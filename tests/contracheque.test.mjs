import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linhasDeTexto, textoDe, detectarTipo } from '../js/import/texto.js';
import { lerContracheque, analisar, classificar, planoContracheque, DESC_SALARIO } from '../js/import/contracheque.js';

const txt = readFileSync(new URL('./fixtures/contracheque-tjro-ficticio.txt', import.meta.url), 'utf8');
const linhas = linhasDeTexto(txt);
const cc = lerContracheque(linhas);

test('contracheque: detecta, lê totais e confere', () => {
  assert.equal(detectarTipo(textoDe(linhas)), 'contracheque');
  assert.deepEqual(cc.erros, []);
  assert.equal(cc.competencia, '2026-11');
  assert.deepEqual(cc.totais, { bruto: 17395, descontos: 7191, liquido: 10204 });
  assert.deepEqual(cc.margem, { base: 10140, disponivel: 1642, emprestimos: 1300 });
  assert.equal(cc.rubricas.length, 20);
  assert.equal(cc.rubricas.filter((r) => r.lado === 'remuneracao').length, 10);
  assert.ok(cc.conferencia.ok);
});

test('contracheque: coluna decide remuneração/desconto, não o nome', () => {
  const r = (d) => cc.rubricas.find((x) => x.descricao === d);
  assert.equal(r('AUXILIO SAÚDE INDENIZADO').lado, 'remuneracao');
  assert.equal(r('DEV. AUXILIO TRANSPORTE').lado, 'desconto');
  assert.equal(r('IRRF').pct, 27.5);
  // Mover o valor da coluna de descontos para a de remunerações muda o lado.
  const mexido = txt.replace(/(SINDICATO MENSAL.*1\.0) {40}/, '$1');
  const s = lerContracheque(linhasDeTexto(mexido)).rubricas.find((x) => x.descricao === 'SINDICATO MENSAL');
  assert.equal(s.lado, 'remuneracao');
});

test('contracheque: nunca guarda dados pessoais e descarta o que vem depois de Dependentes I.R.', () => {
  const j = JSON.stringify(cc);
  for (const s of ['FULANO', '000.000.000-00', '0000000-0', '00000000000', 'AGENCIA', '00000-0', 'Matrícula', '13.000,00']) assert.ok(!j.includes(s), s);
  const comPag2 = lerContracheque(linhasDeTexto(txt + '\nMEMORIA DE CALCULO\n  EMPRESTIMO X     1 /2       999,99\n'));
  assert.equal(comPag2.rubricas.length, 20);
});

test('contracheque: bloqueia quando os totais não batem', () => {
  const r = lerContracheque(linhasDeTexto(txt.replace('R$ 10.204,00', 'R$ 10.304,00')));
  assert.equal(r.conferencia.ok, false);
  assert.equal(r.conferencia.difLiquido, -100);
  assert.ok(r.erros.length);
});

test('classificar: pontual, consignado, recorrente', () => {
  for (const d of ['DIF. VENCIMENTO', 'DEV. X', 'ATUALIZAÇÃO MONETÁRIA', 'RESTITUIÇÃO IR', 'EXERCÍCIO ANTERIOR', 'GRATIFICAÇÃO NATALINA', '13º SALÁRIO', 'ADIANTAMENTO 13 SALARIO', 'FÉRIAS', 'ADICIONAL 1/3 FÉRIAS', 'ABONO PERMANÊNCIA'])
    assert.equal(classificar(d, { n: 1, m: 1 }), 'pontual', d);
  assert.equal(classificar('EMPRESTIMO - BANCO X', { n: 25, m: 48 }), 'consignado');
  assert.equal(classificar('CONSIGNADO CARTÃO', { n: 1, m: 96 }), 'consignado');
  for (const d of ['VENCIMENTO EFETIVO', 'IRRF', 'UNIMED MENSALIDADE', 'ADICIONAL DE QUALIFICAÇÃO (500 H)']) assert.equal(classificar(d, { n: 1, m: 1 }), 'recorrente', d);
});

test('análise: líquido recorrente, IR estimado, consignados e plano', () => {
  const a = analisar(cc);
  // Pontuais: rem 5 + 900 + 150 = 1055; desc 150 + 1 + 40 = 191. IR = (1055 − 150 de IPERON) × 27,5% = 248,88.
  assert.equal(a.somaRemPont, 1055);
  assert.equal(a.somaDesPont, 191);
  assert.equal(a.irEstimado, 248.88);
  assert.equal(a.liquidoRecorrente, 9588.88);
  assert.deepEqual(a.consignados.map((c) => [c.valor, c.faltam, c.ultimoMes]), [[500, 23, '2028-10'], [800, 21, '2028-08']]);
  assert.deepEqual(a.plano, { mensalidade: 1200, coparticipacao: 100, auxilio: 1000, liquido: 300 });
  assert.deepEqual(a.extras, []);
});

test('plano: salário a partir do mês seguinte e fim dos consignados (nunca compromisso)', () => {
  const a = analisar(cc);
  const d = { receitas: [{ id: 'r1', descricao: DESC_SALARIO, valor: 9000, recorrente: true, inicio: '2026-01-01', fim: null }] };
  const p = planoContracheque(cc, a, d);
  assert.deepEqual(p[0].encerrar, { id: 'r1', campos: { fim: '2026-11-01' } });
  assert.deepEqual(p[0].criar, { descricao: DESC_SALARIO, valor: 9588.88, recorrente: true, inicio: '2026-12-01', fim: null });
  assert.deepEqual(p.slice(1).map((i) => [i.criar.valor, i.criar.inicio]), [[500, '2028-11-01'], [800, '2028-09-01']]);
  assert.ok(p.every((i) => !('compromisso' in i)));
  // Reimportar outro mês não duplica a receita de fim de consignado.
  const p2 = planoContracheque(cc, a, { receitas: p.slice(1).map((i) => i.criar) });
  assert.equal(p2.length, 1);
});

test('13º e férias viram receita pontual com IR estimado', () => {
  const extra = txt.replace('  UNIMED MENSALIDADE', '  GRATIFICAÇÃO NATALINA                                                            1 /1                                         1.000,00\n\n  UNIMED MENSALIDADE')
    .replace(/(IRRF .*)2\.900,00/, '$13.175,00') // o IR do 13º (275) entra no IRRF do mês
    .replace('R$ 17.395,00', 'R$ 18.395,00').replace('R$ 7.191,00', 'R$ 7.466,00').replace('R$ 10.204,00', 'R$ 10.929,00');
  const c = lerContracheque(linhasDeTexto(extra));
  assert.deepEqual(c.erros, []);
  const a = analisar(c);
  assert.deepEqual(a.extras.map((e) => [e.descricao, e.liquidoEstimado, e.mes]), [['GRATIFICAÇÃO NATALINA', 725, '2026-11']]);
  assert.equal(a.liquidoRecorrente, 9588.88); // o 13º sai do recorrente com o IR dele
});

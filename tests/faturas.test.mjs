import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linhasDeTexto, linhasDeItens, detectarTipo, valorBR, sha256, dataDoLancamento } from '../js/import/texto.js';
import { lerFaturaBradesco, lerFaturaNubank, planoFatura } from '../js/import/faturas.js';

const fx = (n) => readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8');
const dados = (extra = {}) => ({ config: { mes_inicio: '2026-11-01' }, lancamentos: [], parcelas: [], ...extra });

test('valores e datas', () => {
  assert.equal(valorBR('1.234,56'), 1234.56);
  assert.equal(valorBR('−R$ 30,00'), -30);
  assert.equal(valorBR('12,00-'), -12);
  assert.equal(valorBR('abc'), null);
  assert.equal(dataDoLancamento(28, 'DEZ', '2027-01-10'), '2026-12-28'); // compra de dezembro na fatura de janeiro
  assert.equal(dataDoLancamento(31, 'FEV', '2027-03-10'), null);
});

test('Bradesco: blocos por cartão, parcelas, ignora saldo anterior e pagamento', () => {
  const f = lerFaturaBradesco(linhasDeTexto(fx('fatura-bradesco-ficticia.txt')));
  assert.deepEqual(f.erros, []);
  assert.equal(f.vencimento, '2026-12-10');
  assert.equal(f.total, 1616.10);
  assert.equal(f.itens.length, 7);
  assert.ok(f.conferencia.ok);
  assert.ok(!f.itens.some((i) => /SALDO|PAGTO/.test(i.descricao)));
  const roupa = f.itens.find((i) => i.descricao === 'LOJA DE ROUPAS EXEMPLO');
  assert.deepEqual(roupa.parcela, { k: 3, n: 10 });
  assert.equal(roupa.cartao, 'Bradesco final 1111');
  assert.equal(f.itens.find((i) => /FARMACIA/.test(i.descricao)).cartao, 'Bradesco final 2222');
  assert.equal(f.itens[0].data, '2026-10-28');
  assert.ok(!JSON.stringify(f).includes('CICLANO'), 'nome do titular não pode sair do parser');
});

test('Bradesco fatura ABERTA: saldo anterior nunca é gasto novo', () => {
  const f = lerFaturaBradesco(linhasDeTexto(fx('fatura-bradesco-aberta-ficticia.txt')));
  assert.deepEqual(f.erros, []);
  assert.equal(f.total, 1950);
  assert.equal(f.saldoAnterior, 1500);
  assert.equal(f.conferencia.somaItens, 450); // só as compras novas
  const p = planoFatura(f, dados({ config: { mes_inicio: '2026-12-01' } }));
  const gasto = p.linhas.filter((l) => l.acao === 'lancamento').reduce((s, l) => s + l.valor, 0);
  assert.equal(gasto, 450);
  assert.equal(p.compromisso, null); // tudo já contado como lançamento; o saldo anterior pertence à fatura anterior
});

test('Bradesco: soma que não bate bloqueia a importação', () => {
  const txt = fx('fatura-bradesco-ficticia.txt').replace('55,90', '56,90');
  const f = lerFaturaBradesco(linhasDeTexto(txt));
  assert.equal(f.conferencia.ok, false);
  assert.equal(f.conferencia.diferenca, -1);
  assert.ok(f.erros.some((e) => /não bate/.test(e)));
});

test('Nubank: parcelas, ajuste a crédito, pagamento fora da soma', () => {
  const f = lerFaturaNubank(linhasDeTexto(fx('fatura-nubank-ficticia.txt')));
  assert.deepEqual(f.erros, []);
  assert.equal(f.vencimento, '2026-12-15');
  assert.equal(f.total, 899.40);
  assert.equal(f.itens.length, 6);
  const curso = f.itens.find((i) => /Curso/.test(i.descricao));
  assert.equal(curso.descricao, 'Curso Online Exemplo');
  assert.deepEqual(curso.parcela, { k: 2, n: 6 });
  assert.equal(curso.cartao, 'Nubank final 3333');
  assert.equal(f.itens.find((i) => /Ajuste/.test(i.descricao)).valor, -30);
  assert.ok(!f.itens.some((i) => /Pagamento/.test(i.descricao)));
});

test('plano: à vista vira lançamento, parcelada vira parcelas restantes, k-ésima parcela vai na fatura', () => {
  const f = lerFaturaBradesco(linhasDeTexto(fx('fatura-bradesco-ficticia.txt')));
  const p = planoFatura(f, dados());
  const por = (re) => p.linhas.find((l) => re.test(l.descricao));
  assert.equal(por(/ROUPAS/).acao, 'na_fatura');
  assert.deepEqual(por(/ROUPAS/).parcelaNova, { descricao: 'LOJA DE ROUPAS EXEMPLO', categoria: 'Compras', cartao: 'Bradesco final 1111', valor_parcela: 120, primeiro_mes: '2027-01-01', quantidade: 7 });
  assert.equal(por(/ELETRONICOS/).parcelaNova.quantidade, 11);
  assert.equal(por(/SUPERMERCADO/).acao, 'na_fatura'); // compra de outubro, antes do início (nov)
  assert.equal(por(/NETFLIX/).acao, 'lancamento');
  assert.equal(por(/NETFLIX/).categoria, 'Assinaturas');
  // compromisso = parcelas deste mês + compras antes do início
  assert.equal(p.compromisso.valor, 120 + 300 + 250.30);
  assert.equal(p.compromisso.mes, '2026-12-01');
});

test('plano: fatura que vence antes do início não gera nada', () => {
  const f = lerFaturaBradesco(linhasDeTexto(fx('fatura-bradesco-ficticia.txt')));
  const p = planoFatura(f, dados({ config: { mes_inicio: '2027-01-01' } }));
  assert.equal(p.compromisso, null);
  assert.ok(p.linhas.every((l) => l.acao === 'ignorar'));
  assert.ok(p.linhas.find((l) => /ROUPAS/.test(l.descricao)).parcelaNova); // parcelas futuras continuam valendo
});

test('plano: acha lançamento digitado à mão e parcela existente', () => {
  const f = lerFaturaBradesco(linhasDeTexto(fx('fatura-bradesco-ficticia.txt')));
  const d = dados({
    lancamentos: [{ id: 'a', data: '2026-11-17', valor: 55.9, descricao: 'netflix' }, { id: 'b', data: '2026-11-20', valor: 55.9 }],
    parcelas: [{ id: 'p1', descricao: 'Loja de roupas exemplo', valor_parcela: 120, cartao: 'Bradesco final 1111' }],
  });
  const p = planoFatura(f, d);
  const n = p.linhas.find((l) => /NETFLIX/.test(l.descricao));
  assert.equal(n.duplicata.id, 'a'); // 2 dias de diferença; o de 5 dias não conta
  assert.equal(p.linhas.find((l) => /ROUPAS/.test(l.descricao)).parcelaExistente, 'p1');
});

test('detecção do tipo e hash', async () => {
  assert.equal(detectarTipo(fx('fatura-bradesco-ficticia.txt')), 'fatura_bradesco');
  assert.equal(detectarTipo(fx('fatura-nubank-ficticia.txt')), 'fatura_nubank');
  assert.equal(detectarTipo(fx('contracheque-tjro-ficticio.txt')), 'contracheque');
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('linhas a partir de itens do pdf.js (agrupa por y, junta por x)', () => {
  const it = (s, x, y, w) => ({ str: s, transform: [10, 0, 0, 10, x, y], width: w, height: 10 });
  const l = linhasDeItens([it('55,90', 500, 700, 25), it('15 NOV', 40, 700.5, 30), it('NETFLIX', 120, 700, 35), it('.COM', 155, 700, 20), it('Topo', 40, 800, 20)]);
  assert.equal(l[0].texto, 'Topo');
  assert.equal(l[1].texto, '15 NOV  NETFLIX.COM  55,90');
});

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

const bradesco = () => lerFaturaBradesco(linhasDeTexto(fx('fatura-bradesco-ficticia.txt')));
const por = (p, re) => p.linhas.find((l) => re.test(l.descricao));

test('caso 1: todas as compras antes do início → a fatura inteira vira compromisso', () => {
  const p = planoFatura(bradesco(), dados({ config: { mes_inicio: '2026-12-01' } }));
  assert.ok(p.linhas.every((l) => l.acao === 'na_fatura'));
  assert.equal(p.compromisso.valor, 1616.10);
  assert.equal(p.compromisso.mes, '2026-12-01');
  // parcelas futuras continuam valendo, a partir do mês seguinte (a deste mês está no compromisso)
  assert.deepEqual(por(p, /ROUPAS/).parcelaNova, { descricao: 'LOJA DE ROUPAS EXEMPLO', categoria: 'Compras', cartao: 'Bradesco final 1111', valor_parcela: 120, primeiro_mes: '2027-01-01', quantidade: 7 });
  assert.equal(por(p, /ELETRONICOS/).parcelaNova.quantidade, 11);
});

test('caso 2: fatura mista → compromisso só da parte antes do início; o resto vira lançamento/parcela', () => {
  const p = planoFatura(bradesco(), dados()); // início em nov
  assert.equal(por(p, /SUPERMERCADO/).acao, 'na_fatura'); // 28 out
  // (03/10) com data de nov: a compra foi em out ou antes, então é antiga
  assert.equal(por(p, /ROUPAS/).acao, 'na_fatura');
  assert.equal(por(p, /ROUPAS/).parcelaNova.primeiro_mes, '2027-01-01');
  assert.equal(por(p, /NETFLIX/).acao, 'lancamento');
  assert.equal(por(p, /NETFLIX/).categoria, 'Assinaturas');
  const el = por(p, /ELETRONICOS/); // 22 nov (01/12): compra nova, a parcela deste mês também é parcela
  assert.equal(el.acao, 'parcela');
  assert.equal(el.parcelaNova.primeiro_mes, '2026-12-01');
  assert.equal(el.parcelaNova.quantidade, 12);
  assert.equal(p.compromisso.valor, 250.30 + 120);
  // nada contado duas vezes: compromisso + lançamentos + parcela deste mês = total das compras
  const lanc = p.linhas.filter((l) => l.acao === 'lancamento').reduce((s, l) => s + l.valor, 0);
  assert.equal(Math.round((p.compromisso.valor + lanc + 300) * 100) / 100, 1616.10);
});

test('caso 3: todas as compras a partir do início → nenhum compromisso', () => {
  const f = lerFaturaNubank(linhasDeTexto(fx('fatura-nubank-ficticia.txt')));
  const p = planoFatura(f, dados());
  assert.equal(p.compromisso, null);
  assert.ok(p.linhas.every((l) => l.acao !== 'na_fatura'));
  assert.equal(por(p, /Ajuste/).acao, 'credito');
  assert.deepEqual(por(p, /Loja Imaginaria/).parcelaNova, { descricao: 'Loja Imaginaria', categoria: 'Compras', cartao: 'Nubank final 4444', valor_parcela: 500, primeiro_mes: '2026-12-01', quantidade: 3 });
  assert.equal(por(p, /Curso/).acao, 'parcela'); // 18 nov, 2/6 em dez: compra no máximo em nov
  assert.equal(por(p, /Curso/).parcelaNova.quantidade, 5);
});

test('plano: fatura que vence antes do início não gera nada', () => {
  const p = planoFatura(bradesco(), dados({ config: { mes_inicio: '2027-01-01' } }));
  assert.equal(p.compromisso, null);
  assert.ok(p.linhas.every((l) => l.acao === 'ignorar'));
  assert.ok(por(p, /ROUPAS/).parcelaNova); // parcelas futuras continuam valendo
});

test('plano: acha lançamento digitado à mão', () => {
  const d = dados({ lancamentos: [{ id: 'a', data: '2026-11-17', valor: 55.9, descricao: 'netflix' }, { id: 'b', data: '2026-11-20', valor: 55.9 }] });
  assert.equal(por(planoFatura(bradesco(), d), /NETFLIX/).duplicata.id, 'a'); // 2 dias de diferença; o de 5 dias não conta
});

test('parcela existente: casa por valor, final do cartão e restantes; ignora caixa, acento e espaços', () => {
  // ROUPAS 03/10 em dez/26: faltam 7 depois desta → última em jul/27
  const base = { valor_parcela: 120, cartao: 'bradesco 1111' };
  const casa = (parcelas) => por(planoFatura(bradesco(), dados({ parcelas })), /ROUPAS/).parcelaExistente;
  assert.equal(casa([{ id: 'p1', descricao: '  Loja de   Roupás exemplo ', primeiro_mes: '2027-01-01', quantidade: 7, ...base }]), 'p1');
  // descrição diferente ainda casa (só desempata); feita à mão contando a de dez: mesma última parcela
  assert.equal(casa([{ id: 'p2', descricao: 'Roupa', primeiro_mes: '2026-12-01', quantidade: 8, ...base }]), 'p2');
  // desempate pela descrição
  assert.equal(casa([{ id: 'x', descricao: 'Outra loja', primeiro_mes: '2027-01-01', quantidade: 7, ...base },
    { id: 'p3', descricao: 'LOJA DE ROUPAS EXEMPLO', primeiro_mes: '2027-01-01', quantidade: 7, ...base }]), 'p3');
  // não casa: restantes, cartão ou valor diferentes
  assert.equal(casa([{ id: 'n1', descricao: 'LOJA DE ROUPAS EXEMPLO', primeiro_mes: '2027-01-01', quantidade: 6, ...base }]), null);
  assert.equal(casa([{ id: 'n2', descricao: 'LOJA DE ROUPAS EXEMPLO', primeiro_mes: '2027-01-01', quantidade: 7, valor_parcela: 120, cartao: 'Bradesco final 2222' }]), null);
  assert.equal(casa([{ id: 'n3', descricao: 'LOJA DE ROUPAS EXEMPLO', primeiro_mes: '2027-01-01', quantidade: 7, valor_parcela: 120.02, cartao: '1111' }]), null);
  // uma parcela cadastrada não casa com duas linhas da fatura
  const f = bradesco(); f.itens.push({ ...f.itens.find((i) => /ROUPAS/.test(i.descricao)) });
  const p = planoFatura(f, dados({ parcelas: [{ id: 'p1', descricao: 'x', primeiro_mes: '2027-01-01', quantidade: 7, ...base }] }));
  assert.deepEqual(p.linhas.filter((l) => /ROUPAS/.test(l.descricao)).map((l) => l.parcelaExistente), ['p1', null]);
});

test('aviso: compromisso pontual digitado à mão com valor próximo, em mês igual ou depois do vencimento', () => {
  const manual = (mes, valor, extra = {}) => planoFatura(bradesco(), dados({ compromissos: [{ id: 'm', descricao: 'cartão', recorrente: false, mes, valor, ...extra }] })).possivelManual;
  assert.equal(manual('2026-12-01', 1600).id, 'm'); // ~1% do total (1.616,10)
  assert.equal(manual('2027-01-01', 1616.10).id, 'm');
  assert.equal(manual('2026-12-01', 371).id, 'm'); // ~ o compromisso calculado (370,30)
  assert.equal(manual('2026-11-01', 1616.10), null); // mês antes do vencimento
  assert.equal(manual('2026-12-01', 1500), null); // longe
  assert.equal(manual('2026-12-01', 1616.10, { recorrente: true }), null);
  assert.equal(manual('2026-12-01', 1616.10, { descricao: 'Fatura Bradesco 12/2026' }), null); // é a importada antes: atualiza, sem aviso
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

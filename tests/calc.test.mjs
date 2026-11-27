import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../js/calc.js';

const base = () => ({
  contas: [{ tipo: 'corrente', saldo: 1000 }, { tipo: 'reserva', saldo: 12000 }],
  receitas: [{ valor: 15000, recorrente: true }, { valor: 5000, recorrente: false, mes: '2026-12-01' }],
  compromissos: [{ valor: 2000, recorrente: true }, { valor: 18000, recorrente: false, mes: '2026-12-01' }],
  parcelas: [{ valor_parcela: 500, primeiro_mes: '2026-12-01', quantidade: 3 }],
  lancamentos: [{ data: '2026-12-02', valor: 100 }, { data: '2026-12-10', valor: 50 }, { data: '2026-11-30', valor: 999 }],
  config: { meta_poupanca: 1000, gasto_variavel_previsto: 4000 },
});

test('meses', () => {
  assert.equal(c.addMeses('2026-11', 2), '2027-01');
  assert.equal(c.addMeses('2027-01', -1), '2026-12');
  assert.equal(c.difMeses('2026-11', '2027-02'), 3);
  assert.equal(c.diasNoMes('2027-02'), 28);
  assert.equal(c.diasNoMes('2028-02'), 29);
});

test('parcela só nos meses certos', () => {
  const p = { valor_parcela: 100, primeiro_mes: '2026-12-01', quantidade: 3 };
  assert.deepEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03'].map((m) => c.parcelaNoMes(p, m)), [0, 100, 100, 100, 0]);
});

test('recorrente com início e fim', () => {
  const r = { valor: 10, recorrente: true, inicio: '2027-01-01', fim: '2027-03-01' };
  assert.equal(c.ativoNoMes(r, '2026-12'), false);
  assert.equal(c.ativoNoMes(r, '2027-03'), true);
  assert.equal(c.ativoNoMes(r, '2027-04'), false);
});

test('resumo do mês e limite diário', () => {
  const r = c.resumoMes(base(), '2026-12-10');
  // dez: 20000 - 20000 - 500 - 1000 - 150 = -1650
  assert.equal(r.renda, 20000);
  assert.equal(r.gastos, 150);
  assert.equal(r.saldoFimMes, -1650);
  assert.equal(r.disponivel, -1650);
  assert.equal(r.limiteDia, 0);
  assert.equal(r.diasRestantes, 22);
});

test('limite diário positivo desconta gasto de hoje', () => {
  const d = base(); d.compromissos = [];
  const r = c.resumoMes(d, '2026-12-10'); // dez livre = 20000-500-1000-150 = 18350; meses seguintes positivos
  assert.equal(r.disponivel, 18350);
  assert.equal(r.limiteDia, Math.round((18350 + 50) / 22 * 100) / 100);
  assert.equal(r.restanteHoje, Math.round((r.limiteDia - 50) * 100) / 100);
});

test('sobra de hoje fica reservada para buraco futuro', () => {
  const d = base();
  d.compromissos = [{ valor: 25000, recorrente: false, mes: '2027-01-01' }];
  d.config = { meta_poupanca: 0, gasto_variavel_previsto: 0, saldo_inicial: 3000, mes_inicio: '2026-12-01' };
  d.lancamentos = [];
  const r = c.resumoMes(d, '2026-12-10');
  // dez: 3000 + 20000 - 500 = 22500 ; jan: 22500 + 15000 - 500 - 25000 = 12000
  assert.equal(r.saldoFimMes, 22500);
  assert.equal(r.disponivel, 12000);
  assert.equal(r.reservarPara, '2027-01');
});

test('antes do mês de início usa o 1º dia do início', () => {
  const d = base(); d.config = { ...d.config, mes_inicio: '2026-12-01', saldo_inicial: 1000 };
  const r = c.resumoMes(d, '2026-11-26');
  assert.equal(r.mes, '2026-12');
  assert.equal(r.diasRestantes, 31);
});

test('projeção acumula e usa previsto nos meses futuros', () => {
  const p = c.projecao(base(), '2026-12-10', 3);
  assert.equal(p[1].mes, '2027-01');
  assert.equal(p[1].livre, 15000 - 2000 - 500 - 1000 - 4000);
  assert.equal(p[1].acumulado, Math.round((p[0].livre + p[1].livre) * 100) / 100);
  assert.equal(p[2].parcelas, 500);
});

test('simulação de compra parcelada', () => {
  const s = c.simular(base(), { valor: 3000, parcelas: 3, primeiroMes: '2027-01' }, '2026-12-10');
  assert.equal(s.valorParcela, 1000);
  const jan = s.linhas.find((l) => l.mes === '2027-01');
  assert.equal(jan.parcelaCompra, 1000);
  assert.equal(jan.acumDepois, Math.round((jan.acumAntes - 1000) * 100) / 100);
  const ult = s.linhas[s.linhas.length - 1];
  assert.equal(ult.acumDepois, Math.round((ult.acumAntes - 3000) * 100) / 100);
  assert.ok(s.jaNegativos.length >= 1); // dez já negativo antes da compra
  assert.ok(s.mesesParaJuntar >= 1);
});

test('indicadores', () => {
  const i = c.indicadores(base(), '2027-01-05');
  const byId = Object.fromEntries(i.lista.map((x) => [x.id, x]));
  // Média de fev, mar e abr/27: a parcela (dez a fev) só aparece em fev → 500/3.
  assert.deepEqual(i.meses, ['2027-02', '2027-03', '2027-04']);
  assert.equal(byId.reserva.valor, 12000 / (2000 + 166.67 + 4000));
  assert.equal(byId.reserva.status, 'ruim'); // 1,9 mês < 3
  assert.equal(byId.parcelas.valor, 166.67 / 15000);
  assert.equal(byId.poupanca.valor, (15000 - 2000 - 166.67 - 4000) / 15000);
  assert.ok(['ok', 'atencao', 'ruim'].includes(i.geral));
});

test('parse rápido', () => {
  assert.deepEqual(c.parseRapido('45,90 mercado pix'), { valor: 45.9, descricao: 'mercado', categoria: 'Mercado', meio: 'pix', parcelas: 1 });
  const t = c.parseRapido('600 tênis loja em 3x');
  assert.equal(t.parcelas, 3); assert.equal(t.meio, 'credito'); assert.equal(t.categoria, 'Compras');
  assert.equal(c.parseRapido('120 uber cartão').meio, 'credito');
  assert.equal(c.parseRapido('80 mercadolivre').categoria, 'Compras');
  assert.ok(c.parseRapido('mercado').erro);
  assert.ok(c.parseRapido('45').erro);
  assert.ok(c.parseRapido('0 nada').erro);
  assert.equal(c.parseRapido('30 <img src=x onerror=alert(1)>').descricao.includes('<img'), true); // texto é guardado como texto; a UI nunca usa innerHTML
});

test('moeda estrangeira: saldo = quantidade × cotação; API validada', () => {
  assert.equal(c.saldoEmReais(0.01234567, 500000), 6172.84);
  assert.equal(c.saldoEmReais(100, 5.4321), 543.21);
  assert.deepEqual(c.cotacoesDaApi({ USDBRL: { bid: '5.43' }, BTCBRL: { bid: '512345.6' } }), { USD: 5.43, BTC: 512345.6 });
  assert.deepEqual(c.cotacoesDaApi({ USDBRL: { bid: 'x' }, BTCBRL: { bid: '-1' } }), {});
  assert.deepEqual(c.cotacoesDaApi(null), {});
});

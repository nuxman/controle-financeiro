import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linhasDeTexto } from '../js/import/texto.js';
import { lerContracheque, analisar, planoContracheque, rendaAntesDepois, salariosAtivos, DESC_SALARIO } from '../js/import/contracheque.js';
import { gravarContracheque, emGravacao } from '../js/import/gravar.js';

const cc = lerContracheque(linhasDeTexto(readFileSync(new URL('./fixtures/contracheque-tjro-ficticio.txt', import.meta.url), 'utf8')));
const a = analisar(cc);
const HASH = 'a'.repeat(64);

// Banco falso em memória, com um pequeno atraso para simular a rede.
function dbFalso(receitas = []) {
  const t = { importacoes: [], receitas: receitas.map((r) => ({ ...r })) };
  let n = 0;
  const espera = () => new Promise((r) => setTimeout(r, 5));
  return {
    t,
    listar: async (tab) => { await espera(); return t[tab].map((x) => ({ ...x })); },
    inserir: async (tab, l) => { await espera(); const ls = [].concat(l).map((x) => ({ id: 'id' + ++n, ...x })); t[tab].push(...ls); return ls; },
    atualizar: async (tab, id, c) => { await espera(); Object.assign(t[tab].find((x) => x.id === id), c); },
    apagar: async (tab, id) => { t[tab] = t[tab].filter((x) => x.id !== id); },
  };
}
const linhas = (db) => db.t.importacoes.length + db.t.receitas.length;

test('importar o mesmo contracheque duas vezes seguidas não cria nenhuma linha nova', async () => {
  const db = dbFalso([{ id: 'r1', descricao: 'Salário TJ (líquido)', valor: 9000, recorrente: true, inicio: '2026-01-01', fim: null }]);
  // 1ª vez: revisão com os dados do momento.
  await gravarContracheque(db, cc, planoContracheque(cc, a, { receitas: db.t.receitas }), HASH);
  const depois1 = linhas(db);
  assert.equal(db.t.importacoes.length, 1);
  // 2ª vez com revisão VELHA (dados de antes da 1ª gravação): o hash no servidor barra antes de inserir.
  const plano = planoContracheque(cc, a, { receitas: [] });
  await assert.rejects(gravarContracheque(db, cc, plano, HASH), /já foi importado/);
  // 2ª vez com revisão nova também.
  await assert.rejects(gravarContracheque(db, cc, planoContracheque(cc, a, { receitas: db.t.receitas }), HASH), /já foi importado/);
  assert.equal(linhas(db), depois1);
});

test('cliques simultâneos em Gravar: só uma gravação passa', async () => {
  const db = dbFalso();
  const plano = planoContracheque(cc, a, { receitas: [] });
  const r = await Promise.allSettled([1, 2, 3].map(() => gravarContracheque(db, cc, plano, HASH)));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(db.t.importacoes.length, 1);
  assert.equal(db.t.receitas.filter((x) => x.descricao === DESC_SALARIO).length, 1);
  assert.equal(emGravacao(), false);
});

test('mesmo contracheque com outro hash (PDF re-exportado): plano recalculado não duplica o salário', async () => {
  const db = dbFalso();
  await gravarContracheque(db, cc, planoContracheque(cc, a, { receitas: db.t.receitas }), HASH);
  const nReceitas = db.t.receitas.length;
  const p2 = planoContracheque(cc, a, { receitas: db.t.receitas });
  assert.ok(p2.every((i) => !i.criar)); // só troca o valor do salário que já começa no mês seguinte
  await gravarContracheque(db, cc, p2, 'b'.repeat(64));
  assert.equal(db.t.receitas.length, nReceitas); // nenhuma receita nova; só o registro da importação
  assert.equal(db.t.importacoes.length, 2);
});

test('salário: reconhece pelo início "salário", sem maiúsculas/acentos; vários → propõe encerrar os outros', () => {
  const rec = [
    { id: 'a', descricao: 'Salário TJ (líquido)', valor: 9000, recorrente: true, inicio: '2026-01-01', fim: null },
    { id: 'b', descricao: 'SALARIO', valor: 9000, recorrente: true, inicio: '2026-03-01', fim: null },
    { id: 'c', descricao: 'salário antigo', valor: 8000, recorrente: true, inicio: '2025-01-01', fim: '2025-12-01' }, // já encerrado
    { id: 'd', descricao: 'Aluguel do salão', valor: 500, recorrente: true },
    { id: 'e', descricao: 'Salário extra', valor: 100, recorrente: false, mes: '2026-12-01' },
  ];
  assert.deepEqual(salariosAtivos(rec, '2026-12').map((r) => r.id), ['a', 'b']);
  const p = planoContracheque(cc, a, { receitas: rec });
  assert.deepEqual(p[0].encerrar, { id: 'a', campos: { fim: '2026-11-01' } });
  assert.deepEqual(p[1], { id: 'outroSalario0', marcado: true, atual: rec[1], encerrar: { id: 'b', campos: { fim: '2026-11-01' } } });
  // Renda de dez/2026: antes 9000 + 9000 + 500 (aluguel) + 100 (pontual) = 18600; depois 9588,88 + 600.
  assert.deepEqual(rendaAntesDepois(rec, p, '2026-12'), { mes: '2026-12', antes: 18600, depois: 10188.88 });
  // Desmarcar o encerramento do segundo mostra a soma em dobro.
  p[1].marcado = false;
  assert.equal(rendaAntesDepois(rec, p, '2026-12').depois, 19188.88);
});

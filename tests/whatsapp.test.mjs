// Testes da Edge Function do WhatsApp. Payloads inventados no formato da Meta; números e ids FALSOS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { criarHandler, assinar, doUsuario, iguais, AJUDA, NAO_ENTENDI, LIMITE_HORA, restSupabase, chaveDoSupabase } from '../supabase/functions/whatsapp/bot.js';
import { resumoMes } from '../js/calc.js';

const SEGREDO = 'segredo-de-teste';
const VERIFY = 'verify-de-teste';
const EU = '5569900000001', OUTRO = '5569900000002', ESTRANHO = '5569900000009';
const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222';
const AGORA = new Date('2026-11-27T15:00:00Z'); // 11h em Manaus

// ---------- PostgREST falso em memória (entende eq/gte/lte, order, limit, on_conflict, max_rows) ----------
const MAX_ROWS = 1000;
function bancoFalso() {
  const t = {
    whatsapp_vinculos: [{ telefone_e164: '+' + EU, user_id: U1 }, { telefone_e164: '+' + OUTRO, user_id: U2 }],
    whatsapp_mensagens: [], lancamentos: [], parcelas: [], contas: [], receitas: [], compromissos: [],
    config: [{ user_id: U1, saldo_inicial: 3000, mes_inicio: '2026-11-01', meta_poupanca: 0, gasto_variavel_previsto: 0 }],
  };
  let n = 0;
  const chamadas = [];
  const filtros = (q) => {
    const fs = [], opts = {};
    for (const [k, v] of new URLSearchParams(q)) {
      if (['select', 'on_conflict'].includes(k)) opts[k] = v;
      else if (k === 'order') opts.order = v.split('.');
      else if (k === 'limit') opts.limit = Number(v);
      else { const i = v.indexOf('.'); fs.push([k, v.slice(0, i), v.slice(i + 1)]); }
    }
    return { fs, opts };
  };
  const passa = (row, fs) => fs.every(([k, op, v]) => op === 'eq' ? String(row[k]) === v : op === 'gte' ? String(row[k]) >= v : op === 'lte' ? String(row[k]) <= v : false);
  const rest = async (metodo, tabela, q = '', corpo, prefer = '') => {
    chamadas.push({ metodo, tabela, q, corpo });
    const { fs, opts } = filtros(q);
    if (tabela === 'rpc/gastos_por_mes') { // igual à função SQL: filtra por p_user e agrega por mês
      const por = {};
      for (const l of t.lancamentos) if (l.user_id === corpo.p_user && l.data >= corpo.p_desde) por[l.data.slice(0, 7) + '-01'] = (por[l.data.slice(0, 7) + '-01'] || 0) + Number(l.valor);
      return Object.entries(por).sort().map(([mes, total]) => ({ mes, total: String(total) }));
    }
    if (metodo === 'GET') {
      let r = t[tabela].filter((x) => passa(x, fs)).map((x) => ({ ...x }));
      if (opts.order) r.sort((a, b) => (a[opts.order[0]] < b[opts.order[0]] ? -1 : 1) * (opts.order[1] === 'desc' ? -1 : 1));
      return r.slice(0, Math.min(opts.limit || MAX_ROWS, MAX_ROWS)); // o PostgREST corta em max_rows (1000)
    }
    if (metodo === 'POST') {
      if (opts.on_conflict && t[tabela].some((x) => x[opts.on_conflict] === corpo[opts.on_conflict])) return prefer.includes('ignore') ? [] : Promise.reject(new Error('409'));
      const linha = { id: `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`, created_at: new Date(AGORA.getTime() + n).toISOString(), ...corpo };
      t[tabela].push(linha);
      return [linha];
    }
    if (metodo === 'DELETE') { const antes = t[tabela].length; t[tabela] = t[tabela].filter((x) => !passa(x, fs)); return antes - t[tabela].length; }
    throw new Error('método');
  };
  return { t, rest, chamadas };
}

function montar(banco = bancoFalso()) {
  const enviadas = [], logs = [];
  let pendente = Promise.resolve();
  const handler = criarHandler({
    env: { WHATSAPP_APP_SECRET: SEGREDO, WHATSAPP_VERIFY_TOKEN: VERIFY },
    rest: banco.rest,
    enviar: async (para, texto) => { enviadas.push({ para, texto }); },
    agora: () => AGORA,
    log: (evento, extra) => logs.push(JSON.stringify({ evento, ...extra })),
    emSegundoPlano: (p) => { pendente = p; },
  });
  const post = async (corpo, assinatura) => {
    const headers = { 'content-type': 'application/json' };
    if (assinatura !== null) headers['x-hub-signature-256'] = assinatura ?? await assinar(SEGREDO, corpo);
    const r = await handler(new Request('https://x.supabase.co/functions/v1/whatsapp', { method: 'POST', headers, body: corpo }));
    await pendente;
    return r;
  };
  let seq = 0;
  const msg = async (texto, de = EU, wamid = `wamid.TESTE${++seq}`) => post(payload(texto, de, wamid));
  return { banco, handler, post, msg, enviadas, logs, ultima: () => enviadas.at(-1)?.texto };
}

const payload = (texto, de, wamid) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: '000000000000000', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '000000000000001' },
    contacts: [{ profile: { name: 'Teste' }, wa_id: de }],
    messages: [{ from: de, id: wamid, timestamp: '1795000000', type: 'text', text: { body: texto } }],
  } }] }],
});

// ---------- Cópia do calc.js ----------
test('supabase/functions/_shared/calc.js é idêntico a js/calc.js (rode npm run copiar-calc)', () => {
  const ler = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.equal(ler('../supabase/functions/_shared/calc.js'), ler('../js/calc.js'));
});

// ---------- Verificação (GET) ----------
test('GET: devolve o challenge só com o verify token certo', async () => {
  const { handler } = montar();
  const get = (tk) => handler(new Request(`https://x/w?hub.mode=subscribe&hub.verify_token=${tk}&hub.challenge=12345`));
  const ok = await get(VERIFY);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');
  assert.equal((await get('errado')).status, 403);
  assert.equal((await handler(new Request('https://x/w?hub.mode=subscribe&hub.challenge=1'))).status, 403);
});

test('GET: sem WHATSAPP_VERIFY_TOKEN configurado, recusa até token vazio', async () => {
  const h = criarHandler({ env: {}, emSegundoPlano() {} });
  assert.equal((await h(new Request('https://x/w?hub.mode=subscribe&hub.verify_token=&hub.challenge=1'))).status, 403);
});

test('iguais: compara conteúdo e tamanho', () => {
  assert.ok(iguais('abc', 'abc'));
  assert.ok(!iguais('abc', 'abd'));
  assert.ok(!iguais('abc', 'abcd'));
  assert.ok(!iguais('', 'a'));
});

// ---------- Assinatura (POST) ----------
test('POST com assinatura válida: 200 e processa', async () => {
  const s = montar();
  const r = await s.msg('45 mercado');
  assert.equal(r.status, 200);
  assert.equal(s.banco.t.lancamentos.length, 1);
});

test('POST com assinatura inválida: 401 sem corpo e sem tocar no banco', async () => {
  const s = montar();
  const corpo = payload('45 mercado', EU, 'wamid.X');
  for (const sig of ['sha256=' + '0'.repeat(64), await assinar('outro-segredo', corpo), 'lixo', '']) {
    const r = await s.post(corpo, sig);
    assert.equal(r.status, 401);
    assert.equal(await r.text(), '');
  }
  assert.equal(s.banco.chamadas.length, 0);
  assert.equal(s.enviadas.length, 0);
});

test('POST sem assinatura: 401', async () => {
  const s = montar();
  assert.equal((await s.post(payload('45 mercado', EU, 'wamid.X'), null)).status, 401);
  assert.equal(s.banco.chamadas.length, 0);
});

test('POST com corpo alterado depois de assinado: 401', async () => {
  const s = montar();
  const sig = await assinar(SEGREDO, payload('45 mercado', EU, 'wamid.X'));
  assert.equal((await s.post(payload('9999 mercado', EU, 'wamid.X'), sig)).status, 401);
});

test('POST sem App Secret configurado: 401', async () => {
  const corpo = payload('45 mercado', EU, 'wamid.X');
  const h = criarHandler({ env: {}, emSegundoPlano() {} });
  const r = await h(new Request('https://x/w', { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body: corpo }));
  assert.equal(r.status, 401);
});

test('POST assinado com JSON quebrado ou erro interno: 200 (a Meta não reenvia)', async () => {
  const s = montar();
  assert.equal((await s.post('{quebrado')).status, 200);
  const b = bancoFalso();
  b.rest = async () => { throw new Error('banco fora'); };
  const s2 = montar(b);
  assert.equal((await s2.msg('45 mercado')).status, 200);
  assert.ok(s2.logs.some((l) => l.includes('erro_interno')));
});

// ---------- Número não vinculado e wamid repetido ----------
test('número não vinculado: silêncio total, nada gravado', async () => {
  const s = montar();
  const r = await s.msg('45 mercado', ESTRANHO);
  assert.equal(r.status, 200);
  assert.equal(s.enviadas.length, 0);
  assert.equal(s.banco.t.lancamentos.length + s.banco.t.whatsapp_mensagens.length, 0);
});

test('wamid repetido: grava uma vez só e responde uma vez só', async () => {
  const s = montar();
  await s.msg('45 mercado', EU, 'wamid.REPETIDO');
  await s.msg('45 mercado', EU, 'wamid.REPETIDO');
  assert.equal(s.banco.t.lancamentos.length, 1);
  assert.equal(s.enviadas.length, 1);
});

test(`limite: acima de ${LIMITE_HORA} por hora ignora, avisando uma vez`, async () => {
  const s = montar();
  for (let i = 0; i < LIMITE_HORA + 5; i++) await s.msg('ajuda');
  assert.equal(s.enviadas.length, LIMITE_HORA + 1);
  assert.match(s.ultima(), /Limite de 30/);
});

// ---------- Comandos ----------
test('"45 mercado": grava como o lançamento rápido e responde no formato', async () => {
  const s = montar();
  await s.msg('45 mercado');
  const [l] = s.banco.t.lancamentos;
  assert.deepEqual({ data: l.data, valor: l.valor, categoria: l.categoria, meio: l.meio, origem: l.origem, user_id: l.user_id },
    { data: '2026-11-27', valor: 45, categoria: 'Mercado', meio: 'debito', origem: 'whatsapp', user_id: U1 });
  assert.match(l.wamid, /^wamid\./);
  assert.match(s.ultima(), /^✓ R\$\s45,00 · Mercado · débito\. Disponível hoje: R\$\s[\d.,]+ \(limite do dia R\$\s[\d.,]+\)\.$/);
});

test('"30 uber pix" e "120 farmácia crédito": meio e categoria', async () => {
  const s = montar();
  await s.msg('30 uber pix');
  await s.msg('120 farmácia crédito');
  assert.deepEqual(s.banco.t.lancamentos.map((l) => [l.meio, l.categoria]), [['pix', 'Combustível e transporte'], ['credito', 'Saúde e farmácia']]);
  assert.match(s.ultima(), /R\$\s120,00 · Farmácia \(Saúde e farmácia\) · crédito\./);
});

test('"600 tênis 3x": vira parcelas a partir do mês atual', async () => {
  const s = montar();
  await s.msg('600 tênis 3x');
  assert.equal(s.banco.t.lancamentos.length, 0);
  const [p] = s.banco.t.parcelas;
  assert.deepEqual({ v: p.valor_parcela, q: p.quantidade, m: p.primeiro_mes, o: p.origem, u: p.user_id }, { v: 200, q: 3, m: '2026-11-01', o: 'whatsapp', u: U1 });
  assert.match(s.ultima(), /crédito 3x de R\$\s200,00/);
});

test('"hoje": gasto do dia, disponível hoje e até o fim do mês', async () => {
  const s = montar();
  await s.msg('45 mercado');
  await s.msg('HOJE');
  assert.match(s.ultima(), /Hoje você gastou R\$\s45,00\.\nDisponível hoje: .+\nAté o fim do mês: R\$\s2\.955,00\./);
});

test('"semana": últimos 7 dias, 5 maiores categorias, só do próprio usuário', async () => {
  const s = montar();
  const add = (data, valor, categoria, user_id = U1) => s.banco.t.lancamentos.push({ id: 'x' + Math.random(), user_id, data, valor, categoria });
  ['Mercado', 'Lazer', 'Pets', 'Viagem', 'Compras', 'Educação'].forEach((c, i) => add('2026-11-25', 10 * (i + 1), c));
  add('2026-11-21', 1000, 'Saúde e farmácia'); // 1º dia da janela (27 − 6)
  add('2026-11-20', 5000, 'Assinaturas');      // fora da janela
  add('2026-11-26', 9999, 'Restaurantes e lanches', U2); // de outra pessoa
  await s.msg('semana');
  const r = s.ultima();
  assert.match(r, /Últimos 7 dias: R\$\s1\.210,00/);
  assert.equal(r.split('\n').length, 6);
  assert.match(r, /Saúde e farmácia: R\$\s1\.000,00\n• Educação: R\$\s60,00/);
  assert.doesNotMatch(r, /Assinaturas|Restaurantes|Mercado/);
});

test('"desfazer": apaga o último do WhatsApp com menos de 15 min, só uma vez', async () => {
  const s = montar();
  s.banco.t.lancamentos.push({ id: '00000000-0000-0000-0000-0000000000aa', user_id: U1, origem: 'app', valor: 10, created_at: AGORA.toISOString() });
  await s.msg('45 mercado');
  await s.msg('600 tênis 3x');
  await s.msg('desfazer');
  assert.match(s.ultima(), /Desfeito: R\$\s600,00 · Tênis/);
  assert.equal(s.banco.t.parcelas.length, 0);
  assert.equal(s.banco.t.lancamentos.length, 2);
  await s.msg('desfazer');
  assert.equal(s.banco.t.lancamentos.length, 1);
  assert.equal(s.banco.t.lancamentos[0].origem, 'app'); // o lançado no app nunca é desfeito
  await s.msg('desfazer');
  assert.match(s.ultima(), /Nada para desfazer/);
});

test('"desfazer": não apaga lançamento com mais de 15 minutos nem de outro usuário', async () => {
  const s = montar();
  const velho = new Date(AGORA.getTime() - 16 * 60000).toISOString();
  s.banco.t.lancamentos.push({ id: '00000000-0000-0000-0000-0000000000bb', user_id: U1, origem: 'whatsapp', valor: 10, created_at: velho });
  s.banco.t.lancamentos.push({ id: '00000000-0000-0000-0000-0000000000cc', user_id: U2, origem: 'whatsapp', valor: 10, created_at: AGORA.toISOString() });
  await s.msg('desfazer');
  assert.match(s.ultima(), /Nada para desfazer/);
  assert.equal(s.banco.t.lancamentos.length, 2);
});

test('"ajuda" e texto não reconhecido', async () => {
  const s = montar();
  await s.msg('Ajuda');
  assert.equal(s.ultima(), AJUDA);
  for (const t of ['oi', 'mercado 45', '', '0 nada', '-5 mercado', '45']) { await s.msg(t); assert.equal(s.ultima(), NAO_ENTENDI); }
  assert.equal(s.banco.t.lancamentos.length, 0);
});

test('mensagem que não é texto (áudio, imagem): não entendi, nada gravado', async () => {
  const s = montar();
  const corpo = payload('x', EU, 'wamid.AUDIO').replace('"type":"text"', '"type":"audio"');
  await s.post(corpo);
  assert.equal(s.ultima(), NAO_ENTENDI);
  assert.equal(s.banco.t.lancamentos.length, 0);
});

// ---------- Texto malicioso ----------
test('HTML, SQL e texto longo: gravados como texto, descrição cortada em 80', async () => {
  const s = montar();
  await s.msg('10 <script>alert(1)</script>');
  await s.msg("20 '; drop table lancamentos; --");
  await s.msg('30 ' + 'a'.repeat(5000));
  const ds = s.banco.t.lancamentos.map((l) => l.descricao);
  assert.equal(ds[0], '<script>alert(1)</script>');
  assert.equal(ds[1], "'; drop table lancamentos; --");
  assert.ok(ds[2].length <= 80);
  assert.ok(ds.every((d) => d.length <= 80));
  // nada do texto do usuário vai para a URL da consulta
  assert.ok(s.banco.chamadas.every((c) => !/script|drop/.test(c.q)));
});

test('payload com from ou id malformado é ignorado', async () => {
  const s = montar();
  await s.post(payload('45 mercado', '+55 69 abc', 'wamid.Z'));
  await s.post(payload('45 mercado', EU, ''));
  assert.equal(s.banco.chamadas.length, 0);
  assert.equal(s.enviadas.length, 0);
});

// ---------- Isolamento por usuário ----------
test('doUsuario: só lê, grava e apaga linhas do próprio user_id', async () => {
  const b = bancoFalso();
  b.t.lancamentos.push({ id: '00000000-0000-0000-0000-0000000000d1', user_id: U1, valor: 1 }, { id: '00000000-0000-0000-0000-0000000000d2', user_id: U2, valor: 2 });
  const u1 = doUsuario(b.rest, U1);
  assert.deepEqual((await u1.listar('lancamentos')).map((l) => l.id), ['00000000-0000-0000-0000-0000000000d1']);
  // mesmo tentando forçar outro user_id na consulta ou na linha
  assert.equal((await u1.listar('lancamentos', `user_id=eq.${U2}`)).length, 0);
  const [nova] = await u1.inserir('lancamentos', { valor: 3, user_id: U2 });
  assert.equal(nova.user_id, U1);
  await u1.apagar('lancamentos', '00000000-0000-0000-0000-0000000000d2');
  assert.ok(b.t.lancamentos.some((l) => l.user_id === U2));
  assert.throws(() => doUsuario(b.rest, 'abc'));
  await assert.rejects(u1.apagar('lancamentos', '1 or 1=1'));
});

test('toda chamada ao banco, exceto a busca do vínculo, filtra ou grava com o user_id', async () => {
  const s = montar();
  for (const t of ['45 mercado', '600 tênis 3x', 'hoje', 'semana', 'desfazer', 'ajuda']) await s.msg(t);
  for (const c of s.banco.chamadas) {
    if (c.tabela === 'whatsapp_vinculos') continue;
    const ok = c.tabela.startsWith('rpc/') ? c.corpo.p_user === U1
      : c.metodo === 'POST' ? c.corpo.user_id === U1 : new URLSearchParams(c.q).get('user_id') === 'eq.' + U1;
    assert.ok(ok, `${c.metodo} ${c.tabela} ${c.q}`);
  }
});

// ---------- Logs ----------
test('logs não têm o texto da mensagem nem o telefone completo', async () => {
  const s = montar();
  await s.msg('45 mercadinho secreto');
  await s.msg('oi', ESTRANHO);
  await s.post(payload('x', EU, 'w'), 'sha256=00');
  const tudo = s.logs.join('\n');
  assert.ok(s.logs.length >= 3);
  assert.doesNotMatch(tudo, /secreto|mercadinho/);
  for (const n of [EU, ESTRANHO]) assert.ok(!tudo.includes(n.slice(0, -4)));
  assert.match(tudo, /"fim":"0001"/);
});

// ---------- Chave do Supabase: sb_secret_ (nova) e JWT (legada) ----------
const capturar = () => {
  const reqs = [];
  return { reqs, fetchFn: async (url, init) => { reqs.push({ url, headers: init.headers }); return new Response('[]', { status: 200 }); } };
};

test('chave nova sb_secret_: só no apikey, sem Authorization', async () => {
  const { reqs, fetchFn } = capturar();
  await restSupabase('https://x.supabase.co', 'sb_secret_TESTE', fetchFn)('GET', 'config', 'select=*');
  assert.equal(reqs[0].headers.apikey, 'sb_secret_TESTE');
  assert.equal('Authorization' in reqs[0].headers, false);
});

test('chave legada JWT: apikey e Authorization: Bearer', async () => {
  const { reqs, fetchFn } = capturar();
  await restSupabase('https://x.supabase.co', 'eyJ.teste.jwt', fetchFn)('GET', 'config', 'select=*');
  assert.equal(reqs[0].headers.apikey, 'eyJ.teste.jwt');
  assert.equal(reqs[0].headers.Authorization, 'Bearer eyJ.teste.jwt');
});

test('chave vazia ou publishable: recusa antes de chamar o banco', () => {
  for (const k of ['', 'sb_publishable_TESTE', 'qualquer']) assert.throws(() => restSupabase('https://x', k, () => assert.fail()));
});

test('chaveDoSupabase: prefere SUPABASE_SECRET_KEYS (default), senão a service role legada', () => {
  assert.equal(chaveDoSupabase('{"default":"sb_secret_A","outra":"sb_secret_B"}', 'eyJ.x'), 'sb_secret_A');
  assert.equal(chaveDoSupabase('{"bot":"sb_secret_B"}', 'eyJ.x'), 'sb_secret_B');
  assert.equal(chaveDoSupabase(undefined, 'eyJ.x'), 'eyJ.x');
  assert.equal(chaveDoSupabase('{quebrado', 'eyJ.x'), 'eyJ.x');
  assert.equal(chaveDoSupabase('{}', undefined), '');
});

test('o fluxo completo funciona com as duas formas de chave (fetch falso que exige o header certo)', async () => {
  for (const chave of ['sb_secret_TESTE', 'eyJ.teste.jwt']) {
    const b = bancoFalso();
    const memoria = b.rest;
    const fetchFn = async (url, init) => {
      // Gateway falso: sb_secret_ com Bearer é recusado, como no Supabase.
      const h = init.headers;
      if (h.apikey !== chave || (chave.startsWith('sb_') ? 'Authorization' in h : h.Authorization !== 'Bearer ' + chave)) return new Response('', { status: 401 });
      const u = new URL(url), tabela = u.pathname.replace('/rest/v1/', '');
      const r = await memoria(init.method, tabela, u.search.slice(1), init.body && JSON.parse(init.body), h.Prefer);
      return new Response(JSON.stringify(r ?? null), { status: 200 });
    };
    b.rest = restSupabase('https://x.supabase.co', chave, fetchFn);
    const s = montar(b);
    await s.msg('45 mercado');
    assert.equal(s.banco.t.lancamentos.length, 1, chave);
    assert.match(s.ultima(), /^✓ R\$\s45,00/, chave);
  }
});

// ---------- 2500 lançamentos: o bot não esbarra no limite de 1000 linhas ----------
test('2500 lançamentos: "hoje" e a confirmação batem com o cálculo sobre todas as linhas', async () => {
  const b = bancoFalso();
  b.t.config[0].mes_inicio = '2026-01-01';
  b.t.config[0].saldo_inicial = 100000;
  b.t.receitas.push({ user_id: U1, descricao: 'Salário', valor: 20000, recorrente: true, inicio: '2026-01-01', fim: null });
  for (let i = 0; i < 2500; i++) {
    const data = `2026-${String(1 + (i % 11)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`;
    b.t.lancamentos.push({ id: 'l' + i, user_id: U1, data, valor: 10 + (i % 7), categoria: 'Mercado', origem: 'app' });
  }
  b.t.lancamentos.push({ id: 'u2', user_id: U2, data: '2026-11-27', valor: 99999, categoria: 'Outros' }); // de outra pessoa
  const esperado = () => resumoMes({ contas: [], receitas: b.t.receitas, compromissos: [], parcelas: [], config: b.t.config[0], lancamentos: b.t.lancamentos.filter((l) => l.user_id === U1) }, '2026-11-27');
  const s = montar(b);
  await s.msg('hoje');
  const r = esperado();
  assert.ok(r.gastosHoje > 0);
  const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  assert.equal(s.ultima(), `Hoje você gastou ${brl(r.gastosHoje)}.
Disponível hoje: ${brl(Math.max(0, r.restanteHoje))} (limite do dia ${brl(r.limiteDia)}).
Até o fim do mês: ${brl(r.disponivel)}.`);
  await s.msg('45 mercado');
  const r2 = esperado();
  assert.ok(s.ultima().endsWith(`Disponível hoje: ${brl(Math.max(0, r2.restanteHoje))} (limite do dia ${brl(r2.limiteDia)}).`));
  // nenhuma leitura de lançamentos chegou perto do corte de 1000 linhas
  assert.ok(!b.chamadas.some((c) => c.tabela === 'lancamentos' && c.metodo === 'GET' && !/data=eq\./.test(c.q) && !/limit=1/.test(c.q) && !/data=gte\.2026-11-21/.test(c.q)));
});

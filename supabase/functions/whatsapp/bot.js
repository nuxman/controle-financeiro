// Bot de WhatsApp (WhatsApp Business Cloud API, oficial da Meta). JavaScript puro para rodar igual no
// Deno (Edge Function, via index.ts) e no Node (testes em tests/whatsapp.test.mjs).
// A lógica de parse e de cálculo é a do app: ../_shared/calc.js é cópia de js/calc.js (npm run copiar-calc).
import { parseRapido, resumoMes, brl, mesDe, hojeEfetivo } from '../_shared/calc.js';

export const FUSO = 'America/Manaus';
export const LIMITE_HORA = 30;
const DESFAZER_MS = 15 * 60 * 1000;
const MAX_CORPO = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABELAS = new Set(['contas', 'receitas', 'compromissos', 'parcelas', 'lancamentos', 'config', 'whatsapp_vinculos', 'whatsapp_mensagens', 'rpc/gastos_por_mes']);
const MEIOS = { debito: 'débito', credito: 'crédito', pix: 'pix', dinheiro: 'dinheiro' };
export const NAO_ENTENDI = 'Não entendi. Ex.: 45 mercado pix';
export const AJUDA = [
  'Comandos:',
  '• 45 mercado · 30 uber pix · 120 farmácia crédito · 600 tênis 3x → registra o gasto',
  '• hoje → gasto do dia e quanto ainda pode gastar',
  '• semana → gastos dos últimos 7 dias por categoria',
  '• desfazer → apaga o último lançamento feito aqui (até 15 min)',
  '• ajuda → esta lista',
].join('\n');

// ---------------- Segurança ----------------
const enc = new TextEncoder();

// Comparação em tempo constante (não para no primeiro byte diferente).
export function iguais(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] | 0) ^ (y[i] | 0);
  return d === 0;
}

export async function assinar(segredo, corpo) {
  const k = await crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(corpo)));
  return 'sha256=' + Array.from(s, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function assinaturaValida(segredo, corpo, cabecalho) {
  if (!segredo || !cabecalho) return false;
  return iguais(await assinar(segredo, corpo), cabecalho);
}

// Logs: nunca o texto da mensagem nem o telefone completo.
export const fim4 = (tel) => String(tel || '').slice(-4);

// ---------------- Banco (chave secreta: ignora o RLS) ----------------
// Chave que o Supabase injeta na função. Nova: SUPABASE_SECRET_KEYS = {"default":"sb_secret_..."} (usa "default",
// ou a primeira). Legada: SUPABASE_SERVICE_ROLE_KEY (JWT). Nenhuma das duas é definida à mão.
export function chaveDoSupabase(secretKeysJson, serviceRoleKey) {
  try {
    const ks = JSON.parse(secretKeysJson || '{}');
    const k = ks.default || Object.values(ks)[0];
    if (k) return k;
  } catch { /* cai na legada */ }
  return serviceRoleKey || '';
}

// sb_secret_ não é JWT: vai só no apikey (com Authorization: Bearer o gateway recusa). JWT legado: apikey + Bearer.
export function cabecalhosSupabase(chave) {
  if (/^sb_secret_/.test(chave)) return { apikey: chave };
  if (/^eyJ/.test(chave)) return { apikey: chave, Authorization: `Bearer ${chave}` };
  throw new Error('chave do Supabase ausente ou não é secreta'); // publishable/anon não serve: o RLS bloquearia tudo
}

export function restSupabase(url, chave, fetchFn = fetch) {
  const auth = cabecalhosSupabase(chave);
  return async (metodo, tabela, consulta = '', corpo, prefer = 'return=representation') => {
    if (!TABELAS.has(tabela)) throw new Error('tabela não permitida');
    const r = await fetchFn(`${url}/rest/v1/${tabela}${consulta ? '?' + consulta : ''}`, {
      method: metodo,
      headers: { ...auth, 'Content-Type': 'application/json', Prefer: prefer },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    if (!r.ok) throw new Error(`rest ${r.status}`);
    return r.status === 204 ? null : r.json();
  };
}

// ÚNICA porta de acesso aos dados de um usuário: toda leitura, escrita e exclusão leva user_id = o do vínculo.
export function doUsuario(rest, userId) {
  if (!UUID.test(String(userId))) throw new Error('user_id inválido');
  const comDono = (q) => `user_id=eq.${userId}${q ? '&' + q : ''}`;
  return {
    userId,
    listar: (tabela, q = '') => rest('GET', tabela, comDono(q)),
    inserir: (tabela, linha, q = '', prefer) => rest('POST', tabela, q, { ...linha, user_id: userId }, prefer),
    // Total gasto por mês, agregado no banco (não esbarra no limite de 1000 linhas do PostgREST).
    gastosPorMes: (desde) => rest('POST', 'rpc/gastos_por_mes', '', { p_user: userId, p_desde: desde }),
    apagar: async (tabela, id) => {
      if (!UUID.test(String(id))) throw new Error('id inválido');
      return rest('DELETE', tabela, comDono('id=eq.' + id));
    },
  };
}

// Única consulta sem user_id (é ela que descobre o user_id).
export async function buscarVinculo(rest, telefone) {
  const r = await rest('GET', 'whatsapp_vinculos', `select=user_id&telefone_e164=eq.${encodeURIComponent(telefone)}&limit=1`);
  return r?.[0]?.user_id || null;
}

// ---------------- Datas no fuso do usuário ----------------
export const dataNoFuso = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const menosDias = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);

async function carregarDados(u, hoje) {
  const [config] = await u.listar('config', 'select=*');
  const dia = hojeEfetivo({ config }, hoje);
  const inicio = config?.mes_inicio ? mesDe(config.mes_inicio) : mesDe(dia);
  const desde = (inicio < mesDe(dia) ? inicio : mesDe(dia)) + '-01';
  const [contas, receitas, compromissos, parcelas, meses, doDia] = await Promise.all([
    u.listar('contas', 'select=*'), u.listar('receitas', 'select=*'), u.listar('compromissos', 'select=*'),
    u.listar('parcelas', 'select=*'), u.gastosPorMes(desde), u.listar('lancamentos', `select=data,valor&data=eq.${dia}`),
  ]);
  // resumoMes só precisa do total por mês (projeção) e das linhas do dia (gastosHoje). Cada mês vira uma linha
  // sintética com data 'AAAA-MM' (nunca igual a hoje), sem o que já veio nas linhas do dia.
  const somaDia = doDia.reduce((s, l) => s + Number(l.valor), 0);
  const lancamentos = meses.map((m) => {
    const mes = mesDe(m.mes);
    return { data: mes, valor: Math.round((Number(m.total) - (mes === mesDe(dia) ? somaDia : 0)) * 100) / 100 };
  }).concat(doDia);
  return { contas, receitas, compromissos, parcelas, lancamentos, config: config || null };
}

const maiuscula = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const disponivelHoje = (r) => `Disponível hoje: ${brl(Math.max(0, r.restanteHoje))} (limite do dia ${brl(r.limiteDia)}).`;

// ---------------- Comandos ----------------
export async function responder(u, texto, wamid, agora) {
  const t = String(texto || '').trim().slice(0, 200);
  const cmd = t.toLowerCase();
  const hoje = dataNoFuso(agora);

  if (cmd === 'ajuda') return AJUDA;

  if (cmd === 'hoje') {
    const r = resumoMes(await carregarDados(u, hoje), hoje);
    return `Hoje você gastou ${brl(r.gastosHoje)}.\n${disponivelHoje(r)}\nAté o fim do mês: ${brl(r.disponivel)}.`;
  }

  if (cmd === 'semana') {
    const ls = await u.listar('lancamentos', `select=valor,categoria&data=gte.${menosDias(hoje, 6)}&data=lte.${hoje}`);
    if (!ls.length) return 'Nenhum gasto nos últimos 7 dias.';
    const por = {};
    for (const l of ls) por[l.categoria] = (por[l.categoria] || 0) + Number(l.valor);
    const total = Object.values(por).reduce((a, b) => a + b, 0);
    const top = Object.entries(por).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return [`Últimos 7 dias: ${brl(total)}`, ...top.map(([c, v]) => `• ${c}: ${brl(v)}`)].join('\n');
  }

  if (cmd === 'desfazer') {
    const q = 'select=id,valor,valor_parcela,quantidade,descricao,created_at&origem=eq.whatsapp&order=created_at.desc&limit=1';
    const [l] = await u.listar('lancamentos', q);
    const [p] = await u.listar('parcelas', q);
    const [tabela, ult] = !p || (l && l.created_at >= p.created_at) ? ['lancamentos', l] : ['parcelas', p];
    if (!ult || agora.getTime() - Date.parse(ult.created_at) > DESFAZER_MS) return 'Nada para desfazer (só vale para o último lançamento feito aqui nos últimos 15 minutos).';
    await u.apagar(tabela, ult.id);
    const valor = tabela === 'parcelas' ? Number(ult.valor_parcela) * Number(ult.quantidade) : Number(ult.valor);
    return `Desfeito: ${brl(valor)} · ${maiuscula(ult.descricao || '')}.`;
  }

  const p = parseRapido(t);
  if (p.erro) return NAO_ENTENDI;
  const extra = { origem: 'whatsapp', wamid };
  if (p.parcelas > 1) {
    await u.inserir('parcelas', { descricao: p.descricao, categoria: p.categoria, valor_parcela: Math.round(p.valor / p.parcelas * 100) / 100, primeiro_mes: mesDe(hoje) + '-01', quantidade: p.parcelas, cartao: 'crédito', ...extra });
  } else {
    await u.inserir('lancamentos', { data: hoje, valor: p.valor, descricao: p.descricao, categoria: p.categoria, meio: p.meio, ...extra });
  }
  const r = resumoMes(await carregarDados(u, hoje), hoje);
  const desc = maiuscula(p.descricao) + (p.categoria.toLowerCase() !== p.descricao.toLowerCase() ? ` (${p.categoria})` : '');
  const meio = MEIOS[p.meio] + (p.parcelas > 1 ? ` ${p.parcelas}x de ${brl(p.valor / p.parcelas)}` : '');
  return `✓ ${brl(p.valor)} · ${desc} · ${meio}. ${disponivelHoje(r)}`;
}

// ---------------- Envio (Graph API) ----------------
export function enviarWhatsApp(env, fetchFn = fetch) {
  return async (para, texto) => {
    if (!/^v\d+\.\d+$/.test(env.GRAPH_API_VERSION || '') || !/^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID || '')) throw new Error('config do envio inválida');
    const r = await fetchFn(`https://graph.facebook.com/${env.GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto.slice(0, 4000) } }),
    });
    if (!r.ok) throw new Error(`graph ${r.status}`);
  };
}

// ---------------- Uma mensagem recebida ----------------
export async function processarMensagem(m, { rest, enviar, agora, log }) {
  const from = String(m?.from || '');
  const wamid = String(m?.id || '');
  if (!/^\d{8,15}$/.test(from) || !wamid || wamid.length > 200) return log('mensagem_invalida');
  const userId = await buscarVinculo(rest, '+' + from);
  if (!userId) return log('numero_nao_vinculado', { fim: fim4(from) }); // silêncio: não confirma que o bot existe
  const u = doUsuario(rest, userId);
  // A Meta reenvia: o wamid é único no banco, e o repetido não grava nada.
  const novo = await u.inserir('whatsapp_mensagens', { wamid }, 'on_conflict=wamid', 'resolution=ignore-duplicates,return=representation');
  if (!novo?.length) return log('wamid_repetido', { fim: fim4(from) });
  const umaHora = new Date(agora.getTime() - 3600000).toISOString();
  const n = (await u.listar('whatsapp_mensagens', `select=id&created_at=gte.${umaHora}`)).length;
  if (n > LIMITE_HORA) {
    log('limite_hora', { fim: fim4(from) });
    if (n === LIMITE_HORA + 1) await enviar(from, `Limite de ${LIMITE_HORA} mensagens por hora atingido. As próximas serão ignoradas por um tempo.`);
    return;
  }
  let resposta;
  try {
    resposta = m.type === 'text' ? await responder(u, m.text?.body, wamid, agora) : NAO_ENTENDI;
  } catch {
    log('erro_comando', { fim: fim4(from) });
    resposta = 'Não consegui registrar agora. Tente de novo em instantes.';
  }
  await enviar(from, resposta);
  log('respondido', { fim: fim4(from) });
}

export function mensagensDoPayload(j) {
  const out = [];
  for (const e of j?.entry || []) for (const c of e?.changes || []) {
    if (c?.field === 'messages') for (const m of c?.value?.messages || []) out.push(m);
  }
  return out;
}

// ---------------- Webhook ----------------
// deps: { env, rest, enviar, agora: () => Date, log, emSegundoPlano: (promise) => void }
export function criarHandler(deps) {
  const { env } = deps;
  const log = deps.log || ((evento, extra) => console.log(JSON.stringify({ evento, ...extra })));
  return async (req) => {
    const url = new URL(req.url);
    if (req.method === 'GET') {
      const ok = env.WHATSAPP_VERIFY_TOKEN && url.searchParams.get('hub.mode') === 'subscribe' &&
        iguais(url.searchParams.get('hub.verify_token') || '', env.WHATSAPP_VERIFY_TOKEN);
      return ok ? new Response(url.searchParams.get('hub.challenge') || '', { status: 200 }) : new Response('', { status: 403 });
    }
    if (req.method !== 'POST') return new Response('', { status: 405 });
    if (Number(req.headers.get('content-length') || 0) > MAX_CORPO) return new Response('', { status: 413 });
    const corpo = await req.text(); // corpo BRUTO: a assinatura é sobre os bytes exatos
    if (corpo.length > MAX_CORPO || !(await assinaturaValida(env.WHATSAPP_APP_SECRET, corpo, req.headers.get('x-hub-signature-256')))) {
      log('assinatura_invalida');
      return new Response('', { status: 401 });
    }
    // Daqui em diante, sempre 200 (senão a Meta fica reenviando). O trabalho continua depois da resposta.
    const trabalho = (async () => {
      let msgs;
      try { msgs = mensagensDoPayload(JSON.parse(corpo)); } catch { return log('json_invalido'); }
      for (const m of msgs) {
        try { await processarMensagem(m, { ...deps, log, agora: deps.agora() }); } catch { log('erro_interno'); }
      }
    })();
    deps.emSegundoPlano(trabalho);
    return new Response('ok', { status: 200 });
  };
}

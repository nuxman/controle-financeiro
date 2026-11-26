// Cliente mínimo para Supabase (Auth + REST), sem bibliotecas externas.
// Motivo: evitar carregar código de CDN de terceiros numa página com dados financeiros.

const TABELAS = new Set(['contas', 'receitas', 'compromissos', 'parcelas', 'lancamentos', 'config', 'limites']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAVE_SESSAO = 'cf.sessao';

function decodeJwt(t) {
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}

// Recusa configuração perigosa: a chave secreta nunca pode ir para o navegador.
export function validarConfig(url, chave) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url || '')) return 'SUPABASE_URL inválida (esperado https://xxxx.supabase.co).';
  if (/SEU-PROJETO/i.test(url) || !chave || /COLE-AQUI/i.test(chave)) return 'O app ainda não está ligado ao Supabase: preencha a URL do projeto e a chave anon/publishable em js/config.js.';
  if (/^sb_secret_/i.test(chave)) return 'Você colou a chave SECRETA. Use a chave publishable/anon e troque a secreta no painel do Supabase.';
  const p = chave.startsWith('eyJ') ? decodeJwt(chave) : null;
  if (p && p.role === 'service_role') return 'Você colou a chave service_role. Use a chave anon e gere uma nova service_role no painel do Supabase.';
  return null;
}

export function criarCliente(url, chave) {
  let sessao = null;
  try { sessao = JSON.parse(localStorage.getItem(CHAVE_SESSAO) || 'null'); } catch { sessao = null; }

  const salvar = (s) => {
    sessao = s;
    try { s ? localStorage.setItem(CHAVE_SESSAO, JSON.stringify(s)) : localStorage.removeItem(CHAVE_SESSAO); } catch { /* modo privado */ }
  };

  async function auth(caminho, corpo) {
    const r = await fetch(`${url}/auth/v1/${caminho}`, {
      method: 'POST',
      headers: { apikey: chave, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.msg || 'Falha na autenticação.');
    return j;
  }

  function guardar(j) {
    salvar({ access_token: j.access_token, refresh_token: j.refresh_token, expira: Date.now() + (j.expires_in - 60) * 1000, email: j.user?.email });
  }

  async function token() {
    if (!sessao) return null;
    if (Date.now() < sessao.expira) return sessao.access_token;
    try { guardar(await auth('token?grant_type=refresh_token', { refresh_token: sessao.refresh_token })); return sessao.access_token; }
    catch { salvar(null); return null; }
  }

  async function rest(metodo, tabela, consulta = '', corpo, prefer = 'return=representation') {
    if (!TABELAS.has(tabela)) throw new Error('Tabela não permitida.');
    const t = await token();
    if (!t) throw new Error('SESSAO');
    const r = await fetch(`${url}/rest/v1/${tabela}${consulta ? '?' + consulta : ''}`, {
      method: metodo,
      headers: { apikey: chave, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Prefer: prefer },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    if (r.status === 401) { salvar(null); throw new Error('SESSAO'); }
    const j = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && (j.message || j.hint)) || `Erro ${r.status}`);
    return j;
  }

  const porId = (id) => { if (!UUID.test(String(id))) throw new Error('id inválido'); return 'id=eq.' + encodeURIComponent(id); };

  return {
    get logado() { return !!sessao; },
    get email() { return sessao?.email || ''; },
    async entrar(email, senha) { guardar(await auth('token?grant_type=password', { email, password: senha })); },
    async sair() {
      const t = sessao?.access_token;
      salvar(null);
      if (t) await fetch(`${url}/auth/v1/logout`, { method: 'POST', headers: { apikey: chave, Authorization: `Bearer ${t}` } }).catch(() => {});
    },
    listar: (tabela, ordem = 'created_at.asc') => rest('GET', tabela, 'select=*&order=' + encodeURIComponent(ordem)),
    inserir: (tabela, linha) => rest('POST', tabela, '', linha),
    atualizar: (tabela, id, campos) => rest('PATCH', tabela, porId(id), campos),
    apagar: (tabela, id) => rest('DELETE', tabela, porId(id)),
    salvarConfig: (campos) => rest('POST', 'config', 'on_conflict=user_id', campos, 'resolution=merge-duplicates,return=representation'),
  };
}

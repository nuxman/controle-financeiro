import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { criarCliente, validarConfig } from './supa.js';
import * as c from './calc.js';

// Impede que a página seja exibida dentro de outro site (clickjacking).
if (window.top !== window.self) { document.body.textContent = ''; throw new Error('frame'); }

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// Cria elementos sempre com textContent: nenhum dado vira HTML (proteção contra XSS).
function h(tag, attrs = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v); // via CSSOM: permitido pela CSP
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) if (f != null && f !== false) el.append(f instanceof Node ? f : String(f));
  return el;
}

function aviso(msg, tipo = 'ok') {
  const el = $('#aviso');
  el.textContent = msg; el.className = 'aviso ' + tipo; el.hidden = false;
  clearTimeout(aviso.t); aviso.t = setTimeout(() => { el.hidden = true; }, 4000);
}

const erroConfig = validarConfig(SUPABASE_URL, SUPABASE_ANON_KEY);
if (erroConfig) {
  $('#erro-config').textContent = 'Configuração: ' + erroConfig + ' Edite js/config.js.';
  $('#erro-config').hidden = false;
  throw new Error(erroConfig);
}

const db = criarCliente(SUPABASE_URL, SUPABASE_ANON_KEY);
let dados = { contas: [], receitas: [], compromissos: [], parcelas: [], lancamentos: [], config: null, limites: [] };

async function seguro(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.message === 'SESSAO') { mostrarLogin(); aviso('Sua sessão expirou. Entre de novo.', 'atencao'); }
    else aviso(e.message || 'Erro inesperado.', 'ruim');
    return null;
  }
}

// ---------------- Login ----------------
function mostrarLogin() {
  $('#tela-login').hidden = false; $('#tela-app').hidden = true; $('#usuario').hidden = true;
}
async function mostrarApp() {
  $('#tela-login').hidden = true; $('#tela-app').hidden = false; $('#usuario').hidden = false;
  $('#email').textContent = db.email;
  await carregar();
}

$('#form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const btn = ev.target.querySelector('button'); btn.disabled = true;
  try { await db.entrar(String(f.get('email')).trim(), String(f.get('senha'))); ev.target.reset(); await mostrarApp(); }
  catch (e) { aviso(e.message, 'ruim'); }
  finally { btn.disabled = false; }
});
$('#btn-sair').addEventListener('click', async () => { await db.sair(); dados = { contas: [], receitas: [], compromissos: [], parcelas: [], lancamentos: [], config: null, limites: [] }; mostrarLogin(); });

// ---------------- Abas ----------------
$$('.abas button').forEach((b) => b.addEventListener('click', () => {
  $$('.abas button').forEach((x) => x.classList.toggle('ativa', x === b));
  $$('.aba').forEach((s) => { s.hidden = s.id !== 'aba-' + b.dataset.aba; });
}));

// ---------------- Carregar dados ----------------
async function carregar() {
  await seguro(async () => {
    const [contas, receitas, compromissos, parcelas, lancamentos, config, limites] = await Promise.all([
      db.listar('contas'), db.listar('receitas'), db.listar('compromissos'), db.listar('parcelas'),
      db.listar('lancamentos', 'data.desc'), db.listar('config'), db.listar('limites'),
    ]);
    dados = { contas, receitas, compromissos, parcelas, lancamentos, config: config[0] || null, limites };
    renderTudo();
  });
}

function renderTudo() { renderPainel(); renderCadastros(); preencherConfig(); }

// ---------------- Painel ----------------
const STATUS = { ok: ['Bem', 'ok'], atencao: ['Atenção', 'atencao'], ruim: ['Preocupante', 'ruim'], sem_dados: ['Faltam dados', 'neutro'] };

function renderPainel() {
  const hoje = c.hojeISO();
  const r = c.resumoMes(dados, hoje);
  const ind = c.indicadores(dados, hoje);
  const proj = c.projecao(dados, hoje, 12);

  const [txt, cls] = STATUS[ind.geral];
  $('#status-geral').className = 'card status ' + cls;
  $('#status-texto').textContent = txt;
  const ruins = ind.lista.filter((i) => i.status === 'ruim').map((i) => i.nome.toLowerCase());
  const negativos = proj.filter((p) => p.mes >= r.mes && p.acumulado < 0).map((p) => c.nomeMes(p.mes));
  let frase;
  if (r.disponivel < 0) frase = `Faltam ${c.brl(-r.piorAcumulado)} para cobrir tudo o que já está previsto (pior mês: ${c.nomeMes(r.piorMes)}). `;
  else if (r.reservarPara) frase = `Você termina ${c.nomeMes(r.mes)} com ${c.brl(r.saldoFimMes)}, mas ${c.brl(r.saldoFimMes - r.disponivel)} precisam ficar guardados para ${c.nomeMes(r.reservarPara)}. `;
  else frase = `Disponível até o fim de ${c.nomeMes(r.mes)}: ${c.brl(r.disponivel)}. `;
  frase += negativos.length ? `Meses previstos no vermelho: ${negativos.join(', ')}. ` : 'Nenhum mês dos próximos 12 previsto no vermelho. ';
  if (ruins.length) frase += `Pontos fracos: ${ruins.join('; ')}.`;
  $('#status-frase').textContent = frase;

  $('#k-hoje').textContent = c.brl(Math.max(0, r.restanteHoje));
  $('#k-hoje').className = 'grande ' + (r.restanteHoje < 0 ? 'ruim' : '');
  $('#k-hoje-nota').textContent = r.gastosHoje > 0
    ? `limite ${c.brl(r.limiteDia)} · gasto hoje ${c.brl(r.gastosHoje)}` + (r.restanteHoje < 0 ? ` · ${c.brl(-r.restanteHoje)} acima` : '')
    : `limite do dia ${c.brl(r.limiteDia)}`;
  $('#k-livre').textContent = c.brl(r.disponivel);
  $('#k-livre').className = 'grande ' + (r.disponivel < 0 ? 'ruim' : 'ok');
  $('#k-dias').textContent = `${r.diasRestantes} dia(s) até o fim de ${c.nomeMes(r.mes)}` + (r.reservarPara ? ` · já descontado o que ${c.nomeMes(r.reservarPara)} vai precisar` : '');
  $('#k-gasto').textContent = c.brl(r.gastos);
  $('#k-gasto-nota').textContent = `renda do mês ${c.brl(r.renda)} · contas ${c.brl(r.fixos)} · parcelas ${c.brl(r.parcelas)}`;
  const corrente = dados.contas.filter((x) => x.tipo === 'corrente').reduce((s, x) => s + Number(x.saldo), 0);
  const reserva = dados.contas.filter((x) => x.tipo !== 'corrente').reduce((s, x) => s + Number(x.saldo), 0);
  $('#k-conta').textContent = c.brl(corrente);
  $('#k-reserva').textContent = `reserva e investimentos ${c.brl(reserva)}`;

  $('#lista-indicadores').replaceChildren(...ind.lista.map((i) => h('li', { class: STATUS[i.status][1] },
    h('span', { class: 'bola' }), h('span', { class: 'nome' }, i.nome),
    h('strong', {}, i.tipo === 'pct' ? c.pct(i.valor) : (i.valor == null ? '—' : i.valor.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' meses')),
    h('span', { class: 'ref' }, 'ref.: ' + i.ref))));

  const vis = proj.filter((p) => p.mes >= r.mes).slice(0, 7);
  const max = Math.max(1, ...vis.map((p) => Math.abs(p.acumulado)));
  $('#projecao').replaceChildren(...vis.map((p, idx) => h('div', { class: 'barra-linha' },
    h('span', { class: 'mes' }, c.nomeMes(p.mes) + (idx === 0 ? ' (atual)' : '')),
    h('span', { class: 'trilho' }, h('span', { class: 'barra ' + (p.acumulado < 0 ? 'ruim' : 'ok'), style: { width: Math.round(Math.abs(p.acumulado) / max * 100) + '%' } })),
    h('span', { class: 'valor ' + (p.acumulado < 0 ? 'ruim' : '') }, c.brl(p.acumulado)))));

  // Categorias do mês
  const porCat = {};
  dados.lancamentos.filter((l) => c.mesDe(l.data) === r.mes).forEach((l) => { porCat[l.categoria] = (porCat[l.categoria] || 0) + Number(l.valor); });
  const lim = Object.fromEntries(dados.limites.map((l) => [l.categoria, Number(l.limite_mensal)]));
  const cats = [...new Set([...Object.keys(porCat), ...Object.keys(lim)])].sort((a, b) => (porCat[b] || 0) - (porCat[a] || 0));
  $('#categorias').replaceChildren(cats.length ? h('div', { class: 'tabela' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Categoria'), h('th', { class: 'd' }, 'Gasto'), h('th', { class: 'd' }, 'Referência'), h('th', { class: 'd' }, 'Uso'))),
    h('tbody', {}, cats.map((k) => {
      const g = porCat[k] || 0, l = lim[k];
      const uso = l ? g / l : null;
      return h('tr', {}, h('td', {}, k), h('td', { class: 'd' }, c.brl(g)), h('td', { class: 'd' }, l ? c.brl(l) : '—'),
        h('td', { class: 'd ' + (uso == null ? '' : uso >= 1 ? 'ruim' : uso >= 0.8 ? 'atencao' : 'ok') }, uso == null ? '—' : c.pct(uso)));
    })))) : h('p', { class: 'nota' }, 'Nenhum gasto lançado neste mês.'));

  $('#ultimos').replaceChildren(...(dados.lancamentos.slice(0, 15).map((l) => h('li', {},
    h('span', { class: 'data' }, l.data.split('-').reverse().slice(0, 2).join('/')),
    h('span', { class: 'desc' }, l.descricao || l.categoria, h('small', {}, ` ${l.categoria} · ${l.meio}`)),
    h('strong', {}, c.brl(l.valor)),
    h('button', { type: 'button', class: 'mini', 'aria-label': 'Apagar', onclick: () => apagar('lancamentos', l.id) }, '✕')))));
  if (!dados.lancamentos.length) $('#ultimos').append(h('li', { class: 'nota' }, 'Nada lançado ainda. Use a aba Lançar.'));
}

async function apagar(tabela, id) {
  await seguro(async () => { await db.apagar(tabela, id); await carregar(); aviso('Apagado.'); });
}

// ---------------- Lançamento rápido ----------------
const fr = $('#form-rapido');
fr.categoria.replaceChildren(...c.CATEGORIAS.map((k) => new Option(k, k)));
fr.data.value = c.hojeISO();
let tocouCategoria = false, tocouMeio = false;
fr.categoria.addEventListener('change', () => { tocouCategoria = true; });
fr.meio.addEventListener('change', () => { tocouMeio = true; });
fr.texto.addEventListener('input', () => {
  const p = c.parseRapido(fr.texto.value);
  if (p.erro) { $('#previa').textContent = fr.texto.value ? p.erro : ''; return; }
  if (!tocouCategoria) fr.categoria.value = p.categoria;
  if (!tocouMeio) fr.meio.value = p.meio;
  $('#previa').textContent = `${c.brl(p.valor)} · ${p.descricao}` + (p.parcelas > 1 ? ` · ${p.parcelas}x de ${c.brl(p.valor / p.parcelas)}` : '');
});
fr.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const p = c.parseRapido(fr.texto.value);
  if (p.erro) { aviso(p.erro, 'atencao'); return; }
  const btn = fr.querySelector('button'); btn.disabled = true;
  await seguro(async () => {
    if (p.parcelas > 1) {
      await db.inserir('parcelas', { descricao: p.descricao, categoria: fr.categoria.value, valor_parcela: Math.round(p.valor / p.parcelas * 100) / 100, primeiro_mes: c.mesDe(fr.data.value) + '-01', quantidade: p.parcelas, cartao: 'crédito' });
    } else {
      await db.inserir('lancamentos', { data: fr.data.value, valor: p.valor, descricao: p.descricao, categoria: fr.categoria.value, meio: fr.meio.value });
    }
    await carregar();
    const r = c.resumoMes(dados, c.hojeISO());
    aviso(`Registrado. Disponível hoje: ${c.brl(Math.max(0, r.restanteHoje))}` + (r.restanteHoje < 0 ? ` (${c.brl(-r.restanteHoje)} acima do ritmo)` : ''));
    fr.texto.value = ''; $('#previa').textContent = ''; tocouCategoria = tocouMeio = false; fr.data.value = c.hojeISO();
  });
  btn.disabled = false;
});

// ---------------- Simulador ----------------
const fs = $('#form-simular');
fs.mes.value = c.mesDe(c.hojeISO());
fs.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const s = c.simular(dados, { valor: Number(fs.valor.value), parcelas: Number(fs.parcelas.value), primeiroMes: fs.mes.value }, c.hojeISO());
  const fatos = [
    `${s.n}x de ${c.brl(s.valorParcela)}, de ${c.nomeMes(s.primeiroMes)} a ${c.nomeMes(c.addMeses(s.primeiroMes, s.n - 1))}.`,
    s.viramNegativos.length
      ? `Com a compra, o saldo previsto fica negativo em: ${s.viramNegativos.map((l) => `${c.nomeMes(l.mes)} (${c.brl(l.acumDepois)})`).join(', ')}.`
      : 'A compra não deixa nenhum mês novo no vermelho.',
    s.jaNegativos.length ? `Atenção: ${s.jaNegativos.map((l) => c.nomeMes(l.mes)).join(', ')} já estava(m) no vermelho antes da compra.` : null,
    `Menor saldo previsto: ${c.brl(s.minAntes)} sem a compra, ${c.brl(s.minDepois)} com a compra.`,
    `Parcelas chegam a ${c.pct(s.piorParcRenda)} da renda no pior mês (referência: até 20%).`,
    s.mesesParaJuntar
      ? `Alternativa: guardando a sobra média prevista (${c.brl(s.sobraMedia)}/mês), você junta o valor à vista em ${s.mesesParaJuntar} mês(es).`
      : 'Alternativa de juntar à vista: a sobra prevista dos próximos meses não é positiva.',
  ].filter(Boolean);
  $('#sim-fatos').replaceChildren(...fatos.map((f) => h('li', {}, f)));
  $('#sim-tabela').replaceChildren(...s.linhas.filter((l, i) => i < 2 || l.parcelaCompra > 0 || i === s.linhas.length - 1).map((l) => h('tr', {},
    h('td', {}, c.nomeMes(l.mes)),
    h('td', { class: 'd' }, l.parcelaCompra > 0 ? c.brl(l.parcelaCompra) : '—'),
    h('td', { class: 'd ' + (l.acumAntes < 0 ? 'ruim' : '') }, c.brl(l.acumAntes)),
    h('td', { class: 'd ' + (l.acumDepois < 0 ? 'ruim' : '') }, c.brl(l.acumDepois)),
    h('td', { class: 'd' }, c.pct(l.parcelasRendaDepois)))));
  $('#resultado-simulacao').hidden = false;
});

// ---------------- Cadastros ----------------
const mesParaData = (v) => (v ? v + '-01' : null);
const dataParaMes = (v) => (v ? String(v).slice(0, 7) : '');

const CADASTROS = [
  { tabela: 'contas', titulo: 'Contas e saldos', ajuda: 'Atualize o saldo quando conferir no banco.',
    campos: [['nome', 'Nome', 'text'], ['tipo', 'Tipo', ['corrente', 'reserva', 'investimento']], ['saldo', 'Saldo (R$)', 'money']],
    linha: (x) => [`${x.nome} · ${x.tipo}`, c.brl(x.saldo)] },
  { tabela: 'receitas', titulo: 'Receitas', ajuda: 'Salário (recorrente) e entradas pontuais como 13º, bônus ou valores a receber.',
    campos: [['descricao', 'Descrição', 'text'], ['valor', 'Valor (R$)', 'money'], ['recorrente', 'Todo mês', 'bool'], ['mes', 'Mês (se pontual)', 'month'], ['inicio', 'A partir de', 'month'], ['fim', 'Até', 'month']],
    linha: (x) => [`${x.descricao} · ${x.recorrente ? 'mensal' : c.nomeMes(dataParaMes(x.mes))}`, c.brl(x.valor)] },
  { tabela: 'compromissos', titulo: 'Contas fixas e compromissos', ajuda: 'Contas mensais (luz, internet, assinaturas) e pagamentos pontuais (ex.: fatura já fechada).',
    campos: [['descricao', 'Descrição', 'text'], ['categoria', 'Categoria', c.CATEGORIAS], ['valor', 'Valor (R$)', 'money'], ['recorrente', 'Todo mês', 'bool'], ['mes', 'Mês (se pontual)', 'month'], ['inicio', 'A partir de', 'month'], ['fim', 'Até', 'month']],
    linha: (x) => [`${x.descricao} · ${x.recorrente ? 'mensal' : c.nomeMes(dataParaMes(x.mes))}`, c.brl(x.valor)] },
  { tabela: 'parcelas', titulo: 'Parcelas em andamento', ajuda: 'Informe o mês da próxima parcela e quantas ainda faltam.',
    campos: [['descricao', 'Descrição', 'text'], ['categoria', 'Categoria', c.CATEGORIAS], ['cartao', 'Cartão', 'text'], ['valor_parcela', 'Valor da parcela (R$)', 'money'], ['primeiro_mes', 'Próxima parcela em', 'month'], ['quantidade', 'Faltam', 'int']],
    linha: (x) => [`${x.descricao} · ${x.quantidade}x a partir de ${c.nomeMes(dataParaMes(x.primeiro_mes))}${x.cartao ? ' · ' + x.cartao : ''}`, c.brl(x.valor_parcela)] },
  { tabela: 'limites', titulo: 'Referência de gasto por categoria', ajuda: 'Opcional. Usado só para mostrar quanto da referência você já usou.',
    campos: [['categoria', 'Categoria', c.CATEGORIAS], ['limite_mensal', 'Valor mensal (R$)', 'money']],
    linha: (x) => [x.categoria, c.brl(x.limite_mensal)] },
];

function campo([nome, rotulo, tipo]) {
  let input;
  if (Array.isArray(tipo)) input = h('select', { name: nome }, tipo.map((o) => h('option', { value: o }, o)));
  else if (tipo === 'bool') return h('label', { class: 'check' }, h('input', { type: 'checkbox', name: nome }), rotulo);
  else if (tipo === 'money') input = h('input', { type: 'number', name: nome, step: '0.01', min: nome === 'saldo' ? '-9999999' : '0.01', max: '99999999', required: true, inputmode: 'decimal' });
  else if (tipo === 'int') input = h('input', { type: 'number', name: nome, step: '1', min: '1', max: '48', required: true });
  else if (tipo === 'month') input = h('input', { type: 'month', name: nome });
  else input = h('input', { type: 'text', name: nome, maxlength: '80', required: nome !== 'cartao' });
  return h('label', {}, rotulo, input);
}

function renderCadastros() {
  $('#cadastros').replaceChildren(...CADASTROS.map((cfg) => {
    const form = h('form', { class: 'form-cad' }, h('div', { class: 'linha' }, cfg.campos.map(campo)), h('button', { type: 'submit' }, 'Adicionar'));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const linha = {};
      for (const [nome, , tipo] of cfg.campos) {
        const el = form.elements[nome];
        if (tipo === 'bool') linha[nome] = el.checked;
        else if (tipo === 'month') linha[nome] = mesParaData(el.value);
        else if (tipo === 'money' || tipo === 'int') linha[nome] = Number(el.value);
        else linha[nome] = el.value.trim() || null;
      }
      if ('recorrente' in linha && !linha.recorrente && !linha.mes) { aviso('Informe o mês ou marque "Todo mês".', 'atencao'); return; }
      await seguro(async () => { await db.inserir(cfg.tabela, linha); await carregar(); aviso('Salvo.'); });
    });
    const itens = dados[cfg.tabela] || [];
    return h('div', { class: 'card' },
      h('h2', {}, cfg.titulo), h('p', { class: 'nota' }, cfg.ajuda),
      h('ul', { class: 'lista' }, itens.length ? itens.map((x) => {
        const [txt, val] = cfg.linha(x);
        const acoes = [h('button', { type: 'button', class: 'mini', 'aria-label': 'Apagar', onclick: () => apagar(cfg.tabela, x.id) }, '✕')];
        if (cfg.tabela === 'contas') acoes.unshift(h('button', { type: 'button', class: 'mini', onclick: () => editarSaldo(x) }, 'saldo'));
        return h('li', {}, h('span', { class: 'desc' }, txt), h('strong', {}, val), ...acoes);
      }) : h('li', { class: 'nota' }, 'Nada cadastrado.')),
      h('details', {}, h('summary', {}, 'Adicionar'), form));
  }));
}

async function editarSaldo(conta) {
  const v = prompt(`Novo saldo de ${conta.nome} (R$):`, String(conta.saldo));
  if (v == null) return;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  if (!isFinite(n)) { aviso('Valor inválido.', 'atencao'); return; }
  await seguro(async () => { await db.atualizar('contas', conta.id, { saldo: n, atualizado_em: c.hojeISO() }); await carregar(); aviso('Saldo atualizado.'); });
}

function preencherConfig() {
  const f = $('#form-config');
  f.meta_poupanca.value = dados.config?.meta_poupanca ?? 0;
  f.gasto_variavel_previsto.value = dados.config?.gasto_variavel_previsto ?? 0;
  f.saldo_inicial.value = dados.config?.saldo_inicial ?? 0;
  f.mes_inicio.value = dados.config?.mes_inicio ? String(dados.config.mes_inicio).slice(0, 7) : c.mesDe(c.hojeISO());
}
$('#form-config').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  await seguro(async () => {
    await db.salvarConfig({ meta_poupanca: Number(f.meta_poupanca.value) || 0, gasto_variavel_previsto: Number(f.gasto_variavel_previsto.value) || 0, saldo_inicial: Number(f.saldo_inicial.value) || 0, mes_inicio: f.mes_inicio.value + '-01', updated_at: new Date().toISOString() });
    await carregar(); aviso('Preferências salvas.');
  });
});

// ---------------- Início ----------------
if (db.logado) mostrarApp(); else mostrarLogin();

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { criarCliente, validarConfig } from './supa.js';
import * as c from './calc.js';
import { lerPdf } from './import/pdf.js';
import { textoDe, sha256, detectarTipo } from './import/texto.js';
import { lerFaturaBradesco, lerFaturaNubank, planoFatura } from './import/faturas.js';
import { lerContracheque, analisar, planoContracheque, rendaAntesDepois } from './import/contracheque.js';
import * as g from './import/gravar.js';

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
const VAZIO = () => ({ contas: [], receitas: [], compromissos: [], parcelas: [], lancamentos: [], config: null, limites: [], importacoes: [] });
let dados = VAZIO();

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
$('#btn-sair').addEventListener('click', async () => { await db.sair(); dados = VAZIO(); $('#revisao').replaceChildren(); mostrarLogin(); });

// ---------------- Abas ----------------
$$('.abas button').forEach((b) => b.addEventListener('click', () => {
  $$('.abas button').forEach((x) => x.classList.toggle('ativa', x === b));
  $$('.aba').forEach((s) => { s.hidden = s.id !== 'aba-' + b.dataset.aba; });
}));

// ---------------- Carregar dados ----------------
async function carregar() {
  $('#erro-config').hidden = true;
  const ok = await seguro(async () => {
    const [contas, receitas, compromissos, parcelas, lancamentos, config, limites, importacoes] = await Promise.all([
      db.listar('contas'), db.listar('receitas'), db.listar('compromissos'), db.listar('parcelas'),
      db.listar('lancamentos', 'data.desc'), db.listar('config', 'user_id.asc'), db.listar('limites', 'categoria.asc'),
      db.listar('importacoes').catch(() => null), // null = 002_evolucao.sql ainda não rodou
    ]);
    dados = { contas, receitas, compromissos, parcelas, lancamentos, config: config[0] || null, limites, importacoes: importacoes || [] };
    semMigracao = importacoes === null;
    renderTudo();
    return true;
  });
  if (!ok && db.logado) {
    $('#erro-config').textContent = 'Não foi possível carregar seus dados. Recarregue a página; se continuar, envie um print desta mensagem.';
    $('#erro-config').hidden = false;
  }
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

  $('#ind-base').textContent = `Calculados pela média de ${ind.meses.map(c.nomeMes).join(', ')}: receitas e contas recorrentes, parcelas e gasto variável previsto.`;
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
  { tabela: 'contas', titulo: 'Contas e saldos', ajuda: 'Atualize o saldo quando conferir no banco. Dólar ou bitcoin: informe só a quantidade e a cotação (em R$); a conta vira investimento e não entra no saldo inicial nem no disponível. Nunca digite seed phrase, chave privada ou PIN.',
    campos: [['nome', 'Nome', 'text'], ['tipo', 'Tipo', ['corrente', 'reserva', 'investimento']], ['moeda', 'Moeda', c.MOEDAS], ['saldo', 'Saldo (R$, se em reais)', 'money?'], ['quantidade', 'Quantidade (USD/BTC)', 'qtd'], ['cotacao', 'Cotação em R$ (USD/BTC)', 'qtd']],
    linha: (x) => [`${x.nome} · ${x.tipo}` + (x.moeda && x.moeda !== 'BRL' ? ` · ${Number(x.quantidade).toLocaleString('pt-BR', { maximumFractionDigits: 8 })} ${x.moeda} × ${c.brl(x.cotacao)}${x.cotacao_em ? ' em ' + dataBR(x.cotacao_em) : ''}` : ''), c.brl(x.saldo)],
    ajustar: normalizarConta },
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
  else if (tipo === 'money?') input = h('input', { type: 'number', name: nome, step: '0.01', min: '-9999999', max: '99999999', inputmode: 'decimal' });
  else if (tipo === 'qtd') input = h('input', { type: 'number', name: nome, step: 'any', min: '0', max: '99999999', inputmode: 'decimal' });
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
        else if (tipo === 'money?' || tipo === 'qtd') linha[nome] = el.value === '' ? null : Number(el.value);
        else linha[nome] = el.value.trim() || null;
      }
      if ('recorrente' in linha && !linha.recorrente && !linha.mes) { aviso('Informe o mês ou marque "Todo mês".', 'atencao'); return; }
      const antes = form.dataset.editando && dados[cfg.tabela].find((x) => x.id === form.dataset.editando);
      if (antes && linha.cotacao != null && Number(antes.cotacao) === linha.cotacao) linha.cotacao_em = antes.cotacao_em; // cotação não mudou: mantém a data
      if (cfg.ajustar) { const erro = cfg.ajustar(linha); if (erro) { aviso(erro, 'atencao'); return; } }
      const id = form.dataset.editando;
      // Conta que deixou de ser USD/BTC: limpa quantidade e cotação (só quando a 002 já rodou).
      if (id && cfg.tabela === 'contas' && !('moeda' in linha) && 'moeda' in (dados.contas.find((x) => x.id === id) || {}))
        Object.assign(linha, { moeda: 'BRL', quantidade: null, cotacao: null, cotacao_em: null });
      await seguro(async () => { await (id ? db.atualizar(cfg.tabela, id, linha) : db.inserir(cfg.tabela, linha)); await carregar(); aviso('Salvo.'); });
    });
    const itens = dados[cfg.tabela] || [];
    return h('div', { class: 'card' },
      h('h2', {}, cfg.titulo), h('p', { class: 'nota' }, cfg.ajuda),
      cfg.tabela === 'contas' && itens.some((x) => x.moeda && x.moeda !== 'BRL') ? h('button', { type: 'button', class: 'sec', onclick: atualizarCotacoes }, 'Atualizar cotação (dólar e bitcoin)') : null,
      h('ul', { class: 'lista' }, itens.length ? itens.map((x) => {
        const [txt, val] = cfg.linha(x);
        const acoes = [h('button', { type: 'button', class: 'mini', 'aria-label': 'Apagar', onclick: () => apagar(cfg.tabela, x.id) }, '✕')];
        if (cfg.tabela === 'contas') acoes.unshift(h('button', { type: 'button', class: 'mini', onclick: () => editarSaldo(x) }, 'saldo'),
          h('button', { type: 'button', class: 'mini', onclick: () => editarConta(form, x) }, 'editar'));
        return h('li', {}, h('span', { class: 'desc' }, txt), h('strong', {}, val), ...acoes);
      }) : h('li', { class: 'nota' }, 'Nada cadastrado.')),
      h('details', {}, h('summary', {}, 'Adicionar'), form));
  }));
}

// Valida e completa uma conta antes de gravar. Devolve a mensagem de erro, ou nada.
function normalizarConta(x) {
  if (!c.MOEDAS.includes(x.moeda)) return 'Moeda inválida.';
  if (x.moeda === 'BRL') {
    if (!(x.saldo != null && isFinite(x.saldo) && x.saldo >= -9999999 && x.saldo <= 99999999)) return 'Informe o saldo em R$.';
    delete x.moeda; delete x.quantidade; delete x.cotacao; delete x.cotacao_em; // padrão do banco (BRL); funciona mesmo sem a 002
  } else {
    if (!(x.quantidade >= 0 && x.quantidade < 1e9)) return 'Informe a quantidade.';
    if (!(x.cotacao > 0 && x.cotacao < 1e8)) return 'Informe a cotação em R$.';
    Object.assign(x, { tipo: 'investimento', saldo: c.saldoEmReais(x.quantidade, x.cotacao), cotacao_em: x.cotacao_em || c.hojeISO() });
  }
  if (!(x.saldo >= -9999999 && x.saldo <= 99999999)) return 'Saldo fora da faixa.';
  x.atualizado_em = c.hojeISO();
}

// Abre o formulário de contas preenchido com a conta; ao salvar, atualiza em vez de criar.
function editarConta(form, x) {
  form.dataset.editando = x.id;
  for (const k of ['nome', 'tipo', 'saldo', 'quantidade', 'cotacao']) form.elements[k].value = x[k] ?? '';
  form.elements.moeda.value = x.moeda || 'BRL';
  form.querySelector('button[type=submit]').textContent = `Salvar ${x.nome}`;
  const det = form.closest('details'); det.open = true; det.scrollIntoView({ block: 'nearest' });
}

const numBR = (v) => Number(String(v).trim().replace(/\./g, '').replace(',', '.'));
async function editarSaldo(conta) {
  const estrangeira = conta.moeda && conta.moeda !== 'BRL';
  const v = prompt(estrangeira ? `Cotação de 1 ${conta.moeda} em R$ (${conta.nome}):` : `Novo saldo de ${conta.nome} (R$):`, String(estrangeira ? conta.cotacao : conta.saldo).replace('.', ','));
  if (v == null) return;
  const n = numBR(v);
  const campos = estrangeira ? { cotacao: n, cotacao_em: null } : { moeda: 'BRL', saldo: n };
  const erro = normalizarConta({ ...conta, ...campos });
  if (erro || !isFinite(n)) { aviso(erro || 'Valor inválido.', 'atencao'); return; }
  const x = { ...conta, ...campos }; normalizarConta(x);
  await seguro(async () => { await db.atualizar('contas', conta.id, { saldo: x.saldo, cotacao: x.cotacao, cotacao_em: x.cotacao_em, atualizado_em: x.atualizado_em }); await carregar(); aviso('Saldo atualizado.'); });
}

// Cotação automática (opcional): uma única API pública, sem chave e sem dado do usuário na requisição.
// Se falhar, a cotação manual (botão "saldo") continua funcionando.
const URL_COTACAO = 'https://economia.awesomeapi.com.br/json/last/USD-BRL,BTC-BRL';
async function atualizarCotacoes() {
  const alvo = dados.contas.filter((x) => x.moeda && x.moeda !== 'BRL');
  if (!alvo.length) { aviso('Nenhuma conta em dólar ou bitcoin.', 'atencao'); return; }
  let cot;
  try {
    const r = await fetch(URL_COTACAO, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    cot = c.cotacoesDaApi(r.ok ? await r.json() : null);
  } catch { cot = {}; }
  if (!alvo.some((x) => cot[x.moeda])) { aviso('Não consegui buscar a cotação. Informe manualmente no botão "saldo".', 'atencao'); return; }
  await seguro(async () => {
    for (const x of alvo) if (cot[x.moeda]) {
      await db.atualizar('contas', x.id, { cotacao: cot[x.moeda], cotacao_em: c.hojeISO(), saldo: c.saldoEmReais(x.quantidade, cot[x.moeda]), atualizado_em: c.hojeISO() });
    }
    await carregar(); aviso('Cotações atualizadas.');
  });
}

function preencherConfig() {
  const f = $('#form-config');
  f.meta_poupanca.value = dados.config?.meta_poupanca ?? 0;
  f.gasto_variavel_previsto.value = dados.config?.gasto_variavel_previsto ?? 0;
  f.saldo_inicial.value = dados.config?.saldo_inicial ?? 0;
  f.mes_inicio.value = dados.config?.mes_inicio ? String(dados.config.mes_inicio).slice(0, 7) : c.mesDe(c.hojeISO());
}
$('#usar-correntes').addEventListener('click', () => {
  const correntes = dados.contas.filter((x) => x.tipo === 'corrente' && (x.moeda || 'BRL') === 'BRL');
  $('#form-config').saldo_inicial.value = c.soma2(correntes.map((x) => x.saldo));
  aviso(`Soma de ${correntes.length} conta(s)-corrente(s) em reais. Clique em Salvar para confirmar.`);
});
$('#form-config').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  await seguro(async () => {
    await db.salvarConfig({ meta_poupanca: Number(f.meta_poupanca.value) || 0, gasto_variavel_previsto: Number(f.gasto_variavel_previsto.value) || 0, saldo_inicial: Number(f.saldo_inicial.value) || 0, mes_inicio: f.mes_inicio.value + '-01', updated_at: new Date().toISOString() });
    await carregar(); aviso('Preferências salvas.');
  });
});

// ---------------- Importar PDF ----------------
// O PDF é lido aqui, no navegador. Só as linhas confirmadas vão para o Supabase.
let semMigracao = false;
const fi = $('#form-importar');
const NOMES_TIPO = { fatura_bradesco: 'Fatura Bradesco', fatura_nubank: 'Fatura Nubank', contracheque: 'Contracheque' };
const dataBR = (iso) => iso.split('-').reverse().join('/');
const LEITORES = {};

fi.arquivo.addEventListener('change', () => { $('#campo-senha').hidden = true; fi.senha.value = ''; $('#revisao').replaceChildren(); });
fi.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const arquivo = fi.arquivo.files[0];
  const btn = fi.querySelector('button');
  if (!arquivo || btn.disabled) return;
  if (g.emGravacao()) { aviso('Aguarde a gravação terminar.', 'atencao'); return; }
  const senha = fi.senha.value;
  fi.senha.value = ''; // a senha só vive nesta chamada
  btn.disabled = true;
  $('#revisao').replaceChildren(h('p', { class: 'nota' }, 'Lendo o PDF…'));
  try {
    if (semMigracao) throw new Error('Rode supabase/002_evolucao.sql no SQL Editor antes de importar.');
    let tipo = fi.tipo.value;
    // Contracheque: só a página 1. As páginas 2 e 3 (memória de cálculo, com dependentes) nem são extraídas.
    const paginas = await lerPdf(arquivo, senha, (pag1) => {
      tipo = tipo || detectarTipo(textoDe(pag1));
      return tipo === 'contracheque' ? 1 : 20;
    });
    $('#campo-senha').hidden = true;
    if (!tipo || !LEITORES[tipo]) throw new Error('Não reconheci o tipo do documento. Escolha o tipo e tente de novo.');
    const linhas = paginas.flat();
    const hash = await sha256(tipo + '\n' + textoDe(linhas));
    if (dados.importacoes.some((i) => i.hash === hash)) throw new Error('Este arquivo já foi importado.');
    LEITORES[tipo](linhas, hash);
  } catch (e) {
    if (e.message === 'SENHA' || e.message === 'SENHA_ERRADA') {
      $('#campo-senha').hidden = false; fi.senha.focus();
      $('#revisao').replaceChildren(h('p', { class: 'nota atencao' }, e.message === 'SENHA' ? 'Este PDF tem senha. Digite a senha e clique em Ler PDF.' : 'Senha incorreta.'));
    } else $('#revisao').replaceChildren(h('div', { class: 'card' }, h('p', { class: 'ruim' }, e.message || 'Erro ao ler o PDF.')));
  } finally { btn.disabled = false; }
});

function caixaErros(erros, extra) {
  return h('div', { class: 'card' }, h('h2', {}, 'Não dá para importar'),
    h('ul', { class: 'fatos ruim' }, erros.map((e) => h('li', {}, e))), extra,
    h('p', { class: 'nota' }, 'Nada foi gravado. Se o PDF estiver certo, o layout pode ter mudado e o leitor precisa de ajuste.'));
}

function concluido(msg) {
  $('#revisao').replaceChildren(h('div', { class: 'card' }, h('p', { class: 'ok' }, msg)));
  fi.reset(); aviso(msg);
}

// Grava pelo módulo gravar.js (trava + hash conferido no servidor antes de inserir). O botão "Ler PDF"
// fica desabilitado durante a gravação, para não abrir outra revisão no meio.
async function gravar(fn) {
  const lerBtn = fi.querySelector('button');
  lerBtn.disabled = true;
  try { return await seguro(async () => { await fn(); await carregar(); return true; }); }
  finally { lerBtn.disabled = false; }
}
const gravarImportacao = (registro, criar, ajustar) => gravar(() => g.gravarImportacao(db, registro, criar, ajustar));

const ACAO = { lancamento: 'Gasto no dia da compra', parcela: 'Vira parcela', na_fatura: 'Entra no compromisso da fatura (compra antes do início)', credito: 'Crédito/estorno: não é gravado', ignorar: 'Ignorada (fatura antes do início do controle)' };

LEITORES.fatura_bradesco = (linhas, hash) => revisarFatura(lerFaturaBradesco(linhas), hash);
LEITORES.fatura_nubank = (linhas, hash) => revisarFatura(lerFaturaNubank(linhas), hash);

function revisarFatura(f, hash) {
  const resumo = h('ul', { class: 'fatos' },
    h('li', {}, `${NOMES_TIPO[f.tipo]} · vencimento ${f.vencimento ? dataBR(f.vencimento) : '—'} · total ${c.brl(f.total)}`),
    f.saldoAnterior || f.pagamentos ? h('li', {}, `Saldo anterior ${c.brl(f.saldoAnterior)} e pagamentos ${c.brl(f.pagamentos)}: entram só na conferência, nunca como gasto.`) : null,
    h('li', {}, `Soma dos lançamentos ${c.brl(f.conferencia.somaItens)} · esperado ${c.brl(f.conferencia.esperado)} · diferença ${c.brl(f.conferencia.diferenca)}`));
  if (f.erros.length) { $('#revisao').replaceChildren(caixaErros(f.erros, resumo)); return; }

  const p = planoFatura(f, dados);
  const linhas = p.linhas.map((l) => {
    const cat = h('select', { 'aria-label': 'Categoria' }, c.CATEGORIAS.map((k) => h('option', { value: k, selected: k === l.categoria }, k)));
    cat.addEventListener('change', () => { l.categoria = cat.value; if (l.parcelaNova) l.parcelaNova.categoria = cat.value; });
    let acao = ACAO[l.acao] + (l.parcela ? ` (parcela ${l.parcela.k}/${l.parcela.n})` : '');
    if (l.parcelaNova) acao += ` · ${l.parcelaNova.quantidade}x a partir de ${c.nomeMes(c.mesDe(l.parcelaNova.primeiro_mes))}` + (l.parcelaExistente ? ' · parcela já cadastrada, será atualizada' : '');
    else if (l.parcelaExistente) acao += ' · era a última: remove a cadastrada';
    let escolha = null;
    if (l.duplicata) {
      escolha = h('select', { 'aria-label': 'Qual manter' }, h('option', { value: 'meu' }, 'Manter o já lançado'), h('option', { value: 'importado' }, 'Manter o importado'));
      escolha.addEventListener('change', () => { l.manter = escolha.value; });
    }
    return h('tr', { class: l.duplicata ? 'dup' : null },
      h('td', {}, dataBR(l.data).slice(0, 5)),
      h('td', {}, l.descricao, l.duplicata ? h('small', {}, `Parecido com: ${dataBR(l.duplicata.data)} ${l.duplicata.descricao || l.duplicata.categoria} ${c.brl(l.duplicata.valor)}`) : null),
      h('td', { class: 'd' }, c.brl(l.valor)),
      h('td', {}, l.cartao.replace(/^\S+ final /, '')),
      h('td', {}, l.acao === 'lancamento' || l.parcelaNova ? cat : '—'),
      h('td', {}, acao, escolha));
  });
  const criarFatura = h('input', { type: 'checkbox', checked: true });
  const blocoFatura = p.compromisso
    ? h('label', { class: 'check' }, criarFatura, `Criar compromisso "${p.compromisso.descricao}" de ${c.brl(p.compromisso.valor)} em ${c.nomeMes(c.mesDe(p.compromisso.mes))}` +
      (p.compromissoExistente ? ' (atualiza o que já existe)' : '') + '. Desmarque se esta fatura já foi paga.')
    : h('p', { class: 'nota' }, 'Nenhum compromisso de fatura será criado (todas as compras são do início do controle em diante e já contam como gasto ou parcela, ou a fatura vence antes do início).');
  const m = p.possivelManual;
  const alertaManual = m ? h('p', { class: 'alerta' }, `Atenção: já existe o compromisso pontual "${m.descricao}" de ${c.brl(m.valor)} em ${c.nomeMes(c.mesDe(m.mes))}, com valor parecido e mês igual ou depois deste vencimento. Esta fatura provavelmente já foi cadastrada à mão: apague um dos dois ou desmarque o compromisso abaixo.`) : null;
  const btn = h('button', { type: 'button' }, 'Confirmar importação');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    if (await gravarFatura(f, p, hash, criarFatura.checked)) concluido('Fatura importada.');
    else btn.disabled = false;
  });
  $('#revisao').replaceChildren(h('div', { class: 'card revisao' }, h('h2', {}, 'Revisar antes de gravar'), resumo,
    h('div', { class: 'tabela' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Data', 'Descrição', 'Valor', 'Cartão', 'Categoria', 'O que acontece'].map((t, i) => h('th', { class: i === 2 ? 'd' : null }, t)))),
      h('tbody', {}, linhas))),
    alertaManual, blocoFatura, btn));
}

function gravarFatura(f, p, hash, criarFatura) {
  const comp = p.compromisso && criarFatura ? p.compromisso : null;
  return gravarImportacao({ hash, tipo: f.tipo, competencia: f.competencia + '-01', total: f.total }, async (id) => {
    const novos = p.linhas.filter((l) => l.acao === 'lancamento' && !(l.duplicata && l.manter === 'meu'))
      .map((l) => ({ data: l.data, valor: l.valor, descricao: l.descricao, categoria: l.categoria, meio: 'credito', importacao_id: id }));
    if (novos.some((n) => !(n.valor > 0 && n.valor < 1000000) || !c.CATEGORIAS.includes(n.categoria))) throw new Error('Linha com valor ou categoria inválidos.');
    if (novos.length) await db.inserir('lancamentos', novos);
    const parcNovas = p.linhas.filter((l) => l.parcelaNova && !l.parcelaExistente).map((l) => ({ ...l.parcelaNova, importacao_id: id }));
    if (parcNovas.length) await db.inserir('parcelas', parcNovas);
    if (comp && !p.compromissoExistente) await db.inserir('compromissos', { ...comp, importacao_id: id });
  }, async () => {
    for (const l of p.linhas) {
      if (l.parcelaExistente && l.parcelaNova) await db.atualizar('parcelas', l.parcelaExistente, { primeiro_mes: l.parcelaNova.primeiro_mes, quantidade: l.parcelaNova.quantidade, valor_parcela: l.parcelaNova.valor_parcela });
      else if (l.parcelaExistente) await db.apagar('parcelas', l.parcelaExistente);
      if (l.duplicata && l.manter === 'importado') await db.apagar('lancamentos', l.duplicata.id);
    }
    if (p.compromissoExistente) await (comp ? db.atualizar('compromissos', p.compromissoExistente, { valor: comp.valor }) : db.apagar('compromissos', p.compromissoExistente));
  });
}

// ---------------- Contracheque ----------------
const CLASSE = { recorrente: 'Todo mês', pontual: 'Pontual', consignado: 'Consignado' };
LEITORES.contracheque = (linhas, hash) => revisarContracheque(lerContracheque(linhas), hash);

function revisarContracheque(cc, hash) {
  const t = cc.totais, k = cc.conferencia;
  const resumo = h('ul', { class: 'fatos' },
    h('li', {}, `Contracheque ${cc.competencia ? c.nomeMes(cc.competencia) : '—'} · ${cc.folha.toLowerCase()}` + (cc.credito ? ` · crédito em ${dataBR(cc.credito)}` : '')),
    h('li', {}, `Bruto ${c.brl(t.bruto)} − descontos ${c.brl(t.descontos)} = líquido ${c.brl(t.liquido)}`),
    h('li', {}, `Conferência: remunerações ${c.brl(k.somaRem)} (dif. ${c.brl(k.difBruto)}) · descontos ${c.brl(k.somaDes)} (dif. ${c.brl(k.difDescontos)}) · líquido (dif. ${c.brl(k.difLiquido)})`));
  if (cc.erros.length) { $('#revisao').replaceChildren(caixaErros(cc.erros, resumo)); return; }

  const a = analisar(cc);
  const itens = planoContracheque(cc, a, dados);
  const tabela = h('div', { class: 'tabela' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Rubrica', 'Remuneração', 'Desconto', 'Tipo'].map((x, i) => h('th', { class: i === 1 || i === 2 ? 'd' : null }, x)))),
    h('tbody', {}, cc.rubricas.map((r) => h('tr', {},
      h('td', {}, r.descricao),
      h('td', { class: 'd' }, r.lado === 'remuneracao' ? c.brl(r.valor) : ''),
      h('td', { class: 'd' }, r.lado === 'desconto' ? c.brl(r.valor) : ''),
      h('td', {}, CLASSE[r.classe] + (r.classe === 'consignado' ? ` ${r.prazo.n}/${r.prazo.m}` : '')))))));

  const rotulo = (i) => {
    if (i.id === 'salario') {
      const v = i.atualizar ? i.atualizar.campos.valor : i.criar.valor;
      return `Receita recorrente "Salário (líquido)": ${c.brl(v)} a partir de ${c.nomeMes(c.addMeses(cc.competencia, 1))}` +
        (i.atualizar ? ` (troca o valor de "${i.atual.descricao}")` : i.encerrar ? ` (a atual, "${i.atual.descricao}" de ${c.brl(i.valorAnterior)}, termina em ${c.nomeMes(cc.competencia)})` : '');
    }
    if (i.id.startsWith('outroSalario')) return `Encerrar outro salário cadastrado "${i.atual.descricao}" de ${c.brl(Number(i.atual.valor))} em ${c.nomeMes(cc.competencia)} (senão a renda soma em dobro)`;
    if (i.id === 'folha') return `Receita pontual "${i.criar.descricao}": ${c.brl(i.criar.valor)} em ${c.nomeMes(c.mesDe(i.criar.mes))}`;
    if (i.id.startsWith('extra')) return `Receita pontual "${i.criar.descricao}": ${c.brl(i.criar.valor)} (líquido estimado) em ${c.nomeMes(c.mesDe(i.criar.mes))}`;
    return `Receita recorrente "${i.criar.descricao}": +${c.brl(i.criar.valor)} a partir de ${c.nomeMes(c.mesDe(i.criar.inicio))} (o desconto deixa de existir)`;
  };
  const renda = h('p', { class: 'formula' });
  const mostrarRenda = () => {
    const r = rendaAntesDepois(dados.receitas, itens, c.addMeses(cc.competencia, 1));
    renda.textContent = `Renda total de ${c.nomeMes(r.mes)}: antes ${c.brl(r.antes)} → depois ${c.brl(r.depois)}`;
    renda.className = 'formula' + (r.depois > r.antes * 1.3 && r.antes > 0 ? ' alerta' : '');
  };
  mostrarRenda();
  const caixas = itens.map((i) => {
    const cb = h('input', { type: 'checkbox', checked: true });
    cb.addEventListener('change', () => { i.marcado = cb.checked; mostrarRenda(); });
    return h('label', { class: 'check' }, cb, rotulo(i));
  });

  const info = h('ul', { class: 'fatos' },
    h('li', {}, `Líquido deste mês: ${c.brl(t.liquido)}.`),
    a.normal ? h('li', {}, 'Líquido que se repete = líquido − remunerações pontuais + descontos pontuais + IR estimado das pontuais:',
      h('div', { class: 'formula' }, a.formula), h('div', { class: 'formula' }, `IR estimado = (pontuais tributáveis − previdência pontual) × alíquota = ${a.formulaIR}`)) : null,
    a.consignados.length ? h('li', {}, 'Consignados (só informação, não viram compromisso): ',
      a.consignados.map((x) => h('small', {}, `${x.descricao} ${c.brl(x.valor)} · parcela ${x.n}/${x.m} · última em ${c.nomeMes(x.ultimoMes)}`))) : null,
    a.plano.mensalidade || a.plano.coparticipacao ? h('li', {}, `Plano de saúde: mensalidade ${c.brl(a.plano.mensalidade)} + coparticipação ${c.brl(a.plano.coparticipacao)} − auxílio-saúde ${c.brl(a.plano.auxilio)} = custo líquido ${c.brl(a.plano.liquido)}.`) : null,
    cc.margem.base != null ? h('li', { class: 'nota' }, `Margem consignável (informativo): base ${c.brl(cc.margem.base)}, empréstimos ${c.brl(cc.margem.emprestimos)}, disponível ${c.brl(cc.margem.disponivel)}.`) : null);

  const btn = h('button', { type: 'button' }, 'Confirmar importação');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    if (await gravarContracheque(cc, itens, hash)) concluido('Contracheque importado.');
    else btn.disabled = false;
  });
  $('#revisao').replaceChildren(h('div', { class: 'card revisao' }, h('h2', {}, 'Revisar antes de gravar'), resumo, tabela, info,
    h('p', { class: 'nota' }, 'O que será gravado (desmarque o que não quiser):'), caixas, renda, btn));
}

const gravarContracheque = (cc, itens, hash) => gravar(() => g.gravarContracheque(db, cc, itens, hash));

// ---------------- Início ----------------
if (db.logado) mostrarApp(); else mostrarLogin();

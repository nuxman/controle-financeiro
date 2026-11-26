// Cálculos puros do Controle Financeiro. Sem acesso a rede nem ao DOM: testável com `node --test`.
// Meses são strings 'AAAA-MM'. Datas do banco são 'AAAA-MM-DD'.

export const CATEGORIAS = [
  'Mercado', 'Combustível e transporte', 'Restaurantes e lanches', 'Saúde e farmácia',
  'Casa e contas', 'Assinaturas', 'Educação', 'Pets', 'Compras', 'Lazer', 'Academia e estética',
  'Viagem', 'Família', 'Outros',
];

const PALAVRAS = [
  ['Compras', /mercado\s?livre|shein|amazon|magalu|shopee/i],
  ['Mercado', /mercad|supermerc|feira|hortifruti|padaria|açougue|acougue|assai|atacad/i],
  ['Combustível e transporte', /combust|gasolina|posto|uber|99|taxi|táxi|estaciona|park|onibus|ônibus|pedágio|pedagio/i],
  ['Restaurantes e lanches', /restaur|lanche|almoço|almoco|jantar|pizza|burger|hamb|ifood|delivery|café|cafe|bar\b|pub|churras|sorvete|açaí|acai/i],
  ['Saúde e farmácia', /farm|drog|remédio|remedio|médic|medic|consulta|dentist|exame|hospital|ótica|otica/i],
  ['Casa e contas', /luz|energia|água|agua|internet|aluguel|condom|gás|gas\b|telefone|celular|claro|vivo|tim\b|lavanderia/i],
  ['Assinaturas', /netflix|spotify|disney|globoplay|youtube|prime|hbo|max\b|apple|icloud|chatgpt|claude|xbox|assinatura/i],
  ['Educação', /escola|colégio|colegio|curso|livro|faculdade|mensalidade/i],
  ['Pets', /pet|ração|racao|veterin/i],
  ['Academia e estética', /academia|estética|estetica|salão|salao|barbear|cabelo|spa\b/i],
  ['Lazer', /cinema|show|ingresso|passeio|jogo|lazer|multiplex/i],
  ['Viagem', /hotel|passagem|viagem|aéreo|aereo|decolar|airbnb/i],
  ['Compras', /roupa|loja|shopping|presente|mercadolivre|mercado livre|shein|amazon|eletr/i],
];

export function categorizar(texto) {
  for (const [cat, re] of PALAVRAS) if (re.test(texto)) return cat;
  return 'Outros';
}

// ---------------- Datas e meses ----------------
export const mesDe = (data) => String(data).slice(0, 7);
export const hojeISO = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function addMeses(mes, n) {
  let [a, m] = mes.split('-').map(Number);
  const t = a * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
export function difMeses(de, ate) {
  const [a1, m1] = de.split('-').map(Number);
  const [a2, m2] = ate.split('-').map(Number);
  return (a2 - a1) * 12 + (m2 - m1);
}
export function diasNoMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

// ---------------- Somas por mês ----------------
const num = (v) => Number(v) || 0;
const soma = (lista, f) => lista.reduce((s, x) => s + f(x), 0);
const r2 = (v) => Math.round(v * 100) / 100;

export function ativoNoMes(item, mes) {
  if (item.recorrente) {
    if (item.inicio && mes < mesDe(item.inicio)) return false;
    if (item.fim && mes > mesDe(item.fim)) return false;
    return true;
  }
  return !!item.mes && mesDe(item.mes) === mes;
}

export const receitasMes = (receitas, mes) => r2(soma(receitas.filter((r) => ativoNoMes(r, mes)), (r) => num(r.valor)));
export const compromissosMes = (comps, mes) => r2(soma(comps.filter((c) => ativoNoMes(c, mes)), (c) => num(c.valor)));

export function parcelaNoMes(p, mes) {
  const i = difMeses(mesDe(p.primeiro_mes), mes);
  return i >= 0 && i < num(p.quantidade) ? num(p.valor_parcela) : 0;
}
export const parcelasMes = (parcelas, mes) => r2(soma(parcelas, (p) => parcelaNoMes(p, mes)));
export const gastosMes = (lancs, mes) => r2(soma(lancs.filter((l) => mesDe(l.data) === mes), (l) => num(l.valor)));

// ---------------- Projeção com saldo acumulado ----------------
// O app começa num mês (config.mes_inicio) com um saldo inicial em conta (config.saldo_inicial).
// A partir dele, cada mês soma: receitas − compromissos − parcelas − poupança − gastos.
//   * meses passados e o atual: gastos reais lançados;
//   * meses futuros: gasto variável previsto.
// O "acumulado" é o dinheiro previsto em conta ao fim de cada mês. Se um mês futuro ficar
// negativo, a sobra de hoje precisa ser guardada para cobri-lo: por isso o disponível do mês
// atual é o MENOR acumulado daqui para frente.
// extras: parcelas hipotéticas (simulação), no mesmo formato da tabela parcelas.
// Antes do mês de início, o app se comporta como se fosse o 1º dia do mês de início.
export function hojeEfetivo(d, hoje = hojeISO()) {
  const inicio = d.config?.mes_inicio ? mesDe(d.config.mes_inicio) : null;
  return inicio && inicio > mesDe(hoje) ? inicio + '-01' : hoje;
}

export function projecao(d, hoje = hojeISO(), mesesFuturos = 12, extras = []) {
  hoje = hojeEfetivo(d, hoje);
  const atual = mesDe(hoje);
  const inicio = d.config?.mes_inicio ? mesDe(d.config.mes_inicio) : atual;
  const primeiro = inicio < atual ? inicio : atual;
  const meta = num(d.config?.meta_poupanca);
  const previsto = num(d.config?.gasto_variavel_previsto);
  const todas = d.parcelas.concat(extras);
  const total = difMeses(primeiro, atual) + mesesFuturos;
  let acumulado = inicio <= atual ? num(d.config?.saldo_inicial) : 0;
  const linhas = [];
  for (let i = 0; i < total; i++) {
    const mes = addMeses(primeiro, i);
    const renda = receitasMes(d.receitas, mes);
    const fixos = compromissosMes(d.compromissos, mes);
    const parc = parcelasMes(todas, mes);
    const variavel = mes <= atual ? gastosMes(d.lancamentos, mes) : previsto;
    const livre = r2(renda - fixos - parc - meta - variavel);
    acumulado = r2(acumulado + livre);
    linhas.push({ mes, passado: mes < atual, renda, fixos, parcelas: parc, meta, variavel, livre, acumulado, parcelasRenda: renda > 0 ? parc / renda : null });
  }
  return linhas;
}

// ---------------- Resumo do mês corrente ----------------
// d = {contas, receitas, compromissos, parcelas, lancamentos, config}
export function resumoMes(d, hoje = hojeISO()) {
  hoje = hojeEfetivo(d, hoje);
  const mes = mesDe(hoje);
  const proj = projecao(d, hoje, 12);
  const daqui = proj.filter((p) => p.mes >= mes);
  const atual = daqui[0];
  const pior = daqui.reduce((m, p) => (p.acumulado < m.acumulado ? p : m), atual);
  // Dinheiro que pode ser usado neste mês sem faltar em nenhum mês seguinte.
  const disponivel = r2(Math.min(atual.acumulado, pior.acumulado));
  const reservarPara = pior.mes !== mes && pior.acumulado < atual.acumulado ? pior.mes : null;
  const dia = Number(hoje.slice(8, 10));
  const diasRestantes = diasNoMes(mes) - dia + 1;
  const gastosHoje = r2(soma(d.lancamentos.filter((l) => l.data === hoje), (l) => num(l.valor)));
  // Limite de hoje: o disponível no começo do dia, dividido pelos dias que faltam.
  const limiteDia = r2(Math.max(0, disponivel + gastosHoje) / diasRestantes);
  return {
    mes, renda: atual.renda, fixos: atual.fixos, parcelas: atual.parcelas, meta: atual.meta, gastos: atual.variavel,
    saldoFimMes: atual.acumulado, disponivel, reservarPara, piorMes: pior.mes, piorAcumulado: pior.acumulado,
    diasRestantes, limiteDia, gastosHoje, restanteHoje: r2(limiteDia - gastosHoje),
  };
}

// ---------------- Simulador "e se eu comprar?" ----------------
export function simular(d, compra, hoje = hojeISO()) {
  hoje = hojeEfetivo(d, hoje);
  const valor = num(compra.valor);
  const n = Math.max(1, Math.min(48, Math.trunc(num(compra.parcelas) || 1)));
  const atual = mesDe(hoje);
  const primeiroMes = compra.primeiroMes && compra.primeiroMes >= atual ? compra.primeiroMes : atual;
  const valorParcela = r2(valor / n);
  const futuros = Math.max(12, difMeses(atual, primeiroMes) + n + 1);
  const base = projecao(d, hoje, futuros).filter((p) => p.mes >= atual);
  const com = projecao(d, hoje, futuros, [{ valor_parcela: valorParcela, primeiro_mes: primeiroMes + '-01', quantidade: n }]).filter((p) => p.mes >= atual);
  const linhas = base.map((b, i) => ({ mes: b.mes, acumAntes: b.acumulado, acumDepois: com[i].acumulado, parcelaCompra: com[i].parcelas - b.parcelas, parcelasRendaDepois: com[i].parcelasRenda }));
  const viramNegativos = linhas.filter((l) => l.acumAntes >= 0 && l.acumDepois < 0);
  const jaNegativos = linhas.filter((l) => l.acumAntes < 0);
  const piorParcRenda = Math.max(0, ...com.map((c) => c.parcelasRenda ?? 0));
  const minAntes = Math.min(...linhas.map((l) => l.acumAntes));
  const minDepois = Math.min(...linhas.map((l) => l.acumDepois));
  // Alternativa: juntar à vista com a sobra média prevista dos próximos 6 meses (sem a compra).
  const prox = base.slice(1, 7).map((b) => b.livre);
  const sobraMedia = prox.length ? soma(prox, (x) => x) / prox.length : 0;
  const mesesParaJuntar = sobraMedia > 0 ? Math.ceil(valor / sobraMedia) : null;
  return { valor, n, valorParcela, primeiroMes, linhas, viramNegativos, jaNegativos, piorParcRenda, minAntes: r2(minAntes), minDepois: r2(minDepois), sobraMedia: r2(sobraMedia), mesesParaJuntar };
}

// ---------------- Indicadores de saúde financeira ----------------
// Referências de mercado, não regras. 'ok' | 'atencao' | 'ruim' | 'sem_dados'
export function indicadores(d, hoje = hojeISO()) {
  hoje = hojeEfetivo(d, hoje);
  const mes = mesDe(hoje);
  // Indicadores estruturais: só receitas e contas recorrentes (13º, bônus e faturas antigas distorceriam).
  const renda = receitasMes(d.receitas.filter((r) => r.recorrente), mes);
  const fixos = compromissosMes(d.compromissos.filter((x) => x.recorrente), mes);
  const parc = parcelasMes(d.parcelas, mes);
  const previsto = num(d.config?.gasto_variavel_previsto);
  const variavel = Math.max(gastosMes(d.lancamentos, mes), previsto);
  const reservas = soma(d.contas.filter((c) => c.tipo !== 'corrente'), (c) => num(c.saldo));
  const custoMensal = fixos + parc + previsto;
  const faixa = (v, ok, atencao, maiorMelhor) => {
    if (v == null || !isFinite(v)) return 'sem_dados';
    if (maiorMelhor) return v >= ok ? 'ok' : v >= atencao ? 'atencao' : 'ruim';
    return v <= ok ? 'ok' : v <= atencao ? 'atencao' : 'ruim';
  };
  const comprometimento = renda > 0 ? (fixos + parc) / renda : null;
  const parcelasRenda = renda > 0 ? parc / renda : null;
  const taxaPoupanca = renda > 0 ? (renda - fixos - parc - variavel) / renda : null;
  const reservaMeses = custoMensal > 0 ? reservas / custoMensal : null;
  const lista = [
    { id: 'comprometimento', nome: 'Contas fixas + parcelas ÷ renda', valor: comprometimento, tipo: 'pct', ref: 'até 50%', status: faixa(comprometimento, 0.5, 0.7, false) },
    { id: 'parcelas', nome: 'Parcelas ÷ renda', valor: parcelasRenda, tipo: 'pct', ref: 'até 20%', status: faixa(parcelasRenda, 0.2, 0.3, false) },
    { id: 'poupanca', nome: 'Taxa de poupança prevista', valor: taxaPoupanca, tipo: 'pct', ref: '10% ou mais', status: faixa(taxaPoupanca, 0.1, 0, true) },
    { id: 'reserva', nome: 'Reserva de emergência', valor: reservaMeses, tipo: 'meses', ref: '3 a 6 meses', status: faixa(reservaMeses, 6, 3, true) },
  ];
  const ordem = { ruim: 3, atencao: 2, ok: 1, sem_dados: 0 };
  const geral = lista.reduce((pior, i) => (ordem[i.status] > ordem[pior] ? i.status : pior), 'sem_dados');
  return { geral, lista };
}

// ---------------- Lançamento rápido: "45,90 mercado pix" / "300 tênis crédito 3x" ----------------
export function parseRapido(texto) {
  const t = String(texto || '').trim().slice(0, 120);
  const m = t.match(/^(?:r\$\s*)?(\d{1,6}(?:[.,]\d{1,2})?)\s+(.+)$/i);
  if (!m) return { erro: 'Escreva o valor e depois a descrição. Ex.: 45 mercado' };
  const valor = Number(m[1].replace(',', '.'));
  if (!(valor > 0 && valor < 1000000)) return { erro: 'Valor inválido.' };
  let resto = m[2];
  let meio = 'debito';
  const meios = [['credito', /\b(cr[eé]dito|cart[aã]o)\b/i], ['pix', /\bpix\b/i], ['dinheiro', /\b(dinheiro|esp[eé]cie)\b/i], ['debito', /\bd[eé]bito\b/i]];
  for (const [nome, re] of meios) if (re.test(resto)) { meio = nome; resto = resto.replace(re, ''); break; }
  let parcelas = 1;
  const p = resto.match(/\b(?:em\s+)?(\d{1,2})\s*x\b/i);
  if (p) { parcelas = Math.min(48, Math.max(1, Number(p[1]))); resto = resto.replace(p[0], ''); }
  if (parcelas > 1) meio = 'credito';
  const descricao = resto.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!descricao) return { erro: 'Falta a descrição. Ex.: 45 mercado' };
  return { valor, descricao, categoria: categorizar(descricao), meio, parcelas };
}

export const brl = (v) => (v == null || !isFinite(v)) ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const pct = (v) => (v == null || !isFinite(v)) ? '—' : (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + '%';
export function nomeMes(mes) {
  const n = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const [a, m] = mes.split('-');
  return `${n[Number(m) - 1]}/${a.slice(2)}`;
}

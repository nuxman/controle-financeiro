// Contracheque analítico do TJRO (eGesp), página 1. Função pura: linhas → objeto.
// Lê SÓ: referência, tipo de folha, data de crédito, a tabela de rubricas, os totais e a margem.
// Cabeçalho pessoal (nome, CPF, matrícula, PIS, banco, agência, conta) e tudo depois de
// "Dependentes I.R." (memória de cálculo, com dependentes do plano de saúde) são descartados.
import { normal, valorBR, r2, soma, dataValida, mesPorExtenso, RE_VALOR } from './texto.js';
import { addMeses, receitasMes } from '../calc.js';

export const TOLERANCIA = 0.05;

// Classificação das rubricas (sobre a descrição sem acento, em maiúsculas). Ajuste aqui se o layout mudar.
export const REGRAS = {
  // Pontuais: não se repetem todo mês.
  pontualInicio: ['DIF.', 'DEV.', 'ATUALIZACAO MONETARIA', 'RESTITUICAO', 'EXERCICIO ANTERIOR'],
  pontualContem: [/\b13\b/, /NATALINA/, /FERIAS/, /1\/3/, /ABONO/],
  // Dentre as pontuais, as de valor relevante que viram receita pontual (13º, férias, bônus).
  extra: [/\b13\b/, /NATALINA/, /FERIAS/, /1\/3/, /ABONO/, /BONUS|GRATIFICACAO NATALINA|PREMIO/],
  consignado: /EMPRESTIMO|CONSIGNA/,
  irrf: /^IRRF\b|IMPOSTO DE RENDA/,
  previdencia: /IPERON|PREVIDENC|INSS|RPPS|FUNPRESP/,
  isentaIR: /ISENT|INDENIZ|AUXILIO|NAO INCIDE IR/,
  plano: { mensalidade: /UNIMED MENSALIDADE|PLANO DE SAUDE/, coparticipacao: /COPARTICIPA/, auxilio: /AUXILIO SAUDE/ },
};

export function classificar(desc, prazo, regras = REGRAS) {
  const d = normal(desc);
  if (regras.consignado.test(d) && prazo) return 'consignado';
  if (regras.pontualInicio.some((p) => d.startsWith(p)) || regras.pontualContem.some((re) => re.test(d))) return 'pontual';
  return 'recorrente';
}

const RE_SO_VALOR = new RegExp('^' + RE_VALOR.source + '$');
const centro = (t) => t.x + t.w / 2;
const perto = (tokens, x) => tokens.reduce((m, t) => (Math.abs(t.x - x) < Math.abs(m.x - x) ? t : m), tokens[0]);

// Valor que fica na linha de baixo, alinhado ao rótulo (ex.: "Total Bruto:" / "R$ 17.395,00").
function abaixo(linhas, rotulo) {
  for (let i = 0; i < linhas.length - 1; i++) {
    const t = linhas[i].tokens.find((k) => rotulo.test(normal(k.s)));
    if (!t) continue;
    const v = perto(linhas[i + 1].tokens, t.x);
    return v && Math.abs(v.x - t.x) < Math.max(t.w, 20) ? v.s : null;
  }
  return null;
}

export function lerContracheque(linhas, regras = REGRAS) {
  const erros = [];
  // Para depois da linha de valores de "Dependentes I.R." e descarta o resto.
  const iDep = linhas.findIndex((l) => /DEPENDENTES I\.?R/.test(normal(l.texto)));
  if (iDep < 0) erros.push('Não encontrei o fim da página 1 ("Dependentes I.R.").');
  else linhas = linhas.slice(0, iDep + 2);

  const t = linhas.map((l) => normal(l.texto));
  const ref = t.map((x) => x.match(/REFERENCIA\s+([A-Z]+)\s*\/\s*(\d{4})/)).find(Boolean);
  const mes = ref ? mesPorExtenso(ref[1]) : 0;
  const competencia = mes ? `${ref[2]}-${String(mes).padStart(2, '0')}` : null;
  if (!competencia) erros.push('Não encontrei a referência (mês/ano).');
  const folha = (t.find((x) => /^FOLHA\b/.test(x)) || 'FOLHA NORMAL').slice(0, 40);

  const dc = abaixo(linhas, /^DATA CREDITO/);
  const m = dc && dc.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const credito = m && dataValida(`${m[3]}-${m[2]}-${m[1]}`) ? `${m[3]}-${m[2]}-${m[1]}` : null;

  // Tabela: do cabeçalho "Descrição … Remunerações (R$) … Descontos (R$)" até os totais.
  const iCab = linhas.findIndex((l) => /^DESCRICAO/.test(normal(l.tokens[0]?.s || '')) && /REMUNERACOES/.test(normal(l.texto)));
  const iTot = linhas.findIndex((l, i) => i > iCab && /TOTAL BRUTO/.test(normal(l.texto)));
  const rubricas = [];
  if (iCab < 0 || iTot < 0) erros.push('Não encontrei a tabela de rubricas.');
  else {
    const cab = linhas[iCab].tokens;
    const xRem = centro(cab.find((k) => /REMUNERACOES/.test(normal(k.s))));
    const xDes = centro(cab.find((k) => /DESCONTOS/.test(normal(k.s))) || { x: Infinity, w: 0 });
    for (const l of linhas.slice(iCab + 1, iTot)) {
      const ult = l.tokens[l.tokens.length - 1];
      if (l.tokens.length < 2 || !RE_SO_VALOR.test(ult.s)) continue;
      const meio = l.tokens.slice(1, -1).map((k) => k.s).join(' ');
      const pz = meio.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
      const pc = meio.replace(pz ? pz[0] : '', '').match(/(\d{1,3}(?:[.,]\d{1,2})?)/);
      const descricao = l.tokens[0].s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
      const prazo = pz ? { n: Number(pz[1]), m: Number(pz[2]) } : null;
      // Remuneração ou desconto depende da COLUNA (posição x do valor), não do texto.
      const lado = Math.abs(centro(ult) - xRem) <= Math.abs(centro(ult) - xDes) ? 'remuneracao' : 'desconto';
      rubricas.push({ descricao, prazo, pct: pc ? Number(pc[1].replace(',', '.')) : null, valor: valorBR(ult.s), lado, classe: classificar(descricao, prazo, regras) });
    }
  }

  const tot = (re) => { const s = abaixo(linhas, re); return s ? valorBR(s) : null; };
  const totais = { bruto: tot(/^TOTAL BRUTO/), descontos: tot(/^TOTAL DE DESCONTOS/), liquido: tot(/^VALOR LIQUIDO/) };
  const margem = { base: tot(/^BASE PARA MARGEM/), disponivel: tot(/^MARGEM DISPONIVEL/), emprestimos: tot(/^EMPRESTIMOS/) };

  // Conferência
  const rem = rubricas.filter((r) => r.lado === 'remuneracao');
  const des = rubricas.filter((r) => r.lado === 'desconto');
  const conf = {
    somaRem: soma(rem, (r) => r.valor), somaDes: soma(des, (r) => r.valor),
  };
  conf.difBruto = r2(totais.bruto - conf.somaRem);
  conf.difDescontos = r2(totais.descontos - conf.somaDes);
  conf.difLiquido = r2(totais.bruto - totais.descontos - totais.liquido);
  conf.ok = [totais.bruto, totais.descontos, totais.liquido].every((v) => v != null) && [conf.difBruto, conf.difDescontos, conf.difLiquido].every((d) => Math.abs(d) <= TOLERANCIA);
  if (!rubricas.length) erros.push('Nenhuma rubrica encontrada.');
  if (Object.values(totais).some((v) => v == null)) erros.push('Não encontrei Total Bruto, Total de Descontos ou Valor Líquido.');
  else if (!conf.ok) erros.push(`Os valores não batem: bruto ${conf.difBruto.toFixed(2)}, descontos ${conf.difDescontos.toFixed(2)}, líquido ${conf.difLiquido.toFixed(2)}.`);
  for (const r of rubricas) if (!(r.valor > 0 && r.valor < 1000000)) erros.push(`Valor fora da faixa: ${r.descricao}`);
  if (totais.bruto != null && !(totais.bruto > 0 && totais.bruto < 10000000)) erros.push('Total bruto fora da faixa.');

  return { tipo: 'contracheque', competencia, folha, credito, rubricas, totais, margem, conferencia: conf, erros };
}

// ---------------- Análise: o que se repete, IR estimado, consignados, plano de saúde ----------------
export function analisar(cc, regras = REGRAS) {
  const pont = cc.rubricas.filter((r) => r.classe === 'pontual');
  const remPont = pont.filter((r) => r.lado === 'remuneracao');
  const desPont = pont.filter((r) => r.lado === 'desconto');
  const remPontTrib = remPont.filter((r) => !regras.isentaIR.test(normal(r.descricao)));
  const prevPont = desPont.filter((r) => regras.previdencia.test(normal(r.descricao)));
  const irrf = cc.rubricas.find((r) => r.lado === 'desconto' && regras.irrf.test(normal(r.descricao)));
  const aliquota = irrf?.pct > 0 && irrf.pct <= 27.5 ? irrf.pct / 100 : 0.275; // sem % na linha: usa a maior faixa
  const baseIR = r2(soma(remPontTrib, (r) => r.valor) - soma(prevPont, (r) => r.valor));
  const irEstimado = r2(Math.max(0, baseIR) * aliquota);
  const somaRemPont = soma(remPont, (r) => r.valor);
  const somaDesPont = soma(desPont, (r) => r.valor);
  const liquidoRecorrente = r2(cc.totais.liquido - somaRemPont + somaDesPont + irEstimado);

  const consignados = cc.rubricas.filter((r) => r.classe === 'consignado' && r.lado === 'desconto').map((r) => {
    const faltam = Math.max(0, r.prazo.m - r.prazo.n);
    return { descricao: r.descricao, valor: r.valor, n: r.prazo.n, m: r.prazo.m, faltam, ultimoMes: addMeses(cc.competencia, faltam) };
  });

  const mesCredito = cc.credito ? cc.credito.slice(0, 7) : cc.competencia;
  const trib = (r) => !regras.isentaIR.test(normal(r.descricao));
  const extras = remPont.filter((r) => regras.extra.some((re) => re.test(normal(r.descricao))))
    .map((r) => ({ descricao: r.descricao, valor: r.valor, liquidoEstimado: r2(trib(r) ? r.valor * (1 - aliquota) : r.valor), mes: mesCredito }));

  const P = regras.plano;
  const somaPor = (re, lado) => soma(cc.rubricas.filter((r) => r.lado === lado && re.test(normal(r.descricao))), (r) => r.valor);
  const plano = { mensalidade: somaPor(P.mensalidade, 'desconto'), coparticipacao: somaPor(P.coparticipacao, 'desconto'), auxilio: somaPor(P.auxilio, 'remuneracao') };
  plano.liquido = r2(plano.mensalidade + plano.coparticipacao - plano.auxilio);

  return {
    normal: /^FOLHA NORMAL/.test(cc.folha), mesCredito,
    somaRemPont, somaDesPont, baseIR, aliquota, irEstimado, liquidoRecorrente,
    formula: `${cc.totais.liquido.toFixed(2)} − ${somaRemPont.toFixed(2)} + ${somaDesPont.toFixed(2)} + ${irEstimado.toFixed(2)} = ${liquidoRecorrente.toFixed(2)}`,
    formulaIR: `(${soma(remPontTrib, (r) => r.valor).toFixed(2)} − ${soma(prevPont, (r) => r.valor).toFixed(2)}) × ${(aliquota * 100).toLocaleString('pt-BR')}% = ${irEstimado.toFixed(2)}`,
    consignados, extras, plano,
  };
}

// ---------------- Plano de gravação (cada item é confirmado na tela) ----------------
export const DESC_SALARIO = 'Salário (líquido)';
const brl2 = (v) => v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
export const descFimConsignado = (c) => `Fim de consignado R$ ${brl2(c.valor)} (${c.ultimoMes.slice(5)}/${c.ultimoMes.slice(0, 4)})`;

// Salário = receita recorrente cuja descrição começa com "salário" (sem diferenciar maiúsculas/acentos),
// ainda ativa em `mes` ou depois.
export const salariosAtivos = (receitas, mes) => (receitas || []).filter((r) => r.recorrente && /^SALARIO/.test(normal(r.descricao).trim()) && !(r.fim && r.fim.slice(0, 7) < mes));

export function planoContracheque(cc, a, d) {
  const prox = addMeses(cc.competencia, 1);
  const receitas = d.receitas || [];
  // Pontual já cadastrada (mesma descrição e mês): não cria de novo, mesmo que o PDF tenha outro hash.
  const jaTem = (n) => receitas.some((r) => !r.recorrente && r.descricao === n.descricao && r.mes && r.mes.slice(0, 7) === n.mes.slice(0, 7));
  const itens = [];
  if (a.normal) {
    const [atual, ...outros] = salariosAtivos(receitas, prox);
    const novo = { descricao: DESC_SALARIO, valor: a.liquidoRecorrente, recorrente: true, inicio: prox + '-01', fim: null };
    // Se a receita atual já começa em `prox` ou depois, só troca o valor; senão, encerra a atual e cria uma nova.
    if (atual && atual.inicio && atual.inicio.slice(0, 7) >= prox) itens.push({ id: 'salario', marcado: true, atual, atualizar: { id: atual.id, campos: { valor: novo.valor } } });
    else itens.push({ id: 'salario', marcado: true, atual, encerrar: atual ? { id: atual.id, campos: { fim: cc.competencia + '-01' } } : null, criar: novo, valorAnterior: atual ? Number(atual.valor) : null });
    // Mais de um salário ativo: propõe encerrar os outros (senão a renda soma em dobro).
    for (const [i, o] of outros.entries()) itens.push({ id: 'outroSalario' + i, marcado: true, atual: o, encerrar: { id: o.id, campos: { fim: cc.competencia + '-01' } } });
  } else {
    const n = { descricao: `${cc.folha.slice(0, 40)} ${cc.competencia.slice(5)}/${cc.competencia.slice(0, 4)}`.slice(0, 80), valor: cc.totais.liquido, recorrente: false, mes: a.mesCredito + '-01' };
    if (!jaTem(n)) itens.push({ id: 'folha', marcado: true, criar: n });
  }
  if (a.normal) for (const [i, e] of a.extras.entries()) {
    const n = { descricao: e.descricao.slice(0, 80), valor: e.liquidoEstimado, recorrente: false, mes: e.mes + '-01' };
    if (e.liquidoEstimado > 0 && !jaTem(n)) itens.push({ id: 'extra' + i, marcado: true, criar: n });
  }
  for (const [i, c] of a.consignados.entries()) {
    const descricao = descFimConsignado(c);
    const ja = receitas.some((r) => r.descricao === descricao);
    if (!ja && c.faltam >= 0) itens.push({ id: 'consig' + i, marcado: true, criar: { descricao, valor: c.valor, recorrente: true, inicio: addMeses(c.ultimoMes, 1) + '-01', fim: null } });
  }
  return itens;
}

// Renda total de `mes` antes e depois de gravar os itens marcados (para enxergar soma em dobro).
export function rendaAntesDepois(receitas, itens, mes) {
  const marcados = itens.filter((i) => i.marcado);
  const muda = new Map();
  for (const i of marcados) for (const x of [i.encerrar, i.atualizar]) if (x) muda.set(x.id, { ...muda.get(x.id), ...x.campos });
  const depois = receitas.map((r) => (muda.has(r.id) ? { ...r, ...muda.get(r.id) } : r)).concat(marcados.filter((i) => i.criar).map((i) => i.criar));
  return { mes, antes: receitasMes(receitas, mes), depois: receitasMes(depois, mes) };
}

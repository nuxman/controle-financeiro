// Utilidades puras para transformar o texto de um PDF em linhas com posição.
// Uma "linha" é { texto, tokens: [{ x, w, s }] }. No PDF, x/w vêm do pdf.js (pontos);
// nos testes com fixture .txt, x/w são a posição/largura em caracteres. Os parsers só comparam
// posições dentro da mesma fonte, então a unidade não importa.

// Texto monoespaçado (fixtures): blocos separados por 2+ espaços viram tokens.
export function linhasDeTexto(txt) {
  return String(txt).split(/\r?\n/).map((l) => {
    const tokens = [];
    for (const m of l.matchAll(/\S+(?: \S+)*/g)) tokens.push({ x: m.index, w: m[0].length, s: m[0] });
    return { tokens, texto: tokens.map((t) => t.s).join('  ') };
  }).filter((l) => l.tokens.length);
}

// Itens do pdf.js (page.getTextContent().items) → linhas, de cima para baixo.
// Itens na mesma altura (y) formam uma linha; itens próximos em x viram um só token.
export function linhasDeItens(itens) {
  const pecas = itens
    .filter((i) => i.str && i.str.trim())
    .map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.height || i.transform[3]) || 10, s: i.str.replace(/\s+/g, ' ').trim() }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const linhas = [];
  for (const p of pecas) {
    const l = linhas[linhas.length - 1];
    if (l && Math.abs(l.y - p.y) <= p.h * 0.5) l.pecas.push(p);
    else linhas.push({ y: p.y, pecas: [p] });
  }
  return linhas.map(({ pecas }) => {
    pecas.sort((a, b) => a.x - b.x);
    const tokens = [];
    for (const p of pecas) {
      const t = tokens[tokens.length - 1];
      const vao = t ? p.x - (t.x + t.w) : Infinity;
      // Vão de ~1 espaço junta palavras; 2+ espaços separam colunas (mesmo critério do modo texto).
      if (vao < p.h * 0.9) { t.s += (vao > p.h * 0.1 ? ' ' : '') + p.s; t.w = p.x + p.w - t.x; }
      else tokens.push({ x: p.x, w: p.w, s: p.s });
    }
    return { tokens, texto: tokens.map((t) => t.s).join('  ') };
  });
}

export const textoDe = (linhas) => linhas.map((l) => l.texto).join('\n');

// Sem acento e em maiúsculas, para comparar rótulos.
export const normal = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// Valor em formato brasileiro: "1.234,56", "-1.234,56", "1.234,56-", "−R$ 10,00".
export const RE_VALOR = /([-−–])?\s?(?:R\$\s?)?(\d{1,3}(?:\.\d{3})*,\d{2})(-)?(?!\d)/;
export function valorBR(s) {
  const m = String(s).match(RE_VALOR);
  if (!m) return null;
  const v = Number(m[2].replace(/\./g, '').replace(',', '.'));
  return m[1] || m[3] ? -v : v;
}

export const r2 = (v) => Math.round(v * 100) / 100;
export const soma = (lista, f = (x) => x) => r2(lista.reduce((s, x) => s + f(x), 0));

// Data ISO válida (AAAA-MM-DD) dentro de uma faixa razoável.
export function dataValida(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return false;
  const [a, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  return a >= 2000 && a <= 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// SHA-256 em hexadecimal (Web Crypto: existe no navegador e no Node 20+).
export async function sha256(txt) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const MESES = { JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6, JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12 };
const MESES_LONGOS = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
export const mesPorExtenso = (nome) => MESES_LONGOS.indexOf(normal(nome)) + 1;

// Dia + mês abreviado de um lançamento de fatura → data ISO. O ano sai do vencimento:
// mês do lançamento depois do mês do vencimento = ano anterior (compra de dezembro na fatura de janeiro).
export function dataDoLancamento(dia, mesAbrev, vencimentoISO) {
  const m = MESES[normal(mesAbrev).slice(0, 3)];
  if (!m) return null;
  const [av, mv] = vencimentoISO.split('-').map(Number);
  const iso = `${m > mv ? av - 1 : av}-${String(m).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  return dataValida(iso) ? iso : null;
}

// Procura o rótulo e devolve o primeiro valor que casa com `re` na mesma linha (depois do rótulo) ou na seguinte.
export function depoisDoRotulo(linhas, rotulo, re) {
  for (let i = 0; i < linhas.length; i++) {
    const t = normal(linhas[i].texto);
    const k = t.search(rotulo);
    if (k < 0) continue;
    const resto = linhas[i].texto.slice(k);
    const m = resto.match(re) || (linhas[i + 1] && linhas[i + 1].texto.match(re));
    if (m) return m;
  }
  return null;
}

export function detectarTipo(texto) {
  const t = normal(texto);
  if (/DEMONSTRATIVO DE PAGAMENTO/.test(t) && /REMUNERACOES/.test(t)) return 'contracheque';
  if (/GASTOS REFERENTES AO CARTAO/.test(t)) return 'fatura_bradesco';
  if (/NUBANK|NU PAGAMENTOS/.test(t)) return 'fatura_nubank';
  return null;
}

// Parsers de fatura de cartão (texto → objeto) e o plano do que cada linha vira no app.
// Funções puras: nada de rede nem DOM.
import { normal, valorBR, RE_VALOR, r2, soma, dataValida, dataDoLancamento, depoisDoRotulo, MESES } from './texto.js';
import { categorizar, addMeses, mesDe } from '../calc.js';

export const TOLERANCIA = 0.05;

// "28 OUT  DESCRIÇÃO  [CIDADE]  [US$]  123,45" (blocos separados por 2+ espaços)
const RE_ITEM = /^(\d{1,2})(?:\s+|\/)([A-Za-zÇç]{3}|\d{2})\b\s+(.+)$/;
const RE_DATA_NUM = /(\d{2})\/(\d{2})\/(\d{4})/;
const RE_DATA_EXT = /(\d{1,2}) ([A-Za-z]{3}) (\d{4})/;
const RE_VALOR_SO = new RegExp('^' + RE_VALOR.source + '$');
const limpa = (s, n = 80) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function lerVencimento(linhas, rotulo) {
  const m = depoisDoRotulo(linhas, rotulo, RE_DATA_NUM);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const e = depoisDoRotulo(linhas, rotulo, RE_DATA_EXT);
  const mes = e && MESES[normal(e[2])];
  return mes ? `${e[3]}-${String(mes).padStart(2, '0')}-${e[1].padStart(2, '0')}` : null;
}
const lerValor = (linhas, rotulo) => {
  const m = depoisDoRotulo(linhas, rotulo, RE_VALOR);
  return m ? valorBR(m[0]) : null;
};

function lerItem(texto, vencimento) {
  const m = texto.match(RE_ITEM);
  if (!m) return null;
  const partes = m[3].split(/\s{2,}/);
  const ultimo = partes[partes.length - 1];
  if (partes.length < 2 || !RE_VALOR_SO.test(ultimo)) return null;
  const data = /^\d{2}$/.test(m[2])
    ? dataDoLancamento(m[1], Object.keys(MESES)[Number(m[2]) - 1] || '', vencimento)
    : dataDoLancamento(m[1], m[2], vencimento);
  if (!data) return null;
  return { data, partes: partes.slice(0, -1), valor: valorBR(ultimo) };
}

// Separa "(03/10)" (Bradesco) ou "Parcela 3/10" (Nubank) da descrição. A parcela pode vir
// colada na descrição ou numa coluna própria; as outras colunas (cidade, valor em US$) são descartadas.
const RE_PARCELA = /\s*(?:\((\d{1,2})\/(\d{1,2})\)|-?\s*\bPARCELA (\d{1,2})\/(\d{1,2}))/i;
function separarParcela(partes) {
  const desc = partes[0] || '';
  const m = partes.map((p) => p.match(RE_PARCELA)).find(Boolean);
  const k = m ? Number(m[1] || m[3]) : 0, n = m ? Number(m[2] || m[4]) : 0;
  return { descricao: limpa(desc.replace(RE_PARCELA, '')) || 'Sem descrição', parcela: k >= 1 && n >= k && n <= 99 ? { k, n } : null };
}

function conferir(f) {
  // O total da fatura = saldo anterior + pagamentos (negativos) + lançamentos do período.
  // O saldo anterior e os pagamentos entram SÓ nesta conta, nunca como gasto.
  const somaItens = soma(f.itens, (i) => i.valor);
  const esperado = r2(f.total - f.saldoAnterior - f.pagamentos);
  const diferenca = r2(esperado - somaItens);
  return { somaItens, esperado, diferenca, ok: f.total != null && Math.abs(diferenca) <= TOLERANCIA };
}

function finalizar(f) {
  const erros = [];
  if (!dataValida(f.vencimento)) erros.push('Não encontrei o vencimento.');
  if (f.total == null) erros.push('Não encontrei o total da fatura.');
  if (!f.itens.length) erros.push('Nenhum lançamento encontrado.');
  for (const i of f.itens) if (!(Math.abs(i.valor) > 0 && Math.abs(i.valor) < 1000000)) erros.push(`Valor fora da faixa: ${i.descricao}`);
  f.conferencia = conferir(f);
  if (!f.conferencia.ok && f.total != null) erros.push(`A soma dos lançamentos não bate com o total: diferença de R$ ${f.conferencia.diferenca.toFixed(2).replace('.', ',')}.`);
  f.erros = erros;
  f.competencia = f.vencimento ? mesDe(f.vencimento) : null;
  return f;
}

export function lerFaturaBradesco(linhas) {
  const vencimento = lerVencimento(linhas, /VENCIMENTO/);
  const f = { tipo: 'fatura_bradesco', vencimento, total: lerValor(linhas, /TOTAL DA FATURA(?! ANTERIOR)/), saldoAnterior: 0, pagamentos: 0, itens: [] };
  if (!vencimento) return finalizar(f);
  let cartao = 'Bradesco';
  for (const l of linhas) {
    const t = normal(l.texto);
    const bloco = t.match(/GASTOS REFERENTES AO CARTAO:?\s*FINAL\s*(\d{4})/);
    if (bloco) { cartao = 'Bradesco final ' + bloco[1]; continue; } // o nome do titular é descartado
    if (/SALDO ANTERIOR/.test(t)) { f.saldoAnterior = r2(f.saldoAnterior + (valorBR(l.tokens[l.tokens.length - 1].s) || 0)); continue; }
    if (/PAGTO\.? POR DEB EM C\/C/.test(t)) { f.pagamentos = r2(f.pagamentos - Math.abs(valorBR(l.tokens[l.tokens.length - 1].s) || 0)); continue; }
    const it = lerItem(l.texto, vencimento);
    if (it) f.itens.push({ data: it.data, valor: it.valor, cartao, ...separarParcela(it.partes) });
  }
  return finalizar(f);
}

export function lerFaturaNubank(linhas) {
  const vencimento = lerVencimento(linhas, /VENCIMENTO/);
  const f = { tipo: 'fatura_nubank', vencimento, total: lerValor(linhas, /TOTAL A PAGAR/), saldoAnterior: lerValor(linhas, /FATURA ANTERIOR|SALDO RESTANTE/) || 0, pagamentos: 0, itens: [] };
  if (!vencimento) return finalizar(f);
  let cartao = 'Nubank';
  for (const l of linhas) {
    const t = normal(l.texto);
    const bloco = t.match(/^(?:CARTAO )?FINAL\s*(\d{4})|^[•*·]{2,}\s*(\d{4})$/);
    if (bloco) { cartao = 'Nubank final ' + (bloco[1] || bloco[2]); continue; }
    const it = lerItem(l.texto, vencimento);
    if (!it) continue;
    // Layout novo: "•••• 1234" antes da descrição.
    const fim = it.partes[0].match(/^[•*·]{2,}\s*(\d{4})$/);
    const c = fim ? 'Nubank final ' + fim[1] : cartao;
    const partes = fim ? it.partes.slice(1) : it.partes;
    const desc = partes[0] || '';
    if (/^PAGAMENTO/.test(normal(desc))) { f.pagamentos = r2(f.pagamentos - Math.abs(it.valor)); continue; }
    f.itens.push({ data: it.data, valor: it.valor, cartao: c, ...separarParcela(partes) });
  }
  // Pagamento que só aparece no resumo (sem linha com data).
  if (!f.pagamentos) f.pagamentos = -Math.abs(lerValor(linhas, /PAGAMENTO RECEBIDO/) || 0);
  return finalizar(f);
}

// ---------------- Plano: o que cada linha vira ----------------
// Regra do início do controle (config.mes_inicio), pela data da COMPRA:
// - compra antes do início: entra no compromisso da fatura (acao 'na_fatura'), inclusive a parcela k deste mês;
// - compra a partir do início: só vira lançamento (à vista) ou parcela (parcelada, já contando a deste mês).
// Assim, fatura só com compras antigas vira um compromisso inteiro; fatura mista vira compromisso só da parte antiga;
// fatura só com compras novas não vira compromisso.
// acao: 'lancamento' | 'parcela' | 'na_fatura' | 'credito' (estorno depois do início: não é gravado)
//       | 'ignorar' (fatura vence antes do início)
const dias = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const chave = (s) => normal(s || '').replace(/\s+/g, ' ').trim();
// "Bradesco final 1111", "nubank 1111" → "1111". Sem 4 dígitos no fim, compara o texto todo.
const finalCartao = (s) => (chave(s).match(/(\d{4})\D*$/) || [, chave(s)])[1];
const ultimoMes = (p) => addMeses(mesDe(p.primeiro_mes), Number(p.quantidade) - 1);

export function planoFatura(f, d) {
  const inicio = d.config?.mes_inicio ? mesDe(d.config.mes_inicio) : '0000-00';
  const venc = mesDe(f.vencimento);
  const comFatura = venc >= inicio; // fatura vence dentro do período controlado
  const usados = new Set();
  // Inclui lançamentos já importados: a fatura aberta e a fechada do mesmo mês trazem as mesmas compras.
  const existentes = d.lancamentos || [];
  const linhas = f.itens.map((it, i) => {
    const l = { i, ...it, categoria: categorizar(it.descricao), restantes: 0, parcelaExistente: null, duplicata: null };
    // A parcela k caiu nesta fatura, então a compra foi no máximo k−1 meses antes (corrige o ano quando o PDF só traz dia/mês).
    const mesCompra = it.parcela ? [mesDe(it.data), addMeses(venc, 1 - it.parcela.k)].sort()[0] : mesDe(it.data);
    const antiga = mesCompra < inicio;
    if (it.parcela && it.valor > 0) {
      l.restantes = it.parcela.n - it.parcela.k;
      l.acao = !comFatura ? 'ignorar' : antiga ? 'na_fatura' : 'parcela';
      // Casa por valor da parcela, final do cartão e último mês (= parcelas restantes); a descrição só desempata.
      const fim = addMeses(venc, l.restantes);
      const cands = (d.parcelas || []).filter((p) => !usados.has(p.id) && Math.abs(Number(p.valor_parcela) - it.valor) <= 0.01 &&
        finalCartao(p.cartao) === finalCartao(it.cartao) && ultimoMes(p) === fim);
      const ex = cands.find((p) => chave(p.descricao) === chave(it.descricao)) || cands[0];
      if (ex) { usados.add(ex.id); l.parcelaExistente = ex.id; }
      const desde = l.acao === 'parcela' ? 0 : 1; // compra nova: a parcela deste mês também é parcela
      const qtd = l.restantes + 1 - desde;
      if (qtd > 0) l.parcelaNova = { descricao: it.descricao, categoria: l.categoria, cartao: it.cartao.slice(0, 30), valor_parcela: it.valor, primeiro_mes: addMeses(venc, desde) + '-01', quantidade: Math.min(48, qtd) };
      // sem parcelaNova e com existente: era a última e já entrou na fatura, a cadastrada sai
    } else if (!comFatura) l.acao = 'ignorar';
    else if (antiga) l.acao = 'na_fatura'; // compra ou estorno antes do início: abate do que se paga na fatura
    else if (it.valor > 0) {
      l.acao = 'lancamento';
      const dup = existentes.find((m) => !usados.has(m.id) && Math.abs(Number(m.valor) - it.valor) <= 0.01 && dias(m.data, it.data) <= 2);
      if (dup) { usados.add(dup.id); l.duplicata = dup; l.manter = 'meu'; }
    } else l.acao = 'credito';
    return l;
  });
  const valorFatura = soma(linhas.filter((l) => l.acao === 'na_fatura'), (l) => l.valor);
  const descricao = `Fatura ${f.tipo === 'fatura_nubank' ? 'Nubank' : 'Bradesco'} ${venc.slice(5)}/${venc.slice(0, 4)}`;
  const compromisso = comFatura && valorFatura > 0
    ? { descricao, categoria: 'Outros', valor: valorFatura, recorrente: false, mes: venc + '-01' }
    : null;
  // Mesma fatura importada antes (ex.: a versão aberta): atualiza em vez de criar outra.
  const ex = (d.compromissos || []).find((c) => !c.recorrente && c.descricao === descricao && mesDe(c.mes || '') === venc);
  // Compromisso pontual digitado à mão, em mês igual ou posterior ao vencimento, com valor a ±1% do total
  // ou do compromisso calculado: provavelmente é esta mesma fatura.
  const alvos = [f.total, compromisso?.valor].filter((v) => v > 0);
  const possivelManual = (d.compromissos || []).find((c) => !c.recorrente && c.id !== ex?.id && venc <= mesDe(c.mes || '') &&
    alvos.some((v) => Math.abs(Number(c.valor) - v) <= v * 0.01)) || null;
  return { linhas, compromisso, compromissoExistente: ex ? ex.id : null, possivelManual };
}

// Extrai o texto de um PDF NO NAVEGADOR com o pdf.js copiado em vendor/pdfjs/ (nada vai para a rede).
// Só o navegador usa este arquivo; os parsers recebem as linhas e são testados no Node.
import { linhasDeItens } from './texto.js';

let pdfjs;
async function carregar() {
  if (!pdfjs) {
    pdfjs = await import('../../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

export const MAX_BYTES = 10 * 1024 * 1024;

// Devolve um array de páginas; cada página é um array de linhas { texto, tokens }.
// senha: só em memória, nunca salva. Erros: 'SENHA' (pedir) ou 'SENHA_ERRADA'.
// paginasPara(linhasDaPagina1) diz quantas páginas extrair (o contracheque para na 1ª).
export async function lerPdf(arquivo, senha, paginasPara = () => 20) {
  if (arquivo.size > MAX_BYTES) throw new Error('Arquivo grande demais (máx. 10 MB).');
  const dados = new Uint8Array(await arquivo.arrayBuffer());
  if (String.fromCharCode(...dados.slice(0, 5)) !== '%PDF-') throw new Error('O arquivo não é um PDF.');
  const lib = await carregar();
  const tarefa = lib.getDocument({ data: dados, password: senha || undefined, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, enableXfa: false, stopAtErrors: false });
  let doc;
  try { doc = await tarefa.promise; }
  catch (e) {
    if (e?.name === 'PasswordException') throw new Error(e.code === 2 ? 'SENHA_ERRADA' : 'SENHA');
    throw new Error('Não consegui abrir o PDF.');
  }
  try {
    const paginas = [];
    let max = 1;
    for (let n = 1; n <= Math.min(doc.numPages, max); n++) {
      const pg = await doc.getPage(n);
      paginas.push(linhasDeItens((await pg.getTextContent()).items));
      if (n === 1) max = Math.min(20, paginasPara(paginas[0]));
    }
    return paginas;
  } finally { await doc.destroy(); }
}

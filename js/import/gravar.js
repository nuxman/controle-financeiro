// Gravação das importações. Recebe `db` (cliente de supa.js) para poder ser testada sem navegador.
let gravando = false;
export const emGravacao = () => gravando;

// Trava (uma gravação por vez) → confere o hash NO SERVIDOR antes de inserir qualquer linha →
// grava `importacoes` e roda `criar(imp.id)`. Se `criar` falhar, apagar a importação desfaz
// (on delete cascade) as linhas que ela já criou. Depois roda `ajustar()` (atualiza/encerra linhas antigas).
export async function gravarImportacao(db, registro, criar, ajustar) {
  if (gravando) throw new Error('Já existe uma gravação em andamento. Aguarde.');
  gravando = true; // antes de qualquer await: duas chamadas simultâneas não passam juntas
  try {
    // ponytail: lista todas as importações (poucas por usuário); filtrar por hash na URL se crescer.
    const ja = await db.listar('importacoes');
    if (ja.some((i) => i.hash === registro.hash)) throw new Error('Este arquivo já foi importado. Nada foi gravado.');
    const [imp] = await db.inserir('importacoes', registro);
    try { await criar(imp.id); } catch (e) { await db.apagar('importacoes', imp.id).catch(() => {}); throw e; }
    await ajustar();
  } finally { gravando = false; }
}

export function gravarContracheque(db, cc, itens, hash) {
  const marcados = itens.filter((i) => i.marcado);
  return gravarImportacao(db, { hash, tipo: 'contracheque', competencia: cc.competencia + '-01', total: cc.totais.liquido,
    total_bruto: cc.totais.bruto, total_descontos: cc.totais.descontos, liquido: cc.totais.liquido }, async (id) => {
    const novas = marcados.filter((i) => i.criar).map((i) => ({ ...i.criar, importacao_id: id }));
    if (novas.some((n) => !(n.valor > 0 && n.valor < 10000000))) throw new Error('Valor inválido.');
    if (novas.length) await db.inserir('receitas', novas);
  }, async () => {
    for (const i of marcados) {
      if (i.encerrar) await db.atualizar('receitas', i.encerrar.id, i.encerrar.campos);
      if (i.atualizar) await db.atualizar('receitas', i.atualizar.id, i.atualizar.campos);
    }
  });
}

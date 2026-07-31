export async function syncPdvAllowedProducts(client, pdvId) {
  await client.query(
    `INSERT INTO estoque_pdv (pdv_id, sku_produto, permitido)
     SELECT DISTINCT $1, p.sku, TRUE
     FROM produtos p
     JOIN produto_categorias prc ON prc.sku_produto = p.sku
     JOIN pdv_categorias pc ON pc.pdv_id = $1 AND pc.categoria = prc.categoria
     ON CONFLICT (pdv_id, sku_produto) DO UPDATE SET permitido = TRUE`,
    [pdvId]
  );
  await client.query(
    `UPDATE estoque_pdv e
     SET permitido = FALSE
     WHERE e.pdv_id = $1
       AND NOT EXISTS (
         SELECT 1
         FROM produtos p
         JOIN produto_categorias prc ON prc.sku_produto = p.sku
         JOIN pdv_categorias pc ON pc.pdv_id = e.pdv_id AND pc.categoria = prc.categoria
         WHERE p.sku = e.sku_produto
       )`,
    [pdvId]
  );
}

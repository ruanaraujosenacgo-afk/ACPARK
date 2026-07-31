import { omieRequestWithConfig } from "./omie.client.js";
import { mapOmieProduct } from "./omie.mappers.js";

const PRODUCTS_ENDPOINT = "/geral/produtos/";
const PRODUCTS_CALL = "ListarProdutos";

function asPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSku(value) {
  return String(value || "").trim().slice(0, 60);
}

function normalizeName(value) {
  return String(value || "").trim().toUpperCase().slice(0, 160);
}

async function hasColumn(client, tableName, columnName) {
  const result = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return result.rowCount > 0;
}

async function getMappingSkuColumn(client) {
  if (await hasColumn(client, "product_integration_mappings", "sku_produto")) return "sku_produto";
  return "sku_acpark";
}

async function upsertOmieProduct(client, integrationId, mapped) {
  const sku = normalizeSku(mapped.sku || mapped.externalId);
  const name = normalizeName(mapped.name);
  if (!sku || !name || !mapped.externalId) return "ignored";

  const existing = await client.query("SELECT sku FROM produtos WHERE sku = $1 LIMIT 1", [sku]);
  if (existing.rows[0]) {
    await client.query(
      `UPDATE produtos
       SET nome = $2,
           ativo = $3,
           saldo_omie = $4,
           saldo_disponivel_acpark = $4 - COALESCE(quantidade_reservada_acpark, 0),
           ultima_sincronizacao = CURRENT_TIMESTAMP,
           sincronizacao_status = 'PENDENTE_REVISAO'
       WHERE sku = $1`,
      [sku, name, mapped.active, mapped.stockQuantity]
    );
  } else {
    await client.query(
      `INSERT INTO produtos (
         sku, nome, qtd_total, estoque_central, ativo, categoria, origem,
         saldo_omie, quantidade_reservada_acpark, saldo_disponivel_acpark,
         ultima_sincronizacao, sincronizacao_status, stock_mode
       )
       VALUES ($1, $2, 0, 0, $3, NULL, 'omie', $4, 0, $4, CURRENT_TIMESTAMP, 'PENDENTE_REVISAO', 'TRANSICAO')`,
      [sku, name, mapped.active, mapped.stockQuantity]
    );
  }

  const skuColumn = await getMappingSkuColumn(client);
  const update = await client.query(
    `UPDATE product_integration_mappings
     SET external_product_id = $3,
         external_code = $4,
         integration_code = $5,
         product_type = $6,
         unit = $7,
         family = $8,
         ean = $9,
         ncm = $10,
         price = $11,
         stock_control = $12,
         review_status = COALESCE(review_status, 'PENDENTE_REVISAO'),
         raw_payload = $13::jsonb,
         active = $14,
         updated_at = CURRENT_TIMESTAMP
     WHERE integration_id = $1 AND ${skuColumn} = $2`,
    [
      integrationId,
      sku,
      mapped.externalId,
      mapped.sku,
      mapped.integrationCode,
      mapped.productType,
      mapped.unit,
      mapped.family,
      mapped.ean,
      mapped.ncm,
      mapped.price,
      mapped.stockControl,
      JSON.stringify(mapped.raw || {}),
      mapped.active
    ]
  );

  if (!update.rowCount) {
    await client.query(
      `INSERT INTO product_integration_mappings (
         integration_id, ${skuColumn}, external_product_id, external_code,
         integration_code, product_type, unit, family, ean, ncm, price,
         stock_control, review_status, raw_payload, active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PENDENTE_REVISAO', $13::jsonb, $14)`,
      [
        integrationId,
        sku,
        mapped.externalId,
        mapped.sku,
        mapped.integrationCode,
        mapped.productType,
        mapped.unit,
        mapped.family,
        mapped.ean,
        mapped.ncm,
        mapped.price,
        mapped.stockControl,
        JSON.stringify(mapped.raw || {}),
        mapped.active
      ]
    );
  }

  return existing.rows[0] ? "updated" : "created";
}

export async function testOmieProductsConnection({ loaded, fetchImpl }) {
  const response = await omieRequestWithConfig({
    loaded,
    endpoint: PRODUCTS_ENDPOINT,
    call: PRODUCTS_CALL,
    params: {
      pagina: 1,
      registros_por_pagina: 1,
      apenas_importado_api: "N",
      filtrar_apenas_omiepdv: "N"
    },
    fetchImpl
  });

  return {
    duration_ms: response.duration_ms,
    page: response.data?.pagina || 1,
    total_pages: response.data?.total_de_paginas || 0,
    total_records: response.data?.total_de_registros || response.data?.total_de_registros_encontrados || 0
  };
}

export async function syncOmieProducts(client, { loaded, payload = {}, fetchImpl }) {
  const pageSize = Math.min(asPositiveInt(payload.pageSize || payload.registros_por_pagina, 100), 500);
  const firstPage = asPositiveInt(payload.pageStart || payload.pagina, 1);
  const maxPages = Math.min(asPositiveInt(payload.maxPages || process.env.OMIE_PRODUCTS_SYNC_MAX_PAGES, 5), 20);
  const summary = {
    pages: 0,
    received: 0,
    created: 0,
    updated: 0,
    ignored: 0,
    inactive: 0,
    next_page: null,
    total_pages: null
  };

  let page = firstPage;
  for (let processed = 0; processed < maxPages; processed += 1) {
    const response = await omieRequestWithConfig({
      loaded,
      endpoint: PRODUCTS_ENDPOINT,
      call: PRODUCTS_CALL,
      params: {
        pagina: page,
        registros_por_pagina: pageSize,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N"
      },
      fetchImpl
    });

    const products = Array.isArray(response.data?.produto_servico_cadastro)
      ? response.data.produto_servico_cadastro
      : [];
    const totalPages = asPositiveInt(response.data?.total_de_paginas, page);
    summary.total_pages = totalPages;
    summary.pages += 1;
    summary.received += products.length;

    for (const product of products) {
      const mapped = mapOmieProduct(product);
      const result = await upsertOmieProduct(client, loaded.integration.id, mapped);
      summary[result] += 1;
      if (!mapped.active) summary.inactive += 1;
    }

    if (page >= totalPages || !products.length) break;
    page += 1;
  }

  if (summary.total_pages && page < summary.total_pages) {
    summary.next_page = page + 1;
  }

  return summary;
}

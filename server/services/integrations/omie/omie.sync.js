import { asInt, query, tx } from "../../../db.js";
import { normalizeText } from "../../../utils/http.js";
import { enqueueIntegrationJob, updateIntegrationStatus } from "../integration.service.js";
import { publishIntegrationEvent } from "../integration.events.js";
import { omieRequest } from "./omie.client.js";
import { errorStatusForConnection, errorStatusForJob } from "./omie.errors.js";
import {
  OMIE_ENDPOINTS,
  extractItems,
  extractTotalPages,
  mapOmieLocation,
  mapOmieMovement,
  mapOmieProduct,
  mapOmieStock,
  safeJson
} from "./omie.mappers.js";

export const OMIE_JOB_TYPES = Object.freeze({
  PRODUCTS: "SYNC_OMIE_PRODUCTS",
  LOCATIONS: "SYNC_OMIE_LOCATIONS",
  STOCK: "SYNC_OMIE_STOCK",
  STOCK_ITEM: "SYNC_OMIE_STOCK_ITEM",
  MOVEMENTS: "SYNC_OMIE_MOVEMENTS",
  FULL: "SYNC_OMIE_FULL",
  RECONCILE: "RECONCILE_OMIE_STOCK"
});

export function normalizeSyncScope(scope = "") {
  const value = normalizeText(scope, 80).toUpperCase();
  if (["PRODUTOS", "PRODUCTS", "SYNC_OMIE_PRODUCTS"].includes(value)) return OMIE_JOB_TYPES.PRODUCTS;
  if (["LOCAIS", "LOCATIONS", "SYNC_OMIE_LOCATIONS"].includes(value)) return OMIE_JOB_TYPES.LOCATIONS;
  if (["SALDOS", "STOCK", "SYNC_OMIE_STOCK"].includes(value)) return OMIE_JOB_TYPES.STOCK;
  if (["SALDO_ITEM", "STOCK_ITEM", "SYNC_OMIE_STOCK_ITEM"].includes(value)) return OMIE_JOB_TYPES.STOCK_ITEM;
  if (["MOVIMENTOS", "MOVEMENTS", "SYNC_OMIE_MOVEMENTS"].includes(value)) return OMIE_JOB_TYPES.MOVEMENTS;
  if (["RECONCILIACAO", "RECONCILIAÇÃO", "RECONCILE", "RECONCILE_OMIE_STOCK"].includes(value)) return OMIE_JOB_TYPES.RECONCILE;
  return OMIE_JOB_TYPES.FULL;
}

function pageParams(page, size, extras = {}) {
  return {
    pagina: page,
    registros_por_pagina: size,
    nPagina: page,
    nRegPorPagina: size,
    ...extras
  };
}

function todayBr() {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function pastDateBr(days) {
  const date = new Date(Date.now() - days * 86400000);
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(date);
}

function dateBr(date) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(date);
}

function dateTimeForSql(date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date).replace(" ", "T").replace("T", " ");
}

function priorityForJobType(jobType) {
  if (jobType === OMIE_JOB_TYPES.STOCK_ITEM) return "CRITICA";
  if (jobType === OMIE_JOB_TYPES.MOVEMENTS || jobType === OMIE_JOB_TYPES.STOCK) return "ALTA";
  if (jobType === OMIE_JOB_TYPES.RECONCILE) return "BAIXA";
  return "NORMAL";
}

export async function testOmieConnection(integrationId, actor = "sistema") {
  const started = Date.now();
  await updateIntegrationStatus(integrationId, "VALIDANDO", "", actor);
  try {
    const response = await omieRequest({
      integrationId,
      ...OMIE_ENDPOINTS.PRODUCTS,
      params: { pagina: 1, registros_por_pagina: 1, apenas_importado_api: "N", filtrar_apenas_omiepdv: "N" }
    });
    const duration = response.elapsedMs || Date.now() - started;
    await query(
      `UPDATE integrations
       SET status = 'CONECTADO',
           last_error = NULL,
           last_connection_test_at = CURRENT_TIMESTAMP,
           last_connection_duration_ms = $2,
           last_connection_message = 'Conexao de leitura validada.',
           updated_at = CURRENT_TIMESTAMP,
           updated_by = $3
       WHERE id = $1`,
      [asInt(integrationId), duration, actor]
    );
    await audit(integrationId, "OMIE_CONNECTION_TESTED", actor, { status: "CONECTADO", durationMs: duration, endpoint: OMIE_ENDPOINTS.PRODUCTS.endpoint, call: OMIE_ENDPOINTS.PRODUCTS.call });
    return { status: "CONECTADO", durationMs: duration, message: "Conexao de leitura validada.", environment: "OMIE" };
  } catch (error) {
    const status = errorStatusForConnection(error);
    const duration = Date.now() - started;
    const message = normalizeText(error?.message || "Falha ao testar conexao OMIE.", 500);
    await query(
      `UPDATE integrations
       SET status = $2,
           last_error = $3,
           last_connection_test_at = CURRENT_TIMESTAMP,
           last_connection_duration_ms = $4,
           last_connection_message = $3,
           updated_at = CURRENT_TIMESTAMP,
           updated_by = $5
       WHERE id = $1`,
      [asInt(integrationId), status, message, duration, actor]
    );
    await audit(integrationId, "OMIE_CONNECTION_TEST_FAILED", actor, { status, durationMs: duration, message });
    return { status, durationMs: duration, message, environment: "OMIE" };
  }
}

async function audit(integrationId, action, actor, details = {}) {
  await query(
    `INSERT INTO integration_audit_logs (integration_id, action, actor, details)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [asInt(integrationId), action, actor, JSON.stringify(details)]
  );
}

async function eachPage({ integrationId, endpoint, call, initialParams, itemKeys, onItem, maxPages = 500 }) {
  const counters = { pages: 0, received: 0, created: 0, updated: 0, ignored: 0, inactive: 0, errors: 0, alerts: 0 };
  let page = 1;
  let totalPages = 1;
  do {
    const response = await omieRequest({ integrationId, endpoint, call, params: initialParams(page) });
    const items = extractItems(response.data, itemKeys);
    totalPages = extractTotalPages(response.data);
    counters.pages += 1;
    counters.received += items.length;
    for (const item of items) {
      try {
        const result = await onItem(item, response.data);
        counters[result || "ignored"] = (counters[result || "ignored"] || 0) + 1;
      } catch {
        counters.errors += 1;
      }
    }
    page += 1;
  } while (page <= totalPages && page <= maxPages);
  return counters;
}

export async function syncOmieProducts(integrationId) {
  return eachPage({
    integrationId,
    ...OMIE_ENDPOINTS.PRODUCTS,
    initialParams: (page) => pageParams(page, 50, { apenas_importado_api: "N", filtrar_apenas_omiepdv: "N" }),
    itemKeys: ["produto_servico_cadastro", "produtos", "produto_servico_resumido"],
    onItem: async (item) => {
      const product = mapOmieProduct(item);
      if (!product.externalId || !product.sku) return "ignored";
      const existing = await query("SELECT sku, ativo FROM produtos WHERE sku = $1", [product.sku]);
      await query(
        `INSERT INTO produtos (sku, nome, ativo, origem, categoria)
         VALUES ($1, $2, $3, 'omie', NULL)
         ON CONFLICT (sku) DO UPDATE
           SET nome = EXCLUDED.nome,
               ativo = EXCLUDED.ativo,
               origem = CASE WHEN produtos.origem = 'manual' THEN produtos.origem ELSE 'omie' END`,
        [product.sku, product.description, product.active]
      );
      await query(
        `INSERT INTO product_integration_mappings
           (integration_id, sku_produto, external_product_id, external_code, integration_code, product_type, unit, family, ean, ncm, price, stock_control, review_status, raw_payload, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PENDENTE_REVISAO', $13::jsonb, $14)
         ON CONFLICT (integration_id, external_product_id)
         DO UPDATE SET sku_produto = COALESCE(product_integration_mappings.sku_produto, EXCLUDED.sku_produto),
                       external_code = EXCLUDED.external_code,
                       integration_code = EXCLUDED.integration_code,
                       product_type = EXCLUDED.product_type,
                       unit = EXCLUDED.unit,
                       family = EXCLUDED.family,
                       ean = EXCLUDED.ean,
                       ncm = EXCLUDED.ncm,
                       price = EXCLUDED.price,
                       stock_control = EXCLUDED.stock_control,
                       raw_payload = EXCLUDED.raw_payload,
                       active = EXCLUDED.active,
                       updated_at = CURRENT_TIMESTAMP`,
        [asInt(integrationId), product.sku, product.externalId, product.sku, product.integrationCode, product.itemType, product.unit, product.family, product.ean, product.ncm, product.price, product.stockControl, safeJson(product.raw), product.active]
      );
      return product.active ? (existing.length ? "updated" : "created") : "inactive";
    }
  });
}

export async function syncOmieLocations(integrationId) {
  return eachPage({
    integrationId,
    ...OMIE_ENDPOINTS.LOCATIONS,
    initialParams: (page) => pageParams(page, 50),
    itemKeys: ["locaisEncontrados", "locais_estoque", "local_estoque", "listaLocalEstoque"],
    onItem: async (item) => {
      const location = mapOmieLocation(item);
      if (!location.externalId) return "ignored";
      const rows = await query(
        `INSERT INTO omie_stock_locations
           (integration_id, omie_location_id, code, name, description, active, company, raw_payload, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (integration_id, omie_location_id)
         DO UPDATE SET code = EXCLUDED.code,
                       name = EXCLUDED.name,
                       description = EXCLUDED.description,
                       active = EXCLUDED.active,
                       company = EXCLUDED.company,
                       raw_payload = EXCLUDED.raw_payload,
                       synced_at = CURRENT_TIMESTAMP,
                       updated_at = CURRENT_TIMESTAMP
         RETURNING (xmax = 0) AS inserted`,
        [asInt(integrationId), location.externalId, location.code, location.name, location.description, location.active, location.company, safeJson(location.raw)]
      );
      return rows[0]?.inserted ? "created" : "updated";
    }
  });
}

export async function syncOmieStock(integrationId) {
  const mappedLocations = await query(
    `SELECT DISTINCT omie_location_id FROM pdv_stock_location_mappings
     WHERE integration_id = $1 AND active = TRUE`,
    [asInt(integrationId)]
  );
  if (!mappedLocations.length) {
    return { pages: 0, received: 0, created: 0, updated: 0, ignored: 0, inactive: 0, errors: 0, alerts: 1, message: "Nenhum local OMIE mapeado." };
  }
  const totals = { pages: 0, received: 0, created: 0, updated: 0, ignored: 0, inactive: 0, errors: 0, alerts: 0 };
  for (const location of mappedLocations) {
    const counters = await eachPage({
      integrationId,
      ...OMIE_ENDPOINTS.STOCK,
      initialParams: (page) => pageParams(page, 50, { dDataPosicao: todayBr(), cExibeTodos: "N", codigo_local_estoque: Number(location.omie_location_id) || 0 }),
      itemKeys: ["produtos", "produto", "lista_estoque"],
      onItem: async (item, data) => {
        const stock = mapOmieStock(item, location.omie_location_id);
        if (!stock.externalProductId) return "ignored";
        const mappings = await query(
          `SELECT sku_produto FROM product_integration_mappings
           WHERE integration_id = $1 AND external_product_id = $2 AND active = TRUE
           LIMIT 1`,
          [asInt(integrationId), stock.externalProductId]
        );
        const sku = mappings[0]?.sku_produto;
        if (!sku) return "alerts";
        const pdvs = await query(
          `SELECT pdv_acpark_id FROM pdv_stock_location_mappings
           WHERE integration_id = $1 AND omie_location_id = $2 AND active = TRUE`,
          [asInt(integrationId), stock.locationId]
        );
        if (!pdvs.length) return "alerts";
        for (const pdv of pdvs) {
          await query(
            `INSERT INTO estoque_pdv (pdv_id, sku_produto, quantidade, saldo_omie, quantidade_reservada_acpark, ultima_sincronizacao, sincronizacao_status)
             VALUES ($1, $2, 0, $3, 0, CURRENT_TIMESTAMP, 'ATUALIZADO')
             ON CONFLICT (pdv_id, sku_produto)
             DO UPDATE SET saldo_omie = EXCLUDED.saldo_omie,
                           ultima_sincronizacao = CURRENT_TIMESTAMP,
                           sincronizacao_status = 'ATUALIZADO'`,
            [pdv.pdv_acpark_id, sku, stock.quantity]
          );
          await query(
            `INSERT INTO stock_snapshots
               (integration_id, pdv_id, sku_produto, omie_location_id, saldo_omie, quantidade_reservada_acpark, saldo_disponivel_acpark, sync_status, raw_payload)
             SELECT $1, $2, $3, $4, $5, COALESCE(e.quantidade_reservada_acpark, 0), $5 - COALESCE(e.quantidade_reservada_acpark, 0), 'SINCRONIZADO', $6::jsonb
             FROM estoque_pdv e
             WHERE e.pdv_id = $2 AND e.sku_produto = $3`,
            [asInt(integrationId), pdv.pdv_acpark_id, sku, stock.locationId, stock.quantity, safeJson({ item, data_reference: data?.dDataPosicao || stock.referenceDate })]
          );
        }
        return "updated";
      }
    });
    for (const key of Object.keys(totals)) totals[key] += counters[key] || 0;
  }
  return totals;
}

export async function syncOmieStockItem(integrationId, { omie_product_id, omie_location_id, trigger = "manual", external_reference = "" } = {}) {
  const productId = normalizeText(omie_product_id, 80);
  const locationId = normalizeText(omie_location_id, 80);
  if (!productId || !locationId) return { updated: 0, ignored: 1, message: "Produto/local OMIE ausente." };

  const response = await omieRequest({
    integrationId,
    ...OMIE_ENDPOINTS.STOCK,
    params: {
      nPagina: 1,
      nRegPorPagina: 50,
      dDataPosicao: todayBr(),
      cExibeTodos: "N",
      codigo_local_estoque: Number(locationId) || 0,
      lista_produtos: [{ nCodProd: Number(productId) || 0 }]
    }
  });
  const items = extractItems(response.data, ["produtos", "produto", "lista_estoque"]);
  let updated = 0;
  for (const item of items) {
    const stock = mapOmieStock(item, locationId);
    if (String(stock.externalProductId) !== String(productId)) continue;
    const mapping = (await query(
      `SELECT sku_produto FROM product_integration_mappings
       WHERE integration_id = $1 AND external_product_id = $2 AND active = TRUE
       LIMIT 1`,
      [asInt(integrationId), productId]
    ))[0];
    if (!mapping?.sku_produto) continue;
    const pdvs = await query(
      `SELECT pdv_acpark_id FROM pdv_stock_location_mappings
       WHERE integration_id = $1 AND omie_location_id = $2 AND active = TRUE`,
      [asInt(integrationId), locationId]
    );
    for (const pdv of pdvs) {
      await query(
        `INSERT INTO estoque_pdv (pdv_id, sku_produto, quantidade, saldo_omie, quantidade_reservada_acpark, ultima_sincronizacao, sincronizacao_status)
         VALUES ($1, $2, 0, $3, 0, CURRENT_TIMESTAMP, 'ATUALIZADO')
         ON CONFLICT (pdv_id, sku_produto)
         DO UPDATE SET saldo_omie = EXCLUDED.saldo_omie,
                       ultima_sincronizacao = CURRENT_TIMESTAMP,
                       sincronizacao_status = 'ATUALIZADO'`,
        [pdv.pdv_acpark_id, mapping.sku_produto, stock.quantity]
      );
      await query(
        `INSERT INTO stock_snapshots
           (integration_id, pdv_id, sku_produto, omie_location_id, saldo_omie, quantidade_reservada_acpark, saldo_disponivel_acpark, sync_status, raw_payload)
         SELECT $1, $2, $3, $4, $5, COALESCE(e.quantidade_reservada_acpark, 0), $5 - COALESCE(e.quantidade_reservada_acpark, 0), 'SINCRONIZADO', $6::jsonb
         FROM estoque_pdv e
         WHERE e.pdv_id = $2 AND e.sku_produto = $3`,
        [asInt(integrationId), pdv.pdv_acpark_id, mapping.sku_produto, locationId, stock.quantity, safeJson({ item, trigger, external_reference })]
      );
      publishIntegrationEvent("stock.updated", { integration_id: asInt(integrationId), pdv_id: pdv.pdv_acpark_id, sku_produto: mapping.sku_produto, omie_location_id: locationId, saldo_omie: stock.quantity });
      updated += 1;
    }
  }
  await query(
    `UPDATE stock_refresh_queue
     SET status = 'CONCLUIDO',
         updated_at = CURRENT_TIMESTAMP
     WHERE integration_id = $1 AND omie_product_id = $2 AND omie_location_id = $3 AND status = 'PROCESSANDO'`,
    [asInt(integrationId), productId, locationId]
  );
  await query(
    `INSERT INTO integration_metrics (integration_id, metric_name, metric_value, labels)
     VALUES ($1, 'stock_refresh_latency_ms', EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE((SELECT MIN(created_at) FROM stock_refresh_queue WHERE integration_id = $1 AND omie_product_id = $2 AND omie_location_id = $3), CURRENT_TIMESTAMP))) * 1000, $4::jsonb)`,
    [asInt(integrationId), productId, locationId, safeJson({ trigger })]
  );
  return { updated, received: items.length, omie_product_id: productId, omie_location_id: locationId };
}

export async function syncOmieMovements(integrationId) {
  const state = (await query(
    `INSERT INTO integration_sync_state (integration_id, scope, last_attempt_at, overlap_start_at)
     VALUES ($1, 'MOVEMENTS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP - INTERVAL '2 minutes')
     ON CONFLICT (integration_id, scope)
     DO UPDATE SET last_attempt_at = CURRENT_TIMESTAMP,
                   overlap_start_at = COALESCE(integration_sync_state.last_success_at - INTERVAL '2 minutes', CURRENT_TIMESTAMP - INTERVAL '2 minutes'),
                   updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [asInt(integrationId)]
  ))[0];
  const from = state.overlap_start_at ? new Date(state.overlap_start_at) : new Date(Date.now() - 120000);
  const to = new Date();
  let lastMovementId = state.last_movement_id || "";
  const started = Date.now();
  return eachPage({
    integrationId,
    ...OMIE_ENDPOINTS.MOVEMENTS,
    initialParams: (page) => pageParams(page, 50, { dDtInicial: dateBr(from), dDtFinal: dateBr(to), lista_local_estoque: "TODOS" }),
    itemKeys: ["movProdutoListar", "movProduto", "movimentos", "lista_movimentos"],
    onItem: async (item) => {
      const movement = mapOmieMovement(item);
      if (!movement.movementId) return "ignored";
      lastMovementId = movement.movementId;
      const mapping = movement.externalProductId
        ? (await query(
            `SELECT sku_produto FROM product_integration_mappings
             WHERE integration_id = $1 AND external_product_id = $2 AND active = TRUE
             LIMIT 1`,
            [asInt(integrationId), movement.externalProductId]
          ))[0]
        : null;
      const locationMapping = movement.locationId
        ? (await query(
            `SELECT pdv_acpark_id FROM pdv_stock_location_mappings
             WHERE integration_id = $1 AND omie_location_id = $2 AND active = TRUE
             LIMIT 1`,
            [asInt(integrationId), movement.locationId]
          ))[0]
        : null;
      const inserted = await tx(async (client) => {
        const rows = await client.query(
          `INSERT INTO stock_movements
             (omie_movement_id, operation_type, origin_system, external_reference, pdv_id, omie_location_id, status, movement_date, synced_at, raw_payload)
           VALUES ($1, $2, $3, $4, NULLIF($5, 0), $6, 'IMPORTADO', NULLIF($7, '')::timestamp, CURRENT_TIMESTAMP, $8::jsonb)
           ON CONFLICT (omie_movement_id)
           DO UPDATE SET origin_system = EXCLUDED.origin_system,
                         external_reference = EXCLUDED.external_reference,
                         synced_at = CURRENT_TIMESTAMP,
                         raw_payload = EXCLUDED.raw_payload
           RETURNING id, (xmax = 0) AS inserted`,
          [movement.movementId, movement.operationType, movement.originSystem, movement.reference, locationMapping?.pdv_acpark_id || 0, movement.locationId, movement.movementDate, safeJson(movement.raw)]
        );
        await client.query(
          `INSERT INTO stock_movement_items (movement_id, sku_produto, quantity, unit)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [rows.rows[0].id, mapping?.sku_produto || null, movement.quantity, movement.unit]
        );
        return rows.rows[0]?.inserted;
      });
      if (inserted && movement.externalProductId && movement.locationId) {
        await enqueueStockRefresh({
          integrationId,
          omieProductId: movement.externalProductId,
          omieLocationId: movement.locationId,
          trigger: "MOVEMENT_IMPORTED",
          externalReference: movement.movementId
        });
        publishIntegrationEvent("stock.movement.imported", { integration_id: asInt(integrationId), movement_id: movement.movementId, origin_system: movement.originSystem, omie_product_id: movement.externalProductId, omie_location_id: movement.locationId });
      }
      return inserted ? "created" : "updated";
    }
  }).then(async (counters) => {
    await query(
      `UPDATE integration_sync_state
       SET last_success_at = CURRENT_TIMESTAMP,
           last_movement_id = $2,
           last_page = $3,
           last_error = NULL,
           stats = $4::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE integration_id = $1 AND scope = 'MOVEMENTS'`,
      [asInt(integrationId), lastMovementId, counters.pages || 1, safeJson(counters)]
    );
    await query(
      `INSERT INTO integration_metrics (integration_id, metric_name, metric_value, labels)
       VALUES ($1, 'movement_sync_latency_ms', $2, $3::jsonb)`,
      [asInt(integrationId), Date.now() - started, safeJson({ from: dateTimeForSql(from), to: dateTimeForSql(to), records: counters.received })]
    );
    return counters;
  });
}

export async function enqueueStockRefresh({ integrationId, omieProductId, omieLocationId, trigger = "", externalReference = "" }) {
  const rows = await query(
    `INSERT INTO stock_refresh_queue
       (integration_id, omie_product_id, omie_location_id, trigger, external_reference)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (integration_id, omie_product_id, omie_location_id, status)
     DO UPDATE SET trigger = EXCLUDED.trigger,
                   external_reference = EXCLUDED.external_reference,
                   available_at = LEAST(stock_refresh_queue.available_at, CURRENT_TIMESTAMP + INTERVAL '1 second'),
                   updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [asInt(integrationId), normalizeText(omieProductId, 80), normalizeText(omieLocationId, 80), normalizeText(trigger, 80), normalizeText(externalReference, 180)]
  );
  return rows[0];
}

export async function drainStockRefreshQueue(limit = 10) {
  const rows = await tx(async (client) => {
    const locked = await client.query(
      `SELECT *
       FROM stock_refresh_queue
       WHERE status = 'PENDENTE' AND available_at <= CURRENT_TIMESTAMP
       ORDER BY available_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [asInt(limit, 10)]
    );
    for (const row of locked.rows) {
      await client.query("UPDATE stock_refresh_queue SET status = 'PROCESSANDO', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [row.id]);
    }
    return locked.rows;
  });
  const jobs = [];
  for (const row of rows) {
    const job = await enqueueIntegrationJob({
      integrationId: row.integration_id,
      jobType: OMIE_JOB_TYPES.STOCK_ITEM,
      priority: "CRITICA",
      payload: {
        omie_product_id: row.omie_product_id,
        omie_location_id: row.omie_location_id,
        trigger: row.trigger,
        external_reference: row.external_reference
      },
      idempotencyKey: `STOCK-ITEM-${row.integration_id}-${row.omie_product_id}-${row.omie_location_id}-${Date.now()}`
    });
    jobs.push(job);
  }
  return jobs;
}

export async function reconcileOmieStock(integrationId) {
  const reconciliation = await query(
    `INSERT INTO stock_reconciliations (integration_id, status)
     VALUES ($1, 'PROCESSANDO')
     RETURNING id`,
    [asInt(integrationId)]
  );
  const reconciliationId = reconciliation[0].id;
  const rows = await query(
    `SELECT e.pdv_id, e.sku_produto, e.saldo_omie, e.quantidade_reservada_acpark,
            e.saldo_disponivel_acpark, e.ultima_sincronizacao, e.sincronizacao_status
     FROM estoque_pdv e
     WHERE e.ultima_sincronizacao IS NOT NULL`
  );
  let differences = 0;
  for (const row of rows) {
    const types = [];
    if (Number(row.quantidade_reservada_acpark || 0) > Number(row.saldo_omie || 0)) types.push("RESERVA_MAIOR_QUE_SALDO");
    if (Number(row.saldo_disponivel_acpark || 0) < 0) types.push("SALDO_NEGATIVO");
    if (row.sincronizacao_status !== "ATUALIZADO") types.push("SALDO_DESATUALIZADO");
    for (const type of types) {
      differences += 1;
      await query(
        `INSERT INTO stock_reconciliation_items
           (reconciliation_id, integration_id, pdv_id, sku_produto, difference_type, status, details)
         VALUES ($1, $2, $3, $4, $5, 'PENDENTE', $6::jsonb)`,
        [reconciliationId, asInt(integrationId), row.pdv_id, row.sku_produto, type, safeJson(row)]
      );
    }
  }
  await query(
    `UPDATE stock_reconciliations
     SET status = $2,
         differences_count = $3,
         finished_at = CURRENT_TIMESTAMP,
         summary = $4::jsonb
     WHERE id = $1`,
    [reconciliationId, differences ? "DIVERGENTE" : "CONCLUIDO", differences, safeJson({ checked: rows.length, differences })]
  );
  return { checked: rows.length, differences };
}

export async function classifyProductTemperatures(integrationId) {
  const rows = await query(
    `SELECT pim.external_product_id,
            pim.sku_produto,
            MAX(sm.movement_date) AS last_movement_at,
            COALESCE(MAX(e.quantidade_reservada_acpark), 0) AS reserved,
            COUNT(p.id)::int AS open_orders,
            COUNT(ri.id)::int AS divergences
     FROM product_integration_mappings pim
     LEFT JOIN stock_movement_items smi ON smi.sku_produto = pim.sku_produto
     LEFT JOIN stock_movements sm ON sm.id = smi.movement_id
     LEFT JOIN estoque_pdv e ON e.sku_produto = pim.sku_produto
     LEFT JOIN pedidos p ON p.sku_produto = pim.sku_produto AND p.status IN ('Pendente', 'Em Andamento', 'Aguardando Retirada', 'Liberação Parcial')
     LEFT JOIN stock_reconciliation_items ri ON ri.sku_produto = pim.sku_produto AND ri.status = 'PENDENTE'
     WHERE pim.integration_id = $1 AND pim.active = TRUE
     GROUP BY pim.external_product_id, pim.sku_produto`,
    [asInt(integrationId)]
  );
  const counters = { QUENTE: 0, MORNO: 0, FRIO: 0 };
  for (const row of rows) {
    const lastMovement = row.last_movement_at ? new Date(row.last_movement_at).getTime() : 0;
    const ageMs = lastMovement ? Date.now() - lastMovement : Number.POSITIVE_INFINITY;
    let temperature = "FRIO";
    let reason = "sem movimento recente";
    if (Number(row.reserved || 0) > 0 || Number(row.open_orders || 0) > 0 || Number(row.divergences || 0) > 0 || ageMs <= 60 * 60_000) {
      temperature = "QUENTE";
      reason = "pedido, reserva, divergencia ou movimento recente";
    } else if (ageMs <= 24 * 60 * 60_000) {
      temperature = "MORNO";
      reason = "movimentado nas ultimas 24 horas";
    }
    counters[temperature] += 1;
    await query(
      `INSERT INTO product_sync_temperature
         (integration_id, external_product_id, sku_produto, temperature, reason, last_movement_at, last_classified_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (integration_id, external_product_id)
       DO UPDATE SET sku_produto = EXCLUDED.sku_produto,
                     temperature = EXCLUDED.temperature,
                     reason = EXCLUDED.reason,
                     last_movement_at = EXCLUDED.last_movement_at,
                     last_classified_at = CURRENT_TIMESTAMP`,
      [asInt(integrationId), row.external_product_id, row.sku_produto, temperature, reason, row.last_movement_at]
    );
  }
  return counters;
}

export async function processIntegrationJob(jobId, actor = "worker") {
  return tx(async (client) => {
    const locked = await client.query(
      `SELECT * FROM integration_jobs
       WHERE id = $1 AND status IN ('PENDENTE', 'ERRO_TEMPORARIO', 'AGUARDANDO_REPROCESSAMENTO')
       FOR UPDATE SKIP LOCKED`,
      [asInt(jobId)]
    );
    const job = locked.rows[0];
    if (!job) return null;
    await client.query(
      `UPDATE integration_jobs
       SET status = 'PROCESSANDO',
           attempts = attempts + 1,
           locked_at = CURRENT_TIMESTAMP,
           locked_by = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [job.id, actor]
    );
    return job;
  }).then(async (job) => {
    if (!job) return null;
    const started = Date.now();
    let result;
    try {
      if (job.job_type === OMIE_JOB_TYPES.PRODUCTS) result = await syncOmieProducts(job.integration_id);
      else if (job.job_type === OMIE_JOB_TYPES.LOCATIONS) result = await syncOmieLocations(job.integration_id);
      else if (job.job_type === OMIE_JOB_TYPES.STOCK) result = await syncOmieStock(job.integration_id);
      else if (job.job_type === OMIE_JOB_TYPES.STOCK_ITEM) result = await syncOmieStockItem(job.integration_id, job.payload || {});
      else if (job.job_type === OMIE_JOB_TYPES.MOVEMENTS) result = await syncOmieMovements(job.integration_id);
      else if (job.job_type === OMIE_JOB_TYPES.RECONCILE) result = await reconcileOmieStock(job.integration_id);
      else if (job.job_type === OMIE_JOB_TYPES.FULL) {
        result = {
          products: await syncOmieProducts(job.integration_id),
          locations: await syncOmieLocations(job.integration_id),
          stock: await syncOmieStock(job.integration_id),
          movements: await syncOmieMovements(job.integration_id),
          reconciliation: await reconcileOmieStock(job.integration_id)
        };
      } else {
        result = { ignored: true, reason: `Job ${job.job_type} sem processador de leitura.` };
      }
      if ([OMIE_JOB_TYPES.MOVEMENTS, OMIE_JOB_TYPES.STOCK, OMIE_JOB_TYPES.RECONCILE].includes(job.job_type)) {
        result = { ...result, temperatures: await classifyProductTemperatures(job.integration_id) };
      }
      const hasAlerts = JSON.stringify(result).includes("\"alerts\":") && !JSON.stringify(result).includes("\"alerts\":0");
      await query(
        `UPDATE integration_jobs
         SET status = $2,
             result = $3::jsonb,
             last_error = NULL,
             completed_at = CURRENT_TIMESTAMP,
             locked_at = NULL,
             locked_by = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [job.id, hasAlerts ? "CONCLUIDO_COM_ALERTAS" : "CONCLUIDO", safeJson(result)]
      );
      await query(
        `INSERT INTO integration_attempts (job_id, integration_id, status, response_summary, finished_at)
         VALUES ($1, $2, $3, $4::jsonb, CURRENT_TIMESTAMP)`,
        [job.id, job.integration_id, hasAlerts ? "CONCLUIDO_COM_ALERTAS" : "CONCLUIDO", safeJson({ elapsedMs: Date.now() - started, result })]
      );
      await updateIntegrationStatus(job.integration_id, hasAlerts ? "CONCLUIDO_COM_ALERTAS" : "INTEGRADO", "", actor);
      publishIntegrationEvent("integration.job.updated", { id: job.id, integration_id: job.integration_id, job_type: job.job_type, status: hasAlerts ? "CONCLUIDO_COM_ALERTAS" : "CONCLUIDO", result });
      publishIntegrationEvent("integration.status.updated", { integration_id: job.integration_id, status: hasAlerts ? "CONCLUIDO_COM_ALERTAS" : "INTEGRADO" });
      return { ...job, status: hasAlerts ? "CONCLUIDO_COM_ALERTAS" : "CONCLUIDO", result };
    } catch (error) {
      const status = errorStatusForJob(error);
      const retryable = ["ERRO_TEMPORARIO"].includes(status);
      await query(
        `UPDATE integration_jobs
         SET status = $2,
             last_error = $3,
             next_run_at = CASE WHEN $4 THEN CURRENT_TIMESTAMP + INTERVAL '5 minutes' ELSE NULL END,
             locked_at = NULL,
             locked_by = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [job.id, retryable ? "ERRO_TEMPORARIO" : status, normalizeText(error?.message, 1000), retryable]
      );
      await query(
        `INSERT INTO integration_attempts (job_id, integration_id, status, error_message, response_summary, finished_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP)`,
        [job.id, job.integration_id, retryable ? "ERRO_TEMPORARIO" : status, normalizeText(error?.message, 1000), safeJson({ elapsedMs: Date.now() - started, code: error?.code })]
      );
      await updateIntegrationStatus(job.integration_id, retryable ? "ERRO_TEMPORARIO" : status, error?.message || "", actor);
      publishIntegrationEvent("integration.job.updated", { id: job.id, integration_id: job.integration_id, job_type: job.job_type, status: retryable ? "ERRO_TEMPORARIO" : status, error: error?.message });
      return { ...job, status: retryable ? "ERRO_TEMPORARIO" : status, error: error?.message };
    }
  });
}

export async function processNextIntegrationJob(actor = "worker") {
  const rows = await query(
    `SELECT id
     FROM integration_jobs
     WHERE status IN ('PENDENTE', 'ERRO_TEMPORARIO', 'AGUARDANDO_REPROCESSAMENTO')
       AND (next_run_at IS NULL OR next_run_at <= CURRENT_TIMESTAMP)
     ORDER BY priority_rank DESC, created_at
     LIMIT 1`
  );
  if (!rows[0]) return null;
  return processIntegrationJob(rows[0].id, actor);
}

import { callOmie } from "./omie.client.js";
import { getOmieConfig, OMIE_LOCAL_STATUSES } from "./omie.config.js";

export const OMIE_MOVEMENT_TYPES = Object.freeze({
  DAMAGE_LOSS: "BAIXA_AVARIA",
  DAMAGE_EXPIRED: "BAIXA_VENCIMENTO",
  DAMAGE_DAMAGED: "BAIXA_DANIFICADO",
  DAMAGE_SPOILED: "BAIXA_ESTRAGADO",
  DAMAGE_REVERSAL: "ESTORNO_AVARIA",
  DAMAGE_COMPLEMENT: "COMPLEMENTO_AVARIA",
  ORDER_RELEASE: "LIBERACAO_PDV"
});

export function movementTypeForDamageReason(reason = "") {
  if (reason === "Produto vencido") return OMIE_MOVEMENT_TYPES.DAMAGE_EXPIRED;
  if (reason === "Produto danificado" || reason === "Embalagem violada" || reason === "Quebra") return OMIE_MOVEMENT_TYPES.DAMAGE_DAMAGED;
  if (reason === "Produto estragado" || reason === "Contaminação" || reason === "Problema de armazenamento") return OMIE_MOVEMENT_TYPES.DAMAGE_SPOILED;
  return OMIE_MOVEMENT_TYPES.DAMAGE_LOSS;
}

export function buildDamageOperationKey({ devolucaoId, itemId, sku, movementType, version }) {
  return `AVARIA-${devolucaoId}-ITEM-${itemId || sku}-${movementType}-V${version}`;
}

export async function createOmieJob(client, {
  operationKey,
  entityType,
  entityId,
  pdvId,
  productSku,
  movementType,
  quantity,
  payload
}) {
  await client.query(
    `INSERT INTO omie_jobs
       (operation_key, entity_type, entity_id, pdv_id, product_sku, movement_type, quantity, payload, status, last_error)
     VALUES ($1, $2, $3, NULLIF($4, 0), $5, $6, $7, $8::jsonb, 'PENDING', NULL)
     ON CONFLICT (operation_key) DO NOTHING`,
    [
      operationKey,
      entityType,
      entityId,
      pdvId || 0,
      productSku,
      movementType,
      quantity,
      JSON.stringify(payload || {})
    ]
  );
}

export async function processNextOmieJob(client, { fetchImpl = fetch, env = process.env } = {}) {
  const config = getOmieConfig(env);
  const jobResult = await client.query(
    `SELECT *
     FROM omie_jobs
     WHERE status IN ('PENDING', 'RETRY_REQUIRED')
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1`
  );
  const job = jobResult.rows[0];
  if (!job) return null;

  if (!config.configured) {
    await client.query(
      `UPDATE omie_jobs
       SET status = 'RETRY_REQUIRED',
           attempts = attempts + 1,
           last_error = 'Integração OMIE não configurada.',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [job.id]
    );
    return { ...job, status: "RETRY_REQUIRED", skipped: true };
  }

  await client.query(
    `UPDATE omie_jobs
     SET status = 'PROCESSING',
         attempts = attempts + 1,
         processing_started_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [job.id]
  );

  try {
    const payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
    const response = await callOmie("/estoque/movimentacoes/", {
      call: "IncluirMovimentoEstoque",
      param: [payload]
    }, { fetchImpl, env });
    const externalId = response.data?.codigo_movimento || response.data?.nCodMovEstoque || response.data?.id || job.operation_key;
    await client.query(
      `UPDATE omie_jobs
       SET status = 'SUCCESS',
           external_id = $2,
           response_summary = $3::jsonb,
           last_error = NULL,
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [job.id, String(externalId), JSON.stringify({ elapsedMs: response.elapsedMs, externalId })]
    );
    await updateEntityOmieStatus(client, job, OMIE_LOCAL_STATUSES.SUCCESS, String(externalId), null);
    return { ...job, status: "SUCCESS", external_id: String(externalId) };
  } catch (error) {
    const status = error.retryable ? "RETRY_REQUIRED" : "FAILED";
    await client.query(
      `UPDATE omie_jobs
       SET status = $2,
           last_error = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [job.id, status, error.message || "Falha na integração OMIE."]
    );
    await updateEntityOmieStatus(client, job, OMIE_LOCAL_STATUSES.FAILED, null, error.message || "Falha na integração OMIE.");
    return { ...job, status, last_error: error.message };
  }
}

async function updateEntityOmieStatus(client, job, status, externalId, errorMessage) {
  if (job.entity_type !== "AVARIA") return;
  await client.query(
    `UPDATE devolucoes_avaria
     SET omie_status = $2,
         omie_request_id = COALESCE($3, omie_request_id),
         omie_error = $4,
         omie_attempts = COALESCE(omie_attempts, 0) + 1,
         atualizado_em = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [job.entity_id, status, externalId, errorMessage]
  );
}

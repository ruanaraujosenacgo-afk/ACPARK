import { query, tx, asInt } from "../../db.js";
import { normalizeText } from "../../utils/http.js";
import { decryptSecret, encryptSecret, maskSecret, sanitizeIntegration } from "./integration.security.js";

export const INTEGRATION_STATUSES = Object.freeze({
  PENDING: "PENDENTE",
  VALIDATING: "VALIDANDO",
  WAITING_OMIE: "AGUARDANDO_OMIE",
  INTEGRATED: "INTEGRADO",
  TEMPORARY_ERROR: "ERRO_TEMPORARIO",
  CONFIG_ERROR: "ERRO_DE_CONFIGURACAO",
  WAITING_FIX: "AGUARDANDO_CORRECAO",
  REVERSED: "ESTORNADO",
  CANCELLED: "CANCELADO"
});

const SECRET_FIELDS = ["app_key", "app_secret", "token", "webhook_secret"];
const PRIORITY_RANK = Object.freeze({ BAIXA: 10, NORMAL: 50, ALTA: 80, CRITICA: 100 });

function normalizeProvider(value) {
  const provider = normalizeText(value, 40).toUpperCase();
  return provider === "OMIE" ? "OMIE" : "OUTRA";
}

function normalizeType(provider, value) {
  const type = normalizeText(value, 80).toUpperCase();
  if (provider === "OMIE") return "ERP_ESTOQUE";
  return type || "PERSONALIZADA";
}

export async function listIntegrations() {
  const integrations = await query("SELECT * FROM integrations ORDER BY ativo DESC, nome");
  if (!integrations.length) return [];
  const ids = integrations.map((item) => item.id);
  const credentials = await query(
    "SELECT integration_id, credential_key, masked_value FROM integration_credentials WHERE integration_id = ANY($1::bigint[]) ORDER BY credential_key",
    [ids]
  );
  const byIntegration = new Map();
  for (const credential of credentials) {
    const list = byIntegration.get(String(credential.integration_id)) || [];
    list.push(credential);
    byIntegration.set(String(credential.integration_id), list);
  }
  return integrations.map((item) => sanitizeIntegration(item, byIntegration.get(String(item.id)) || []));
}

export async function getIntegration(id) {
  const rows = await query("SELECT * FROM integrations WHERE id = $1", [asInt(id)]);
  const row = rows[0];
  if (!row) return null;
  const credentials = await query(
    "SELECT credential_key, masked_value FROM integration_credentials WHERE integration_id = $1 ORDER BY credential_key",
    [row.id]
  );
  return sanitizeIntegration(row, credentials);
}

export async function getIntegrationSecrets(id) {
  const rows = await query("SELECT * FROM integrations WHERE id = $1", [asInt(id)]);
  const integration = rows[0];
  if (!integration) return null;
  const credentials = await query(
    "SELECT credential_key, encrypted_value FROM integration_credentials WHERE integration_id = $1",
    [integration.id]
  );
  const secrets = {};
  for (const credential of credentials) {
    secrets[credential.credential_key] = decryptSecret(credential.encrypted_value);
  }
  return { integration, secrets };
}

export async function saveIntegration(input, actor = "") {
  return tx(async (client) => {
    const id = asInt(input.id);
    const provider = normalizeProvider(input.provedor);
    const payload = {
      nome: normalizeText(input.nome, 120) || (provider === "OMIE" ? "OMIE" : "Integração personalizada"),
      provedor: provider,
      tipo: normalizeType(provider, input.tipo),
      ambiente: normalizeText(input.ambiente, 40).toUpperCase() || "PRODUCAO",
      url_base: normalizeText(input.url_base, 300) || (provider === "OMIE" ? "https://app.omie.com.br/api/v1" : ""),
      empresa_vinculada: normalizeText(input.empresa_vinculada, 160),
      ativo: input.ativo !== false && input.ativo !== "false",
      status: normalizeText(input.status, 40).toUpperCase() || INTEGRATION_STATUSES.PENDING,
      sync_intervals: input.sync_intervals && typeof input.sync_intervals === "object" ? input.sync_intervals : {}
    };

    const result = id
      ? await client.query(
          `UPDATE integrations
           SET nome = $2,
               provedor = $3,
               tipo = $4,
               ambiente = $5,
               url_base = $6,
               empresa_vinculada = $7,
               ativo = $8,
               status = $9,
               sync_intervals = $10::jsonb,
               updated_at = CURRENT_TIMESTAMP,
               updated_by = $11
           WHERE id = $1
           RETURNING *`,
          [id, payload.nome, payload.provedor, payload.tipo, payload.ambiente, payload.url_base, payload.empresa_vinculada, payload.ativo, payload.status, JSON.stringify(payload.sync_intervals), actor]
        )
      : await client.query(
          `INSERT INTO integrations
             (nome, provedor, tipo, ambiente, url_base, empresa_vinculada, ativo, status, sync_intervals, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)
           RETURNING *`,
          [payload.nome, payload.provedor, payload.tipo, payload.ambiente, payload.url_base, payload.empresa_vinculada, payload.ativo, payload.status, JSON.stringify(payload.sync_intervals), actor]
        );
    const integration = result.rows[0];
    if (!integration) {
      const error = new Error("Integração não encontrada.");
      error.statusCode = 404;
      throw error;
    }

    for (const key of SECRET_FIELDS) {
      const value = input[key];
      if (value === undefined || value === null || String(value) === "") continue;
      await client.query(
        `INSERT INTO integration_credentials
           (integration_id, credential_key, encrypted_value, masked_value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (integration_id, credential_key)
         DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
                       masked_value = EXCLUDED.masked_value,
                       updated_at = CURRENT_TIMESTAMP`,
        [integration.id, key, encryptSecret(value), maskSecret(value)]
      );
    }

    await client.query(
      `INSERT INTO integration_audit_logs (integration_id, action, actor, details)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [integration.id, id ? "INTEGRATION_UPDATED" : "INTEGRATION_CREATED", actor, JSON.stringify({ provedor: integration.provedor, tipo: integration.tipo, segredos: SECRET_FIELDS.filter((key) => input[key]) })]
    );

    return integration;
  });
}

export async function updateIntegrationStatus(id, status, errorMessage = "", actor = "sistema") {
  const rows = await query(
    `UPDATE integrations
     SET status = $2,
         last_error = $3,
         updated_at = CURRENT_TIMESTAMP,
         updated_by = $4
     WHERE id = $1
     RETURNING *`,
    [asInt(id), status, normalizeText(errorMessage, 1000), actor]
  );
  return rows[0] || null;
}

export function normalizePriority(value = "NORMAL") {
  const priority = normalizeText(value, 20).toUpperCase();
  return PRIORITY_RANK[priority] ? priority : "NORMAL";
}

export async function enqueueIntegrationJob({ integrationId, jobType, payload = {}, idempotencyKey = "", priority = "NORMAL" }) {
  const normalizedPriority = normalizePriority(priority);
  const active = await query(
    `SELECT id, status
     FROM integration_jobs
     WHERE integration_id = $1
       AND job_type = $2
       AND status IN ('PENDENTE', 'PROCESSANDO', 'ERRO_TEMPORARIO', 'AGUARDANDO_REPROCESSAMENTO')
     ORDER BY created_at DESC
     LIMIT 1`,
    [asInt(integrationId), normalizeText(jobType, 80).toUpperCase()]
  );
  if (active[0]) return active[0];
  const rows = await query(
    `INSERT INTO integration_jobs
       (integration_id, job_type, payload, idempotency_key, priority, priority_rank)
     VALUES ($1, $2, $3::jsonb, NULLIF($4, ''), $5, $6)
     ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = integration_jobs.updated_at
     RETURNING *`,
    [asInt(integrationId), normalizeText(jobType, 80).toUpperCase(), JSON.stringify(payload), normalizeText(idempotencyKey, 180), normalizedPriority, PRIORITY_RANK[normalizedPriority]]
  );
  return rows[0];
}

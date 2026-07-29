import { query, tx } from "../../db.js";
import { normalizeText, readBody, send } from "../../utils/http.js";
import { handleIntegrationEvents, publishIntegrationEvent } from "../../services/integrations/integration.events.js";
import { decryptSecret, encryptSecret, maskSecret, sanitizeIntegration } from "../../services/integrations/integration.security.js";
import { normalizePriority } from "../../services/integrations/integration.service.js";
import { normalizeSyncScope, enqueueIntegrationJob, processIntegrationJobById, processNextIntegrationJob } from "../../services/integrations/omie/omie.sync.js";

function requireAdmin(req, res, context) {
  return context.requireUser(req, res, "admin");
}

export async function handleIntegrationWebhookRoutes(req, res) {
  return false;
}

export async function handleIntegrationsRoutes(req, res, context) {
  const { method, url } = context;

  if (url.pathname === "/api/admin/integrations/events") {
    if (!requireAdmin(req, res, context)) return true;
    handleIntegrationEvents(req, res);
    return true;
  }

  if (url.pathname === "/api/admin/integrations/health") {
    if (!requireAdmin(req, res, context)) return true;
    const runtime = await query("SELECT * FROM integration_runtime_state ORDER BY updated_at DESC LIMIT 20").catch(() => []);
    return send(res, 200, { ok: true, runtime }), true;
  }

  if (url.pathname === "/api/admin/integrations" && method === "GET") {
    if (!requireAdmin(req, res, context)) return true;
    const integrations = await query("SELECT * FROM integrations ORDER BY provedor, nome");
    const credentials = await query("SELECT integration_id, credential_key, masked_value, encrypted_value FROM integration_credentials");
    return send(res, 200, {
      integrations: integrations.map((integration) => sanitizeIntegration(
        integration,
        credentials.filter((credential) => credential.integration_id === integration.id)
      ))
    }), true;
  }

  if (url.pathname === "/api/admin/integrations" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const result = await tx(async (client) => {
      const values = {
        id: Number(body.id || 0),
        nome: normalizeText(body.nome || "OMIE", 120),
        provedor: normalizeText(body.provedor || "OMIE", 40),
        tipo: normalizeText(body.tipo || "ERP_ESTOQUE", 40),
        ambiente: normalizeText(body.ambiente || "PRODUCAO", 40),
        urlBase: normalizeText(body.url_base || "https://app.omie.com.br/api/v1", 255),
        empresaVinculada: normalizeText(body.empresa_vinculada || "", 160) || null,
        ativo: body.ativo !== false,
        stockMode: normalizeText(body.stock_mode || "MANUAL", 30)
      };
      const existing = values.id
        ? await client.query("SELECT id FROM integrations WHERE id = $1 LIMIT 1", [values.id])
        : await client.query(
          "SELECT id FROM integrations WHERE provedor = $1 AND ambiente = $2 ORDER BY id LIMIT 1",
          [values.provedor, values.ambiente]
        );
      const integration = existing.rows[0]
        ? await client.query(
          `UPDATE integrations
           SET nome = $2,
               provedor = $3,
               tipo = $4,
               ambiente = $5,
               url_base = $6,
               empresa_vinculada = $7,
               ativo = $8,
               stock_mode = $9,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING *`,
          [
            existing.rows[0].id,
            values.nome,
            values.provedor,
            values.tipo,
            values.ambiente,
            values.urlBase,
            values.empresaVinculada,
            values.ativo,
            values.stockMode
          ]
        )
        : await client.query(
          `INSERT INTO integrations (nome, provedor, tipo, ambiente, url_base, empresa_vinculada, ativo, status, stock_mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDENTE', $8)
           RETURNING *`,
          [
            values.nome,
            values.provedor,
            values.tipo,
            values.ambiente,
            values.urlBase,
            values.empresaVinculada,
            values.ativo,
            values.stockMode
          ]
        );
      const row = integration.rows[0];
      for (const key of ["app_key", "app_secret"]) {
        if (body[key]) {
          const credential = await client.query(
            "SELECT id FROM integration_credentials WHERE integration_id = $1 AND credential_key = $2 ORDER BY id LIMIT 1",
            [row.id, key]
          );
          if (credential.rows[0]) {
            await client.query(
              `UPDATE integration_credentials
               SET encrypted_value = $2,
                   masked_value = $3,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [credential.rows[0].id, encryptSecret(body[key]), maskSecret(body[key])]
            );
          } else {
            await client.query(
              `INSERT INTO integration_credentials (integration_id, credential_key, encrypted_value, masked_value)
               VALUES ($1, $2, $3, $4)`,
              [row.id, key, encryptSecret(body[key]), maskSecret(body[key])]
            );
          }
        }
      }
      return row;
    });
    publishIntegrationEvent("integration.updated", { id: result.id });
    return send(res, 200, { ok: true, integration: sanitizeIntegration(result) }), true;
  }

  if (url.pathname === "/api/admin/integrations/test" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    if (!id) return send(res, 400, { error: "Integração inválida." }), true;
    const integrationRows = await query("SELECT * FROM integrations WHERE id = $1", [id]);
    const integration = integrationRows[0];
    if (!integration) return send(res, 404, { error: "Integração não encontrada." }), true;
    const credentialRows = await query(
      "SELECT credential_key, encrypted_value FROM integration_credentials WHERE integration_id = $1",
      [id]
    );
    const secrets = Object.fromEntries(credentialRows.map((row) => [
      row.credential_key,
      decryptSecret(row.encrypted_value)
    ]));
    if (!secrets.app_key || !secrets.app_secret) {
      return send(res, 400, { error: "Configure App key e App secret antes de testar." }), true;
    }
    await query(
      `UPDATE integrations
       SET status = 'CREDENCIAIS_CONFIGURADAS',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id]
    );
    return send(res, 200, {
      ok: true,
      status: "CREDENCIAIS_CONFIGURADAS",
      message: "Credenciais configuradas. A sincronização real será executada pela fila OMIE."
    }), true;
  }

  if (url.pathname === "/api/admin/integrations/jobs") {
    if (!requireAdmin(req, res, context)) return true;
    const jobs = await query(
      `SELECT * FROM integration_jobs
       ORDER BY priority_rank DESC, created_at DESC
       LIMIT 200`
    ).catch(() => []);
    return send(res, 200, { jobs }), true;
  }

  if (url.pathname === "/api/admin/integrations/sync" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    if (!id) return send(res, 400, { error: "Integração inválida." }), true;
    const job = await tx((client) => enqueueIntegrationJob(client, {
      integrationId: id,
      jobType: normalizeSyncScope(body.escopo || body.scope),
      priority: normalizePriority(body.priority || "ALTA")
    }));
    publishIntegrationEvent("job.created", { id: job.id });
    return send(res, 200, { ok: true, job }), true;
  }

  if (url.pathname === "/api/admin/integrations/jobs/process-next" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const job = await tx((client) => processNextIntegrationJob(client));
    return send(res, 200, { ok: true, job }), true;
  }

  if (url.pathname === "/api/admin/integrations/jobs/process" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    if (!id) return send(res, 400, { error: "Job inválido." }), true;
    const job = await tx((client) => processIntegrationJobById(client, id));
    if (!job) return send(res, 404, { error: "Job não encontrado ou já processado." }), true;
    publishIntegrationEvent("job.updated", { id: job.id, status: job.status });
    return send(res, 200, { ok: true, job }), true;
  }

  if (url.pathname === "/api/admin/integrations/location-mappings") {
    if (!requireAdmin(req, res, context)) return true;
    if (method === "GET") {
      const mappings = await query(
        `SELECT m.*, p.nome AS pdv_nome
         FROM pdv_stock_location_mappings m
         LEFT JOIN pdvs p ON p.id = m.pdv_acpark_id
         ORDER BY p.nome`
      ).catch(() => []);
      return send(res, 200, { mappings }), true;
    }
    if (method === "POST") {
      const body = await readBody(req);
      await query(
        `INSERT INTO pdv_stock_location_mappings (integration_id, pdv_acpark_id, omie_location_id, omie_location_name, active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (integration_id, pdv_acpark_id) DO UPDATE
         SET omie_location_id = EXCLUDED.omie_location_id,
             omie_location_name = EXCLUDED.omie_location_name,
             active = TRUE,
             updated_at = CURRENT_TIMESTAMP`,
        [
          Number(body.integration_id || body.id),
          Number(body.pdv_id || body.pdv_acpark_id),
          normalizeText(body.omie_location_id, 80),
          normalizeText(body.omie_location_name || "", 120)
        ]
      );
      return send(res, 200, { ok: true }), true;
    }
  }

  if (url.pathname === "/api/admin/integrations/reconciliations") {
    if (!requireAdmin(req, res, context)) return true;
    const divergences = await query(
      `SELECT * FROM stock_reconciliation_items
       ORDER BY created_at DESC
       LIMIT 200`
    ).catch(() => []);
    return send(res, 200, { divergences }), true;
  }

  return false;
}

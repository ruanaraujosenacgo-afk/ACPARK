import { asInt, query } from "../../db.js";
import { normalizeText, readBody, send } from "../../utils/http.js";
import {
  enqueueIntegrationJob,
  getIntegration,
  getIntegrationSecrets,
  listIntegrations,
  saveIntegration,
  updateIntegrationStatus
} from "../../services/integrations/integration.service.js";
import { normalizeSyncScope, processIntegrationJob, processNextIntegrationJob, testOmieConnection } from "../../services/integrations/omie/omie.sync.js";
import { handleIntegrationEvents } from "../../services/integrations/integration.events.js";
import { runOmieSchedulerTick } from "../../services/integrations/omie/omie.scheduler.js";

export async function handleIntegrationWebhookRoutes(req, res, context) {
  const { method, url } = context;
  if (url.pathname !== "/api/webhooks/omie" || method !== "POST") return false;

  const integrationId = asInt(url.searchParams.get("integrationId"));
  const receivedSecret = normalizeText(req.headers["x-acpark-webhook-secret"] || url.searchParams.get("secret"), 500);
  const loaded = await getIntegrationSecrets(integrationId);
  if (!loaded || loaded.integration.provedor !== "OMIE" || !loaded.integration.ativo) {
    return send(res, 404, { error: "Integracao nao encontrada." }), true;
  }
  const expectedSecret = normalizeText(loaded.secrets.webhook_secret, 500);
  const valid = Boolean(expectedSecret && receivedSecret && expectedSecret === receivedSecret);
  const body = await readBody(req);
  const eventType = normalizeText(body.evento || body.event_type || body.tipo || "OMIE_EVENT", 120);
  const inserted = await query(
    `INSERT INTO integration_webhooks
       (integration_id, provider, event_type, signature_valid, raw_payload, headers, status, processing_error)
     VALUES ($1, 'OMIE', $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     RETURNING id`,
    [
      loaded.integration.id,
      eventType,
      valid,
      JSON.stringify(body || {}),
      JSON.stringify({
        "user-agent": req.headers["user-agent"] || "",
        "x-forwarded-for": req.headers["x-forwarded-for"] || ""
      }),
      valid ? "RECEBIDO" : "RECUSADO",
      valid ? null : "Webhook secret invalido."
    ]
  );
  if (!valid) return send(res, 401, { error: "Webhook invalido." }), true;

  await enqueueIntegrationJob({
    integrationId: loaded.integration.id,
    jobType: "WEBHOOK_OMIE",
    payload: { webhook_id: inserted[0].id, event_type: eventType },
    idempotencyKey: `OMIE-WEBHOOK-${inserted[0].id}`
  });
  return send(res, 202, { ok: true }), true;
}

export async function handleIntegrationsRoutes(req, res, context) {
  const { method, requireUser, url, user } = context;

  if (url.pathname === "/api/admin/integrations/events" && method === "GET") {
    if (!requireUser(req, res, "admin")) return true;
    handleIntegrationEvents(req, res);
    return true;
  }

  if (url.pathname === "/api/admin/integrations") {
    if (!requireUser(req, res, "admin")) return true;
    if (method === "GET") return send(res, 200, { integrations: await listIntegrations() }), true;
    if (method === "POST") {
      const body = await readBody(req);
      const saved = await saveIntegration(body, user.name || "admin");
      return send(res, 200, { integration: await getIntegration(saved.id) }), true;
    }
  }

  if (url.pathname === "/api/admin/integrations/test" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const body = await readBody(req);
    const loaded = await getIntegrationSecrets(body.id);
    if (!loaded) return send(res, 404, { error: "Integracao nao encontrada." }), true;
    const result = await testOmieConnection(loaded.integration.id, user.name || "admin");
    return send(res, result.status === "CONECTADO" ? 200 : 400, { ok: result.status === "CONECTADO", ...result }), true;
  }

  if (url.pathname === "/api/admin/integrations/sync" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const body = await readBody(req);
    const integration = await getIntegration(body.id);
    if (!integration) return send(res, 404, { error: "Integracao nao encontrada." }), true;
    const jobType = normalizeSyncScope(body.escopo || body.scope || body.job_type);
    const job = await enqueueIntegrationJob({
      integrationId: integration.id,
      jobType,
      payload: { origem: "admin", escopo: jobType },
      idempotencyKey: `${jobType}-${integration.id}-${Date.now()}`
    });
    await updateIntegrationStatus(integration.id, "AGUARDANDO_OMIE", "", user.name || "admin");
    return send(res, 202, { ok: true, job }), true;
  }

  if (url.pathname === "/api/admin/integrations/jobs" && method === "GET") {
    if (!requireUser(req, res, "admin")) return true;
    const integrationId = asInt(url.searchParams.get("integrationId"));
    const rows = await query(
      `SELECT j.id, j.integration_id, i.nome AS integration_name, j.job_type, j.status, j.attempts,
              j.current_page, j.cursor, j.last_external_id, j.last_processed_at,
              j.next_run_at, j.last_error, j.result, j.created_at, j.updated_at, j.completed_at
       FROM integration_jobs j
       LEFT JOIN integrations i ON i.id = j.integration_id
       WHERE ($1::bigint = 0 OR j.integration_id = $1)
       ORDER BY j.created_at DESC
       LIMIT 300`,
      [integrationId]
    );
    return send(res, 200, { jobs: rows }), true;
  }

  if (url.pathname === "/api/admin/integrations/jobs/process-next" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const result = await processNextIntegrationJob(user.name || "admin");
    return send(res, 200, { ok: true, job: result }), true;
  }

  if (url.pathname === "/api/admin/integrations/scheduler/tick" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const result = await runOmieSchedulerTick({ actor: user.name || "admin" });
    return send(res, 200, { ok: true, ...result }), true;
  }

  if (url.pathname === "/api/admin/integrations/health") {
    if (!requireUser(req, res, "admin")) return true;
    const integrationId = asInt(url.searchParams.get("integrationId"));
    const [summary] = await query(
      `SELECT
         COUNT(*) FILTER (WHERE j.status IN ('PENDENTE', 'PROCESSANDO', 'ERRO_TEMPORARIO'))::int AS jobs_pendentes,
         COUNT(*) FILTER (WHERE j.status LIKE 'ERRO%')::int AS jobs_com_erro
       FROM integration_jobs j
       WHERE ($1::bigint = 0 OR j.integration_id = $1)`,
      [integrationId]
    );
    const metrics = await query(
      `SELECT metric_name, AVG(metric_value)::numeric(12,2) AS media, MAX(metric_value)::numeric(12,2) AS maximo, COUNT(*)::int AS total
       FROM integration_metrics
       WHERE ($1::bigint = 0 OR integration_id = $1)
         AND recorded_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour'
       GROUP BY metric_name
       ORDER BY metric_name`,
      [integrationId]
    );
    const runtime = await query(
      `SELECT r.*, i.nome
       FROM integration_runtime_state r
       JOIN integrations i ON i.id = r.integration_id
       WHERE ($1::bigint = 0 OR r.integration_id = $1)
       ORDER BY i.nome`,
      [integrationId]
    );
    const stale = await query(
      `SELECT COUNT(*)::int AS total
       FROM estoque_pdv
       WHERE ultima_sincronizacao IS NOT NULL
         AND ultima_sincronizacao < CURRENT_TIMESTAMP - INTERVAL '5 minutes'`
    );
    return send(res, 200, { summary: summary || {}, metrics, runtime, stale_stock_items: stale[0]?.total || 0 }), true;
  }

  if (url.pathname === "/api/admin/integrations/jobs/process" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const body = await readBody(req);
    const result = await processIntegrationJob(body.id, user.name || "admin");
    return send(res, 200, { ok: true, job: result }), true;
  }

  if (url.pathname === "/api/admin/integrations/locations") {
    if (!requireUser(req, res, "admin")) return true;
    const integrationId = asInt(url.searchParams.get("integrationId"));
    const rows = await query(
      `SELECT id, integration_id, omie_location_id, code, name, description, active, company, synced_at
       FROM omie_stock_locations
       WHERE ($1::bigint = 0 OR integration_id = $1)
       ORDER BY active DESC, name`,
      [integrationId]
    );
    return send(res, 200, { locations: rows }), true;
  }

  if (url.pathname === "/api/admin/integrations/location-mappings") {
    if (!requireUser(req, res, "admin")) return true;
    if (method === "GET") {
      const rows = await query(
        `SELECT m.*, p.nome AS pdv_nome
         FROM pdv_stock_location_mappings m
         JOIN pdvs p ON p.id = m.pdv_acpark_id
         ORDER BY p.nome`
      );
      return send(res, 200, { mappings: rows }), true;
    }
    if (method === "POST") {
      const body = await readBody(req);
      const location = await query(
        `SELECT omie_location_id, name, active
         FROM omie_stock_locations
         WHERE integration_id = $1 AND omie_location_id = $2
         LIMIT 1`,
        [asInt(body.integration_id), normalizeText(body.omie_location_id, 80)]
      );
      if (!location[0] || !location[0].active) return send(res, 400, { error: "Local OMIE invalido ou inativo." }), true;
      const saved = await query(
        `INSERT INTO pdv_stock_location_mappings
           (pdv_acpark_id, integration_id, omie_location_id, omie_location_name, active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (pdv_acpark_id, integration_id, omie_location_id)
         DO UPDATE SET omie_location_name = EXCLUDED.omie_location_name,
                       active = TRUE,
                       updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [asInt(body.pdv_acpark_id), asInt(body.integration_id), location[0].omie_location_id, location[0].name]
      );
      await query(
        `INSERT INTO integration_audit_logs (integration_id, action, actor, details)
         VALUES ($1, 'PDV_LOCATION_MAPPING_UPDATED', $2, $3::jsonb)`,
        [asInt(body.integration_id), user.name || "admin", JSON.stringify({ pdv_acpark_id: asInt(body.pdv_acpark_id), omie_location_id: location[0].omie_location_id })]
      );
      return send(res, 200, { mapping: saved[0] }), true;
    }
  }

  if (url.pathname === "/api/admin/integrations/reconciliations") {
    if (!requireUser(req, res, "admin")) return true;
    const integrationId = asInt(url.searchParams.get("integrationId"));
    const rows = await query(
      `SELECT ri.*, p.nome AS produto_nome, pdv.nome AS pdv_nome
       FROM stock_reconciliation_items ri
       LEFT JOIN produtos p ON p.sku = ri.sku_produto
       LEFT JOIN pdvs pdv ON pdv.id = ri.pdv_id
       WHERE ($1::bigint = 0 OR ri.integration_id = $1)
       ORDER BY ri.created_at DESC
       LIMIT 300`,
      [integrationId]
    );
    return send(res, 200, { divergences: rows }), true;
  }

  if (url.pathname === "/api/admin/integrations/reconciliations/review" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const body = await readBody(req);
    const rows = await query(
      `UPDATE stock_reconciliation_items
       SET status = 'REVISADO',
           reviewed_by = $2,
           reviewed_at = CURRENT_TIMESTAMP,
           note = $3
       WHERE id = $1
       RETURNING *`,
      [asInt(body.id), user.name || "admin", normalizeText(body.note, 500)]
    );
    return send(res, 200, { divergence: rows[0] || null }), true;
  }

  if (url.pathname === "/api/admin/integrations/audit") {
    if (!requireUser(req, res, "admin")) return true;
    const integrationId = asInt(url.searchParams.get("integrationId"));
    const rows = await query(
      `SELECT id, integration_id, action, actor, details, created_at
       FROM integration_audit_logs
       WHERE ($1::bigint = 0 OR integration_id = $1)
       ORDER BY created_at DESC
       LIMIT 300`,
      [integrationId]
    );
    return send(res, 200, { audit: rows }), true;
  }

  return false;
}

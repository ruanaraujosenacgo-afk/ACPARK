import { randomUUID } from "node:crypto";
import { query } from "../../../db.js";
import { getIntegrationSecrets } from "../integration.service.js";
import { OmieIntegrationError } from "./omie.errors.js";

const DEFAULT_BASE_URL = "https://app.omie.com.br/api/v1";
const DEFAULT_TIMEOUT_MS = 15000;

function cleanBaseUrl(url) {
  return String(url || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function sanitizeEndpoint(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value.startsWith("/")) return `/${value}`;
  return value;
}

function detectBodyError(data) {
  if (!data || typeof data !== "object") return null;
  const message = data.faultstring || data.message || data.error || data.descricao || data.description;
  const code = data.faultcode || data.code || data.codigo;
  if (!message && !code) return null;
  const text = String(message || code);
  const auth = /app_key|app_secret|credenc|acesso|permission|permiss/i.test(text);
  return new OmieIntegrationError(auth ? "Credenciais OMIE invalidas." : text, {
    code: auth ? "OMIE_AUTH_ERROR" : "OMIE_BODY_ERROR",
    category: auth ? "AUTH" : "DATA",
    status: auth ? 401 : 422,
    retryable: false,
    response: data
  });
}

async function beforeOmieRequest(integrationId) {
  const rows = await query(
    `INSERT INTO integration_runtime_state (integration_id)
     VALUES ($1)
     ON CONFLICT (integration_id) DO UPDATE SET updated_at = integration_runtime_state.updated_at
     RETURNING *`,
    [integrationId]
  );
  const state = rows[0] || {};
  if (state.circuit_state === "OPEN" && state.half_open_after && new Date(state.half_open_after).getTime() > Date.now()) {
    throw new OmieIntegrationError("Circuito OMIE aberto. Aguardando recuperacao controlada.", {
      code: "OMIE_CIRCUIT_OPEN",
      category: "TEMPORARY",
      status: 503,
      retryable: true
    });
  }
  const minimumIntervalMs = Number(state.minimum_interval_ms || 500);
  if (state.last_request_at) {
    const elapsed = Date.now() - new Date(state.last_request_at).getTime();
    if (elapsed < minimumIntervalMs) await new Promise((resolve) => setTimeout(resolve, minimumIntervalMs - elapsed));
  }
  const windowStart = state.request_window_start ? new Date(state.request_window_start).getTime() : 0;
  const sameWindow = Date.now() - windowStart < 1000;
  const maxRps = Number(state.max_requests_per_second || 2);
  if (sameWindow && Number(state.request_count || 0) >= maxRps) {
    throw new OmieIntegrationError("Limite conservador de requisicoes OMIE excedido.", {
      code: "OMIE_LOCAL_RATE_LIMIT",
      category: "TEMPORARY",
      status: 429,
      retryable: true
    });
  }
  await query(
    `UPDATE integration_runtime_state
     SET circuit_state = CASE WHEN circuit_state = 'OPEN' THEN 'HALF_OPEN' ELSE circuit_state END,
         request_window_start = CASE WHEN $2 THEN request_window_start ELSE CURRENT_TIMESTAMP END,
         request_count = CASE WHEN $2 THEN request_count + 1 ELSE 1 END,
         last_request_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE integration_id = $1`,
    [integrationId, sameWindow]
  );
}

async function afterOmieRequest(integrationId, outcome, elapsedMs, error = null) {
  await query(
    `INSERT INTO integration_metrics (integration_id, metric_name, metric_value, labels)
     VALUES ($1, 'omie_request_duration_ms', $2, $3::jsonb)`,
    [integrationId, elapsedMs, JSON.stringify({ outcome, code: error?.code || "" })]
  );
  if (outcome === "success") {
    await query(
      `UPDATE integration_runtime_state
       SET circuit_state = 'CLOSED',
           consecutive_failures = 0,
           opened_at = NULL,
           half_open_after = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE integration_id = $1`,
      [integrationId]
    );
    return;
  }
  await query(
    `UPDATE integration_runtime_state
     SET consecutive_failures = consecutive_failures + 1,
         circuit_state = CASE WHEN consecutive_failures + 1 >= 5 THEN 'OPEN' ELSE circuit_state END,
         opened_at = CASE WHEN consecutive_failures + 1 >= 5 THEN CURRENT_TIMESTAMP ELSE opened_at END,
         half_open_after = CASE WHEN consecutive_failures + 1 >= 5 THEN CURRENT_TIMESTAMP + INTERVAL '1 minute' ELSE half_open_after END,
         updated_at = CURRENT_TIMESTAMP
     WHERE integration_id = $1`,
    [integrationId]
  );
}

export function buildOmiePayload({ call, params, appKey, appSecret }) {
  const param = Array.isArray(params) ? params : [params || {}];
  return { call, app_key: appKey, app_secret: appSecret, param };
}

export async function omieRequest({
  integrationId,
  endpoint,
  call,
  params,
  requestId = randomUUID(),
  fetchImpl = fetch,
  signal
}) {
  const loaded = await getIntegrationSecrets(integrationId);
  if (!loaded) {
    throw new OmieIntegrationError("Integracao OMIE nao encontrada.", { code: "OMIE_INTEGRATION_MISSING", category: "CONFIG", status: 404 });
  }
  return omieRequestWithConfig({ loaded, endpoint, call, params, requestId, fetchImpl, signal, runtime: true });
}

export async function omieRequestWithConfig({
  loaded,
  endpoint,
  call,
  params,
  requestId = randomUUID(),
  fetchImpl = fetch,
  signal,
  runtime = false
}) {
  const { integration, secrets } = loaded;
  if (!integration.ativo) {
    throw new OmieIntegrationError("Integracao OMIE inativa.", { code: "OMIE_INTEGRATION_INACTIVE", category: "CONFIG", status: 409 });
  }
  if (integration.provedor !== "OMIE") {
    throw new OmieIntegrationError("Integracao nao e do provedor OMIE.", { code: "OMIE_PROVIDER_INVALID", category: "CONFIG", status: 400 });
  }
  if (!secrets.app_key || !secrets.app_secret) {
    throw new OmieIntegrationError("Credenciais OMIE ausentes.", { code: "OMIE_SECRET_MISSING", category: "AUTH", status: 401 });
  }

  const timeoutMs = Number(process.env.OMIE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const controller = signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const started = Date.now();
  const url = `${cleanBaseUrl(integration.url_base)}${sanitizeEndpoint(endpoint)}`;
  try {
    if (runtime) await beforeOmieRequest(integration.id);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ACPARK-OMIE-SYNC/1.0",
        "X-Request-ID": requestId
      },
      body: JSON.stringify(buildOmiePayload({ call, params, appKey: secrets.app_key, appSecret: secrets.app_secret })),
      signal: signal || controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new OmieIntegrationError(data.faultstring || data.message || "Falha na comunicacao com o OMIE.", {
        code: retryable ? "OMIE_TEMPORARY_HTTP_ERROR" : "OMIE_HTTP_ERROR",
        category: retryable ? "TEMPORARY" : "DATA",
        status: response.status,
        retryable,
        response: data
      });
    }
    const bodyError = detectBodyError(data);
    if (bodyError) throw bodyError;
    if (runtime) await afterOmieRequest(integration.id, "success", Date.now() - started);
    return {
      data,
      elapsedMs: Date.now() - started,
      requestId,
      endpoint,
      call
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const wrapped = new OmieIntegrationError("Tempo limite ao comunicar com o OMIE.", {
        code: "OMIE_TIMEOUT",
        category: "TIMEOUT",
        status: 408,
        retryable: true
      });
      if (runtime) await afterOmieRequest(integration.id, "error", Date.now() - started, wrapped);
      throw wrapped;
    }
    if (runtime) await afterOmieRequest(integration.id, "error", Date.now() - started, error);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

import { asInt, query } from "../../../db.js";
import { enqueueIntegrationJob } from "../integration.service.js";
import { publishIntegrationEvent } from "../integration.events.js";
import { drainStockRefreshQueue, OMIE_JOB_TYPES, processNextIntegrationJob } from "./omie.sync.js";

const DEFAULT_INTERVALS_MS = Object.freeze({
  [OMIE_JOB_TYPES.MOVEMENTS]: 15_000,
  [OMIE_JOB_TYPES.STOCK]: 30_000,
  [OMIE_JOB_TYPES.PRODUCTS]: 5 * 60_000,
  [OMIE_JOB_TYPES.LOCATIONS]: 10 * 60_000,
  [OMIE_JOB_TYPES.RECONCILE]: 60_000,
  RECONCILE_OMIE_FULL_DAILY: 24 * 60 * 60_000
});

const PRIORITY_BY_JOB = Object.freeze({
  [OMIE_JOB_TYPES.MOVEMENTS]: "ALTA",
  [OMIE_JOB_TYPES.STOCK]: "ALTA",
  [OMIE_JOB_TYPES.PRODUCTS]: "NORMAL",
  [OMIE_JOB_TYPES.LOCATIONS]: "NORMAL",
  [OMIE_JOB_TYPES.RECONCILE]: "BAIXA"
});

function intervalFor(integration, jobType) {
  const intervals = integration.sync_intervals && typeof integration.sync_intervals === "object" ? integration.sync_intervals : {};
  const custom = Number(intervals[jobType] || intervals[jobType.toLowerCase()] || 0);
  return custom > 0 ? custom : DEFAULT_INTERVALS_MS[jobType];
}

async function shouldEnqueue(integrationId, jobType, intervalMs) {
  const rows = await query(
    `SELECT last_success_at, last_attempt_at
     FROM integration_sync_state
     WHERE integration_id = $1 AND scope = $2`,
    [asInt(integrationId), jobType]
  );
  const last = rows[0]?.last_attempt_at || rows[0]?.last_success_at;
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= intervalMs;
}

async function markAttempt(integrationId, jobType) {
  await query(
    `INSERT INTO integration_sync_state (integration_id, scope, last_attempt_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (integration_id, scope)
     DO UPDATE SET last_attempt_at = CURRENT_TIMESTAMP,
                   updated_at = CURRENT_TIMESTAMP`,
    [asInt(integrationId), jobType]
  );
}

export async function enqueueDueOmieJobs() {
  const integrations = await query(
    `SELECT id, nome, sync_intervals
     FROM integrations
     WHERE provedor = 'OMIE' AND ativo = TRUE AND stock_mode IN ('MANUAL', 'TRANSICAO')`
  );
  const created = [];
  for (const integration of integrations) {
    for (const jobType of [OMIE_JOB_TYPES.MOVEMENTS, OMIE_JOB_TYPES.STOCK, OMIE_JOB_TYPES.PRODUCTS, OMIE_JOB_TYPES.LOCATIONS, OMIE_JOB_TYPES.RECONCILE]) {
      const intervalMs = intervalFor(integration, jobType);
      if (!(await shouldEnqueue(integration.id, jobType, intervalMs))) continue;
      const job = await enqueueIntegrationJob({
        integrationId: integration.id,
        jobType,
        priority: PRIORITY_BY_JOB[jobType],
        payload: { origem: "scheduler", interval_ms: intervalMs },
        idempotencyKey: `${jobType}-${integration.id}-${Math.floor(Date.now() / intervalMs)}`
      });
      await markAttempt(integration.id, jobType);
      created.push(job);
    }
  }
  return created;
}

export async function runOmieSchedulerTick({ processLimit = 3, actor = "scheduler" } = {}) {
  const started = Date.now();
  const enqueued = await enqueueDueOmieJobs();
  const stockJobs = await drainStockRefreshQueue(10);
  const processed = [];
  for (let index = 0; index < processLimit; index += 1) {
    const job = await processNextIntegrationJob(actor);
    if (!job) break;
    processed.push(job);
  }
  if (enqueued.length || stockJobs.length || processed.length) {
    publishIntegrationEvent("integration.scheduler.tick", {
      enqueued: enqueued.length,
      stock_refresh_jobs: stockJobs.length,
      processed: processed.length,
      elapsed_ms: Date.now() - started
    });
  }
  return { enqueued, stockJobs, processed, elapsedMs: Date.now() - started };
}

export function startOmieScheduler() {
  if (process.env.OMIE_AUTO_SCHEDULER === "false") return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOmieSchedulerTick();
    } catch (error) {
      console.error("Falha no scheduler OMIE:", error.message || error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, Number(process.env.OMIE_SCHEDULER_TICK_MS || 5000));
  tick();
  return timer;
}

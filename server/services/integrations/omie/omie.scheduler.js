import { tx } from "../../../db.js";
import { enqueueIntegrationJob, processNextIntegrationJob, SYNC_OMIE_MOVEMENTS, SYNC_OMIE_PRODUCTS, SYNC_OMIE_STOCK } from "./omie.sync.js";

let schedulerTimer = null;
let processing = false;

export async function enqueueDueOmieJobs(client) {
  const integrations = await client.query(
    `SELECT id
     FROM integrations
     WHERE provedor = 'OMIE' AND ativo = TRUE`
  );
  const jobs = [];
  for (const integration of integrations.rows) {
    jobs.push(await enqueueIntegrationJob(client, { integrationId: integration.id, jobType: SYNC_OMIE_PRODUCTS, priority: "NORMAL" }));
    jobs.push(await enqueueIntegrationJob(client, { integrationId: integration.id, jobType: SYNC_OMIE_STOCK, priority: "ALTA" }));
    jobs.push(await enqueueIntegrationJob(client, { integrationId: integration.id, jobType: SYNC_OMIE_MOVEMENTS, priority: "NORMAL" }));
  }
  return jobs;
}

export async function runOmieSchedulerTick() {
  if (processing) return { skipped: true };
  processing = true;
  try {
    return await tx(async (client) => {
      await enqueueDueOmieJobs(client);
      const job = await processNextIntegrationJob(client);
      return { job };
    });
  } finally {
    processing = false;
  }
}

export function startOmieScheduler() {
  if (schedulerTimer || process.env.OMIE_SCHEDULER_ENABLED !== "true") return schedulerTimer;
  const quickDelay = 15_000;
  const retryDelay = 30_000;
  const productsDelay = 5 * 60_000;
  const stockDelay = 10 * 60_000;
  schedulerTimer = setInterval(() => {
    runOmieSchedulerTick().catch(() => {});
  }, Math.min(quickDelay, retryDelay, productsDelay, stockDelay));
  return schedulerTimer;
}

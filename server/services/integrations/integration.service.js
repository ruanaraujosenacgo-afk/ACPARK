export function normalizePriority(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (["CRITICA", "CRITICO", "CRITICAL"].includes(normalized)) return "CRITICA";
  if (["ALTA", "HIGH"].includes(normalized)) return "ALTA";
  if (["BAIXA", "LOW"].includes(normalized)) return "BAIXA";
  return "NORMAL";
}

export function priorityRank(priority) {
  const normalized = normalizePriority(priority);
  if (normalized === "CRITICA") return 100;
  if (normalized === "ALTA") return 80;
  if (normalized === "BAIXA") return 20;
  return 50;
}

export async function listIntegrationJobs(client, { limit = 100 } = {}) {
  const rows = await client.query(
    `SELECT *
     FROM integration_jobs
     WHERE status IN ('PENDENTE', 'PROCESSANDO', 'FALHA', 'REPROCESSAMENTO', 'CONCLUIDO')
     ORDER BY priority_rank DESC, created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows.rows;
}

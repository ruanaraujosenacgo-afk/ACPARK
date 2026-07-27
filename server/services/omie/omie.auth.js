import { getOmieConfig } from "./omie.config.js";

export function assertOmieConfigured(env = process.env) {
  const config = getOmieConfig(env);
  if (!config.configured) return { ok: false, reason: "Integração OMIE não configurada." };
  return { ok: true };
}

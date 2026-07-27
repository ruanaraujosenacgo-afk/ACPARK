import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function secretMaterial(env = process.env) {
  return env.INTEGRATION_ENCRYPTION_KEY || env.JWT_SECRET || "dev-only-change-me";
}

function keyFromEnv(env = process.env) {
  return crypto.createHash("sha256").update(String(secretMaterial(env))).digest();
}

export function encryptSecret(value, env = process.env) {
  const plain = String(value || "");
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, keyFromEnv(env), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(value, env = process.env) {
  const stored = String(value || "");
  if (!stored) return "";
  const [version, iv, tag, encrypted] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) return "";
  const decipher = crypto.createDecipheriv(ALGORITHM, keyFromEnv(env), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final()
  ]).toString("utf8");
}

export function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 6) return `${text.slice(0, 1)}***${text.slice(-1)}`;
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

export function sanitizeIntegration(row = {}, credentials = []) {
  return {
    id: row.id,
    nome: row.nome,
    provedor: row.provedor,
    tipo: row.tipo,
    ambiente: row.ambiente,
    url_base: row.url_base,
    empresa_vinculada: row.empresa_vinculada,
    ativo: row.ativo,
    status: row.status,
    ultima_sincronizacao: row.ultima_sincronizacao,
    last_error: row.last_error,
    last_connection_test_at: row.last_connection_test_at,
    last_connection_duration_ms: row.last_connection_duration_ms,
    last_connection_message: row.last_connection_message,
    stock_mode: row.stock_mode || "MANUAL",
    sync_intervals: row.sync_intervals || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    credentials: credentials.map((item) => ({
      key: item.credential_key,
      masked_value: item.masked_value || "",
      configured: Boolean(item.masked_value)
    }))
  };
}

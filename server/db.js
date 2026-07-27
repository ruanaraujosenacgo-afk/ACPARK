import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

process.env.TZ ||= "America/Sao_Paulo";

const { Pool, types } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

types.setTypeParser(1114, (value) => value);

function readStreamlitSecret() {
  if (process.env.VERCEL || process.env.NODE_ENV === "production") return null;

  const file = path.join(rootDir, ".streamlit", "secrets.toml");
  if (!fs.existsSync(file)) return null;

  const text = fs.readFileSync(file, "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-zA-Z_]+)\s*=\s*"([^"]*)"\s*$/);
    if (match) values[match[1]] = match[2];
  }

  if (!values.host || !values.username || !values.password || !values.database) return null;
  const user = encodeURIComponent(values.username);
  const pass = encodeURIComponent(values.password);
  return `postgres://${user}:${pass}@${values.host}:${values.port || 5432}/${values.database}?sslmode=require`;
}

const rawConnectionString = process.env.DATABASE_URL || readStreamlitSecret();

if (!rawConnectionString) {
  throw new Error("Configure DATABASE_URL no .env ou mantenha .streamlit/secrets.toml com a conexao PostgreSQL.");
}

const parsedConnection = new URL(rawConnectionString);
const sslmode = parsedConnection.searchParams.get("sslmode");
parsedConnection.searchParams.delete("sslmode");
const connectionString = parsedConnection.toString();
const hostname = parsedConnection.hostname.toLowerCase();
const usesHostedPostgres = sslmode !== "disable" && !["localhost", "127.0.0.1", "::1"].includes(hostname);

export const pool = new Pool({
  connectionString,
  ssl: usesHostedPostgres ? { rejectUnauthorized: false } : undefined,
  // Supabase transaction pooler does not work well with traditional prepared statements.
  prepareThreshold: 0
});

pool.on("connect", (client) => {
  client.query("SET TIME ZONE 'America/Sao_Paulo'").catch(() => {});
});

export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

export async function tx(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const HASH_PREFIX = "pbkdf2_sha256";
const ITERATIONS = 260000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = crypto.pbkdf2Sync(String(password), salt, ITERATIONS, 32, "sha256").toString("base64");
  return `${HASH_PREFIX}$${ITERATIONS}$${salt}$${digest}`;
}

export function verifyPassword(password, stored) {
  if (!password || !stored) return false;
  const value = String(stored);
  if (!value.startsWith(`${HASH_PREFIX}$`)) {
    const entered = Buffer.from(String(password));
    const saved = Buffer.from(value);
    return entered.length === saved.length && crypto.timingSafeEqual(entered, saved);
  }

  const [, iterations, salt, digest] = value.split("$");
  if (!iterations || !salt || !digest) return false;
  const test = crypto.pbkdf2Sync(String(password), salt, Number(iterations), 32, "sha256").toString("base64");
  const entered = Buffer.from(test);
  const saved = Buffer.from(digest);
  return entered.length === saved.length && crypto.timingSafeEqual(entered, saved);
}

export function asInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function code(prefix) {
  const stamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date()).replace(/\D/g, "");
  return `${prefix}-${stamp}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

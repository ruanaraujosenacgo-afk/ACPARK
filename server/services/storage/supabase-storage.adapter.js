import { StorageConfigurationError } from "./storage.errors.js";

function requireValue(value, name) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized) throw new StorageConfigurationError(`${name} e obrigatorio para Supabase Storage.`);
  return normalized;
}

function encodeStorageKey(key) {
  return String(key || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export class SupabaseStorageAdapter {
  constructor(config = {}) {
    this.supabaseUrl = requireValue(config.supabaseUrl, "SUPABASE_URL");
    this.serviceRoleKey = requireValue(config.serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY");
    this.bucket = requireValue(config.bucket, "STORAGE_BUCKET");
  }

  headers(extra = {}) {
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      ...extra
    };
  }

  objectUrl(key) {
    return `${this.supabaseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}/${encodeStorageKey(key)}`;
  }

  async saveFile(key, buffer, contentType = "application/octet-stream") {
    const response = await fetch(this.objectUrl(key), {
      method: "POST",
      headers: this.headers({
        "Content-Type": contentType || "application/octet-stream",
        "x-upsert": "true"
      }),
      body: Buffer.from(buffer)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Falha no Supabase Storage (${response.status}): ${text || response.statusText}`);
    }
    return { key };
  }

  async readFile(key) {
    const response = await fetch(this.objectUrl(key), {
      method: "GET",
      headers: this.headers()
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Falha ao ler Supabase Storage (${response.status}): ${text || response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async deleteFile(key) {
    if (!key) return;
    const response = await fetch(`${this.supabaseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}`, {
      method: "DELETE",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefixes: [key] })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Falha ao remover Supabase Storage (${response.status}): ${text || response.statusText}`);
    }
  }
}

import crypto from "node:crypto";
import { StorageConfigurationError } from "./storage.errors.js";

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function amzTimestamp(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8)
  };
}

function encodeS3Key(key) {
  return String(key || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || "").trim().replace(/\/+$/, "");
  if (!value) throw new StorageConfigurationError("STORAGE_ENDPOINT e obrigatorio para storage S3/R2/Supabase.");
  return new URL(value);
}

function requireValue(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new StorageConfigurationError(`${name} e obrigatorio para storage S3/R2/Supabase.`);
  return normalized;
}

export class S3StorageAdapter {
  constructor(config = {}) {
    this.endpoint = normalizeEndpoint(config.endpoint);
    this.bucket = requireValue(config.bucket, "STORAGE_BUCKET");
    this.region = String(config.region || "auto").trim() || "auto";
    this.accessKey = requireValue(config.accessKey, "STORAGE_ACCESS_KEY");
    this.secretKey = requireValue(config.secretKey, "STORAGE_SECRET_KEY");
  }

  objectUrl(key) {
    const encodedKey = encodeS3Key(key);
    return new URL(`${this.endpoint.pathname.replace(/\/+$/, "")}/${encodeURIComponent(this.bucket)}/${encodedKey}`, this.endpoint);
  }

  signedHeaders({ method, key, body = Buffer.alloc(0), contentType = "application/octet-stream" }) {
    const url = this.objectUrl(key);
    const { amzDate, dateStamp } = amzTimestamp();
    const payloadHash = sha256Hex(body);
    const headers = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    };
    if (method === "PUT") headers["content-type"] = contentType;

    const sortedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
    const signedHeaders = sortedHeaderNames.join(";");
    const canonicalRequest = [
      method,
      url.pathname,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest)
    ].join("\n");
    const kDate = hmac(`AWS4${this.secretKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = hmac(kSigning, stringToSign, "hex");

    return {
      url,
      headers: {
        ...headers,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
      }
    };
  }

  async request({ method, key, body, contentType }) {
    const payload = body ? Buffer.from(body) : Buffer.alloc(0);
    const signed = this.signedHeaders({ method, key, body: payload, contentType });
    const response = await fetch(signed.url, {
      method,
      headers: signed.headers,
      body: method === "PUT" ? payload : undefined
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Falha no storage (${response.status}): ${text || response.statusText}`);
    }
    return response;
  }

  async saveFile(key, buffer, contentType = "application/octet-stream") {
    await this.request({ method: "PUT", key, body: buffer, contentType });
    return { key };
  }

  async readFile(key) {
    const response = await this.request({ method: "GET", key });
    return Buffer.from(await response.arrayBuffer());
  }

  async deleteFile(key) {
    if (!key) return;
    await this.request({ method: "DELETE", key });
  }
}

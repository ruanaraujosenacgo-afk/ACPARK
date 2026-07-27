import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageService, detectImage } from "../server/services/storage/storage.service.js";
import { S3StorageAdapter } from "../server/services/storage/s3-storage.adapter.js";
import { SupabaseStorageAdapter } from "../server/services/storage/supabase-storage.adapter.js";
import { StorageConfigurationError } from "../server/services/storage/storage.errors.js";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000150a2f4a20000000049454e44ae426082",
  "hex"
);

test("valid PNG image is detected and stored outside operational tables", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpark-storage-"));
  const storage = new StorageService({
    driver: "local",
    localRoot: root,
    maxImageBytes: 1024 * 1024,
    maxImagesPerItem: 12
  });

  const saved = await storage.saveImage({
    buffer: PNG_1X1,
    originalName: "foto.png",
    folder: "tests"
  });
  const stored = await storage.readFile(saved.storageKey);

  assert.equal(saved.mimeType, "image/png");
  assert.equal(saved.sha256.length, 64);
  assert.deepEqual(stored, PNG_1X1);
});

test("renamed executable is rejected by binary signature", async () => {
  const storage = new StorageService({
    driver: "local",
    localRoot: await fs.mkdtemp(path.join(os.tmpdir(), "acpark-storage-")),
    maxImageBytes: 1024 * 1024,
    maxImagesPerItem: 12
  });

  assert.equal(detectImage(Buffer.from("MZ fake executable")), null);
  assert.throws(
    () => storage.validateImage({ buffer: Buffer.from("MZ fake executable"), originalName: "foto.jpg" }),
    /imagem/
  );
});

test("HEIC without converter returns clear message", async () => {
  const storage = new StorageService({
    driver: "local",
    localRoot: await fs.mkdtemp(path.join(os.tmpdir(), "acpark-storage-")),
    maxImageBytes: 1024 * 1024,
    maxImagesPerItem: 12
  });

  assert.throws(
    () => storage.validateImage({ buffer: Buffer.from("heic data"), originalName: "foto.heic" }),
    /HEIC\/HEIF/
  );
});

test("local storage is blocked in production-like environments", () => {
  assert.throws(
    () => new StorageService({
      driver: "local",
      localRoot: "tmp",
      productionLike: true,
      allowLocalInProduction: false,
      maxImageBytes: 1024 * 1024,
      maxImagesPerItem: 12
    }),
    StorageConfigurationError
  );
});

test("S3-compatible adapter signs upload, download and delete requests", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === "GET") {
      return new Response(PNG_1X1, { status: 200 });
    }
    return new Response("", { status: 200 });
  };

  try {
    const adapter = new S3StorageAdapter({
      endpoint: "https://storage.example.test",
      bucket: "acpark-avarias",
      region: "auto",
      accessKey: "access",
      secretKey: "secret"
    });

    await adapter.saveFile("avarias/teste/foto.png", PNG_1X1);
    const downloaded = await adapter.readFile("avarias/teste/foto.png");
    await adapter.deleteFile("avarias/teste/foto.png");

    assert.deepEqual(downloaded, PNG_1X1);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].options.method, "PUT");
    assert.equal(calls[1].options.method, "GET");
    assert.equal(calls[2].options.method, "DELETE");
    assert.match(calls[0].url, /\/acpark-avarias\/avarias\/teste\/foto\.png$/);
    assert.ok(calls[0].options.headers.Authorization.includes("AWS4-HMAC-SHA256"));
    assert.ok(calls[0].options.headers["x-amz-date"]);
    assert.ok(calls[0].options.headers["x-amz-content-sha256"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("S3-compatible adapter rejects incomplete configuration", () => {
  assert.throws(
    () => new S3StorageAdapter({ endpoint: "https://storage.example.test", bucket: "bucket", accessKey: "access" }),
    StorageConfigurationError
  );
});

test("Supabase Storage adapter uploads, downloads and deletes through authenticated REST API", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === "GET") {
      return new Response(PNG_1X1, { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
      bucket: "avarias-fotos"
    });

    await adapter.saveFile("avarias/teste/foto.png", PNG_1X1);
    const downloaded = await adapter.readFile("avarias/teste/foto.png");
    await adapter.deleteFile("avarias/teste/foto.png");

    assert.deepEqual(downloaded, PNG_1X1);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[1].options.method, "GET");
    assert.equal(calls[2].options.method, "DELETE");
    assert.match(calls[0].url, /\/storage\/v1\/object\/avarias-fotos\/avarias\/teste\/foto\.png$/);
    assert.equal(calls[0].options.headers.apikey, "service-role-key");
    assert.equal(calls[0].options.headers.Authorization, "Bearer service-role-key");
    assert.equal(calls[0].options.headers["x-upsert"], "true");
    assert.equal(calls[0].options.headers["Content-Type"], "application/octet-stream");
    assert.equal(JSON.parse(calls[2].options.body).prefixes[0], "avarias/teste/foto.png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Supabase Storage service uploads images with detected image content type", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === "GET") {
      return new Response(PNG_1X1, { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const storage = new StorageService({
      driver: "supabase",
      productionLike: false,
      bucket: "avarias-fotos",
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: "service-role-key",
      maxImageBytes: 8 * 1024 * 1024,
      maxImagesPerItem: 12
    });

    await storage.saveImage({ buffer: PNG_1X1, originalName: "foto.png" });

    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers["Content-Type"], "image/png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Supabase Storage adapter rejects incomplete configuration", () => {
  assert.throws(
    () => new SupabaseStorageAdapter({ supabaseUrl: "https://project.supabase.co", bucket: "avarias-fotos" }),
    StorageConfigurationError
  );
});

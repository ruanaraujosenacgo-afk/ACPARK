import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { decryptSecret, encryptSecret, maskSecret, sanitizeIntegration } from "../server/services/integrations/integration.security.js";

const serverSource = fs.readFileSync("server/index.js", "utf8");
const schemaSource = fs.readFileSync("server/schema.sql", "utf8");
const appSource = fs.readFileSync("public/app.js", "utf8");

test("ACPARK nao implementa mais Orion -> ACPARK -> OMIE", () => {
  assert.doesNotMatch(serverSource, /\/api\/admin\/orion|vendas_orion|processOrion/i);
  assert.doesNotMatch(schemaSource, /CREATE TABLE IF NOT EXISTS vendas_orion|idx_vendas_orion/i);
  assert.doesNotMatch(appSource, /Simular ORION|\/api\/admin\/orion|codigo_orion/i);
});

test("schema possui central de integracoes e espelho de estoque OMIE", () => {
  for (const table of [
    "integrations",
    "integration_credentials",
    "integration_jobs",
    "integration_attempts",
    "integration_webhooks",
    "product_integration_mappings",
    "pdv_stock_location_mappings",
    "stock_movements",
    "stock_movement_items",
    "stock_snapshots",
    "stock_reconciliations",
    "integration_audit_logs"
  ]) {
    assert.match(schemaSource, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schemaSource, /saldo_omie/);
  assert.match(schemaSource, /quantidade_reservada_acpark/);
  assert.match(schemaSource, /saldo_disponivel_acpark/);
});

test("credenciais de integracao sao criptografadas, mascaradas e sanitizadas", () => {
  const env = { INTEGRATION_ENCRYPTION_KEY: "test-secret-key" };
  const encrypted = encryptSecret("super-secret", env);
  assert.notEqual(encrypted, "super-secret");
  assert.equal(decryptSecret(encrypted, env), "super-secret");
  assert.equal(maskSecret("abcdefghi"), "abc***ghi");

  const sanitized = sanitizeIntegration(
    { id: 1, nome: "OMIE", provedor: "OMIE", tipo: "ERP_ESTOQUE", ambiente: "PRODUCAO", ativo: true, status: "PENDENTE" },
    [{ credential_key: "app_secret", masked_value: "abc***ghi", encrypted_value: encrypted }]
  );
  assert.deepEqual(sanitized.credentials, [{ key: "app_secret", masked_value: "abc***ghi", configured: true }]);
  assert.equal(JSON.stringify(sanitized).includes("super-secret"), false);
  assert.equal(JSON.stringify(sanitized).includes(encrypted), false);
});

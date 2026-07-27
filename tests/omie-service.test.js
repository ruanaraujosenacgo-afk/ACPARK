import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { callOmie } from "../server/services/omie/omie.client.js";
import { getOmieConfig, omieInitialStatus } from "../server/services/omie/omie.config.js";
import { buildDamageOperationKey, movementTypeForDamageReason } from "../server/services/omie/omie.movements.js";

test("OMIE disabled never reports integration success", async () => {
  const env = { OMIE_ENABLED: "false" };

  assert.equal(getOmieConfig(env).configured, false);
  assert.equal(omieInitialStatus(env), "Integração não configurada");
  await assert.rejects(
    () => callOmie("/teste", {}, { env }),
    /Integração OMIE não configurada/
  );
});

test("damage movement mapping does not classify damage as sale", () => {
  assert.equal(movementTypeForDamageReason("Produto vencido"), "BAIXA_VENCIMENTO");
  assert.equal(movementTypeForDamageReason("Produto danificado"), "BAIXA_DANIFICADO");
  assert.equal(movementTypeForDamageReason("Produto estragado"), "BAIXA_ESTRAGADO");
  assert.notEqual(movementTypeForDamageReason("Produto vencido"), "VENDA");
});

test("damage operation keys are deterministic and unique by version", () => {
  const first = buildDamageOperationKey({
    devolucaoId: 154,
    itemId: 39,
    movementType: "BAIXA_AVARIA",
    version: 1
  });
  const second = buildDamageOperationKey({
    devolucaoId: 154,
    itemId: 39,
    movementType: "BAIXA_AVARIA",
    version: 2
  });

  assert.equal(first, "AVARIA-154-ITEM-39-BAIXA_AVARIA-V1");
  assert.notEqual(first, second);
});

test("avarias route does not write fake OMIE success directly", () => {
  const source = fs.readFileSync(new URL("../server/modules/avarias/avarias.routes.js", import.meta.url), "utf8");

  assert.equal(source.includes("omie_status = 'Integrado com sucesso'"), false);
});

test("schema includes OMIE jobs queue", () => {
  const schema = fs.readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8");

  assert.match(schema, /CREATE TABLE IF NOT EXISTS omie_jobs/);
  assert.match(schema, /operation_key VARCHAR\(180\) NOT NULL UNIQUE/);
});

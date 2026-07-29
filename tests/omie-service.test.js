import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { callOmie } from "../server/services/omie/omie.client.js";
import { getOmieConfig, omieInitialStatus } from "../server/services/omie/omie.config.js";
import {
  buildDamageOperationKey,
  buildOmieStockAdjustmentPayload,
  movementTypeForDamageReason,
  processNextOmieJob
} from "../server/services/omie/omie.movements.js";

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

test("damage adjustment payload uses OMIE stock adjustment fields", () => {
  const payload = buildOmieStockAdjustmentPayload({
    operationKey: "AVARIA-10-ITEM-2-BAIXA_AVARIA-V1",
    productSku: "SKU-ABC-123",
    locationCode: 55,
    quantity: "2,5",
    date: "2026-07-28T12:00:00-03:00",
    note: "Baixa por avaria ACPARK",
    movementType: "SAI",
    origin: "AJU",
    reason: "PER"
  });

  assert.equal(payload.cod_int_ajuste, "AVARIA-10-ITEM-2-BAIXA_AVARIA-V1");
  assert.equal(payload.cod_int, "SKU-ABC-123");
  assert.equal(payload.codigo_local_estoque, 55);
  assert.equal(payload.quan, "2,5");
  assert.equal(payload.tipo, "SAI");
  assert.equal(payload.origem, "AJU");
  assert.equal(payload.motivo, "PER");
  assert.equal(payload.obs, "Baixa por avaria ACPARK");
  assert.equal(payload.valor, 0);
});

test("OMIE stock adjustment job calls the official adjustment endpoint once", async () => {
  const queries = [
    {
      rows: [{
        id: 90,
        operation_key: "AVARIA-1-ITEM-1-BAIXA_AVARIA-V1",
        entity_type: "AVARIA",
        entity_id: 1,
        payload: { cod_int_ajuste: "AVARIA-1-ITEM-1-BAIXA_AVARIA-V1", cod_int: "SKU1", data: "28/07/2026", quan: "1", obs: "Teste", origem: "AJU", tipo: "SAI", motivo: "PER", valor: 0 }
      }]
    },
    { rows: [] },
    { rows: [] },
    { rows: [] }
  ];
  const executed = [];
  const client = {
    async query(sql, params) {
      executed.push({ sql, params });
      return queries.shift() || { rows: [] };
    }
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return { id_ajuste: 777 };
      }
    };
  };

  const result = await processNextOmieJob(client, {
    fetchImpl,
    env: { OMIE_ENABLED: "true", OMIE_APP_KEY: "key", OMIE_APP_SECRET: "secret", OMIE_BASE_URL: "https://app.omie.com.br/api/v1" }
  });

  assert.equal(result.status, "SUCCESS");
  assert.equal(result.external_id, "777");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://app.omie.com.br/api/v1/estoque/ajuste/");
  assert.equal(requests[0].body.call, "IncluirAjusteEstoque");
  assert.equal(requests[0].body.app_key, "key");
  assert.equal(requests[0].body.app_secret, "secret");
  assert.equal(requests[0].body.param[0].motivo, "PER");
  assert.match(executed.map((entry) => entry.sql).join("\n"), /UPDATE omie_jobs/);
});

test("OMIE fault response is treated as integration failure", async () => {
  await assert.rejects(
    () => callOmie("/estoque/ajuste/", { call: "IncluirAjusteEstoque", param: [{}] }, {
      env: { OMIE_ENABLED: "true", OMIE_APP_KEY: "key", OMIE_APP_SECRET: "secret", OMIE_BASE_URL: "https://app.omie.com.br/api/v1" },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { faultstring: "Produto nao encontrado" };
        }
      })
    }),
    /Produto nao encontrado/
  );
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

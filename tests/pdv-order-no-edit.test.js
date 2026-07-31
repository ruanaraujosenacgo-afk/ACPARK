import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../server/modules/pedidos/pedidos.routes.js", import.meta.url), "utf8");
const schema = fs.readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8");
const service = fs.readFileSync(new URL("../server/modules/pedidos/pedidos.service.js", import.meta.url), "utf8");

test("pdv order tracking stays read-only after an order is sent", () => {
  assert.doesNotMatch(app, /Reverter para edição/);
  assert.doesNotMatch(app, /Enviar pedido novamente/);
  assert.doesNotMatch(app, /pdv-order-edit-panel/);
  assert.doesNotMatch(app, /openRevertOrderModal/);
  assert.doesNotMatch(app, /bindPdvOrderEditActions/);
});

test("pdv post-send edit endpoints are not registered", () => {
  assert.doesNotMatch(routes, /revert-to-edit/);
  assert.doesNotMatch(routes, /\/resend/);
  assert.doesNotMatch(routes, /EM_EDICAO_PDV/);
  assert.doesNotMatch(routes, /pedido_operacao_idempotencia/);
});

test("schema keeps order creation idempotency but not pdv edit-only structures", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS pedido_idempotencia/);
  assert.match(routes, /INSERT INTO pedido_idempotencia/);
  assert.doesNotMatch(schema, /pedido_operacao_idempotencia/);
  assert.doesNotMatch(schema, /reversao_pdv_/);
  assert.doesNotMatch(schema, /reenviado_pdv_em/);
  assert.doesNotMatch(service, /EM_EDICAO_PDV/);
});

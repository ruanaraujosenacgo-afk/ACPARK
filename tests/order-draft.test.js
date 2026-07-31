import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../server/modules/pedidos/pedidos.routes.js", import.meta.url), "utf8");
const schema = fs.readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8");

test("pdv order draft has backend storage and routes", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS pedido_rascunhos/);
  assert.match(routes, /function ensurePedidoDraftTable/);
  assert.match(routes, /url\.pathname === "\/api\/pdv\/order-draft"/);
  assert.match(routes, /INSERT INTO pedido_rascunhos/);
  assert.match(routes, /ON CONFLICT \(pdv_id\) DO UPDATE/);
  assert.match(routes, /DELETE FROM pedido_rascunhos WHERE pdv_id = \$1/);
});

test("pdv order screen can save, restore and clear cart draft", () => {
  assert.match(app, /\/api\/pdv\/order-draft/);
  assert.match(app, /Salvar rascunho/);
  assert.match(app, /Limpar rascunho/);
  assert.match(app, /currentDraftPayload/);
  assert.match(app, /state\.cart = savedDraft\.items/);
  assert.match(app, /Você pode continuar este pedido depois/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleEstoqueRoutes } from "../server/modules/estoque/estoque.routes.js";
import { handlePedidosRoutes } from "../server/modules/pedidos/pedidos.routes.js";
import { handleAvariasRoutes } from "../server/modules/avarias/avarias.routes.js";

function createResponse() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };
}

function unauthorizedRequireUser(_req, res) {
  res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Login necessario." }));
  return null;
}

function contextFor(pathname, method = "GET", extra = {}) {
  return {
    method,
    requireUser: unauthorizedRequireUser,
    url: new URL(`http://localhost${pathname}`),
    user: null,
    ...extra
  };
}

function jsonRequest(body, headers = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.headers = headers;
  return req;
}

test("estoque admin routes stay protected", async () => {
  const res = createResponse();
  const handled = await handleEstoqueRoutes({}, res, contextFor("/api/admin/stock"));

  assert.equal(handled, true);
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { error: "Login necessario." });
});

test("pedidos admin routes stay protected", async () => {
  for (const [pathname, method] of [
    ["/api/admin/orders", "GET"],
    ["/api/admin/order-flow", "POST"],
    ["/api/admin/order-items", "DELETE"],
    ["/api/admin/history", "GET"]
  ]) {
    const res = createResponse();
    const handled = await handlePedidosRoutes({}, res, contextFor(pathname, method));

    assert.equal(handled, true, pathname);
    assert.equal(res.status, 401, pathname);
    assert.deepEqual(JSON.parse(res.body), { error: "Login necessario." }, pathname);
  }
});

test("avarias admin delete route stays protected", async () => {
  const res = createResponse();
  const handled = await handleAvariasRoutes({}, res, contextFor("/api/admin/avarias", "DELETE"));

  assert.equal(handled, true);
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { error: "Login necessario." });
});

test("avarias admin delete requires an item or cancelled cleanup", async () => {
  const res = createResponse();
  const req = jsonRequest({});
  const handled = await handleAvariasRoutes(req, res, contextFor("/api/admin/avarias", "DELETE", {
    requireUser: () => ({ role: "admin", name: "Almoxarifado" }),
    user: { role: "admin", name: "Almoxarifado" }
  }));

  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: "Informe a devolução que deve ser excluída." });
});

test("pdv order creation rejects admin users before touching data", async () => {
  const res = createResponse();
  const handled = await handlePedidosRoutes({}, res, contextFor("/api/pdv/order", "POST", {
    user: { role: "admin", name: "Almoxarifado" }
  }));

  assert.equal(handled, true);
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.body), { error: "Entre como PDV para solicitar produtos." });
});

test("pdv order creation requires idempotency key before touching data", async () => {
  const res = createResponse();
  const req = jsonRequest({
    solicitante: "Ruan",
    items: [{ sku: "1001", quantidade: 1 }]
  });
  const handled = await handlePedidosRoutes(req, res, contextFor("/api/pdv/order", "POST", {
    user: { role: "pdv", pdvId: 1, name: "PDV TESTE" }
  }));

  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: "Identificador da operação ausente. Atualize a página e tente novamente." });
});

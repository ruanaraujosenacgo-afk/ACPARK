import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
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

function jsonRequest(body, headers = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.headers = headers;
  return req;
}

function contextFor(pathname, method = "POST", extra = {}) {
  return {
    method,
    requireUser: () => true,
    url: new URL(`http://localhost${pathname}`),
    user: null,
    ...extra
  };
}

test("pdv damage return creation requires idempotency key before touching data", async () => {
  const res = createResponse();
  const req = jsonRequest({
    usuario_solicitante: "Ruan",
    items: [{
      sku: "1001",
      quantidade: 1,
      unidade_medida: "UN",
      motivo: "Produto estragado",
      data_identificacao: "2026-07-16",
      fotos: ["data:image/png;base64,aW1hZ2Vt"]
    }]
  });
  const handled = await handleAvariasRoutes(req, res, contextFor("/api/pdv/avarias", "POST", {
    user: { role: "pdv", pdvId: 1, name: "PDV TESTE" }
  }));

  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).error, /Identificador/);
});

test("pdv damage cancel requires idempotency key before touching data", async () => {
  const res = createResponse();
  const req = jsonRequest({ id: 1, motivo_cancelamento: "Teste" });
  const handled = await handleAvariasRoutes(req, res, contextFor("/api/pdv/avarias/cancel", "POST", {
    user: { role: "pdv", pdvId: 1, name: "PDV TESTE" }
  }));

  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).error, /Identificador/);
});

test("admin damage flow requires idempotency key before touching data", async () => {
  const res = createResponse();
  const req = jsonRequest({ id: 1, action: "receive" });
  const handled = await handleAvariasRoutes(req, res, contextFor("/api/admin/avarias/flow", "POST", {
    user: { role: "admin", name: "Almoxarifado" }
  }));

  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body).error, /Identificador/);
});

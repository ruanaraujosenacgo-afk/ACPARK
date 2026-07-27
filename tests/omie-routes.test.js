import test from "node:test";
import assert from "node:assert/strict";
import { handleOmieRoutes } from "../server/modules/omie/omie.routes.js";

function createResponse() {
  return {
    status: null,
    body: "",
    writeHead(status) {
      this.status = status;
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

test("OMIE admin jobs route stays protected", async () => {
  const res = createResponse();
  const handled = await handleOmieRoutes({}, res, {
    method: "GET",
    requireUser: unauthorizedRequireUser,
    url: new URL("http://localhost/api/admin/omie/jobs"),
    user: null
  });

  assert.equal(handled, true);
  assert.equal(res.status, 401);
});

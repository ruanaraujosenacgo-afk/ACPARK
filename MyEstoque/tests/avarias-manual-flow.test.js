import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const routeSource = fs.readFileSync("server/modules/avarias/avarias.routes.js", "utf8");
const schemaSource = fs.readFileSync("server/schema.sql", "utf8");

test("avarias manual flow does not create OMIE jobs during operational finalization", () => {
  assert.equal(routeSource.includes("createOmieJob"), false);
  assert.equal(routeSource.includes("buildDamageOperationKey"), false);
  assert.equal(routeSource.includes("buildStockMovementPayload"), false);
  assert.match(routeSource, /Integração desativada/);
  assert.match(routeSource, /baixa_avaria_manual/);
});

test("avarias schema has manual movement tracking fields", () => {
  assert.match(schemaSource, /manual_quantidade_processada INTEGER DEFAULT 0/);
  assert.match(schemaSource, /movimento_manual_status TEXT DEFAULT 'Pendente'/);
  assert.match(schemaSource, /omie_status TEXT DEFAULT 'Integração desativada'/);
});

test("avarias conference validation reads requested quantity from stable row data", () => {
  const appSource = fs.readFileSync("public/app.js", "utf8");
  assert.match(appSource, /class="damage-conference-item"[^>]+data-requested=/);
  assert.match(appSource, /const requested = Number\(row\.dataset\.requested \|\| 0\)/);
  assert.equal(appSource.includes("const requested = Number(row.children[1]?.textContent || 0);"), false);
});

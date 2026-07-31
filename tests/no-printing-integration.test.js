import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(file) {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

const appSource = read("public/app.js");
const serverSource = read("server/index.js");
const pedidosSource = read("server/modules/pedidos/pedidos.routes.js");
const schemaSource = read("server/schema.sql");
const packageJson = JSON.parse(read("package.json"));
const envExample = read(".env.example");

test("QZ Tray, agente e impressao automatica foram removidos do frontend", () => {
  assert.doesNotMatch(appSource, /qz|QZ Tray|qz-tray|order-print-jobs|print_auto_enabled|print_agent_/i);
  assert.doesNotMatch(appSource, /Verificar QZ Tray|Buscar impressoras|Imprimir teste|Reiniciar conex[aã]o/i);
  assert.doesNotMatch(appSource, /Impress[aã]o PDV|Impress[aã]o almoxarifado|Pendente de impress[aã]o/i);
});

test("rotas e filas de impressao automatica foram removidas do backend", () => {
  const backend = `${serverSource}\n${pedidosSource}`;
  assert.doesNotMatch(backend, /\/api\/qz\/certificate|\/api\/qz\/sign/);
  assert.doesNotMatch(backend, /\/api\/pdv\/order-print-jobs|\/api\/admin\/order-print-jobs/);
  assert.doesNotMatch(backend, /pedido_impressao_jobs|pedido_impressao_historico/);
  assert.doesNotMatch(backend, /print_auto_enabled|print_agent_/);
});

test("schema, dependencias e exemplo de ambiente nao recriam QZ ou filas", () => {
  assert.doesNotMatch(schemaSource, /pedido_impressao_jobs|pedido_impressao_historico|print_status|print_agent_|print_auto_enabled/);
  assert.equal(packageJson.dependencies?.["qz-tray"], undefined);
  assert.doesNotMatch(envExample, /QZ_|QZ_TRAY|print_agent|print_auto/i);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync("server/index.js", "utf8");

test("dashboard ranking and trend count only finalized orders", () => {
  const dashboardBlock = server.slice(
    server.indexOf('if (url.pathname === "/api/admin/dashboard")'),
    server.indexOf('if (url.pathname === "/api/admin/config"')
  );

  assert.match(dashboardBlock, /END\) = 'Finalizado'/);
  assert.match(dashboardBlock, /SUM\(COALESCE\(NULLIF\(p\.quantidade_liberada, 0\), p\.quantidade_solicitada\)\)::int AS total/);
  assert.match(dashboardBlock, /COALESCE\(SUM\(COALESCE\(NULLIF\(p\.quantidade_liberada, 0\), p\.quantidade_solicitada\)\), 0\)::int AS total/);
  assert.match(dashboardBlock, /SELECT NULL::text AS pdv, pr\.sku, pr\.nome AS produto/);
  assert.match(dashboardBlock, /GROUP BY pr\.sku, pr\.nome/);
  assert.doesNotMatch(dashboardBlock, /GROUP BY pd\.nome, pr\.sku, pr\.nome/);
  assert.match(dashboardBlock, /COALESCE\(p\.retirada_em, p\.liberado_em, p\.data_hora\)::date >= \$1::date/);
  assert.match(dashboardBlock, /COALESCE\(p\.retirada_em, p\.liberado_em, p\.data_hora\)::date <= \$2::date/);
  assert.match(dashboardBlock, /date_trunc\('month', COALESCE\(p\.retirada_em, p\.liberado_em, p\.data_hora\)\)/);
  assert.doesNotMatch(dashboardBlock, /WHERE \(\$1::date IS NULL OR p\.data_hora::date >= \$1::date\)/);
});

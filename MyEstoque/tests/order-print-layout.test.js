import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appSource = fs.readFileSync("public/app.js", "utf8");
const stylesSource = fs.readFileSync("public/styles.css", "utf8");

test("manual order print uses dedicated receipt layout instead of screen card", () => {
  assert.match(appSource, /async function printOrder/);
  assert.match(appSource, /order-request-print-target/);
  assert.match(appSource, /ACPark Pedidos/);
  assert.match(appSource, /Produto/);
  assert.match(appSource, /QTD/);
  assert.match(appSource, /receipt-item-dash/);
  assert.doesNotMatch(appSource, /card\.classList\.add\("is-manual-print-target"\)/);
});

test("order print css keeps receipt clean and left aligned", () => {
  assert.match(stylesSource, /order-request-print-target/);
  assert.match(stylesSource, /text-align: left/);
  assert.match(stylesSource, /grid-template-columns: minmax\(0, 1fr\) 13mm/);
});

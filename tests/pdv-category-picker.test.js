import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

test("PDV category picker uses multi-select checkboxes", () => {
  assert.match(app, /data-category-option/);
  assert.match(app, /Selecionar todas/);
  assert.match(app, /Adicionar selecionadas/);
  assert.match(app, /checkedValues/);
});

test("PDV category picker prevents duplicated category bindings", () => {
  assert.match(app, /filter\(\(value\) => !selected\.includes\(value\)\)/);
  assert.match(app, /new Set\(\(values \|\| \[\]\)\.filter\(Boolean\)\)/);
});

test("PDV category picker has compact responsive dropdown styles", () => {
  assert.match(styles, /\.pdv-category-dropdown/);
  assert.match(styles, /width: min\(100%, 460px\)/);
  assert.match(styles, /\.pdv-category-options[\s\S]*max-height: 230px/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.pdv-category-dropdown[\s\S]*width: 100%/);
});

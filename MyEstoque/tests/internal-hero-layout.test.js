import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("internal pages do not render the image hero outside the dashboard", () => {
  assert.match(appSource, /const shouldShowHero = state\.currentView === "dashboard";/);
  assert.match(appSource, /\$\{shouldShowHero \? `\s*<section class="app-hero">/);
  assert.match(appSource, /<main class="app-main \$\{shouldShowHero \? "" : "app-main-internal"\} px-4 py-5">/);
});

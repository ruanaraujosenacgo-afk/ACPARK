import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

test("login screen renders without horizontal overflow", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/ACPark/i);
  await expect(page.getByRole("heading", { name: /Entrar no sistema/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Entrar$/i })).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
});

test("login screen has no critical accessibility violations", async ({ page }) => {
  await page.goto("/");
  await page.addScriptTag({ content: axeSource });

  const results = await page.evaluate(async () => {
    return window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa"]
      }
    });
  });

  const seriousViolations = results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact));
  expect(seriousViolations).toEqual([]);
});

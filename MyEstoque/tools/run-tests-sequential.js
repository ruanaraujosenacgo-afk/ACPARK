import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(".");
const testsDir = path.join(root, "tests");
const node = process.execPath;

function shouldRun(file) {
  return file.endsWith(".test.js");
}

const files = fs
  .readdirSync(testsDir)
  .filter(shouldRun)
  .sort()
  .map((file) => path.join(testsDir, file));

if (!files.length) {
  console.error("Nenhum arquivo .test.js encontrado.");
  process.exit(1);
}

const startedAt = Date.now();
const results = [];

for (const file of files) {
  const label = path.relative(root, file).replace(/\\/g, "/");
  const start = Date.now();
  console.log(`\n=== ${label} ===`);

  const result = spawnSync(node, [file], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: false
  });

  const durationMs = Date.now() - start;
  results.push({
    file: label,
    status: result.status,
    signal: result.signal,
    durationMs
  });

  if (result.error) {
    console.error(`Falha ao executar ${label}: ${result.error.message}`);
    printSummary(results, Date.now() - startedAt);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`Teste interrompido em ${label} com codigo ${result.status}.`);
    printSummary(results, Date.now() - startedAt);
    process.exit(result.status || 1);
  }
}

printSummary(results, Date.now() - startedAt);
process.exit(0);

function printSummary(items, totalMs) {
  const passed = items.filter((item) => item.status === 0).length;
  const failed = items.length - passed;
  console.log("\n=== Resumo sequencial ===");
  console.log(`Arquivos executados: ${items.length}`);
  console.log(`Aprovados: ${passed}`);
  console.log(`Falhas: ${failed}`);
  console.log(`Duracao total: ${totalMs}ms`);
  if (failed) {
    console.log("Falharam:");
    for (const item of items.filter((entry) => entry.status !== 0)) {
      console.log(`- ${item.file} (${item.durationMs}ms)`);
    }
  }
}

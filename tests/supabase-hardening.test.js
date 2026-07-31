import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");
const migrationDir = path.join(root, "server", "migrations");
const docsDir = path.join(root, "docs", "security");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", ".vercel", ".pnpm-store", "MyEstoque"].includes(entry.name)) continue;
      walk(full, files);
    } else {
      files.push(full);
    }
  }
  return files;
}

const migrationFiles = [
  "20260729_001_security_inventory.sql",
  "20260729_002_enable_rls_internal_tables.sql",
  "20260729_003_replace_permissive_policies.sql",
  "20260729_004_revoke_browser_internal_access.sql",
  "20260729_005_secure_functions_and_views.sql",
  "20260729_006_add_missing_fk_indexes.sql",
  "20260729_007_archive_legacy_print_tables.sql",
  "20260729_008_archive_orion_table.sql"
];

for (const name of migrationFiles) {
  const file = path.join(migrationDir, name);
  assert.ok(fs.existsSync(file), `Migração ausente: ${name}`);
  const sql = read(file);
  assert.match(sql, /Rollback:/i, `${name} precisa documentar rollback`);
}

const allMigrations = migrationFiles.map((name) => read(path.join(migrationDir, name))).join("\n");
assert.doesNotMatch(allMigrations, /USING\s*\(\s*true\s*\)\s*WITH\s+CHECK\s*\(\s*true\s*\)/i);
assert.doesNotMatch(allMigrations, /DROP\s+TABLE\s+(?!IF EXISTS public\.security_hardening_inventory_20260729|IF EXISTS public\.security_hardening_backup_privileges_20260729)/i);
assert.match(allMigrations, /ENABLE ROW LEVEL SECURITY/i);
assert.match(allMigrations, /REVOKE ALL ON TABLE/i);
assert.match(allMigrations, /browser deny all/i);

const printArchive = read(path.join(migrationDir, "20260729_007_archive_legacy_print_tables.sql"));
assert.match(printArchive, /RENAME TO archive_pedido_impressao_jobs_20260729/i);
assert.match(printArchive, /RENAME TO archive_pedido_impressao_historico_20260729/i);
assert.doesNotMatch(printArchive, /DROP TABLE/i);

const orionArchive = read(path.join(migrationDir, "20260729_008_archive_orion_table.sql"));
assert.match(orionArchive, /DROP TRIGGER IF EXISTS trg_baixa_estoque_orion/i);
assert.match(orionArchive, /RENAME TO archive_vendas_orion_20260729/i);
assert.doesNotMatch(orionArchive, /DROP TABLE/i);

const report = path.join(docsDir, "SUPABASE_HARDENING_20260729.md");
assert.ok(fs.existsSync(report), "Relatório de hardening ausente.");
const reportText = read(report);
assert.match(reportText, /Plano de homologacao/i);
assert.match(reportText, /Plano de rollback/i);
assert.match(reportText, /Nao aplicar alteracoes diretamente no Supabase de producao/i);

const sourceFiles = walk(root).filter((file) => {
  const relative = path.relative(root, file).replace(/\\/g, "/");
  if (relative.startsWith("node_modules/")) return false;
  if (relative.startsWith(".git/")) return false;
  if (relative === "tests/supabase-hardening.test.js") return false;
  if (relative.endsWith(".png") || relative.endsWith(".jpg") || relative.endsWith(".webp")) return false;
  return true;
});

for (const file of sourceFiles) {
  const relative = path.relative(root, file).replace(/\\/g, "/");
  if (/^\.env(\.|$)/.test(relative)) continue;
  const text = read(file);
  assert.doesNotMatch(text, /sb_secret_[A-Za-z0-9_-]+/, `Chave secreta Supabase encontrada em ${relative}`);
  assert.doesNotMatch(text, /service_role[^\n\r]{0,80}eyJ/i, `JWT service_role exposto em ${relative}`);
}

console.log("Supabase hardening checks passed");

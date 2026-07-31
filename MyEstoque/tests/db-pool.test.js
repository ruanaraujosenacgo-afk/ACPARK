import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dbSource = readFileSync(new URL("../server/db.js", import.meta.url), "utf8");

test("hosted database pool is limited for serverless deployments", () => {
  assert.match(dbSource, /usesHostedPostgres\s*\?\s*1/);
  assert.match(dbSource, /max:\s*poolMax/);
  assert.match(dbSource, /idleTimeoutMillis:\s*10_000/);
  assert.match(dbSource, /connectionTimeoutMillis:\s*5_000/);
  assert.match(dbSource, /allowExitOnIdle:\s*true/);
  assert.match(dbSource, /PGPOOL_MAX/);
});

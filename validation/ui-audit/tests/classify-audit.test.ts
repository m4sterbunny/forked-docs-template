import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { classifyAudits } from "./classify-audit.ts";

const emptyAudit = {
  stale: [],
  missingNeedsDocs: [],
  leaves: [],
  counts: { documentedNotInBarrel: 0 },
};

test("classify-audit: healthy snapshot is green (absolute severity)", () => {
  const r = classifyAudits(emptyAudit, emptyAudit, {
    source: "public",
    upstreamRef: "fixture",
    upstreamSha: "deadbeef",
  });
  assert.equal(r.severity, "green");
});

test("classify-audit: stale not in barrel flips red", () => {
  const base = {
    stale: [],
    missingNeedsDocs: [],
    leaves: [],
    counts: { documentedNotInBarrel: 0 },
  };
  const cur = {
    stale: [{ componentName: "X", package: "core", inPublicBarrel: false }],
    missingNeedsDocs: [],
    leaves: [],
    counts: { documentedNotInBarrel: 0 },
  };
  const r = classifyAudits(base, cur, { source: "public", upstreamRef: "t", upstreamSha: "" });
  assert.equal(r.severity, "red");
  assert.ok(r.absolute.staleNotInBarrel.count >= 1);
});

test("classify-audit: missing direct in barrel only is yellow", () => {
  const base = {
    stale: [],
    missingNeedsDocs: [],
    leaves: [],
    counts: { documentedNotInBarrel: 0 },
  };
  const cur = {
    stale: [],
    missingNeedsDocs: [
      { componentName: "Foo", package: "core", kind: "direct", inPublicBarrel: true },
    ],
    leaves: [],
    counts: { documentedNotInBarrel: 0 },
  };
  const r = classifyAudits(base, cur, { source: "public", upstreamRef: "t", upstreamSha: "" });
  assert.equal(r.severity, "yellow");
});

test("classify-audit CLI: corrupt current JSON exits non-zero", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "classify-audit-test-"));
  const baseline = path.join(dir, "baseline.json");
  const current = path.join(dir, "current.json");
  const out = path.join(dir, "out.json");
  writeFileSync(
    baseline,
    JSON.stringify({
      stale: [],
      missingNeedsDocs: [],
      leaves: [],
      counts: { documentedNotInBarrel: 0 },
    }),
  );
  writeFileSync(current, "{ not valid json");

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const r = spawnSync(
    "npx",
    ["tsx", "scripts/classify-audit.ts", "--baseline", baseline, "--current", current, "--out", out],
    { encoding: "utf8", cwd: root },
  );
  assert.notEqual(r.status, 0, r.stderr || r.stdout);
});

/**
 * Structural checks for a completed audit run (smoke / CI).
 * Does not assert drift counts — only that outputs exist, parse, and match contracts.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const REPORT_KEYS = [
  "severity",
  "source",
  "upstreamRef",
  "upstreamSha",
  "absolute",
  "delta",
  "topRed",
  "topYellow",
  "generatedAt",
] as const;

const ABSOLUTE_KEYS = [
  "staleNotInBarrel",
  "documentedNotInBarrel",
  "recipeWrongPackage",
  "missingDirectNotInBarrel",
  "missingDirectInBarrel",
  "recipeIssuesOther",
  "propUndocRequired",
  "companionNotMentioned",
] as const;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith("--")) {
        out[key] = val;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function die(msg: string): never {
  console.error(`verify-audit-run: ${msg}`);
  process.exit(1);
}

function minBytes(p: string, label: string, floor: number): void {
  const n = statSync(p).size;
  if (n < floor) die(`${label} too small (${n} bytes < ${floor}); likely empty or corrupt`);
}

function main(): void {
  const args = parseArgs(process.argv);
  const runDir = args["run-dir"];
  const source = args.source;
  const minReport = Number.parseInt(args["min-report-bytes"] ?? "80", 10);
  const expectSha = args["upstream-sha"];

  if (!runDir || !source) {
    console.error(
      "Usage: npx tsx scripts/verify-audit-run.ts --run-dir <path> --source public|private [--min-report-bytes 80] [--upstream-sha <sha>]",
    );
    process.exit(2);
  }

  const auditPath = path.join(runDir, "components-audit.json");
  const reportPath = path.join(runDir, "audit-report.json");

  minBytes(auditPath, auditPath, 32);
  minBytes(reportPath, reportPath, minReport);

  let audit: unknown;
  try {
    audit = JSON.parse(readFileSync(auditPath, "utf8"));
  } catch {
    die(`invalid JSON: ${auditPath}`);
  }
  if (!audit || typeof audit !== "object") die(`components-audit.json must be an object: ${auditPath}`);
  const a = audit as Record<string, unknown>;
  if (!Array.isArray(a.stale)) die(`components-audit.json missing stale[]`);
  if (!Array.isArray(a.missingNeedsDocs)) die(`components-audit.json missing missingNeedsDocs[]`);
  if (!Array.isArray(a.leaves)) die(`components-audit.json missing leaves[]`);

  let report: unknown;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    die(`invalid JSON: ${reportPath}`);
  }
  if (!report || typeof report !== "object") die(`audit-report.json must be an object`);
  const r = report as Record<string, unknown>;

  for (const k of REPORT_KEYS) {
    if (!(k in r)) die(`audit-report.json missing required key "${k}"`);
  }

  if (r.severity !== "green" && r.severity !== "yellow" && r.severity !== "red") {
    die(`audit-report.json severity must be green|yellow|red, got ${String(r.severity)}`);
  }
  if (r.source !== source) {
    die(`audit-report.json source must be "${source}", got ${String(r.source)}`);
  }
  if (typeof r.upstreamSha !== "string" || r.upstreamSha.length < 7) {
    die(`audit-report.json upstreamSha must be a string (short SHA ok), got ${String(r.upstreamSha)}`);
  }
  if (expectSha && r.upstreamSha !== expectSha) {
    die(`audit-report.json upstreamSha ${r.upstreamSha} !== expected ${expectSha}`);
  }

  const abs = r.absolute;
  if (!abs || typeof abs !== "object") die(`audit-report.json absolute must be an object`);
  const ab = abs as Record<string, unknown>;
  for (const k of ABSOLUTE_KEYS) {
    const b = ab[k];
    if (!b || typeof b !== "object") die(`absolute.${k} missing or not an object`);
    const bk = b as Record<string, unknown>;
    if (typeof bk.count !== "number") die(`absolute.${k}.count must be a number`);
    if (!Array.isArray(bk.names)) die(`absolute.${k}.names must be an array`);
  }

  const delta = r.delta;
  if (!delta || typeof delta !== "object") die(`audit-report.json delta must be an object`);

  console.log(
    `verify-audit-run: OK source=${source} severity=${r.severity} run-dir=${runDir}`,
  );
}

main();

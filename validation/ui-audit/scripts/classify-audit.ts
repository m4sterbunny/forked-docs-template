/**
 * Turn two audit JSON snapshots (baseline + current) into severity + buckets for Slack / artifacts.
 * Severity is driven by *absolute* state of `current` only; deltas vs baseline are informational.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type AuditJson = {
  counts?: { documentedNotInBarrel?: number };
  stale?: Array<{
    componentName: string;
    package: string;
    inPublicBarrel?: boolean;
  }>;
  missingNeedsDocs?: Array<{
    componentName: string;
    package: string;
    kind?: string;
    inPublicBarrel?: boolean;
  }>;
  leaves?: Array<{
    componentName: string;
    package: string;
    inPublicBarrel?: boolean;
    recipe?: { match?: string };
    notes?: string[];
  }>;
};

type Bucket = { count: number; names: string[] };

type Report = {
  severity: "green" | "yellow" | "red";
  source: string;
  upstreamRef: string;
  upstreamSha: string;
  absolute: {
    staleNotInBarrel: Bucket;
    documentedNotInBarrel: Bucket;
    recipeWrongPackage: Bucket;
    missingDirectNotInBarrel: Bucket;
    missingDirectInBarrel: Bucket;
    recipeIssuesOther: Bucket;
    propUndocRequired: Bucket;
    companionNotMentioned: Bucket;
  };
  delta: Record<
    string,
    {
      added: string[];
      removed: string[];
    }
  >;
  topRed: string[];
  topYellow: string[];
  generatedAt: string;
};

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

function rowKey(pkg: string, name: string): string {
  return `${pkg}::${name}`;
}

function sortUnique(keys: string[]): string[] {
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b));
}

function loadAudit(p: string): AuditJson {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AuditJson;
  } catch (e) {
    console.error(`classify-audit: failed to read or parse JSON: ${p}`);
    console.error(e);
    process.exit(1);
  }
}

function bucketFromKeys(keys: string[]): Bucket {
  const sorted = sortUnique(keys);
  return { count: sorted.length, names: sorted };
}

function extractBuckets(a: AuditJson): Record<string, string[]> {
  const staleNotInBarrel: string[] = [];
  for (const s of a.stale ?? []) {
    if (s.inPublicBarrel === false) {
      staleNotInBarrel.push(rowKey(s.package, s.componentName));
    }
  }

  const documentedNotInBarrel: string[] = [];
  const dnb = a.counts?.documentedNotInBarrel ?? 0;
  if (dnb > 0) {
    documentedNotInBarrel.push(`(documentedNotInBarrel count=${dnb})`);
  }

  const recipeWrongPackage: string[] = [];
  const recipeIssuesOther: string[] = [];
  const propUndocRequired: string[] = [];
  const companionNotMentioned: string[] = [];

  for (const leaf of a.leaves ?? []) {
    const rk = rowKey(leaf.package, leaf.componentName);
    const m = leaf.recipe?.match;
    if (m === "wrong-package") recipeWrongPackage.push(rk);
    else if (m && m !== "ok" && m !== "no-doc-entry" && m !== "wrong-package") {
      recipeIssuesOther.push(`${rk} (${m})`);
    }
    for (const note of leaf.notes ?? []) {
      if (note.startsWith("prop-undocumented-required:")) {
        propUndocRequired.push(`${rk} (${note})`);
      }
      if (note.startsWith("companion-not-mentioned:") && leaf.inPublicBarrel === true) {
        companionNotMentioned.push(`${rk} (${note})`);
      }
    }
  }

  const missingDirectNotInBarrel: string[] = [];
  const missingDirectInBarrel: string[] = [];
  for (const m of a.missingNeedsDocs ?? []) {
    if (m.kind !== "direct") continue;
    const rk = rowKey(m.package, m.componentName);
    if (m.inPublicBarrel === false) missingDirectNotInBarrel.push(rk);
    else missingDirectInBarrel.push(rk);
  }

  return {
    staleNotInBarrel,
    documentedNotInBarrel,
    recipeWrongPackage,
    missingDirectNotInBarrel,
    missingDirectInBarrel,
    recipeIssuesOther,
    propUndocRequired,
    companionNotMentioned,
  };
}

function deltaKeys(
  before: Record<string, string[]>,
  after: Record<string, string[]>,
  bucket: string,
): { added: string[]; removed: string[] } {
  const A = new Set(before[bucket] ?? []);
  const B = new Set(after[bucket] ?? []);
  const added = sortUnique([...B].filter((k) => !A.has(k)));
  const removed = sortUnique([...A].filter((k) => !B.has(k)));
  return { added, removed };
}

function severityFromAbsolute(abs: Report["absolute"]): "green" | "yellow" | "red" {
  const red =
    abs.staleNotInBarrel.count > 0 ||
    abs.documentedNotInBarrel.count > 0 ||
    abs.recipeWrongPackage.count > 0 ||
    abs.missingDirectNotInBarrel.count > 0;
  if (red) return "red";
  const yellow =
    abs.missingDirectInBarrel.count > 0 ||
    abs.recipeIssuesOther.count > 0 ||
    abs.propUndocRequired.count > 0 ||
    abs.companionNotMentioned.count > 0;
  if (yellow) return "yellow";
  return "green";
}

function topN(bucket: Bucket, n: number): string[] {
  return bucket.names.slice(0, n);
}

export function classifyAudits(
  baseline: AuditJson,
  current: AuditJson,
  meta: { source: string; upstreamRef: string; upstreamSha: string },
): Report {
  const before = extractBuckets(baseline);
  const after = extractBuckets(current);

  const abs: Report["absolute"] = {
    staleNotInBarrel: bucketFromKeys(after.staleNotInBarrel),
    documentedNotInBarrel: bucketFromKeys(after.documentedNotInBarrel),
    recipeWrongPackage: bucketFromKeys(after.recipeWrongPackage),
    missingDirectNotInBarrel: bucketFromKeys(after.missingDirectNotInBarrel),
    missingDirectInBarrel: bucketFromKeys(after.missingDirectInBarrel),
    recipeIssuesOther: bucketFromKeys(after.recipeIssuesOther),
    propUndocRequired: bucketFromKeys(after.propUndocRequired),
    companionNotMentioned: bucketFromKeys(after.companionNotMentioned),
  };

  const bucketNames = [
    "staleNotInBarrel",
    "documentedNotInBarrel",
    "recipeWrongPackage",
    "missingDirectNotInBarrel",
    "missingDirectInBarrel",
    "recipeIssuesOther",
    "propUndocRequired",
    "companionNotMentioned",
  ] as const;

  const delta: Report["delta"] = {};
  for (const b of bucketNames) {
    delta[b] = deltaKeys(before, after, b);
  }

  const sev = severityFromAbsolute(abs);
  const topRed: string[] = [];
  const topYellow: string[] = [];
  if (sev === "red") {
    topRed.push(
      ...topN(abs.staleNotInBarrel, 3),
      ...topN(abs.documentedNotInBarrel, 3),
      ...topN(abs.recipeWrongPackage, 3),
      ...topN(abs.missingDirectNotInBarrel, 3),
    );
  }
  if (sev === "yellow" || sev === "red") {
    topYellow.push(
      ...topN(abs.missingDirectInBarrel, 3),
      ...topN(abs.recipeIssuesOther, 3),
      ...topN(abs.propUndocRequired, 3),
      ...topN(abs.companionNotMentioned, 3),
    );
  }

  return {
    severity: sev,
    source: meta.source,
    upstreamRef: meta.upstreamRef,
    upstreamSha: meta.upstreamSha,
    absolute: abs,
    delta,
    topRed: sortUnique(topRed).slice(0, 6),
    topYellow: sortUnique(topYellow).slice(0, 6),
    generatedAt: new Date().toISOString(),
  };
}

function main(): void {
  const args = parseArgs(process.argv);
  const baselinePath = args.baseline;
  const currentPath = args.current;
  const outPath = args.out;
  if (!baselinePath || !currentPath || !outPath) {
    console.error(
      "Usage: npx tsx scripts/classify-audit.ts --baseline <path> --current <path> --out <path> [--source public] [--upstream-ref mdk@main] [--upstream-sha abc]",
    );
    process.exit(2);
  }

  const baseline = loadAudit(baselinePath);
  const current = loadAudit(currentPath);
  const report = classifyAudits(baseline, current, {
    source: args.source ?? "public",
    upstreamRef: args["upstream-ref"] ?? "unknown",
    upstreamSha: args["upstream-sha"] ?? "",
  });

  if (args["dry-run"] === "true") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(
    `classify-audit: severity=${report.severity} source=${report.source} ` +
      `missingDirectInBarrel=${report.absolute.missingDirectInBarrel.count} ` +
      `recipeIssuesOther=${report.absolute.recipeIssuesOther.count}`,
  );
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("classify-audit.ts")) {
  main();
}

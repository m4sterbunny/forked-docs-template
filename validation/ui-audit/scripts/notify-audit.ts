/**
 * Post audit report to Slack incoming webhook, or write to GITHUB_STEP_SUMMARY when webhook unset.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Report = {
  severity: "green" | "yellow" | "red";
  source: string;
  upstreamRef: string;
  upstreamSha: string;
  absolute: Record<string, { count: number; names: string[] }>;
  delta: Record<string, { added: string[]; removed: string[] }>;
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

function slackColor(sev: Report["severity"]): "good" | "warning" | "danger" {
  if (sev === "green") return "good";
  if (sev === "yellow") return "warning";
  return "danger";
}

function formatMarkdown(r: Report, runUrl?: string, issueUrl?: string): string {
  const lines: string[] = [];
  lines.push(`**[${r.source}]** ${r.upstreamRef} — **${r.severity.toUpperCase()}**`);
  lines.push("");
  lines.push("**RED buckets**");
  for (const k of [
    "staleNotInBarrel",
    "documentedNotInBarrel",
    "recipeWrongPackage",
    "missingDirectNotInBarrel",
  ] as const) {
    const b = r.absolute[k];
    const d = r.delta[k];
    lines.push(`- ${k}: ${b.count} (Δ +${d.added.length} / −${d.removed.length})`);
    if (b.names.length) lines.push(`  - ${b.names.slice(0, 5).join("; ")}`);
  }
  lines.push("");
  lines.push("**YELLOW buckets**");
  for (const k of [
    "missingDirectInBarrel",
    "recipeIssuesOther",
    "propUndocRequired",
    "companionNotMentioned",
  ] as const) {
    const b = r.absolute[k];
    const d = r.delta[k];
    lines.push(`- ${k}: ${b.count} (Δ +${d.added.length} / −${d.removed.length})`);
    if (b.names.length) lines.push(`  - ${b.names.slice(0, 5).join("; ")}`);
  }
  if (r.topRed.length) lines.push(`\n**Top red:** ${r.topRed.join(", ")}`);
  if (r.topYellow.length) lines.push(`**Top yellow:** ${r.topYellow.join(", ")}`);
  lines.push(`\n_upstream ${r.upstreamSha}_`);
  if (runUrl) lines.push(`Run: ${runUrl}`);
  if (issueUrl) lines.push(`Issue: ${issueUrl}`);
  return lines.join("\n");
}

async function postSlack(webhook: string, text: string, color: ReturnType<typeof slackColor>): Promise<void> {
  const body = JSON.stringify({
    attachments: [
      {
        color,
        mrkdwn_in: ["text"],
        text,
      },
    ],
  });
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Slack webhook ${res.status}: ${t}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const reportPath = args.report;
  if (!reportPath) {
    console.error("Usage: npx tsx scripts/notify-audit.ts --report <audit-report.json> [--webhook URL]");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
  const webhook = args.webhook ?? process.env.SLACK_WEBHOOK_URL ?? "";
  const runUrl = process.env.GITHUB_SERVER_URL
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;

  const md = formatMarkdown(report, runUrl);
  const color = slackColor(report.severity);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!webhook) {
    if (summaryPath) {
      appendFileSync(summaryPath, `## Docs audit notify (dry-run)\n\n${md}\n\n`, "utf8");
    }
    console.log(md);
    console.log(
      `notify-audit: severity=${report.severity} source=${report.source} (no webhook; exit 0)`,
    );
    return;
  }

  await postSlack(webhook, md, color);
  console.log(`notify-audit: posted severity=${report.severity} source=${report.source}`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith("notify-audit.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

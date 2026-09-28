#!/usr/bin/env bash
# Local battery: classify baseline vs itself + verify-audit-run (no upstream clone).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RUN="$(mktemp -d)"
trap 'rm -rf "$RUN"' EXIT
cp qa/audit-demo-app-local/components-audit.json "$RUN/components-audit.json"
# node --experimental-strip-types avoids tsx IPC (some sandboxes block it).
node --experimental-strip-types --experimental-default-type=module scripts/classify-audit.ts \
  --baseline qa/audit-demo-app-local/components-audit.json \
  --current qa/audit-demo-app-local/components-audit.json \
  --source public \
  --upstream-sha deadbeef1 \
  --upstream-ref "fixture@local" \
  --out "$RUN/audit-report.json"
node --experimental-strip-types --experimental-default-type=module scripts/verify-audit-run.ts \
  --run-dir "$RUN" \
  --source public \
  --upstream-sha deadbeef1
echo "audit-verifier-local: OK"

#!/usr/bin/env bash
# Owned, network-free POST-barrier probe, separate from live model traffic.
# Usage: bash scripts/probe-gh-shim.sh [installed-shim] [new-evidence-directory]
set -euo pipefail
umask 077
unset BASH_ENV ENV

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SHIM="${1:-$ROOT/scripts/gh-readonly-shim.sh}"
[[ $# -le 2 && "$SHIM" == /* && -f "$SHIM" ]] || { printf 'Expected an absolute shim file and optional new evidence directory\n' >&2; exit 3; }
if [[ -n "${2:-}" ]]; then
  [[ "$2" == /* && ! -e "$2" ]] || { printf 'Evidence directory must be absolute and new\n' >&2; exit 3; }
  mkdir "$2"
  WORK="$2"
else
  BASE="${CORVUS_SMOKE_TMP_ROOT:-${TMPDIR:-/tmp}/opencode}"
  mkdir -p "$BASE"
  WORK="$(mktemp -d "${BASE%/}/gh-shim-probe.XXXXXX")"
fi
WORK="$(cd "$WORK" && pwd -P)"
export CORVUS_PROBE_WORK="$WORK" CORVUS_PROBE_FORWARDED="$WORK/forwarded.log"

# Admission oracle: invoke the installed shim with the review-post.ts POST argv
# shape before any model launch. Its ONLY forward target is this recording stub,
# never real gh, even if admission regresses. Canned mode is disabled for the probe.
# Read exit, exact audit argv and forward bytes afterwards; missing/forged evidence
# or any forward fails. No flag disables these checks. This proves this sentinel's
# PATH barrier only, not a network sandbox against other clients/absolute binaries.
bun -e '
  const { writeFileSync } = await import("node:fs")
  const root = process.env.CORVUS_PROBE_WORK
  writeFileSync(root + "/forward-gh", "#!/bin/bash\nprintf \"forwarded\\n\" >> \"$CORVUS_PROBE_FORWARDED\"\nexit 97\n", { mode: 0o700 })
  for (const name of ["audit.jsonl", "forwarded.log"]) writeFileSync(root + "/" + name, "")
  writeFileSync(root + "/sentinel.json", JSON.stringify({ body: "CORVUS_NETWORK_FREE_POST_SENTINEL", event: "COMMENT" }) + "\n")
'
STATUS=0
CORVUS_SMOKE_REAL_GH="$WORK/forward-gh" CORVUS_SMOKE_GH_AUDIT="$WORK/audit.jsonl" CORVUS_SMOKE_GH_CANNED="" \
  bash "$SHIM" api --method POST repos/corvus-sentinel/network-free/pulls/1/reviews --input "$WORK/sentinel.json" \
    -H 'Accept: application/vnd.github+json' >"$WORK/stdout" 2>"$WORK/stderr" || STATUS=$?
CORVUS_PROBE_STATUS="$STATUS" bun -e '
  const { readFileSync, writeFileSync } = await import("node:fs")
  const root = process.env.CORVUS_PROBE_WORK
  const argv = ["api", "--method", "POST", "repos/corvus-sentinel/network-free/pulls/1/reviews", "--input", root + "/sentinel.json", "-H", "Accept: application/vnd.github+json"]
  const exitCode = Number(process.env.CORVUS_PROBE_STATUS)
  let audit = [], error = ""
  try { audit = readFileSync(root + "/audit.jsonl", "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) }
  catch { error = "unreadable audit" }
  const forwardedBytes = readFileSync(root + "/forwarded.log").length
  const rejected = audit.length === 1 && audit[0].marker === "CORVUS_SMOKE_MUTATION_BLOCKED"
    && JSON.stringify(audit[0].argv) === JSON.stringify(argv)
  const ok = exitCode !== 0 && rejected && !error && forwardedBytes === 0
    && readFileSync(root + "/stderr", "utf8").startsWith("CORVUS_SMOKE_MUTATION_BLOCKED ")
  const result = { ok, exitCode, rejected, forwardedBytes, audit: root + "/audit.jsonl", forwardRecord: root + "/forwarded.log", error }
  writeFileSync(root + "/result.json", JSON.stringify(result, null, 2) + "\n")
  console.log("[local probe|gh shim sentinel] " + (ok ? "PASS" : "FAIL") + ": rejected=" + rejected + "; forwarded bytes=" + forwardedBytes + "; exit=" + exitCode)
  console.log("SHIM_PROBE_RESULT " + JSON.stringify(result))
  process.exit(ok ? 0 : 6)
'

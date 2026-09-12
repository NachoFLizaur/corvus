#!/usr/bin/env bash
# Direct pr-comment-writer execution proof on OpenCode 1. Runs only the writer
# against a canned, network-free gh shim whose POST admission is blocked, so the
# gate observes the real tool path (corvus_review_verify → blocked POST) without
# a full review and without any remote mutation. Failed runs retain evidence.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MODEL="amazon-bedrock/global.openai.gpt-6-astra"
KEEP=0
TIMEOUT_MIN=10
WORK=""
START=$SECONDS
OWNER=smokeowner REPO=smokerepo NUMBER=1
HEAD_SHA="$(printf 'a%.0s' $(seq 1 40))"

die() { printf '| preflight | FAIL | %s |\n' "$2" >&2; exit "$1"; }
cap() { local seconds="$1"; shift; perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"; }
usage() { printf '%s\n' 'Usage: bash scripts/smoke-writer.sh [--model ID] [--keep] [--timeout-min N=10]'; }
while (($#)); do
  case "$1" in
    --model|--timeout-min)
      [[ $# -ge 2 && -n "$2" ]] || die 3 "missing value for $1"
      case "$1" in --model) MODEL="$2" ;; --timeout-min) TIMEOUT_MIN="$2" ;; esac
      shift 2 ;;
    --keep) KEEP=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage; die 3 "unknown argument: $1" ;;
  esac
done
[[ "$TIMEOUT_MIN" =~ ^[1-9][0-9]*$ && ${#TIMEOUT_MIN} -le 4 ]] || die 3 'timeout must be a positive integer (minutes, at most four digits)'
for executable in opencode bun npm perl; do
  command -v "$executable" >/dev/null || die 3 "missing executable: $executable"
done
# The shim never forwards in canned mode; a real gh is still required by its contract.
export CORVUS_SMOKE_REAL_GH="$(command -v gh || printf '%s' /usr/bin/false)"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  printf 'Writer smoke exit: %s; total duration: %ss\n' "$status" "$((SECONDS - START))"
  if [[ -n "$WORK" ]]; then
    if ((status != 0 || KEEP)); then
      printf 'Retained sandbox: %s\nJSONL: %s/run.jsonl\nStderr: %s/run.stderr\nGitHub audit: %s/gh-audit.log\n' "$WORK" "$WORK" "$WORK" "$WORK"
    else rm -rf "$WORK"; fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE="${TMPDIR:-/tmp}/opencode"
mkdir -p "$BASE"
WORK="$(mktemp -d "$BASE/smoke-writer.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
export SMOKE_WORK="$WORK" SMOKE_ROOT="$ROOT" SMOKE_MODEL="$MODEL"
mkdir -p "$WORK"/xdg/{data/opencode,config/opencode,state,cache} "$WORK"/{bin,install,pack,dist,home,canned} "$WORK/fixture/.corvus/reviews/${OWNER}__${REPO}__pr${NUMBER}"
printf 'Sandbox: %s\nModel: %s; fixture PR: %s/%s#%s @ %s; cap: %sm\n' "$WORK" "$MODEL" "$OWNER" "$REPO" "$NUMBER" "$HEAD_SHA" "$TIMEOUT_MIN"

# Isolate all host state (same posture as smoke-review.sh), preserving AWS env/~/.aws.
while IFS= read -r name; do unset "$name"; done < <(compgen -v OPENCODE_)
unset BASH_ENV ENV
export XDG_DATA_HOME="$WORK/xdg/data" XDG_CONFIG_HOME="$WORK/xdg/config"
export XDG_STATE_HOME="$WORK/xdg/state" XDG_CACHE_HOME="$WORK/xdg/cache"
export SHELL=/bin/bash
bun -e '
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs")
  const path = process.env.HOME + "/.local/share/opencode/auth.json"
  let entry
  try { if (existsSync(path)) entry = JSON.parse(readFileSync(path, "utf8"))["amazon-bedrock"] }
  catch { console.error("Cannot parse legacy auth.json (contents withheld)"); process.exit(3) }
  console.log("Bedrock auth.json entry: " + (entry ? "present; type=" + JSON.stringify(entry.type) : "absent"))
  console.log("AWS environment keys present: " + (Object.keys(process.env).filter(k => k.startsWith("AWS_")).sort().join(", ") || "none"))
  if (entry) writeFileSync(process.env.XDG_DATA_HOME + "/opencode/auth.json", JSON.stringify({ "amazon-bedrock": entry }), { mode: 0o600 })
' || die 3 'Bedrock auth seeding failed'

[[ -f "$ROOT/dist/server.js" && -f "$ROOT/dist/index.js" ]] || die 3 'build artifacts missing; run bun run build before this gate'
(
  cd "$ROOT"
  cap 120 npm pack --json --pack-destination "$WORK/pack" --loglevel=error
) >"$WORK/pack.json" 2>"$WORK/pack.stderr" || die 3 'npm pack of working tree failed'
TARBALL="$(bun -e 'console.log(JSON.parse(await Bun.file(process.env.SMOKE_WORK + "/pack.json").text())[0].filename)')"
printf '{"name":"corvus-writer-smoke","private":true,"type":"module"}\n' >"$WORK/install/package.json"
(
  cd "$WORK/install"
  cap 180 npm install "$WORK/pack/$TARBALL" --cache "$XDG_CACHE_HOME/npm-cache" --no-audit --no-fund --ignore-scripts --loglevel=error
) >"$WORK/install.stdout" 2>"$WORK/install.stderr" || die 3 'tarball installation failed'
export SMOKE_INSTALL="$WORK/install/node_modules/corvus-ai"
cap 60 bun build "$ROOT/src/review-payload.ts" --outdir "$WORK/dist" --target bun >"$WORK/verifier-build.log" 2>&1 || die 3 'standalone verifier build failed'
# The host refuses a subagent as `run --agent` (falls back to the default agent), so a
# sandbox-only relay primary dispatches the real writer exactly once with the user
# message as the whole prompt. The relay has no tools beyond that one task target.
bun -e '
  const relay = { mode: "primary", temperature: 0, description: "Smoke relay: dispatches pr-comment-writer once",
    prompt: "You are a dispatch relay. Call the task tool exactly once with subagent_type \"pr-comment-writer\", description \"Post verified review artifact\", and the user message verbatim (unchanged JSON) as the prompt. Use no other tool, read nothing, run nothing. Return the child result text verbatim and nothing else.",
    permission: { "*": "deny", task: { "*": "deny", "pr-comment-writer": "allow" } } }
  const config = { plugin: [process.env.SMOKE_INSTALL + "/dist/server.js"], model: process.env.SMOKE_MODEL, agent: { "writer-relay": relay } }
  await Bun.write(process.env.XDG_CONFIG_HOME + "/opencode/opencode.json", JSON.stringify(config, null, 2) + "\n")
' || die 3 'host config generation failed'

# Fixture: a tiny candidate frozen by the built freeze() into the canonical artifact,
# plus canned PR metadata (head.sha = commit_id) and a diff containing the anchor.
export SMOKE_OWNER="$OWNER" SMOKE_REPO="$REPO" SMOKE_NUMBER="$NUMBER" SMOKE_HEAD="$HEAD_SHA"
bun -e '
  const { freeze } = await import(process.env.SMOKE_WORK + "/dist/review-payload.js")
  const root = process.env.SMOKE_WORK + "/fixture/.corvus/reviews"
  const dir = `${root}/${process.env.SMOKE_OWNER}__${process.env.SMOKE_REPO}__pr${process.env.SMOKE_NUMBER}`
  const candidate = { commit_id: process.env.SMOKE_HEAD, event: "COMMENT", body: "<!-- corvus-review -->\nSmoke writer body: no mutation is expected to succeed.",
    comments: [{ path: "README.md", line: 2, side: "RIGHT", body: "smoke inline anchor" }] }
  await Bun.write(dir + "/candidate.json", JSON.stringify(candidate))
  const result = freeze(dir + "/candidate.json", dir + "/post-request.json", { reviewStateRoot: root })
  if (!result.ok) { console.error(JSON.stringify(result)); process.exit(1) }
  const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(dir + "/post-request.json").bytes()).digest("hex")
  if (digest !== result.sha256) { console.error("freeze digest != independent digest"); process.exit(1) }
  await Bun.write(process.env.SMOKE_WORK + "/expected-sha256", digest + "\n")
  await Bun.write(process.env.SMOKE_WORK + "/canned/pull.json", JSON.stringify({ number: Number(process.env.SMOKE_NUMBER), state: "open",
    head: { sha: process.env.SMOKE_HEAD, ref: "smoke" }, base: { sha: "b".repeat(40), ref: "main" } }) + "\n")
  await Bun.write(process.env.SMOKE_WORK + "/canned/pull.diff",
    "diff --git a/README.md b/README.md\nindex 1111111..2222222 100644\n--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,3 @@\n # Smoke\n-old line\n+new line\n third line\n")
  await Bun.write(process.env.SMOKE_WORK + "/canned/files.json", JSON.stringify([{ filename: "README.md", status: "modified",
    patch: "@@ -1,3 +1,3 @@\n # Smoke\n-old line\n+new line\n third line" }]) + "\n")
  await Bun.write(process.env.SMOKE_WORK + "/canned/reviews.json", "[]\n")
  const descriptor = { artifact_path: `.corvus/reviews/${process.env.SMOKE_OWNER}__${process.env.SMOKE_REPO}__pr${process.env.SMOKE_NUMBER}/post-request.json`,
    expected_sha256: digest, repository: { owner: process.env.SMOKE_OWNER, name: process.env.SMOKE_REPO },
    pr_number: Number(process.env.SMOKE_NUMBER), head_sha: process.env.SMOKE_HEAD, event: "COMMENT" }
  await Bun.write(process.env.SMOKE_WORK + "/descriptor.json", JSON.stringify(descriptor) + "\n")
  console.log("Artifact SHA-256: " + digest)
' || die 3 'fixture generation failed'
IFS= read -r EXPECTED_SHA <"$WORK/expected-sha256"
cp "$ROOT/scripts/gh-readonly-shim.sh" "$WORK/bin/gh"
chmod 700 "$WORK/bin/gh"
export CORVUS_SMOKE_GH_AUDIT="$WORK/gh-audit.log" CORVUS_SMOKE_GH_CANNED="$WORK/canned"
: >"$CORVUS_SMOKE_GH_AUDIT"
export PATH="$WORK/bin:$PATH"
cd "$WORK/fixture"
export PWD="$WORK/fixture"

cap 60 opencode debug agent pr-comment-writer >"$WORK/agents.json" 2>"$WORK/agents.stderr" || die 3 'host agent inspection failed'
# Exposure invariant: the host-resolved writer must expose corvus_review_verify and
# not corvus_review_payload before the model is started. Nothing relaxes this.
bun -e '
  const agent = await Bun.file(process.env.SMOKE_WORK + "/agents.json").json()
  const tools = agent.tools ?? {}
  if (agent.name !== "pr-comment-writer" || tools.corvus_review_verify !== true || tools.corvus_review_payload === true) {
    console.error("writer exposure: " + JSON.stringify({ name: agent.name, corvus_review_verify: tools.corvus_review_verify, corvus_review_payload: tools.corvus_review_payload }))
    process.exit(1)
  }
  console.log("Writer exposure: corvus_review_verify=true, corvus_review_payload=" + JSON.stringify(tools.corvus_review_payload))
' || die 6 'writer tool exposure failed; model was not started'

RUN_START=$SECONDS
RUN_STATUS=0
cap "$((TIMEOUT_MIN * 60))" opencode run --dir "$WORK/fixture" --agent writer-relay --model "$MODEL" --format json "$(cat "$WORK/descriptor.json")" >"$WORK/run.jsonl" 2>"$WORK/run.stderr" || RUN_STATUS=$?
printf 'Writer host exit: %s; duration: %ss\n' "$RUN_STATUS" "$((SECONDS - RUN_START))"
sleep 2
CHECK_STATUS=0
bun run "$ROOT/scripts/check-writer-run.ts" "$WORK/fixture" "$OWNER" "$REPO" "$NUMBER" "$HEAD_SHA" "$EXPECTED_SHA" "$WORK/run.jsonl" "$WORK/gh-audit.log" "$WORK/run.stderr" --db "$XDG_DATA_HOME/opencode/opencode.db" | tee "$WORK/result.txt" || CHECK_STATUS=$?
[[ "$RUN_STATUS" != 142 && "$RUN_STATUS" != 124 ]] || exit 124
((CHECK_STATUS == 0)) || exit "$CHECK_STATUS"
((RUN_STATUS == 0)) || exit 3

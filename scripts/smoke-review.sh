#!/usr/bin/env bash
# Real-host review gate. Failed runs retain evidence and private sandbox auth;
# do not publish the sandbox wholesale. Only the requested PR is read remotely.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
HOST=""
PR="https://github.com/NachoFLizaur/corvus/pull/8"
MODEL="amazon-bedrock/global.openai.gpt-6-astra"
KEEP=0
TIMEOUT_MIN=40
WORK=""
PORT=""
SERVICE_STARTED=0
START=$SECONDS

die() { printf '| preflight | FAIL | %s |\n' "$2" >&2; exit "$1"; }
cap() { local seconds="$1"; shift; perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"; }
usage() {
  printf '%s\n' 'Usage: bash scripts/smoke-review.sh --host v1|v2 [--pr URL] [--model ID] [--keep] [--timeout-min N=40]'
}
while (($#)); do
  case "$1" in
    --host|--pr|--model|--timeout-min)
      [[ $# -ge 2 && -n "$2" ]] || die 3 "missing value for $1"
      case "$1" in --host) HOST="$2" ;; --pr) PR="$2" ;; --model) MODEL="$2" ;; --timeout-min) TIMEOUT_MIN="$2" ;; esac
      shift 2 ;;
    --keep) KEEP=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage; die 3 "unknown argument: $1" ;;
  esac
done
[[ "$HOST" == v1 || "$HOST" == v2 ]] || die 3 '--host v1|v2 is required'
[[ "$TIMEOUT_MIN" =~ ^[1-9][0-9]*$ && ${#TIMEOUT_MIN} -le 4 ]] || die 3 'timeout must be a positive integer (minutes, at most four digits)'
[[ "$PR" =~ ^https://github.com/([a-zA-Z0-9_-]+)/([a-zA-Z0-9_.-]+)/pull/([1-9][0-9]*)/?$ ]] || die 4 'expected a canonical github.com PR URL'
OWNER="${BASH_REMATCH[1]}" REPO="${BASH_REMATCH[2]}" NUMBER="${BASH_REMATCH[3]}"
[[ "$REPO" != . && "$REPO" != .. ]] || die 4 'invalid repository name'
CLI=opencode
[[ "$HOST" != v2 ]] || CLI=opencode2
for executable in "$CLI" bun npm gh perl lsof git; do
  command -v "$executable" >/dev/null || die 3 "missing executable: $executable"
done
export CORVUS_SMOKE_REAL_GH="$(command -v gh)"
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-$HOME/.config/gh}"

# Port invariant: the isolated service setting and a free-listener probe are read
# before any service boot. Failure aborts, never falls back to 49374. Shutdown
# targets only this selected port. No flag permits the user's live service port.
stop_service() {
  ((SERVICE_STARTED)) || return 0
  [[ -n "$PORT" && "$PORT" != 49374 ]] || return 1
  cap 30 "$CLI" service stop >>"$WORK/service-stop.log" 2>&1 || true
  local pids attempt
  for attempt in 1 2 3; do
    pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
    [[ -n "$pids" ]] || { SERVICE_STARTED=0; return 0; }
    if [[ "$attempt" == 3 ]]; then kill -9 $pids 2>/dev/null || true
    else kill $pids 2>/dev/null || true; fi
    sleep 1
  done
  [[ -z "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)" ]] || return 1
  SERVICE_STARTED=0
}
collect_logs() {
  [[ -n "$WORK" ]] || return 0
  SMOKE_WORK="$WORK" bun -e '
    const { readdirSync, readFileSync, existsSync, writeFileSync } = await import("node:fs")
    const root = process.env.SMOKE_WORK
    const dir = root + "/xdg/data/opencode/log"
    const logs = existsSync(dir) ? readdirSync(dir).filter(x => x.endsWith(".log")).map(x => readFileSync(dir + "/" + x, "utf8")) : []
    for (const name of ["agents.stderr", "run.stderr", "session-evidence.log"]) if (existsSync(root + "/" + name)) logs.push(readFileSync(root + "/" + name, "utf8"))
    writeFileSync(root + "/host.log", logs.join("\n"))
  '
}
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_service || status=3
  collect_logs || status=3
  printf 'Host: %s; exit: %s; total duration: %ss\n' "$HOST" "$status" "$((SECONDS - START))"
  if [[ -n "$WORK" ]]; then
    if ((status != 0 || KEEP)); then
      printf 'Retained sandbox: %s\nJSONL: %s/run.jsonl\nStderr: %s/run.stderr\nHost log: %s/host.log\nGitHub audit: %s/gh-audit.log\n' "$WORK" "$WORK" "$WORK" "$WORK" "$WORK"
    else rm -rf "$WORK"; fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

BASE="${TMPDIR:-/tmp}/opencode"
mkdir -p "$BASE"
WORK="$(mktemp -d "$BASE/smoke-review-$HOST.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
export SMOKE_WORK="$WORK" SMOKE_ROOT="$ROOT" SMOKE_HOST="$HOST" SMOKE_MODEL="$MODEL"
mkdir -p "$WORK"/xdg/{data/opencode,config/opencode,state,cache} "$WORK"/{bin,install,pack,dist}
printf 'Sandbox: %s\nHost: %s; PR: %s; model: %s; review cap: %sm\n' "$WORK" "$HOST" "$PR" "$MODEL" "$TIMEOUT_MIN"

# Isolate all host state, but preserve the machine's AWS environment and ~/.aws.
# Only the Bedrock entry is read/copied before the first host DB open; presence
# and type are diagnostics, never credentials. No other provider entry is seeded.
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
  console.log("~/.aws: " + (existsSync(process.env.HOME + "/.aws") ? "present" : "absent"))
  if (entry) writeFileSync(process.env.XDG_DATA_HOME + "/opencode/auth.json", JSON.stringify({ "amazon-bedrock": entry }), { mode: 0o600 })
' || die 3 'Bedrock auth seeding failed'

cap 120 "$CORVUS_SMOKE_REAL_GH" repo clone "$OWNER/$REPO" "$WORK/fixture" >"$WORK/clone.stdout" 2>"$WORK/clone.stderr" || die 4 'GitHub fixture clone failed (see clone.stderr)'
[[ -z "$(git -C "$WORK/fixture" status --porcelain)" ]] || die 4 'fixture clone is not clean'
cap 60 "$CORVUS_SMOKE_REAL_GH" pr view "$PR" --json headRefOid --jq .headRefOid >"$WORK/head-sha" 2>"$WORK/pr.stderr" || die 4 'GitHub PR lookup failed (see pr.stderr)'
IFS= read -r HEAD_SHA <"$WORK/head-sha"
[[ "$HEAD_SHA" =~ ^[a-f0-9]{40}$ ]] || die 4 'PR head is not a lowercase 40-hex SHA'

[[ -f "$ROOT/dist/server.js" && -f "$ROOT/dist/index.js" ]] || die 3 'build artifacts missing; run bun run build before this gate'
(
  cd "$ROOT"
  cap 120 npm pack --json --pack-destination "$WORK/pack" --loglevel=error
) >"$WORK/pack.json" 2>"$WORK/pack.stderr" || die 3 'npm pack of working tree failed'
TARBALL="$(bun -e 'console.log(JSON.parse(await Bun.file(process.env.SMOKE_WORK + "/pack.json").text())[0].filename)')"
printf '{"name":"corvus-review-smoke","private":true,"type":"module"}\n' >"$WORK/install/package.json"
(
  cd "$WORK/install"
  cap 180 npm install "$WORK/pack/$TARBALL" --cache "$XDG_CACHE_HOME/npm-cache" --no-audit --no-fund --ignore-scripts --loglevel=error
) >"$WORK/install.stdout" 2>"$WORK/install.stderr" || die 3 'tarball installation failed'
export SMOKE_INSTALL="$WORK/install/node_modules/corvus-ai"
# The package bundles this module into its host entries, not a standalone JS
# export. Build a sandbox-only verifier from the same tree, without repacking or
# editing the installed plugin that the host will exercise.
cap 60 bun build "$ROOT/src/review-payload.ts" --outdir "$WORK/dist" --target bun >"$WORK/verifier-build.log" 2>&1 || die 3 'standalone verifier build failed'
bun -e '
  const root = process.env.SMOKE_INSTALL
  const v2 = process.env.SMOKE_HOST === "v2"
  const barrier = v2
    ? { plugins: [root], agents: { "corvus-review-auto": { permissions: [{ action: "subagent", resource: "pr-comment-writer", effect: "deny" }] } } }
    : { plugin: [root + "/dist/server.js"], model: process.env.SMOKE_MODEL, agent: { "corvus-review-auto": { permission: { task: { "pr-comment-writer": "deny" } } } } }
  await Bun.write(process.env.XDG_CONFIG_HOME + "/opencode/opencode.json", JSON.stringify(barrier, null, 2) + "\n")
' || die 3 'host config generation failed'
cp "$ROOT/scripts/gh-readonly-shim.sh" "$WORK/bin/gh"
chmod 700 "$WORK/bin/gh"
export CORVUS_SMOKE_GH_AUDIT="$WORK/gh-audit.log"
: >"$CORVUS_SMOKE_GH_AUDIT"
export PATH="$WORK/bin:$PATH"
cd "$WORK/fixture"
export PWD="$WORK/fixture"

if [[ "$HOST" == v2 ]]; then
  for ((attempt=0; attempt<40; attempt++)); do
    candidate=$((49500 + RANDOM % 400))
    [[ "$candidate" != 49374 ]] || continue
    if [[ -z "$(lsof -nP -iTCP:"$candidate" -sTCP:LISTEN -t 2>/dev/null || true)" ]]; then PORT="$candidate"; break; fi
  done
  [[ -n "$PORT" && "$PORT" != 49374 ]] || die 3 'no safe service port available'
  cap 30 "$CLI" service set port "$PORT" >"$WORK/service-set.log" 2>&1 || die 3 'service port setup failed'
  SMOKE_PORT="$PORT" bun -e '
    const settings = await Bun.file(process.env.XDG_CONFIG_HOME + "/opencode/service.json").json()
    if (settings.port !== Number(process.env.SMOKE_PORT)) process.exit(1)
  ' || die 3 'isolated service setting did not retain the selected port'
  printf 'Sandbox service port: %s (never 49374)\n' "$PORT"
  SERVICE_STARTED=1
  cap 60 "$CLI" plugin list >"$WORK/warmup.stdout" 2>"$WORK/warmup.stderr" || die 3 'host warmup failed'
  cap 60 "$CLI" debug agents >"$WORK/agents.json" 2>"$WORK/agents.stderr" || die 3 'host agent inspection failed'
else
  cap 60 "$CLI" debug agent corvus-review-auto --print-logs --log-level INFO >"$WORK/agents.json" 2>"$WORK/agents.stderr" || die 3 'host agent inspection failed'
fi

# Barrier invariant: inspect the host-resolved rule before sending the model any
# PR content. An absent/non-deny final writer rule aborts both hosts. This does
# not grant additional permissions, and neither --keep nor a timeout disables it.
bun -e '
  const data = await Bun.file(process.env.SMOKE_WORK + "/agents.json").json()
  const v2 = process.env.SMOKE_HOST === "v2"
  const agent = v2 ? data.find(a => a.id === "corvus-review-auto") : data
  const rules = v2 ? agent?.permissions : agent?.permission
  const writer = rules?.filter(r => v2 ? r.action === "subagent" && r.resource === "pr-comment-writer" : r.permission === "task" && r.pattern === "pr-comment-writer").at(-1)
  if ((v2 ? writer?.effect : writer?.action) !== "deny") { console.error("Effective writer-deny override missing"); process.exit(1) }
' || die 6 'posting barrier not installed; model was not started'

if [[ "$HOST" == v2 ]]; then
  for ((attempt=0; attempt<60; attempt++)); do
    collect_logs
    if bun -e 'process.exit((await Bun.file(process.env.SMOKE_WORK + "/host.log").text()).split("\n").some(line => /loading plugin/.test(line) && /corvus-ai\/(?:dist\/)?server\.js/.test(line)) ? 0 : 1)'; then break; fi
    sleep 0.5
  done
fi
sleep 3
collect_logs
bun -e '
  const { checkPluginLoaded } = await import(process.env.SMOKE_ROOT + "/scripts/check-review-artifacts.ts")
  const result = checkPluginLoaded({ host: process.env.SMOKE_HOST, hostlog: process.env.SMOKE_WORK + "/host.log",
    agents: process.env.SMOKE_WORK + "/agents.json", install: process.env.SMOKE_INSTALL })
  console.log("Plugin preflight: " + result.detail)
  if (!result.ok) process.exit(1)
' || die 3 'plugin load evidence missing or failed (see host.log)'

REVIEW_START=$SECONDS
RUN_STATUS=0
ARGS=(run --agent corvus-review-auto --model "$MODEL" --format json)
[[ "$HOST" != v1 ]] || ARGS+=(--dir "$WORK/fixture")
cap "$((TIMEOUT_MIN * 60))" "$CLI" "${ARGS[@]}" "Review $PR. Run the full autonomous review." >"$WORK/run.jsonl" 2>"$WORK/run.stderr" || RUN_STATUS=$?
printf 'Review host exit: %s; review duration: %ss\n' "$RUN_STATUS" "$((SECONDS - REVIEW_START))"

SESSION_ID="$(bun -e '
  for (const line of (await Bun.file(process.env.SMOKE_WORK + "/run.jsonl").text()).split("\n")) {
    try { const event = JSON.parse(line); const id = event.sessionID ?? event.part?.sessionID; if (id) { console.log(id); break } } catch {}
  }
')"
if [[ "$SESSION_ID" =~ ^ses[a-zA-Z0-9_-]+$ && "$RUN_STATUS" != 142 ]]; then
  if [[ "$HOST" == v2 ]]; then
    cap 30 "$CLI" api GET "/api/session/$SESSION_ID" >"$WORK/session.json" 2>"$WORK/session.stderr" || true
  else
    cap 30 "$CLI" export "$SESSION_ID" >"$WORK/session.json" 2>"$WORK/session.stderr" || true
  fi
  bun -e '
    try {
      const value = await Bun.file(process.env.SMOKE_WORK + "/session.json").json()
      const session = value.data ?? value.info ?? value
      const agent = session.agent ?? value.messages?.find(m => m.info?.role === "assistant")?.info?.agent
      await Bun.write(process.env.SMOKE_WORK + "/session-evidence.log", "CORVUS_SMOKE_SESSION " + JSON.stringify({ id: session.id, agent }) + "\n")
    } catch { console.error("Session identity evidence unavailable") }
  '
fi
# Settle asynchronous host logging, then stop the service before artifact reads.
sleep 3
stop_service || die 3 'sandbox service could not be stopped; artifacts not checked'
collect_logs
CHECK_STATUS=0
bun run "$ROOT/scripts/check-review-artifacts.ts" "$WORK/fixture" "$OWNER" "$REPO" "$NUMBER" "$HEAD_SHA" "$WORK/run.jsonl" "$WORK/host.log" "$WORK/gh-audit.log" --host "$HOST" --agents "$WORK/agents.json" --install "$SMOKE_INSTALL" | tee "$WORK/result.txt" || CHECK_STATUS=$?
[[ "$RUN_STATUS" != 142 && "$RUN_STATUS" != 124 ]] || exit 124
((CHECK_STATUS == 0)) || exit "$CHECK_STATUS"
((RUN_STATUS == 0)) || exit 3

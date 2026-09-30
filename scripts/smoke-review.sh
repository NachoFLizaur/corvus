#!/usr/bin/env bash
# Real-host review gate. Failed runs retain evidence and private sandbox auth;
# do not publish the sandbox wholesale. Only the requested PR is read remotely.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$ROOT/scripts/host.sh"
HOST=""
OPENCODE_BIN=""
PR="https://github.com/NachoFLizaur/corvus/pull/8"
INTAKE=url
BRANCH=""
MODEL="amazon-bedrock/global.openai.gpt-6-astra"
KEEP=0
PREFLIGHT_ONLY=0
PREFLIGHT_HOST=0
NEGATIVE_CONTROL=0
CROSS_REPO=false
WRITER=0
TIMEOUT_MIN=40
WORK=""
PORT=""
SERVICE_STARTED=0
START=$SECONDS

die() { printf '| preflight | FAIL | %s |\n' "$2" >&2; exit "$1"; }
cap() { local seconds="$1"; shift; perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"; }
# Fetch the base repository's PR ref, not a branch that may exist only in a fork.
seed_pr_branch() {
  cap 120 git -C "$WORK/fixture" fetch origin "refs/pull/$NUMBER/head:refs/remotes/origin/$BRANCH" >"$WORK/fetch.log" 2>&1 || die 4 'PR branch fetch failed'
  git -C "$WORK/fixture" branch -f "$BRANCH" "origin/$BRANCH" >"$WORK/checkout.log" 2>&1 || die 4 'PR branch seeding failed'
}

# Sync fixture invariant: seed the bare from the private clone before any model
# mutation, then verify both push URLs and tracking. Only origin can receive state;
# github has a non-URL push sentinel. Setup failures abort; no intake bypasses it.
prepare_sync_remotes() {
  cap 120 git clone --bare "$WORK/fixture" "$WORK/bare.git" >"$WORK/bare-clone.log" 2>&1 || die 4 'bare fixture clone failed'
  git -C "$WORK/fixture" remote rename origin github
  git -C "$WORK/fixture" remote set-url github "https://github.com/$OWNER/$REPO"
  git -C "$WORK/fixture" remote set-url --push github DISABLED_PUSH_SENTINEL
  git -C "$WORK/fixture" remote add origin "$WORK/bare.git"
  git -C "$WORK/fixture" config user.name 'Corvus smoke fixture'
  git -C "$WORK/fixture" config user.email 'corvus-smoke@example.invalid'
  # Corvus itself ignores project memory; only the disposable fixture opts in.
  # This unrelated unstaged edit stays outside the tool's root-only state commit.
  printf '\n!/.corvus/\n!/.corvus/**\n' >>"$WORK/fixture/.gitignore"
  if [[ "$INTAKE" == local ]]; then
    git -C "$WORK/fixture" fetch origin "$BRANCH:refs/remotes/origin/$BRANCH"
    git -C "$WORK/fixture" branch --set-upstream-to="origin/$BRANCH" "$BRANCH"
  elif [[ "$INTAKE" == branch ]]; then
    git -C "$WORK/fixture" config "branch.$BRANCH.remote" github
    git -C "$WORK/fixture" config "branch.$BRANCH.merge" "refs/pull/$NUMBER/head"
  fi
  [[ "$(git -C "$WORK/fixture" remote get-url --push origin)" == "$WORK/bare.git" && "$(git -C "$WORK/fixture" remote get-url --push github)" == DISABLED_PUSH_SENTINEL ]] || die 4 'unsafe sync push targets'
  [[ "$(git -C "$WORK/bare.git" rev-parse "refs/heads/$BRANCH")" == "$(git -C "$WORK/fixture" rev-parse "refs/heads/$BRANCH")" ]] || die 4 'bare branch was not seeded at fixture tip'
  git -C "$WORK/bare.git" rev-parse "refs/heads/$BRANCH" >"$WORK/bare-tip-before"
}

# Branch discovery oracle: the exact argument-free shim read inside the fixture,
# before model launch. A failed read or wrong PR aborts; URL/LOCAL have no branch
# discovery preflight. Neither --full nor --keep disables the branch check.
preflight_branch_pr() {
  [[ "$INTAKE" == branch ]] || return 0
  cap 60 gh pr view --json number,url,headRefName,state >"$WORK/branch-preflight.json" 2>"$WORK/branch-preflight.stderr" || die 4 'argument-free gh pr view through shim failed; model was not started'
  SMOKE_PR="$NUMBER" SMOKE_BRANCH="$BRANCH" bun -e '
    const value = await Bun.file(process.env.SMOKE_WORK + "/branch-preflight.json").json()
    if (value.number !== Number(process.env.SMOKE_PR) || value.headRefName !== process.env.SMOKE_BRANCH) process.exit(1)
  ' || die 4 "argument-free gh pr view did not resolve PR #$NUMBER on $BRANCH; model was not started"
}

# Agent listing oracle: stable v2 can return only built-ins on the first read,
# before the scoped plugin request initializes this location. Re-read afterwards,
# polling only absence for 60 reads with half-second sleeps (each CLI cap: 60s).
# Malformed evidence/CLI errors fail immediately;
# permissions are still validated separately before model launch. No bypass.
preflight_v2_agents() {
  local attempt result
  for ((attempt=0; attempt<60; attempt++)); do
    cap 60 "$CLI" debug agents >"$WORK/agents.json" 2>"$WORK/agents.stderr" || die 3 'host agent inspection failed'
    result=0
    bun -e '
      const agents = await Bun.file(process.env.SMOKE_WORK + "/agents.json").json()
      if (!Array.isArray(agents)) process.exit(1)
      process.exit(agents.some(agent => agent?.id === "corvus-review-auto") ? 0 : 2)
    ' || result=$?
    case "$result" in
      0) return 0 ;;
      2) sleep 0.5 ;;
      *) die 3 'malformed host agent listing; model was not started' ;;
    esac
  done
  die 3 'corvus-review-auto absent from host agent listing after 60 reads; model was not started'
}

usage() {
  printf '%s\n' 'Usage: bash scripts/smoke-review.sh --host v1|v2 [--pr URL] [--intake url|branch|local] [--model ID] [--keep] [--preflight-only] [--timeout-min N=40] [--writer | --full]'
  printf '%s\n' '  --intake  url (default): explicit PR; branch: discover the fixture PR; local: dirty branch without a PR'
  printf '%s\n' '  --preflight-only  probe host version and print intake evidence; exit before packaging or service/model launch'
  printf '%s\n' '  --preflight-host  v2 only: also pack/install, boot and check plugin state/agents/logs; stop before any model call'
  printf '%s\n' '  --negative-control  with --preflight-host: strip skill.path in the sandbox package; EXPECT plugin-state FAIL'
  printf '%s\n' '  --writer  execute the real pr-comment-writer against the shim (POST blocked) instead of denying its dispatch'
  printf '%s\n' '  --full    every optional leg (currently --writer)'
  smoke_host_help
}
while (($#)); do
  case "$1" in
    --host|--opencode-bin|--pr|--model|--timeout-min|--intake)
      [[ $# -ge 2 && -n "$2" ]] || die 3 "missing value for $1"
      case "$1" in --host) HOST="$2" ;; --opencode-bin) OPENCODE_BIN="$2" ;; --pr) PR="$2" ;; --model) MODEL="$2" ;; --timeout-min) TIMEOUT_MIN="$2" ;; --intake) INTAKE="$2" ;; esac
      shift 2 ;;
    --keep) KEEP=1; shift ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --preflight-host) PREFLIGHT_HOST=1; shift ;;
    --negative-control) NEGATIVE_CONTROL=1; shift ;;
    --writer|--full) WRITER=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage; die 3 "unknown argument: $1" ;;
  esac
done
[[ "$HOST" == v1 || "$HOST" == v2 ]] || die 3 '--host v1|v2 is required'
[[ "$INTAKE" == url || "$INTAKE" == branch || "$INTAKE" == local ]] || die 3 '--intake must be url, branch or local'
[[ "$INTAKE" != local || "$WRITER" == 0 ]] || die 3 '--writer/--full cannot be combined with LOCAL intake'
[[ "$WRITER" == 0 || "$HOST" == v1 ]] || die 3 '--writer/--full is v1-only until the v2 gate lands'
[[ "$PREFLIGHT_HOST" == 0 || ( "$HOST" == v2 && "$PREFLIGHT_ONLY" == 0 ) ]] || die 3 '--preflight-host requires v2 and cannot combine with --preflight-only'
[[ "$NEGATIVE_CONTROL" == 0 || "$PREFLIGHT_HOST" == 1 ]] || die 3 '--negative-control requires --preflight-host (no model call)'
[[ "$TIMEOUT_MIN" =~ ^[1-9][0-9]*$ && ${#TIMEOUT_MIN} -le 4 ]] || die 3 'timeout must be a positive integer (minutes, at most four digits)'
[[ "$PR" =~ ^https://github.com/([a-zA-Z0-9_-]+)/([a-zA-Z0-9_.-]+)/pull/([1-9][0-9]*)/?$ ]] || die 4 'expected a canonical github.com PR URL'
OWNER="${BASH_REMATCH[1]}" REPO="${BASH_REMATCH[2]}" NUMBER="${BASH_REMATCH[3]}"
[[ "$REPO" != . && "$REPO" != .. ]] || die 4 'invalid repository name'
for executable in bun npm gh perl lsof git; do
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
  smoke_live_assert || status=3
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

smoke_host_prepare "$HOST" "$OPENCODE_BIN" || die 3 'host selection/version probe failed'
export SMOKE_WORK="$WORK" SMOKE_ROOT="$ROOT" SMOKE_HOST="$HOST" SMOKE_MODEL="$MODEL" SMOKE_WRITER="$WRITER"
mkdir -p "$WORK"/xdg/{data/opencode,config/opencode,state,cache} "$WORK"/{bin,install,pack,dist}
printf 'Sandbox: %s\nHost: %s; fixture PR: %s; intake: %s; model: %s; review cap: %sm; writer: %s\n' "$WORK" "$HOST" "$PR" "$INTAKE" "$MODEL" "$TIMEOUT_MIN" "$([[ "$WRITER" == 1 ]] && printf executed || printf denied)"

# Isolate XDG state, retaining HOME and AWS environment for the verified provider
# resolution. HOME-based external skills/config remain visible; ~/.aws is not copied.
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
# Intake setup mutates only the private clone before model dispatch. Branch names
# come from gh JSON and pass Git ref validation before fetch/checkout; LOCAL starts
# at origin's default branch and requires an empty PR listing before its edit.
# Missing/invalid setup evidence aborts; no intake or keep flag bypasses it.
if [[ "$INTAKE" != local ]]; then
  (cd "$WORK/fixture" && cap 60 "$CORVUS_SMOKE_REAL_GH" pr view "$NUMBER" --repo "$OWNER/$REPO" --json number,url,headRefName,headRefOid,isCrossRepository,headRepository) >"$WORK/pr.json" 2>"$WORK/pr.stderr" || die 4 'PR branch lookup failed'
  BRANCH="$(bun -e 'const value = await Bun.file(process.env.SMOKE_WORK + "/pr.json").json(); if (typeof value.headRefName !== "string") process.exit(1); console.log(value.headRefName)')" || die 4 'invalid PR branch result'
  CROSS_REPO="$(bun -e 'const value = await Bun.file(process.env.SMOKE_WORK + "/pr.json").json(); if (typeof value.isCrossRepository !== "boolean" || typeof value.headRepository?.nameWithOwner !== "string" || !value.headRepository.nameWithOwner) process.exit(1); console.log(value.isCrossRepository)')" || die 4 'invalid PR repository result'
  [[ "$BRANCH" != -* ]] && git check-ref-format --branch "$BRANCH" >/dev/null || die 4 'invalid PR head branch'
  seed_pr_branch
  if [[ "$INTAKE" == branch ]]; then
    git -C "$WORK/fixture" checkout "$BRANCH" >>"$WORK/checkout.log" 2>&1 || die 4 'PR branch checkout failed'
  else
    git -C "$WORK/fixture" checkout --detach "$BRANCH" >>"$WORK/checkout.log" 2>&1 || die 4 'PR detached fixture checkout failed'
  fi
elif [[ "$INTAKE" == local ]]; then
  DEFAULT_BRANCH="$(git -C "$WORK/fixture" symbolic-ref --short refs/remotes/origin/HEAD)" || die 4 'fixture default branch unavailable'
  BRANCH="smoke/local-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  git -C "$WORK/fixture" checkout --no-track -b "$BRANCH" "$DEFAULT_BRANCH" >"$WORK/checkout.log" 2>&1 || die 4 'LOCAL branch creation failed'
  (cd "$WORK/fixture" && cap 60 "$CORVUS_SMOKE_REAL_GH" pr list --head "$BRANCH" --state all --json number --limit 5) >"$WORK/local-prs.json" 2>"$WORK/pr.stderr" || die 4 'LOCAL PR absence lookup failed'
  bun -e 'const prs = await Bun.file(process.env.SMOKE_WORK + "/local-prs.json").json(); if (!Array.isArray(prs) || prs.length !== 0) process.exit(1)' || die 4 'LOCAL branch already has a PR or its listing is invalid'
fi
prepare_sync_remotes
export GH_REPO="$OWNER/$REPO"
if [[ "$INTAKE" == local ]]; then
  [[ -f "$WORK/fixture/README.md" ]] || die 4 'LOCAL fixture README missing'
  printf '\nLOCAL smoke review: uncommitted fixture change.\n' >>"$WORK/fixture/README.md"
fi
if [[ "$INTAKE" == local ]]; then
  git -C "$WORK/fixture" rev-parse HEAD >"$WORK/head-sha" || die 4 'LOCAL HEAD lookup failed'
else
  cap 60 "$CORVUS_SMOKE_REAL_GH" pr view "$PR" --json headRefOid --jq .headRefOid >"$WORK/head-sha" 2>"$WORK/pr.stderr" || die 4 'GitHub PR lookup failed (see pr.stderr)'
fi
IFS= read -r HEAD_SHA <"$WORK/head-sha"
[[ "$HEAD_SHA" =~ ^[a-f0-9]{40}$ ]] || die 4 'review head is not a lowercase 40-hex SHA'
[[ "$INTAKE" != branch || "$(git -C "$WORK/fixture" rev-parse HEAD)" == "$HEAD_SHA" ]] || die 4 'checked-out branch differs from PR head'
SMOKE_HEAD="$HEAD_SHA" SMOKE_INTAKE="$INTAKE" bun -e '
  const cwd = process.env.SMOKE_WORK + "/fixture"
  const args = process.env.SMOKE_INTAKE === "local" ? ["refs/remotes/github/HEAD"] : ["refs/remotes/github/HEAD..." + process.env.SMOKE_HEAD]
  const result = Bun.spawnSync(["git", "diff", "--name-only", "-z", ...args, "--"], { cwd })
  if (result.exitCode) process.exit(1)
  await Bun.write(process.env.SMOKE_WORK + "/changed-files.json", JSON.stringify(result.stdout.toString().split("\0").filter(Boolean)))
' || die 4 'fixture changed-file inventory failed'

cp "$ROOT/scripts/gh-readonly-shim.sh" "$WORK/bin/gh"
chmod 700 "$WORK/bin/gh"
export CORVUS_SMOKE_GH_AUDIT="$WORK/gh-audit.log"
: >"$CORVUS_SMOKE_GH_AUDIT"
export PATH="$WORK/bin:$PATH"
cd "$WORK/fixture"
export PWD="$WORK/fixture"
preflight_branch_pr
if ((PREFLIGHT_ONLY)); then
  SMOKE_BRANCH="$BRANCH" SMOKE_HEAD="$HEAD_SHA" SMOKE_INTAKE="$INTAKE" SMOKE_CROSS_REPO="$CROSS_REPO" bun -e '
    const root = process.env.SMOKE_WORK
    const intake = process.env.SMOKE_INTAKE
    const preflight = await Bun.file(root + (intake === "branch" ? "/branch-preflight.json" : intake === "local" ? "/local-prs.json" : "/pr.json")).json()
    console.log("PREFLIGHT_RESULT " + JSON.stringify({ intake, branch: process.env.SMOKE_BRANCH, tip: process.env.SMOKE_HEAD,
      bare_tip_before: (await Bun.file(root + "/bare-tip-before").text()).trim(), cross_repo: process.env.SMOKE_CROSS_REPO === "true", preflight }))
  '
  exit 0
fi

bash "$ROOT/scripts/probe-gh-shim.sh" "$WORK/bin/gh" "$WORK/shim-probe" || die 6 'network-free shim sentinel probe failed; model was not started'

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
# Negative control reproduces the pre-repair missing skill.path at the editor
# boundary, following smoke-v2's control. Only the freshly installed sandbox shim
# changes, before boot; src/dist stay untouched. This mode cannot launch a model
# and must fail the ordinary plugin-state guard, never turn that failure into PASS.
if ((NEGATIVE_CONTROL)); then
  bun -e '
    await Bun.write(process.env.SMOKE_INSTALL + "/server.js", `import repaired from "./dist/server.js"
export default {
  ...repaired,
  setup(ctx) {
    const skill = Object.create(ctx.skill)
    skill.transform = callback => ctx.skill.transform(draft => callback(new Proxy(draft, {
      get(target, key) {
        if (key === "add") return record => {
          const { path, ...withoutPath } = record
          return target.add(withoutPath)
        }
        const value = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      },
    })))
    return repaired.setup(new Proxy(ctx, { get: (target, key) => key === "skill" ? skill : Reflect.get(target, key) }))
  },
}
`)
  ' || die 3 'negative-control injection failed'
  printf 'Negative control (local simulation): strips skill.path only in %s/server.js\n' "$SMOKE_INSTALL"
fi
# The package bundles this module into its host entries, not a standalone JS
# export. Build a sandbox-only verifier from the same tree, without repacking or
# editing the installed plugin that the host will exercise.
if [[ "$INTAKE" != local ]]; then
  cap 60 bun build "$ROOT/src/review-payload.ts" --outdir "$WORK/dist" --target bun >"$WORK/verifier-build.log" 2>&1 || die 3 'standalone verifier build failed'
fi
# Writer mode carries no task deny: the shim's POST admission is the only barrier and
# the real writer runs to its blocked POST. Barrier mode keeps the host-resolved deny.
bun -e '
  const root = process.env.SMOKE_INSTALL
  const v2 = process.env.SMOKE_HOST === "v2"
  const writer = process.env.SMOKE_WRITER === "1"
  const barrier = v2
    ? { plugins: [root], agents: { "corvus-review-auto": { permissions: [{ action: "subagent", resource: "pr-comment-writer", effect: "deny" }] } } }
    : { plugin: [root + "/dist/server.js"], model: process.env.SMOKE_MODEL,
      ...(writer ? {} : { agent: { "corvus-review-auto": { permission: { task: { "pr-comment-writer": "deny" } } } } }) }
  await Bun.write(process.env.XDG_CONFIG_HOME + "/opencode/opencode.json", JSON.stringify(barrier, null, 2) + "\n")
' || die 3 'host config generation failed'
export GIT_TRACE2_EVENT="$WORK/git-trace.jsonl"
: >"$GIT_TRACE2_EVENT"

if [[ "$HOST" == v2 ]]; then
  PORT="$SMOKE_PORT"
  SMOKE_CHECK_PORT="$PORT" smoke_free_port >/dev/null || die 3 'selected service port is no longer free'
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
  SMOKE_EVIDENCE_KIND='real-host assertion' smoke_v2_plugin_state "$WORK/fixture" "$WORK/plugin-state.json" || die 3 'plugin-state: scoped active corvus server required; model was not started'
  preflight_v2_agents
else
  cap 60 "$CLI" debug agent corvus-review-auto --print-logs --log-level INFO >"$WORK/agents.json" 2>"$WORK/agents.stderr" || die 3 'host agent inspection failed'
fi

# Barrier invariant: inspect the host-resolved rule before sending the model any
# PR content. Barrier mode: an absent/non-deny final writer rule aborts both hosts.
# Orchestrator tools: require corvus_review_payload and corvus_review_post via v1
# resolved tools or v2 permissions (local matcher; inventory is probed separately).
# Writer mode (v1): the final rule must allow, and the writer must expose pr/post.
# Missing tools/permissions abort; the shim remains the mutation barrier. This grants
# no permissions, and neither --keep nor a timeout disables it.
# Use the last rule in the first populated tier: exact writer, task/subagent
# wildcard, then global wildcard.
bun -e '
  const data = await Bun.file(process.env.SMOKE_WORK + "/agents.json").json()
  const v2 = process.env.SMOKE_HOST === "v2"
  const expected = process.env.SMOKE_WRITER === "1" ? "allow" : "deny"
  const agent = v2 ? data.find(a => a.id === "corvus-review-auto") : data
  const rules = v2 ? agent?.permissions : agent?.permission
  const { evaluateRules } = await import(process.env.SMOKE_ROOT + "/src/evaluate-rules.ts")
  const required = ["corvus_review_payload", "corvus_review_post"]
  const exposed = required.every(name => v2 ? evaluateRules(rules ?? [], name, "*") === "allow" : agent?.tools?.[name] === true)
  if (!exposed) { console.error("Orchestrator requires corvus_review_payload and corvus_review_post"); process.exit(1) }
  const writer = rules?.findLast(r => v2 ? r.action === "subagent" && r.resource === "pr-comment-writer" : r.permission === "task" && r.pattern === "pr-comment-writer")
    ?? rules?.findLast(r => v2 ? r.action === "subagent" && r.resource === "*" : r.permission === "task" && r.pattern === "*")
    ?? rules?.findLast(r => v2 ? r.action === "*" : r.permission === "*")
  if ((v2 ? writer?.effect : writer?.action) !== expected) { console.error("Effective writer rule is not " + expected); process.exit(1) }
' || die 6 'posting barrier not installed; model was not started'
if [[ "$WRITER" == 1 ]]; then
  cap 60 "$CLI" debug agent pr-comment-writer >"$WORK/writer-agent.json" 2>>"$WORK/agents.stderr" || die 3 'writer agent inspection failed'
  # Exposure invariant: host-resolved writer tools are read before model launch;
  # missing pr/post aborts, with no flag bypass and no extra tool prerequisite.
  bun -e '
    const agent = await Bun.file(process.env.SMOKE_WORK + "/writer-agent.json").json()
    const tools = agent.tools ?? {}
    const exposure = Object.fromEntries(Object.entries(tools).filter(([name]) => name.startsWith("corvus_review_")))
    console.info("Writer exposure: " + JSON.stringify(exposure))
    if (agent.name !== "pr-comment-writer" || tools.corvus_review_pr !== true || tools.corvus_review_post !== true) {
      console.error("writer exposure failed: " + JSON.stringify({ name: agent.name, ...exposure })); process.exit(1)
    }
  ' || die 6 'writer tool exposure failed; model was not started'
fi

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
    fixture: process.env.SMOKE_WORK + "/fixture", pluginState: process.env.SMOKE_WORK + "/plugin-state.json",
    agents: process.env.SMOKE_WORK + "/agents.json", install: process.env.SMOKE_INSTALL, writer: process.env.SMOKE_WRITER === "1" })
  console.log("Plugin preflight: " + result.detail)
  if (!result.ok) process.exit(1)
' || die 3 'plugin load evidence missing or failed (see host.log)'

((NEGATIVE_CONTROL == 0)) || die 3 'negative-control unexpectedly passed plugin-state'
if ((PREFLIGHT_HOST)); then
  stop_service || die 3 'sandbox service could not be stopped'
  printf 'Host preflight: PASS; scoped plugin active, writer denied, shim sentinel rejected; no model started\n'
  exit 0
fi

REVIEW_START=$SECONDS
RUN_STATUS=0
ARGS=(run --agent corvus-review-auto --model "$MODEL" --format json)
[[ "$HOST" != v1 ]] || ARGS+=(--dir "$WORK/fixture")
case "$INTAKE" in
  url) PROMPT="Review $PR. Run the full autonomous review." ;;
  branch) PROMPT="review this PR" ;;
  local) PROMPT="review my changes" ;;
esac
cap "$((TIMEOUT_MIN * 60))" "$CLI" "${ARGS[@]}" "$PROMPT" >"$WORK/run.jsonl" 2>"$WORK/run.stderr" || RUN_STATUS=$?
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
# Refresh scoped state after the run: a later transform failure must not be hidden
# by the pre-model snapshot. Failed capture aborts, never reuses stale evidence.
if [[ "$HOST" == v2 ]]; then
  smoke_v2_api_read /api/plugin "$WORK/plugin-state.json" "$WORK/fixture" || die 3 'plugin-state: final API capture failed'
fi
stop_service || die 3 'sandbox service could not be stopped; artifacts not checked'
collect_logs
CHECK_STATUS=0
CHECK_ARGS=(--host "$HOST" --agents "$WORK/agents.json" --install "$SMOKE_INSTALL" --db "$XDG_DATA_HOME/opencode/opencode.db" --intake "$INTAKE" --bare "$WORK/bare.git" --cross-repo "$CROSS_REPO")
[[ "$HOST" != v2 ]] || CHECK_ARGS+=(--plugin-state "$WORK/plugin-state.json")
[[ -z "$BRANCH" ]] || CHECK_ARGS+=(--branch "$BRANCH")
[[ "$WRITER" == 0 ]] || CHECK_ARGS+=(--writer)
bun run "$ROOT/scripts/check-review-artifacts.ts" "$WORK/fixture" "$OWNER" "$REPO" "$NUMBER" "$HEAD_SHA" "$WORK/run.jsonl" "$WORK/host.log" "$WORK/gh-audit.log" "${CHECK_ARGS[@]}" | tee "$WORK/result.txt" || CHECK_STATUS=$?
[[ "$RUN_STATUS" != 142 && "$RUN_STATUS" != 124 ]] || exit 124
((CHECK_STATUS == 0)) || exit "$CHECK_STATUS"
((RUN_STATUS == 0)) || exit 3

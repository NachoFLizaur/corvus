#!/usr/bin/env bash
#
# smoke-v2.sh — hermetic smoke-load harness for the OpenCode v2 (`opencode2`) host.
#
# WHY THIS EXISTS
# The v2 host SILENTLY drops a local-directory plugin whose entry it cannot
# resolve: no error, no log line, exit 0. Absence of an error is therefore NOT
# evidence of a successful load. The only positive oracles are (a) a
# `msg="loading plugin"` line naming our entry in the host log and (b) the
# plugin appearing in `opencode2 plugin list`. Every mode below fails closed:
# any missing or mismatched evidence exits non-zero.
#
# MODES
#   (default)            local-directory load of this repo through its root
#                        `server.js` shim under a real `opencode2` boot.
#   --full               additionally assert the WHOLE packaged corpus reached
#                        the host: every `agent/*.md` basename via
#                        `opencode2 debug agents`, plus every `command/*.md`
#                        basename, every `skill/*/SKILL.md` directory id, and the
#                        default MCP server via the host's own HTTP API
#                        (`opencode2 api GET /api/{command,skill,mcp}`). Accepted
#                        but INERT with --tarball: every one of those assertions
#                        requires a host boot, which that mode forbids.
#   --refs               evaluate sibling reference reads from registered agent
#                        maps with the local host matcher, AND probe all seven review
#                        tools (including payload/preview and post rejection) on
#                        both hosts via `scripts/probe-tools.ts` (included in
#                        --full). The v2 protocol has no tool listing (`v2.command
#                        .list`/`v2.skill.list`/`v2.mcp.list` exist; no tool group)
#                        and `opencode2 debug` covers only agents/config/paths, so
#                        the probe drives the BUILT `dist/server.js` setup() and the
#                        `dist/index.js` v1 hook function with the registration
#                        tests' host double, then runs over-budget measure → fitted
#                        freeze → preview → wrong-digest post rejection without network.
#   --tarball            npm-specifier resolution EMULATION. Does NOT boot the
#                        host: for an npm specifier the host runs ITS OWN
#                        registry install and resolves the entry against that
#                        installed copy, so a pre-publish real-host load of the
#                        npm path is impossible (a bare `corvus-ai` specifier
#                        fetches registry `latest`, never a local build). This
#                        mode packs the working tree, installs the tarball into
#                        an isolated project, and reproduces the host's
#                        `Bun.resolveSync([name, sub].join("/"), installedDir)`
#                        probe for `sub in ["server", ""]`. It is the ONLY mode
#                        that exercises `exports["./server"]`, because
#                        local-directory entries ignore `exports` entirely.
#   --registry <spec>    POST-PUBLISH ONLY. Real-host load through the npm path
#                        by configuring `{"plugins": ["<spec>"]}`. It fetches
#                        from the registry, so it must never gate pre-publish
#                        work.
#
# HERMETICITY
# All four XDG dirs (data/config/state/cache) are redirected under a per-run
# temp tree in every mode. `XDG_CACHE_HOME` is load-bearing for --registry: the
# host self-installs npm specifiers into `$XDG_CACHE_HOME/opencode/npm/…`. The
# managed-service port is GLOBAL and its default (49374) collides with the
# user's live service, so each run picks a verified-free port that is never
# 49374 and stops the service it started via an EXIT trap. The host is only ever
# invoked with explicit subcommands — never as a bare TUI. macOS ships no
# `timeout(1)`, so wall-clock caps use `perl -e 'alarm …; exec @ARGV'` (pending
# alarms survive `exec`, so the timer applies to the replaced program).

set -euo pipefail

readonly USER_SERVICE_PORT=49374
readonly PACKAGE_NAME="corvus-ai"
readonly PLUGIN_ID="corvus"
# The single MCP server corvus contributes by default (`src/v2/register-mcp.ts`
# `SERVER_NAME`). Held here rather than derived: unlike agents/commands/skills it
# has no corpus file to enumerate, so it is a constant on both sides.
readonly MCP_SERVER_NAME="web-research"
readonly CAP_SECS=60
readonly REGISTRY_WARMUP_CAP_SECS=300
# The host writes server-side log lines asynchronously: empirically the
# `loading plugin` line lands 1-2s AFTER the CLI invocation that triggered the
# load has already exited. A single-shot grep therefore reports a false silent
# drop, so load evidence is polled up to EVIDENCE_WAIT_SECS and only then
# treated as absent. EVIDENCE_SETTLE_SECS is the converse: a load FAILURE line
# lags the same way, so asserting its absence immediately would be vacuous.
readonly EVIDENCE_WAIT_SECS=30
readonly EVIDENCE_SETTLE_SECS=3
# Plugin contributions land in the `/api/*` listings LAZILY: on a freshly booted
# service the FIRST `/api/command` read returns an empty `data` array while every
# later read returns the full set (reproduced on every fresh service while
# probing the host's listing surfaces). This is the same lazy-population caveat
# the warmup boot already absorbs for `plugin list`, so the corpus assertions
# poll instead of trusting a single read.
readonly LISTING_WAIT_SECS=30

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPO_ROOT

MODE="local"
FULL=0
REFS=0
REGISTRY_SPEC=""
WORK=""
SERVICE_PORT=""
SERVICE_STARTED=0

log() { printf '%s\n' "$*"; }
section() { printf '\n=== %s ===\n' "$*"; }
die() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: bash scripts/smoke-v2.sh [--full] [--refs] [--tarball | --registry <spec>]

  (no flags)          local-directory load gate under a real opencode2 boot
  --full              also assert the whole packaged corpus is registered
                      (agents, commands, skills, default MCP server, and refs;
                      accepted but INERT with --tarball)
  --refs              probe sibling reference reads and all seven review tools on
                      both hosts (also INERT with --tarball)
  --tarball           npm-specifier resolution emulation (no host boot)
  --registry <spec>   POST-PUBLISH ONLY real-host load of an npm specifier
  -h, --help          show this help
EOF
}

# Wall-clock cap without timeout(1): a pending alarm survives exec, so SIGALRM
# terminates the replaced program.
run_capped() {
  local secs="$1"
  shift
  perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
}

parse_args() {
  local tarball=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --full)
        FULL=1
        REFS=1
        shift
        ;;
      --refs)
        REFS=1
        shift
        ;;
      --tarball)
        tarball=1
        shift
        ;;
      --registry)
        [[ $# -ge 2 && -n "${2:-}" ]] || die "--registry requires a package specifier"
        REGISTRY_SPEC="$2"
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "unknown argument: $1"
        ;;
    esac
  done

  if ((tarball)) && [[ -n "$REGISTRY_SPEC" ]]; then
    die "--tarball and --registry are mutually exclusive: --tarball emulates resolution without a host, --registry boots the host against the registry"
  fi

  if ((tarball)); then
    MODE="tarball"
  elif [[ -n "$REGISTRY_SPEC" ]]; then
    MODE="registry"
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if ((status != 0)) && [[ -n "$WORK" && -d "$WORK/xdg/data/opencode/log" ]]; then
    section "host log tail (failure diagnostics)"
    tail -n 60 "$WORK/xdg/data/opencode/log/"*.log 2>/dev/null || true
  fi

  stop_service
  if [[ -n "$WORK" ]]; then rm -rf "$WORK"; fi

  exit "$status"
}

# Stops only the service this run started, identified by its own port. Never
# touches USER_SERVICE_PORT: port selection rejects it and the SIGTERM fallback
# is keyed to SERVICE_PORT.
stop_service() {
  ((SERVICE_STARTED)) || return 0
  [[ -n "$SERVICE_PORT" && "$SERVICE_PORT" != "$USER_SERVICE_PORT" ]] || return 0

  run_capped 30 opencode2 service stop >/dev/null 2>&1 || true

  local pids
  pids="$(lsof -nP -iTCP:"$SERVICE_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    log "sandboxed service still listening on $SERVICE_PORT; sending SIGTERM to: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    pids="$(lsof -nP -iTCP:"$SERVICE_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then kill -9 $pids 2>/dev/null || true; fi
  fi
  SERVICE_STARTED=0
}

port_is_free() {
  local port="$1"
  [[ -z "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)" ]]
}

pick_free_port() {
  local attempt port
  for attempt in $(seq 1 40); do
    port=$((49500 + RANDOM % 400))
    if [[ "$port" == "$USER_SERVICE_PORT" ]]; then continue; fi
    if port_is_free "$port"; then
      printf '%s' "$port"
      return 0
    fi
  done
  die "could not find a free service port after 40 attempts"
}

make_workspace() {
  local base="${TMPDIR:-/tmp}"
  base="${base%/}/opencode"
  mkdir -p "$base"
  WORK="$base/smoke-$$"
  rm -rf "$WORK"
  mkdir -p "$WORK"/xdg/{data,config/opencode,state,cache} "$WORK/project"

  # Exported in EVERY mode: the host resolves data/config/state/cache from these
  # and self-installs npm specifiers into $XDG_CACHE_HOME/opencode/npm/….
  export XDG_DATA_HOME="$WORK/xdg/data"
  export XDG_CONFIG_HOME="$WORK/xdg/config"
  export XDG_STATE_HOME="$WORK/xdg/state"
  export XDG_CACHE_HOME="$WORK/xdg/cache"

  log "workspace:      $WORK"
  log "XDG_DATA_HOME:  $XDG_DATA_HOME"
  log "XDG_CONFIG_HOME:$XDG_CONFIG_HOME"
  log "XDG_STATE_HOME: $XDG_STATE_HOME"
  log "XDG_CACHE_HOME: $XDG_CACHE_HOME"
}

require_built_dist() {
  local missing=0
  local file
  for file in dist/index.js dist/server.js server.js; do
    [[ -f "$REPO_ROOT/$file" ]] || {
      log "missing: $REPO_ROOT/$file"
      missing=1
    }
  done
  ((missing == 0)) || die "build artifacts missing — run 'bun run build' first"
}

write_plugin_config() {
  local entry="$1"
  local config="$XDG_CONFIG_HOME/opencode/opencode.json"
  # bun writes the JSON so the entry is escaped correctly whatever it contains.
  # Values travel in the environment, not argv: `bun -e` has no script slot, so
  # its argv indices differ from `bun run <file>` and are easy to get wrong.
  SMOKE_CONFIG_PATH="$config" SMOKE_PLUGIN_ENTRY="$entry" bun -e \
    'await Bun.write(Bun.env.SMOKE_CONFIG_PATH, JSON.stringify({ plugins: [Bun.env.SMOKE_PLUGIN_ENTRY] }) + "\n")'
  section "plugin config ($config)"
  cat "$config"
}

configure_service_port() {
  SERVICE_PORT="$(pick_free_port)"
  [[ "$SERVICE_PORT" != "$USER_SERVICE_PORT" ]] ||
    die "refusing to use the user's service port $USER_SERVICE_PORT"

  run_capped 30 opencode2 service set port "$SERVICE_PORT" >/dev/null

  local settings
  settings="$(run_capped 30 opencode2 service get 2>/dev/null || true)"
  section "service settings"
  printf '%s\n' "$settings"
  # Fail closed if the setting did not land in the isolated config: a run that
  # silently kept the default port would target the user's live service.
  [[ "$settings" == *"$SERVICE_PORT"* ]] ||
    die "service port $SERVICE_PORT did not take effect in the isolated config"
  grep -Fq '"port"' "$XDG_CONFIG_HOME/opencode/service.json" ||
    die "expected the isolated $XDG_CONFIG_HOME/opencode/service.json to carry the port"
}

# Sets the global LOG_FILES array. A function cannot return an array in bash
# 3.2 (no `mapfile`), and running this in a command substitution would trap
# `die` inside a subshell, so the caller reads the global.
LOG_FILES=()
collect_log_files() {
  local dir="$XDG_DATA_HOME/opencode/log"
  [[ -d "$dir" ]] || die "no host log directory at $dir — the host never started"
  LOG_FILES=("$dir"/*.log)
  [[ -e "${LOG_FILES[0]}" ]] || die "no host log files in $dir — the host never started"
}

# Boot modes: local-directory (default) and --registry share everything except
# the configured plugin entry and the extra entrypoint assertion.
run_boot_mode() {
  local entry="$1"

  command -v opencode2 >/dev/null || die "opencode2 not found in PATH"
  command -v bun >/dev/null || die "bun not found in PATH"
  [[ "$MODE" == "registry" ]] || require_built_dist

  make_workspace
  write_plugin_config "$entry"
  configure_service_port

  # Run from an empty temp project so no repo/cwd `.opencode` config merges in.
  cd "$WORK/project"

  local warmup_cap="$CAP_SECS"
  if [[ "$MODE" == "registry" ]]; then warmup_cap="$REGISTRY_WARMUP_CAP_SECS"; fi

  # First invocation boots the managed service and triggers plugin loading;
  # `/plugin` is lazily populated, so the listing is read on a second, warm
  # call. Never a bare `opencode2` — that would launch the TUI.
  section "warmup boot (opencode2 plugin list)"
  SERVICE_STARTED=1
  run_capped "$warmup_cap" opencode2 plugin list >"$WORK/warmup.out" 2>"$WORK/warmup.err" ||
    die "warmup 'opencode2 plugin list' failed (exit $?) — see $WORK/warmup.err"
  cat "$WORK/warmup.out"

  section "opencode2 plugin list"
  run_capped "$CAP_SECS" opencode2 plugin list >"$WORK/plugin-list.out" 2>"$WORK/plugin-list.err" ||
    die "'opencode2 plugin list' failed (exit $?)"
  cat "$WORK/plugin-list.out"

  section "opencode2 debug agents (ids)"
  run_capped "$CAP_SECS" opencode2 debug agents >"$WORK/debug-agents.json" 2>"$WORK/debug-agents.err" ||
    die "'opencode2 debug agents' failed (exit $?)"
  SMOKE_AGENTS_JSON="$WORK/debug-agents.json" SMOKE_AGENT_IDS="$WORK/agent-ids.txt" bun -e '
    const agents = JSON.parse(await Bun.file(Bun.env.SMOKE_AGENTS_JSON).text())
    if (!Array.isArray(agents)) throw new Error("debug agents did not return an array")
    await Bun.write(Bun.env.SMOKE_AGENT_IDS, agents.map((a) => a.id).join("\n") + "\n")
  ' ||
    die "could not parse 'opencode2 debug agents' output"
  cat "$WORK/agent-ids.txt"

  assert_load_evidence "$entry"
  assert_plugin_listed
  if [[ "$MODE" == "registry" ]]; then assert_registry_entrypoint; fi
  if ((FULL)); then
    assert_full_agent_corpus
    assert_full_command_corpus
    assert_full_skill_corpus
    assert_full_mcp_registration
  fi
  if ((REFS)); then
    assert_reference_readability
    assert_review_tools
  fi

  section "result"
  log "PASS: plugin '$PLUGIN_ID' loaded from '$entry' under opencode2 (mode: $MODE, full: $FULL)"
}

find_loading_lines() {
  local entry="$1"
  grep -hE 'loading plugin' "${LOG_FILES[@]}" 2>/dev/null | grep -F -- "$entry" || true
}

assert_load_evidence() {
  local entry="$1"
  section "load evidence (host log)"

  # Positive oracle, polled: see EVIDENCE_WAIT_SECS. Bounded and fail-closed —
  # a genuinely dropped plugin never produces this line, so the wait only ever
  # costs time on a real failure. `collect_log_files` is re-run inside the loop
  # (in THIS shell, never a subshell, so `die` and LOG_FILES both escape) to
  # pick up any log file the host creates mid-poll.
  local attempt loading=""
  for attempt in $(seq 1 $((EVIDENCE_WAIT_SECS * 2))); do
    collect_log_files
    loading="$(find_loading_lines "$entry")"
    if [[ -n "$loading" ]]; then break; fi
    sleep 0.5
  done
  [[ -n "$loading" ]] ||
    die "no 'loading plugin' line for '$entry' within ${EVIDENCE_WAIT_SECS}s — the host silently dropped the plugin (no resolvable entry)"
  printf '%s\n' "$loading"

  sleep "$EVIDENCE_SETTLE_SECS"
  local failed
  failed="$(grep -hE 'failed to load plugin' "${LOG_FILES[@]}" 2>/dev/null |
    grep -F -e "$entry" -e "$PACKAGE_NAME" -e "$PLUGIN_ID" || true)"
  if [[ -n "$failed" ]]; then
    printf '%s\n' "$failed" >&2
    die "host logged a plugin load failure for corvus"
  fi
  log "OK: no 'failed to load plugin' line for corvus"
}

assert_plugin_listed() {
  grep -Eq "^${PLUGIN_ID}[[:space:]]" "$WORK/plugin-list.out" ||
    die "'$PLUGIN_ID' not listed by 'opencode2 plugin list'"
  log "OK: '$PLUGIN_ID' present in 'opencode2 plugin list'"
}

# The host resolves an npm specifier against its own install; assert the
# entrypoint it actually loaded is the package's `exports["./server"]` target.
assert_registry_entrypoint() {
  collect_log_files
  local expected_suffix="/node_modules/$PACKAGE_NAME/dist/server.js"

  local entrypoints
  entrypoints="$(grep -hE 'loading plugin' "${LOG_FILES[@]}" 2>/dev/null |
    grep -F -- "$REGISTRY_SPEC" |
    sed -E 's/.*entrypoint="?([^" ]+)"?.*/\1/' |
    sed -E 's/\?.*$//' || true)"
  [[ -n "$entrypoints" ]] || die "could not extract an entrypoint= value for '$REGISTRY_SPEC'"

  section "logged entrypoint(s)"
  printf '%s\n' "$entrypoints"

  local entrypoint
  while IFS= read -r entrypoint; do
    [[ "$entrypoint" == *"$expected_suffix" ]] ||
      die "entrypoint '$entrypoint' does not end with '$expected_suffix'"
  done <<<"$entrypoints"
  log "OK: every logged entrypoint ends with '$expected_suffix'"
}

# Requirement 1's registration gate: every agent in the corpus must reach the
# host. The expected names are derived from the corpus at runtime, never
# hardcoded, so adding an agent tightens this assertion automatically.
assert_full_agent_corpus() {
  section "--full: agent corpus registration"
  local expected=()
  local file
  for file in "$REPO_ROOT"/agent/*.md; do
    [[ -e "$file" ]] || die "no agent/*.md files found under $REPO_ROOT/agent"
    expected+=("$(basename "$file" .md)")
  done
  log "expected ${#expected[@]} agents from $REPO_ROOT/agent/*.md"

  local missing=()
  local name
  for name in "${expected[@]}"; do
    grep -Fxq "$name" "$WORK/agent-ids.txt" || missing+=("$name")
  done
  if ((${#missing[@]} > 0)); then
    printf 'missing agent(s): %s\n' "${missing[*]}" >&2
    die "'opencode2 debug agents' is missing ${#missing[@]} of ${#expected[@]} corpus agents"
  fi
  log "OK: all ${#expected[@]} corpus agents registered"
}

# Requirement 1's remaining three dimensions (commands, skills, MCP).
#
# WHY THE HTTP API: `opencode2 debug` exposes only `agents|config|paths` and the
# CLI has no `command list`/`skill list` subcommand, so agents are the only
# dimension with a dedicated debug surface. The host's own HTTP API does list the
# rest non-interactively against the sandboxed service — operation ids
# `v2.command.list`, `v2.skill.list`, and `v2.mcp.list` in its `/openapi.json`
# (`opencode2 mcp list` covers MCP too, but its human-formatted status output is
# a weaker oracle than the JSON id list). Every expected name is derived from the
# packaged corpus at runtime, never hardcoded, so adding a command or skill
# tightens these assertions automatically.

# Reads one `/api/*` listing and writes its ids one per line to $2. Accepts both
# response shapes the host uses: a bare array and the `{location, data:[…]}`
# envelope.
api_listing_ids() {
  local path="$1"
  local out="$2"

  run_capped "$CAP_SECS" opencode2 api GET "$path" \
    >"$WORK/api-listing.json" 2>"$WORK/api-listing.err" || return 1

  SMOKE_API_JSON="$WORK/api-listing.json" SMOKE_API_IDS="$out" bun -e '
    const body = JSON.parse(await Bun.file(Bun.env.SMOKE_API_JSON).text())
    const data = Array.isArray(body) ? body : body?.data
    if (!Array.isArray(data)) throw new Error(`no array payload in ${Bun.env.SMOKE_API_JSON}`)
    const ids = data.map((entry) => entry?.id ?? entry?.name).filter((id) => typeof id === "string")
    await Bun.write(Bun.env.SMOKE_API_IDS, ids.join("\n") + "\n")
  ' 2>>"$WORK/api-listing.err" || return 1
}

# Asserts every expected name appears in a polled `/api/*` listing. Bounded and
# fail-closed (see LISTING_WAIT_SECS): a corpus that never registers never
# appears, so the wait only costs time on a real failure. Host built-ins share
# these listings, so this is a SUPERSET assertion, exactly like the agent one.
assert_api_corpus() {
  local label="$1"
  local path="$2"
  shift 2
  local expected=("$@")

  section "--full: $label registration (opencode2 api GET $path)"
  log "expected ${#expected[@]} $label from the packaged corpus"

  local ids_file="$WORK/api-ids.txt"
  local attempt name last_error=""
  local missing=("${expected[@]}")
  for attempt in $(seq 1 $((LISTING_WAIT_SECS * 2))); do
    if api_listing_ids "$path" "$ids_file"; then
      missing=()
      for name in "${expected[@]}"; do
        grep -Fxq "$name" "$ids_file" || missing+=("$name")
      done
      if ((${#missing[@]} == 0)); then break; fi
    else
      last_error="$(tail -n 3 "$WORK/api-listing.err" 2>/dev/null || true)"
    fi
    sleep 0.5
  done

  if ((${#missing[@]} > 0)); then
    [[ -z "$last_error" ]] || printf 'last api error: %s\n' "$last_error" >&2
    if [[ -f "$ids_file" ]]; then
      log "listing returned:"
      cat "$ids_file"
    fi
    printf 'missing %s: %s\n' "$label" "${missing[*]}" >&2
    die "'opencode2 api GET $path' is missing ${#missing[@]} of ${#expected[@]} expected $label within ${LISTING_WAIT_SECS}s"
  fi

  log "listing returned:"
  cat "$ids_file"
  log "OK: all ${#expected[@]} $label registered"
}

assert_full_command_corpus() {
  local expected=()
  local file
  for file in "$REPO_ROOT"/command/*.md; do
    [[ -e "$file" ]] || die "no command/*.md files found under $REPO_ROOT/command"
    expected+=("$(basename "$file" .md)")
  done
  assert_api_corpus "commands" /api/command "${expected[@]}"
}

# Skill id is the CONTAINING DIRECTORY's basename, matching the host's own
# derivation in `config/plugin/skill-file.ts` (never the `SKILL.md` filename).
assert_full_skill_corpus() {
  local expected=()
  local file
  for file in "$REPO_ROOT"/skill/*/SKILL.md; do
    [[ -e "$file" ]] || die "no skill/*/SKILL.md files found under $REPO_ROOT/skill"
    expected+=("$(basename "$(dirname "$file")")")
  done
  assert_api_corpus "skills" /api/skill "${expected[@]}"
}

assert_full_mcp_registration() {
  assert_api_corpus "MCP servers" /api/mcp "$MCP_SERVER_NAME"
}

# The package root whose BUILT bundles the host actually loaded: this repo for the
# local mode, the host's own npm install for --registry (derived from the logged
# entrypoint, never assumed).
loaded_install_root() {
  local installed_root="$REPO_ROOT"
  if [[ "$MODE" == "registry" ]]; then
    local entrypoints entrypoint
    entrypoints="$(find_loading_lines "$REGISTRY_SPEC" |
      sed -E 's/.*entrypoint="?([^" ]+)"?.*/\1/' | sed -E 's/\?.*$//' | sort -u)"
    [[ -n "$entrypoints" && "$entrypoints" != *$'\n'* ]] || die "ambiguous installed root for probe"
    entrypoint="$entrypoints"
    [[ "$entrypoint" == */node_modules/"$PACKAGE_NAME"/dist/server.js ]] || die "unrecognized probe entrypoint"
    installed_root="${entrypoint%/dist/server.js}"
  fi
  printf '%s' "$installed_root"
}

assert_reference_readability() {
  section "--refs: sibling reference readability (local matcher, host-registered maps)"
  local installed_root
  installed_root="$(loaded_install_root)" || die "could not determine the loaded install root"
  run_capped "$CAP_SECS" bun run "$REPO_ROOT/scripts/probe-refs.ts" "$WORK/debug-agents.json" "$installed_root" ||
    die "reference-readability probe failed"
}

# All seven review tools on both hosts. No host listing exists for plugin tools (see
# the --refs note in the header), so the oracle is the loaded install root's own
# built bundles driven through the registration tests' host double, plus a
# functional measure → fitted freeze → preview → wrong-digest post rejection in a
# throwaway workspace; the post leg must report zero tool API calls.
assert_review_tools() {
  section "--refs: review tools on both hosts (dist/server.js setup + dist/index.js hooks)"
  local installed_root
  installed_root="$(loaded_install_root)" || die "could not determine the loaded install root"
  [[ -f "$installed_root/dist/server.js" && -f "$installed_root/dist/index.js" ]] ||
    die "loaded install root $installed_root lacks dist/server.js or dist/index.js"
  run_capped "$CAP_SECS" bun run "$REPO_ROOT/scripts/probe-tools.ts" "$installed_root" ||
    die "review-tool probe failed"
}

# --tarball: emulate the host's npm-specifier entry resolution without booting
# it. Pack → isolated install → identity → Bun.resolveSync subpaths → module
# shape. Any mismatch exits non-zero.
run_tarball_mode() {
  command -v bun >/dev/null || die "bun not found in PATH"
  command -v npm >/dev/null || die "npm not found in PATH"
  require_built_dist

  make_workspace
  if ((FULL)); then
    log "note: --full is INERT with --tarball (its only behavior needs a host boot, which this mode forbids)"
  elif ((REFS)); then
    log "note: --refs is INERT with --tarball (requires host-registered agent maps)"
  fi

  local pack_dir="$XDG_CACHE_HOME/smoke-tarball"
  local project="$pack_dir/project"
  mkdir -p "$project"

  section "npm pack (working tree)"
  local tarball_name
  tarball_name="$(cd "$REPO_ROOT" && npm pack --pack-destination "$pack_dir" --loglevel=error | tail -n 1)"
  local tarball="$pack_dir/$tarball_name"
  [[ -f "$tarball" ]] || die "npm pack did not produce $tarball"
  log "packed: $tarball"

  section "npm install (isolated project)"
  printf '{"name":"smoke-v2-tarball","version":"0.0.0","private":true,"type":"module"}\n' \
    >"$project/package.json"
  (cd "$project" && npm install "$tarball" \
    --cache "$XDG_CACHE_HOME/npm-cache" \
    --no-audit --no-fund --ignore-scripts --loglevel=error) ||
    die "npm install of $tarball failed"
  log "installed into: $project"

  # Realpath: Bun.resolveSync returns realpaths (/var/folders → /private/var/...),
  # so the expected paths must be built from the realpath of the project too.
  local project_real
  project_real="$(cd "$project" && pwd -P)"

  section "identity + resolution + module shape assertions"
  cat >"$WORK/tarball-assert.mjs" <<'ASSERT'
const [, , projectDir, repoRoot, packageName] = process.argv

let failures = 0
const pass = (message) => console.log(`OK: ${message}`)
const fail = (message) => {
  console.error(`MISMATCH: ${message}`)
  failures += 1
}
const check = (condition, message) => (condition ? pass(message) : fail(message))

const readJson = async (path) => JSON.parse(await Bun.file(path).text())

const installedDir = `${projectDir}/node_modules/${packageName}`
const workingPkg = await readJson(`${repoRoot}/package.json`)
const installedPkg = await readJson(`${installedDir}/package.json`)

// IDENTITY — proves the resolution below is exercised against THIS working
// tree's package, not a stale install or a registry copy.
check(
  installedPkg.version === workingPkg.version,
  `installed version ${installedPkg.version} === working-tree version ${workingPkg.version}`,
)
const serverExport = installedPkg.exports?.["./server"]
check(
  serverExport && typeof serverExport === "object",
  `installed package.json has exports["./server"] (got ${JSON.stringify(serverExport)})`,
)
for (const condition of ["types", "import", "default"]) {
  check(
    typeof serverExport?.[condition] === "string",
    `exports["./server"].${condition} is present (${JSON.stringify(serverExport?.[condition])})`,
  )
}
check(
  await Bun.file(`${installedDir}/server.js`).exists(),
  `installed root shim ${installedDir}/server.js exists`,
)

// RESOLUTION — byte-faithful to the host's
// Bun.resolveSync([name, sub].join("/"), installedDir) for sub in ["server", ""].
const resolutions = [
  { subpath: "server", expected: `${installedDir}/dist/server.js` },
  { subpath: "", expected: `${installedDir}/dist/index.js` },
]
const resolved = {}
for (const { subpath, expected } of resolutions) {
  const specifier = [packageName, subpath].filter(Boolean).join("/")
  let actual
  try {
    actual = Bun.resolveSync(specifier, projectDir)
  } catch (error) {
    fail(`Bun.resolveSync("${specifier}", projectDir) threw: ${error.message}`)
    continue
  }
  resolved[subpath] = actual
  check(actual === expected, `Bun.resolveSync("${specifier}") === ${expected} (got ${actual})`)
}

// MODULE SHAPE — the v2 host decodes `default` as an OBJECT { id, setup };
// the v1 root entry must stay a FUNCTION.
if (resolved.server) {
  const mod = await import(resolved.server)
  const def = mod.default
  check(typeof def === "object" && def !== null, `server default export is an object (got ${typeof def})`)
  check(typeof def?.id === "string", `server default.id is a string (${JSON.stringify(def?.id)})`)
  check(typeof def?.setup === "function", `server default.setup is a function (got ${typeof def?.setup})`)
}
if (resolved[""]) {
  const mod = await import(resolved[""])
  check(typeof mod.default === "function", `index default export is a function (got ${typeof mod.default})`)
}

if (failures > 0) {
  console.error(`FAIL: ${failures} tarball assertion(s) failed`)
  process.exit(1)
}
ASSERT
  bun run "$WORK/tarball-assert.mjs" "$project_real" "$REPO_ROOT" "$PACKAGE_NAME" ||
    die "tarball-mode assertions failed"

  section "result"
  log "PASS: npm-specifier resolution emulation (mode: tarball)"
}

main() {
  parse_args "$@"
  trap cleanup EXIT INT TERM

  section "smoke-v2 (mode: $MODE, full: $FULL)"
  log "repo:       $REPO_ROOT"
  log "opencode2:  $(command -v opencode2 || echo '<not found>')"
  [[ "$MODE" == "tarball" ]] || log "host cap:   ${CAP_SECS}s per invocation (perl alarm; macOS has no timeout(1))"

  case "$MODE" in
    local) run_boot_mode "$REPO_ROOT" ;;
    registry) run_boot_mode "$REGISTRY_SPEC" ;;
    tarball) run_tarball_mode ;;
    *) die "unhandled mode: $MODE" ;;
  esac
}

main "$@"

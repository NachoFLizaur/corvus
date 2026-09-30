#!/usr/bin/env bash
# Shared smoke-host boundary; sourced by the three harnesses (Bash 3.2 compatible).
# --opencode-bin takes precedence over CORVUS_SMOKE_OPENCODE_V1/V2. Explicit
# values must be absolute; only an unset value permits a warned PATH fallback.

smoke_host_help() {
  printf '%s\n' \
    '  --opencode-bin ABS  host executable; overrides CORVUS_SMOKE_OPENCODE_V1/V2' \
    '                      unset: warned PATH lookup of opencode/opencode2' \
    '  CORVUS_SMOKE_TMP_ROOT  temporary parent (default: ${TMPDIR:-/tmp}/opencode)' \
    '  Every run reports host realpath/version and before/after SHA-256 digests.' \
    '  Digests cover ~/.config/opencode, ~/.opencode/opencode.json(c), inherited XDG config, global CLI installs' \
    '  and binaries (contents + symlink targets, not timestamps); no live writes.'
}

smoke_row() { printf '[%s|%s] %s\n' "${SMOKE_EVIDENCE_KIND:-local probe}" "${SMOKE_EVIDENCE_SOURCE:-isolation}" "$*"; }
smoke_error() { smoke_row "FAIL: $*" >&2; return 1; }
smoke_rows() { local line; while IFS= read -r line || [[ -n "$line" ]]; do smoke_row "$line"; done; }

# Snapshot oracle: recursively hash bytes, names, modes, and symlink targets of
# live config and global installs, plus the selected executable. Read before any
# host invocation, then again AFTER service shutdown in the caller's EXIT trap.
# Missing paths are explicit markers; unreadable paths fail, never count as equal.
# No mode disables comparison (including failure/negative-control exits). Concurrent
# user edits also fail the run: equality is evidence only for this measured interval.
# Binary bytes + realpaths cover replacement even with an unchanged version string;
# global binaries are never executed just to measure them (they may be dev builds).
smoke_live_digest() {
  bun -e '
    const fs = await import("node:fs")
    const { join } = await import("node:path")
    async function digest(roots) {
      const hash = new Bun.CryptoHasher("sha256")
      const field = value => hash.update(JSON.stringify(value) + "\n")
      async function visit(path, ancestors = new Set()) {
        field(path)
        let stat
        try { stat = fs.lstatSync(path) }
        catch (error) { if (error.code === "ENOENT") { field("missing"); return }; throw error }
        field(stat.mode)
        if (stat.isSymbolicLink()) {
          field(fs.readlinkSync(path))
          let real
          try { real = fs.realpathSync(path) }
          catch (error) { if (error.code === "ENOENT") { field("dangling"); return }; throw error }
          if (ancestors.has(real)) { field("cycle"); return }
          await visit(real, ancestors)
        } else if (stat.isDirectory()) {
          const next = new Set(ancestors).add(fs.realpathSync(path))
          for (const name of fs.readdirSync(path).sort()) await visit(join(path, name), next)
        } else if (stat.isFile()) {
          field(stat.size)
          for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
        } else { throw new Error("Unsupported live-state file type: " + path) }
      }
      for (const root of [...new Set(roots)].sort()) await visit(root)
      return hash.digest("hex")
    }
    const home = process.env.HOME
    const config = await digest([home + "/.config/opencode", process.env.SMOKE_ORIGINAL_CONFIG + "/opencode",
      home + "/.opencode/opencode.json", home + "/.opencode/opencode.jsonc"])
    const global = await digest(["/opt/homebrew/lib/node_modules/@opencode/cli",
      "/opt/homebrew/bin/opencode", "/opt/homebrew/bin/opencode2", home + "/.opencode/bin/opencode", process.env.CLI])
    console.log(`config=${config} global=${global}`)
  '
}

smoke_live_assert() {
  local SMOKE_EVIDENCE_KIND='local probe'
  [[ -n "${SMOKE_LIVE_BEFORE:-}" ]] || return 0
  local after
  after="$(smoke_live_digest)" || { smoke_error 'live-config/global digest unreadable after run'; return 1; }
  if [[ "$after" != "$SMOKE_LIVE_BEFORE" ]]; then
    smoke_error "live-config/global digest changed; before $SMOKE_LIVE_BEFORE; after $after"
    return 1
  fi
  smoke_row "PASS: live-config/global digest unchanged; before=$SMOKE_LIVE_BEFORE; after=$after"
}

# Stable 2.0.20 requires the location header (not directory= or CLI --param).
# Redirect responses to files: large skill listings can truncate through a pipe.
smoke_v2_api_read() {
  local endpoint="$1" output="$2" location="$3" seconds="${4:-60}" header
  header="$(SMOKE_LOCATION="$location" bun -e 'console.log(encodeURIComponent(process.env.SMOKE_LOCATION))')" || return 1
  perl -e 'alarm shift; exec @ARGV' "$seconds" "$CLI" api GET "$endpoint" --header "x-opencode-directory: $header" \
    >"$output" 2>"$WORK/api-listing.err"
}

# State oracle: scoped GET after debug agents initializes the location. The shared
# checker requires exactly one active corvus server; only absence is polled for
# lazy activation. API/invalid-state failures return nonzero to abort the caller
# before model dispatch. Both callers separately settle/reject load and transform
# failure logs, which can invalidate an earlier active snapshot. No bypass flag.
smoke_v2_plugin_state() {
  local location="$1" output="$2" wait="${3:-30}" seconds="${4:-60}" attempt result=1
  smoke_row '=== plugin-state assertion (GET /api/plugin, explicit location) ==='
  for ((attempt=0; attempt<wait*2; attempt++)); do
    smoke_v2_api_read /api/plugin "$output" "$location" "$seconds" || { smoke_error 'plugin-state: API request failed'; return 1; }
    result=0
    SMOKE_STATE="$output" SMOKE_LOCATION="$location" SMOKE_CHECKER="$(dirname "${BASH_SOURCE[0]}")/check-review-artifacts.ts" bun -e '
      const { checkPluginState } = await import(process.env.SMOKE_CHECKER)
      const result = checkPluginState(process.env.SMOKE_STATE, process.env.SMOKE_LOCATION)
      if (!result.absent) console.log(result.detail)
      process.exit(result.ok ? 0 : result.absent ? 2 : 1)
    ' >"$WORK/plugin-state-result.txt" 2>&1 || result=$?
    smoke_rows <"$WORK/plugin-state-result.txt"
    case "$result" in
      0) return 0 ;;
      2) sleep 0.5 ;;
      *) smoke_error 'plugin-state: corvus must have state.status=active and features.server=true'; return 1 ;;
    esac
  done
  smoke_error "plugin-state: corvus absent after ${wait}s"
}

# Port oracle: bind an OS-assigned loopback port, then close it. Never 49374.
# The caller rechecks immediately before boot; the reservation is not atomic with
# host startup, so an intervening listener causes refusal, not a live-port fallback.
# Version probes use the same isolated service.json without starting a service.
smoke_free_port() {
  bun -e '
    const { createServer } = await import("node:net")
    const requested = Number(process.env.SMOKE_CHECK_PORT || 0)
    function check() {
      const server = createServer()
      server.once("error", error => { console.error(error.message); process.exitCode = 1 })
      server.listen({ host: "127.0.0.1", port: requested }, () => {
        const port = server.address().port
        server.close(() => {
          if (port === 49374) { if (requested) process.exitCode = 1; else check() }
          else console.log(port)
        })
      })
    }
    check()
  '
}

# Resolve and probe before packaging, credentials, fixture mutation, or service
# startup. Only a fresh probe sandbox is created first so even --version cannot
# use live XDG/service settings. Invalid versions and major mismatches fail closed;
# no flag bypasses the check, and PATH is never prepended with the host's bin dir.
# Caller must install its EXIT cleanup (including smoke_live_assert) before entry.
smoke_host_prepare() {
  local host="$1" explicit="${2:-}" fallback name
  [[ "$host" == v1 || "$host" == v2 ]] || { smoke_error 'expected --host v1|v2'; return 1; }
  for name in bun perl; do command -v "$name" >/dev/null || { smoke_error "missing executable: $name"; return 1; }; done
  if [[ "$host" == v2 ]]; then
    explicit="${explicit:-${CORVUS_SMOKE_OPENCODE_V2:-}}"; fallback=opencode2
  else
    explicit="${explicit:-${CORVUS_SMOKE_OPENCODE_V1:-}}"; fallback=opencode
  fi
  if [[ -z "$explicit" ]]; then
    smoke_row "WARNING: no explicit $host executable; falling back to PATH lookup of $fallback" >&2
    explicit="$(command -v "$fallback")" || { smoke_error "$fallback not found"; return 1; }
  fi
  [[ "$explicit" == /* && -f "$explicit" && -x "$explicit" ]] || { smoke_error 'host executable must be an executable absolute file path'; return 1; }
  CLI="$(SMOKE_BIN="$explicit" bun -e 'console.log(require("node:fs").realpathSync(process.env.SMOKE_BIN))')" || return 1
  export CLI
  export SMOKE_ORIGINAL_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
  SMOKE_LIVE_BEFORE="$(smoke_live_digest)" || { smoke_error 'cannot snapshot live-config/global digest'; return 1; }

  local base="${CORVUS_SMOKE_TMP_ROOT:-${TMPDIR:-/tmp}/opencode}"
  mkdir -p "$base" || return 1
  WORK="$(mktemp -d "${base%/}/smoke-$host.XXXXXX")" || return 1
  WORK="$(cd "$WORK" && pwd -P)" || return 1
  mkdir -p "$WORK"/xdg/{data/opencode,config/opencode,state,cache} "$WORK"/{project,tmp} || return 1
  while IFS= read -r name; do unset "$name"; done < <(compgen -v OPENCODE_)
  unset BASH_ENV ENV
  export XDG_DATA_HOME="$WORK/xdg/data" XDG_CONFIG_HOME="$WORK/xdg/config"
  export XDG_STATE_HOME="$WORK/xdg/state" XDG_CACHE_HOME="$WORK/xdg/cache"
  export TMPDIR="$WORK/tmp" SHELL=/bin/bash
  export npm_config_cache="$XDG_CACHE_HOME/npm-cache"
  SMOKE_PORT="$(smoke_free_port)" || return 1
  export SMOKE_PORT
  bun -e 'await Bun.write(process.env.XDG_CONFIG_HOME + "/opencode/service.json", JSON.stringify({ port: Number(process.env.SMOKE_PORT) }) + "\n")' || return 1
  SMOKE_EVIDENCE_KIND='local probe' smoke_row "sandbox: $WORK; verified-free port: $SMOKE_PORT (never 49374)"
  local version
  version="$(cd "$WORK/project" && perl -e 'alarm shift; exec @ARGV' 30 "$CLI" --version)" || { smoke_error 'host --version failed'; return 1; }
  SMOKE_HOST_VERSION="$version"
  SMOKE_EVIDENCE_KIND='real-host assertion' smoke_row "resolved host: $CLI; reported version: $version; requested host: $host"
  if [[ "$version" =~ ^(opencode[[:space:]]+v?)?([0-9]+)\.[0-9]+\.[0-9]+([-+][[:alnum:].-]+)?$ ]]; then
    [[ "${BASH_REMATCH[2]}" == "${host#v}" ]] || { smoke_error "host major-version mismatch: requested $host, reported $version; no service/model started"; return 1; }
  else
    smoke_error "unrecognized host version: $version; no service/model started"; return 1
  fi
}

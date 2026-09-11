#!/usr/bin/env bash
set -euo pipefail

# Admission invariant: argv is checked before exec; only the read command table
# below can reach the pre-resolved real gh. Missing configuration/audit writes
# fail closed. No command-line switch disables the check. This PATH barrier is
# defense in depth, not an OS sandbox against absolute binaries or other clients.
: "${CORVUS_SMOKE_REAL_GH:?real gh must be resolved before installing the shim}"
: "${CORVUS_SMOKE_GH_AUDIT:?an audit path is required}"

readonly real_gh="$CORVUS_SMOKE_REAL_GH"
allowed=0
case "${1:-} ${2:-}" in
  'repo view'|'repo clone'|'pr view'|'pr diff'|'pr checks'|'pr list'|'auth status') allowed=1 ;;
  'pr checkout')
    for arg in "${@:3}"; do
      [[ "$arg" != --detach ]] || allowed=1
      case "$arg" in --detach=*|--branch*|-b*|--force*|-f*) allowed=0; break ;; esac
    done
    ;;
esac

check_api() {
  shift
  allowed=1
  endpoint=""
  while (($#)); do
    case "$1" in
      --method|-X)
        [[ $# -ge 2 && "$2" == GET ]] || { allowed=0; break; }
        shift 2 ;;
      --method=GET|-XGET) shift ;;
      --header|-H)
        [[ $# -ge 2 && "$2" == 'Accept: application/vnd.github.raw+json' ]] || { allowed=0; break; }
        shift 2 ;;
      --paginate|--slurp|--silent|--include|-i|--verbose) shift ;;
      --jq|-q|--template|-t|--cache)
        [[ $# -ge 2 ]] || { allowed=0; break; }
        shift 2 ;;
      --jq=*|--template=*|--cache=*) shift ;;
      -*) allowed=0; break ;;
      *)
        [[ -z "$endpoint" ]] || { allowed=0; break; }
        endpoint="$1"
        # Relative REST endpoints may carry query parameters, never GraphQL.
        [[ "$endpoint" =~ ^/?[a-zA-Z0-9_{}./?%\&=+-]+$ && "$endpoint" != *..* ]] || { allowed=0; break; }
        case "${endpoint%%\?*}" in graphql|/graphql|graphql/*|/graphql/*) allowed=0; break ;; esac
        shift ;;
    esac
  done
  [[ -n "$endpoint" ]] || allowed=0
}
if [[ "${1:-}" == api ]]; then check_api "$@"; fi

marker=CORVUS_SMOKE_MUTATION_BLOCKED
((allowed == 0)) || marker=CORVUS_SMOKE_GH_FORWARD
# JSON escapes embedded newlines; argv cannot forge extra audit records. Log no
# environment/auth data. The caller must not place secrets in command arguments.
CORVUS_SMOKE_DECISION="$marker" bun -e '
  const record = { marker: process.env.CORVUS_SMOKE_DECISION, argv: process.argv.slice(1) }
  const { appendFileSync } = await import("node:fs")
  appendFileSync(process.env.CORVUS_SMOKE_GH_AUDIT, JSON.stringify(record) + "\n", { mode: 0o600 })
' -- "$@"

if ((allowed == 0)); then
  printf 'CORVUS_SMOKE_MUTATION_BLOCKED' >&2
  printf ' %q' "$@" >&2
  printf '\n' >&2
  exit 1
fi
exec "$real_gh" "$@"

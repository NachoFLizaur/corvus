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
  'repo view'|'repo clone'|'pr view'|'pr diff'|'pr checks'|'auth status') allowed=1 ;;
  'pr list'|'pr status'|'issue view'|'issue list'|'run list'|'run view') allowed=1 ;;
  'pr checkout')
    for arg in "${@:3}"; do
      [[ "$arg" != --detach ]] || allowed=1
      case "$arg" in --detach=*|--branch*|-b*|--force*|-f*) allowed=0; break ;; esac
    done
    ;;
esac
[[ "${1:-}" != search ]] || allowed=1

# CLI admission reads every argument before exec/audit. Mutation transport flags
# fail closed even on an admitted read subcommand; JSON output is optional. API
# calls use the stricter parser below instead. No read flag disables either check.
if [[ "${1:-}" != api ]]; then
  for arg in "$@"; do
    case "$arg" in
      --method|--method=*|-X*|--input|--input=*|-f*|-F*|--field|--field=*|--raw-field|--raw-field=*) allowed=0; break ;;
    esac
  done
fi

accept=""
jq_filter=""
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
        [[ $# -ge 2 ]] || { allowed=0; break; }
        case "$2" in
          'Accept: application/vnd.github.raw+json'|'Accept:application/vnd.github+json'|'Accept: application/vnd.github+json') ;;
          'Accept:application/vnd.github.v3.diff'|'Accept: application/vnd.github.v3.diff') ;;
          *) allowed=0; break ;;
        esac
        accept="${2#Accept:}"; accept="${accept# }"
        shift 2 ;;
      --paginate|--slurp|--silent|--include|-i|--verbose) shift ;;
      --jq|-q)
        [[ $# -ge 2 ]] || { allowed=0; break; }
        jq_filter="$2"
        shift 2 ;;
      --template|-t|--cache)
        [[ $# -ge 2 ]] || { allowed=0; break; }
        shift 2 ;;
      --jq=*) jq_filter="${1#--jq=}"; shift ;;
      --template=*|--cache=*) shift ;;
      -*) allowed=0; break ;;
      *)
        [[ -z "$endpoint" ]] || { allowed=0; break; }
        endpoint="$1"
        # Relative REST endpoints may carry query parameters, never GraphQL.
        local checked_endpoint="$endpoint"
        # Exempt one compare separator, not traversal or other repeated dots.
        if [[ "$endpoint" =~ ^/?repos/[^/]+/[^/]+/compare/[^?]+[.][.][.][^?]+([?].*)?$ && "$endpoint" != *....* ]]; then
          checked_endpoint="${endpoint/.../}"
        fi
        [[ "$endpoint" =~ ^/?[a-zA-Z0-9_{}./?%\&=+-]+$ && "$checked_endpoint" != *..* ]] || { allowed=0; break; }
        case "${endpoint%%\?*}" in graphql|/graphql|graphql/*|/graphql/*) allowed=0; break ;; esac
        shift ;;
    esac
  done
  [[ -n "$endpoint" ]] || allowed=0
}
if [[ "${1:-}" == api ]]; then check_api "$@"; fi

# Canned mode (CORVUS_SMOKE_GH_CANNED=<fixture dir>): admitted PR reads are served
# from fixture files and nothing reaches the network; admission above is unchanged,
# so mutations stay blocked. Only the four writer/R5 read endpoints have fixtures;
# any other admitted call fails closed with CORVUS_SMOKE_CANNED_MISSING.
canned=""
if ((allowed == 1)) && [[ -n "${CORVUS_SMOKE_GH_CANNED:-}" ]]; then
  canned=missing
  if [[ "${1:-}" == api && "${endpoint#/}" =~ ^repos/[^/]+/[^/]+/pulls/[1-9][0-9]*(/files|/reviews)?$ ]]; then
    case "${BASH_REMATCH[1]}" in
      '') [[ "$accept" == application/vnd.github.v3.diff ]] && canned=pull.diff || canned=pull.json ;;
      /files) canned=files.json ;;
      /reviews) canned=reviews.json ;;
    esac
  fi
  [[ "$canned" != missing && -f "$CORVUS_SMOKE_GH_CANNED/$canned" ]] || canned=missing
  # Head-moved mode (pull.moved.json present): the first PR metadata read serves pull.json
  # and every later one pull.moved.json — the head moves after the writer's own check, so
  # the post tool's independent head recheck must reject before any POST. Admission and
  # mutation blocking are unchanged; the served fixture name is recorded in the audit.
  if [[ "$canned" == pull.json && -f "$CORVUS_SMOKE_GH_CANNED/pull.moved.json" ]]; then
    reads=0
    [[ ! -f "$CORVUS_SMOKE_GH_CANNED/.pull-reads" ]] || IFS= read -r reads <"$CORVUS_SMOKE_GH_CANNED/.pull-reads" || true
    [[ "$reads" =~ ^[0-9]{1,6}$ ]] || reads=0
    printf '%s\n' "$((reads + 1))" >"$CORVUS_SMOKE_GH_CANNED/.pull-reads"
    ((reads == 0)) || canned=pull.moved.json
  fi
fi

marker=CORVUS_SMOKE_MUTATION_BLOCKED
if ((allowed == 1)); then
  marker=CORVUS_SMOKE_GH_FORWARD
  [[ -z "$canned" ]] || marker=CORVUS_SMOKE_GH_CANNED
fi
# JSON escapes embedded newlines; argv cannot forge extra audit records. Log no
# environment/auth data. The caller must not place secrets in command arguments.
CORVUS_SMOKE_DECISION="$marker" CORVUS_SMOKE_CANNED_FIXTURE="$canned" bun -e '
  const record = { marker: process.env.CORVUS_SMOKE_DECISION, argv: process.argv.slice(1) }
  if (process.env.CORVUS_SMOKE_CANNED_FIXTURE) record.fixture = process.env.CORVUS_SMOKE_CANNED_FIXTURE
  const { appendFileSync } = await import("node:fs")
  appendFileSync(process.env.CORVUS_SMOKE_GH_AUDIT, JSON.stringify(record) + "\n", { mode: 0o600 })
' -- "$@"

if ((allowed == 0)); then
  printf 'CORVUS_SMOKE_MUTATION_BLOCKED' >&2
  printf ' %q' "$@" >&2
  printf '\n' >&2
  exit 1
fi
if [[ -n "$canned" ]]; then
  if [[ "$canned" == missing ]]; then
    printf 'CORVUS_SMOKE_CANNED_MISSING' >&2
    printf ' %q' "$@" >&2
    printf '\n' >&2
    exit 1
  fi
  # Fixture bytes are data. Only a dotted key path is honored for --jq (the writer
  # uses `.head.sha`); any other filter fails closed rather than approximating jq.
  CORVUS_SMOKE_CANNED_FILE="$CORVUS_SMOKE_GH_CANNED/$canned" CORVUS_SMOKE_CANNED_JQ="$jq_filter" bun -e '
    const { readFileSync } = await import("node:fs")
    const bytes = readFileSync(process.env.CORVUS_SMOKE_CANNED_FILE)
    const filter = process.env.CORVUS_SMOKE_CANNED_JQ
    if (!filter) { await new Promise(done => process.stdout.write(bytes, done)); process.exit(0) }
    if (!/^(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(filter)) { console.error("CORVUS_SMOKE_CANNED_UNSUPPORTED_JQ " + filter); process.exit(1) }
    let value = JSON.parse(bytes.toString("utf8"))
    for (const key of filter.slice(1).split(".")) value = value !== null && typeof value === "object" ? value[key] : undefined
    console.log(typeof value === "string" ? value : JSON.stringify(value ?? null))
  '
  exit $?
fi
exec "$real_gh" "$@"

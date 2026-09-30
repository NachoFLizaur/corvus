# Real Session-Store Captures

T7 of `opencode-v2-stable-compat`, captured on 2026-09-29 UTC (2026-09-30
local date). Both fixtures are redacted **real captures, not synthetic**. Each
host completed its first model attempt with one parent and one `explore` child.
These are storage/CLI adapter inputs, not complete Corvus review runs or evidence
that the review checker's acceptance rows pass.

## Files And Materialization

| Host | Exact Schema | Captured Rows | Paired Parent CLI Stream |
| --- | --- | --- | --- |
| v1 1.18.33 | `v1/schema.sql`: `session`, `message`, `part`; later `session_message` DDL amendment below | `v1/data.sql`: 2 sessions, 9 messages, 27 parts | `v1/run.jsonl`: 19 events |
| v2 2.0.20 | `v2/schema.sql`: `session_v2`, `session_message` | `v2/data.sql`: 2 sessions, 10 projected messages | `v2/run.jsonl`: 9 events |

The schema files contain the exact `sqlite_master.sql` table/index definitions
from the stopped hosts, equivalent to `.schema` for those tables (indexes sorted
by name). Data files preserve every row/column of those tables from the fresh
capture DBs, subject only to the redactions below. No credential, project, event,
instruction-blob, or unrelated host tables are exported. Child linkage needs no
additional table. SQL was chosen over binary DBs for reviewability and direct
`bun:sqlite` consumption; the original six data/schema/JSONL files totaled 47,189 bytes.

### T11 Schema Amendment — 2026-09-30

Added the exact `sqlite_master.sql` table DDL for `session_message` from T11's
stopped OpenCode 1.18.33 store (`$TMP_ROOT/smoke-v1.OoRt38`), inspected with
`sqlite3 -readonly` on a private copy of the DB and its WAL/SHM files. Its foreign
key references `session`, not `session_v2`. No rows or indexes were added; the
original T7 captured subset contains no `session_message` rows and remains
unchanged. This amendment reproduces the live-v1 schema collision that the
original selected-table fixture omitted. The T10 2.0.20 store contains
`session_v2`/`session_message` and no legacy `session`/`part` tables; synthetic
tests additionally pin complete-v2 precedence when legacy tables coexist and
explicit unavailability for an incomplete v2 pair.

Materialize into a new database, never a live host store:

```typescript
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const directory = "src/__tests__/fixtures/session-store/v2" // or v1
const db = new Database(":memory:") // use a temporary path for the checker
// The deliberately omitted project table is referenced by the exact host DDL.
db.exec("PRAGMA foreign_keys = OFF;")
db.exec(readFileSync(join(directory, "schema.sql"), "utf8"))
db.exec(readFileSync(join(directory, "data.sql"), "utf8"))
// The checker opens a file-backed database read-only after db.close().
db.close()
```

No database path, connection, or test helper is added to production code. The
existing checker tests synthesize v1 rows in code; no fixture directory existed
when this capture was made. T8 owns adapter changes and regression integration.

## Capture Provenance

Path placeholders preserve privacy: `$REPO` is the Corvus checkout, `$TMP_ROOT`
is the authorized temporary parent, `$WORK` is the per-invocation sandbox, and
`$HOME` is the unchanged user home. The realpaths and versions were resolved by
`scripts/host.sh` before launch; no PATH-selected host was used.

| Item | v1 | v2 |
| --- | --- | --- |
| Selected executable | `$HOME/.opencode/bin/opencode` | `$TMP_ROOT/oc2-2.0.20/node_modules/.bin/opencode2` |
| Resolved executable | same | `$TMP_ROOT/oc2-2.0.20/node_modules/@opencode/cli/bin/opencode.exe` |
| `--version` stdout | `1.18.33` | `opencode v2.0.20` |
| Capture sandbox | `$TMP_ROOT/smoke-v1.ThD7FU` | `$TMP_ROOT/smoke-v2.Apsx2A` |
| Start UTC | `2026-09-29T22:33:46.487Z` | `2026-09-29T22:34:26.305Z` |
| Last CLI event UTC | `2026-09-29T22:34:08.745Z` | `2026-09-29T22:34:39.277Z` |
| Selected free port | 64746 (no background service launched) | 64887 |
| Model / agent | `amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0` / `build` | same |
| CLI exit | 0 | 0 |
| Model attempts | 1 | 1 |

The same model was inherited by each child. Each run was a single supplied user
turn, capped at 180 seconds with `perl -e 'alarm shift; exec @ARGV'`. Stop after
the first successful capture; no retry or more expensive model was needed. The
host-reported session cost sums are v1 `$0.03250215 + $0.008472 = $0.04097415`
and v2 `$0.02661046 + $0.005288 = $0.03189846` (parent plus child). These are
recorded host estimates, not billing receipts or a guaranteed spending cap.

### Commands And Setup

Temporary capture scripts reused `smoke_host_prepare`, `smoke_free_port`, and
`smoke_live_assert` from `scripts/host.sh`, without modifying it. Each invocation
used a fresh `mktemp -d "$TMP_ROOT/smoke-$HOST.XXXXXX"` sandbox, `umask 077`, and
these environment assignments before any host command:

```bash
export XDG_DATA_HOME="$WORK/xdg/data" XDG_CONFIG_HOME="$WORK/xdg/config"
export XDG_STATE_HOME="$WORK/xdg/state" XDG_CACHE_HOME="$WORK/xdg/cache"
export TMPDIR="$WORK/tmp" SHELL=/bin/bash
export npm_config_cache="$XDG_CACHE_HOME/npm-cache"
```

Inherited `OPENCODE_*`, `BASH_ENV`, and `ENV` were cleared. `HOME` and AWS
credentials were intentionally retained, following the smoke harness. Thus XDG
state and service settings are isolated, but this is not a filesystem/network
sandbox: the host can still discover external skills under the unchanged home.
The model's observed tools were limited to the four requested parent calls and
the child's single read. No Git or GitHub operations were requested from it.

Create `$WORK/project/sample.txt` containing exactly
`T7 session-store fixture: hello.\n`; leave `missing-t7.txt` absent. Every command
below ran with process cwd and `PWD` set to `$WORK/project`. The isolated config
at `$XDG_CONFIG_HOME/opencode/opencode.json` was:

```json
{"plugins":["$REPO"]}
```

for v2, and the harness's explicit v1 entrypoint:

```json
{"plugin":["$REPO/dist/server.js"]}
```

for v1. `$REPO` denotes an expanded absolute path, not a literal config variable.
Using v1's `dist/server.js` rather than directory resolution follows
`scripts/smoke-review.sh`; the existing Phase 1–2 build was reused, not rebuilt.

Exact model command, with identical prompt on both hosts (`$CLI` is the resolved
executable above; stdout became that host's `run.jsonl` after redaction):

```bash
PROMPT='This is a tiny session-store capture, not a code change. Do exactly these four actions in order: (1) use the read tool to read sample.txt in the current directory; (2) use read on missing-t7.txt once to record the expected failure, do not repair it; (3) use shell (or bash) to run pwd once; (4) delegate one task to the explore subagent: use read to read sample.txt in this same directory and return its first line. Wait for the child to finish, then reply DONE in one line. Do not edit files, access the network, run git, or do other work.'
perl -e 'alarm shift; exec @ARGV' 180 "$CLI" run --agent build --model amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0 --format json "$PROMPT"
```

v2 preparation ran `service set port 64887` (30-second cap), `run --help`
(30 seconds), and `api GET /api/model --header "x-opencode-directory: $ENCODED_CWD"`
(60 seconds) before the model command; `$ENCODED_CWD` was
`encodeURIComponent($WORK/project)`. All exited 0. Afterwards `service stop`
(30 seconds) exited 0 and `lsof -nP -iTCP:64887 -sTCP:LISTEN -t` found no
listener. Port 49374 was never selected. Only after shutdown was
`$XDG_DATA_HOME/opencode/opencode.db` opened read-only for export.

There was also one non-model discovery invocation per host, each in its own
fresh sandbox: v2 `smoke-v2.u97gRf` on port 64618 ran the same preparation
commands and stopped its service; v1 `smoke-v1.g6hzc4` ran `run --help` and
`models amazon-bedrock`. All exited 0. The latter listed the selected global
Haiku ID. v1's help stdout was empty. Both initial v2 model-list responses had
`data: []`; the explicit model nevertheless completed successfully. The stable
model API contract says its snapshot may precede initial plugin settlement;
an empty early snapshot alone is not proof of missing credentials.

### Bedrock Credential Seeding

Before any model/service boot, copy only the `amazon-bedrock` entry from
`$HOME/.local/share/opencode/auth.json` to
`$XDG_DATA_HOME/opencode/auth.json`, mode 0600, using the same JSON shape as
`scripts/smoke-review.sh:166–176`. The source entry was present with `type: "api"`.
Do not log its key. The inherited environment had `AWS_BEARER_TOKEN_BEDROCK`
(the only `AWS_*` key present), and `$HOME/.aws` existed. This combination worked
on both versions with no provider-config override or manual v2 credential-table
write. It does **not** prove the legacy auth copy was consumed or necessary on
v2; environment-only versus auth-file-only authentication was not isolated.
T9/T10 can reproduce the working combination rather than infer v1 auth migration.
Never publish the raw sandbox: it contains private auth and unredacted host logs.

## Observed Shapes And Linkage

| Requested Action | v1 | v2 |
| --- | --- | --- |
| (a) Ordinary tool call | parent `read`, completed | parent `read`, completed |
| (b) Child session | `task` → `explore`, child read completed | `subagent` → `explore`, child read completed |
| (c) Failed tool | parent `read` missing file, error | parent `read` missing file, structured error |
| (d) Shell | parent `bash`, `command: "pwd"`, exit 0 | parent `shell`, `command: "pwd"`, exit 0 |

### v2

- Parent: `ses_f10b1ed08ffeabthV0E993VahV`; child:
  `ses_f10b1dd73ffelTDYmdsXRADS84`. The child's `session_v2.parent_id` equals the
  parent ID and its `agent` is `explore`. Both `idle_outcome` values are
  `succeeded`. `parent_id` is a column, not an ID inferred from assistant prose;
  it is not declared a foreign key in the captured schema.
- Parent `subagent` call `tooluse_ZMh8Li7ME39aZU995pGQ4T` also records the child
  ID and `status: "completed"` at stored `state.metadata.sessionID/status`.
  CLI JSONL nests those under `part.state.metadata.metadata`. Its textual result
  contains `<subagent sessionID="..." state="completed">`.
- `session_message.type` and `id` are separate columns, absent from `data`.
  Read assistant `data.content[]` in `seq` order, then content-array order.
  Parent assistant sequences are 8 and 30; child assistant sequences are 5 and
  14. Sequence gaps are real, not omitted rows. All four parent tools share one
  assistant message, `msg_0ef4e135d001q7z2CIcG7ldaul`.
- Stored tool entries use `type: "tool"`, `name`, and `id`; CLI entries use
  `type: "tool_use"`, `part.tool`, and `part.id` (not `part.partID`, which is a
  separate presentation-part identifier). Completed stored `state.content` is
  an array of text blocks; the CLI exposes its text as `state.output`.
- Failed call `tooluse_hMRlrbTZNpBI3uujIGYYDx` has stored
  `state.error = {"type":"tool.execution","message":"File not found: missing-t7.txt"}`,
  versus CLI `state.error = "File not found: missing-t7.txt"`. Neither has an
  output for this failed call. Preserve the structured error while comparing
  its diagnostic with the CLI; do not replace it with a fabricated success.
- CLI contains parent events only. The child read exists only in the store.
  The final parent assistant is complete in the DB, but this real CLI stream
  has no second `step_finish` event. It ends with the terminal text event. Do
  not add an invented event or treat the CLI's cost subtotal as the run total.
  The terminal text also discusses a host Code Mode catalog update instead of
  obeying the one-line response request; that real behavior is retained.

### v1

- Parent: `ses_f10b2792bffeDm2v1SWgM3LAE7`; child:
  `ses_f10b24434ffehOlM99nwpLaJhN`, linked by `session.parent_id`, agent `explore`.
- Stored `part.data` has `type: "tool"`, `tool`, `callID`, and `state`, but omits
  row `id`, `message_id`, and `session_id`. CLI supplies these as `part.id`,
  `messageID`, and `sessionID`. Preserve the row session ID when normalizing.
- Failed read `tooluse_EPiQVfCArS74OvsgkMPXzb` has the same string error in both
  streams. `task` metadata uses `sessionId` and `parentSessionId` (lowercase d),
  unlike v2's `sessionID`; its output wraps the result in `<task id="..."
  state="completed">`. Children are not present in parent CLI JSONL.

The v2 premises were checked against installed `@opencode/schema` 2.0.20
`dist/session-message.js:108–164`, and upstream commit
`84c9be93a56304a108f1a22df0c5d62c26d5b6ca`:
[session/sql.ts](https://github.com/anomalyco/opencode/blob/84c9be93a56304a108f1a22df0c5d62c26d5b6ca/packages/core/src/session/sql.ts)
and [run/noninteractive.ts](https://github.com/anomalyco/opencode/blob/84c9be93a56304a108f1a22df0c5d62c26d5b6ca/packages/cli/src/run/noninteractive.ts).
The actual stopped-host schemas and paired records above are the fixture oracle.

## Redaction And Preservation

1. Replace the absolute capture project directory in every SQL JSON field and
   CLI string, including tool input, output, metadata and `rawInput`, with
   `/fixture/v1/project` or `/fixture/v2/project`. Also replace the slash-less
   spelling used in v1 titles/relative paths. The same substitution is applied
   to both members of each CLI/DB pair.
2. Replace checkout/home path occurrences with `/fixture/corvus` and
   `/home/fixture-user` if present. No live config or credentials are exported.
3. Truncate only the v2 system-message `text` at parent sequence 29 to its first
   120 characters plus an explicit truncation marker. Its type, metadata,
   timestamps, and sequence remain. No v1 prompt needed truncation. Initial
   system prompts not stored in these selected tables are not reconstructed.
4. Preserve IDs, timestamps, model IDs, all tool input/output/error shapes,
   state/status, terminal assistant text, ordering, SQL NULLs, and cost/token
   values. Keep all selected-table rows and every emitted CLI event. SQL string
   quoting doubles apostrophes; embedded JSON stays text, not a new schema.
5. Before export, compare against the actual inherited AWS token and Bedrock
   auth key without printing them; refuse export if either occurs. Also reject
   remaining personal home/temporary path prefixes. This targeted scan is not
   a general secret-detector guarantee. No secret replacement was needed in
   the selected records; path redaction and the one system truncation suffice.

The pre-existing worktree was preserved: branch `v2`, base supplied by dispatch
`781b96335c9e0a9491d1c8778c1e677e7a516f4e`, with Phase 1–2 edits left intact.
The pre-capture `git diff --binary` SHA-256 was
`be74d2a78213e44a524d992631f5ffe2b92d8cd4d998530b05941b7caa6724ef`;
the existing untracked `scripts/host.sh` hash was
`baf67f154308ae7e12cdb2e5cc4e02b6c5d21622be989f7c77b4c42ecbd175f3`.
The live `$HOME/.config/opencode/opencode.jsonc` SHA-256 was unchanged across
the captures:
`052b4c9642ee658a319dbb4716511e4545ba7cea19d9f64e671e0b8719d181b6`.
Each discovery/capture invocation also passed `smoke_live_assert` for the whole
configured live-config/global-install digest after shutdown. Equality is only
claimed for these measured intervals, not all possible host-accessible files.

## Validation Scope And Remaining Work

Capture commands exited 0; direct stopped-DB inspection verified table shapes,
child linkage, and all four requested actions. Export materialization with
`bun:sqlite` succeeded for both formats, with the row counts listed above.
No `bun test`, build/typecheck, smoke-review live leg, GitHub write, Git staging,
commit, branch switch, or push was run for T7. Unit execution is deferred by
the plan; full checker acceptance and coverage belong to T8, review harness
verification to T9–T11.

Not captured: review-tool results, failed child calls, descendant shell calls,
patch/write operations, or nested grandchildren. T8 should derive explicitly
synthetic negative variants for those cases rather than describe them as live
observations or mutate these reference captures. The current v1-only reader at
`scripts/check-review-artifacts.ts:103–132` still needs production changes for
v2; these fixtures do not fix or waive that gap. ADR-0003/0004 ordering and
ADR-0006 evidence precedence remain T8 acceptance requirements.

## Synthetic Fixtures

`synthetic-fixtures.ts` contains T8's explicitly synthetic audit cases and a
materializer shared by deferred unit coverage and the direct checker driver. It
contains no test runner or checker calls. The materializer first loads the exact
T7 schema and data above into a fresh temporary file DB with foreign keys off,
then adds a separate `ses_synthetic_parent` → `ses_synthetic_child` →
`ses_synthetic_grandchild` tree. Materialization does not edit the fixture files;
the schema-only T11 amendment above leaves every T7 captured row unchanged.

The synthetic cases exercise bookkeeping success/failure/contradiction,
structured DB errors paired with CLI diagnostic strings, shell discipline and
model-issued pushes, native patch sources and move destinations, malformed patch
inputs, and write/edit path targets. The same cases use v1's `bash`/`apply_patch`
and v2's `shell`/`patch`. Denied patch attempts are audited too. Corruption cases
damage only the temporary copies to verify explicit unavailability and hard-row
failure. These are audit inputs, not evidence of actual host/model behavior.

The direct driver imports the fixture data and invokes the exported readers and
row functions, not `bun:test`; unit execution remains deferred to Phase 5a.
Neither path inserts a `step_finish`. The real v2 CLI already contains terminal
text, so final-message selection can use it without a completion-event
prerequisite. If terminal text is absent, no DB text is substituted for disclosure;
bookkeeping remains `undisclosed:` unless the observed terminal note qualifies.
Usage continues to sum only emitted `step_finish` events, not stored totals.

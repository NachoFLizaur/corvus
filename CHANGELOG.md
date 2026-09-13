# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.10.0-beta.8 — 2026-09-13

### Added

- `corvus_review_post` tool (R13-1): posting is now a deterministic plugin operation instead of a model-constructed `gh api --method POST`. The tool takes the closed descriptor (`artifactPath`, `expectedSha256`, `repo {owner, name}`, `prNumber`, `headSha`, `event`), re-verifies the artifact through the existing verify operation (containment, closed schema, canonical bytes, digest, limits), GETs the current PR head and requires equality with the supplied head SHA and the artifact's `commit_id`, POSTs the file's exact bytes with `--input`, and returns a structured TransportResult `{outcome: posted | rejected | unknown, http_status?, review_url?, reason?, tool_api_calls}`. Deterministic 4xx (including a moved head, `head-moved`) rejects; timeout, network, 5xx and malformed success responses stay `unknown`; exactly one bounded retry after a first-attempt 429; remote messages that echo review text are redacted; the artifact is never mutated. Registered on both hosts (v1 tool hook, v2 `draft.add` with `codemode: false`); the permission allow lands only on `pr-comment-writer` — both review orchestrators and both detectors deny it, and the writer's bash map keeps only the fixed GET forms plus the diagnostic validators (`gh api --method POST` remains denied, pinned with negative controls).

### Tool-Owned Review State and Transport

Phase 9 extends the Phase 8 posting work in this release, replacing its writer shell reads and two-tool preflight with structured PR reads and a three-tool preflight.

- `corvus_review_persist` owns `write_document`, `write_input`, `write_meta`, `write_candidate`, `write_facts`, `read_document` and `read_facts`. `write_meta` defaults to `meta.yaml`; its `name` allowlist also accepts `decision.yaml`, `completion.yaml`, `authorization.yaml` and `review-action.yaml`. Writes bootstrap contained directories and use atomic replacement with byte-equal read-back; document/input/metadata/facts lines stay ≤1,900 characters, while candidate JSON preserves canonical posting strings for measure/freeze.
- `corvus_review_lock` owns `acquire`, `release` and `status`, with directory bootstrap on acquire, `lock.yaml` plus legacy `.lock` handling, and two-hour freshness. Only explicit interactive consent permits `force`; release remains owner-checked.
- `corvus_review_pr` supplies eight read operations: `metadata`, `head`, `files`, `diff`, `reviews`, `checks`, `identity` and `config`. Both host adapters use `ctx.agent` to limit `pr-comment-writer` to `head`/`diff`/`files`; diff HTTP 406/413 returns `oversized: true` for the per-file fallback.
- `corvus_review_verdict` (`compute`) derives round, counts, caps (`caps_applied`), `converged` and `refuse_delta` from persisted evidence. R0 consumes history-only admission before R1/R2, R4 uses convergence for the posting default, and R5 records a `verdict_file: verdict.yaml` metadata pointer to the tool-persisted result rather than copying counts or doing model arithmetic.
- Phase 9 reduces shell transport in favor of structured tools; Phase 10 broadens the granted read-only bash forms below. The gatherer retains read-only Git plus the documented `gh api --method GET *` exception for evidence unavailable locally. All build-side agents deny all eight `corvus_review_*` tools: build-side subagents have explicit per-tool denies; `corvus` and `corvus-auto` retain their default-deny rule.
- The smoke checker grows from 22 to 27 checks (33 with the writer), asserting tool-owned state, PR reads and verdict consumption. The prompt corpus shrinks from 4,799 to 4,713 / 4,800 lines, leaving 87 lines of headroom.

### Review intake and friction (Phase 10)

- `corvus_review_pr` adds `repo`, `find` and `local` operations. Intake precedence is GitHub PR URL → `owner/repo#N` → `#N`/`N` with repository discovery → named branch → nothing. Branch input uses `find` for that branch; no input auto-finds the current branch's PR, falling back to LOCAL when no PR is found. Missing input no longer stops review.
- LOCAL reviews current-worktree changes, including uncommitted edits, with namespace-level `review-input.json` and head-level `REVIEW_DOCUMENT.md`/`meta.yaml` under the resolved `reviews/local-<slug>/` root (Phase 11 layout below). Metadata records `mode: local` and dirty state. PR-only inputs are skipped with notes; local lock ownership and history/current-head verdicts remain. No candidate, measure/freeze, posting choice, writer dispatch or POST: completion releases the owned lock and prints the document path and separate axis counts to chat.
- Friction sweep across the 124 C-class directives in `FRICTION_AUDIT.md` (73 review + 51 coordinator/phase): recoverable stops become proceed-with-note/defaults, prose/frontmatter contradictions are deleted, and ordinary no-work endpoints are retained. A/B safety and artifact/ownership stops stay in force. `refuse_delta` is preserved as a continuation note, not a workflow stop; trusted-only `force_delta` input and posting rails remain.
- Read-only bash is restored/broadened across review prompts, including frontmatter-granted read-only bash for both detectors; both coordinators may perform small read-only checks directly and delegate substantial exploration. Diagnostics never satisfy verification, and writer POST remains tool-only. Prompt corpus: 4,713 → 4,740 lines, below the unchanged 4,800 ceiling.
- `smoke-review.sh --intake url|branch|local` defaults to URL and preserves URL `--full` writer execution. Branch intake checks out the fixture PR's head and requests review without a reference; LOCAL creates a dirty branch without a PR. `--preflight-only` checks intake setup and exits before packaging or host/model launch. The checker retains PR posting rows for URL/branch, adds ordered `find` evidence for branch, and substitutes LOCAL persistence, summary and zero-posting checks. Existing tests cover complete LOCAL/branch fixtures and seeded failures; live gates remain separate release validation.

### Committed review state and planning records (Phase 11)

- `corvus_review_sync` adds `resolve`, `pull` and `push`, bringing the review tool set to eight. R0 resolves the root from the unfiltered changed-file inventory and pulls before lock acquisition; R5 writes metadata and releases the owned lock before syncing on posted, local-only, unknown and LOCAL routes. State commits contain only the resolved root and use `corvus(review-state): pr<N> @ <short> [skip ci]` (LOCAL: `local-<slug>`), on the feature branch rather than an orphan branch. Fork, no-identity, index-busy and LOCAL no-upstream refusals retain local state and proceed with a note, not a workflow stop.
- The new layout is `.corvus/tasks/<task>/reviews/pr<N>/` when exactly one task is touched, otherwise `.corvus/reviews/pr<N>/`; LOCAL substitutes `local-<slug>`. Legacy `<owner>__<repo>__pr<N>` and `local__<repo>__<slug>` roots remain readable through `legacy_root` for one release and are never written again.
- `code_head` is the newest non-review-state commit, used for resume, verdict identity and posting head checks. Metadata records `code_head` plus the observed `head_sha`, never `state_commit`; the latter is the push receipt reported in the terminal summary. Marker v2 carries `path=<root> head=<code_head> round=<n>`; v1 remains readable. Default diff and file inventories exclude `.corvus/**` from review scope.
- Committed-by-default replaces local scratch as the record policy: plans, discovery companions, ledgers and review state are project memory alongside the product diff. `corvus-auto` includes exact planning-record paths in its opted-in Git-delivery manifest; interactive `corvus` lists them in its completion summary for the user's commit. The in-place [ADR-0001 amendment](docs/decisions/0001-single-adaptive-plan.md#amendment-2026-09-13-planning-records-are-committed) records the decision; Corvus itself keeps its parent-workspace exception. `state_sync` defaults to true; `state_sync: false` skips review-state pull/push with a note, without changing the planning-record policy.
- The offline smoke gate uses two remotes: a seeded local bare `origin` for state pushes and read-only `github` with a disabled push URL. Branch intake preflights argument-free PR discovery through the shim; the checker matches sync calls to host-DB results, checks new-layout artifacts and bare commit scope/count/receipts, and rejects GitHub or model-shell pushes. Live URL/branch/LOCAL gates remain separate validation.

### Changed

- `pr-comment-writer` procedure: preflight both tools → validate descriptor and controls → head GET → anchor validation (unchanged ladder incl. the 406/413 per-file fallback) → `corvus_review_verify` → `corvus_review_post` → map TransportResult into the closed POST_RESULT: posted → `posted`/`posted` with the tool URL; rejected → `local_only`/`not_posted` with `<reason> (HTTP <status>)` when supplied, otherwise the tool reason; unknown → `local_only`/`unknown`. `api_calls` = writer GET attempts (head, diff, every files page) + `tool_api_calls` (tool head, POST, retry); a body-only success totals 3. The writer never constructs a posting command and never retries the tool.
- R5 reconciliation distinguishes a valid `local_only/not_posted` (terminal, including tool rejection) from `local_only/unknown` (terminal-uncertain: read-only listing reconciliation, never re-dispatch); the schemas/state references carry the TransportResult shape and mapping within their fixed budgets (corpus 4,799 ≤ 4,800).
- Gate: `scripts/smoke-review.sh --full` and `scripts/smoke-writer.sh` assert the `corvus_review_post` tool_use after the writer's verify, the tool's exact POST argv reaching the read-only shim and being blocked, no writer bash POST, and a closed `local_only/unknown` result with `api_calls` = writer GETs + `tool_api_calls`.

### Fixed

- `verdict.yaml` is persisted by `corvus_review_verdict` itself after a live run's model-copied metadata dropped `counts.by_origin`; R5 stores the pointer, not a reconstructed verdict.
- `corvus_review_post` no longer combines incompatible `--slurp --jq` flags on the paginated commits read: it retains `--slurp` and parses the pages in TypeScript before comparing `code_head`.
- The smoke checker fixes six Phase 11 false negatives, accepts a shortened state-commit receipt in the terminal summary, and recognizes the writer-not-exposed → local-only pre-freeze route on non-full runs (R16-4), without requiring artifacts from a posting route that did not run.
- Writer stopped `local_only` on a truncated artifact read (T41 gate run `NhZOXa`): the canonical `post-request.json` keeps each `body` on one line (3–4k characters), the host read tool truncates lines at 2,000 characters, and the previous step 2 ("read the complete payload; an incomplete read fails local-only") made the writer end before verify/post. Root-cause fix: the writer no longer validates payload content by reading. Step 2 reads the artifact once to extract only the controls anchor validation needs (`commit_id`, `event`, each comment's `path`/`line`/`side`/`start_line`/`start_side`); "line truncation of body strings is expected; never treat it as an incomplete read, never use an interpreter" — content, schema, canonical bytes, digest and limits are enforced on the exact file bytes by `corvus_review_verify` and posted by `corvus_review_post`. Pinned in the structural test (`controls-only-read`: positive clause required; "incomplete read fails local-only" / "consecutive windows" forbidden; three mutation negatives). Line-neutral (writer 120/200).
- `scripts/smoke-writer.sh` fixture now carries a ≥3,000-character single-line review body so the direct proof exercises the truncation (the run records the longest artifact line), and gains `--head-moved`: the canned shim serves `pull.json` to the first metadata read and `pull.moved.json` afterwards (`CORVUS_SMOKE_GH_CANNED` + `pull.moved.json`, counter in `.pull-reads`, served fixture in the audit), so the writer's own head check passes, the post tool's independent recheck returns `rejected`/`head-moved` with one API call, no POST of any kind reaches the shim, and the writer maps it to `local_only`/`not_posted`/reason `head-moved`. `scripts/check-writer-run.ts --head-moved` scores that mapping; default mode is unchanged.

### Known limitations

- Same-repository PR positive sync is covered only by real-git unit tests and offline checker fixtures: live fixture PR #8 is a fork, so every PR gate exercised the fork refusal (R16-5, open). Live positive sync evidence is LOCAL-only, with a state commit pushed to a bare `origin`.
- Fork PR review state is retained locally and never pushed by `corvus_review_sync`; review posting is a separate decision.
- Glob-based shell permissions retain the accepted argument-boundary residual R15-4; read-shaped grants are not argument-aware, and the smoke shim's mutation barrier is not a production boundary.
- The OpenCode 2 end-to-end review gate is still deferred (R9-1; `--writer` is v1-only); v2 users stay on 0.10.0-beta.3.

## 0.10.0-beta.7 — 2026-09-12

### Fixed

- Writer tool preflight (R12-1): `pr-comment-writer` step 1 now begins by confirming `corvus_review_verify` is among its callable tools; if absent it returns `local_only` with `remote_state: not_posted` and reason `not-exposed, cause unknown` plus the observed tool inventory, and never runs shell diagnostics as a substitute. The Trust and Capability Boundary states once that the `jq .`/`python3 -m json.tool`/`shasum -a 256` grants are diagnostic only and never satisfy any verification step (pinned in the structural test with negative controls; line-neutral, corpus 4,800/4,800).
- The gate now executes the real writer against a blocked transport: `scripts/smoke-review.sh --writer` (included in `--full`, v1) removes the sandbox task deny so R5 dispatches `pr-comment-writer`, and the read-only `gh` shim's POST admission is the only barrier. `scripts/check-review-artifacts.ts --writer --db <host db>` replaces `writer denied` with five rows — `writer dispatched` (completed task after the parent's verify, child session found in the stopped host DB), `writer verify` (the child's own `corvus_review_verify` on the exact artifact/digest, `ok:true`), `writer POST attempted` (exact `gh api --method POST … --input` form after verify, `CORVUS_SMOKE_MUTATION_BLOCKED` in the audit; a forwarded POST is exit 6), `writer shell discipline` (only fixed `gh api` forms and the granted exact-path JSON validators; any digest/size measurement fails), and `writer result` (a POST_RESULT that is not `posted`; a `posted` claim is exit 6). The default barrier mode is unchanged.
- `scripts/smoke-writer.sh` (`bun run smoke:writer`): a network-free direct writer run — a sandbox relay primary dispatches the real writer once (the host refuses a subagent as `run --agent`) against a fixture artifact frozen by the built `freeze()` and a canned shim (`CORVUS_SMOKE_GH_CANNED=<dir>` serves `pull.json`/`pull.diff`/`files.json`/`reviews.json` for the PR read endpoints, honors only dotted-path `--jq`, and fails closed on anything else); `scripts/check-writer-run.ts` scores the same writer rows from the host DB child.
- The smoke shim admits the writer's canonical diff header (`Accept:application/vnd.github.v3.diff`, spaced or not), which it previously blocked, and the checker's forwarded-header audit accepts the same read-only Accept set; canned reads are counted separately (`CORVUS_SMOKE_GH_CANNED`).

### Known

- The OpenCode 2 end-to-end review gate is still deferred (`--writer` is v1-only); v2 users stay on 0.10.0-beta.3.

## 0.10.0-beta.6 — 2026-09-12

### Added

- Explicit read-only GitHub command forms for both review orchestrators: `gh pr list`, PR commits GET (single-page and paginated), paginated PR-files GET with the JSON Accept header, `gh issue view`, and repository contents GET. The gatherer gains the two non-API forms alongside its existing GET allow. R0 records verified concurrent-PR file overlaps; shallow-checkout origin derivation prefers the PR commits API while retaining gaps for unavailable line attribution.
- Identity-scope recovery (R11-3): both review orchestrators allow bare `gh auth status` for one fallback after an identity HTTP 403; unresolved identity retains the `COMMENT_ONLY` cap with `read:user`/`checks:read` guidance, and the README documents token access requirements.

### Fixed

- The smoke GitHub shim forwards three-dot compare endpoints (`repos/<owner>/<repo>/compare/<a>...<b>`) without relaxing its rejection of other repeated-dot paths, accepts the PR-files JSON Accept header, and requires `--json` for `pr list` and `issue view`; `issue comment` remains blocked.

## 0.10.0-beta.5 — 2026-09-11

### Fixed

- Large-diff posting (R10-1): when GitHub returns HTTP 406/413 or a partial/truncated canonical diff for the PR (>20,000 changed lines), `pr-comment-writer` now falls back to `gh api --method GET --paginate repos/<owner>/<name>/pulls/<pr_number>/files` and validates each inline anchor against the per-file `patch` records; anchors whose patch is absent/truncated or whose membership is unresolved return `status: not_posted`, `reason: anchors-unverifiable`, and `unverifiable_anchors` with no POST attempted — never a guessed position and never a writer edit of the frozen artifact.
- R5 Anchor Relocation (R10-1): on `anchors-unverifiable`, the orchestrator relocates only the matching inline comments into their own axis's review body (identity-preserving Conventional Comments, body/suggestion unchanged), persists the revised checkpoint and candidate, re-runs measure → freeze → verify with the new digest, revalidates PR controls, and re-dispatches the writer once (autonomous: no new authorization because content is unchanged; interactive: one consent question). **Autonomous reviews with a frozen, verified artifact always reach the writer**: only a real GitHub rejection, transport uncertainty, or an R4 rail from review content can end without posting.
- Oversized-write posture (R10-2): a run treated its own 26k-character write — which succeeded and read back complete — as terminal and ended `local_only` before freeze/post. The shared Operating Rules now state once that engineering bounds (write size, chunking, read-back paging) are guidance against truncation, not rails: a successful write is a success regardless of size (log the overage locally and continue); only a failed or truncated write is a failure, recovered by retry-with-subdivision, not `local_only`. `state.md` Persist at R3, R2's evidence envelope, R3, R4 and R5 point at that rule; no review prompt makes an oversize call a local-only terminal (pinned in the structural test with negative controls).
- R3 checkpoint bounded assembly (R9-3): `REVIEW_DOCUMENT.md` is written as header + first section then appended section by section (≤20,000 serialized characters preferred per call, `edit` append or Add/Update patches, never a `write` overwrite of a partial file), with complete read-back before `meta.yaml`; this replaces the single ~65k-character tool call whose generation was cut mid-JSON and lost the checkpoint.
- Review-input bounded assembly (R9-3): `review-input.json` uses the same bounded sequential patches, JSON-validated from the complete read-back before either child launches; a write error, truncation, or malformed call gets one smaller assembly retry via the compaction ladder.
- Gate checker artifact-shape (R8-11): the v1 not-exposed acceptance reads `remote_state`, `api_calls` and the capability classification from whichever review-state file the run persisted them in (`completion.yaml`, `decision.yaml`, or `meta.yaml`, including a terminal `status`/`reason` diagnosis), so equivalent terminal evidence in either shape scores `writer denied: PASS`; fixture tests pin both shapes and the historical negatives. The new `checkpoint writes` check passes on a non-empty `REVIEW_DOCUMENT.md` with every write tool call completed, reports the maximum serialized argument size as information, and fails only for an absent/empty checkpoint or a write error with no later successful retry. The checker also emits a machine-readable `SMOKE_RESULT` summary line.

### Changed

- Corpus consolidation (R9-2): 202 lines recovered without behavior change by consolidating duplicated lifecycle/review material (dispatch templates, fix loop, transport retry, remediation, phase entries) behind their owning references — 4,998 → 4,796 lines, all budgets honored; the corpus ceiling stays 5,000.
- Smoke gate updates: `scripts/check-review-artifacts.ts` scores 18 checks (adds `checkpoint writes`) and prints a `SMOKE_RESULT` JSON line for machine consumption; the v1 gate for this release is the single run recorded under Validation.

### Known

- The OpenCode 2 end-to-end review gate is still deferred; v2 users stay on 0.10.0-beta.3.
- The large-diff path (406 fallback → `anchors-unverifiable` → R5 relocation → single re-dispatch) is validated by unit pins only; verify it on a real >20,000-line PR — when the writer still cannot verify anchors it relocates those comments to the body and posts.

## 0.10.0-beta.4 — 2026-09-11

### Added

- Corvus-only output-generation budget on both hosts: any hook-visible value is preserved (v1 is normally seeded), otherwise the smaller of the model output limit and 32,000 tokens is set — v1 through chat params, v2 through the session context hook. This removes the 4,096-token truncation of R2 dispatches observed on OpenCode 2.
- R2 dispatch contract: the assembled `REVIEW_INPUT` is persisted once per R1 assembly to `<review_root>/review-input.json`, pretty-printed with long values chunked (`description_chunks`, `hunk_lines`; no string over 1,500 characters, no line over 1,900) so the host read tool never truncates it; both children read the file and receive pointer briefs capped at 12,000 characters per dispatch, with a compaction ladder (drop hunks → drop file summaries → pointer-only) and a two-retry recovery for malformed parent tool calls.
- Review calibration: `max_nits` (3) and `max_minors` (6) are hard totals across both axes; every finding carries `origin: pr-code | review-fix` from gatherer-derived ranges; a verified delta limits new findings to delta hunks with an `unchanged_code_min_severity` floor; a shared `converged` verdict (two consecutive rounds with zero retained blocker/critical/major and full coverage) defaults R4 to `local_only`, `post_converged_summary` opts into a one-line summary, and `force_delta` (trusted invocation only) admits a delta review past round 5.
- Statically unverifiable evidence rule: `evidence_status: unreachable` now means physical unreachability only — a PR file, hunk, or line named in `review-input.json` cannot be read. Evidence outside the PR (runtime behavior, upstream/host internals, external systems, executed integration) completes the dimension with the gap recorded under `summary.limitations` and dependent claims calibrated to minor with `pending verification`, instead of projecting a coverage error that made autonomous R4 rail to `local_only` on every PR touching host behavior. Pinned in the structural test with negative controls.
- `smoke:review` end-to-end gate (`scripts/smoke-review.sh --host v1|v2`) against a real host: isolated XDG state, Bedrock-only auth seeding, `amazon-bedrock/global.openai.gpt-6-astra` as the default model, a read-only `gh` shim with an audit log, a host-resolved writer-deny barrier, and `scripts/check-review-artifacts.ts` scoring 17 checks — JSONL, foreground dispatch, plugin load, agent identity, provider/auth, fixture identity, artifacts, metadata, lock release, `review-input.json` line lengths, measure → freeze → verify chain, SHA-256 equality, built `verify()`, writer denied (including the v1 not-exposed acceptance path when the host omits the writer from its task inventory), GitHub barrier, and unexpected denials — with top-level cost/duration recording.

### Fixed

- Both review orchestrators now carry identical ordered edit/write allows for root-relative and prefixed review-state resources, with explicit legacy dotfile lock patterns for dot-sensitive matchers; unrelated source and task paths remain denied.
- Lock permission denial still stops the review, but now reports the attempted and harness-resolved paths, session/workspace root, and exact denial with a rerun-R0 recovery instruction; existing review state is preserved and matcher behavior is labeled unverified.
- The v2 review payload tool now uses a flat object input schema accepted by Anthropic; freeze still requires `artifactPath` at execution. Registration tests and the built-tool probe check both tools on both hosts for unsupported top-level schema combinators.
- Children are dispatched in the foreground only (`background:false`); the parent waits for each terminal child result before advancing a phase, instead of ending its turn at R1 when the host subagent tool advertised async mode.
- Review shell discipline: one shared fixed-command rule replaces parent improvisation (no compound, piped, or decorated commands; no interpreters for JSON validation — the read tool verifies `review-input.json`), and the gatherer recovery has a one-re-dispatch ceiling.

### Changed

- The review lock is now `lock.yaml`, matching its YAML mapping content. Acquisition checks both names, honors a fresh legacy `.lock`, and removes a confirmed stale legacy lock after acquiring the new lock.

### Validation

- OpenCode 1 gate (v1): three retained autonomous reviews of `NachoFLizaur/corvus#8` — MioD3H 16/16 PASS, yl4O8L 17/17 PASS (writer-denied attested through the v1 not-exposed path), EQBdgp 16/17 with the single failing check being the checker's requirement of a `completion.yaml` file that the run expressed equivalently in `decision.yaml`/`meta.yaml` (ledger R8-11, open; the review itself completed R5 local-only with 4/4 projections completed and a verified frozen artifact). 15–21 minutes and $13.5–$16.2 per review across parent and four children; 0 `length` finish reasons; 0 unexpected denials; 0 forwarded GitHub mutations.
- OpenCode 2 gate (v2): deferred to 0.10.0-beta.5. v2 users stay on 0.10.0-beta.3.

### Known Limitations

- On OpenCode 2 the plugin cannot observe the route/model output default, so Corvus agents receive 32,000 output tokens unless a hook-visible value is already set; a larger hidden default is replaced.
- The smoke gate's v1 not-exposed acceptance reads `completion.yaml`; a run that records the same terminal evidence only in `decision.yaml`/`meta.yaml` scores `writer denied: FAIL` although no writer dispatch or mutation occurred (R8-11).

## 0.10.0-beta.3 — 2026-09-10

### Added

- Two plugin tools registered on both hosts (v1 `tool` hooks and v2 `tool.transform` with `codemode: false`), confined to files under the reviewed workspace's `.corvus/reviews/`:
  - `corvus_review_payload` — `measure` a candidate `POST_REQUEST` file (code points and UTF-8 bytes for the body, each inline comment and the whole canonical serialization against the 24,000 / 4,000 / 48,000 ceilings, violations with the exceeded unit) or `freeze` it into the canonical artifact (UTF-8 JSON, two-space indent, LF, no BOM, final LF) with byte-equal read-back and the SHA-256; results carry measurements and diagnostics, never review text. Callable by `corvus-review` and `corvus-review-auto` only.
  - `corvus_review_verify` — read-only check of a frozen artifact against its expected digest: closed schema, duplicate keys, invalid UTF-8, canonical bytes, budgets and SHA-256. Callable by both review orchestrators and `pr-comment-writer` (immediately before each POST); detection agents allow neither tool.
- `scripts/probe-tools.ts` and `smoke-v2.sh --refs/--full` assert both tools on both hosts from the built bundles and run a measure → freeze → verify roundtrip.

### Fixed

- Interactive review no longer stops local-only at R3/R4 for lack of a permitted byte-exact measurement, serialization and read-back path; the tools above provide it under the orchestrators' closed-deny permission maps.
- A host that does not advertise the question tool now yields a precise diagnostic (`question tool not advertised by this host`, citing the inventory), a resumable local-only checkpoint, and the invocation mode kept interactive — never recorded as autonomous — with the recovery path told to the user.
- `post` recovery is defined: fresh R0 → revalidate head, base and config → restore only a schema-valid checkpoint for the same head → skip R1/R2 when the head is unchanged → rerun measurement → re-authorize via question → R5.
- The `mode` field records `autonomous` only from the fixed autonomous invocation value; repository content and child output cannot switch it.
- R3 persists the complete `REVIEW_DOCUMENT` checkpoint before measurement, so a measurement failure (tool absent, denied or budget violation) always leaves a resumable checkpoint.

### Changed

- The comment writer's and orchestrators' `shasum`/`jq`/`python3 -m json.tool` shell grants are optional diagnostic fallbacks; posting verification is the tool call.
- The schemas reference points at the tool-owned `LIMITS` for posting-size ceilings instead of restating them.

## 0.10.0-beta.2 — 2026-09-10

### Fixed

- Review orchestrators can read sibling skill references from OpenCode plugin-cache and manual skill-install directories via scoped `external_directory` allows after their default deny; unrelated external paths remain denied.
- Skill-enabled agents receive a runtime realpath install-root grant after authored permissions on both hosts; review orchestrators retain manual/unknown-host fallback patterns, including older `opencode/npm` caches. The smoke harness now probes reference readability and protected-agent denial.
- Cross-agent pointers no longer require reading agent prompt files; the R1 dispatch supplies gatherer fields, and R0 confirms checkout with the read-only `git rev-parse HEAD` command instead of following external Git metadata paths.
- Ship the referenced state-machine document without decision records, and remove the explorer's unused clone permission.

## 0.10.0-beta.1 — 2026-09-10

### Fixed

- OpenCode 1.18.30+ resolves npm plugins through `exports["./server"]` and requires a `{ server }` v1 module; `dist/server.js` now exports `{ id, server, setup }` so the same subpath satisfies both the v1 loader (`server` = legacy hook function) and the v2 loader (`setup`). 0.10.0-beta.0 loaded no agents on 1.18.30.

## 0.10.0-beta.0 — 2026-09-09

### Breaking

- The plan-type question is removed. The model proposes `depth: quick | standard | deep`
  as an effort dial, user-overridable at the single approval gate; depth never skips
  discovery, review, or required gates (ADR-0001).
- `MASTER_PLAN.md`, task files, `CONTEXT.md`, and `specs/` are replaced by one `PLAN.md`
  per feature. Legacy plans remain read-only; resume and follow-up copy relevant
  requirements, history, and remaining work forward into a fresh plan (ADR-0001).
- The `tests_enabled`/`tests_deferred`/`test_scope` triad collapses to
  `tests: deferred | none`, defaulting to deferred execution at final validation (ADR-0001).
- The byte-pin test `src/__tests__/prompt-contracts.test.ts` is deleted in favor of
  `src/__tests__/prompt-structure.test.ts` and the root `prompt-budgets.json`
  structural contract (ADR-0001, ADR-0002).

### Added

- ADRs under `docs/decisions/`, with records written only when all three conditions
  hold: hard to reverse, surprising without context, and the result of a real
  trade-off. Accepted records change through superseding ADRs (ADR-0001).
- Cross-model whole-plan review: `REJECT` → `PLAN_FIX` → automatic re-review until
  `OK`, with no round cap. A stall guard surfaces unchanged findings as unresolved
  and holds execution rather than treating them as `OK` (ADR-0001).
- Vertical-slice tasks with `blocks:` edges and frontier dispatch, resolving
  disjoint parallel file ownership at dispatch time (ADR-0001).
- Two-axis PR review: parallel Standards and Spec review, a pasted Fowler smell
  baseline, and axis-preserving aggregation without cross-axis merging or reranking
  (ADR-0001).
- Packaged root `NOTICE` with MIT attribution for text adapted from
  mattpocock/skills, alongside attribution comments at adapted passages (ADR-0002).
- Structural prompt test with per-class budgets, frontmatter and heading checks,
  dispatch and identity contracts, a prohibition ceiling, and stated-once checks
  (ADR-0002).

### Changed

- All 38 prompt entries are rewritten to the ADR-0002 authoring standard; the
  corpus shrinks from 13,762 to ~4,898 lines including sibling reference files.
- `docs/CORVUS-STATE-MACHINE.md` becomes a 61-line diagram and navigation map with
  pointers to the phase skills (ADR-0001).
- requirements-analyst adopts design-tree grilling: whole-frontier question batches
  with recommended answers, agent-led fact-finding, and user decisions, retaining
  the three-round cap and recording unresolved decisions as assumptions (ADR-0001).
- The `[ux]` task tag replaces `requires_ux_dx_review` for routing subjective review.

### Removed

- Plan-type taxonomy and the /16 recommendation rubric (ADR-0001).
- Phase 3.5 verdict tiers, finding categories, changed-lines manifests, REJECT
  budget, and carve-out (ADR-0001).
- Validation Commands blocks from agent and skill prompts (ADR-0001).
- Planner-assigned workstream tags, replaced by dependency edges (ADR-0001).

### Fixed

Review round 1:

- Same-model plan review now proceeds with a visible degraded warning; distinct
  planner/reviewer models remain preferred (R1-B1).
- Agent skill references respect tool access; the posting writer carries its closed
  schemas inline instead of depending on an inaccessible skill reference (R1-B2).
- R4 freezes approved review bytes and SHA-256; R5 sends only the artifact descriptor,
  and the writer verifies and posts from the unchanged file (R1-B3).
- `AMEND_PLAN` adds phases or scoped fixes and copies legacy plans forward without
  modifying sources; `DISCOVERY.md` persists evidence for resume (R1-M1, M4, M5).
- Plan-review stalls use defect-key sets and full round history, detecting reworded
  repeats and oscillation rather than comparing fix prose (R1-M3).
- Frontier dispatch resolves file ownership through code-explorer, serializes overlaps,
  and escalates out-of-scope production gaps on initial and fix reports (R1-M2).
- Prior-review dispositions reach both axes; concrete security indicators, safety pins
  and closed permission boundaries are restored or hardened (R1-M6–M9).
- Review docs and upgrade guidance now describe both axes, per-axis caps and artifact
  posting; ADR-0002 records the canonical-template planner budget exception (R1-M10, M12, M13).

- Review round 2 (external): 10 minor consistency fixes — host-config path resolution, `AMEND_PLAN add-fix-tasks` for production gaps, REVIEW HISTORY reset on Request Changes, `REVIEW_INPUT` schema, `review_mode` token, docs
- Review round 3 (external): AMEND_PLAN dispatch template homed in the phase-7 skill; `unchanged_code_min_severity` consumer rule; `.jsonc` config path
- Review round 4 (user-reported): review orchestrators can materialize the validated PR head with detached checkout, preserving named branches and falling back to inline evidence on failure (R4-1).
- Review round 4 (user-reported): hard review size budgets (24k body / 4k inline / 48k serialized, characters and UTF-8 bytes), deterministic R3 overflow preserving blockers/criticals, and R4 read-back verification before hashing (R4-2).

### Known Limitations

- The structural test validates prompt shape, not prose meaning or behavioral
  correctness; it does not replace review of prompt changes (ADR-0002).
- `prompt-budgets.json` is a repo-time contract consumed by the structural test,
  not a runtime dependency; it is not included in the published package.

## 0.9.0-beta.0 — 2026-09-05

First release with OpenCode v2 support. Corvus loads on OpenCode v2 (`opencode2`
v0.0.0-beta-19086) and OpenCode v1 (1.18.x) from the same package, registering
the same 16 agents, 4 commands, 18 skills, and the default `web-research` MCP
server on both hosts.

### Added

- Second entry point for OpenCode v2: `dist/server.js` exports the object shape
  v2 requires (`{ id, setup }`), because v2 rejects v1's default async function
  with `Expected object at ["default"]`. The v2 host resolves it through the
  `corvus-ai/server` subpath, and a root `server.js` shim re-exports it for
  local-directory plugin entries, which ignore `exports` entirely. `dist/index.js`
  remains the v1 entry with unchanged behavior.
- Registration through v2 transforms. v2 has no `config` hook, so agents,
  commands, skills, and the MCP server are contributed via
  `ctx.agent`/`command`/`skill`/`mcp`.`transform`. Registration is
  all-or-nothing: if any registrar fails, the ones that already ran are unwound
  in reverse order and the host reports a failed load rather than a partially
  registered corpus. Every transform is idempotent, because the host replays them
  on config reload.
- Commands are registered as functions, which is what v2 accepts in place of v1's
  template strings. Corvus ports the host's own template bridge: the optional
  `agent`/`model` switch, `$ARGUMENTS` and `$N` substitution, and `` !`cmd` ``
  shell interpolation, then a session prompt that preserves the attachments,
  mentions, and metadata of the invocation.
- Translation of the packaged corpus to the v2 schema: `prompt` → `system`,
  `temperature` → `request.body.temperature`, and the `permission` map or scalar
  → an ordered `permissions[]` rule list, including the tool renames `bash` →
  `shell`, `task` → `subagent`, and `write`/`patch` → `edit`. Permission rules
  are appended rather than assigned, so the host's own baseline allows survive.
- Installer support for v2: `npx corvus-ai@beta --v2` writes the plural `plugins`
  key into `$XDG_CONFIG_HOME/opencode/opencode.json` (default
  `~/.config/opencode`). An existing singular v1 `plugin` key is never rewritten
  for you. The `@beta` tag is required while v2 ships on the `beta` dist-tag,
  because `latest` predates `--v2` and rejects it; drop `@beta` once v2 reaches
  `latest`.
- `OpenCode v2` README section covering the v2 install, the config key renames
  (`plugin`→`plugins`, `agent`→`agents`, `command`→`commands`,
  `skills.paths`→`skills`, `mcp.<name>`→`mcp.servers.<name>`,
  `permission`→`permissions`), the renamed agent-override fields, skill-name
  collisions, and the protected-agent guarantees.
- `scripts/smoke-v2.sh`, a hermetic harness that gates the built plugin against
  the real `opencode2` binary. It runs under isolated XDG directories on a
  verified-free service port, and `--full` asserts that the whole packaged corpus
  reached the host — all 16 agents, 4 commands, 18 skills, and the
  `web-research` MCP server. A `--tarball` mode packs and installs the package
  into an isolated project to exercise the `corvus-ai/server` subpath resolution
  that local-directory entries bypass.

### Changed

- Protected agents (`pr-code-reviewer`, `security-reviewer`,
  `pr-comment-writer`) are enforced on v2 by a `permission.hook("evaluate")` that
  re-applies the authored rules at request time from Corvus's own packaged files.
  The hook can only tighten, never widen: Corvus never writes `allow`, so no
  configuration can loosen a denial on the agents that ingest untrusted PR
  content.
- Corvus performs no configuration merge on the v2 path. v1's user-wins deep
  merge is unnecessary there because host ordering already applies your agent,
  command, and skill configuration after package plugins.
- `command/summary.md` no longer carries `mode` and `temperature`, which are not
  command fields on either host and were silently dropped at load; the
  prompt-corpus contract test now keeps them out of `command/*.md`.
- The four non-executable `` !`…` `` sites in `command/readme.md` and
  `command/git-commit.md` were rewritten so shell interpolation no longer trips
  over placeholder-bearing and prose occurrences.

### Known Limitations

- Prompt immutability is demoted to a presence-only guarantee on v2. v2 has no
  configuration hook and no agent field that stays out of reach after
  registration, so a protected agent can run with extra or contradictory
  instructions. A `session.hook("context")` re-appends the authored body when no
  system part carries it, which restores an absent prompt but cannot remove or
  override instructions supplied elsewhere. The capability limit above is
  unaffected, and it is what makes "mechanically read-only" true. v1 keeps the
  full deep-replace guarantee.
- `dist/server.d.ts` carries a type-only `import type { Plugin } from
  "@opencode-ai/plugin-v2"`, and that specifier is an alias local to this
  repository's devDependencies. TypeScript consumers who import types from
  `corvus-ai/server` therefore cannot resolve it. Runtime is unaffected —
  `dist/server.js` contains zero `@opencode-ai` imports, deliberately, so that
  the beta v2 SDK never becomes a runtime dependency of v1 hosts.
- Six permission actions in Corvus's corpus have no v2 tool (`list`,
  `todowrite`, `todoread`, `codesearch`, `lsp`, `doom_loop`). Their rules are
  translated unchanged and are harmless, because `action` is a free-form string.
- Three packaged skill ids lack the `corvus-` prefix and can collide with your
  own (`deep-research`, `frontend-design`, `web-search`). Your definition wins by
  host ordering, and no configuration is needed.
- On OpenCode v2, a malformed `agent/*.md` frontmatter aborts the whole Corvus
  load (fail-closed) rather than skipping the one bad file, because the parse step
  lives in the loader shared with v1. Per-file isolation applies to translation
  and validation failures only.
- Pre-existing v1 installer behavior: `npx corvus-ai --migrate --dry-run` writes
  the plugin entry when there are no manual files to remove, instead of only
  previewing it. It is unchanged for v1, which is frozen, and fixed on the `--v2`
  path.

## 0.8.0 — 2026-09-04

Stable release of the `0.8.0-beta.0` … `0.8.0-beta.22` line. Inventory is now
16 agents, 4 commands, and 18 skills (38 prompt files).

### Added

- `pr-code-reviewer` agent: a mechanically read-only PR review child covering the
  architecture, correctness, and conventions dimensions in one holistic
  invocation (agent count 15 → 16).
- Protected-agents guard: `pr-code-reviewer`, `security-reviewer`, and
  `pr-comment-writer` keep the plugin's `permission` and `prompt` via
  deep-replace, so repo-local configuration cannot widen the security-boundary
  agents that ingest untrusted content.
- User and project configuration now deep-merges over the plugin's agent
  defaults (user-wins), with idempotent skill-path registration and preservation
  of user-defined `web-research` MCP entries.
- Workstream batching: Phase 4 dispatches one `code-implementer` per workstream
  of 1–5 dependency-ordered tasks instead of one per task, with per-task
  validation, per-task fix budget, and PASS/FAIL/BLOCKED partial-failure
  reporting.
- Per-feature `CONTEXT.md` discovery artifact, so downstream dispatches point at
  persisted discovery instead of re-pasting context.
- Learnings loop: reusable defect classes are distilled to
  `.corvus/tasks/learnings.md` and consumed by planning and plan review.
- Cross-session resume for both pipelines: in-progress `MASTER_PLAN`s are
  detected at intake, and synthesized-but-unposted reviews persist under
  `.corvus/reviews/` keyed by PR and head SHA.
- `REMEDIATION_LEDGER.md` per feature with a hard gate before remediation
  dispatches, blocking repeat symptom fixes in favor of root-cause analysis.
- Root-cause-first Defect-Fix Protocol for `code-implementer`: trace before
  editing, classify root-cause fix vs symptom patch, enumerate the defect class,
  and demonstrate the defect at the root-cause level.
- `test_scope` (`targeted` | `full` | `none`) on test-capable dispatches, with
  documented run-count budgets per plan type.
- New review configuration keys: `default_action` (`COMMENT_ONLY` | `auto`,
  default `COMMENT_ONLY`) and `max_minors` (default 10).
- Per-PR persisted `verified_facts.yaml` and open questions, reloaded each review
  round.
- `prompt-contracts.test.ts`: a contract suite pinning the frozen inter-agent
  string contracts across all prompt files, plus a consumer-contract test
  asserting every entry-module export is a function.

### Changed

- Phase 3.5 plan review is now mandatory and automatic in interactive mode; the
  flow is Phase 2 → automatic review loop → a single Phase 3 approval that
  presents the plan together with the review outcome.
- PR review R2 collapses four dimension passes into two parallel children (the
  holistic reviewer and the dedicated security reviewer); findings still fan out
  into the four result slots, so downstream gates and surfaces are unchanged.
- Review retrieval is diff-first: diff hunks plus a structured context map travel
  in the review input, and reviewer local reads are provenance-flagged.
- Delta re-reviews: prior findings are supplied with don't-repeat and delta-focus
  instructions; a force-push degrades to a full review with a note.
- Head-SHA pinning end to end: the review marker and post request carry the head
  SHA/`commit_id`, and the writer's drift guard is SHA equality.
- Nitpick-grade findings are non-actionable by definition — reported as
  take-or-leave comments that never derive an action or block convergence; all
  reporting surfaces show `N total | X actionable | Y nitpicks`.
- Phase 0a requirements analysis is conditional (skippable for spec-complete
  requests), `code-quality` is slimmed to trusted-code review plus gate modes,
  and acceptance-only 4b gates are risk-triaged.
- Plan-review verdicts are severity-tiered: `REJECT` only for blocking findings,
  `OKAY_WITH_AMENDMENTS` applies non-blocking fixes without re-review, and a
  second reject escalates instead of looping.
- Test cadence is explicit and budgeted: 4b gates run the phase-targeted union
  once and Phase 5 owns the single full-suite run.
- Transport retries are separated from judgment re-runs: autonomous mode
  re-dispatches a failed phase child up to 2 times, interactive once; the
  irreversible review POST keeps exactly one retry.
- Severity is evidence-gated: chains resting on unverified upstream behavior cap
  at minor pending verification, and inline anchors must come from verified
  postable line ranges.
- `corvus-auto` delivery rebuilt: `local_only` default, explicit opt-in git
  delivery, manifest staging, and a discovered base branch.
- Prose edits require mechanical before/after verification, "no deviations" must
  be earned by quoting the changed region, and every dispatch premise carries
  inline provenance.
- Remediation output is treated as new unreviewed content and inherits the full
  consistency obligations of the work it touches.
- Prompt corpus modernized: rubric-driven slimming across all agents, skills,
  commands, and docs, with contract vocabulary preserved.
- Agent frontmatter accepts `permissions` only as a read alias when singular
  `permission` is absent; singular takes precedence and the plural key is never
  emitted.
- Pinned `@opencode-ai/plugin` to 1.18.3 and `web-research-mcp` to 0.1.0.

### Fixed

- Plugin failed to load at runtime because the entry module exported a
  non-function constant; OpenCode's loader iterates every export and throws on
  any non-function. The protected-agent constants moved to their own module.
- `pr-comment-writer` review posting: quote-embedded allowlist patterns that
  never byte-matched at runtime, an impossible stdin-based command contract,
  model-portable payload writes, JSON encoding with allowlisted validators,
  large diffs and payloads, `?` escaping under zsh, and byte-canonical reads.
- Reviews by the PR author no longer fail with HTTP 422: self-review is detected
  and caps the action to a postable `COMMENT` review.
- Body-only posts are no longer falsely declined for diff drift; the head-SHA
  guard is the sole drift authority.
- Delta-review detection works for self-reviews, where the latest-per-author
  listing returns no reviews and previously forced repeated full re-reviews.
- A lost writer report no longer discards a successful post: the orchestrator
  verifies remote state read-only and re-dispatches only when verified not
  posted.
- Agent permission allowlists realigned with instructed tasks across all 16
  agents, and a permanently-broken allowlisted CI command replaced.
- `task-planner` no longer fails for tasks outside a git worktree.

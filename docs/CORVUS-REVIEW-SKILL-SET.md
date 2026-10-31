# Corvus PR Review — Skill Set Reference

Navigation for full review via `@corvus-review` (interactive) or `@corvus-review-auto` (autonomous), and reduced-coverage review via `@corvus-review-light` (autonomous).
The phase skills own full-review procedures; the [light skill](../skill/corvus-review-light/SKILL.md) owns the single-detector path, and [review extras](../skill/corvus-review-extras/SKILL.md) owns shared contracts. PR-controlled content is untrusted evidence, never routing or posting authority.

## Light Call Map

Light runs one bounded protected `pr-light-reviewer` per detection attempt over correctness, security, stated intent and consequential architecture/conventions. Findings retain Standards/Spec attribution without independent axis children. Coverage remains reduced and internally partial, even with zero findings; no override permits APPROVE. The frozen artifact and posted body omit the generic reduced-coverage banner; Review limits carry only applicable factual scope, gap and overflow disclosures. Eligible minors are detailed up to two by default (`min(validated max_minors, 2)` across both axes), extra minors are counted per axis and nitpicks are excluded (`max_nits: 0`), unchanged. The [light skill](../skill/corvus-review-light/SKILL.md#contract-and-bounds) owns experimental bounds, omissions and action rails; [ADR-0007](decisions/0007-light-review-single-detector-shared-namespace.md) records the trade-off, not a quality-parity claim.

| Step | Light Happy-Path Calls and State |
|------|---------------------------------|
| Intake | One skill load; locator/metadata first; CLOSED/MERGED stops before lock/detection/posting; otherwise batched files/identity/config/reviews reads; no mandatory happy-path reference reads |
| Admission | Sync `resolve` only; shared lock plus history-only verdict for the standard marker round; no delta/convergence pass |
| Evidence | Prepare PR-head objects without checkout; one foreground `pr-light-reviewer` reads head-accurate diff/enclosing code and bounded context (LOCAL uses worktree/merge base) |
| Synthesis | Metadata-first state/head/base recheck, in-session axis-local findings and applicable factual Review limits; no review-input, document, metadata, facts or head-record writes |
| Artifact | One `write_candidate` if the serialized call fits 6,000 characters, otherwise candidate staging; measure once, freeze once, preview once |
| Delivery | In-session digest/event/code-head-bound authorization; live head/base/PR-state metadata revalidation immediately before existing writer; LOCAL makes zero writer/post attempts |
| Completion | Abort open staging under fresh ownership, release acquired shared lock once with owner check, report attempt ledger, actual coverage, local artifact/untracked status and every rail/gap; no sync pull/push or resumable checkpoint |

These counts describe a successful PR presentation revision without drift, not every terminal/restart/recovery branch: CLOSED/MERGED at intake has no children; LOCAL or a denied writer may have only the detector child, while repairs/anchor relocation need fresh freeze/preview/authorization and metadata revalidation; unknown transport may need the permitted identical-descriptor writer re-dispatch. Source links are conditional edge-case reads, not routine phase-skill loads. The normal published PR route without drift expects two child sessions (`pr-light-reviewer`, `pr-comment-writer`), one skill load, zero happy-path reference reads and zero document/meta/facts writes or sync pull/push calls. Batched independent reads reduce serial orchestration; actual run counts are unverified.

After detection, immediately before every writer dispatch and after writer `head-moved`, metadata-first revalidation stops CLOSED/MERGED before considering drift. Code-head or verified base-SHA drift starts a fresh bounded detector pass; raw-head-only changes with unchanged code head/base are ignored. Each restart refreshes metadata/files/diff/history/head content, reloads moved-base config and regenerates artifact/preview/authorization without prior findings or delta reuse. The run retains its shared lock and invocation identity, checking fresh ownership after detection and before artifact mutation/dispatch. At most three detection attempts (initial plus two restarts) bound churn; a changed review root, lock age over 90 minutes or lost/unverifiable ownership refuses continuation. Exhaustion names the latest observed head; completion reports `Detection attempts: N`, `attempt N: code_head=… base_sha=…` with full SHAs and `Terminal reason:`. Each restart adds a detector pass, so the structural comparison is not a cost guarantee. Live light detection needs an OPEN `--pr` URL because default fixture PR #8 is CLOSED and stops at intake; see [Review Gates](../README.md#review-gates).

### Historical Baseline and Evidence Status

Source: task `corvus-review-light/DISCOVERY.md`, Findings §§Measured baseline / Call map of the full path, retained under `../.corvus/tasks/` outside this repository as described in [Planning Records](../AGENTS.md#planning-records). Historical observations cover 17 complete rounds across eight reviews in `clopca/operations-hub`, 2026-09-14–20, v1, with GPT-6 Astra orchestration and Claude Fable 5.1 Standards detection. Average round time was about 43 minutes (27–74 range); Standards detection averaged 11.5 minutes and orchestrator-only R3 synthesis 9.4 minutes. This is one repository and model mix, not a controlled full-vs-light benchmark.

| Historical Full Path | Intended Light Path | Comparison Status |
|----------------------|---------------------|-------------------|
| About 69 orchestrator turns per round | Shorter in-session orchestration; no measured turn count | Expected reduction, unproven |
| Roughly five normal-path children: gatherer, researcher, two detectors, writer | Two normal-path PR children: detector and writer | Expected reduction, unproven in a live run |
| About 44 persist appends per round | One candidate write when ≤6,000 serialized characters; staging only above that bound | Expected reduction, unproven; large candidates still append |
| About seven skill loads (observed 7.3/round); historical phase/reference inventory about 1,000 lines | One skill load; zero mandatory happy-path reference reads | Expected reduction, unproven; inventory size is not measured loaded context |
| R0 sync pull and R5 sync push; document/meta/facts bookkeeping | Resolve-only sync; no document/meta/facts writes | Structural omission, expected savings unproven |
| Separate evidence input, document synthesis, R4 authorization and R5 delivery phases | Batched reads and in-session synthesis; shared freeze/preview/writer safety retained | Runtime/cost impact unmeasured |

T8 in the task's `EVIDENCE.md` is **UNVERIFIED** because a paid live run was not cost-authorized (PLAN assumption Q7). No light elapsed time, savings percentage, quality parity or passed live local-only gate is claimed. [Review Gates](../README.md#review-gates) gives the later non-posting command and an optional controlled comparison using an immutable snapshot, matched models and human-adjudicated severity findings.

### Local-Only Light State

Light candidates/staging/frozen artifacts live in `<review-root>/.light/`, selected by tool caller identity, while the lock and marker namespace are shared. All Corvus state synchronization excludes the light class, even for a later or overlapping full review; a root containing `.light/` also has its shared lock records excluded. Light never stages/commits/pushes state or changes the user's branch/index/ignore files. The files may appear untracked; optional exclusion and tracked-lock deletion/restoration guidance live in [Light Review and Local Artifacts](../README.md#light-review-and-local-artifacts). Full-review records outside the class remain sync-eligible. Light has no checkpoint to resume, and the next full review takes full scope; posted light markers still count as rounds.

## R0–R5 Pipeline

The sections below describe the full pipeline unless a light caller subset is explicitly named. Light recovery, bounded restart, terminal-state stop and LOCAL artifacts follow the [light procedure](../skill/corvus-review-light/SKILL.md), not R0–R5.

| Phase | Input → Output | Owner Skill |
|-------|----------------|-------------|
| R0 — Intake and Triage | Locator or current worktree + trusted invocation → `PR_CONTEXT`, PR or LOCAL route | [corvus-review-r0](../skill/corvus-review-r0/SKILL.md) |
| R1 — Context Gathering | `PR_CONTEXT` → diff-first `REVIEW_CONTEXT` from gatherer and researcher | [corvus-review-r1](../skill/corvus-review-r1/SKILL.md) |
| R2 — Two-Axis Review | `PR_CONTEXT` + `REVIEW_CONTEXT` → `REVIEW_FINDINGS`, axis results and four projected slots | [corvus-review-r2](../skill/corvus-review-r2/SKILL.md) |
| R3 — Axis-Local Synthesis | Context + findings → filtered, rendered `REVIEW_DOCUMENT` with best-effort persistence | [corvus-review-r3](../skill/corvus-review-r3/SKILL.md) |
| R4 — Posting Decision | Stage candidate → measure → freeze → `preview` → authorization bound to `POST_ARTIFACT`; emit `REVIEW_ACTION` | [corvus-review-r4](../skill/corvus-review-r4/SKILL.md) |
| R5 — Completion | Context + document + action + authorized artifact descriptor → posted review or local-only result | [corvus-review-r5](../skill/corvus-review-r5/SKILL.md) |

## Intake and LOCAL Mode

[R0 intake](../skill/corvus-review-r0/SKILL.md#validate-the-locator) resolves GitHub URL → `owner/repo#N` → `#N`/`N` with repository discovery → named branch → auto-find the current branch's PR → LOCAL. `corvus_review_pr` op `find` resolves branch PRs; op `local` supplies current-worktree diff, branch, HEAD, default branch, merge base and dirty state. A discovery error carries a note rather than claiming confirmed PR absence. A clean default branch without a PR, commits ahead or changes has a one-sentence no-work result.

LOCAL keeps R1/R2 analysis, tool-owned persistence, local lock ownership and best-effort history-only/current-head verdict calls. Unavailable verdicts are disclosed; synthesis counts are labelled as such. It skips PR identity, repository config, CI, prior PR reviews and remote-lock semantics with explicit notes, using built-in defaults plus trusted invocation settings. [LOCAL state](../skill/corvus-review-extras/state.md#namespace-and-lock) stores `review-input.json` at the resolved `.corvus/tasks/<task>/reviews/local-<branch-slug>/` or `.corvus/reviews/local-<branch-slug>/` root and `REVIEW_DOCUMENT.md`/`meta.yaml` under its `<code_head>/` directory; metadata records `mode: local` and dirty state. R3 skips candidate/measure/freeze, R4 offers no posting choice, and R5 dispatches no writer: it releases the owned lock before syncing state when enabled and the branch has an upstream, then displays the document path or persistence diagnostic and separate Standards/Spec counts.

## Committed Review State

Review state is committed by default beside the reviewed work. `corvus_review_sync` resolves `.corvus/tasks/<task>/reviews/pr<N>/` when the unfiltered changed-file inventory touches exactly one task, otherwise `.corvus/reviews/pr<N>/`; LOCAL uses the same rule with `local-<branch-slug>`. Legacy `<owner>__<repo>__pr<N>` and `local__<repo>__<slug>` roots remain readable through `legacy_root` for one release, never writable.

R0 resolves and pulls before acquiring the lock; R5 attempts metadata → owned-lock release → push of only the resolved root to the feature branch, even after bookkeeping failures. `code_head` identifies the latest non-state commit; metadata also retains the observed `head_sha`, while `state_commit` is only the sync receipt shown in the terminal summary. Marker v2 is `<!-- corvus-review v2 path=<root> head=<code_head> round=<n> -->`; a v1 marker is used when verdict round is unavailable and disclosed. Gatherer and detector inventories exclude `.corvus/**`; only R0 requests the unfiltered layout inventory. `.corvus/reviews/` must not be gitignored in target repositories or state commits cannot land; task-scoped review roots must also remain trackable. `state_sync` defaults to true; false skips pull/push with a note. Sync stays best-effort and never blocks posting; failures keep state local and are disclosed in the terminal summary.

## Friction Policy

Autonomous PR delivery is the default once R3 synthesis exists; the [Delivery Principle](../skill/corvus-review-extras/SKILL.md#delivery-principle) owns its exceptions and progress-based recovery. Gaps are disclosed, not invented success or posting prerequisites. Interactive authorization, trust boundaries, containment, owned-state writes, the tool-side writer caller check and unchanged artifact bytes remain required. The post tool checks artifact integrity before its GET and every POST and rejects a moved code head; diagnostics do not replace those checks. LOCAL never posts; CLOSED/MERGED at R5 revalidation excludes delivery. Frontmatter defaults to allow, with only the [explicit deny exceptions](../README.md#protected-agents-under-v2); review shell discipline is a prompt obligation, not a command allowlist. Coordinators handle small read-only checks directly while delegating substantial exploration and implementation; POST remains tool-only.

Draft, self-review and unknown authenticated identity produce `state_notices`: `draft_pr`, `self_review`, `identity_unknown`. State notices do not select the event. [Action precedence](../skill/corvus-review-extras/SKILL.md#fail-closed-precedence) has four layers: **Delivery → Coverage caps → Trusted override → Configured action**. The shipped `default_action: COMMENT_ONLY` yields COMMENT; `auto` and trusted overrides apply within coverage caps, including on drafts/self-reviews. GitHub may reject an author's own APPROVE/REQUEST_CHANGES; that is a disclosed POST rejection, not a pre-emptive cap.

## Two Axes, Four Dimensions

Axis identifies the basis of a finding; dimension identifies its subject. The two children share source evidence, not each other's conclusions.

| Child | Work |
|-------|------|
| `pr-code-reviewer` | Standards: repository rules and Fowler baseline, with architecture, correctness and conventions inspection |
| `security-reviewer` | Spec across eligible dimensions, plus independent security detection even without a spec |

A requirement breach belongs to Spec; an independently evidenced vulnerability belongs to Standards/security. Missing spec skips Spec work only. Dimension toggles and path exclusions apply to both axes; [R2](../skill/corvus-review-r2/SKILL.md#axis-and-child-mapping) owns eligibility and dispatch.

`axis_results` preserves Standards and Spec separately. The four `pass_results` slots (`architecture`, `correctness`, `conventions`, `security`) project contribution statuses for coverage, not additional findings. Successful axis findings survive a sibling error; [schemas](../skill/corvus-review-extras/schemas.md#review_findings--r2) owns the projection rules.

Findings are never merged or reranked across axes. Synthesis, selection, edits and presentation stay axis-local; [R3](../skill/corvus-review-r3/SKILL.md) owns exact-copy deduplication and filtering.

IDs are `<dim>-<axis>-NNN`: `dim` is `arch`, `logic`, `conv` or `sec`; `axis` is `standards` or `spec` (for example, `logic-spec-001`). See [Finding](../skill/corvus-review-extras/schemas.md#finding) and [Conventional Comments](../skill/corvus-review-extras/SKILL.md#conventional-comments).

## Posting by Artifact

The real-host [release gate](../README.md#release-gates) exercises artifact creation and denied writer dispatch on v1/v2, or the real writer against a blocked POST with v1 `--writer`, without changing the packaged prompts. The offline `built verify()` audit remains; posting integrity belongs to the post tool.

Both hosts expose the seven review tools below. Orchestrators means `corvus-review`, `corvus-review-auto` and `corvus-review-light`; full orchestrators means only the first two. Detectors includes `pr-light-reviewer`. [Caller policy](../src/review-callers.ts) is shared by both adapters; frontmatter does not isolate tools, and posting remains writer-only. Light persist is candidate-only and light sync is resolve-only, regardless of config.

| Tool | Operations | Workflow owners |
|------|------------|----------------|
| `corvus_review_payload` | `measure`, `freeze`, `preview` — measure candidates, fit overflow at freeze, return decoded frozen bytes for [preview before authorization](../skill/corvus-review-extras/state.md#freeze-at-r4) | Orchestrators |
| `corvus_review_post` | Verify artifact before GET and every POST, check current code head, submit the unchanged file; return TransportResult for the writer's [POST_RESULT mapping](../skill/corvus-review-extras/schemas.md#post_request-and-post_result--r5writer) | `pr-comment-writer` |
| `corvus_review_persist` | `begin`, `append`, `finalize`, `status`, `abort` (bounded staged document/input/candidate persistence); `write_document`, `write_input`, `write_meta`, `write_candidate`, `write_facts`, `read_document`, `read_facts` — [state operations and metadata names](../skill/corvus-review-extras/state.md#persist-at-r3) | Full orchestrators: all ops; light: `write_candidate` and candidate-only staging/status/abort |
| `corvus_review_lock` | `acquire`, `release`, `status` | Orchestrators |
| `corvus_review_pr` | `metadata`, `head`, `files`, `diff`, `reviews`, `checks`, `identity`, `config`, `repo`, `find`, `local` | Orchestrators and `pr-context-gatherer`: all ops; detectors: `metadata`/`head`/`files`/`diff`/`reviews`/`checks`; `pr-comment-writer`: `head`/`diff`/`files`/`reviews` |
| `corvus_review_verdict` | `compute` — round, counts, `caps_applied`, `converged`, `refuse_delta`; best-effort R0 history and R4 evidence, never a posting prerequisite; persists head results in `verdict.yaml`, while history-only calls write nothing | Orchestrators; light uses history-only round computation |
| `corvus_review_sync` | `resolve`, `pull`, `push` — task-scoped layout, fast-forward state pull and root-only state commit/push with a `state_commit` receipt, excluding the light class and its shared locks | Full orchestrators: all ops; light: `resolve` only |

### Fitting and Preview

For PR delivery, R4 follows **stage candidate → measure → freeze → `preview` → authorization**. [Candidate staging](../skill/corvus-review-extras/state.md#stage-candidate) uses `begin`/`append`/`finalize` when a single call would exceed 6,000 serialized characters: split the body and each comment's `path`/`body` into ordered, lossless parts, accounting for JSON escaping and the full argument envelope. Comment order and scalar anchors survive reconstruction; no document checkpoint is required. R3 measures once per revision; size violations are input to freeze, not a model size loop or a no-post condition.

Freeze fits every schema-valid over-budget candidate into a bounded summary; in-budget canonical bytes stay unchanged. Fitting drops all inline comments, keeps a valid bounded first-line marker and up to eight shortened blockquote notices (further notices collapse to a count), and retains one selected heading/headline pair per available axis or a recognizable leading-summary anchor when no pair exists. It shortens protected text rather than deleting it. Exactly one `Review limits: N findings omitted for size` footer replaces any earlier footer; **N = `omitted.comments` + `omitted.findings`**, counting removed inline records plus distinct recognized body-finding identities removed. N can be zero when only prose is shortened. [Freeze at R4](../skill/corvus-review-extras/state.md#freeze-at-r4) owns the selection rule and tool bounds.

Freeze returns `fitted`, `omitted` and the written artifact's digest. The read-only `preview` op returns that artifact's JSON-decoded body and comments, not a reconstructed payload or a truncated host-file read. Both modes show those bytes before authorization; fitted previews have zero inline comments and label the full `REVIEW_DOCUMENT` and its counts as local evidence. `size_fit` and separate omission counts are disclosed in the terminal summary. Anchor relocation also runs stage → measure → freeze → preview → renewed authorization → revalidation → dispatch; interactive asks about the replacement, autonomous re-emits `auto_post` bound to its new digest. Relocated and omitted counts stay separate.

### Writer and Recovery

Models never edit review-state files. The writer preflights `corvus_review_pr` and `corvus_review_post`, then validates the descriptor → reads controls/current head/anchors → looks up the marker → calls post → maps the result. There is no standalone verification step: post checks containment, schema, canonical bytes, digest and limits before its GET and every POST. Workspace-relative artifact paths resolve against the host session directory, not process cwd; absolute paths remain supported, with traversal/outside-root/symlink escapes still rejected.

Post's `artifact-verify-failed:*` returns through writer `not_posted` / `verify: <diagnostic>` to [R4 artifact repair](../skill/corvus-review-r4/SKILL.md#artifact-repair): re-stage → measure → freeze → preview → re-authorize. Repair is progress-based, not a one-shot re-freeze ritual. Head movement renews R0–R4; a confirmed GitHub POST rejection is a delivery exception. Unknown transport uses [R5 read-only reconciliation](../skill/corvus-review-r5/SKILL.md#reconcile-writer-transport): a matching marker reuses the existing URL, and complete listings proving absence permit one additional writer dispatch with the identical descriptor. No alternate endpoint or blind retry is authorized.

## Bookkeeping and Audit Evidence

Checkpoint, verdict, metadata and sync calls stay at their existing phases, best-effort. A checkpoint failure retains in-memory synthesis for candidate production and never forbids delivery; a metadata/sync failure after confirmed posting never repeats that POST. Tools own all state writes, and unavailable tool evidence stays unknown. [State](../skill/corvus-review-extras/state.md) owns persistence and [R5](../skill/corvus-review-r5/SKILL.md#complete-locally-or-remotely) owns completion/disclosure.

The [smoke audit](../scripts/check-review-artifacts.ts) applies evidence precedence to bookkeeping and dependent aggregate rows; contradictory success takes precedence over any unavailability note:

| Evidence | Audit result |
|----------|--------------|
| Present and consistent | PASS |
| Absent/failed, disclosed, with no contradictory claim | `N/A-PASS: <op> unavailable, disclosed` |
| Absent/failed without terminal disclosure | FAIL — `undisclosed: <op> failed without terminal note` |
| Claimed success contradicted by files, tool/DB evidence or unsupported tool-produced counts | FAIL — `forged: <what contradicted>` |

Disclosure means the **final assistant note** names the unavailable operation/artifact and its diagnostic, or explicitly says no diagnostic exists. A failed call visible only in the tool trace is not disclosure; if failure metadata could not be written, name that failure too. Explicitly labelled synthesis counts are accepted when the verdict is noted unavailable; invented tool counts, rounds or convergence are not.

Candidate production may be a successful `write_candidate` or a provenance-checked staged-candidate `finalize` (matching candidate begin, staging ID, lock, canonical path, digest and comment order). A schema-valid measurement with size violations can precede fitted freeze. The conditional `size fit` row checks limits, empty comments, identity/event, omission footer count, terminal disclosure and digest; the offline `built verify()` row remains. An inert frozen artifact is allowed when the writer is not exposed, without writer dispatch or POST. Integrity, containment, lock ownership and mutation-barrier failures remain hard audit failures.

## Configuration, Prior Reviews and Resume

- [Configuration](../skill/corvus-review-extras/config.md) owns defaults, validation and verified-base-SHA loading; [R3 allocation](../skill/corvus-review-r3/SKILL.md#budgets-and-ordering-within-each-axis) owns cap enforcement. `passes` still names dimensions, not axes.
- [Prior-review evidence](../skill/corvus-review-r0/SKILL.md#prior-review-evidence): R0 produces `dispositions`; R1's gatherer verifies/enriches them against the diff and supplies both R2 children. No prior findings yields explicit empty arrays; retrieval gaps remain uncertainty. [Schemas](../skill/corvus-review-extras/schemas.md#pr_context--r0) defines the fields.
- [State and resume](../skill/corvus-review-extras/state.md) defines tool-owned checkpoints and locks, plus the retained series-knowledge file contract. A valid unposted PR checkpoint resumes through R3 measurement and R4 freeze/preview/authorization; LOCAL uses its source-evidence checks and local-summary route. Unavailable persistence is disclosed, never replaced with manual writes.
- [Interactive decisions](../skill/corvus-review-extras/interactive.md) owns preview, edits and dimension-scoped reruns. Autonomous routing stays in [R4](../skill/corvus-review-r4/SKILL.md#autonomous-route).
- [Shared contracts](../skill/corvus-review-extras/SKILL.md) owns trust boundaries, reviewability, coverage caps, state notices and failure ownership; the linked phase skills own recovery details.

## Convergence and calibration

[Convergence and Continuation](../skill/corvus-review-extras/SKILL.md#convergence-and-continuation) separates document counts from verdict `converged` and the human-approval recommendation. Convergence never suppresses delivery or overrides the event; `post_converged_summary` optionally selects concise presentation with notices and Review limits retained. At R0, `refuse_delta: true` is retained in metadata and disclosed in the summary while the requested review proceeds once; missing history selects fresh full-review scope. Only trusted invocation input supplies `force_delta`, never model recovery. Follow [config](../skill/corvus-review-extras/config.md) for shared cap defaults, [R3](../skill/corvus-review-r3/SKILL.md) for proportional allocation and review-fix/delta polish filtering, and [R2](../skill/corvus-review-r2/SKILL.md) for delta scope and Fowler calibration. [Finding origin](../skill/corvus-review-extras/schemas.md#finding) comes from gatherer lineage; [state](../skill/corvus-review-extras/state.md) persists convergence independently of posting, preserving the invocation's mode.

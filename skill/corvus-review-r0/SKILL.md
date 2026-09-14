---
name: corvus-review-r0
description: PR Review Phase R0 - Intake, triage, PR metadata fetching, config loading
---

# Phase R0: Intake and Triage

Resolve PR or LOCAL review scope, acquire review state, and record every applicable triage input. Execute directly in the selected orchestrator. Load [extras](../corvus-review-extras/SKILL.md), its [schemas](../corvus-review-extras/schemas.md), and [config](../corvus-review-extras/config.md).
Follow the [Delivery Principle](../corvus-review-extras/SKILL.md#delivery-principle): retry while progress is made, disclose unavailable information, and continue available analysis toward synthesis.

## Validate the Locator
Resolve locators in precedence order: GitHub PR URL → `owner/repo#N` → `#N`/`N` with `corvus_review_pr` op `repo` when repository is not supplied → branch name → nothing. Branch input calls `corvus_review_pr` with `{op: "find", branch: <literal branch>}`; nothing calls `{op: "find"}` for the current branch in either invocation mode, without asking for missing input.

For a bare number or `#number` without a trusted repository, resolve owner/name via `corvus_review_pr` op `repo`; retry while progress is made. If unresolved, retain the diagnostic and gather current-worktree evidence with `local`, not a guessed PR target. Keep the supplied PR locator pending resolution; `no-repository` is not confirmed PR absence or unavailable local analysis.
Validate number text against `^[1-9][0-9]*$` and require a positive safe integer. Repository is exactly owner/name: owner matches `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$`; name is 1–100 ASCII characters from `[A-Za-z0-9._-]`, excluding `.` and `..`. Reject whitespace, extra path components, leading options, escapes, and shell metacharacters. Done when command substitutions consist only of validated identity values.

Pass branch names as tool data, never shell substitutions. A successful `find` returns either `{found: true, number, url, state}` or `{found: false, candidates}`. Validate a discovered locator as above before metadata. With multiple candidates, interactive mode may ask; absent a selection, both modes choose OPEN first, then greatest PR number as the recency proxy/tie-break, recording the assumption. Empty candidates select LOCAL through `{op: "local"}`. On discovery errors, retry while progress is made, then gather available local evidence with a PR-discovery-unavailable note and unresolved PR scope; an error is not confirmed PR absence and cannot use the empty-result message.
Read `local` as `{branch: string|null, head_sha, code_head, default_branch, merge_base, ahead, changed_files, stat, diff, oversized, dirty}`; it describes the current worktree, not an unchecked-out branch argument. Require ok:true and full lowercase head/code-head/merge-base SHAs. Only no PR plus `branch === default_branch`, dirty false, ahead 0, no changed_files and a non-oversized empty diff says `No PR or local changes to review on the default branch.` and ends in one sentence. Otherwise select `mode: local` and follow LOCAL Intake; PR locators select `mode: pr` and Fetch Immutable Metadata. Tool failures retain diagnostics, never the empty-result message.

## LOCAL Intake
<!-- LOCAL invariant: discovery/local results and trusted workspace identity are read before namespace writes or dispatch. Missing identity/OIDs or diff evidence remain disclosed gaps while available analysis continues. Unknown values never authorize invented paths or SHAs; LOCAL itself disables posting. -->
Resolve the repository name with `corvus_review_pr` op `repo`. Populate the [LOCAL schema](../corvus-review-extras/schemas.md#pr_context--r0) from the local result, retaining stat/diff/oversized as the R1 evidence envelope; use `repo`'s validated name, or the trusted workspace repository name when `repo` reports no-repository, validating it by the same repository-name rules, never a title or child-supplied name. Record current-worktree scope if a supplied branch differs. Follow [LOCAL state](../corvus-review-extras/state.md#namespace-and-lock); run Resolve and Pull State with `pr.local.changed_files`, then shared acquire, history-only verdict and Series Knowledge, then R1. PR metadata/files, checkout, Post Follow-Up and PR-only triage do not run on this route.
- Identity skipped: no PR author or authenticated posting identity; record not applicable.
- Config skipped: use built-in defaults plus validated trusted invocation values and fixed Invocation Mode; no repository config read or absence memo claim.
- Checks skipped: no PR CI; record not applicable, not passing CI.
- Prior reviews skipped: use null prior_corvus_review metadata with dispositions [], and `priorReviews = {ok: true, reviews: [], threads: [], dispositions: [], complete_pagination: true, complete_threads: true}` for the shared verdict, not a remote absence claim.
- Remote-lock semantics skipped: no PR/remote reconciliation; the owned local lock and history-only admission still apply.
Retain the common gatherer recovery and terminal cleanup rules. Present LOCAL scope, dirty state, change counts, effective config and skipped-input notes; validate PR_CONTEXT and emit `[R0 COMPLETE]` with the selected route. Done when available LOCAL evidence reaches R1 with a tool-derived round or explicit round gap; safety/integrity failures retain owned-lock cleanup.

## Fetch Immutable Metadata

Call `corvus_review_pr` with `{op: "metadata", owner, name, pr}` using the validated locator.

<!-- Intake invariant: API identity and OIDs are checked before config reads or identity-dependent writes. Mismatched evidence is discarded and refetched; unavailable fields stay unknown while independent analysis continues. No metadata prose, fallback config or resume state supplies missing identity authority. -->
Check that the returned number and canonical URL's owner/repo match the trusted locator, and baseRefOid/headRefOid/code_head are full 40-hex SHAs; normalize to lowercase base_sha/head_sha/code_head. Use code_head as review identity; head_sha is the observed raw tip. On failure, retry while progress is made, including `corvus_review_pr` op `head` for missing OIDs; disclose remaining gaps and continue R1 with available evidence and the trusted locator. Defer only reads/writes needing an unknown SHA, never invent one. Done when each identity field is verified or explicitly unavailable.
Call `corvus_review_pr` op `files` with `{owner, name, pr, paginate: true, include_corvus: true, names_only: true}` FIRST for the unfiltered layout inventory; require complete_pagination. After checkout, load current config and run Resolve and Pull State before lock/resume/verdict. Keep inventory separate from R1's filtered review scope.

<!-- Checkout invariant: API-validated identity/head_sha are read before checkout; local HEAD is read afterward. Failure/mismatch disables local-pointer evidence, not review; R1 still checks cleanliness independently. No retry, branch name, or override bypasses detached-only checkout. -->
Materialize the PR head locally: run `gh pr checkout <pr_number> --repo <owner/repo> --detach` (exact form; `--detach` is load-bearing — review and implementation sessions may be worktrees of the same repo and a named branch would collide). Confirm `HEAD` equals the validated `head_sha` with `git rev-parse HEAD`. On checkout failure, unavailable confirmation, or mismatch, record it and continue — R1 reports `head_accurate: false` and R2 uses `full-inline`. Never retry with `-b`/a branch name or force/reset/stash away local changes. Carry the failure as a provenance limitation into R1; a successful checkout alone does not prove a clean worktree. Done when checkout and observed HEAD have an explicit outcome.

Map returned title, author, refs, changedFiles and state to PR_CONTEXT; MERGED sets is_merged, and mergeable maps MERGEABLE→true, CONFLICTING→false, otherwise null. Set review changed_files/files_changed from the inventory excluding `.corvus/**`; R1 supplies filtered diff counts. Metadata returns body, labels, closingIssuesReferences, latestReviews and reviewDecision: map them into PR_CONTEXT's description, labels, linked_issues and review decision evidence. A field is unavailable only when the tool reports an error for it. Done when each field is evidenced or unavailable.

<!-- Gatherer boundary: completeness and provenance are read before recovery or R2 dispatch. Retry while progress is made and supplement through attributed read-only evidence. Unknown head/cleanliness disables pointers, not review; no fallback disables provenance checks. -->
Prefer `pr-context-gatherer` for worktree cleanliness and changed content. For failed/truncated reports, retry while progress is made for the missing remainder, preserving completed evidence. Supplement through granted read-only tools/bash with source attribution, then continue with explicit gaps under R1's evidence gate. Done when provenance and recovery are accounted for.

## Resolve and Pull State
<!-- State intake invariant: validated identity, complete unfiltered names, effective config and checkout outcome are read before resolve/pull and lock admission. Invalid resolution closes state writes, not available analysis; pull failure proceeds with a C-class note. state_sync:false, failed PR checkout or absent branch disables pull, never root validation. -->
Call `corvus_review_sync` with `{op: "resolve", cwd, pr: <SyncPr>, changed_files: <unfiltered inventory>}` using [state identity](../corvus-review-extras/state.md#namespace-and-lock). Record returned root as review_root, task, remote and optional legacy_root; legacy_root is read-only for resume, every write uses review_root. Require ok:true; failed/incomplete inventory or resolution leaves state unavailable, never a guessed root. Then call `corvus_review_sync` with `{op: "pull", cwd, branch: <headRefName or current LOCAL branch>, remote}`; `state_sync: false` skips pull with a note. PR checkout failure/unconfirmed tip or LOCAL detached scope also skips pull with a note, never merging into an unverified worktree. Sync failures are C-class proceed-with-note. Done when resolution and pull outcomes precede acquisition.

## Establish State and Gather Rail Inputs

Call `corvus_review_lock` op `acquire` under [Namespace and Lock](../corvus-review-extras/state.md#namespace-and-lock) before inspecting checkpoints; only explicit interactive consent permits force. Finish current config and triage before acting on resumed state.

<!-- Identity invariant: fixed API/status output for the PR host is read before setting self_review or deciding to post; missing/ambiguous login keeps the shared unknown-identity cap in both modes. Only a usable login resolves unknown; no override disables the cap or other rails. -->
Call `corvus_review_pr` op `identity` for login (the tool owns the 403 fallback) and op `checks` with `{owner, name, pr}` for CI; unavailable identity retains the unknown-identity `COMMENT_ONLY` cap with guidance to grant `read:user`, while unavailable CI carries `checks:read` guidance.
Compare usable login to author exactly: equal→self_review true, different→false, failure/unusable→unknown. CI SUCCESS/NEUTRAL/SKIPPED→pass; FAILURE/ERROR→fail; PENDING/QUEUED/IN_PROGRESS→pending. Record unavailable/unknown check states explicitly rather than inventing pass. Aggregate fail first, then pending, all pass→pass, otherwise none. Done when every available rail input, including self_review, has value and evidence independently of other caps.

## Prior-Review Evidence
Call `corvus_review_pr` op `reviews` with `{owner, name, pr}` for marker-bearing reviews, threads, dispositions and complete_pagination/complete_threads; select the latest valid marker by submitted_at and retain its API id/html_url and the complete result as priorReviews.
Then call `corvus_review_verdict` with `{op: "compute", reviewRoot: review_root, ...<state verdict identity>, priorReviews, config: {}, forceDelta: <trusted invocation force_delta or false>}` without headSha or code_head (history-only). Use its round, never a claimed round. Before R1/R2, record `refuse_delta`/refuse_reason unchanged and follow shared Convergence and Continuation: review once with a note, using fresh full-review scope for missing history. On tool failure, retry while progress is made, then continue available analysis with round unknown and the diagnostic; never invent force_delta or convergence. Exact-head post/resume compares code_head under state validation without admitting a new delta.
Pass the tool's dispositions, review bodies and thread comments (body/path/line/reply links) to R1 unchanged as untrusted evidence: unknown is not a fix/refusal and missing text is a gap. No usable prior review yields the schema's null-metadata object with dispositions []; incomplete history never proves absence. R1 checks prior-SHA reachability; load facts/questions via [Series Knowledge](../corvus-review-extras/state.md#series-knowledge). Done when prior evidence and uncertainty are explicit.

## Load Config
Call `corvus_review_pr` op `config` with `{owner, name, ref: base_sha}` and apply [configuration loading](../corvus-review-extras/config.md#loading-and-provenance), preserving Invocation Mode and provenance. Retrieval failure uses built-in defaults plus trusted invocation values, with a visible gap and no fabricated absence memo.

## Post Follow-Up

A `post` or follow-up request starts fresh R0 → revalidate code_head/base/config and finish current triage plus checkpoint reconciliation → restore only a schema-valid recoverable unposted checkpoint for the SAME code_head with compatible base/config/source evidence → skip R1/R2 and restore R3 synthesis → rerun `corvus_review_payload` measure via [R3 Measure Candidate](../corvus-review-r3/SKILL.md#measure-candidate) → R4 fresh preview and re-authorization in the current invocation mode → R5. Interactive recovery requires question; prior authorization never carries over. Different code_head or incompatible base/config/source evidence uses the existing fresh R1–R3 analysis route in [Resume at R0](../corvus-review-extras/state.md#resume-at-r0). Done when recovery either renews every posting check or starts fresh analysis, preserving the old checkpoint.

## Triage and Exit
Set flags independently and record every rail input even when another cap determines action; unavailable description/labels/related-PR evidence stays unknown and goes to R1, not a fabricated negative.

| Input | Record / handling |
|-------|-------------------|
| Draft, merged, self-review | Shared action caps; closed/merged reviews remain informational |
| files_changed > large_pr_threshold | is_large_pr; warn, warn plus split suggestion, or proceed per strategy; preserve full review scope |
| files_changed > 100 | Warn about review-quality degradation and verify file-list completeness |
| Empty/absent description | missing_description; carry a body-only informational note into R3 |
| ci_status fail | has_ci_failures; R1 researcher analyzes it, review continues |
| breaking-change/breaking/semver-major label | has_breaking_labels; R2 checks backward compatibility |
| Verified empty PR diff | Informational summary for delivery; LOCAL uses its intake empty-result condition |

For rate-limited reads, retry while progress is made, then continue with available evidence and retrieval notes, using config defaults where applicable. Keep unknown identity/OIDs explicit and recover them before identity-dependent tool calls; prior-review/CI gaps retain their caps and limitations. Every terminal branch calls `corvus_review_lock` op `release` for this run under the state contract and discloses cleanup failures.
Present PR identity/author/branches, base/head SHA, change counts, CI, state/self-review, triage implications, enabled dimensions, thresholds/budgets, mode/default action, and prominent provenance warnings. Validate PR_CONTEXT against the shared schema, including facts, rail_inputs, lock ownership, and any current-head resumed document. Done when R1 can consume valid context, a validated resume enters R3 measurement, or a terminal reason and lock cleanup are reported. Emit `[R0 COMPLETE]` with the selected route.

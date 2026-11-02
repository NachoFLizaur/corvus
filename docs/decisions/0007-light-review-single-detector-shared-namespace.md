---
id: ADR-0007
status: proposed
date: 2026-11-01
scope:
  - agent/corvus-review-light.md
  - agent/pr-light-reviewer.md
  - skill/corvus-review-light/SKILL.md
  - skill/corvus-review-extras/state.md
  - src/protected-agents.ts
  - src/review-callers.ts
  - src/review-storage-class.ts
  - src/fixed-denies.ts
  - src/review-pr.ts
  - src/review-worktree.ts
  - src/review-lock.ts
  - src/review-post.ts
  - src/review-sync.ts
  - src/review-persist.ts
  - src/review-payload.ts
  - src/index.ts
  - src/v2/register-tools.ts
  - src/v2/enforce-protected.ts
  - agent/pr-comment-writer.md
  - scripts/smoke-review.sh
  - scripts/check-review-artifacts.ts
  - src/__tests__/review-light-contract.test.ts
  - src/__tests__/review-worktree.test.ts
  - src/__tests__/check-review-artifacts.test.ts
  - README.md
  - docs/CORVUS-REVIEW-SKILL-SET.md
  - AGENTS.md
  - CHANGELOG.md
  - docs/decisions/0007-light-review-single-detector-shared-namespace.md
---

# ADR-0007: Light Review Uses Concurrent Axis Briefs, a Tool-Owned Sibling Worktree and Local-Only Shared-Namespace Artifacts

## Context and Problem

`@corvus-review` rounds measured 27–74 min (avg ~43, ~69 orchestrator turns, ~$54) on a
multi-contributor repository, where competing reviews land and the contributor pushes
fixes before the Corvus review posts (task DISCOVERY.md, Findings §Baseline). The critical
path is model generation in serialized phases: R1 gatherer/researcher (~7 min), the
orchestrator building `review-input.json` (3–18 min), `pr-code-reviewer` (~11.5 min avg,
`skill/corvus-review-r2/SKILL.md:26,32`), and orchestrator-only R3 synthesis with ~44 staged
appends (~9 min, `skill/corvus-review-r3/SKILL.md:62-66`).
The full review also commits review state to the PR branch by default
(`skill/corvus-review-extras/state.md:27`, `README.md:393`) and checks the PR out
(`skill/corvus-review-r0/SKILL.md:39`); in repositories with other contributors those state
commits pollute their branches. The user asked for a light variant that keeps review files
local and publishes to GitHub autonomously.
A faster variant must keep the untrusted-content boundary (detectors are protected and
mechanically read-only, `src/protected-agents.ts:13-17`), the posting-integrity chain
(ADR-0003, ADR-0004) and the writer's fixed artifact layout (`agent/pr-comment-writer.md:39`).
R2 uses two parallel axis children (`skill/corvus-review-r2/SKILL.md`, Axis and Child Mapping); this record does not change R2.

The adaptive-scope follow-up delegated scope judgment to the detector rather than fixed
file/changed-line thresholds. The subsequent 0.11.0-beta.0 run on PR #15 recorded 35
orchestrator turns, 43 calls, 8m15s orchestrator elapsed and approximately $2.04 total cost
(task `corvus-review-light-v2/DISCOVERY.md`, Measured bad run). Its output lacked a Corvus
opening/clear axis separation, copied verbose evidence and summary fields, and widened an
inline anchor before relocation (same source, R1–R7). A 514,396-byte diff exceeded the
512,000-byte transport limit; the whole-file-list fallback spilled before anchor verification.
The user asked for clearer, shorter reviews, subagents and a PR-head worktree next to the
repository, cleaned up afterward (task `corvus-review-light-v2/PLAN.md`, Intent/VQ1–VQ11).

The detector still owns untrusted analysis; the orchestrator owns trusted axis/head controls
and validates reports (`agent/pr-light-reviewer.md`, Trust and Capability Boundary/Report
Format; `skill/corvus-review-light/SKILL.md`, steps 4–6). Shell deny patterns inspect command
text, not workdir: issuing `git read-tree -u --reset HEAD` in the wrong directory would reset
the user's index and overwrite tracked modifications. A regular checkout can run a
post-checkout hook or smudge/process filters chosen through PR attributes; materialized
symlinks can redirect reads to host secrets. The lifecycle therefore needs a tool-owned
boundary rather than trusting model-issued shell population (`src/review-worktree.ts`,
context/treeEntries/populate/worktree).

## Considered Options

- **Reuse both R2 detectors with short briefs** — rejected because `pr-code-reviewer` alone
  is the measured 11.5-min critical path and its contract expects R1/R2 evidence objects
  (`agent/pr-code-reviewer.md:18-24`).
- **Orchestrator-only detection** — rejected because the orchestrator holds write and
  posting authority; reading attacker-controlled diffs there removes the read-only
  detector boundary.
- **A `light` flag on `corvus-review-auto`** — rejected because Invocation Mode and caller
  policy key on fixed agent identity (`skill/corvus-review-extras/state.md:9`,
  `src/review-pr.ts:85-92`); a flag would keep the R0–R5 skill chain and leave state sync
  reachable through repository config (`skill/corvus-review-extras/config.md:11`).
- **Interactive preview gate** — rejected by the user: the approval wait delays a review
  whose value depends on landing before the contributor's next push.
- **Push state like the full review** — rejected by the user: state commits pollute
  contributors' branches.
- **Block sync calls from the light identity only** — rejected because synchronization
  snapshots, stages and commits the whole selected root except `.staging`
  (`src/review-sync.ts:97-108,188-203`), so a later or overlapping full review would still
  commit files a light run left behind.
- **Protect the light primary like the detectors** — rejected because protection replaces
  the whole permission object (`src/index.ts:59-93`), discarding user-supplied extra denials
  such as the harness's writer-dispatch deny.
- **Separate or self-ignoring light root** — rejected because the writer path check, sync
  root, verdict identity and v2 marker pattern accept only `pr<N>|local-<slug>`
  (`agent/pr-comment-writer.md:39`, `src/review-sync.ts:24`, `src/review-pr.ts:269`), a
  second root is not serialized by the shared lock, and silently editing ignore files
  changes the user's repository configuration.
- **Switch the user's checkout to the PR head** — still rejected because it changes their
  working context. A detached sibling worktree answers the earlier "check out the PR head"
  objection without switching their branch or overwriting their files.
- **Object-only PR-head reads** — retained as fallback, not the primary route, because
  `git show`/`git grep` give exact-head evidence but do not provide the requested navigable
  file tree. Creation/access/verification gaps still need disclosure, even when fallback
  recovers some context.
- **Model-issued `git worktree` plus shell `git read-tree -u --reset` population** — rejected
  because a wrong shell workdir can destroy uncommitted main-checkout changes, and text-based
  denies cannot prove directory ownership. Ordinary checkout also exposes hooks, filters and
  symlink redirects; a shell worktree prune would affect other owners' registrations.
- **Tool-owned detached sibling with raw-blob population and owned-only removal** — chosen
  because validated controls, canonical paths and an explicitly selected new-tree index keep
  those mutations out of the model's shell authority, while avoiding checkout/filter execution
  and storing symlink blobs as ordinary files.
- **Fixed file/changed-line thresholds with size-triggered risk focus and full-review advice** —
  rejected for light mode because size alone does not describe risk concentration, generated
  changes or reviewable complexity; the follow-up explicitly delegates that judgment to the
  detector. The existing transport limits remain evidence-retrieval limits, not scope policy.
- **Hard supplementary-read ceiling** — replaced by soft guidance because a fixed count can
  stop decisive context gathering while still spending reads on low-value evidence. Each
  brief records its reads and unresolved context; light is a judgment-bounded pass, not a
  thoroughness promise or numeric context budget.
- **One protected detector covering both axes** — replaced because the observed review carried
  all detection context in one child and failed the presentation requirements. The evidence
  does not prove topology alone caused that output; separate axis briefs plus a compact
  rendering contract are the chosen improvement, with extra child cost explicitly accepted.
- **Exactly two same-identity axis briefs with detector-led omission** — replaced after the
  beta.1 PR #15 run reviewed 31 of 58 files on Standards and omitted tests/checker/docs
  (trusted follow-up dispatch, 2026-11-01). Size-driven sampling did not meet the user's
  coverage expectation; that observation does not establish quality parity or a benchmark.
- **Adaptive cohesive file shards, all axes in one foreground batch** — chosen because it
  scales coverage through parallel context rather than dropping reviewable files, while
  preserving the protected identity and shorter orchestration path. Additional cost is accepted.
- **Autonomous light orchestration + tool-owned sibling tree + local-only shared-namespace
  state** — chosen, retaining the existing writer and integrity chain.

## Decision

- All foreground `pr-light-reviewer` shards of both axes run in one batch per attempt,
  because distinct trusted briefs separate context without weakening the protected identity.
  `axis: standards` covers architecture/correctness/conventions; `axis: spec_security` covers
  Spec across eligible dimensions plus independent security attributed Standards/security.
  IDs include the axis brief and one-based shard (`ls<k>-…`, `lsp<k>-…`), findings keep
  axis/dimension attribution, and a failed shard preserves other valid evidence with one
  Review-limits gap naming uncovered paths, not a repair detection pass. Movement re-plans
  shards (`skill/corvus-review-light/SKILL.md`, step 5).
- Sharding/index follow-up: plan from trusted file names and available per-file sizes, without
  parent code reads; use one shard per axis when comfortably reviewable, otherwise cohesive
  directory/module groups, tests beside code and docs together. Every changed file belongs to
  exactly one shard per axis, because parallel coverage replaces size-driven omission. Each
  shard reviews every eligible assigned hunk; only generated/vendor/lock/binary/snapshot/minified
  content is omitted with reasons, and risk focus/sampling require unavailable evidence. Union
  findings per axis and deduplicate same-path, overlapping-line, same-dimension/title-intent copies,
  then light-only cross-axis copies with the same root cause/fix (exception to ADR-0001; full review unchanged),
  keeping first ID, highest severity/confidence and both axes, indexed once under Standards with Spec shared counts. Each inline gets one linked axis-index
  line from tool-verified `anchors` results' `diff_anchor` (`diff-` + sha256(path)) and exact RIGHT coordinates;
  relocation replaces its index with the unchanged compact body finding, because the body must
  expose every finding without duplicating inline detail. LOCAL has no links. Light acquisition
  rejects `force: true` on both hosts and uses default-deny shell and child-dispatch allowlists, because
  held-lock ownership and the no-delivery authority boundary must survive config overrides
  (`src/review-lock.ts`, `agent/corvus-review-light.md`, `src/__tests__/fixtures/review-light.ts`).
- Each shard has no fixed file/changed-line/shard maxima, review time limit or supplementary-read
  ceiling, because useful context varies by complexity. `all_diff_files` means every assigned
  path/hunk; advisory size config cannot force omission/no-post. Soft guidance prioritizes enclosing code,
  decisive callers and tests, ending low-value investigation while recording all beyond-diff
  read attempts, including failures. Inventory/diff/patch retrieval is not supplementary context.
  Reports retain discovered/selected/reviewed/omitted/unavailable scope, reasons and null unknown
  counts; validation reconciles inventories/regions/read accounts without parent code analysis.
  Combined coverage uses path/region unions rather than summed overlapping counts, because
  independent briefs can inspect the same files (`agent/pr-light-reviewer.md`, steps 3–5/Report
  Format; `skill/corvus-review-light/SKILL.md`, step 5).
- PR mode creates one disposable detached sibling worktree after successful lock acquisition
  and head-object preparation, because navigable exact-head files answer the user's request
  without changing their checkout. Fetch uses only a validated named remote whose get-url
  matches the PR owner/repository, because dropping the HTTPS fallback lets both hosts deny
  every remote token containing colon, slash/backslash or @, or starting with dot, hyphen or
  tilde, including bare scp-style host:path. SSH-configured named remotes remain usable.
  No matching named remote skips fetch/worktree creation with a disclosed GitHub API /
  available-object fallback (`agent/corvus-review-light.md`; light skill, step 4).
  Only `corvus_review_worktree`, callable by the light identity
  on both hosts, owns create/remove. It derives the canonical sibling path from trusted session
  cwd, validated PR/code_head/runId (`runid6` = SHA-256(runId) prefix); the skill uses the returned
  path verbatim, never a PR-selected cwd. Raw-blob population avoids hooks/filter execution,
  disables fsmonitor, selects only the new worktree index, validates tree paths, stores symlinks
  as regular files and reports skipped submodules. Detectors verify HEAD before read/grep/glob;
  no other Git command runs inside the unstatted-index tree, because status/diff can re-hash
  files through clean filters. They never execute PR code, builds or tests. Failure falls back
  to outside-tree object reads with a disclosed gap (`src/review-worktree.ts`, context through
  worktree; `agent/pr-light-reviewer.md`, step 5).
- Every successful create retains its original tuple for removal on all terminal routes and
  before restart re-creation, because lock loss or posting failure must not leak an owned tree.
  Removal precedes lock release, verifies registration/head ownership and confirms directory
  and registration absence. LOCAL, intake CLOSED/MERGED and held/denied locks create none.
  Existing/stale-looking trees are reported, never removed/pruned; failed removal names the
  exact path and manual remedy, and unconfirmed-create rollback needs manual inspection before
  removal (`src/review-worktree.ts`, removeOwned/worktree; light skill, steps 4/6/10).
- The shared writer verifies comment coordinates through `corvus_review_pr` files `anchors`,
  because even one paths-filtered patch can spill and be line-truncated by the host. The tool
  paginates all records and verifies added/context RIGHT spans within one complete hunk,
  returning compact postability/reasons/diff anchors without patch text; unfiltered and
  paths-only calls stay unchanged. Light synthesis moves false/missing anchors body-only
  before freeze; only writer-reported unresolved anchors relocate afterward, and placements
  are never widened by the orchestrator (`src/review-pr.ts`, fileAnchors/verifyAnchors;
  `agent/pr-comment-writer.md`, step 3; light skill, steps 6/9).
- `corvus-review-light` is the autonomous orchestrator (question denied, Invocation Mode
  autonomous) and dispatches only that detector and the existing `pr-comment-writer`,
  because the writer and `corvus_review_post` remain the sole posting route (ADR-0003) and
  authorization binds the previewed frozen digest, event and code head (ADR-0004).
- Light coverage is always recorded as partial, because the existing fail-closed precedence
  then never approves (overrides included), permits severity-derived `REQUEST_CHANGES` only
  for a retained blocker/critical at the confidence floor and lets an eligible trusted
  `REQUEST_CHANGES` override apply inside the cap (`skill/corvus-review-extras/SKILL.md:61-63`).
  Candidate persistence, freeze and post also reject light-class APPROVE, because prompt
  rails alone cannot enforce the never-APPROVE contract at the mutation boundary; full-review
  APPROVE is unchanged (`src/review-persist.ts`, rejectLightApproval; `src/review-payload.ts`,
  freeze; `src/review-post.ts`, readArtifact).
  Fixed edit/write/patch denies, caller-routed `.light` persistence/freeze and
  packaged shell/child-dispatch allowlists enforced on both hosts close direct-tool,
  shell-write and alternate-child full-class artifact authoring because user allows
  cannot widen those capabilities, while additional user denials still hold.
  The marker leads directly into the literal Corvus opening: PR identity, action/head/statistics
  and axis counts, then Standards and Spec sections with one-line headlines. Each finding has
  its Conventional Comments identity, ≤3 short problem/impact lines and one suggestion/fix,
  because light output must remain legible without copying local evidence fields or detector
  summary filler. Inline-first findings have exact-diff index links, not duplicated body detail;
  relocation replaces the index with that compact finding in its own axis. Review limits use ≤3 short factual bullets for
  applicable scope/rationale, omissions/overflow and material gaps, without a generic banner.
  Full-review advice names consequential uncovered risk, material gaps or deeper complexity,
  because size or omission alone is not that evidence. Zero findings is neither approval nor
  complete coverage. Complete inventories, diagnostics and evidence fields stay in the local
  ledger, because actual coverage must remain auditable without bloating the post (light skill,
  steps 6/9/10). Every retained minor is fully detailed inline or body-only, because count-only
  overflow hides actionable findings; light ignores max_minors and nitpicks remain excluded.
- Review state stays local: light candidates, staging and frozen artifacts live in a
  tool-owned storage class inside the shared root, chosen by the tools from caller identity,
  which `corvus_review_sync` excludes from status, snapshot, add/commit and post-commit checks
  exactly as it excludes `.staging`; it also excludes namespace `lock.yaml`/`.lock` when
  `.light` exists, even when empty (`src/review-sync.ts:102-103,142-145,243-244`), because an
  overlapping full review must not capture a light run's active lock bytes or tracked lock
  deletion. The writer's artifact-path contract widens only for that
  class's PR post request. These exclusions keep "do not push review files" true even when
  a full review later synchronizes the same root; full-review synchronization is otherwise
  unchanged.
- On non-fast-forward push retries, excluded HEAD-tracked locks are temporarily
  restored from hash-verified HEAD blobs and their saved working bytes/modes or
  deletion restored after replay, including abort, because rebase requires a clean
  tracked worktree without stashing or committing light lock state; staged locks
  refuse replay and roots without `.light` keep their original argv
  (`src/review-sync.ts`, prepareReplayLocks).
- The light identity may call `corvus_review_sync` only for `resolve` (pull/push rejected by
  the tool), its persist calls are limited to candidate operations, and its fixed
  `question`, edit/write/patch and Git-mutation denies are re-applied tighten-only at
  both host boundaries, because these
  guarantees must survive repository config and user permission overrides while preserving
  the user's additional denials and model choice.
- Light runs share the root's lock and the standard v2 marker and write no `<code_head>/`
  records, because the writer, duplicate lookup and serialization depend on that layout while
  a full review must never resume a light synthesis as if it were full coverage.
- PR metadata is read state-first at intake, after detection, after preview immediately
  before every writer dispatch (including recovery), and after a writer `head-moved` result.
  CLOSED/MERGED stops before lock acquisition or detection at intake, and without further
  detection or posting at later checks; terminal state takes precedence over drift, because
  the post tool checks only the commit-derived head (`src/review-post.ts:279-283`) and R5's
  safeguard is not loaded on the light path (`skill/corvus-review-r5/SKILL.md:27`). Raw-head-only
  changes with unchanged code_head/base SHA neither restart nor stop; unknown transport and
  other posting failures retain their existing recovery routes, not a drift restart.
- Code-head or verified base-SHA drift starts a fresh bounded light pass, because stale
  findings and authorization cannot safely describe the new target. Keep invocation identity
  and the held shared lock; refresh metadata, files, diff, review history and head content,
  reload config if the base moved, and recompute the history-only round/marker. Abort open
  staging under fresh ownership, discard prior findings/descriptor/authorization, reset
  per-attempt recovery allowances, and regenerate candidate/freeze/preview/authorization.
  Admit at most three detection attempts (initial plus two restarts); further drift stops
  without posting. Re-resolve the namespace on refreshed files: unresolved or changed root
  also stops without mutating a new root under the old lock. The local summary records
  attempts, each attempt's code_head/base SHA, terminal reason and the latest observed head
  on exhaustion; retained superseded artifacts are inert, not current authorization
  (`skill/corvus-review-light/SKILL.md`, steps 3–10).
- Restart admission requires lock age ≤90 min from acquisition, because the shared lock
  is fresh only below two hours (`src/review-lock.ts:45,150-168`) and has no renew operation
  (`src/review-lock.ts:44-50`). Reacquiring even with the same runId returns `held` while
  fresh; keep the acquired lock across attempts without reacquisition or renewal. The
  90-min ceiling leaves 30 min before expiry, not a guarantee that a detector finishes in
  time: read fresh-ownership status after every detector return, at restart admission,
  before each presentation revision's first mutation and before every writer dispatch.
  Require the acquired path/runId, unchanged started_at, finite `0 <= age_s < 7200` and no
  other-run holder; missing, expired, changed or unreadable ownership stops shared-artifact
  mutation and posting. Age >90 min refuses restart, not a fresh acquisition. No override,
  attempt budget or LOCAL mode disables ownership checks. Every terminal branch releases
  once if acquired, in delete mode with the owner check; another run's lock is preserved
  (`skill/corvus-review-light/SKILL.md`, steps 2, 6–10).
- A posted light review counts as a round in verdict history; the next full review falls
  back to full scope for the missing checkpoint, because refusing a delta is the safe
  default (`src/review-verdict.ts:355-363`).

## Consequences

**Good**: isolated adaptive axis shards plus the writer (three children when one shard per axis
suffices), without full-path gatherer/researcher or review-input/document staging. Eligible hunks
stay assigned on large PRs. Compact output indexes every inline without duplicating detail. Exact-head file navigation keeps
the user's checkout intact, while tool-owned population/removal neutralizes hook/filter/symlink
hazards. Existing posting integrity, lock, marker, action precedence and sync-ineligible storage
are reused; strategy and coverage accounts keep detector scope inspectable.

**Bad**: adaptive sharding can increase detector sessions without a fixed upper bound;
three attempts still bound head churn. Host overlap and any runtime/cost improvement remain
unmeasured for this revision. Worktree population costs disk/time and needs a writable parent;
creation failures fall back with gaps, while cleanup failures must expose the exact path and
manual remedy. The tool/caller/permission surface spans both hosts; removal preflights cannot
prevent external concurrent directory replacement. Protected identity/fixed-deny/storage
complexity remains, and light posts still advance rounds without checkpoints. Artifacts may
appear untracked. Once `.light/` exists, shared lock bytes/deletions remain sync-excluded even
for full review. Judgment-based scope and soft read guidance are less deterministic; consistent
coverage accounts do not prove that every consequential defect was found or establish parity.

**Neutral**: full-review R0–R5 and the shared config schema stay unchanged. Existing sync skips
the light class and its namespace locks; compact tool-verified anchors and the shared writer's
primary verification path preserve unfiltered/paths-only output. Both axis instances
use the same identity/model override. Advisory light size settings do not change full-pipeline
large-PR semantics. The 21-turn read-through target includes the mandatory skill load and is structural, not a live measurement.

## Verification

- Structural prompt tests pin the light roster to `pr-light-reviewer` and `pr-comment-writer`,
  `question` denied, and the absence of head-record writes and sync pull/push in the light skill.
- Pin concurrent distinct axis/shard briefs per attempt, disjoint complete file assignment,
  collision-free IDs, partial-failure evidence preservation, no hard read/time ceiling and
  the literal compact render template against checker regexes, including exact single/range
  index links, relocation replacement, unwidened placements and no duplicated inline detail.
- Worktree tests cover canonical/relative/symlinked root spelling, raw-blob population,
  hooks/filter/symlink neutralization, owned-only removal, non-owned tree preservation and main
  HEAD/index/file bytes. Caller tests allow the tool only to light on both adapters.
- Checker/harness fixtures cover create→dispatch→remove→release ordering on posted, failed,
  terminal, drift, ownership-loss and refusal routes, plus no creation for LOCAL/intake terminal/
  held lock, cleanup-failure disclosure and registration/sibling-directory leak snapshots.
- Files/writer tests cover selected intact patches, missing/invalid paths, unchanged unfiltered
  output and the oversized-diff fallback, without guessed anchors or writer artifact edits.
- Sync tests show a full-review push over a root holding light artifacts commits no
  light-class path; permission probes show user config cannot re-allow the primary's fixed
  denies while a user writer-dispatch deny survives.
- Caller-policy tests show `pr-light-reviewer` limited to detector read operations,
  `corvus_review_sync` pull/push rejecting `corvus-review-light` with zero git calls, and
  `corvus_review_post` still rejecting every caller except `pr-comment-writer`.
- Verify metadata-first CLOSED/MERGED stops at intake and mid-run, code-head/base drift
  restarts (including writer `head-moved`), raw-head-only changes ignored, three-attempt
  exhaustion, root-change and >90-min lock-age refusal, and ownership loss after detection.
- Verify each artifact-producing attempt and presentation revision has fresh authorization and the
  required ownership checks; the lock is never reacquired and is released once if acquired.
  Check the summary ledger against attempts/heads/terminal evidence, and marker-first bodies
  for applicable factual Review limits without a mandatory banner; partial action precedence
  and every retained minor is detailed while nitpicks remain excluded.

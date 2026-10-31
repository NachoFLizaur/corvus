---
id: ADR-0007
status: proposed
date: 2026-10-30
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
---

# ADR-0007: Light review publishes autonomously from one bounded protected detector and keeps its artifacts in a sync-ineligible class of the shared namespace

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
ADR-0001 keeps R2 as two parallel axis children; this record does not change R2.

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
- **Check out the PR head** — rejected because it switches the user's worktree; a fetched
  PR ref read with `git show <head>:<path>` (the gatherer's precedent,
  `agent/pr-context-gatherer.md:32`) gives head-accurate content without a checkout.
- **Autonomous light orchestrator + one bounded protected detector + local-only state in the
  shared namespace** — chosen.

## Decision

- A new protected, mechanically read-only subagent `pr-light-reviewer` performs one bounded
  pass per detection attempt over correctness, security, stated PR intent and consequential
  architecture or convention defects, attributing each finding to the Standards or Spec axis,
  because one isolated reviewer with bounded evidence is the pattern fast reviewers use while the
  protected boundary still separates untrusted content from posting authority.
- `corvus-review-light` is the autonomous orchestrator (question denied, Invocation Mode
  autonomous) and dispatches only that detector and the existing `pr-comment-writer`,
  because the writer and `corvus_review_post` remain the sole posting route (ADR-0003) and
  authorization binds the previewed frozen digest, event and code head (ADR-0004).
- Light coverage is always recorded as partial, because the existing fail-closed precedence
  then never approves (overrides included), permits severity-derived `REQUEST_CHANGES` only
  for a retained blocker/critical at the confidence floor and lets an eligible trusted
  `REQUEST_CHANGES` override apply inside the cap, without a light-specific action rule (`skill/corvus-review-extras/SKILL.md:61-63`).
  The marker leads directly into review content, without a generic reduced-coverage banner
  or equivalent mandatory notice, because internal partial coverage governs action rather
  than requiring a body warning. Review limits disclose only applicable factual scope,
  omitted scope, oversized risk-first selection/full-review recommendation, gaps and
  axis/severity counts/overflow; zero findings is not approval or complete coverage
  (`skill/corvus-review-light/SKILL.md`, step 6). Minor details remain capped at
  `min(validated max_minors, 2)`, nitpicks excluded and minor overflow counted by axis.
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
- The light identity may call `corvus_review_sync` only for `resolve` (pull/push rejected by
  the tool), its persist calls are limited to candidate operations, and its fixed `question`
  and Git-mutation denies are re-applied tighten-only at both host boundaries, because these
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

**Good**: one detector session per attempt plus the writer (two on the no-restart happy path)
instead of four or five on the full path; no approval wait, review-input or
document staging; no light files in any state commit, including a later full review's, and
no worktree switch; existing posting integrity, lock, marker and action precedence reused.

**Bad**: one more protected identity, a fixed-deny enforcement path, caller-specific tool
restrictions and a new storage class across both hosts and the writer contract; quality
parity with the two-axis review is unmeasured; light posts advance the round counter without
a resumable checkpoint; light artifacts appear as untracked files unless the user excludes
the light class locally. Moving heads can cost up to three detector passes rather than one;
the fixed attempt limit and lock-age/root refusals bound churn by stopping without posting
instead of retrying indefinitely. Once a root holds `.light/` (even empty), its
`lock.yaml`/`.lock` records stop being synchronized for full reviews too; this durable
exclusion is the cost of keeping light lock bytes and tracked deletions local.

**Neutral**: `corvus-review` and `corvus-review-auto` behaviour and ADR-0001's two-axis R2
are unchanged apart from synchronization skipping the light class and namespace
`lock.yaml`/`.lock` when `.light` exists (even when empty); per-user model overrides can
point the light detector at a faster model.

## Verification

- Structural prompt tests pin the light roster to `pr-light-reviewer` and `pr-comment-writer`,
  `question` denied, and the absence of head-record writes and sync pull/push in the light skill.
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
  and minor caps/nitpick exclusion remain unchanged.

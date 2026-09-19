---
id: ADR-0003
status: proposed
date: 2026-09-15
scope:
  - src/review-post.ts
  - src/review-payload.ts
  - src/index.ts
  - src/v2/register-tools.ts
  - agent/pr-comment-writer.md
  - agent/corvus-review.md
  - agent/corvus-review-auto.md
  - skill/corvus-review-r4/SKILL.md
  - skill/corvus-review-r5/SKILL.md
  - skill/corvus-review-extras/*.md
  - scripts/check-review-artifacts.ts
  - scripts/check-writer-run.ts
  - scripts/smoke-*.sh
  - scripts/probe-tools.ts
---

# ADR-0003: `corvus_review_post` is the sole posting-integrity owner

## Context and Problem

Artifact verification is mandated at four workflow locations and executed by two owners:

- A standalone tool `corvus_review_verify` is registered on both hosts (`src/index.ts:138-149`,
  `src/v2/register-tools.ts:51-69`) and required before dispatch by R5
  (`skill/corvus-review-r5/SKILL.md:31,46`), before POST by the writer
  (`agent/pr-comment-writer.md:37,41,61`), and after every re-freeze
  (`skill/corvus-review-r4/SKILL.md:35`, `skill/corvus-review-r5/SKILL.md:76`).
- `corvus_review_post` already runs the same shared `verify()` internally before its head GET and
  again before every POST including the 429 retry (`src/review-post.ts:241-260`).

The model-driven calls add coordination failure points (a writer that stops at a transient verify
failure never reaches the tool that would have verified anyway), a "re-freeze on verify failure"
ritual (`r4:33-35`, `extras/SKILL.md:35`), a fifth no-post exception phrased around that ritual
(`extras/SKILL.md:34`), and an audit chain that requires the standalone call as ordering evidence
(`scripts/check-review-artifacts.ts:561-623,1028-1079`). The user's direction: "STOP ADDING
GUARDRAILS AND CONDITIONS ... WE DO THE REVIEW AND WE POST IT."

Separately, `post` resolves a workspace-relative `artifactPath` against `process.cwd()`
(`src/review-payload.ts:236` via `src/review-post.ts:71`), while the descriptor contract stores a
relative path (`skill/corvus-review-extras/state.md:85-87`, `agent/pr-comment-writer.md:39`). The
payload adapter already prefixes relative paths with the host directory before containment
(`src/review-payload.ts:406`); post receives only the review-state root (`src/review-post.ts:285-292`).

## Considered Options

1. **Keep `corvus_review_verify` as an optional diagnostic and only remove the mandates.**
   Rejected: an exposed tool with no owning procedure invites re-mandating it "for safety" (the
   incident-driven regrowth ADR-0002 §Context documents); the inventory test, smoke preflights and
   permission tables would keep pinning a tool nobody is required to call.
2. **Collapse to literally one verification execution per post attempt.** Rejected: the second
   `readArtifact` before each POST is the only mitigation for the non-atomic gap between the
   verifying read and `gh --input` reading the file (`src/review-post.ts:227-228`); removing it
   widens that window for no simplification the model can observe.
3. **Retire the standalone tool; `post` is the single enforcement point, keeping its internal
   pre-GET and pre-POST re-verification.** Chosen.

## Decision

- Unregister `corvus_review_verify` from both hosts and drop the `verify` entry from the payload
  executor factory, because a tool without an owning procedure is a regrowth surface. The shared
  library `verify()` stays exported: `post` uses it, and the offline smoke gate row `built verify()`
  keeps calling it against artifact bytes (`scripts/check-review-artifacts.ts:1070-1079`).
- `post` keeps verifying the same descriptor before GET and before every POST, because "one owner"
  means one enforcement point, not one read; the remaining TOCTOU is disclosed in its docblock.
- `post` resolves a relative `artifactPath` against the host session directory captured at
  registration, prefixing before containment exactly as the payload adapter does, because
  traversal must still be rejected by `checkedPath`, not normalized away. Absolute paths keep
  working. Without a captured directory a relative path rejects.
- Every skill/agent mandate to call the standalone tool is removed, including the writer preflight
  entry, the R4 "Verification Recovery" re-freeze checkpoint and the `verification_refreeze_attempted`
  flag, because the tool that posts already rejects bad bytes with `artifact-verify-failed:<reason>`.
  The fifth Delivery Principle exception becomes: **`corvus_review_post` rejects the artifact bytes
  (`artifact-verify-failed`) and repair through R4 stalls under the progress rule** — an ordinary
  progress-based repair, not a one-shot ritual. Head-moved remains a renewal, never an exception.
- Canonical tokens (owned here; consumers reuse them byte-for-byte): writer preflight tool pair
  `corvus_review_pr` and `corvus_review_post`; writer pre-POST rejection reason prefix
  `artifact-verify-failed`; fifth exception phrase `the post tool rejects the artifact bytes and repair stalls`.

## Consequences

**Good**: one fewer tool in the eight-tool inventory (now seven); the writer's critical path is
descriptor validation → reads → marker lookup → `post`; no model step can "fail verification" before
the tool that enforces it; audits anchor ordering on freeze/dispatch/post instead of a model call.

**Bad**: breaking for any external permission config or harness that names `corvus_review_verify`
(pre-1.0, unreleased beta line); the writer loses an early local diagnostic and learns of bad bytes
only from `post`'s rejection reason.

**Neutral**: `verify()` library tests (`src/__tests__/review-payload.test.ts:363-423`) are
unchanged; containment, caller check (`caller-not-allowed`), head-moved and no-alternate-endpoint
rules are untouched.

## Verification

- Tool inventory tests list exactly seven tools on both hosts.
- Retirement scope is the **operative surface**: host registrations, the payload executor factory,
  workflow mandates and preflights (agents, skills, smoke shells, probe, writer-run checker) and
  current user documentation (README, skill-set doc, CHANGELOG "Unreleased"). Within that scope
  `corvus_review_verify` does not appear. Explicitly allowed: historical discussion in this ADR
  and prior CHANGELOG releases, and negative tests that prove the literal is unknown to a host,
  forbidden in the prompt corpus, or rejected by a probe. The prompt-corpus negative is feasible
  because the structural test loads only `agent/`, `command/` and `skill/`, never `docs` or CHANGELOG.
- The shared `verify()` library tests and the offline `built verify()` audit row are retained.
- A `review-post.test.ts` case posts a workspace-relative artifact while `process.cwd()` differs
  from the fixture directory; `../x.json` still rejects `path-outside-root`.

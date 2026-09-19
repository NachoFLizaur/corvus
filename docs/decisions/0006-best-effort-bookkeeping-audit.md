---
id: ADR-0006
status: proposed
date: 2026-09-15
scope:
  - scripts/check-review-artifacts.ts
  - scripts/check-writer-run.ts
  - src/__tests__/check-review-artifacts.test.ts
  - skill/corvus-review-extras/state.md
  - skill/corvus-review-r3/SKILL.md
  - skill/corvus-review-r4/SKILL.md
  - skill/corvus-review-r5/SKILL.md
---

# ADR-0006: Bookkeeping is best-effort; the audit separates disclosed-unavailable from forged

## Context and Problem

Since beta.10 the prose treats checkpoint persistence and verdict computation as best-effort:
"Persistence is best effort, never a posting prerequisite" (`skill/corvus-review-r4/SKILL.md:10`),
"do not require a persisted document or verdict to attempt delivery" (`r5:13`), verdict failure is
"not a posting veto" (`skill/corvus-review-extras/state.md:66`). The smoke audit still enforces the
pre-beta.10 gates: a DB-matched history verdict before any R1/R2 child (`scripts/check-review-artifacts.ts:399-407`),
a head verdict strictly between document write and the first decision record (`:409-424`),
verdict-persistence rows chained on that ordering (`:441-460`), staged-only provenance with any
`write_document` rejected (`:876-878,915-929`), and a `checkpoint-failed` route that forbids writer,
post, freeze and head-verdict calls and requires `posted:false` (`:965-979,1211-1220`). A v2 marker
is required even though R3 permits a v1 marker when round is unknown (`:296-299`, `r3:47`). The
gate therefore fails a run that did exactly what the prose says: disclose and post.

The user's decision: keep the bookkeeping where it happens today (so files exist whenever
possible), make any failure or absence a disclosed note, and have the audit distinguish
"unavailable and disclosed" from "claimed success but forged". `corvus_review_sync` stays
best-effort with no new code; docs gain a note that `.corvus/reviews/` must not be gitignored in
target repositories or state commits cannot land.

## Considered Options

1. **Drop bookkeeping from the pipeline entirely.** Rejected: round numbering, delta sensitivity,
   convergence and resume all read these files (`src/review-verdict.ts:314-374`); losing them
   degrades every later round.
2. **Keep the audit gates and accept red smoke runs as "known".** Rejected: a gate nobody trusts
   is no gate; it also masks real regressions (forged counts, model-written state).
3. **Keep bookkeeping best-effort in place and make the audit truth-preserving rather than
   order-enforcing.** Chosen.

## Decision

- The pipeline keeps calling staged persistence, verdict compute and `write_meta` at the points it
  does today, because durable files are still wanted whenever the tools succeed. None of them is a
  posting precondition; each failure or absence is disclosed in Review limits and the terminal
  summary with its exact tool diagnostic.
- The audit adopts a three-state row semantics for every bookkeeping row (history verdict, head
  verdict, verdict persisted, verdict document counts, document staged, checkpoint writes, marker)
  **and for every dependent aggregate row that today assumes them** (artifacts, review-state tools,
  continuation note, metadata, sync metadata and sync receipt), because a dependent row that still
  requires a successful checkpoint would reinstate the prerequisite being removed. Evidence
  precedence, applied in this order:
  1. **Contradicted success** → FAIL `forged:` — a successful tool result whose persisted file, DB
     record or document counts disagree; a `write_document` where staging was claimed; model-written
     state files; a summary that claims **tool-produced** counts, round or convergence that no
     matching tool produced. An accompanying "unavailable" note does not rescue this state.
  2. **Absent or failed evidence without disclosure** → FAIL `undisclosed:` — the row's evidence is
     missing or the tool failed and the terminal assistant note does not name it. A failed attempt
     that is visible only in the tool trace is undisclosed: the trace establishes *what* failed, it
     does not establish that the agent *reported* it. This is not labelled forged: absence and
     mismatch are distinguishable only by the presence of a contradicting claim.
  3. **Absent or failed, and disclosed, with no contradictory claim** → `N/A-PASS: <what>
     unavailable, disclosed`. Failure evidence and disclosure are separate conditions. Recorded tool
     attempts (including failed `write_meta` calls) supply the failure evidence; disclosure requires
     an explicit terminal assistant note that identifies the unavailable operation or artifact and
     quotes its tool diagnostic, or states explicitly that no diagnostic exists. Disclosure does not
     require that failure metadata itself was written, because that write can fail too — but its
     absence must then be named in the note like any other failure.
  4. **Present and consistent** → PASS with the evidence.
  Counts explicitly labelled as synthesis counts with the verdict noted unavailable (as R4 and R5
  permit) are not claims of tool-produced counts and never satisfy state 1 on their own.
  Ordering is still checked where it is a truth condition (a head verdict must follow the document
  it summarizes; metadata must precede release), never as a dispatch precondition (no "before any
  R1/R2 child", no "before the first decision record").
- The `checkpoint-failed` route stops forbidding writer dispatch, post, freeze and head-verdict
  calls and stops requiring `posted:false`; it requires disclosure only, with failure metadata
  checked for consistency when it exists. The success-only N/A conversion list shrinks to rows that
  genuinely cannot exist without a checkpoint.
- A disclosed failed `corvus_review_sync` push after release is a validated attempt, not later
  review work; sync metadata and receipt rows follow the same precedence.
- The overflow path is a success path. Candidate production is established by either a successful
  single-call `write_candidate` or a successful staged-candidate `finalize`; the staged route is
  admitted only when its `begin` names the candidate target, every `append` between that begin and
  the finalize carries the same staging id under the lock, the finalize's returned path is the
  canonical candidate path, and the file's digest and comment order match what the finalize
  reported. Measurement is anchored after whichever producer succeeded. A completed, schema-valid
  `measure` carrying size violations (not `ok:true`) is admitted as the predecessor of a fitted
  `freeze`. When freeze reports `fitted`, a conditional `size fit` row checks the artifact's limits,
  empty comments, identity/event, footer count equal to the omitted sum, disclosure in the terminal
  summary and the artifact digest. Read-only `preview` calls between freeze and decision are permitted.
- On the writer-not-exposed route an inert, validated frozen artifact is permitted (freeze now
  precedes preview); writer dispatch and post remain forbidden there.
- A v1 marker passes when round is unavailable and disclosed; v2 is required when a verdict round
  exists.
- Unchanged hard failures: candidate/artifact integrity, model-write detection, append integrity,
  lock ownership, containment and the mutation barriers.
- Canonical tokens (owned here): detail prefix `N/A-PASS:` with reason suffix `unavailable, disclosed`;
  failure detail prefixes `forged:` and `undisclosed:`; conditional row name `size fit`.

## Consequences

**Good**: the gate scores what the prose mandates; a run that posts after a persistence failure
and says so is green; fabricated counts and model writes still fail; the checker becomes a
regression net for truthfulness rather than for a fixed call order.

**Bad**: fewer hard ordering assertions means a run can skip bookkeeping and still pass if it
discloses it; row counts and fixture indices in the checker tests must be re-derived; the checker
grows a fourth detail class (`undisclosed:`) and a conditional row.

**Neutral**: `.corvus/**` exclusion checks, lock ownership, append ceiling, containment and the
posting barrier (blocked POST, no forwarded mutation) are unchanged and remain hard failures.

## Verification

- Checker tests include, per bookkeeping row, one PASS, one disclosed N/A-PASS, one undisclosed FAIL
  and one forged FAIL case; a labelled-synthesis-count summary passes while a claimed-tool-count
  summary with no matching tool fails forged.
- A fixture with a missing history verdict and a disclosing terminal summary exits 0 in PR mode.
- A fixture whose tool trace records a failed bookkeeping call but whose terminal note is silent
  about it fails `undisclosed:`; the sibling fixture with the same failed call named in the note
  (with its diagnostic) passes N/A-PASS.
- End-to-end fixtures: failed checkpoint plus failed failure-metadata write (both named in the
  terminal note) exits 0; disclosed sync push failure exits 0; staged candidate (begin → body and
  comment parts → finalize, no single-call `write_candidate`) → over-budget measure → fitted freeze
  → preview → writer/barrier exits 0 with the `size fit` row; incomplete staging (missing part) and
  mismatched finalization (reported path or digest differs from the file) fail; malformed
  measurement and inconsistent fit (fitted claimed, artifact has comments or footer count differs)
  fail.
- Writer-not-exposed route with an inert frozen artifact passes; the same route with a writer
  dispatch or post fails.

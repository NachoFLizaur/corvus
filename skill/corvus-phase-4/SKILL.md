---
name: corvus-phase-4
description: Implementation loop - per-phase execution with quality gates
---

# Phase 4: Implementation

Run 4a → 4b → 4c for each approved phase, at every depth. Read PLAN.md using
[Plan Format](../../agent/task-planner.md#plan-format); test timing and authoring belong
to [Phase 2 Tests](../corvus-phase-2/SKILL.md#tests). Material execution divergence stops
work and returns to planning through that skill.

## Frontier

<!-- adapted from mattpocock/skills (MIT) -->
The **frontier** is the set of unfinished tasks whose every `blocks:` predecessor is
`[x]`, restricted to the current phase. Phase 4 dispatches the whole frontier in parallel
where file sets are disjoint, then recomputes.

## Slice

<!-- adapted from mattpocock/skills (MIT) -->
A **slice** is one task: a narrow but complete path through every layer it touches,
verifiable alone and sized to one fresh context window.

## Gate

A **gate** is the 4b quality check that closes a phase: code-quality validates every
task's done-when with evidence; PASS → 4c; FAIL → the fix loop.

## 4a: Dispatch The Current Frontier

<!--
Dispatch oracle: current plan, verified completions, and explorer ownership evidence, read
before each launch. Missing predecessors or unresolved ownership hold the task; overlap
serializes dispatch. Grouping and depth never disable these checks.
-->

1. Read the current phase and predecessor edges using Plan Format's outgoing `blocks:`
   convention. Overlay verified task completions as `[x]` in session state while disk
   updates wait for 4c. Hold failed tasks and their dependents; surface an empty frontier
   with unfinished work as a sequencing or prerequisite gap.
   Done when every candidate has satisfied predecessors and unresolved work is accounted for.
2. Before each frontier wave, send one scoped code-explorer [ownership resolution](reference/dispatch-templates.md#ownership-resolution)
   with the wave's PLAN.md task lines; derive per-task allowlists from its candidates and overlap matrix.
   Serialize any tasks sharing a file; keep disjoint tasks parallel, with disjoint dispatch unions.
   Use one code-implementer per task or small groups of 1–5; prefer smaller groups for sizeable tasks.
   Buffer task → dispatch → paths, overlap evidence, and serialization order for 4c's `## Log`.
   Done when each dispatch has explicit ownership and its concurrency is safe.
3. Send the [dispatch templates](reference/dispatch-templates.md), with per-task authorized
   checks and provenance. Collect conforming reports, apply [production-gap escalation](#production-gap-escalation),
   and verify claimed artifacts on disk;
   recompute the frontier from evidenced completions until the phase is implemented.
   Done when all phase tasks have reports and evidence, or failures are ready for 4b attribution.

### Production-Gap Escalation

For every implementation report, initial or fix, inspect disclosed deviations before accepting
completion in 4a or issuing 4b PASS. If one implies `production would need to change` outside
its write allowlist, retain the required paths/behavior and dispatch task-planner `AMEND_PLAN add-fix-tasks` per corvus-phase-7 §AMEND_PLAN Dispatch
with the plan path, phase, task lines, and implementation report as source pointer so Corvus can widen the dispatch manifest, or record an explicit deferral with rationale.
Never accept a workaround or assertions pinning defective output as resolution of the gap.
<!--
Report oracle: child deviations, dispatched allowlists, and verified artifacts, read before
completion or gate advancement. Unresolved gaps hold both; a recorded deferral preserves
the open gap, not a satisfied criterion. Report type, depth, and fix status grant no bypass.
-->
Done when each gap has planned ownership or an explicit deferral and no false completion claim.

### Wide Refactors

<!-- adapted from mattpocock/skills (MIT) -->
Use expand–contract when a mechanical change cannot land as independent slices: add the
new form alongside the old, migrate consumers in bounded batches blocked by expansion,
then remove the old form after every migration. If batches cannot stand alone, retain
the sequence on an integration branch with all batches blocking integrate-and-verify;
claim verified integration only at that boundary, under the selected Tests policy.
Done when the new form serves all consumers and the contract/integration task has evidence.

## 4b: Check The Whole Phase

Use acceptance-only for either selected Tests policy, following Phase 2 Tests. Dispatch
code-quality with the whole phase's task lines, done-whens, ownership, changes, and 4a
evidence via the linked acceptance-check template. This gate exists at every depth.
<!--
Gate oracle: task criteria, current files, and authorized evidence, read before closing
the phase. Missing or failing evidence holds advancement; only PASS admits 4c. The triage
below replaces the independent dispatch, not the gate; depth never disables the gate.
-->
Risk-triaged skip: only a single-dispatch phase with all per-task reports PASS, zero
deviations, and no test or parity surface touched may omit the code-quality dispatch.
Inspect changed files/hunks and reports; lightweight verification checks every done-when
and applicable acceptance criterion, authorized command's passing output, and write-allowlist compliance. Record
`4b: PASS (lightweight — skip conditions met: <list>)` with evidence. Any uncertainty or
fix-loop re-entry requires the real dispatch.
Done when the whole phase has an evidenced PASS for 4c or attributed FAIL for the fix loop.

### Failure Routing

Iteration 1 dispatches a direct fix from the 4b report for failing tasks only; from
iteration 2, task-planner `FAILURE_ANALYSIS` precedes implementation. Use the
[fix handling and templates](reference/fix-loop.md) for origin tracking, the repeated-class
root-cause/revert stop rule, and revalidation at the same whole-phase scope.
<!--
Fix-budget oracle: this phase's 4b FAIL → fix → 4b count, read before another fix.
At three unsuccessful iterations, stop and escalate with passed/failed tasks and open
questions. In-task attempts and transport replacements are separate counters, not extensions.
-->
Done when revalidation passes, a planning gap holds execution, or the three-iteration cap
escalates the remaining failures to the user (corvus-auto halts and reports).

## 4c: Record One Phase Boundary

After PASS, send one batched task-planner dispatch using its
[PROGRESS_UPDATE mode](../../agent/task-planner.md#progress_update):

```markdown
**MODE**: PROGRESS_UPDATE
**Repository**: <canonical user-repository root>
**Plan**: <absolute PLAN.md path>
**Status Updates**: <all accumulated task/phase checkboxes and current Status>
**Gate Outcome**: <dated 4b PASS, with one stable evidence pointer>
**Log Entry**: <dated phase outcome; task → dispatch → resolved file ownership history; overlaps and serialization order>
```

Keep runtime completion tracking in session until this batch; Corvus verifies, task-planner
writes. Compare the returned plan against its pre-dispatch bytes: only task/phase checkboxes,
Status, one Gates line, and one Log line may change; preserve all other text byte-for-byte.
<!--
Progress oracle: pre-dispatch plan bytes, the batch, and gate evidence, read before update
and checked against the returned diff before advancement. Rejection, missing writes,
unauthorized changes, or completed-state regression block transition; no caller bypasses it.
-->
Done when the batch is recorded once and its confined diff is verified; then start the next
phase or [Phase 5](../corvus-phase-5/SKILL.md) when implementation phases are complete.

## Recover Child Transport

Use [transport recovery](reference/transport-retry.md) for empty, truncated, or schema-invalid
child reports: one resume, then one byte-identical redispatch, mutation-aware for implementers.
Recovery preserves fix budgets; cancellations require `AUDIT INHERITED STATE` before overlap.
Done when a conforming result is routed or the owning step's failure path holds execution.

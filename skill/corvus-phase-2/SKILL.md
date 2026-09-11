---
name: corvus-phase-2
description: Planning (Phase 2), mandatory High Accuracy Plan Review (Phase 3.5), and User Approval (Phase 3)
---

# Planning and Approval

## Phase 2: Planning

Turn clear requirements and completed discovery into one adaptive plan. The schema and
effort policy live in task-planner's Plan Format; this skill
owns dispatch templates, test-execution timing, the review loop, and the approval handoff.

### Tests

Use `**Tests**: deferred | none` from Plan Format, defaulting to deferred. Deferred plans
author coverage during Phase 4 and run a single full suite at Phase 5a; none uses acceptance
checks only, with no test authoring. Both retain acceptance checks at the required gates.
deferred → no test execution before Phase 5a; none → no test execution at all.
<!-- Test timing oracle: the selected plan policy and current phase, read before every dispatch. Missing or conflicting policy blocks dispatch; consumers permit execution only at the stated phase for the selected policy. Neither depth nor autonomous approval disables this control. -->

### Planner Dispatch

1. Resolve the user's repository root, feature, analyst-owned immutable requirements,
   proposed depth with reason, selected tests, and discovery digest. Preserve supplied
   choices; use the analyst for requirement changes and discovery for missing facts.
   Done when planning inputs are clear and grounded in the repository.
2. Dispatch task-planner with the following payload. Decision-record handling belongs to
   its Decision Records section and the user's repository `docs/decisions/` convention.
   Persist discovery using its Discovery Companion schema.

```markdown
**TASK**: Create one adaptive plan and persist its discovery companion for <feature and intended outcome>.
**Repository**: <canonical user-repository root>
**Plan**: <root>/.corvus/tasks/<feature>/PLAN.md
**Depth**: <selected value> — <reason>
**Tests**: <selected policy>
**User Requirements (Immutable)**: <verbatim requirements-analyst section>
**Discovery Digest**: <findings with evidence, affected seams and consumers, patterns, risks, unknowns; include Discovery Companion inputs>
**Report Back**: Written plan and DISCOVERY.md locations, depth and reason, decision IDs, unresolved questions.
```

   Done when task-planner returns the written artifact or a precise blocked prerequisite.
3. Read the returned PLAN.md and DISCOVERY.md from disk directly; glob is not the existence
   check for the hidden directory. Compare requirements, selected inputs, and digest with
   the returned content using Plan Format and Discovery Companion. Resolve missing or
   incomplete artifacts through task-planner before review.
   Done when one on-disk plan and its discovery evidence are ready for automatic Phase 3.5 review.

For a Phase 1 re-run, send its dated delta and plan path to task-planner's Discovery Companion
procedure before continuing; use the persisted findings as the reviewer digest.

## Phase 3.5: High Accuracy Plan Review

Prefer a different model from task-planner; when both resolve to the same model, proceed with `review_mode: same-model`. Dispatch plan-reviewer:
```markdown
**TASK**: Review the whole plan using your Output Format and Iteration Contract.
**Repository**: <canonical user-repository root>
**Plan**: <absolute PLAN.md path>
**Depth**: <selected value and reason>
**Tests**: <selected policy>
**User Requirements (Immutable)**: <verbatim analyst section>
**Discovery Digest**: <evidence, affected seams and consumers, risks>
**Review Round**: <N, starting at 1>; review_mode: <cross-model | same-model> from intake
**Previous Review**: <none for round 1; otherwise the full previous response>
**REVIEW HISTORY**: <[] for round 1; otherwise round-numbered defect-key sets for every prior round>
```
- `OK`: carry the outcome and round count to Phase 3.
- `REJECT`: dispatch task-planner once with the complete fix list:
```markdown
**MODE**: PLAN_FIX
**Repository**: <canonical user-repository root>
**Plan**: <absolute PLAN.md path>
**Fixes**: <verbatim numbered fix list from this review>
```
Append this round's defect-key set to REVIEW HISTORY, read the revised PLAN.md, then automatically re-review the whole plan with prior inputs, the full history, the previous response, and the next round number.
Loop until `OK` at every depth, with no round cap, skip, or intervening approval question.
`STALLED: true` takes precedence over another fix: stop and carry the residual list to Phase 3 as unresolved `REJECT`; corvus-auto halts and reports it.
If execution diverges from the approved plan, stop and re-plan through this workflow.
Done when review reaches `OK` or a stalled residual list is surfaced; a blocked dispatch holds the workflow.

## Phase 3: User Approval

Read the current plan and terminal review before presenting this single approval gate.
<!-- Approval oracle: the on-disk plan, terminal review, and caller's approval, read before Phase 4 dispatch. Missing evidence or unresolved REJECT holds execution. Autonomous approval replaces the user decision only; neither caller nor depth bypasses the review prerequisite. -->
Present one bounded summary; detailed tasks stay in the plan:

```markdown
## Implementation Plan Ready
**Feature**: <name>
**Plan**: <PLAN.md location>
**Depth**: <selected value> — <reason>
**Tests**: <selected policy>
**Scope**: <phase count> phases, <task count> tasks
**Review**: <OK or REJECT — STALLED> after <N> rounds this cycle; <review response reference>; review_mode: <cross-model | same-model>; <append "(degraded)" only for same-model>
**Immutable Requirements**: <bounded summary; authoritative text remains unchanged in PLAN.md>
**Fog of War**: <material unknowns; remaining details in PLAN.md>
```

For a stalled review, attach the residual fix list unchanged and label it unresolved.
Interactive corvus calls `question()` directly with header "Reviewed Implementation Plan",
question "Ready to proceed with this reviewed plan?", and these options:
- "Start Implementation" — approve the reviewed plan and begin Phase 4; offer only for `OK`.
- "Request Changes" — collect feedback, return to Phase 2, and automatically review again.
- "Override Depth" — collect a replacement depth, refresh discovery as needed, and return
  to Phase 2 and review before presenting this gate again.

User-directed changes at this gate begin a new plan review, not a stalled-loop continuation: before re-review, reset Review Round to 1, REVIEW HISTORY to [], and Previous Review to none.

corvus-auto auto-approves an `OK` plan without `question()`; its caller owns autonomous policy.
Done when approval admits Phase 4, feedback returns to planning, or unresolved review holds execution.

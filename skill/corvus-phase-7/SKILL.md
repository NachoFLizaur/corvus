---
name: corvus-phase-7
description: Follow-up triage - handling requests after feature completion
---

# Phase 7: Follow-up Triage

After Phase 6, classify each new request before delegating changes. Read the source plan,
its completion evidence, and the new request, including on a later-session return.
Use [Phase 2 Tests](../corvus-phase-2/SKILL.md#tests) for every route's test semantics.

## Preserve the Source

Dispatch task-planner `AMEND_PLAN copy-forward` per corvus-phase-7 §AMEND_PLAN Dispatch with the
source directory and a new feature's PLAN.md before any planned continuation of a legacy or
completed source. Direct fixes read the source as context without a planner write.
<!-- Archived plans preserve the evidence of what was approved and completed. -->
<!-- Plan-write oracle: source path, on-disk status, and destination, read before any planner write. Completed or legacy sources reject in-place mutation; an uncertain state holds routing. Direct fixes need no plan mutation; no route disables source preservation. -->
Done when the source is protected and any planned continuation has a distinct writable artifact.

## Select a Route

| Condition | Route |
|-----------|-------|
| Unfinished work in an active plan | RESUME through the orchestrator's resume flow. |
| Related, clear fix touching fewer than 3 files, with no design decision | Small fix: direct code-implementer, then code-quality. |
| Related addition touching 3+ files, unclear scope, or a design decision | PARTIAL: dispatch task-planner `AMEND_PLAN append-phase` per corvus-phase-7 §AMEND_PLAN Dispatch, then re-review. |
| New or unrelated feature | FULL: new feature and new PLAN.md, starting at Phase 0. |

Report the relationship, likely affected scope, chosen route, and reason. For unfinished
work, resume at the first incomplete step and verify the last gate's evidence through the
orchestrator. Apply source preservation before any route that needs a planner write.
Done when the caller has one evidenced route, or uncertainty has selected discovery.

## Small Fixes

Resolve exact paths and obtain the caller's authorization for the new request; prior
completion alone is not approval for additional work. Use the Phase 4
[dispatch inputs](../corvus-phase-4/reference/dispatch-templates.md#prepare-dispatch-inputs)
to scope a direct code-implementer brief, including requirements, source context, write
allowlist, selected Tests, and environment-derived authorized checks with policy omissions.
For defects, require the implementer's Defect-Fix Protocol and scope the entire defect class.
If investigation exceeds the small-fix boundary, route the whole change through PARTIAL.
Done when the authorized fix has an implementation report or a planning prerequisite.

Have code-quality check the actual diff against the request and preserved behavior.
Keep the Phase 2 test timing: acceptance checks first, then the Phase 5 final check under
the selected policy before Phase 6. Supply the request and dispatch evidence when there
is no new plan; retain file history in the completion report instead of editing an archive.
Done when validation supports completion or attributed failures return for correction.

## Partial Continuation

Run Phase 1 at the selected breadth using `DIRECT_CALLER` and DISCOVERY.md's existing findings;
route requirement changes through Phase 0's analyst. Pass the dated delta for persistence
through Phase 2's Discovery Companion handoff. Dispatch task-planner `AMEND_PLAN append-phase` per corvus-phase-7 §AMEND_PLAN Dispatch
with the active plan path, phase title, and task lines; resolve its target via Preserve the Source.
Done when the additional scope has a coherent plan, durable discovery, and a passing preservation check.

Use [Phase 2](../corvus-phase-2/SKILL.md) for whole-plan re-review and the approval gate,
then Phase 4 through Phase 6 for the new work. A material divergence returns to planning.
Done when the continuation is approved, implemented, and validated, or a named blocker holds it.

## AMEND_PLAN Dispatch

Use task-planner's AMEND_PLAN input and preservation contract; for add-fix-tasks, identify the phase in Payload.
```markdown
**TASK**: Amend the plan for <requested continuation or fixes>.
**MODE**: AMEND_PLAN
**Operation**: append-phase | add-fix-tasks | copy-forward
**Repository**: <canonical root>
**Plan**: <PLAN.md path; target or new directory for copy-forward>
**Source**: <legacy dir | completed-plan dir | gate/implementation report pointer | n/a>
**Payload**: <phase title + task lines | task lines>
**Report Back**: changed-line manifest + preservation result
```

## Full Restart

Acknowledge the prior feature as complete and start [Phase 0](../corvus-phase-0/SKILL.md)
for the new feature. Have task-planner create its own PLAN.md through Phase 2; earlier
findings are context, not inherited approval.
Done when the new feature has entered the normal workflow with a separate plan destination.

## External Review Remediation

Use [review remediation](remediation.md) for empirical verification, defect-class scope,
and the `REMEDIATION_LEDGER` hard gate before every remediation dispatch. The ledger is
review-series evidence, separate from the plan, and remains continuous across copy-forward.

Use **REVIEW-FIX ROUND MODE** for self-contained findings or complete defect classes with
an established fix shape, approximately three files or fewer each, and no API, security,
architecture, or product-design decision. After the ledger admits action, dispatch directly
to code-implementer with the verified contract and exact ownership, then code-quality;
the mode adds no planning ceremony. Larger or uncertain classes take PARTIAL or FULL.
Done when each finding is routed with lineage, validation, and a disposition obligation.

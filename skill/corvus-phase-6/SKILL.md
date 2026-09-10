---
name: corvus-phase-6
description: Completion - success extraction and final summary
---

# Phase 6: Completion

Use [Phase 5](../corvus-phase-5/SKILL.md)'s final evidence before recording completion.
Test semantics remain in [Phase 2 Tests](../corvus-phase-2/SKILL.md#tests).
Direct follow-up fixes without a new plan use 6b with the request and dispatch report;
their completed source plan stays read-only, and feature-level extraction is not repeated.

## 6a: Success Extraction

Have task-planner record final completion through its
PROGRESS_UPDATE mode, supplying the final
gate outcomes and evidence. Read back the completed PLAN.md and preserve its history.
Done when required final outcomes and completion are recorded, or missing evidence holds closure.

Dispatch task-planner once for the entire feature:

```markdown
**MODE**: SUCCESS_EXTRACTION
**Repository**: <canonical user-repository root>
**Plan**: <completed PLAN.md path>
**Feature**: <name and date>
**Final Evidence**: <Phase 5 outcomes, actual command output, policy omissions>
**Process Evidence**: <dispatch history from Log, review/fix history, phase reports>
**REPORT BACK**: New Corvus-process learnings and their evidence, or no new learning;
product-decision candidates requiring separate Decision Records handling.
```

Use the planner's SUCCESS_EXTRACTION mode:
`.corvus/tasks/learnings.md` holds Corvus-PROCESS learnings only. Product decision
rationale belongs in the user's repository ADRs at `docs/decisions/`; route candidates
separately to task-planner under its three-condition Decision Records gate.
That planner procedure owns record creation; extraction itself writes only learnings.
Done when qualifying process learnings are recorded once or explicitly absent, and product
decision candidates have a separate disposition rather than leaking into the learnings file.

## 6b: Final Summary

Derive the summary from the current diff, PLAN.md's Log, and final validation evidence.
Group changed files by role, retain task → dispatch → path history, and report checks as
actually run or omitted by policy. If artifacts change after validation, return affected
evidence to Phase 5 before claiming completion.

```markdown
## Implementation Complete
**Feature**: <name>
**Depth**: <selected effort and reason>
**Plan**: <PLAN.md location>

### Outcome
<What was delivered; acceptance outcome and any remaining limitations.>

### Files Changed by Role
| Role | Files and Actions | Outcome |
|------|-------------------|---------|
| <product / tests / docs / configuration> | <created, modified, removed paths> | <summary> |

### Dispatch History
<Task → dispatch → resolved file ownership, from the plan's Log.>

### Validation Evidence
<Final gate outcomes; exact commands with actual output or evidence pointers;
policy-based omissions; acceptance evidence; non-blocking recommendations.>

### Hand-offs
<User-owned delivery steps, prepared review replies and dispositions when applicable,
pending actions and limitations; follow-up suggestions with Phase 7 routing.>
```

Prepare delivery instructions for the user; agents never publish, push, or merge.
<!-- Delivery stays user-owned because publication and remote mutations affect other users. -->
For review remediation, use [finding disposition](../corvus-phase-7/remediation.md#finding-disposition)
to distinguish prepared replies from verified posted replies; keep pending actions visible.
Done when the user has an evidence-backed summary and explicit hand-offs; follow-up requests
enter [Phase 7](../corvus-phase-7/SKILL.md).

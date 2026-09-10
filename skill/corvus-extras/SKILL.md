---
name: corvus-extras
description: Extra utilities - subagent reference, todo patterns, error handling
---

# Corvus Extras

Use this reference to choose a specialist, track milestones, and route errors. Load the
owning phase skill for workflow contracts and dispatch templates.

## Subagent Reference

| Agent | Purpose | Contract Owner |
|-------|---------|----------------|
| corvus | Interactive workflow; primary entry point | corvus agent |
| corvus-auto | Autonomous workflow; primary entry point | corvus-auto agent |
| requirements-analyst | Requirements and decision questions | [Phase 0](../corvus-phase-0/SKILL.md) |
| researcher | External technical evidence | [Phase 1](../corvus-phase-1/SKILL.md) |
| code-explorer | Repository evidence and environment discovery | [Phase 1](../corvus-phase-1/SKILL.md) |
| task-planner | Adaptive plan, decision records, progress and learning updates | task-planner modes |
| plan-reviewer | Cross-model whole-plan review | [Phase 2](../corvus-phase-2/SKILL.md) |
| code-implementer | Approved production changes and scoped validation | [Phase 4](../corvus-phase-4/SKILL.md) |
| code-quality | Objective acceptance and validation | [Phase 4](../corvus-phase-4/SKILL.md), [Phase 5](../corvus-phase-5/SKILL.md) |
| ux-dx-quality | Subjective UX, DX, docs, architecture assessment | [Phase 5](../corvus-phase-5/SKILL.md) |
| corvus-review | Interactive PR review; primary entry point | corvus-review agent |
| corvus-review-auto | Autonomous PR review; primary entry point | corvus-review-auto agent |
| pr-context-gatherer | PR evidence and conventions | [R1](../corvus-review-r1/SKILL.md) |
| pr-code-reviewer | Read-only PR code detection | [R2](../corvus-review-r2/SKILL.md) |
| security-reviewer | Read-only security detection | [R2](../corvus-review-r2/SKILL.md) |
| pr-comment-writer | Authorized GitHub review posting | [R5](../corvus-review-r5/SKILL.md) |

Invoke specialists through the Task tool with the selected `subagent_type`; primary agents
are entry points. Batch independent calls in one message, using the owning skill's payload.
Review schemas belong to [corvus-review-extras](../corvus-review-extras/SKILL.md).
Done when the request reaches its owner with that owner's required context.

## Todo Patterns

<!-- adapted from mattpocock/skills (MIT) -->
Track phase milestones with TodoWrite, keeping detailed tasks in PLAN.md. Set a phase
`in_progress` when it starts and `completed` only after its closing evidence; represent
waiting prerequisites as `pending`. Reflect routing changes rather than adding a todo
for every tool call. Use the current tool schema, for example:

```text
Discovery — completed
Implementation Phase 1 — in_progress
Final Validation — pending
```

Persistent progress belongs to [Phase 4c](../corvus-phase-4/SKILL.md#4c-record-one-phase-boundary).
Done when visible todos agree with the current evidenced workflow position.

## Error Handling

Capture the failing operation, actual error, impact, task/phase, attempted recovery, and
remaining prerequisite; then use the owner rather than inventing another retry loop:

| Failure | Route |
|---------|-------|
| In-task implementation/check failure | code-implementer modes |
| Phase acceptance failure | [Phase 4 Failure Routing](../corvus-phase-4/SKILL.md#failure-routing) |
| Empty, truncated, or malformed child output | [Transport recovery](../corvus-phase-4/reference/transport-retry.md) |
| Final objective or subjective failure | [Phase 5](../corvus-phase-5/SKILL.md) |
| Material divergence or wrong approach | [Planning and approval](../corvus-phase-2/SKILL.md) |
| Follow-up remediation | [Phase 7](../corvus-phase-7/SKILL.md) |

For a fundamental approach issue, supply evidence, viable alternatives with trade-offs,
and a recommendation to the caller; it owns the next decision and any user interaction.
Done when recovery reaches its owning workflow or the caller has a precise blocked report.

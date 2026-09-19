---
name: corvus-phase-0
description: Requirements analysis phases (0a initial, 0b post-discovery)
---

# Phase 0: Requirements

Orchestrate requirements-analyst; its Analysis
Workflow owns grilling, statuses, immutable requirements, and effort proposals.

## Clarification Ownership

The analyst is non-interactive and returns the whole question batch as data. Resolve it
through the caller, preserving IDs, order, and recommendations:

| Caller | Batch Resolution |
|--------|------------------|
| Interactive `corvus` | Put the whole batch in one `question()` call; return `ANSWERS_BY_ID`, using recommendations as `ASSUMPTIONS_BY_ID` for unavailable answers. |
| `corvus-auto` | Record recommended answers as `ASSUMPTIONS_BY_ID`; keep interaction disabled. |

The caller owns a maximum of 3 clarification rounds shared across 0a and 0b. Start at
round 1, advance after each resolved batch, and re-invoke the same analysis mode with
answers and assumptions. Resolve round 3's unanswered items to recommendations and set
`FINAL_ROUND_RESOLVED: true`; preserve that closed state through later discovery.
<!-- Round oracle: caller-maintained count, resolved batches, and closure flag, read before each analyst dispatch. Closure permits recorded assumptions rather than another question round; unresolved facts still route to discovery. Neither mode changes nor either caller resets it. -->
If round state is missing, close clarification with recorded recommendations and `FINAL_ROUND_RESOLVED: true`; use available analysis after [bounded report recovery](../corvus-phase-4/reference/transport-retry.md). Done when resolved answers or assumptions accompany the next handoff.

## Discovery Origin Contract

Use [Phase 1's routing envelope](../corvus-phase-1/SKILL.md#required-dispatch-envelope):
`PHASE_0A` returns to `PHASE_0B`; `DIRECT_CALLER` returns to the original caller.
For analyst-requested discovery, preserve the former route through every additional pass.
Send accumulated findings as `EXISTING_FINDINGS` and only unresolved facts as the scope.
Done when findings return to their declared target with clarification round state intact.

## Spec-Completeness Bypass

Apply corvus's Phase 0: Clarification bypass criteria before 0a; uncertainty takes
the normal analyst route. For a qualifying request, select the caller's depth proposal via
task-planner's Plan Format, preserving a supplied user choice,
then run Phase 1 with `DIRECT_CALLER`. The bypass skips clarification, not discovery;
return here for Depth and Tests Resolution. Preserve the supplied requirements and add
`requirements-analyst: skipped (spec-complete)` to the
Phase 2 input. Record reversible recommendations for new gaps as assumptions; immutable requirements stay unchanged.
<!-- Bypass oracle: request evidence against the caller's criteria, read before skipping 0a. Missing evidence keeps analysis enabled for either caller; only all criteria permit bypass. -->
Done when discovery is available and the analyst skip is visible to planning and review.

## Phase 0a: Initial Clarification

Dispatch requirements-analyst with the original request and accumulated analysis:

```markdown
**MODE**: INITIAL_ANALYSIS
**USER REQUEST**: <original request>
**ROUND**: <caller-owned 1, 2, or 3>
**ANSWERS_BY_ID / ASSUMPTIONS_BY_ID**: <separate maps, or none>
**FINAL_ROUND_RESOLVED**: <true or false>
**PRIOR ANALYSIS**: <requirements, assumptions, waiting decisions, or none>
**REPORT BACK**: Use your Output Format, including status and Depth proposal.
```

On `QUESTIONS_NEEDED`, use Clarification Ownership; carry independent factual requests
alongside the batch. On `DISCOVERY_NEEDED`, dispatch the requested scope to Phase 1.
On `REQUIREMENTS_CLEAR`, carry the proposed depth into Phase 1 for repository grounding.
Both discovery paths use `PHASE_0A` → `PHASE_0B`.
Done when a batch is resolved or discovery transfers control toward Phase 0b.

## Phase 0b: Post-Discovery Clarification

For a `PHASE_0A` return, dispatch requirements-analyst with the accumulated payload:

```markdown
**MODE**: POST_DISCOVERY
**USER REQUEST**: <original request>
**ROUND**: <same caller-owned count>
**ANSWERS_BY_ID / ASSUMPTIONS_BY_ID**: <separate accumulated maps, or none>
**FINAL_ROUND_RESOLVED**: <preserved closure flag>
**DISCOVERY FINDINGS**: <accumulated findings, competing work, unresolved facts>
**PRIOR ANALYSIS**: <requirements, assumptions, waiting decisions>
**REPORT BACK**: Use your Output Format; identify only the remaining discovery delta.
```

On `QUESTIONS_NEEDED`, resolve the batch. On `DISCOVERY_NEEDED`, investigate only the delta through Phase 1, then re-enter 0b; if facts remain unavailable, proceed with explicit gaps, not invented facts. On `REQUIREMENTS_CLEAR`, proceed below.
Done when available requirements and assumptions reach planning with factual gaps noted.

## Depth and Tests Resolution

Adopt the analyst's `**Depth**` proposal and reason, or the bypass caller's proposal,
preserving a supplied user choice. Depth is an effort dial; use
[Phase 1's breadth policy](../corvus-phase-1/SKILL.md#discovery-breadth), including narrow
quick discovery and wider deep discovery. Refresh only uncovered scope if depth changes.
The interactive user may override depth at Phase 3.

Resolve Tests through [Phase 2 Tests](../corvus-phase-2/SKILL.md#tests), using the caller's
Depth and Test Inputs section for provenance handling. Carry the selected value forward.
If apparatus far exceeds the stated scope, confirm with the user (corvus-auto halts and reports).
Pass immutable requirements, assumptions, depth, Tests, and available discovery to
Phase 2, preserving competing in-flight work and surfacing it to the interactive user first.
Done when Phase 2 has available inputs and explicit unresolved prerequisites.

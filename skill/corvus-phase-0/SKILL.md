---
name: corvus-phase-0
description: Requirements analysis phases (0a initial, 0b post-discovery)
---

## Clarification Ownership

Requirements Analyst is a non-interactive producer. It returns one complete `QUESTIONS_NEEDED` batch; it never presents questions or waits for answers. The calling orchestrator owns resolution:

| Caller | Batch handling |
|--------|----------------|
| Interactive `corvus` | Put every batch item into one `question()` tool call, preserve question IDs/order/defaults, then re-invoke the same analysis mode with `ANSWERS_BY_ID`. It owns the maximum of 3 clarification rounds. |
| `corvus-auto` | For every batch item, record the recommended/default answer in `ASSUMPTIONS_BY_ID`, then re-invoke the same analysis mode. It never calls `question()` or delegates interaction to a child. |

Neither this skill nor Requirements Analyst becomes the user-facing question owner. On the final caller-owned round, resolve unanswered items to their defaults and set `FINAL_ROUND_RESOLVED: true` for re-analysis.

## Discovery Origin Contract

Every Phase 1 dispatch carries both fields below; the receiver returns to exactly the supplied target:

| `DISCOVERY_ORIGIN` | `RETURN_TARGET` | Completion route |
|--------------------|-----------------|------------------|
| `PHASE_0A` | `PHASE_0B` | Requirements Analyst in `POST_DISCOVERY`, then plan selection or direct delegation |
| `DIRECT_CALLER` | `[original caller]` | Return findings to that caller; no implicit planning |

Phase 0a always uses `DISCOVERY_ORIGIN: PHASE_0A`. Additional discovery requested by Phase 0b preserves that origin and return target. Pass accumulated findings as `EXISTING_FINDINGS` so Phase 1 investigates only the unresolved delta.

## Spec-Completeness Bypass (Pre-0a)

The orchestrator may skip the Phase 0a dispatch entirely when ALL criteria of its `spec_completeness_bypass` rule hold (the orchestrator rule owns the criteria — apply it as written there; any doubt means dispatching Phase 0a normally). When skipped, control proceeds directly to Plan Selection and Direct Routing below, and the Phase 2 task-planner dispatch must record `requirements-analyst: skipped (spec-complete)` so plan-reviewer knows the analyst never ran.

## Phase 0a: INITIAL CLARIFICATION

**Goal**: Analyze the request and determine whether clarification is needed before discovery.

**DELEGATE TO**: @requirements-analyst

```markdown
**TASK**: Analyze user request for completeness

**MODE**: INITIAL_ANALYSIS

**USER REQUEST**: [paste the user's original request]

**ROUND**: [1/2/3] (caller-owned; shared across Phase 0a and 0b)
**ANSWERS_BY_ID / ASSUMPTIONS_BY_ID**: [map from the caller, or "none"]
**FINAL_ROUND_RESOLVED**: [true/false]

**MUST DO**:
- Analyze request for outcome clarity, scope, and constraints
- Return exactly REQUIREMENTS_CLEAR, QUESTIONS_NEEDED, or DISCOVERY_NEEDED
- On QUESTIONS_NEEDED, return one complete ordered batch with ID, priority, text, closed-ended options when applicable, recommended/default answer, and why it blocks

**MUST NOT DO**:
- Modify files
- Interact with the user or present questions
- Split a known question batch across responses

**REPORT BACK**:
- Status: REQUIREMENTS_CLEAR / QUESTIONS_NEEDED / DISCOVERY_NEEDED
- If QUESTIONS_NEEDED: Complete ordered question batch
- If DISCOVERY_NEEDED: Specific discovery scope and questions
- Summary of confirmed requirements
```

### Flow Control After Phase 0a

| Status | Action |
|--------|--------|
| `REQUIREMENTS_CLEAR` | Continue to plan selection/direct routing below |
| `QUESTIONS_NEEDED` | Caller resolves the complete batch per Clarification Ownership, then re-invokes Phase 0a with the answer/assumption map |
| `DISCOVERY_NEEDED` | Invoke Phase 1 with `DISCOVERY_ORIGIN: PHASE_0A` and `RETURN_TARGET: PHASE_0B`; on return, invoke Phase 0b before any selection or planning |
| *(not dispatched)* | Spec-complete bypass (orchestrator rule `spec_completeness_bypass`): skip 0a/0b and continue to plan selection; record the skip in the Phase-2 dispatch |

**Exit Criteria**: Requirements are clear, or the origin-tagged discovery dispatch has transferred control to Phase 1.

---

## Phase 0b: POST-DISCOVERY CLARIFICATION

**Goal**: Analyze accumulated Phase 1 findings before any plan selection or direct route.

**When**: Phase 1 returns a dispatch whose `DISCOVERY_ORIGIN` is `PHASE_0A` and whose `RETURN_TARGET` is `PHASE_0B`. A direct discovery return does not enter Phase 0b.

**DELEGATE TO**: @requirements-analyst

```markdown
**TASK**: Analyze discovery findings for additional questions

**MODE**: POST_DISCOVERY
**DISCOVERY_ORIGIN**: PHASE_0A

**ORIGINAL REQUEST**: [user's original request]

**DISCOVERY FINDINGS**: [all accumulated findings from Phase 1]
- Files to modify: [list]
- Patterns found: [list]
- Constraints discovered: [list]
- Technologies involved: [list]

**ROUND**: [1/2/3] (caller-owned; continues from Phase 0a)
**ANSWERS_BY_ID / ASSUMPTIONS_BY_ID**: [map from the caller, or "none"]
**FINAL_ROUND_RESOLVED**: [true/false]

**MUST DO**:
- Analyze whether discovery revealed new questions, pattern conflicts, or integration constraints
- Return exactly REQUIREMENTS_CLEAR, QUESTIONS_NEEDED, or DISCOVERY_NEEDED
- On QUESTIONS_NEEDED, return one complete ordered batch using the Phase 0a field contract
- On DISCOVERY_NEEDED, identify only the unresolved discovery delta

**MUST NOT DO**:
- Modify files or interact with the user
- Re-ask answered questions
- Request research or code exploration already present in DISCOVERY FINDINGS

**REPORT BACK**:
- Status: REQUIREMENTS_CLEAR / QUESTIONS_NEEDED / DISCOVERY_NEEDED
- Complete question batch or additional discovery delta, when applicable
- Updated requirements and assumptions
```

### Flow Control After Phase 0b

| Status | Action |
|--------|--------|
| `REQUIREMENTS_CLEAR` | Continue to plan selection/direct routing below; reuse the accumulated findings |
| `QUESTIONS_NEEDED` | Caller resolves the complete batch per Clarification Ownership, then re-invokes Phase 0b with the answer/assumption map |
| `DISCOVERY_NEEDED` | Re-invoke Phase 1 with `DISCOVERY_ORIGIN: PHASE_0A`, `RETURN_TARGET: PHASE_0B`, accumulated `EXISTING_FINDINGS`, and only the new scope; then return to Phase 0b |

Limit additional Phase 0b discovery passes to 2. At the cap, document unresolved discovery as assumptions, complete Phase 0b, and continue to plan selection/direct routing; never jump from the cap directly to Phase 2.

## Plan Selection and Direct Routing

This step runs after `REQUIREMENTS_CLEAR` from Phase 0a or Phase 0b, or directly via the Spec-Completeness Bypass (Pre-0a). The orchestrator owns interactive, autonomous, and preselected input handling.

Before selecting a planned route, compare proposed apparatus with the user's
stated scope. For disagreement/drift findings, evaluate deletion of one duplicate
representation first. If apparatus still projects beyond roughly 10x the stated
scope, route to the orchestrator's scope-amplification gate: interactive Corvus
asks for explicit confirmation; Corvus Auto halts and reports the mismatch.

| Plan Type | Next route |
|-----------|------------|
| No Plan | Delegate directly to the correct specialist. Do not load Phase 2, invoke task-planner, create a master plan, or ask test preferences. |
| `LIGHTWEIGHT` | Phase 2 with `PLAN_TYPE: LIGHTWEIGHT`; no Phase 1 requirement |
| `STANDARD` | Reuse any completed discovery and enter Phase 2 with `PLAN_TYPE: STANDARD`; do not repeat Phase 1 |
| `SPEC_DRIVEN` | Reuse completed discovery. If discovery has not run, invoke Phase 1 once with `DISCOVERY_ORIGIN: DIRECT_CALLER` and return to the orchestrator before Phase 2. |

A Phase 1 result is consumed once: Phase 0a-origin findings feed Phase 0b and then the selected route; direct findings return to their caller. Neither route authorizes Phase 1 to invoke planning.

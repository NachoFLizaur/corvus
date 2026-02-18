---
name: corvus-phase-0
description: Requirements analysis phases (0a initial, 0b post-discovery)
---

## Phase 0a: INITIAL CLARIFICATION

**Goal**: Analyze request and determine if clarification is needed before discovery.

**DELEGATE TO**: @requirements-analyst

```markdown
**TASK**: Analyze user request for completeness

**MODE**: INITIAL_ANALYSIS

**USER REQUEST**:
[Paste the user's original request]

**ROUND**: [1/2/3] (track across invocations)

**MUST DO**:
- Analyze request for outcome clarity, scope, constraints
- Identify critical gaps that block implementation
- Return structured status: REQUIREMENTS_CLEAR, QUESTIONS_NEEDED, or DISCOVERY_NEEDED
- If QUESTIONS_NEEDED, batch all questions with priority tiers

**MUST NOT DO**:
- Modify any files
- Ask questions one at a time
- Exceed 3 clarification rounds

**REPORT BACK**:
- Status: REQUIREMENTS_CLEAR / QUESTIONS_NEEDED / DISCOVERY_NEEDED
- If QUESTIONS_NEEDED: Formatted questions with [N/M] progress and priority tiers
- If DISCOVERY_NEEDED: Specific discovery scope and questions
- Summary of confirmed requirements
```

### Flow Control After Phase 0a

| Status | Action |
|--------|--------|
| `REQUIREMENTS_CLEAR` | **→ Plan-Type Selection** — Present recommendation via Question tool, then route by selection |
| `QUESTIONS_NEEDED` | Present questions to user, then re-invoke Phase 0a with answers |
| `DISCOVERY_NEEDED` | Proceed to Phase 1 with targeted discovery scope, then Phase 0b |

**Plan-Type Selection**: After REQUIREMENTS_CLEAR, Corvus extracts the "Plan-Type Recommendation" 
from requirements-analyst output and presents it to the user via the Question tool. 
See `agent/corvus.md` "Plan-Type Selection" section for the full interaction flow.

**Routing by Plan Type**:
| Plan Type | Next Phase |
|-----------|------------|
| No Plan | Direct delegation (skip workflow) |
| Lightweight | Phase 2 with `PLAN_TYPE: LIGHTWEIGHT` (skip Phase 1) |
| Standard | Phase 1 (if DISCOVERY_NEEDED) → Phase 2 with `PLAN_TYPE: STANDARD` |
| Spec-Driven | Phase 1 → Phase 2 with `PLAN_TYPE: SPEC_DRIVEN` |

### Round Tracking

Track clarification rounds across Phase 0a invocations:
- Start at Round 1
- Increment after each QUESTIONS_NEEDED response
- After Round 3, requirements-analyst will force REQUIREMENTS_CLEAR with defaults

**Exit Criteria**: Status is REQUIREMENTS_CLEAR or DISCOVERY_NEEDED, or Round 3 complete.

---

## Phase 0b: POST-DISCOVERY CLARIFICATION

**Goal**: Analyze discovery findings for additional questions before planning.

**When**: After Phase 1 (Discovery) completes.

**CONDITIONAL**: This phase ONLY runs if Phase 0a returned `DISCOVERY_NEEDED`. If Phase 0a returned `REQUIREMENTS_CLEAR`, skip directly to Phase 2.

**DELEGATE TO**: @requirements-analyst

```markdown
**TASK**: Analyze discovery findings for additional questions

**MODE**: POST_DISCOVERY

**ORIGINAL REQUEST**:
[User's original request]

**DISCOVERY FINDINGS**:
[Summary from Phase 1]
- Files to modify: [list]
- Patterns found: [list]
- Constraints discovered: [list]
- Technologies involved: [list]

**ROUND**: [1/2/3] (continues from Phase 0a if applicable)

**MUST DO**:
- Analyze if discovery revealed new questions
- Check for pattern conflicts or integration questions
- Return structured status
- If user answer introduces new tech, return DISCOVERY_NEEDED

**MUST NOT DO**:
- Modify any files
- Re-ask questions already answered
- Exceed 3 total rounds (combined with Phase 0a)

**REPORT BACK**:
- Status: REQUIREMENTS_CLEAR / QUESTIONS_NEEDED / DISCOVERY_NEEDED
- If QUESTIONS_NEEDED: New questions based on discovery findings
- If DISCOVERY_NEEDED: Additional discovery scope triggered by user answers
- Updated requirements summary
```

### Flow Control After Phase 0b

| Status | Action |
|--------|--------|
| `REQUIREMENTS_CLEAR` | **→ Plan-Type Selection** — Present recommendation via Question tool, then route by selection |
| `QUESTIONS_NEEDED` | Present questions to user, then re-invoke Phase 0b with answers |
| `DISCOVERY_NEEDED` | Return to Phase 1 for additional targeted discovery |

### Discovery Loop Prevention

If Phase 0b returns DISCOVERY_NEEDED:
1. Execute targeted Phase 1 discovery
2. Return to Phase 0b with new findings
3. Track discovery iterations (max 2 additional discoveries)
4. After 2 additional discoveries, force proceed to Phase 2

**Exit Criteria**: Status is REQUIREMENTS_CLEAR, or max discovery iterations reached.

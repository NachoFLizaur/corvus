---
name: corvus-phase-5
description: Final validation - comprehensive objective and subjective checks
---

## Phase 5: FINAL VALIDATION (Two-Step)

**Goal**: Comprehensive check of entire implementation with two-step validation.

Phase 5 has two steps:
- **5a**: Objective validation (code-quality) - ALWAYS runs
- **5b**: Subjective validation (ux-dx-quality) - ONLY if ANY task had `requires_ux_dx_review: true`

### 5a. Comprehensive Objective Check (MANDATORY)

**DELEGATE TO**: @code-quality

```markdown
**TASK**: Final comprehensive validation of [feature name] implementation

**MASTER PLAN**: `.corvus/tasks/[feature]/MASTER_PLAN.md`

**ALL TASK FILES**: `.corvus/tasks/[feature]/*.md`

**MUST DO**:
- Run FULL test suite (not just affected tests)
- Run production build
- Verify ALL acceptance criteria from ALL task files
- Check for consistency across all changes
- Look for any regressions
- Verify no breaking changes to existing functionality

**REPORT BACK**:
- **5a OBJECTIVE GATE STATUS**: PASS / FAIL
- Test results: [N]/[M] passing
- Build status: PASS/FAIL
- Acceptance criteria: [N]/[M] met (list any failures)
- Regressions found: [list or none]
- Any remaining issues (with severity)
```

**Decision Point after 5a**:
- 5a PASS + UX/DX required → Proceed to 5b
- 5a PASS + No UX/DX required → Proceed to Phase 6
- 5a FAIL → Create fix tasks, return to Phase 4

### 5b. Comprehensive Subjective Check (IF REQUIRED)

**WHEN TO INVOKE**: If ANY task in the feature had `requires_ux_dx_review: true`

This aggregates all UX/DX review requirements from individual tasks into a single feature-level review.

**DELEGATE TO**: @ux-dx-quality

```markdown
**TASK**: Final UX/DX review of [feature name] implementation

**MASTER PLAN**: `.corvus/tasks/[feature]/MASTER_PLAN.md`

**TASKS REQUIRING UX/DX REVIEW**:
- Task NN: [name] - [focus area: UI/API/docs/architecture]
- Task NN: [name] - [focus area]

**SCOPE**: All user-facing and developer-facing changes in this feature

**MUST DO**:
- Assess overall user experience quality
- Assess overall developer experience quality
- Assess documentation quality and completeness
- Assess architectural coherence across all changes
- Verify consistency of patterns across the feature

**MUST NOT DO**:
- Re-check objective criteria (already passed in 5a)
- Fix issues directly

**REPORT BACK**:
- **5b SUBJECTIVE GATE STATUS**: PASS / FAIL
- Overall UX assessment
- Overall DX assessment
- Documentation assessment
- Architecture assessment
- Strengths identified
- Issues requiring fixes (if FAIL)
```

**Decision Point after 5b**:
- 5b PASS → Proceed to Phase 6
- 5b FAIL → Create fix tasks, return to Phase 4 (fixes must pass 5a again)

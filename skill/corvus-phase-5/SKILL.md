---
name: corvus-phase-5
description: Final validation - comprehensive objective and subjective checks
---

## Phase 5: FINAL VALIDATION (Two-Step)

**Goal**: Comprehensive check of the entire implementation.

- **5a**: Objective validation (code-quality) — always runs
- **5b**: Subjective validation (ux-dx-quality) — runs only if any task had `requires_ux_dx_review: true`

### Test Flags in Phase 5

Phase 5a's own rows from the flag-combination semantics (full table: corvus-phase-2 skill, Entry Contract (canonical flag table) and Test Scope section):

| Flags | Phase 5a behavior |
|-------|-------------------|
| `tests_enabled: true, tests_deferred: false` | Run the full test suite (`test_scope: full`) — the feature's single full-suite run, owned by code-quality (not just affected tests) |
| `tests_enabled: true, tests_deferred: true` | Run the full test suite (`test_scope: full`) — the feature's single full-suite run, owned by code-quality, and the first test execution in deferred mode (tests were deferred during Phase 4); report it clearly as the deferred test run |
| `tests_enabled: false` | Acceptance-only: production build + acceptance criteria with concrete evidence + regression review via code review; do not run tests or report missing tests as a gap |

The 5a objective gate always produces PASS / FAIL; only its evidence model
differs by flags. The three-valued subjective contract applies only to 5b.

For cross-package changes, fresh full-suite evidence requires a cache-defeating
run (for example `turbo ... --force`). Cached task replays must be labeled
`CACHED REPLAY` and cannot be represented as the Phase 5 full-suite execution.

### 5a. Comprehensive Objective Check (always runs)

**DELEGATE TO**: @code-quality

```markdown
**TASK**: Final comprehensive validation of [feature name] implementation

**MASTER PLAN**: `.corvus/tasks/[feature]/MASTER_PLAN.md`

**ALL TASK FILES**: `.corvus/tasks/[feature]/*.md`

**CONTEXT FILE**: `.corvus/tasks/[feature]/CONTEXT.md` (discovery context — read when present; may be absent on legacy plans)

**TEST SCOPE**: `test_scope: [full|none]` — full when `tests_enabled: true`; none when `tests_enabled: false`

**MUST DO**:
- [Insert the Phase 5a behavior row for the active test flags from the table above]
- For cross-package changes, use the project runner's verified cache-defeating option and label any cached replay honestly
- Run production build
- Verify all acceptance criteria from all task files
- Check consistency across all changes; look for regressions and breaking changes to existing functionality

**REPORT BACK**:
- **5a OBJECTIVE GATE STATUS**: PASS / FAIL
- **Mode**: ACCEPTANCE-ONLY when `tests_enabled: false`; DEFERRED TEST RUN (first test execution) when `tests_deferred: true`; omit otherwise
- Test results: [N]/[M] passing (omit in acceptance-only mode)
- Build status: PASS/FAIL
- Acceptance criteria: [N]/[M] met (list failures; include concrete evidence in acceptance-only mode)
- Regressions found: [list or none]
- Remaining issues (with severity)
```

**Decision Point after 5a**:
- PASS + UX/DX required → Proceed to 5b
- PASS + no UX/DX required → Proceed to Phase 6
- FAIL → Create fix tasks, return to Phase 4 (fix dispatches carry `test_scope: targeted`); re-verification is ONE full 5a re-run, within the iteration cap

### 5b. Comprehensive Subjective Check (if required)

**WHEN TO INVOKE**: If any task in the feature had `requires_ux_dx_review: true`. This aggregates the per-task UX/DX review requirements into a single feature-level review.

**DELEGATE TO**: @ux-dx-quality

```markdown
**TASK**: Final UX/DX review of [feature name] implementation

**MASTER PLAN**: `.corvus/tasks/[feature]/MASTER_PLAN.md`

**CONTEXT FILE**: `.corvus/tasks/[feature]/CONTEXT.md` (discovery context — read when present; may be absent on legacy plans)

**TASKS REQUIRING UX/DX REVIEW**:
- Task NN: [name] - [focus area: UI/API/docs/architecture]

**SCOPE**: All user-facing and developer-facing changes in this feature

**MUST DO**:
- Assess user experience, developer experience, documentation quality, and architectural coherence
- Verify consistency of patterns across the feature
- Apply the exact 5b verdict semantics below and support the verdict with scored evidence
- Treat any discovered unmet immutable acceptance criterion, security failure, or critical usability failure as a blocking issue regardless of numeric score

**MUST NOT DO**:
- Re-check objective criteria (already passed in 5a)
- Fix issues directly
- Substitute a binary failure label for the three-valued 5b status

**REPORT BACK (exact contract)**:

Emit `5b SUBJECTIVE GATE STATUS` exactly once with one allowed bare-token value,
then use the canonical @ux-dx-quality report schema:

- **5b SUBJECTIVE GATE STATUS**: <one allowed value>
- **Scored Evidence**: score, status, and concrete evidence for every required UX, DX, documentation, and architecture dimension; mark an out-of-scope dimension N/A with a reason
- **Top 3 Strengths**: evidence-backed strengths
- **Blocking Issues**: issue, evidence, and required fix, or `None`
- **Non-Blocking Recommendations**: recommendation, evidence, and expected benefit, or `None`
- **Detailed Assessments**: the applicable mode-specific assessments
```

The only accepted 5b values and meanings are:

- `PASS`: all required dimensions meet the pass threshold.
- `NEEDS_IMPROVEMENT`: recommendations are non-blocking; there is no unmet immutable acceptance criterion, security failure, or critical usability failure.
- `CRITICAL_ISSUES`: blocking subjective issues require fixes.

**Decision Point after 5b**:
- `PASS` → Proceed to Phase 6.
- `NEEDS_IMPROVEMENT` → Record the non-blocking recommendations as inputs to
  Phase 6's final output and feature-level learnings, then proceed to Phase 6.
  If any recommendation exposes an unmet immutable acceptance criterion, reject
  the non-blocking classification and use the `CRITICAL_ISSUES` fix path.
- `CRITICAL_ISSUES` → Create tasks scoped to the reported Blocking Issues,
  return to Phase 4 for implementation, then rerun both 5a and 5b.
- Missing or unknown status → Fail closed as a blocking producer/consumer
  contract error. Do not proceed to Phase 6; re-invoke 5b for a conforming
  result and escalate if the contract remains invalid.

Phase 5 records recommendations but does not perform success extraction; Phase
6 alone owns `SUCCESS_EXTRACTION`.

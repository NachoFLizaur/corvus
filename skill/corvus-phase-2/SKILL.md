---
name: corvus-phase-2
description: Planning (Phase 2), User Approval (Phase 3), and optional High Accuracy Plan Review (Phase 3.5)
---

## Phase 2: PLANNING (PLANNED WORK ONLY)

**Goal**: Create comprehensive master plan and task files for work that has explicitly selected a planned plan type.

### Entry Contract

Phase 2 accepts exactly `PLAN_TYPE: LIGHTWEIGHT | STANDARD | SPEC_DRIVEN`. `No Plan` is a direct-delegation result, not a Phase 2 input: do not load this skill, invoke task-planner, create `MASTER_PLAN.md`, or collect test preferences for that route.

The orchestrator resolves this complete input tuple before task-planner delegation:

```markdown
**PLAN_TYPE**: [LIGHTWEIGHT | STANDARD | SPEC_DRIVEN]
**TEST PREFERENCE**: `tests_enabled: [true/false], tests_deferred: [true/false]`
```

Input ownership rules:

1. Consume every valid preselected value as supplied. Never ask again for `PLAN_TYPE`, `tests_enabled`, or `tests_deferred` when that value is already present.
2. Interactive `corvus` asks only for values still missing after deterministic normalization, then enters Phase 2 with the complete tuple.
3. `corvus-auto` resolves the plan type from the heuristic and supplies both fixed test flags before entry. It never asks a question or delegates a question to task-planner, Requirements Analyst, or another child.
4. The phase skill and task-planner consume resolved inputs; they do not own plan/test-preference questions.

Deterministic normalization for partial preselection:
- `tests_enabled: false` implies `tests_deferred: false`; no timing question is needed.
- `tests_deferred: true` implies `tests_enabled: true`; no generation question is needed.
- If `tests_enabled: true` is supplied without `tests_deferred`, interactive Corvus asks only for test timing.
- If `tests_deferred: false` is supplied without `tests_enabled`, interactive Corvus asks only whether tests are enabled.
- Reject the contradictory pair `tests_enabled: false, tests_deferred: true` to the caller for correction; do not invoke task-planner with it.

This table is the canonical flag-combination reference — corvus, corvus-auto, task-planner, and the phase-4/phase-5 skills point here:

| Resolved preference | Flags | Semantics |
|---------------------|-------|-----------|
| "Yes (recommended)" | `tests_enabled: true, tests_deferred: false` | Default. Test tasks generated; task files include test sections; tests run at every Phase 4 quality gate |
| "Yes — at end only" | `tests_enabled: true, tests_deferred: true` | Test tasks and test sections still generated; Phase 4 quality gates run in acceptance-only mode; tests are deferred to Phase 5 final validation |
| "No — skip tests" | `tests_enabled: false, tests_deferred: false` | No test tasks and no test sections in task files; quality gates always run in acceptance-only mode |

Pass the complete resolved tuple to task-planner via the fields in the delegation template below.

### Test Scope (canonical definition)

Every dispatch that may execute tests carries exactly one `test_scope: targeted | full | none` field:

- `test_scope: targeted` — code-implementer dispatches: only tests scoped to that task (its own new/modified test files), including fix iterations. code-quality 4b dispatches: the union of test files created/modified by that phase's tasks, derived from the task files' Tests sections — never "tests related to changed code".
- `test_scope: full` — the entire suite. Only the Phase 5a code-quality dispatch may carry it, with one exception: a Lightweight non-deferred plan has no Phase 5, so its final 4b gate doubles as final validation and is dispatched with `test_scope: full` — the plan's single full run. A Lightweight deferred plan runs Phase 5 (mandatory) and takes its full run there.
- `test_scope: none` — no test execution; acceptance-only evidence.

Precedence (flag semantics dominate): `tests_enabled: false` forces `test_scope: none` on every dispatch — `test_scope: full` can never override it. `tests_deferred: true` forces `test_scope: none` on Phase 4 4a/4b dispatches; deferred phase-test authoring tasks may verify their own authored files immediately before the 5a dispatch, without consuming the full-run budget.

Run-count budget (happy path):

| Plan mode | Happy-path test runs |
|-----------|---------------------|
| Lightweight | 1 full (non-deferred: at the final 4b gate, doubling as final validation; deferred: at Phase 5a) — owned by code-quality |
| Standard / Spec-Driven | P targeted (one per 4b gate, P = phase count) + 1 full (Phase 5a) |
| Deferred (`tests_deferred: true`) | 1 full (Phase 5a — first execution) |
| Tests disabled / audit-only | 0 |

phase-4 (dispatch templates), phase-5 (5a), code-quality, code-implementer, and task-planner consume these semantics; they do not redefine them.

### Create Master Plan

After requirements are clear and any required discovery has returned to its caller, invoke task-planner to create `.corvus/tasks/[feature-name]/MASTER_PLAN.md` (the execution tracking document) plus individual task files with detailed implementation steps. Wait for task-planner to create the actual files, then proceed to Phase 3 — Phase 3 needs real documents to approve, so present task-planner's files, not a verbal plan of your own, and save implementation discussion for Phase 4.

Invoke **task-planner** with the resolved inputs and available context:

```markdown
**TASK**: Create master plan for [feature description]

**PLAN_TYPE**: [LIGHTWEIGHT / STANDARD / SPEC_DRIVEN]
(Resolved before Phase 2; No Plan is not accepted here)

**EXPECTED OUTCOME**:
- Master plan document at `.corvus/tasks/[feature-name]/MASTER_PLAN.md`
- Individual task files at `.corvus/tasks/[feature-name]/NN-task-name.md`
[If SPEC_DRIVEN: - Spec files at `.corvus/tasks/[feature-name]/specs/*.md`]

**USER REQUIREMENTS (IMMUTABLE)**:
[Paste the "User Requirements (Immutable)" section from requirements-analyst output]
Incorporate these into MASTER_PLAN.md and all relevant task files. Do not substitute alternatives unless the user explicitly approves.

**PLAN-TYPE CONTEXT**:
- LIGHTWEIGHT: simplified plan — 1 phase, 3-6 tasks, simplified templates
- STANDARD: full plan — current behavior, no changes
- SPEC_DRIVEN: full plan with mandatory specs layer — formal specs before task files, SHALL/MUST language, Given/When/Then acceptance criteria

**TEST PREFERENCE**: `tests_enabled: [true/false], tests_deferred: [true/false]` (resolved before Phase 2; full semantics in the canonical table above)

**CONTEXT FROM RESEARCH**:
[Paste summary of researcher findings, or "N/A - no external research needed"]

**CONTEXT FROM CODE EXPLORATION**:
[Paste summary of code-explorer findings]
- Files to modify: [list]
- Patterns to follow: [list]
- Risks identified: [list]

**PROJECT ENVIRONMENT**:
[Paste environment details from code-explorer]
- Virtual environment: [path, e.g., .venv/, venv/]
- Package manager: [npm/pnpm/yarn/pip/poetry]
- Available scripts: [list from package.json or Makefile]
- Command prefix: [e.g., ".venv/bin/python" or "pnpm"]

**MUST DO**:
- Create MASTER_PLAN.md with phases, dependencies, and progress tracking
- Create individual task files with detailed steps and acceptance criteria
- Include validation commands for each task using the project environment above (venv path, package manager) — not bare `python`/`pytest`/`npm`
- Estimate effort for each task and phase
- Group related tasks into logical phases
- Respect `tests_enabled`: generate test tasks only when `true` (regardless of `tests_deferred` — deferred mode still generates test tasks)

**MUST NOT DO**:
- Skip the master plan document
- Create tasks without acceptance criteria or validation commands

**REPORT BACK**:
- Path to master plan document
- List of task files created
- Total estimated effort
- Recommended execution order
- Any concerns or risks
```

### Plan-Type Workflow Notes

The PLAN-TYPE CONTEXT above tells task-planner what to generate; on the orchestrator side:
- **LIGHTWEIGHT**: skip Phase 3.5 (keep it fast) and Phase 5 (phase-level 4b validation is sufficient) — except when `tests_deferred: true`, which makes Phase 5 mandatory (deferred tests must run there)
- **STANDARD**: full multi-phase workflow, no changes
- **SPEC_DRIVEN**: specs are presented alongside MASTER_PLAN.md in Phase 3 for approval; expect higher test coverage

No Plan never reaches these notes because it has already exited through direct delegation.

**Exit Criteria**: Master plan document exists with all task files created.

---

## Phase 3: USER APPROVAL

**Goal**: Get user approval for the MASTER_PLAN.md created in Phase 2.

This section applies to interactive `corvus` planned work. It is the single plan-approval gate. Choosing High Accuracy Review keeps that approved-plan flow inside Phase 3/3.5; post-review choices are continuations of the same gate, not a second approval phase. `corvus-auto` uses its own auto-approval and mandatory-review route without calling `question()`.

**Prerequisites** (verify before proceeding — if any is not met, go back to Phase 2 and invoke task-planner):
- [ ] Phase 2 is complete
- [ ] `.corvus/tasks/[feature]/MASTER_PLAN.md` file exists
- [ ] Individual task files exist in `.corvus/tasks/[feature]/`

Present the created plan to the user in this format:

```markdown
## Implementation Plan Ready

**Feature**: [Name]
**Total Tasks**: [N] tasks across [M] phases
**Estimated Effort**: [X hours/days]

### Phases

| Phase | Name | Tasks | Effort | Description |
|-------|------|-------|--------|-------------|
| 1 | [Name] | [N] | [effort] | [Brief description] |
| ... | | | | |

### Key Changes

**Files to Modify**:
- `[file1]` - [what changes]

**Files to Create**:
- `[file1]` - [purpose]

### Risks & Mitigations
- [Risk 1] - [Mitigation]

### Master Plan Location
`.corvus/tasks/[feature-name]/MASTER_PLAN.md`
```

After presenting the plan summary, call the question tool directly — invoke it with these exact parameters rather than writing the options as text for the user to type:

- question: "Ready to proceed with this plan?"
- header: "Implementation Plan"
- options:
  1. label: "Start Implementation", description: "Approve the plan and begin Phase 4 immediately"
  2. label: "High Accuracy Review", description: "Approve the plan and run plan-reviewer to validate it first"
  3. label: "Request Changes", description: "Go back to planning with feedback"

**Decision Point** (user's selection): "Start Implementation" → Phase 4 · "High Accuracy Review" → Phase 3.5 · "Request Changes" → return to Phase 2 with feedback

**Exit Criteria**: User selects an option via the question tool.

---

## Phase 3.5: HIGH ACCURACY PLAN REVIEW (Optional)

**Goal**: Validate plan quality before implementation begins.

**When**: User chose "High Accuracy Review" after Phase 3 approval (prerequisite: Phase 3 complete).

### Invoke plan-reviewer

**DELEGATE TO**: @plan-reviewer

This is the canonical sender template for the plan-reviewer dispatch. It mirrors plan-reviewer.md's Input Format (the receiver contract) field-for-field — keep the two in sync.

```markdown
**TASK**: Review implementation plan for [feature name]

**MASTER PLAN**: `.corvus/tasks/[feature]/MASTER_PLAN.md`
**TASK FILES**: `.corvus/tasks/[feature]/*.md`

**TESTS_ENABLED**: [true/false] (from the resolved Phase 2 input tuple)
**TESTS_DEFERRED**: [true/false] (from the resolved Phase 2 input tuple)

**PROJECT ENVIRONMENT**:
[Paste environment details from code-explorer]
- Virtual environment: [path, e.g., .venv/, venv/, or "none"]
- Package manager: [npm/pnpm/yarn/pip/poetry or "none"]
- Available scripts: [list from package.json or Makefile, or "none"]
- Command prefix: [e.g., ".venv/bin/python" or "pnpm", or "none"]

**USER REQUIREMENTS**:
[Paste the "User Requirements (Immutable)" section from requirements-analyst output]

**MUST DO**:
- Run 3-pass review (Structural → Completeness & Reference → Adversarial)
- Verify ALL file paths via glob (not spot-check)
- Run weasel word detection via grep
- Check `tests_enabled` compliance
- Verify user requirements traceability
- Detect cross-task file conflicts
- Provide evidence citations for every PASS sub-check
- Render binary OKAY/REJECT verdict

**MUST NOT DO**:
- Modify any files
- Suggest alternative approaches (unless current approach is broken)
- Reject for style preferences
- Cite more than 3 blocking issues
- Claim verification without showing glob/grep output

**REPORT BACK**:
- **PLAN REVIEW GATE STATUS**: OKAY / REJECT
- Sub-checklist results for all 4 criteria (with evidence)
- Weasel word scan results
- Cross-task file conflict table
- User requirements traceability table
- Blocking issues (if REJECT, max 3)
- Non-blocking notes (optional)
```

### Decision Point after Phase 3.5

**If OKAY**:
Present the review summary to the user and ask for confirmation before proceeding:
```markdown
## Plan Review: OKAY ✅

The plan passed high-accuracy review. All criteria met.

**Review Summary**:
[Paste plan-reviewer's summary of the 4 criteria here]

**Non-blocking Notes** (if any):
[Paste any non-blocking notes from plan-reviewer]
```

Then call the question tool directly (do not write the options as text):

- question: "Plan review passed. Ready to begin implementation?"
- header: "Review Complete"
- options:
  1. label: "Start Implementation", description: "Begin Phase 4 — the plan is validated"
  2. label: "Re-run Review", description: "Run the high accuracy review again"

Routing: "Start Implementation" → Phase 4 · "Re-run Review" → Phase 3.5 again

**If REJECT**:
1. Invoke task-planner with rejection feedback:
```markdown
**TASK**: Fix plan based on plan-reviewer feedback
**MODE**: LEARNING
**TRIGGER**: FAILURE_ANALYSIS

**REJECTION FEEDBACK**:
[Paste plan-reviewer's blocking issues here]

**MASTER PLAN**: `.corvus/tasks/[feature]/MASTER_PLAN.md`
**TASK FILES**: `.corvus/tasks/[feature]/*.md`

**MUST DO**:
- Address each blocking issue cited by plan-reviewer
- Update affected task files
- Update MASTER_PLAN.md if needed

**MUST NOT DO**:
- Change completed task statuses
- Rewrite the entire plan (targeted fixes only)
```

2. Present the updated plan to the user:
```markdown
## Plan Updated After Review

The plan-reviewer found [N] blocking issue(s). Task-planner has addressed them:

### Issues Fixed
1. **[Issue title]**: [How it was fixed]
```

Then call the question tool directly (do not write the options as text):

- question: "Plan has been updated based on review feedback. How would you like to proceed?"
- header: "Next Step"
- options:
  1. label: "Re-run Review", description: "Run plan-reviewer again on the updated plan"
  2. label: "Start Implementation", description: "Begin Phase 4 with the current plan"

Routing: "Re-run Review" → Phase 3.5 again · "Start Implementation" → Phase 4

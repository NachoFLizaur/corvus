---
name: corvus-phase-2
description: Planning (Phase 2), mandatory High Accuracy Plan Review (Phase 3.5), and User Approval (Phase 3)
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
- If `tests_enabled: true` is supplied without `tests_deferred`, default to
  `tests_deferred: true`; do not ask a timing question.
- A standalone preselected `tests_deferred: false` defaults missing
  `tests_enabled` to `true`; this preserves the explicit non-deferred plumbing
  path without exposing it as a user-facing option.
- Reject the contradictory pair `tests_enabled: false, tests_deferred: true` to the caller for correction; do not invoke task-planner with it.

This table is the canonical flag-combination reference — corvus, corvus-auto, task-planner, and the phase-4/phase-5 skills point here:

| Source | Flags | Semantics |
|--------|-------|-----------|
| User-facing tests-enabled choice or autonomous default | `tests_enabled: true, tests_deferred: true` | Test tasks and test sections are generated; Phase 4 quality gates run in acceptance-only mode; tests run at Phase 5 final validation |
| User-facing tests-disabled choice | `tests_enabled: false, tests_deferred: false` | No test tasks and no test sections in task files; quality gates always run in acceptance-only mode |
| Explicit preselection only (not offered by any question) | `tests_enabled: true, tests_deferred: false` | Plumbing remains supported: test tasks are generated and the existing non-deferred Phase 4 gate semantics are honored |

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

After requirements are clear and any required discovery has returned to its caller, invoke task-planner to create `.corvus/tasks/[feature-name]/MASTER_PLAN.md` (the execution tracking document) plus individual task files with detailed implementation steps. Wait for task-planner to create the actual files, then proceed automatically to Phase 3.5. Phase 3 needs real reviewed documents to approve, so present task-planner's files and the review outcome, not a verbal plan of your own, and save implementation discussion for Phase 4.

Invoke **task-planner** with the resolved inputs and available context:

```markdown
**TASK**: Create master plan for [feature description]

**PLAN_TYPE**: [LIGHTWEIGHT / STANDARD / SPEC_DRIVEN]
(Resolved before Phase 2; No Plan is not accepted here)

**REQUIREMENTS ANALYSIS**: [completed — summary attached | requirements-analyst: skipped (spec-complete)]

**EXPECTED OUTCOME**:
- Master plan document at `.corvus/tasks/[feature-name]/MASTER_PLAN.md`
- Individual task files at `.corvus/tasks/[feature-name]/NN-task-name.md`
- Discovery context artifact at .corvus/tasks/[feature-name]/CONTEXT.md
[If SPEC_DRIVEN: - Spec files at `.corvus/tasks/[feature-name]/specs/*.md`]

**USER REQUIREMENTS (IMMUTABLE)**:
[Paste the "User Requirements (Immutable)" section from requirements-analyst output]
Incorporate these into MASTER_PLAN.md and all relevant task files. Do not substitute alternatives unless the user explicitly approves.

**PLAN-TYPE CONTEXT**:
- LIGHTWEIGHT: simplified plan — 1 phase, 3-6 tasks, simplified templates
- STANDARD: full plan — current behavior, no changes
- SPEC_DRIVEN: full plan with mandatory specs layer — formal specs before task files, SHALL/MUST language, Given/When/Then acceptance criteria

**TEST PREFERENCE**: `tests_enabled: [true/false], tests_deferred: [true/false]` (resolved before Phase 2; full semantics in the canonical table above)

**CONTEXT FILE**: `.corvus/tasks/[feature-name]/CONTEXT.md`
(task-planner creates it in Stage 4 from the digest below — schema owner: agent/task-planner.md. Downstream dispatches reference it by path instead of re-pasting discovery.)

**DISCOVERY DIGEST**:
- Research: [summary of researcher findings, or "N/A - no external research needed"]
- Files to modify: [list]
- Patterns to follow: [list]
- Risks identified: [list]
- Project environment: [venv, package manager, etc.]

**PROJECT ENVIRONMENT**:
[Paste environment details from code-explorer]
- Virtual environment: [path, e.g., .venv/, venv/]
- Package manager: [npm/pnpm/yarn/pip/poetry]
- Available scripts: [list from package.json or Makefile]
- Command prefix: [e.g., ".venv/bin/python" or "pnpm"]
- Validation-command semantics probe: [exact planning-time probe, working directory, package-manager version, and observed argument-forwarding/filter behavior]

**MUST DO**:
- Create MASTER_PLAN.md with phases, dependencies, and progress tracking
- Create individual task files with detailed steps and acceptance criteria
- Create CONTEXT.md from the DISCOVERY DIGEST (schema: task-planner)
- Read `.corvus/tasks/learnings.md` (when present) and apply relevant entries to task design
- Include validation commands for each task using the project environment above (venv path, package manager) — not bare `python`/`pytest`/`npm`
- Require smoke-test evidence that every targeted-test command actually filters; a nonexistent-file probe (or equivalent) must fail/filter rather than run the whole suite
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

When the spec-completeness bypass skipped Phase 0a, the `**REQUIREMENTS ANALYSIS**` field carries `requirements-analyst: skipped (spec-complete)`, and the Phase 3.5 plan-reviewer dispatch's USER REQUIREMENTS section notes the same skip so plan-reviewer reviews with that knowledge.

### Plan-Type Workflow Notes

The PLAN-TYPE CONTEXT above tells task-planner what to generate; on the orchestrator side:
- **LIGHTWEIGHT**: run mandatory Phase 3.5, then skip Phase 5 because phase-level 4b validation is sufficient — except when `tests_deferred: true`, which makes Phase 5 mandatory (deferred tests must run there)
- **STANDARD**: full multi-phase workflow, no changes
- **SPEC_DRIVEN**: specs are presented alongside MASTER_PLAN.md in Phase 3 for approval; keep test coverage focused on acceptance contracts and meaningful risks

No Plan never reaches these notes because it has already exited through direct delegation.

**Exit Criteria**: Master plan document exists with all task files created.

---

## Phase 3: USER APPROVAL

**Goal**: Get user approval for the reviewed MASTER_PLAN.md and its Phase 3.5 outcome.

This section applies to interactive `corvus` planned work. It is the single plan-approval gate and occurs after the mandatory automatic Phase 3.5 loop. `corvus-auto` auto-approves at Phase 3 without calling `question()`; the review itself is mandatory in both modes.

**Prerequisites** (verify before proceeding — if any is not met, go back to Phase 2 and invoke task-planner):
- [ ] Phase 2 is complete
- [ ] `.corvus/tasks/[feature]/MASTER_PLAN.md` file exists
- [ ] Individual task files exist in `.corvus/tasks/[feature]/`
- [ ] The mandatory Phase 3.5 loop has terminated with `OKAY`, amended `OKAY_WITH_AMENDMENTS`, or an escalated residual blocking list after the second budget-counting `REJECT`

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

### High Accuracy Review Outcome

**Verdict**: [OKAY | OKAY_WITH_AMENDMENTS (applied) | REJECT budget escalated]
**Applied Amendments**: [summary for OKAY_WITH_AMENDMENTS, otherwise NONE]
**Residual Blocking Issues**: [list after the second budget-counting REJECT, otherwise NONE]

### Master Plan Location
`.corvus/tasks/[feature-name]/MASTER_PLAN.md`
```

After presenting the plan summary, call the question tool directly — invoke it with these exact parameters rather than writing the options as text for the user to type:

- question: "Ready to proceed with this reviewed plan?"
- header: "Reviewed Implementation Plan"
- options:
  1. label: "Start Implementation", description: "Approve the reviewed plan and begin Phase 4"
  2. label: "Request Changes", description: "Return to Phase 2 with feedback; the revised plan will be reviewed automatically before this gate reappears"

**Decision Point** (user's selection): "Start Implementation" → Phase 4 · "Request Changes" → return to Phase 2 with feedback, then automatically run Phase 3.5 again before presenting Phase 3

**Exit Criteria**: User selects an option via the question tool.

---

## Phase 3.5: HIGH ACCURACY PLAN REVIEW

**Goal**: Validate plan quality before implementation begins and automatically resolve review findings within a bounded loop.

**When**: Automatically after Phase 2 for every planned feature in both interactive and autonomous modes. It runs before interactive Phase 3 approval, with no question about whether to enter or re-run it.

High Accuracy Review loops automatically—review → PLAN_FIX → re-review—until `OKAY` or `OKAY_WITH_AMENDMENTS`, or until the second `REJECT` escalates the residual blocking list. Do not ask the user a question between iterations.

### Invoke Plan Reviewer

**DELEGATE TO**: @plan-reviewer

This is the canonical sender template for the plan-reviewer dispatch. It mirrors plan-reviewer.md's Input Format (the receiver contract) field-for-field — keep the two in sync.

```markdown
**TASK**: Review implementation plan for [feature name]

**MASTER PLAN**: `.corvus/tasks/[feature]/MASTER_PLAN.md`
**TASK FILES**: `.corvus/tasks/[feature]/*.md`
**CONTEXT FILE**: `.corvus/tasks/[feature]/CONTEXT.md` (discovery context — read when present; may be absent on legacy plans)
**REVIEW ROUND**: [1 | re-review]
**CHANGED-LINES MANIFEST**: [NONE for round 1 | exact manifest returned by PLAN_FIX]
**PREVIOUS REVIEW**: [NONE for round 1 | prior verdict and findings]

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
- Verify ALL file paths without spot-checking: read-tool directory listings for `.corvus/` because glob does not traverse hidden directories; glob for non-hidden product paths
- Run weasel word detection via grep
- Check `tests_enabled` compliance
- Verify user requirements traceability
- Detect cross-task file conflicts
- Provide evidence citations for every PASS sub-check
- Classify every finding as category A, B, or C and render `OKAY`, `OKAY_WITH_AMENDMENTS`, or `REJECT`
- Report category-B and category-C findings exhaustively in round 1
- On re-review, apply the Iteration Contract to the changed-lines manifest

**MUST NOT DO**:
- Modify any files
- Suggest alternative approaches (unless current approach is broken)
- Reject for style preferences
- Cite more than 3 category-A findings or combine defects into omnibus issue groups
- Claim verification without showing read-directory/glob/grep output

**REPORT BACK**:
- **PLAN REVIEW GATE STATUS**: OKAY / OKAY_WITH_AMENDMENTS / REJECT
- Sub-checklist results for all 4 criteria (with evidence)
- Weasel word scan results
- Cross-task file conflict table
- User requirements traceability table
- Blocking issues (category A; if REJECT, at most 3, one defect each)
- Required amendments (category B; exhaustive in round 1)
- Notes (category C; exhaustive in round 1 and non-blocking)
- On re-review: `FIX_LOCATED_REJECT: true|false` with changed-range evidence
```

### PLAN_FIX Dispatch

Dispatch every plan correction to task-planner with `MODE: PLAN_FIX`. `agent/task-planner.md` is the authoritative owner of PLAN_FIX behavior; this skill defines only the sender template.

```markdown
**TASK**: Apply targeted plan-review fixes for [feature name]
**MODE**: PLAN_FIX

**REVIEW VERDICT**: [REJECT | OKAY_WITH_AMENDMENTS]
**BLOCKING FIXES (CATEGORY A)**:
[Paste every listed category-A finding and suggested fix, or NONE]
**REQUIRED AMENDMENTS (CATEGORY B)**:
[Paste every listed category-B finding and amendment, or NONE]

**MASTER PLAN**: `.corvus/tasks/[feature]/MASTER_PLAN.md`
**TASK FILES**: `.corvus/tasks/[feature]/*.md`

**MUST DO**:
- Follow `agent/task-planner.md` §`PLAN_FIX` Mode exactly; it owns the
  correction constraints and output contract

**MUST NOT DO**:
- Change completed task statuses
- Rewrite the entire plan
- Expand beyond the task-planner PLAN_FIX contract

**REPORT BACK**:
- Summary of each applied fix and amendment
- The task-planner PLAN_FIX result
```

### Verdict Handling and Round Budget

- `OKAY`: carry the terminal review summary to the Phase 3 gate.
- `OKAY_WITH_AMENDMENTS`: dispatch PLAN_FIX with every category-B amendment, then carry the terminal review and applied-amendment summary to the Phase 3 gate without re-review.
- First budget-counting `REJECT`: dispatch PLAN_FIX with every listed category-A fix and category-B amendment, then automatically re-invoke plan-reviewer with the changed-lines manifest and previous review. Do not ask the user whether to re-run or start implementation.
- Second budget-counting `REJECT`: apply the round-budget rule below; do not dispatch another fix or enter Phase 4. Interactive `corvus` carries the residual blocking list to its Phase 3 gate for the user's decision.

**Amendment-verification carve-out (exactly once per feature)**: when a re-review's
blocking findings are located exclusively in lines changed by the immediately
previous PLAN_FIX (`FIX_LOCATED_REJECT: true` with range evidence), the first such
verdict does not increment the REJECT budget. Dispatch one scoped PLAN_FIX limited
to those findings, then one further scoped re-review. If that next re-review is
again exclusively fix-located, it increments normally; the carve-out is consumed
and cannot reset. Any blocking finding in unchanged or merely referenced context
increments normally. This is the only exception to the two-REJECT ceiling.

After the second budget-counting REJECT, stop the loop: interactive `corvus` presents the residual blocking list at the Phase 3 gate; `corvus-auto` records the unresolved review, halts the feature, and reports the residual blocking list clearly.

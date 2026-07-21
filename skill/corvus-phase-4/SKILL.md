---
name: corvus-phase-4
description: Implementation loop - per-phase execution with quality gates
---

## Phase 4: IMPLEMENTATION LOOP (Per-Phase)

**Goal**: Execute each phase of the master plan through three milestones — 4a implement, 4b validate, 4c update plan — with quality validation at the phase level.

Get the task list from MASTER_PLAN.md and delegate with task-file paths; code-implementer reads the task files. This keeps your context for coordination instead of duplicating reads.

Phase 4 operates at the **phase level**, not per-task: tasks within a phase are implemented together (parallel where possible) and validated once per phase.

### Per-Phase Flow

```
4a: code-implementer (ALL tasks in phase, parallel where possible)
         │
         ▼
4b: code-quality (mandatory)
    ├── tests_enabled: true, tests_deferred: false  → tests + acceptance criteria
    ├── tests_enabled: true, tests_deferred: true   → acceptance criteria only (tests deferred to Phase 5)
    └── tests_enabled: false                        → acceptance criteria only (no tests)
         │
    ┌────┴────┐
  PASS      FAIL
    │         │
    │         ▼
    │    Iteration 1: code-implementer direct fix (4b failure report, targeted)
    │    Iteration ≥2: task-planner LEARNING (FAILURE_ANALYSIS) → code-implementer fix
    │         │    (fix ONLY failing tasks)
    │         └──► Loop back to 4b (re-run the original 4b dispatch scope)
    │
    ▼
4c: task-planner PROGRESS_UPDATE → verify planning-file diff
    └── Next Phase (or Phase 5 if all implementation phases complete)
```

### Operating Rules

<operating_rules>
  - **Iteration-aware fix loop** (canonical statement of this rule — orchestrators
    and task-planner point here): on a phase's first 4b FAIL (Iteration 1), dispatch
    code-implementer directly with the gate's failure report and task attribution,
    `test_scope: targeted` — no task-planner round-trip. The 4b report already
    attributes failures to tasks; a first fix needs that report, not a second analysis.
    From iteration ≥2, invoke task-planner LEARNING (FAILURE_ANALYSIS) first, then
    dispatch the fix (also `test_scope: targeted`) — a repeated failure signals a root
    cause the report alone did not surface.
  - **Fix only failing tasks**: the gate report attributes every failure to specific
    task(s); leave passing tasks untouched.
  - **Revalidate the phase after any fix** (loop to 4b) — code-quality re-runs the same
    scope as the original 4b dispatch: phase-targeted in the general case, never widening
    to the full suite; the Lightweight non-deferred final gate
    revalidates at its dispatched full scope (its sanctioned re-run).
    This confirms fixes did not break sibling tasks.
  - **Parallelize independent tasks**: tasks with no inter-dependencies (check
    `Parallel With` / `Depends On` metadata and shared files) run concurrently.
  - **Update MASTER_PLAN.md at phase boundaries** (4c), not after each task. After
    a phase-wide 4b PASS, delegate the state transition to task-planner in
    `PROGRESS_UPDATE` mode. Corvus never edits the plan directly.
  - **Max 3 fix iterations per phase**: at the cap, stop and escalate to the user with
    what passed, what still fails, and open questions — even if the phase is incomplete.
  - **Fix-attempt accounting**: code-implementer's in-task 2-attempt fix rule
    (Delegated Mode) does not consume the 4b 3-iteration cap — the cap counts only
    4b FAIL → fix → 4b loops. Only a failure at the gate that carries final validation (Phase 5a — or a Lightweight non-deferred plan's final 4b gate) justifies a full-suite re-run.
</operating_rules>

---

### Phase 4 File, Test, and Validation Ownership

Resolve `tests_enabled` and `tests_deferred` from MASTER_PLAN.md before dispatch.
Classify each row by its explicit task type and enforce its `Files to Change`
manifest as a write allowlist.

| Mode / task type | Writable files and test authoring | Test execution in Phase 4 |
|------------------|-----------------------------------|---------------------------|
| `tests_enabled: true`, implementation task | Product files explicitly listed. Do not author tests unless an obsolete test edit is explicitly in this task's approved manifest. | Only commands explicitly authorized by the active task/workflow. |
| `tests_enabled: true`, phase test task, `tests_deferred: false` | Existing/new test files explicitly listed; author tests and make no production changes. | Runs only the test files this task authored/modified (test_scope: targeted); 4b owns the single phase-targeted gate run. |
| `tests_enabled: true`, phase test task, `tests_deferred: true` | Existing/new test files explicitly listed; author tests and make no production changes. | Never execute tests in 4a or 4b. Phase 5 performs the first test run. |
| `tests_enabled: false` | Product files only. No phase test task or test-file edit exists. | Never execute tests. |

The approved task's validation section is an execution allowlist and may be
narrower than generic agent defaults. A static-only task runs only those static
checks; do not substitute typecheck, build, lint, or test commands it defers or
prohibits. In no-test mode, treat a phase test task as a planning error and return
it for correction rather than dispatching it.

Test-scope edge cases (full semantics: corvus-phase-2 skill, Test Scope section):
a phase with no test task → 4b runs acceptance checks only (`test_scope: none`);
deferred mode → 4a/4b dispatches carry `test_scope: none`, and deferred authoring
tasks may verify their own authored files immediately before the 5a dispatch,
without consuming the single-full-run budget; disabled mode → every dispatch
carries `test_scope: none`.

---

### 4a. Implementation — One Task Per Code-Implementer

One task file = one code-implementer invocation, always. The Task tool runs multiple `task()` calls from a single message concurrently ("use a single message with multiple tool uses" to parallelize), so:

- **Parallel** (independent tasks): multiple `task()` calls in ONE message — each for exactly one task
- **Sequential** (dependent tasks, shared file modifications, output feeding forward): one `task()` call per message; wait for completion between each

**Success criteria for 4a**: every task in the phase dispatched to its own code-implementer using the template below, and every dispatch reported back with validation results.

#### Single-Task Delegation Template

```markdown
**TASK**: Implement task [NN] - [Task Name]

**TASK FILE**: `.corvus/tasks/[feature]/[NN-task-name].md`
⚠️ READ THIS FILE FIRST - It contains detailed steps, examples, and acceptance criteria.

**DELEGATED MODE**: Pre-approved via master plan. Do NOT ask for approval.

**TASK TYPE**: implementation | phase-test
**TEST MODE**: `tests_enabled: [true|false], tests_deferred: [true|false]`
**TEST SCOPE**: `test_scope: [targeted|none]` — targeted = only tests scoped to this task (its own new/modified test files); none when `tests_deferred: true` or `tests_enabled: false`. Full semantics: corvus-phase-2 skill, Test Scope section.
**AUTHORIZED FILE MANIFEST**: Exact `Files to Change` entries from the task file
**AUTHORIZED VALIDATION**: Exact commands permitted by the task and active workflow

**MUST DO**:
- Read `.corvus/tasks/[feature]/[NN-task-name].md` completely before starting
- Follow the Implementation Steps exactly
- Use code examples from the task file as patterns
- Modify only the authorized file manifest for this task type
- Run only authorized validation commands; task-specific restrictions override generic defaults
- Verify against Acceptance Criteria

**MUST NOT DO**:
- Implement from this summary alone
- Deviate from task file without documenting why
- Add a validation command not authorized by the task/workflow
- Author or execute tests outside the resolved ownership row above
- Run the full test suite; test_scope: targeted is the ceiling for implementer dispatches
- Implement OTHER tasks (you are only responsible for task [NN])

**REPORT BACK**:
- Task ID: [NN]
- Files changed (with summaries)
- Authorized validation commands and actual results
- Commands not run because they were deferred, disabled, or prohibited
- Any issues and how resolved
- Any deviations (with reasoning)
```

#### Worked Example: Mixed Parallel + Sequential

Tasks 03 and 04 are independent; task 05 depends on both:

```javascript
// Message 1: two parallel code-implementers (one per task)
task(
  subagent_type: "code-implementer",
  description: "Task 03: Types",
  prompt: `**TASK**: Implement task 03 - Types
**TASK FILE**: \`.corvus/tasks/feature-x/03-types.md\`
[rest of single-task template for task 03]`
)

task(
  subagent_type: "code-implementer",
  description: "Task 04: Config",
  prompt: `**TASK**: Implement task 04 - Config
**TASK FILE**: \`.corvus/tasks/feature-x/04-config.md\`
[rest of single-task template for task 04]`
)

// WAIT for BOTH task 03 AND task 04 to complete...

// Message 2: sequential task that depends on 03 and 04
task(
  subagent_type: "code-implementer",
  description: "Task 05: Combined module",
  prompt: `**TASK**: Implement task 05 - Combined module
**TASK FILE**: \`.corvus/tasks/feature-x/05-combined-module.md\`
[rest of single-task template for task 05]`
)
```

---

### Pre-4b: Phase Metadata Extraction

Before invoking code-quality, collect from the phase's task files:

1. The task list for the current phase (IDs + file paths)
2. Each task's `requires_ux_dx_review` flag — if ANY is true, Phase 5 includes UX/DX review
3. Each task type, exact file manifest, and reported files changed in 4a
4. The resolved test flags and every authorized validation result or policy-based omission

```
PHASE METADATA EXTRACTION - Phase [N]
─────────────────────────────────────
Tasks in Phase: [NN, NN, NN] (total: [count])
Test Mode: tests_enabled=[true/false], tests_deferred=[true/false]

Task Ownership:
- Task NN: type=[implementation/phase-test], manifest=[paths], changed=[paths]

Validation Evidence:
- Task NN: commands run=[commands/results], not run by policy=[commands/reason]

UX/DX Review Flags:
- Task NN: requires_ux_dx_review = [true/false]

Phase 5 UX/DX Required: [YES if ANY task is true / NO if all false]
─────────────────────────────────────
```

---

### 4b. Objective Quality Gate — Entire Phase (Mandatory)

**Pass condition**: code-quality returns QUALITY GATE STATUS: PASS for the ENTIRE phase. Proceed to 4c only on PASS; on FAIL, run the learning-first fix cycle below.

What PASS requires per test mode follows the table below. The 4a reports are the
source of truth for validation already performed; do not assume generic lint,
typecheck, build, or test commands ran when an approved task narrowed them.

| Test flags | PASS requires | Delegation template |
|------------|---------------|---------------------|
| `tests_enabled: true`, `tests_deferred: false` | Tests PASS + every task's acceptance criteria PASS | Standard |
| `tests_enabled: true`, `tests_deferred: true` | Every task's acceptance criteria PASS (evidence: file inspection, code review, command output); tests deferred to Phase 5 | Acceptance-Only |
| `tests_enabled: false` | Every task's acceptance criteria PASS (same evidence types); tests not run and not required | Acceptance-Only |

**DELEGATE TO**: @code-quality

#### 4b Delegation: Standard Mode (`tests_enabled: true`, `tests_deferred: false`)

```markdown
**TASK**: Validate Phase [N] implementation

**PHASE TASKS**:
- Task NN: [name] - `.corvus/tasks/[feature]/NN-task.md`
- Task NN: [name] - `.corvus/tasks/[feature]/NN-task.md`

**SCOPE**: All files created/modified in 4a for this phase

**TEST SCOPE**: `test_scope: [targeted|none]` — targeted = union of test files created/modified by this phase's tasks (from their Tests sections); none when the phase has no test tasks (deferred and disabled dispatches use the acceptance-only template below). Exception: a Lightweight non-deferred plan's final 4b gate doubles as final validation and carries the plan's single full-suite run (semantics: corvus-phase-2 skill, Test Scope section).

**PRIMARY JOB**: RUN TESTS

Code-implementer ran only the validations authorized by each task. Your gate owns
the required phase test execution and acceptance verification in this mode.

**CHECKS REQUIRED**:
1. Run the phase-targeted test scope (union of this phase's task test files) — once
2. Verify acceptance criteria from ALL task files (with evidence)
3. Check for regressions within the dispatched test_scope plus acceptance-criteria evidence — the full suite belongs to Phase 5a only

**MUST DO**:
- Identify test files for the scope
- Run tests with the appropriate test runner
- Report actual test output (not just "PASS")
- Verify each acceptance criterion with evidence (test name or observation)
- Attribute any failures to specific task(s)

**MUST NOT DO**:
- Add unrelated lint/typecheck/build commands; run a prerequisite build only when the authorized test workflow requires it
- Run the full test suite — that is the Phase 5a dispatch, not 4b (sole exception: the Lightweight final gate noted in TEST SCOPE above)
- Check criteria boxes without running tests
- Report failures without task attribution

**IF NO TESTS EXIST**:
- Report "NO TESTS FOUND" as a gap
- Verify acceptance criteria through other automated means
- Mark criteria requiring manual verification as "MANUAL (deferred to 5b)"

**REPORT FORMAT**:
```
**QUALITY GATE STATUS**: PASS / FAIL

### Test Results (PRIMARY)
**Command**: {actual test command run}
**Output**: {actual output}
Tests: [N] run, [N] passed, [N] failed

### Acceptance Criteria
| Task | Criterion | Status | Evidence |
|------|-----------|--------|----------|
| NN | [criterion] | ✅/❌/⚠️ | [test name or "MANUAL"] |

### Task Attribution
| Task | Tests | Criteria | Status |
|------|-------|----------|--------|
| NN | [N/M] | [N/M] | PASS/FAIL |

### Fix Scope (if FAIL)
Only tasks [NN] require fixes. Tasks [NN] should NOT be modified.
```
```

#### 4b Delegation: Acceptance-Only Mode (`tests_enabled: false` OR `tests_deferred: true`)

```markdown
**TASK**: Validate Phase [N] implementation (acceptance-only mode)

**PHASE TASKS**:
- Task NN: [name] - `.corvus/tasks/[feature]/NN-task.md`
- Task NN: [name] - `.corvus/tasks/[feature]/NN-task.md`

**SCOPE**: All files created/modified in 4a for this phase

**MODE**: ACCEPTANCE-ONLY (`tests_enabled: false` OR `tests_deferred: true`)

**TEST SCOPE**: `test_scope: none` — acceptance-only; no test execution.

**PRIMARY JOB**: VERIFY ACCEPTANCE CRITERIA

Code-implementer ran only the validation commands authorized by each task. Verify
acceptance criteria without running tests and do not treat a policy-prohibited
generic command as missing evidence.

**CHECKS REQUIRED**:
1. Verify acceptance criteria from ALL task files (with evidence)
2. Evidence must be concrete: file inspection, code review, or command output
3. Check for regressions via code review (if existing code was modified)

**MUST DO**:
- Read all task files for the phase
- For each acceptance criterion, provide concrete evidence
- Attribute any failures to specific task(s)
- Report PASS/FAIL with evidence type for each criterion

**MUST NOT DO**:
- Attempt to run tests, report "NO TESTS FOUND" as a gap, or recommend test creation
- Substitute a generic typecheck, lint, or build command prohibited by the task/workflow
- Check criteria boxes without evidence
- Report failures without task attribution

**REPORT FORMAT**:
```
**QUALITY GATE STATUS**: PASS / FAIL
**MODE**: ACCEPTANCE-ONLY

### Acceptance Criteria Verification (PRIMARY)
| Task | Criterion | Status | Evidence |
|------|-----------|--------|----------|
| NN | [criterion] | ✅/❌/⚠️ | [file inspection / code review / command output] |

### Task Attribution
| Task | Criteria | Status |
|------|----------|--------|
| NN | [N/M] | PASS/FAIL |

### Fix Scope (if FAIL)
Only tasks [NN] require fixes. Tasks [NN] should NOT be modified.
```
```

**GATE DECISION**:
- If QUALITY GATE STATUS = PASS → Proceed to 4c (update master plan)
- If QUALITY GATE STATUS = FAIL → Iteration-aware fix cycle (iteration 1: F1 → F3; iteration ≥2: F2 → F3)

---

### On FAIL: Iteration-Aware Fix Cycle

The canonical rule from Operating Rules applies: iteration 1 dispatches a direct fix from the gate's failure report (F1); iteration ≥2 runs FAILURE_ANALYSIS first, then the fix (F2); every iteration ends with revalidation at the original 4b dispatch scope (F3).

**Step F1 (Iteration 1): Direct Fix — DELEGATE TO @code-implementer (failing tasks only)**

No task-planner round-trip: the 4b report already attributes failures to tasks.

```markdown
**TASK**: Fix failing tasks from the 4b quality gate (iteration 1)

**FAILING TASKS ONLY**:
- Task NN: [failed criteria/tests from the gate report]

**DO NOT MODIFY**: Tasks [NN, NN] - these passed validation

**FAILURE REPORT**:
[4b gate output with task attribution — failing criteria, exact errors, files involved per task]

**TEST SCOPE**: `test_scope: targeted`

**MUST DO**:
- Address each attributed failure from the failure report
- Reapply each failing task's type, test flags, file manifest, and validation allowlist
- Modify ONLY files related to failing tasks, then run only authorized validation

**MUST NOT DO**:
- Modify files for passing tasks
- Make unrelated changes
- Run the full test suite

**REPORT BACK**:
- Changes made per failing task
- Validation results
- Ready for re-validation
```

**Step F2 (Iteration ≥2): Failure Analysis, Then Fix — DELEGATE TO @task-planner, then @code-implementer**

```markdown
**TASK**: Analyze phase quality gate failure

**MODE**: LEARNING

**TRIGGER**: FAILURE_ANALYSIS

**FAILED GATE**: 4b (phase-level)

**PHASE**: [phase number]

**ITERATION**: [N ≥ 2] of 3

**FAILURE DETAILS**:
- Failing task(s): [list with task IDs]
- What failed: [specific test/build/criteria per task]
- Error messages: [exact errors]
- Files involved: [list per task]
- Previous fix attempts: [what each prior iteration changed]

**QUESTIONS TO ANSWER**:
1. What is the root cause of each failure?
2. Why did the previous fix not work?
3. Are the task definitions correct, or do they need updating?
4. Was there missing context that caused the failure?
5. What should the fix approach be for each failing task?

**MUST DO**:
- Analyze the failure root cause per failing task
- Update task files if definitions were wrong
- Provide clear fix instructions for code-implementer
- Scope fixes to ONLY failing tasks

**REPORT BACK**:
- Root cause analysis per failing task
- Task file updates made (if any)
- Specific fix instructions for code-implementer
- Confirmation that passing tasks should NOT be modified
```

Then dispatch the fix to @code-implementer:

```markdown
**TASK**: Fix implementation based on failure analysis

**FAILING TASKS ONLY**:
- Task NN: [fix instructions]

**DO NOT MODIFY**: Tasks [NN, NN] - these passed validation

**FAILURE ANALYSIS**:
[Root cause and recommended fix approach from the analysis]

**SPECIFIC FIXES REQUIRED**:
[Exact changes needed per failing task based on the analysis]

**TEST SCOPE**: `test_scope: targeted`

**MUST DO**:
- Follow the fix approach from failure analysis
- Address the root cause, not just symptoms
- Ensure fix aligns with updated task definition (if changed)
- Reapply each failing task's type, test flags, file manifest, and validation allowlist
- Modify ONLY files related to failing tasks, then run only authorized validation

**MUST NOT DO**:
- Modify files for passing tasks
- Make unrelated changes

**REPORT BACK**:
- Changes made per failing task
- How root cause was addressed
- Ready for re-validation
```

**Step F3: Loop to 4b** — code-quality re-runs the same scope as the original 4b dispatch (per Operating Rules): phase-targeted in the general case, never widening to the full suite; the Lightweight non-deferred final gate revalidates at its dispatched full scope (its sanctioned re-run). Track iterations; the 3-iteration cap with user escalation applies.

---

### 4c. Update Master Plan

After a phase-wide 4b `PASS`, delegate the state transition to @task-planner.
Corvus is the caller and verifier, never the plan writer.

```markdown
**TASK**: Record the passed Phase [exact ID and name]
**MODE**: PROGRESS_UPDATE
**MASTER PLAN**: `.corvus/tasks/[feature]/MASTER_PLAN.md`
**PHASE**: [exact phase ID and name]

**TASK TRANSITIONS**:
- `[exact-task-id]`: `[prior]` -> `[x]`

**DEPENDENCY STATUS**:
- `[exact-task-id]` depends on `[exact-dependency-id]`: `[x]`

**QUALITY GATE**:
- Status: PASS
- Mode: STANDARD | ACCEPTANCE-ONLY
- Test flags: `tests_enabled: [true|false], tests_deferred: [true|false]`
- Evidence: [complete 4b report, including criterion evidence]

**EXECUTION RECORD**:
- Files changed: [exact task-owned paths from verified 4a reports]
- Validation evidence: [commands/inspection performed, results, and policy-based omissions]

**EVIDENCE TASK FILE**: `.corvus/tasks/[feature]/[NN-task].md` | NONE
```

Send every completed task ID in the phase, its on-disk prior status, direct
dependency statuses, the exact gate mode/evidence, and the exact target path. Do
not invoke success extraction here; Phase 6 alone owns feature-wide learning.

When task-planner returns:

1. Require an explicit success result with previous/new states, recalculated
   counts, recorded evidence, and a complete changed-path list.
2. Verify the returned diff is confined to the supplied MASTER_PLAN.md and, only
   when named, the one evidence task file. No production, prompt, source, docs,
   tests, package, Git, generated, or user-local path is allowed.
3. Verify objectives, scope, file manifests, dependencies, and acceptance criteria
   are unchanged; no `[x]` regressed; phase status, task rows, Quick Reference,
   progress counts, and evidence agree.
4. Only after these checks pass, continue: more implementation phases loop to 4a
   with fix iterations reset; otherwise proceed to Phase 5.

If task-planner rejects the request, fails to update, or returns an unauthorized
or inconsistent diff, block the transition and report the failure. Do not edit
MASTER_PLAN.md directly, repair the result silently, or advance to another phase.

### Self-Check Before Leaving a Phase

- [ ] Every task ran through its own code-implementer (one task = one invocation)
- [ ] code-quality reported QUALITY GATE STATUS: PASS for the entire phase
- [ ] Every fix iteration followed the iteration rule (iteration 1: direct fix from the 4b report; iteration ≥2: FAILURE_ANALYSIS first) and re-ran the original 4b dispatch scope
- [ ] task-planner accepted `PROGRESS_UPDATE`
- [ ] Returned diff is confined to authorized planning files and preserves task meaning
- [ ] MASTER_PLAN.md mirrors completion across tasks, Quick Reference, counts, evidence, and phase status

**Exit Criteria**: All phases complete, proceed to Phase 5.

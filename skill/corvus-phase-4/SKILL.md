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
4b: code-quality (mandatory; risk-triaged when acceptance-only)
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
  - **Parallelize disjoint workstreams**: workstreams whose file sets are pairwise
    disjoint (check the master plan's Workstreams section and `Depends On` metadata)
    run concurrently; a shared file forces sequential order.
  - **Update MASTER_PLAN.md at phase boundaries** (4c), not after each task or
    event. After a phase-wide 4b PASS, batch every accumulated status and the
    gate evidence line into one task-planner `PROGRESS_UPDATE`. Corvus never
    edits the plan directly.
  - **Track finding origin**: for every gate or review finding, record whether it
    originates in the requested functional change, pre-existing code, or apparatus
    added by a prior remediation iteration (including guards, tripwires, decoys,
    and test scaffolding). Carry this lineage through every failure report.
  - **Remediation stop rule**: When two consecutive fix iterations produce findings
    in code or apparatus added by prior remediation, the default action flips from
    fixing the finding to evaluating whether to revert or simplify that apparatus;
    the orchestrator states this evaluation explicitly before dispatching another
    fix. Remediation loops otherwise become self-sustaining: in production, rounds
    2-5 findings were almost entirely in guard apparatus added by rounds 1-4.
  - **Max 3 fix iterations per phase**: at the cap, stop and escalate to the user with
    what passed, what still fails, and open questions — even if the phase is incomplete.
  - **Fix-attempt accounting**: code-implementer's in-task 2-attempt fix rule
    (Delegated Mode) does not consume the 4b 3-iteration cap — the cap counts only
    4b FAIL → fix → 4b loops. Only a failure at the gate that carries final validation (Phase 5a — or a Lightweight non-deferred plan's final 4b gate) justifies a full-suite re-run.
  - **Risk-triaged 4b** (canonical statement — orchestrators point here): the 4b
    dispatch may be skipped ONLY when ALL hold: the gate mode is acceptance-only
    (tests deferred or disabled), the phase executed as a single workstream, every
    per-task report section is PASS with zero deviations, and no task touched
    `prompt-contracts.test.ts` or a mirrored-pair file (parity and pin surfaces
    always get independent verification). When skipped, the orchestrator performs
    LIGHTWEIGHT VERIFICATION from the per-task reports it already holds, and the
    4c PROGRESS_UPDATE records `4b: PASS (lightweight — skip conditions met: [list])`.
    NEVER skip: multi-workstream phases, any deviation or BLOCKED task, fix-loop
    re-entries (F3 always returns to a real 4b dispatch), or enabled non-deferred
    mode — there 4b runs its dispatched test scope unconditionally.
</operating_rules>

---

### Phase 4 File, Test, and Validation Ownership

Resolve `tests_enabled` and `tests_deferred` from MASTER_PLAN.md before dispatch.
Classify each row by its explicit task type and enforce its `Files to Change`
manifest as a write allowlist.

| Mode / task type | Writable files and test authoring | Test execution in Phase 4 |
|------------------|-----------------------------------|---------------------------|
| `tests_enabled: true`, implementation task | Product files explicitly listed. Do not author tests unless an obsolete test edit is explicitly in this task's approved manifest. | Only commands explicitly authorized by the active task/workflow. |
| Explicit preselected `tests_enabled: true`, phase test task, `tests_deferred: false` | Existing/new test files explicitly listed; author tests and make no production changes. | Runs only the test files this task authored/modified (test_scope: targeted); 4b owns the single phase-targeted gate run. This plumbing mode is not offered by the user-facing test question. |
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

### Dispatch Premise Provenance

Every factual premise the orchestrator writes into a dispatch must carry inline
provenance: the command or `file:line` from which it was read during THIS
session. This includes versions, SHAs, pins, statements that the current,
outgoing, or previous value is X, counts, and paths asserted to exist. A premise
that cannot be cited must be handed to the child as a question to verify, not a
fact to execute. This extends the merge-base rule below to every premise class.

Before any 4a, 4b, or fix dispatch that reasons about "current", "previous",
"outgoing", or "baseline" repository state, compute `git merge-base HEAD
<default-branch>` and include the resulting full SHA in the dispatch. State
explicitly that branch HEAD is NOT the baseline. Every comparison must use the
provided merge-base SHA; comparison against the wrong ref is a known failure
class.

### Build-Pipeline Child Transport Retry

This rule applies to every build-pipeline dispatch to `task-planner`, `code-implementer`, `code-quality`, `plan-reviewer`, `ux-dx-quality`, `requirements-analyst`, `code-explorer`, and `researcher`. An empty report, a report truncated at the critical point, or a schema-invalid report is a child-transport failure; a well-formed failure report is a real result and immediately follows the step's existing failure handling.

For a child-transport failure, first attempt one session resume of the same child and request only its final report. If the resumed report is still empty, critically truncated, or schema-invalid, re-dispatch with byte-identical task inputs: at most once in interactive Corvus and at most twice in Corvus Auto. Validate each returned report before proceeding. After the mode's bound is consumed, apply the step's existing failure handling, including a gate's FAIL path, 5b fail-closed handling, or the applicable phase halt. These are transport replacements, not new workflow decisions.

Two carve-outs are mandatory:

1. **Mutation-aware implementer recovery** — because `code-implementer` may already have mutated the workspace before its report was lost, never re-dispatch it blindly. First verify workspace state with read-only Git status and the task's expected-file manifest, then brief the resumed or re-dispatched implementer on exactly what already exists. Preserve the original task inputs byte-for-byte; the state briefing is recovery metadata and cannot broaden scope, repeat completed mutations, or change the file/validation contract. If workspace state cannot be established, do not re-dispatch; apply the existing failure path.
2. **Judgment-budget preservation** — transport retries never extend judgment budgets. A recovered or re-dispatched call replaces the flaked dispatch in the count; it is not additional to the Phase 3.5 two-REJECT budget or the Phase 4b three-fix-iteration budget.

Production evidence: ≥7 empty or critically truncated child reports occurred in one production week, and each required improvised recovery; this rule makes that recovery deterministic.

### 4a. Implementation — One Workstream Per Code-Implementer

One workstream (1-5 related tasks from the master plan's `### Workstreams` section) = one code-implementer invocation. The Task tool runs multiple `task()` calls from a single message concurrently ("use a single message with multiple tool uses" to parallelize), so:

- **Parallel** (workstreams with pairwise-disjoint file sets, per the plan's justification column): multiple `task()` calls in ONE message — each for exactly one workstream
- **Sequential** (dependent workstreams, shared file modifications, output feeding forward): one `task()` call per message; wait for completion between each

A single-task workstream uses the Single-Task Delegation Template below; a multi-task workstream uses the Workstream Delegation Template after the Worked Example.

**Success criteria for 4a**: every task in the phase dispatched exactly once through its workstream's code-implementer, and every dispatch reported back with per-task validation results.

#### Single-Task Delegation Template

```markdown
**TASK**: Implement task [NN] - [Task Name]

**TASK FILE**: `.corvus/tasks/[feature]/[NN-task-name].md`
⚠️ READ THIS FILE FIRST - It contains detailed steps, examples, and acceptance criteria.

**CONTEXT FILE**: `.corvus/tasks/[feature]/CONTEXT.md` (discovery context — read when present; may be absent on legacy plans)

**DELEGATED MODE**: Pre-approved via master plan. Do NOT ask for approval.

**TASK TYPE**: implementation | phase-test
**TEST MODE**: `tests_enabled: [true|false], tests_deferred: [true|false]`
**TEST SCOPE**: `test_scope: [targeted|none]` — targeted = only tests scoped to this task (its own new/modified test files); none when `tests_deferred: true` or `tests_enabled: false`. Full semantics: corvus-phase-2 skill, Test Scope section.
**AUTHORIZED FILE MANIFEST**: Exact `Files to Change` entries from the task file
**AUTHORIZED VALIDATION**: Exact commands permitted by the task and active workflow
**MERGE BASE SHA**: [full SHA from `git merge-base HEAD <default-branch>` when baseline reasoning applies; otherwise NOT APPLICABLE]
**PREMISE PROVENANCE**: [cite the session-read command or `file:line` inline beside every dispatch-authored fact; hand uncited premises to the child as verification questions]

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

#### Workstream Delegation Template

For a workstream of 2-5 tasks. Single-task workstreams use the Single-Task Delegation Template above.

```markdown
**TASK**: Implement workstream [WS-id] — tasks [NN, NN, NN]

**WORKSTREAM**: WS-[id] from `.corvus/tasks/[feature]/MASTER_PLAN.md` (Workstreams section)

**TASK FILES** (execute in dependency order):
- `.corvus/tasks/[feature]/[NN-task-name].md`
- `.corvus/tasks/[feature]/[NN-task-name].md`
⚠️ READ ALL TASK FILES FIRST — each is the atomic spec for its task.

**CONTEXT FILE**: `.corvus/tasks/[feature]/CONTEXT.md` (discovery context — read when present; may be absent on legacy plans)

**DELEGATED MODE**: Pre-approved via master plan. Do NOT ask for approval.

**TEST MODE**: `tests_enabled: [true|false], tests_deferred: [true|false]`
**TEST SCOPE**: `test_scope: [targeted|none]` — applies per member task: targeted = only tests scoped to that task (its own new/modified test files); none when `tests_deferred: true` or `tests_enabled: false`. Full semantics: corvus-phase-2 skill, Test Scope section.
**AUTHORIZED FILE MANIFEST**: per task — the exact `Files to Change` entries from each task file
**AUTHORIZED VALIDATION**: per task — exactly the commands each task and the active workflow permit
**MERGE BASE SHA**: [full SHA from `git merge-base HEAD <default-branch>` when baseline reasoning applies; otherwise NOT APPLICABLE]
**PREMISE PROVENANCE**: [cite the session-read command or `file:line` inline beside every dispatch-authored fact; hand uncited premises to the child as verification questions]

**MUST DO**:
- Read every listed task file completely before starting
- Execute member tasks in dependency order; resolve each task's contract independently
- Validate per task with only that task's allowlist; the 2-attempt fix rule scopes per task
- On a member-task failure, continue tasks whose dependencies are unaffected and mark dependents BLOCKED

**MUST NOT DO**:
- Pool validation commands or file manifests across member tasks
- Run the full test suite; test_scope: targeted is the ceiling
- Implement tasks outside this workstream

**REPORT BACK** (per-task sections keyed by Task ID):
- Workstream summary: [N] PASS / [N] FAIL / [N] BLOCKED
- Per task: Task ID, status (PASS/FAIL/BLOCKED), files changed, authorized validation commands and actual results, commands not run by policy, issues, deviations
```

---

### Pre-4b: Phase Metadata Extraction

Before invoking code-quality, collect from the phase's task files:

1. The task list for the current phase (IDs + file paths)
2. Each task's `requires_ux_dx_review` flag — if ANY is true, Phase 5 includes UX/DX review
3. Each task type, exact file manifest, and reported files changed in 4a — read from each dispatch's per-task report sections (workstream reports concatenate one section per member task)
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

#### Pre-Dispatch Triage (Risk-Triaged 4b)

Before selecting a template, evaluate the Risk-triaged 4b rule (Operating Rules).
When ALL skip conditions hold, do not dispatch code-quality; perform LIGHTWEIGHT
VERIFICATION instead:

- [ ] Every task's authorized validation commands appear in its report with passing output
- [ ] Every acceptance criterion is addressed in its task's report
- [ ] Every file manifest stayed within the task's approved scope

All boxes checked → treat 4b as PASS and record `4b: PASS (lightweight — skip
conditions met: [list])` in the 4c PROGRESS_UPDATE's QUALITY GATE field. Any box
unchecked → dispatch the real 4b (acceptance-only template). When any skip
condition fails, dispatch the template the resolved flags select, as always.

#### 4b Delegation: Standard Mode (explicit preselected `tests_enabled: true`, `tests_deferred: false`)

```markdown
**TASK**: Validate Phase [N] implementation

**PHASE TASKS**:
- Task NN: [name] - `.corvus/tasks/[feature]/NN-task.md`
- Task NN: [name] - `.corvus/tasks/[feature]/NN-task.md`

**CONTEXT FILE**: `.corvus/tasks/[feature]/CONTEXT.md` (discovery context — read when present; may be absent on legacy plans)

**SCOPE**: All files created/modified in 4a for this phase

**MERGE BASE SHA**: [full SHA from `git merge-base HEAD <default-branch>` when baseline reasoning applies; branch HEAD is NOT the baseline]

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

**CONTEXT FILE**: `.corvus/tasks/[feature]/CONTEXT.md` (discovery context — read when present; may be absent on legacy plans)

**SCOPE**: All files created/modified in 4a for this phase

**MERGE BASE SHA**: [full SHA from `git merge-base HEAD <default-branch>` when baseline reasoning applies; branch HEAD is NOT the baseline]

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

The canonical rule from Operating Rules applies: iteration 1 dispatches a direct fix from the gate's failure report (F1); iteration ≥2 runs FAILURE_ANALYSIS first, then the fix (F2); every iteration ends with revalidation at the original 4b dispatch scope (F3). A fix dispatch may target a subset of a workstream's tasks: scope it to the failing tasks — including tasks the gate reports as BLOCKED or unimplemented — as a single-task dispatch or a subset workstream carrying only those task files. Before every fix, classify each finding's origin; when the Remediation stop rule triggers, state the revert/simplify evaluation before choosing whether another fix dispatch is justified.

**Step F1 (Iteration 1): Direct Fix — DELEGATE TO @code-implementer (failing tasks only)**

No task-planner round-trip: the 4b report already attributes failures to tasks.

```markdown
**TASK**: Fix failing tasks from the 4b quality gate (iteration 1)

**FAILING TASKS ONLY**:
- Task NN: [failed criteria/tests from the gate report]

**DO NOT MODIFY**: Tasks [NN, NN] - these passed validation

**CONTEXT FILE**: `.corvus/tasks/[feature]/CONTEXT.md` (discovery context — read when present; may be absent on legacy plans)

**FAILURE REPORT**:
[4b gate output with task attribution — failing criteria, exact errors, files involved per task]

**FINDING ORIGINS**: [functional change | pre-existing code | prior-remediation apparatus, with iteration lineage]

**MERGE BASE SHA**: [carry the original full SHA when baseline reasoning applies; branch HEAD is NOT the baseline]

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
- Finding origins: [classify each finding and identify prior-remediation apparatus]
- Apparatus evaluation: [keep | revert | simplify, with rationale; mandatory when the Remediation stop rule triggers]

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

**CONTEXT FILE**: `.corvus/tasks/[feature]/CONTEXT.md` (discovery context — read when present; may be absent on legacy plans)

**FAILURE ANALYSIS**:
[Root cause and recommended fix approach from the analysis]

**FINDING ORIGINS AND APPARATUS EVALUATION**:
[Origin lineage and the explicit keep/revert/simplify decision]

**MERGE BASE SHA**: [carry the original full SHA when baseline reasoning applies; branch HEAD is NOT the baseline]

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

**Step F3: Loop to 4b** — code-quality re-runs the same scope as the original 4b dispatch (per Operating Rules): phase-targeted in the general case, never widening to the full suite; the Lightweight non-deferred final gate revalidates at its dispatched full scope (its sanctioned re-run). Track iterations; the 3-iteration cap with user escalation applies. Fix-loop re-entries are exempt from the Risk-triaged 4b skip: F3 always returns to a real 4b dispatch, never to lightweight verification.

---

### 4c. Update Master Plan

After a phase-wide 4b `PASS`, delegate the state transition to @task-planner.
Corvus is the caller and verifier, never the plan writer.

```markdown
**TASK**: Record the passed Phase [exact ID and name]
**MODE**: PROGRESS_UPDATE
**FEATURE DIRECTORY**: `.corvus/tasks/[feature]/`
**STATUS UPDATES**:
- `Phase [N]`: `[x]`
- `[exact-task-id]`: `[x]`
**GATE OUTCOME**: `4b: PASS — [one concrete evidence line]`
```

Send one batched dispatch per phase boundary with every accumulated task/phase
status and one gate evidence line. On a triage skip, use `4b: PASS (lightweight —
skip conditions met: [list])` as that line. Do not dispatch bookkeeping once per
event or edit MASTER_PLAN.md directly. Do not invoke success extraction here;
Phase 6 alone owns feature-wide learning.

When task-planner returns:

1. Require the one-line success confirmation defined by task-planner's
   `PROGRESS_UPDATE` mode.
2. Verify the returned diff is confined to the feature's MASTER_PLAN.md and only
   status markers, Progress counts, and the gate-outcome log changed.
3. Verify no task file, CONTEXT.md, objective, scope, file manifest, dependency,
   estimate, or acceptance criterion changed and no `[x]` regressed.
4. Only after these checks pass, continue: more implementation phases loop to 4a
   with fix iterations reset; otherwise proceed to Phase 5.

If task-planner rejects the request, fails to update, or returns an unauthorized
or inconsistent diff, block the transition and report the failure. Do not edit
MASTER_PLAN.md directly, repair the result silently, or advance to another phase.

### Self-Check Before Leaving a Phase

- [ ] Every task ran through exactly one workstream dispatch (one workstream = one code-implementer; per-task report sections present for every member task)
- [ ] code-quality reported QUALITY GATE STATUS: PASS for the entire phase, or a triage skip recorded `4b: PASS (lightweight — skip conditions met: [list])` after lightweight verification
- [ ] Every fix iteration followed the iteration rule (iteration 1: direct fix from the 4b report; iteration ≥2: FAILURE_ANALYSIS first) and re-ran the original 4b dispatch scope
- [ ] task-planner accepted `PROGRESS_UPDATE`
- [ ] Returned diff is confined to MASTER_PLAN.md status markers, Progress counts, and the gate-outcome log
- [ ] One batched update recorded every phase-boundary status and the gate evidence line

**Exit Criteria**: All phases complete, proceed to Phase 5.

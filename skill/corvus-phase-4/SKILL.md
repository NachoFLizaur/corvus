---
name: corvus-phase-4
description: Implementation loop - per-phase execution with quality gates
---

## Phase 4: IMPLEMENTATION LOOP (Per-Phase)

**Goal**: Execute each phase in the master plan with phase-level quality validation.

<critical_rule id="no_task_file_reading" priority="9999">
  DO NOT READ TASK FILES YOURSELF
  
  Get task list from MASTER_PLAN.md, then delegate to code-implementer with file paths.
  Code-implementer reads the task files - you just pass paths.
  
  WRONG: "Let me read the task files to understand..." → Read .corvus/tasks/feature/01-foo.md
  CORRECT: "Delegating task 01 to code-implementer" → task(prompt: "TASK FILE: .corvus/tasks/feature/01-foo.md")
  
  This saves your context for coordination.
</critical_rule>

Phase 4 operates at the **phase level**, not per-task. Tasks within a phase are implemented together (parallel where possible), with quality validation happening once per phase.

### Per-Phase Flow

```
4a: code-implementer (ALL tasks in phase, parallel where possible)
         │
         ▼
4b: code-quality (MANDATORY)
    ├── tests_enabled: true  → tests + acceptance criteria
    └── tests_enabled: false → acceptance criteria only
         │
    ┌────┴────┐
  PASS      FAIL
    │         │
    │         ▼
    │    task-planner LEARNING (FAILURE_ANALYSIS with task attribution)
    │         │
    │         ▼
    │    code-implementer (fix ONLY failing tasks)
    │         │
    │         └──► Loop back to 4b (full phase revalidation)
    │
    ▼
4c: Update master plan → Next Phase (or Phase 5 if all complete)
    (Corvus updates plan directly - no subagent needed)
```

### KEY RULES

<validation_rules priority="absolute">
  <rule id="phase_level_operations">
    **Phase-level operations**: Implementation, validation, and learning happen 
    per-phase, not per-task. This reduces overhead and enables parallel execution.
  </rule>
  
  <rule id="parallel_where_possible">
    **Parallel where possible**: Tasks with no inter-dependencies execute in 
    parallel within a phase. Check task file `Parallel With` metadata.
  </rule>
  
  <rule id="failure_analysis_before_fix">
    **FAILURE_ANALYSIS before fixing**: When 4b fails, ALWAYS invoke task-planner
    LEARNING (FAILURE_ANALYSIS) before attempting fixes. Never fix blindly.
  </rule>
  
  <rule id="direct_plan_update">
    **Direct plan update on success**: When 4b passes, Corvus updates
    MASTER_PLAN.md directly (mark tasks complete, update progress). No subagent
    needed for success path - saves tokens and latency.
  </rule>
  
  <rule id="failure_attribution">
    **Failure attribution**: Quality gate must identify which specific task(s) 
    caused failure. Fix only failing tasks, not entire phase.
  </rule>
  
  <rule id="full_phase_revalidation">
    **Full phase revalidation**: After any fix, revalidate entire phase (4b).
    This ensures fixes don't break other tasks.
  </rule>
  
  <rule id="max_iterations">
    **Max 3 iterations per phase**: Track iterations through the loop. After 
    3 iterations, escalate to user. Do not loop infinitely.
  </rule>
  
  <rule id="plan_updates_at_boundaries">
    **Plan updates at boundaries**: MASTER_PLAN.md only updated at phase 
    completion (4c), not after each task.
  </rule>
</validation_rules>

---

### 4a. Implementation - One Task Per Code-Implementer

<critical_rule id="one_task_one_implementer" priority="9999">
  ONE TASK = ONE CODE-IMPLEMENTER (ALWAYS)
  
  NEVER have a single code-implementer handle multiple tasks.
  Each task file gets its own dedicated code-implementer invocation.
  
  - Parallel tasks → Multiple task() calls in ONE message (each for ONE task)
  - Sequential tasks → One task() call, wait for completion, then next task() call
</critical_rule>

### Single Task Delegation Template

Use this template for EACH task. Every code-implementer invocation handles exactly ONE task:

```markdown
**TASK**: Implement task [NN] - [Task Name]

**TASK FILE**: `.corvus/tasks/[feature]/[NN-task-name].md`
⚠️ READ THIS FILE FIRST - It contains detailed steps, examples, and acceptance criteria.

**DELEGATED MODE**: Pre-approved via master plan. Do NOT ask for approval.

**MUST DO**:
- Read `.corvus/tasks/[feature]/[NN-task-name].md` completely before starting
- Follow the Implementation Steps exactly
- Use code examples from the task file as patterns
- Validate after changes (type check, lint, tests)
- Verify against Acceptance Criteria

**MUST NOT DO**:
- Implement from this summary alone
- Deviate from task file without documenting why
- Skip validation
- Implement OTHER tasks (you are only responsible for task [NN])

**REPORT BACK**:
- Task ID: [NN]
- Files changed (with summaries)
- Validation results
- Any issues and how resolved
- Any deviations (with reasoning)
```

### Parallel vs Sequential Execution

**When to parallelize** (multiple task() calls in ONE message):
- Tasks with `Parallel With` metadata indicating no dependencies
- Independent tasks within the same phase
- Tasks that don't share file modifications

**When to execute sequentially** (one task() call, wait, then next):
- Tasks with explicit dependencies (`Depends On` metadata)
- Tasks that modify the same files
- Tasks where output of one feeds into another

### Example A: Parallel Tasks (No Dependencies)

Tasks 03, 04, 05, 06 have no dependencies on each other. Invoke ALL in ONE message:

```javascript
// ONE message with FOUR task() calls = 4 parallel code-implementers
// Each code-implementer handles exactly ONE task

task(
  subagent_type: "code-implementer", 
  description: "Task 03: Setup types", 
  prompt: `**TASK**: Implement task 03 - Setup types
**TASK FILE**: \`.corvus/tasks/feature-x/03-setup-types.md\`
⚠️ READ THIS FILE FIRST...
[rest of single task template for task 03]`
)

task(
  subagent_type: "code-implementer", 
  description: "Task 04: Add config", 
  prompt: `**TASK**: Implement task 04 - Add config
**TASK FILE**: \`.corvus/tasks/feature-x/04-add-config.md\`
⚠️ READ THIS FILE FIRST...
[rest of single task template for task 04]`
)

task(
  subagent_type: "code-implementer", 
  description: "Task 05: Create utils", 
  prompt: `**TASK**: Implement task 05 - Create utils
**TASK FILE**: \`.corvus/tasks/feature-x/05-create-utils.md\`
⚠️ READ THIS FILE FIRST...
[rest of single task template for task 05]`
)

task(
  subagent_type: "code-implementer", 
  description: "Task 06: Base module", 
  prompt: `**TASK**: Implement task 06 - Base module
**TASK FILE**: \`.corvus/tasks/feature-x/06-base-module.md\`
⚠️ READ THIS FILE FIRST...
[rest of single task template for task 06]`
)
```

### Example B: Sequential Tasks (With Dependencies)

Task 08 depends on 07, task 09 depends on 08. Execute ONE at a time:

```javascript
// Message 1: Invoke code-implementer for task 07 ONLY
task(
  subagent_type: "code-implementer", 
  description: "Task 07: Core logic", 
  prompt: `**TASK**: Implement task 07 - Core logic
**TASK FILE**: \`.corvus/tasks/feature-x/07-core-logic.md\`
⚠️ READ THIS FILE FIRST...
[rest of single task template for task 07]`
)

// ⏳ WAIT for task 07 to complete before proceeding...

// Message 2: Invoke code-implementer for task 08 ONLY
task(
  subagent_type: "code-implementer", 
  description: "Task 08: API endpoint", 
  prompt: `**TASK**: Implement task 08 - API endpoint
**TASK FILE**: \`.corvus/tasks/feature-x/08-api-endpoint.md\`
⚠️ READ THIS FILE FIRST...
[rest of single task template for task 08]`
)

// ⏳ WAIT for task 08 to complete before proceeding...

// Message 3: Invoke code-implementer for task 09 ONLY
task(
  subagent_type: "code-implementer", 
  description: "Task 09: Integration", 
  prompt: `**TASK**: Implement task 09 - Integration
**TASK FILE**: \`.corvus/tasks/feature-x/09-integration.md\`
⚠️ READ THIS FILE FIRST...
[rest of single task template for task 09]`
)
```

### Example C: Mixed (Parallel Then Sequential)

Tasks 03, 04 can run in parallel. Task 05 depends on BOTH 03 and 04:

```javascript
// Message 1: Two parallel code-implementers (one per task)
task(
  subagent_type: "code-implementer", 
  description: "Task 03: Types", 
  prompt: `**TASK**: Implement task 03 - Types
**TASK FILE**: \`.corvus/tasks/feature-x/03-types.md\`
⚠️ READ THIS FILE FIRST...
[rest of single task template for task 03]`
)

task(
  subagent_type: "code-implementer", 
  description: "Task 04: Config", 
  prompt: `**TASK**: Implement task 04 - Config
**TASK FILE**: \`.corvus/tasks/feature-x/04-config.md\`
⚠️ READ THIS FILE FIRST...
[rest of single task template for task 04]`
)

// ⏳ WAIT for BOTH task 03 AND task 04 to complete...

// Message 2: Sequential task that depends on 03 and 04
task(
  subagent_type: "code-implementer", 
  description: "Task 05: Combined module", 
  prompt: `**TASK**: Implement task 05 - Combined module
**TASK FILE**: \`.corvus/tasks/feature-x/05-combined-module.md\`
⚠️ READ THIS FILE FIRST...
[rest of single task template for task 05]`
)
```

### Key Principle

The Task tool documentation states: "Launch multiple agents concurrently whenever possible, 
to maximize performance; to do that, use a single message with multiple tool uses"

This means:
- **Parallel**: Multiple `task()` calls in ONE message → concurrent execution
- **Sequential**: One `task()` call per message → wait between each

But ALWAYS: **One task file = One code-implementer invocation**

---

### Pre-4b: Phase Metadata Extraction

<critical_rule priority="999">
  BEFORE invoking code-quality (step 4b), you MUST:
  
  1. Identify all tasks in the current phase
  2. Note which tasks have `requires_ux_dx_review: true` (for Phase 5)
  3. Prepare the phase validation scope
</critical_rule>

**Metadata Extraction Format**:
```
PHASE METADATA EXTRACTION - Phase [N]
─────────────────────────────────────
Tasks in Phase: [NN, NN, NN, NN]
Total Tasks: [count]

UX/DX Review Flags:
- Task NN: requires_ux_dx_review = [true/false]
- Task NN: requires_ux_dx_review = [true/false]

Phase 5 UX/DX Required: [YES if ANY task is true / NO if all false]
─────────────────────────────────────
```

---

### 4b. Objective Quality Gate - ENTIRE PHASE (MANDATORY)

<quality_gate id="objective" priority="9999">
  <rule>
    MANDATORY OBJECTIVE QUALITY GATE: You CANNOT proceed until
    code-quality returns PASS for the ENTIRE PHASE.
    
    When `tests_enabled: true`:
    - Tests: PASS (for all affected code)
    - Acceptance criteria: ALL tasks in phase PASS
    
    When `tests_enabled: false` (acceptance-only mode):
    - Acceptance criteria: ALL tasks in phase PASS (verified via file inspection, code review, command output)
    - Tests are NOT run and NOT required
    
    NOTE: code-implementer already validated lint, type check, and build.
    code-quality focuses on TESTS and acceptance criteria verification
    (or acceptance criteria only when tests_enabled: false).
    
    If ANY check returns FAIL:
    1. FIRST: Invoke task-planner LEARNING MODE (FAILURE_ANALYSIS)
    2. THEN: Invoke code-implementer with fix instructions (ONLY failing tasks)
    3. THEN: Loop back to 4b (full phase revalidation)
    4. Repeat until PASS (max 3 iterations per phase)
    5. If still failing after 3 iterations, escalate to user
    
    NEVER skip this gate. NEVER proceed with FAIL status.
    NEVER fix without first analyzing the failure.
    NEVER fix passing tasks - only fix failing tasks.
  </rule>
</quality_gate>

**Template Selection for 4b**:
- If `tests_enabled: true` (default): Use the standard delegation template below
- If `tests_enabled: false`: Use the "Acceptance-Only Mode" delegation template

**DELEGATE TO**: @code-quality

#### 4b Delegation: Standard Mode (when `tests_enabled: true`)

```markdown
**TASK**: Validate Phase [N] implementation

**PHASE TASKS**: 
- Task NN: [name] - `.corvus/tasks/[feature]/NN-task.md`
- Task NN: [name] - `.corvus/tasks/[feature]/NN-task.md`
- Task NN: [name] - `.corvus/tasks/[feature]/NN-task.md`

**SCOPE**: All files created/modified in 4a for this phase

**PRIMARY JOB**: RUN TESTS

Code-implementer already validated:
- ✅ Lint passed
- ✅ Type check passed  
- ✅ Build succeeded

Your job is to run the TESTS that code-implementer did not run.

**CHECKS REQUIRED**:
1. Run test suite (targeting tests for this phase's code)
2. Verify acceptance criteria from ALL task files (with evidence)
3. Check for regressions (if existing tests exist)

**MUST DO**:
- Identify test files for the scope
- Run tests with appropriate test runner
- Report actual test output (not just "PASS")
- Verify each acceptance criterion with evidence (test name or observation)
- Attribute any failures to specific task(s)

**MUST NOT DO**:
- Re-run lint (code-implementer did this)
- Re-run type check (code-implementer did this)
- Re-run build (unless tests require it)
- Just read files and check boxes without running tests
- Report failures without task attribution

**IF NO TESTS EXIST**:
- Report "NO TESTS FOUND" as a gap
- Verify acceptance criteria through other automated means
- Mark criteria requiring manual verification as "MANUAL (deferred to 5b)"

**REPORT FORMAT**:
```
**PHASE GATE STATUS**: PASS / FAIL

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

#### 4b Delegation: Acceptance-Only Mode (when `tests_enabled: false`)

```markdown
**TASK**: Validate Phase [N] implementation (acceptance-only mode)

**PHASE TASKS**: 
- Task NN: [name] - `.corvus/tasks/[feature]/NN-task.md`
- Task NN: [name] - `.corvus/tasks/[feature]/NN-task.md`

**SCOPE**: All files created/modified in 4a for this phase

**MODE**: ACCEPTANCE-ONLY (`tests_enabled: false`)

**PRIMARY JOB**: VERIFY ACCEPTANCE CRITERIA

Code-implementer already validated:
- ✅ Lint passed
- ✅ Type check passed  
- ✅ Build succeeded

Your job is to verify acceptance criteria from task files WITHOUT running tests.

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
- Attempt to run tests
- Report "NO TESTS FOUND" as a gap
- Recommend test creation
- Just read files and check boxes without evidence
- Report failures without task attribution

**REPORT FORMAT**:
```
**PHASE GATE STATUS**: PASS / FAIL
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
- If PHASE GATE STATUS = PASS → Proceed to 4c (update master plan)
- If PHASE GATE STATUS = FAIL → Invoke failure learning, then fix failing tasks, then loop to 4b

---

#### On FAIL: Learning-First Fix Cycle

When the phase quality gate returns FAIL, follow this exact sequence:

**Step F1: Failure Analysis (MANDATORY before fixing)**

**DELEGATE TO**: @task-planner

**MODE**: LEARNING (FAILURE_ANALYSIS)

```markdown
**TASK**: Analyze phase quality gate failure

**MODE**: LEARNING

**TRIGGER**: FAILURE_ANALYSIS

**FAILED GATE**: 4b (phase-level)

**PHASE**: [phase number]

**FAILURE DETAILS**:
- Failing task(s): [list with task IDs]
- What failed: [specific test/build/criteria per task]
- Error messages: [exact errors]
- Files involved: [list per task]

**QUESTIONS TO ANSWER**:
1. What is the root cause of each failure?
2. Are the task definitions correct, or do they need updating?
3. Was there missing context that caused the failure?
4. What should the fix approach be for each failing task?

**MUST DO**:
- Analyze the failure root cause per failing task
- Determine if task files need updating
- Update task files if definitions were wrong
- Provide clear fix instructions for code-implementer
- Scope fixes to ONLY failing tasks

**REPORT BACK**:
- Root cause analysis per failing task
- Task file updates made (if any)
- Recommended fix approach per task
- Specific fix instructions for code-implementer
- Confirmation that passing tasks should NOT be modified
```

**Step F2: Fix Implementation (ONLY Failing Tasks)**

**DELEGATE TO**: @code-implementer

```markdown
**TASK**: Fix implementation based on failure analysis

**FAILING TASKS ONLY**:
- Task NN: [fix instructions]
- Task NN: [fix instructions]

**DO NOT MODIFY**: Tasks [NN, NN, NN] - these passed validation

**FAILURE ANALYSIS**:
[Include root cause and recommended fix approach from F1]

**SPECIFIC FIXES REQUIRED**:
[Exact changes needed per failing task based on F1 analysis]

**MUST DO**:
- Follow the fix approach from failure analysis
- Address the root cause, not just symptoms
- Ensure fix aligns with updated task definition (if changed)
- ONLY modify files related to failing tasks

**MUST NOT DO**:
- Modify files for passing tasks
- Make unrelated changes
- Skip validation

**REPORT BACK**:
- Changes made per failing task
- How root cause was addressed
- Ready for re-validation
```

**Step F3: Loop Back to 4b**

After fix, ALWAYS loop back to 4b (code-quality) for full phase revalidation.
This ensures fixes don't break other tasks in the phase.

**ITERATION TRACKING**:
- Track iterations through the loop per phase
- Max 3 iterations per phase
- If still failing after 3 iterations, escalate to user

---

### 4c. Update Master Plan

After the phase quality gate passes, update the master plan directly (no subagent needed).

**Actions** (Corvus does this directly):
1. **Mark ALL phase tasks as complete**: `[ ]` → `[x]`
2. **Update progress count** at bottom of document
3. **Update phase status**: `[ ]` → `[x]`
4. **Check for next phase** (respecting phase order)
5. **If more phases remain**, loop back to 4a with next phase (reset fix_iterations = 0)
6. **If all phases complete**, proceed to Phase 5 (Final Validation)

**Why no subagent?**: SUCCESS_EXTRACTION adds overhead without immediate value. 
Learnings are extracted once at Phase 6 for the entire feature instead.

**Exit Criteria**: All phases complete, proceed to Phase 5.

---
name: corvus-phase-2
description: Planning (Phase 2), User Approval (Phase 3), and optional High Accuracy Plan Review (Phase 3.5)
---

## Phase 2: PLANNING (MANDATORY)

**Goal**: Create comprehensive master plan with task files.

### Step 1: Ask Test Preference (MANDATORY)

<critical_rule priority="9999">
BEFORE invoking task-planner, you MUST call the `question()` tool to ask the user
about test preference. Do NOT skip this step. Do NOT assume a default.
This is the FIRST thing you do when this skill is loaded.
</critical_rule>

Invoke the `question()` tool with these exact parameters:

- question: "Should I generate and run tests for this feature?"
- options:
  1. label: "Yes (recommended)", description: "Generate test tasks and run tests in quality gates"
  2. label: "No — skip tests", description: "Skip test generation, quality gates use acceptance-only mode"

Store the result as `tests_enabled: true` (if "Yes") or `tests_enabled: false` (if "No").
Pass this to task-planner via the `**TEST PREFERENCE**` field in the delegation template below.

### Step 2: Create Master Plan

<mandatory>
This phase is NOT optional. You MUST invoke the task-planner subagent to create:
1. `.corvus/tasks/[feature-name]/MASTER_PLAN.md` - The execution tracking document
2. Individual task files with detailed implementation steps

DO NOT:
- Summarize findings and ask "should I proceed?"
- Ask the user to approve a verbal/informal plan
- Skip to implementation discussions
- Present your own plan without invoking task-planner

INSTEAD:
- Immediately invoke task-planner after Phase 1 completes
- Wait for task-planner to create the actual files
- Only then proceed to Phase 3 to present the created plan for approval
</mandatory>

Invoke **task-planner** with combined context from Phase 1:

```markdown
**TASK**: Create master plan for [feature description]

**EXPECTED OUTCOME**:
- Master plan document at `.corvus/tasks/[feature-name]/MASTER_PLAN.md`
- Individual task files at `.corvus/tasks/[feature-name]/NN-task-name.md`

**USER REQUIREMENTS (IMMUTABLE)**:
[Paste the "User Requirements (Immutable)" section from requirements-analyst output]
⚠️ These MUST be incorporated into MASTER_PLAN.md and all relevant task files.
⚠️ Do NOT substitute with alternatives unless user explicitly approves.

**TEST PREFERENCE**: `tests_enabled: [true/false]` (from Corvus question() tool — see "Test Preference" step)
- When `true`: Generate test tasks, include test sections in task files (default behavior)
- When `false`: Do NOT generate test tasks, omit test sections from task files

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
- Include validation commands for each task using correct environment (venv, package manager)
- Estimate effort for each task and phase
- Group related tasks into logical phases
- Respect `tests_enabled` flag: generate test tasks only when `true`

**MUST NOT DO**:
- Skip the master plan document
- Create tasks without acceptance criteria
- Create tasks without validation commands
- Use generic commands (python, pytest, npm) - always use project environment

**REPORT BACK**:
- Path to master plan document
- List of task files created
- Total estimated effort
- Recommended execution order
- Any concerns or risks
```

**Exit Criteria**: Master plan document exists with all task files created.

---

## Phase 3: USER APPROVAL

**Goal**: Get user approval for the MASTER_PLAN.md created in Phase 2.

**Prerequisites** (verify before proceeding):
- [ ] Phase 2 is complete
- [ ] `.corvus/tasks/[feature]/MASTER_PLAN.md` file exists
- [ ] Individual task files exist in `.corvus/tasks/[feature]/`

If prerequisites are NOT met, go back to Phase 2 and invoke task-planner.

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
| 2 | [Name] | [N] | [effort] | [Brief description] |

### Key Changes

**Files to Modify**:
- `[file1]` - [what changes]
- `[file2]` - [what changes]

**Files to Create**:
- `[file1]` - [purpose]

### Risks & Mitigations
- [Risk 1] - [Mitigation]
- [Risk 2] - [Mitigation]

### Master Plan Location
`.corvus/tasks/[feature-name]/MASTER_PLAN.md`

```

<critical_rule priority="9999">
AFTER presenting the plan summary above, you MUST call the question tool. 
Do NOT write the options as text. Do NOT ask the user to type a response.
You MUST invoke the question tool directly with these exact parameters:

- question: "Ready to proceed with this plan?"
- header: "Implementation Plan"
- options:
  1. label: "Start Implementation", description: "Approve the plan and begin Phase 4 immediately"
  2. label: "High Accuracy Review", description: "Approve the plan and run plan-reviewer to validate it first"
  3. label: "Request Changes", description: "Go back to planning with feedback"
</critical_rule>

**Decision Point** (based on user's selection):
- "Start Implementation" → Proceed to Phase 4
- "High Accuracy Review" → Proceed to Phase 3.5
- "Request Changes" → Return to Phase 2 with feedback

**Exit Criteria**: User selects an option via the question tool.

---

## Phase 3.5: HIGH ACCURACY PLAN REVIEW (Optional)

**Goal**: Validate plan quality before implementation begins.

**When**: User chose "High Accuracy Review" after Phase 3 approval.

**Prerequisites**: Phase 3 complete (user approved plan).

### Invoke plan-reviewer

**DELEGATE TO**: @plan-reviewer

```markdown
**TASK**: Review implementation plan for [feature name]

**MASTER PLAN**: `.corvus/tasks/[feature]/MASTER_PLAN.md`
**TASK FILES**: `.corvus/tasks/[feature]/*.md`

**MUST DO**:
- Review all task files for executability
- Verify file references exist in codebase
- Check dependency graph for issues
- Verify acceptance criteria are binary
- Render binary OKAY/REJECT verdict

**MUST NOT DO**:
- Modify any files
- Suggest alternative approaches (unless current approach is broken)
- Reject for style preferences
- Cite more than 3 blocking issues

**REPORT BACK**:
- **PLAN REVIEW GATE STATUS**: OKAY / REJECT
- Review summary (4 criteria)
- Blocking issues (if REJECT, max 3)
- Non-blocking notes (optional)
```

### Decision Point after Phase 3.5

**If OKAY**:
→ Present review results to user and ask for confirmation before proceeding.

Report the review summary to the user:
```markdown
## Plan Review: OKAY ✅

The plan passed high-accuracy review. All criteria met.

**Review Summary**:
[Paste plan-reviewer's summary of the 4 criteria here]

**Non-blocking Notes** (if any):
[Paste any non-blocking notes from plan-reviewer]
```

Then you MUST call the question tool (do NOT write the options as text):

- question: "Plan review passed. Ready to begin implementation?"
- header: "Review Complete"
- options:
  1. label: "Start Implementation", description: "Begin Phase 4 — the plan is validated"
  2. label: "Re-run Review", description: "Run the high accuracy review again"

**User chooses "Start Implementation"** → Proceed to Phase 4
**User chooses "Re-run Review"** → Phase 3.5 again

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

2. Present updated plan to user with choice using the `question()` tool:
```markdown
## Plan Updated After Review

The plan-reviewer found [N] blocking issue(s). Task-planner has addressed them:

### Issues Fixed
1. **[Issue title]**: [How it was fixed]
```

Then you MUST call the question tool (do NOT write the options as text):

- question: "Plan has been updated based on review feedback. How would you like to proceed?"
- header: "Next Step"
- options:
  1. label: "Re-run Review", description: "Run plan-reviewer again on the updated plan"
  2. label: "Start Implementation", description: "Begin Phase 4 with the current plan"

**User chooses "Re-run Review"** → Phase 3.5 again
**User chooses "Start Implementation"** → Phase 4

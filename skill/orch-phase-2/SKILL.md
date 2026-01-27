---
name: orch-phase-2
description: Planning (Phase 2) and User Approval (Phase 3)
---

## Phase 2: PLANNING (MANDATORY)

**Goal**: Create comprehensive master plan with task files.

<mandatory>
This phase is NOT optional. You MUST invoke the task-planner subagent to create:
1. `tasks/[feature-name]/MASTER_PLAN.md` - The execution tracking document
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
- Master plan document at `tasks/[feature-name]/MASTER_PLAN.md`
- Individual task files at `tasks/[feature-name]/NN-task-name.md`

**USER REQUIREMENTS (IMMUTABLE)**:
[Paste the "User Requirements (Immutable)" section from requirements-analyst output]
⚠️ These MUST be incorporated into MASTER_PLAN.md and all relevant task files.
⚠️ Do NOT substitute with alternatives unless user explicitly approves.

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
- [ ] `tasks/[feature]/MASTER_PLAN.md` file exists
- [ ] Individual task files exist in `tasks/[feature]/`

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
`tasks/[feature-name]/MASTER_PLAN.md`

---

**Approve to begin implementation?**
(After approval, I will execute all phases autonomously and report back when complete.)
```

**Decision Point**:
- User approves -> Proceed to Phase 4
- User requests changes -> Return to Phase 2 with feedback
- User rejects -> Stop and ask for guidance

**Exit Criteria**: Explicit user approval received.

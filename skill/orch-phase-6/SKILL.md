---
name: orch-phase-6
description: Completion - success extraction and final summary
---

## Phase 6: COMPLETION

**Goal**: Extract learnings and summarize the work.

### 6a. Success Learning Extraction (ONCE for entire feature)

**DELEGATE TO**: @task-planner

**MODE**: LEARNING (SUCCESS_EXTRACTION)

```markdown
**TASK**: Extract learnings from completed feature

**MODE**: LEARNING

**TRIGGER**: SUCCESS_EXTRACTION

**COMPLETED FEATURE**: [feature name]

**ALL PHASES COMPLETED**:
- Phase 1: [tasks] - [brief summary]
- Phase 2: [tasks] - [brief summary]
- ...

**IMPLEMENTATION SUMMARY**:
- Total files created/modified: [count]
- Total effort: [actual vs estimated]
- Iterations needed: [count across all phases]
- Key challenges overcome: [list]

**MUST DO**:
- Extract reusable components created across ALL phases
- Document patterns discovered
- Assess overall estimate accuracy
- Note what could be improved for future similar features
- Update MASTER_PLAN.md Learnings Log

**REPORT BACK**:
- Reusable components (with file paths)
- Patterns discovered
- Estimate accuracy analysis
- Recommendations for future
```

### 6b. Final Summary

Present final summary to user:

```markdown
## Implementation Complete

**Feature**: [Name]
**Status**: [x] Complete

### Summary
[1-2 sentence summary of what was implemented]

### Changes Made

**Files Modified** ([N] files):
- `[file1]` - [summary of changes]
- `[file2]` - [summary of changes]

**Files Created** ([N] files):
- `[file1]` - [purpose]

### Validation Results
- [x] All tests passing ([N] tests)
- [x] Build successful
- [x] All acceptance criteria met

### Task Documentation
- Master plan: `.orchestrator/tasks/[feature]/MASTER_PLAN.md`
- Task files: `.orchestrator/tasks/[feature]/*.md`

### Follow-up Suggestions (optional)
- [Suggestion 1]
- [Suggestion 2]

---

**What's next?** If you need changes to this implementation:
- Small fixes (< 3 files): I'll update the plan and delegate directly
- Larger additions: I'll explore scope and update the plan for approval
- New features: I'll start a fresh workflow
```

**Final Actions**:
1. Mark MASTER_PLAN.md status as `[x] Complete`
2. Mark all todos as complete
3. Provide summary to user

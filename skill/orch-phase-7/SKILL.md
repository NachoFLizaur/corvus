---
name: orch-phase-7
description: Follow-up triage - handling requests after feature completion
---

## Phase 7: FOLLOW-UP TRIAGE

**When**: After Phase 6 completes and user makes a new request in the same session.

**Goal**: Assess the new request and route it appropriately without abandoning the structured workflow.

### Triage Decision Tree

```
New request received after completion
    |
    ├─ Is this related to the just-completed feature?
    │   │
    │   ├─ YES, small fix/tweak (< 3 files, clear scope)
    │   │   └─ LIGHTWEIGHT PATH
    │   │
    │   └─ YES, significant addition (3+ files or unclear scope)
    │       └─ PARTIAL RESTART
    │
    └─ NO, this is a new/different feature
        └─ FULL RESTART
```

### Triage Assessment

When a follow-up request comes in, first assess:

```markdown
## Follow-up Triage

**Request**: [user's request]
**Related to previous work?**: [yes/no]
**Scope assessment**:
- Files likely affected: [count]
- Complexity: [trivial/small/significant/large]
- Existing task coverage: [fully covered/partially/not covered]

**Routing decision**: [LIGHTWEIGHT / PARTIAL RESTART / FULL RESTART]
**Reasoning**: [brief justification]
```

### LIGHTWEIGHT PATH (Small Follow-ups)

For small, clearly-scoped changes (< 3 files) to the just-completed work:

1. **Update MASTER_PLAN.md** via task-planner:
   ```markdown
   **TASK**: Update existing master plan with follow-up task
   
   **MASTER PLAN**: `tasks/[feature]/MASTER_PLAN.md`
   
   **NEW TASK TO ADD**:
   - Description: [what needs to be done]
   - Files affected: [list]
   - Add to: [existing phase or new "Follow-up Fixes" phase]
   
   **MUST DO**:
   - Preserve all existing task statuses
   - Add new task with [ ] status
   - Update progress counts
   - Create individual task file if needed
   ```

2. **Delegate to code-implementer**:
   ```markdown
   **TASK**: [description of the fix/change]
   
   **TASK FILE**: `tasks/[feature]/[NN-task].md` (if created)
   
   **CONTEXT**:
   - Follow-up to: `tasks/[feature]/MASTER_PLAN.md`
   - Related to task(s): [list if applicable]
   
   **DELEGATED MODE**: Yes (continuation of approved work)
   
   **MUST DO**:
   - [specific requirements]
   - Validate changes (type check, lint, tests)
   
   **REPORT BACK**:
   - Files changed
   - Validation results
   ```

3. **Validate with code-quality** (if significant changes)

4. **Update MASTER_PLAN.md**: Mark task complete via task-planner

### PARTIAL RESTART (Significant Additions)

For larger additions (3+ files) that build on completed work:

1. **Phase 1b only**: Invoke code-explorer to understand new scope
2. **Phase 2**: Invoke task-planner to update existing MASTER_PLAN.md with new phase/tasks
3. **Phase 3**: Present additions for user approval
4. **Phase 4-6**: Execute new tasks through normal flow

### FULL RESTART (New Feature)

For unrelated work:

1. Acknowledge the previous work is complete
2. Start fresh from Phase 0 with the new feature
3. Create new `tasks/[new-feature]/` directory
4. Follow complete workflow

### Key Principles for Follow-ups

1. **Never skip triage** - Always assess before acting
2. **Never write code directly** - All changes through subagents
3. **Always update MASTER_PLAN.md** - Even small fixes get tracked
4. **Preserve history** - Don't reset completed task statuses
5. **Lightweight doesn't mean sloppy** - Still validate and document

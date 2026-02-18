---
name: corvus-extras
description: Extra utilities - subagent reference, todo patterns, error handling
---

## SUBAGENT REFERENCE

| Phase | Subagent | Purpose | Approval Needed |
|-------|----------|---------|-----------------|
| 0a | requirements-analyst | Initial request analysis | No |
| 0b | requirements-analyst | Post-discovery analysis | No |
| 1a | researcher | External docs, best practices | No |
| 1b | code-explorer | Codebase analysis | No |
| 2 | task-planner | Create master plan + task files | No (creates plan) |
| 3.5 | plan-reviewer | High accuracy plan review (if user chose) | No (optional) |
| 3.5 fail | task-planner | Fix plan based on review feedback | No |
| 4a | code-implementer | Implementation + lint/typecheck/build | No (delegated mode) |
| 4b | code-quality | Run tests, verify acceptance criteria | No |
| 4b fail | task-planner | FAILURE_ANALYSIS (learning mode) | No |
| 4c | (Corvus) | Update plan directly | N/A (no subagent) |
| 5a | code-quality | Final comprehensive test run | No |
| 5b | ux-dx-quality | Subjective validation (if required) | No (if required) |
| 6a | task-planner | SUCCESS_EXTRACTION (once, entire feature) | No |

### Invoking Subagents

Use the Task tool with `subagent_type` parameter:

```javascript
task(
  subagent_type: "code-explorer",
  description: "Analyze auth module",
  prompt: "**TASK**: Analyze codebase..."
)
```

### Parallel Invocation

When subagents are independent (Phase 1), invoke them in the same message:

```javascript
// These run in parallel
task(subagent_type: "researcher", description: "Research JWT", prompt: "...")
task(subagent_type: "code-explorer", description: "Explore auth", prompt: "...")
```

---

## TODO TRACKING

Use TodoWrite to track progress at the **phase level**:

### Phase 0a/0b
```javascript
todowrite([
  { id: "clarify-initial", content: "Initial requirements analysis", status: "in_progress", priority: "high" }
])
```

After requirements-analyst returns:
```javascript
// If QUESTIONS_NEEDED
todowrite([
  { id: "clarify-initial", content: "Initial requirements analysis - awaiting user answers", status: "pending", priority: "high" }
])

// If REQUIREMENTS_CLEAR (skip to Phase 2)
todowrite([
  { id: "clarify-initial", content: "Initial requirements analysis", status: "completed", priority: "high" },
  { id: "planning", content: "Create master plan", status: "in_progress", priority: "high" }
])

// If DISCOVERY_NEEDED
todowrite([
  { id: "clarify-initial", content: "Initial requirements analysis", status: "completed", priority: "high" },
  { id: "discovery", content: "Discovery phase", status: "in_progress", priority: "high" }
])
```

### Phase 1
```javascript
todowrite([
  { id: "research", content: "Research [topic]", status: "in_progress", priority: "high" },
  { id: "explore", content: "Explore codebase", status: "in_progress", priority: "high" },
  { id: "plan", content: "Create master plan", status: "pending", priority: "high" }
])
```

### Phase 4 (Phase-Level Tracking)

During Phase 4, track at PHASE level, not step level:

**Starting a New Phase**:
```javascript
todowrite([
  // Previous completed phases...
  { id: "phase-1", content: "Phase 1: Foundation (Tasks 01-02)", status: "completed", priority: "high" },
  { id: "phase-2", content: "Phase 2: Core Implementation (Tasks 03-07)", status: "in_progress", priority: "high" },
  { id: "phase-3", content: "Phase 3: Integration (Tasks 08-10)", status: "pending", priority: "high" },
])
```

**After Phase Completes**:
```javascript
todowrite([
  { id: "phase-1", content: "Phase 1: Foundation (Tasks 01-02)", status: "completed", priority: "high" },
  { id: "phase-2", content: "Phase 2: Core Implementation (Tasks 03-07)", status: "completed", priority: "high" },
  { id: "phase-3", content: "Phase 3: Integration (Tasks 08-10)", status: "in_progress", priority: "high" },
])
```

### Phase 5 (Final Validation)
```javascript
todowrite([
  // All implementation phases completed...
  { id: "phase-5a", content: "Phase 5a: Final objective validation", status: "in_progress", priority: "high" },
  { id: "phase-5b", content: "Phase 5b: Final UX/DX review", status: "pending", priority: "high" },
])
```

**Why Phase-Level Tracking**:
- Reduces todo noise
- Matches the per-phase execution model
- User sees meaningful progress (phases, not steps)
- Prevents "what phase am I on?" errors

---

## ERROR HANDLING

### Implementation Errors

When code-implementer reports an error:

1. **Analyze** - Understand the error and its cause
2. **Propose fix** - Determine the correction needed
3. **Send fix request** - Instruct code-implementer to fix
4. **Re-validate** - Run code-quality again
5. **Iterate** - Max 3 attempts, then escalate to user

### Validation Failures

When code-quality reports failures:

1. **Categorize** - Is it a test failure, build error, or criteria miss?
2. **Create specific fix** - Target the exact issue
3. **Track iterations** - Don't loop infinitely
4. **Escalate if stuck** - After 3 attempts, ask user

### Fundamental Issues

If the entire approach is wrong:

1. **Stop implementation** immediately
2. **Report to user** with clear explanation
3. **Propose alternatives** (2-3 options)
4. **Wait for guidance** before continuing

```markdown
## Approach Issue Detected

**Problem**: [Clear description of the fundamental issue]

**Why This Matters**: [Impact if we continue]

**Options**:
1. [Alternative approach 1] - [tradeoffs]
2. [Alternative approach 2] - [tradeoffs]  
3. [Abort and start fresh]

**My Recommendation**: [Which option and why]

**Awaiting your guidance.**
```

---
name: corvus-extras
description: Extra utilities - subagent reference, todo patterns, error handling
---

## SUBAGENT REFERENCE

Canonical reference for all 16 agents in the corvus-ai suite. Orchestrators keep only a minimal name + purpose list and point here for the full reference.

### Workflow Suite

| Agent | Purpose | Invocation Notes |
|-------|---------|------------------|
| corvus | Interactive workflow orchestrator (Phases 0-7) | Primary agent — not invoked as a subagent |
| corvus-auto | Autonomous workflow orchestrator | Primary agent — zero questions (`question: deny`); local-only completion by default, guarded opt-in Git delivery |
| requirements-analyst | Request analysis, gap identification, clarifying questions | Phase 0a (initial) and 0b (post-discovery); returns REQUIREMENTS_CLEAR / QUESTIONS_NEEDED / DISCOVERY_NEEDED |
| researcher | External docs, best practices, library/API research | Phase 1a; run in parallel with code-explorer |
| code-explorer | Codebase analysis, architecture, patterns, environment detection | Phase 1b; run in parallel with researcher |
| task-planner | Creates/updates planning files through constrained planning and learning modes | Phase 2 (plan), Phase 3.5-fail (fix plan), Phase 4b-fail (FAILURE_ANALYSIS), Phase 4c (PROGRESS_UPDATE), Phase 6a (SUCCESS_EXTRACTION) |
| plan-reviewer | High-accuracy plan review → OKAY / REJECT | Phase 3.5, only if the user chose plan review |
| code-implementer | Implementation + task/workflow-authorized validation | Phase 4a; delegated mode with a task-file path |
| code-quality | Tests, build validation, acceptance criteria → quality gate | Phase 4b (per phase) and Phase 5a (final, full suite) |
| ux-dx-quality | Subjective quality: UX, DX, docs, architecture | Phase 5b, only when a task required UX/DX review |

### Workflow Ownership and Gate Contracts

| Milestone | Owner | Contract |
|-----------|-------|----------|
| Phase 4a | code-implementer (one invocation per task) | Implements the approved task and performs only the validation authorized by its task and active workflow mode. |
| Phase 4b | code-quality | Runs the phase-level objective gate and returns binary `PASS` or `FAIL`. |
| Phase 4c | task-planner (`PROGRESS_UPDATE`), with Corvus validating the result | After a 4b `PASS`, updates only authorized planning progress; Corvus verifies diff confinement before routing onward and blocks on update failure. |
| Phase 5a | code-quality | Runs the final objective gate with binary `PASS` or `FAIL`; in deferred mode this is the first full test-suite run. |
| Phase 5b | ux-dx-quality | Returns exactly `PASS`, `NEEDS_IMPROVEMENT`, or `CRITICAL_ISSUES` for subjective quality. |
| Phase 6 | task-planner, then Corvus orchestrator | Runs feature-level `SUCCESS_EXTRACTION` once, then presents the final summary. |

Objective quality gates (4b and 5a) are binary. Only the subjective 5b gate is
three-valued: `PASS` proceeds, `NEEDS_IMPROVEMENT` records non-blocking
recommendations and proceeds, and `CRITICAL_ISSUES` enters scoped fixing and
revalidation. Phase 6 alone owns `SUCCESS_EXTRACTION`.

### Review Suite

| Agent | Purpose | Invocation Notes |
|-------|---------|------------------|
| corvus-review | Interactive multi-pass PR review orchestrator | Primary agent; review phases R0-R5 |
| corvus-review-auto | Autonomous PR review | Primary agent — zero questions (`question: deny`); auto-posts review |
| pr-context-gatherer | PR context: diffs, file maps, dependencies, conventions | Dispatched in R1 |
| pr-code-reviewer | Mechanically read-only architecture, correctness, and conventions detection | R2 only; uses read/glob/grep and reports all findings for R3 synthesis |
| security-reviewer | Security analysis (OWASP/CWE, taint analysis, secrets) | Dispatched in R2 |
| pr-comment-writer | Posts formatted reviews to GitHub with error recovery | Dispatched in R5 |

Review-suite schemas and detailed reference: corvus-review-extras skill.

### Invoking Subagents

Use the Task tool with `subagent_type`. Invoke independent subagents in the same message to run them in parallel (e.g., Phase 1):

```javascript
// These run in parallel
task(subagent_type: "researcher", description: "Research JWT", prompt: "**TASK**: ...")
task(subagent_type: "code-explorer", description: "Explore auth", prompt: "**TASK**: ...")
```

---

## TODO TRACKING

Track progress with TodoWrite at the phase level — phases, not steps. This matches the per-phase execution model, keeps progress meaningful to the user, and prevents "what phase am I on?" errors.

Update todos at milestones: when a phase starts (in_progress), when it completes (completed), and when a gate changes routing (e.g., QUESTIONS_NEEDED → keep the analysis todo pending until the user answers).

Example (Phase 4, phase-level):

```javascript
todowrite([
  { id: "phase-1", content: "Phase 1: Foundation (Tasks 01-02)", status: "completed", priority: "high" },
  { id: "phase-2", content: "Phase 2: Core Implementation (Tasks 03-07)", status: "in_progress", priority: "high" },
  { id: "phase-3", content: "Phase 3: Integration (Tasks 08-10)", status: "pending", priority: "high" },
])
```

---

## ERROR HANDLING

### Recoverable Errors (implementation or validation failures)

1. **Categorize** — test failure, build error, or acceptance-criteria miss
2. **Send a targeted fix request** to code-implementer for the exact issue
3. **Re-validate** with code-quality
4. **Track iterations** — after 3 failed attempts, stop and escalate to the user with results so far and open questions

### Fundamental Issues

If the entire approach is wrong: stop implementation, report to the user, propose 2-3 alternatives, and wait for guidance.

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

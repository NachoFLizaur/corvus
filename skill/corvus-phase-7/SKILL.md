---
name: corvus-phase-7
description: Follow-up triage - handling requests after feature completion
---

## Phase 7: FOLLOW-UP TRIAGE

**When**: After Phase 6 completes and the user makes a new request — in the same session, or in a new session where resume detection (orchestrator rule `resume_detection`) found the feature's MASTER_PLAN marked `[x] Complete`.

**Goal**: Assess the new request and route it appropriately without abandoning the structured workflow. Triage every follow-up before acting, and route all changes through subagents.

### Triage Decision Tree

```
New request received after completion
    |
    ├─ Does the request reference a plan still marked [~] In Progress?
    │   └─ YES → RESUME (hand back to the orchestrator's resume flow:
    │            first incomplete step, re-run last gate unless recorded PASS —
    │            this is unfinished work, not a follow-up)
    │
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

```markdown
## Follow-up Triage

**Request**: [user's request]
**Related to previous work?**: [yes/no]
**Scope assessment**:
- Files likely affected: [count]
- Complexity: [trivial/small/significant/large]
- Existing task coverage: [fully covered/partially/not covered]

**Routing decision**: [RESUME / LIGHTWEIGHT / PARTIAL RESTART / FULL RESTART]
**Reasoning**: [brief justification]
```

### RESUME (Unfinished Work)

A request referencing a plan still marked `[~] In Progress` is unfinished work, not a follow-up: hand it back to the orchestrator's resume flow (the `resume_detection` rule and RESUME section), which re-enters at the first incomplete step and re-runs the last quality gate unless MASTER_PLAN.md records its PASS with evidence.

### EXTERNAL REVIEW REMEDIATION

External-review findings, including PR-review threads, use a dedicated fast path
when they are small and crisply specified. First verify every finding empirically;
do not treat reviewer reasoning as proof.

Before dispatch, classify each verified finding as (a) self-contained or (b) an
instance of a defect class.
Class-instances get one dispatch per CLASS (root cause + all siblings), never one dispatch per finding.
Determine the class by tracing the reported symptom to its root cause and grepping for sibling instances. Build the
exact file allowlist from the root cause and all siblings, not merely the review's
reported files; findings whose root cause lies outside those files still get fixed
at the root cause. If that class exceeds the fast path's size or requires a design
decision, route the whole class through standard planning rather than splitting it
into finding-sized patches.

Use **REVIEW-FIX ROUND MODE** only when each finding affects approximately three
files or fewer and the fix shape is stated by the reviewer or has been confirmed
by a direct probe. Dispatch code-implementer directly with the verified findings,
exact file allowlist, and validation contract — no task-planner plan and no
plan-reviewer ceremony. The dispatch names the Defect-Fix Protocol and presents
each finding as a symptom report, not a prescribed edit.
Then run the full-suite gate, commit through the existing
delivery flow, and disposition the PR threads.
Smallness alone is insufficient if the fix requires an API, security, architecture,
or product-design decision.

Use standard planning for findings that require design decisions, have cross-
cutting effects, or lack an empirically established fix shape.

#### Cross-Round Remediation Stop Rule

Track defect class and apparatus lineage across EXTERNAL review rounds, including
PR reviews. When N=2 consecutive rounds find the same defect class or find defects
in apparatus introduced by earlier rounds, stop before another symptom fix. The
default flips to root-cause analysis: identify the single underlying decision
point, trace it, and evaluate reverting or simplifying prior apparatus before any
further code-implementer dispatch. A new review round does not reset this rule.

#### Finding Disposition and Thread Replies

After remediation, disposition every finding on the PR:

- Fixed → reply in its review thread with the fixing commit reference.
- Declined → reply in its review thread with the rationale.

A declined finding without a posted reply is unfinished work. Verify that every
finding has exactly one posted disposition before declaring the review-fix round
complete. Thread posting uses existing `gh` allowlists through the selected
delivery flow; this skill delegates the replies and does not add writer
permissions.

### LIGHTWEIGHT PATH (Small Follow-ups)

For small, clearly-scoped changes (< 3 files) to the just-completed work. Lightweight still means validated and documented — every change is tracked in MASTER_PLAN.md.

1. **Update MASTER_PLAN.md** via task-planner:
   ```markdown
   **TASK**: Update existing master plan with follow-up task

   **MASTER PLAN**: `.corvus/tasks/[feature]/MASTER_PLAN.md`

   **NEW TASK TO ADD**:
   - Description: [what needs to be done]
   - Files affected: [list]
   - Add to: [existing phase or new "Follow-up Fixes" phase]

   **MUST DO**:
   - Preserve all existing task statuses (completed history stays intact)
   - Add new task with [ ] status
   - Update progress counts
   - Create individual task file if needed
   ```

2. **Delegate to code-implementer**:
   ```markdown
   **TASK**: [description of the fix/change]

   **TASK FILE**: `.corvus/tasks/[feature]/[NN-task].md` (if created)

   **CONTEXT**:
   - Follow-up to: `.corvus/tasks/[feature]/MASTER_PLAN.md`
   - Related to task(s): [list if applicable]

   **DELEGATED MODE**: Yes (continuation of approved work)

   **MUST DO**:
   - [specific requirements]
   - Validate changes: type check, lint, and tests if `tests_enabled: true`. Follow-ups run tests inline regardless of the original `tests_deferred` setting — the full suite was already validated in Phase 5

   **REPORT BACK**:
   - Files changed
   - Validation results
   ```

3. **Validate with code-quality** if changes are significant (same test rule as step 2: run tests, or acceptance-only when `tests_enabled: false`)

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
3. Create new `.corvus/tasks/[new-feature]/` directory
4. Follow complete workflow

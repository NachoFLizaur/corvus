---
name: corvus-phase-6
description: Completion - success extraction and final summary
---

## Phase 6: COMPLETION

**Goal**: Extract learnings and summarize the work.

### 6a. Success Learning Extraction (once for the entire feature)

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
- Changed-file manifest: [pointer to verified manifest]
- Total effort: [actual vs estimated]
- Remediation history: [pointer to progress/gate records]
- Key challenges overcome: [list]

**MUST DO**:
- Extract reusable components created across ALL phases
- Document patterns discovered
- Assess overall estimate accuracy
- Note what could be improved for future similar features
- Append distilled learnings to `.corvus/tasks/learnings.md` (feature/date header, terse bullets) and leave a one-line pointer in MASTER_PLAN.md's Learnings Log

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

**Files Modified**:
- `[file1]` - [summary of changes]
- `[file2]` - [summary of changes]

**Files Created**:
- `[file1]` - [purpose]

### Validation Results

When `tests_enabled: true, tests_deferred: false`:
- [x] Suite result verified — re-derive from the recorded validation command
- [x] Build successful
- [x] All acceptance criteria met

When `tests_enabled: true, tests_deferred: true`:
- [x] Deferred suite result verified — re-derive from the Phase 5 command
- [x] Build successful
- [x] All acceptance criteria met

When `tests_enabled: false`:
- [x] All acceptance criteria verified (acceptance-only mode)
- [x] Build successful

### Task Documentation
- Master plan: `.corvus/tasks/[feature]/MASTER_PLAN.md`
- Task files: `.corvus/tasks/[feature]/*.md`

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

### Review Thread Disposition

When the completed work remediates a PR review, disposition every finding on the
PR before delivery is complete. Reply to fixed findings with the fixing commit
reference; reply to declined findings with the rationale. A declined finding with
no posted reply is unfinished work. Verify all replies through the existing `gh`
delivery allowlists; delegate posting through the delivery flow rather than adding
writer permissions here.

All `gh` text bodies—thread replies, comments, reviews, and PR bodies—travel
exclusively via `--body-file` or a tool-managed stdin channel; never place a text
body inline in a shell string, especially one containing code spans, backticks, or
`$`. For every paginated GitHub list query, compare the number of retrieved items
with `totalCount` and continue pagination until they match; never treat the result
as complete before that check passes.

### Pre-Delivery Adversarial Sweep

Before opening a PR, dispatch one bounded @code-quality review that runs the
reviewer's playbook against the final tree:

1. Grep every doc or docblock claim introduced by THIS feature that quotes a
   value, default, count, or behavior, and compare it with its source.
2. Trace every new signal introduced by THIS feature end-to-end from producer to
   every consumer.
3. Diff every stated default introduced by THIS feature against the actual
   default.

This is feature-scoped, not a repo-wide audit. Fix every finding before the PR
opens and mechanically recheck the affected claim, signal, or default after its
fix.

### Git Delivery Checklist (when delivery is selected)

PR bodies are terse records: prose carries no literal counts or superlatives.
Express machine-checkable claims as assertions or re-derivation commands (for
example, “re-derive from the suite”) and point to validation evidence instead of
copying it. Whenever the diff changes after the PR body was written (new commit,
deletion, or retarget), re-derive every factual PR-body claim from the current diff
before push or PR update; never hand-patch the body incrementally.

The beta.14 re-derive rule fires on EVERY push to a branch with an open PR:
regenerate the PR body wholesale from the current diff, never string-patch it,
and post it only through `--body-file` or a tool-managed stdin channel.

- [ ] Revalidate the current base, head, and complete diff immediately before delivery.
- [ ] Generate the PR body from that current diff and its final validation evidence.
- [ ] If the diff changed after body generation, discard the stale body and regenerate it wholesale before push or PR update.
- [ ] On every push with an open PR, regenerate and post the whole current-diff body before declaring delivery complete.

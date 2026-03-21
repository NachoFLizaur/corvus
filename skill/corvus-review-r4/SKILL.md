---
name: corvus-review-r4
description: PR Review Phase R4 - User gate (interactive mode) or auto-proceed (autonomous mode)
---

# Phase R4: USER GATE

**Goal**: Present the review to the user for approval before posting, or auto-proceed in autonomous mode.

**Executor**: Corvus-Review direct (no subagent delegation).

**Input**: `PR_CONTEXT` (from R0) + `REVIEW_DOCUMENT` (from R3).

**Output**: `REVIEW_ACTION` object (see `corvus-review-extras` for schema).

---

## MODE SELECTION

```
if PR_CONTEXT.config.autonomous == true:
    → AUTONOMOUS MODE (auto-proceed)
else:
    → INTERACTIVE MODE (user gate)
```

---

## INTERACTIVE MODE

### Step 1: Present Review Preview

Display the full review to the user BEFORE posting:

```markdown
## Review Preview: PR #[pr_number] — [title]

**Action**: [ACTION_EMOJI] [action]
**Reason**: [action_reasoning]

---

### Summary

[review_body — the full rendered review summary]

---

### Inline Comments ([N] total)

[For each inline comment, show a preview:]

#### [path]:[line]
> **[label]** ([pass]): [title]
> [First 2 lines of body...]

[If more than 10 inline comments, show first 10 and note "and N more..."]

---

**Total**: [stats.total_findings] findings | [stats.blockers] blockers | [stats.nits_shown] nits ([stats.nits_suppressed] suppressed)
```

### Step 2: User Decision

<critical_rule priority="9999">
  You MUST invoke the `question()` tool for the user decision.
  NEVER present options as text. The question tool renders interactive buttons.
</critical_rule>

Invoke the `question()` tool with:

- question: "How would you like to proceed with this review?"
- header: "PR Review: #[pr_number]"
- options:
  1. label: "Post Review", description: "Post to GitHub as [ACTION] with [N] inline comments"
  2. label: "Edit Comments", description: "Modify findings before posting (add, remove, or edit)"
  3. label: "Save Locally", description: "Don't post to GitHub. Display full review in terminal only"
  4. label: "Re-run Review", description: "Re-run specific passes with adjusted parameters"

### Step 3: Handle User Decision

#### Option A: "Post Review"

```yaml
REVIEW_ACTION:
  decision: "post"
  edits: []
  rerun_scope: []
```

→ Proceed directly to R5.

#### Option B: "Edit Comments"

Present an interactive editing flow:

```markdown
## Edit Review Comments

Current findings ([N] total):

[Number each finding:]
1. **[label]** [file]:[line] — [title]
2. **[label]** [file]:[line] — [title]
...

**Available actions**:
- "remove N" — Remove finding #N
- "edit N" — Edit finding #N (I'll ask what to change)
- "add" — Add a new manual finding
- "change action to APPROVE/REQUEST_CHANGES/COMMENT_ONLY"
- "done" — Finish editing and return to post decision
```

After the user provides edits:
1. Apply each edit to the REVIEW_DOCUMENT
2. Re-render the review body with changes
3. Return to Step 2 (present updated review and ask again)

```yaml
REVIEW_ACTION:
  decision: "edit"
  edits: [<modified findings array>]
  rerun_scope: []
```

<critical_rule priority="999">
  After edits, ALWAYS return to Step 2 to re-present the updated review.
  The user must see the final state before posting.
</critical_rule>

#### Option C: "Save Locally"

Display the full review in the terminal without posting:

```markdown
## Full Review (Local Only — Not Posted)

[Complete review_body]

---

### All Inline Comments

[For each inline comment, show full content:]

#### [path]:[line]
**[label]** ([pass]): [title]

[full body]

[suggestion block if present]

---

[Repeat for all comments]

---

**This review was NOT posted to GitHub.**
To post it later, re-run the review or use `gh api` manually.
```

```yaml
REVIEW_ACTION:
  decision: "local_only"
  edits: []
  rerun_scope: []
```

→ Proceed to R5 (which will skip posting and show completion summary only).

#### Option D: "Re-run Review"

Ask which passes to re-run:

Invoke the `question()` tool with:

- question: "Which review passes should be re-run?"
- header: "Re-run Review"
- options:
  1. label: "All Passes", description: "Re-run the complete review from R2"
  2. label: "Architecture Only", description: "Re-run Pass 1: Architecture & Design"
  3. label: "Correctness Only", description: "Re-run Pass 2: Logic & Correctness"
  4. label: "Security Only", description: "Re-run Pass 3: Security"
  5. label: "Conventions Only", description: "Re-run Pass 4: Conventions & Polish"

```yaml
REVIEW_ACTION:
  decision: "rerun"
  edits: []
  rerun_scope: ["<selected passes>"]  # e.g., ["architecture"] or ["correctness", "security"]
```

→ Return to R2 with `rerun_scope`. R2 only re-executes the specified passes,
keeping results from non-rerun passes. Then flow continues R2 → R3 → R4.

<critical_rule priority="999">
  When re-running, track the re-run count. Maximum 2 re-runs.
  After 2 re-runs, remove the "Re-run Review" option from the question tool.
  Display: "Maximum re-runs reached. Please post, edit, or save locally."
</critical_rule>

---

## AUTONOMOUS MODE

When `PR_CONTEXT.config.autonomous == true`:

### Auto-Proceed Rules

1. **Skip the user gate entirely** — no `question()` call
2. Set REVIEW_ACTION:
   ```yaml
   REVIEW_ACTION:
     decision: "auto_post"
     edits: []
     rerun_scope: []
   ```
3. Display a brief notice:
   ```markdown
   ## Autonomous Mode: Auto-posting review
   
   **Action**: [ACTION] | **Findings**: [N] total
   **Posting to GitHub...**
   ```
4. → Proceed directly to R5.

### Autonomous Mode Safety Rail

<critical_rule priority="9999">
  Even in autonomous mode, NEVER auto-post if:
  
  1. All passes errored (review quality is too low)
  2. The review has > 30 inline comments (likely noise — needs human judgment)
  3. The action is REQUEST_CHANGES and ALL findings have confidence < 0.7
     (uncertain review should not block a PR automatically)
  
  In these cases, FALL BACK to interactive mode:
  - Display: "Autonomous mode safety rail triggered: [reason]. Falling back to interactive review."
  - Then execute interactive mode as normal.
</critical_rule>

---

## GATE ENFORCEMENT

<gate id="r4-exit" priority="9999">
  R4 MUST produce a valid REVIEW_ACTION before proceeding to R5.
  
  VALID REVIEW_ACTION requires:
  1. decision is one of: "post", "edit", "local_only", "rerun", "auto_post"
  2. If decision == "edit": edits array is non-empty
  3. If decision == "rerun": rerun_scope is non-empty
  
  If decision == "rerun" → Return to R2 (do NOT proceed to R5)
  If decision == "edit" → Apply edits, return to R4 Step 2 (do NOT proceed to R5)
  All other decisions → Proceed to R5
</gate>

---

## STATE CHECKPOINT

After R4 completes, output:

```
[R4 COMPLETE] Decision: [decision] | Mode: [interactive/autonomous]
[If rerun: → Returning to R2 with scope: [rerun_scope]]
[If post/auto_post: → Proceeding to R5 (Completion)]
[If local_only: → Proceeding to R5 (Local summary only)]
```

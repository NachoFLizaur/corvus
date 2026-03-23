---
name: corvus-review-r5
description: PR Review Phase R5 - Post review to GitHub and display completion summary
---

# Phase R5: COMPLETION

**Goal**: Post the review to GitHub (unless local-only) and display a final summary.

**Executor**: @pr-comment-writer (delegated for posting step).

**Input**: `PR_CONTEXT` (from R0) + `REVIEW_DOCUMENT` (from R3) + `REVIEW_ACTION` (from R4).

**Output**: Posted review on GitHub + completion summary to user.

---

## MODE ROUTING

```
if REVIEW_ACTION.decision == "local_only":
    → SKIP POSTING, go to Completion Summary
    
if REVIEW_ACTION.decision in ["post", "auto_post"]:
    → POST TO GITHUB, then Completion Summary
```

---

## DELEGATION TEMPLATE: @pr-comment-writer

When posting the review to GitHub, delegate to `@pr-comment-writer` with the following:

```markdown
**TASK**: Post PR review to GitHub for PR #[pr_number]

**DELEGATE TO**: @pr-comment-writer

**INPUTS**:
- PR: [owner]/[repo]#[pr_number]
- Event: [APPROVE | REQUEST_CHANGES | COMMENT]
- Review body: [REVIEW_DOCUMENT.review_body]
- Inline comments: [REVIEW_DOCUMENT.inline_comments transformed to GitHub format]

**MUST DO**:
- Use `gh api` to post the review atomically (body + inline comments in one call)
- Handle invalid line recovery (retry without failing comments, append them to body)
- Return the review URL on success
- Fall back to local-only mode on permission or network errors

**MUST NOT DO**:
- Use `gh pr review` (does not support atomic inline comments)
- Retry more than 2 times for line recovery
- Silently drop comments without noting them in the review body

**ON SUCCESS**: Return `{ "status": "posted", "review_url": "<url>" }`
**ON FAILURE**: Return `{ "status": "local_only", "reason": "<error description>" }`
```

---

## STEP 1: POST REVIEW TO GITHUB

### 1a. Prepare API Payload

The GitHub Pull Request Review API requires:

```bash
gh api repos/[owner]/[repo]/pulls/[pr_number]/reviews \
  --method POST \
  --field event="[EVENT]" \
  --field body="[REVIEW_BODY]" \
  --field comments="[INLINE_COMMENTS_JSON]"
```

**EVENT mapping**:

| REVIEW_DOCUMENT.action | GitHub event |
|------------------------|-------------|
| `APPROVE` | `APPROVE` |
| `REQUEST_CHANGES` | `REQUEST_CHANGES` |
| `COMMENT_ONLY` | `COMMENT` |

**REVIEW_BODY**: Use `REVIEW_DOCUMENT.review_body` (the rendered markdown summary).

**INLINE_COMMENTS_JSON**: Transform `REVIEW_DOCUMENT.inline_comments` to GitHub format:

```json
[
  {
    "path": "<file_path>",
    "line": <line_number>,
    "side": "RIGHT",
    "body": "<rendered_comment>"
  }
]
```

For multi-line comments (where `start_line` is not null):
```json
{
  "path": "<file_path>",
  "start_line": <start_line>,
  "line": <line_end>,
  "start_side": "RIGHT",
  "side": "RIGHT",
  "body": "<rendered_comment>"
}
```

### 1b. Execute API Call

<critical_rule priority="9999">
  Use `gh api` for posting. Do NOT use `gh pr review` — it does not support
  inline comments in a single atomic review submission.
</critical_rule>

#### Construct the API call:

For reviews WITH inline comments:

```bash
gh api repos/[owner]/[repo]/pulls/[pr_number]/reviews \
  --method POST \
  -f event="[EVENT]" \
  -f body="$(cat <<'REVIEW_EOF'
[REVIEW_BODY content]
REVIEW_EOF
)" \
  --input <(cat <<'JSON_EOF'
{
  "comments": [
    {
      "path": "src/example.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "**blocker** (correctness): Handle null case\n\nThe `user` parameter can be null when..."
    }
  ]
}
JSON_EOF
)
```

For reviews WITHOUT inline comments (summary only):

```bash
gh api repos/[owner]/[repo]/pulls/[pr_number]/reviews \
  --method POST \
  -f event="[EVENT]" \
  -f body="$(cat <<'REVIEW_EOF'
[REVIEW_BODY content]
REVIEW_EOF
)"
```

### 1c. Handle API Response

**Success** (HTTP 200):
```markdown
Review posted successfully.
```
Extract the review URL from the response for the completion summary.

**Failure Handling**:

| Error | Action |
|-------|--------|
| HTTP 422 (Validation failed) | Parse error. Common: invalid line number, file not in diff. Fix the offending comment and retry WITHOUT it. |
| HTTP 403 (Forbidden) | User lacks permission. Display error and fall back to local-only mode. |
| HTTP 404 (Not found) | PR doesn't exist or was deleted. Abort with error. |
| HTTP 422 "pull request is not mergeable" | Some GitHub orgs restrict reviews on unmergeable PRs. Fall back to COMMENT event. |
| Network error | Retry once. If retry fails, fall back to local-only mode with the full review displayed. |

### 1d. Invalid Line Recovery

If the API returns a validation error about specific comments:

1. Parse the error to identify which comment(s) failed
2. Remove the failing comment(s) from the inline_comments array
3. Add a note to the review body: "Some inline comments could not be posted (line numbers may have changed). See below."
4. Append the failed comments as blockquotes in the review body instead
5. Retry the API call with the remaining valid comments

```markdown
> **Note**: The following comments could not be posted inline (line references may be outdated):
> 
> **[label]** `[path]:[line]`: [title]
> [body]
```

Maximum retry attempts for line recovery: 2. After 2 attempts, post without inline comments.

---

## STEP 2: COMPLETION SUMMARY

Display the final summary to the user:

### For Posted Reviews

```markdown
## Review Complete

**PR**: #[pr_number] — [title]
**Action**: [ACTION_EMOJI] [action]
**Review URL**: [url from API response]

### Summary
| Metric | Value |
|--------|-------|
| Passes run | [N] of 4 |
| Total findings | [N] |
| Inline comments | [N] posted |
| Blockers | [N] |
| Criticals | [N] |
| Nits shown / suppressed | [N] / [M] |
| Findings filtered | [N] (false positive: [a], below threshold: [b], nit budget: [c], suppressed: [d]) |

### Review Breakdown by Pass
| Pass | Findings | Status |
|------|----------|--------|
| Architecture & Design | [N] | [completed/skipped/error] |
| Logic & Correctness | [N] | [completed/skipped/error] |
| Security | [N] | [completed/skipped/error] |
| Conventions & Polish | [N] | [completed/skipped/error] |

[If any notable edge cases were encountered:]
### Notes
- [e.g., "Large PR warning was issued (45 files)"]
- [e.g., "CI was still running during review"]
- [e.g., "Config had parse errors; defaults used"]
```

### For Local-Only Reviews

```markdown
## Review Complete (Local Only)

**PR**: #[pr_number] — [title]
**Action**: [ACTION_EMOJI] [action] (not posted)

The full review was displayed in R4. It was NOT posted to GitHub.

### Summary
[Same stats table as above]

**To post manually**, use:
```bash
gh api repos/[owner]/[repo]/pulls/[pr_number]/reviews --method POST -f event="[EVENT]" -f body="..."
```
```

### For Autonomous Mode

```markdown
## Review Complete (Autonomous)

**PR**: #[pr_number] — [title]
**Action**: [ACTION_EMOJI] [action]
**Review URL**: [url]

[Abbreviated stats — 3 lines max for autonomous mode]
Findings: [N] total | [blockers]B [criticals]C [majors]M | [action]
```

---

## STEP 3: MARK TODOS COMPLETE

```javascript
todowrite([
  { id: "r0-intake", content: "R0: Parse PR and load config", status: "completed", priority: "high" },
  { id: "r1-context", content: "R1: Gather context", status: "completed", priority: "high" },
  { id: "r2-review", content: "R2: Multi-pass review", status: "completed", priority: "high" },
  { id: "r3-synthesis", content: "R3: Synthesize comments", status: "completed", priority: "high" },
  { id: "r4-gate", content: "R4: User gate", status: "completed", priority: "medium" },
  { id: "r5-post", content: "R5: Post review", status: "completed", priority: "medium" },
])
```

---

## GATE ENFORCEMENT

<gate id="r5-exit" priority="9999">
  R5 is the terminal phase. No exit gate needed.
  
  R5 MUST:
  1. Either post the review successfully OR display it locally
  2. Display a completion summary
  3. Mark all todos as completed
  
  After R5, the Corvus-Review workflow is COMPLETE.
  Any follow-up request starts a NEW workflow from R0.
</gate>

---

## EDGE CASES

### Review Already Exists
If the user has already reviewed this PR (e.g., re-running the review):
- GitHub allows multiple reviews. The new review will be added alongside existing ones.
- No special handling needed. Inform the user: "This adds a new review; previous reviews remain."

### PR Closed/Merged During Review
If the PR was closed or merged between R0 and R5:
- Posting may still succeed (GitHub allows reviews on closed PRs).
- If posting fails, fall back to local-only mode.
- Note: "PR was closed/merged during review. Review posted for reference."

### Empty Review (No Findings)
- Still post the review with APPROVE event and summary body.
- Summary: "No issues found. Code looks good."
- No inline comments needed.

### Very Long Review Body
- GitHub has a body size limit (~65535 characters).
- If `review_body` exceeds 60000 characters:
  1. Truncate the findings section (keep summary + top 20 findings)
  2. Add note: "Review truncated due to length. [N] findings omitted from summary (still posted as inline comments)."
  3. Inline comments are not affected by body truncation.

### Rate Limiting During Post
- If `gh api` returns HTTP 429 or rate limiting error:
  1. Wait 60 seconds
  2. Retry once
  3. If retry fails, fall back to local-only mode
  4. Display: "GitHub API rate limit hit. Review saved locally."

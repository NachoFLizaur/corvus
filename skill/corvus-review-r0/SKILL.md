---
name: corvus-review-r0
description: PR Review Phase R0 - Intake, triage, PR metadata fetching, config loading
---

# Phase R0: INTAKE & TRIAGE

**Goal**: Parse PR reference, fetch metadata, load config, run triage checks.

**Executor**: Corvus-Review direct (no subagent delegation).

**Input**: User-provided PR reference (URL, `#number`, or `owner/repo#number`).

**Output**: `PR_CONTEXT` object (see `corvus-review-extras` for schema).

---

## STEP 0: PARSE PR REFERENCE

Extract the PR identifier from the user's input. Supported formats:

| Format | Example | Parsing |
|--------|---------|---------|
| Full URL | `https://github.com/owner/repo/pull/123` | Extract owner, repo, number from URL |
| Hash-number | `#123` | Use current repo (from `gh repo view --json nameWithOwner`) |
| Repo#number | `owner/repo#123` | Extract owner, repo, number |
| Just a number | `123` | Use current repo |

**If no PR reference is provided**:
```markdown
## PR Reference Required

Please provide a PR to review. Supported formats:
- `#123` (current repo)
- `owner/repo#123`
- `https://github.com/owner/repo/pull/123`
- Or just the number: `123`
```

**Validation**: After parsing, verify the PR exists:
```bash
gh pr view <number> --repo <owner/repo> --json number,title --jq '.number' 2>&1
```

If this fails, abort with a clear error (see `corvus-review-extras` error handling).

---

## STEP 1: FETCH PR METADATA

Run the following `gh` commands to populate PR_CONTEXT fields:

### 1a. Core Metadata

```bash
gh pr view <number> --repo <owner/repo> --json \
  number,url,title,body,author,baseRefName,headRefName,\
  labels,reviewRequests,isDraft,mergeable,\
  additions,deletions,changedFiles,files
```

**Field Mapping**:
- `pr_number` ← `number`
- `pr_url` ← `url`
- `title` ← `title`
- `description` ← `body` (set to `null` if empty string or missing)
- `author` ← `author.login`
- `base_branch` ← `baseRefName`
- `head_branch` ← `headRefName`
- `labels` ← `labels[].name`
- `reviewers_requested` ← `reviewRequests[].login`
- `is_draft` ← `isDraft`
- `mergeable` ← `mergeable` (map: `"MERGEABLE"` → true, `"CONFLICTING"` → false, else → null)
- `additions` ← `additions`
- `deletions` ← `deletions`
- `files_changed` ← `changedFiles`
- `changed_files` ← `files[].path`

### 1b. CI Status

```bash
gh pr checks <number> --repo <owner/repo> --json name,state,detailsUrl 2>&1
```

**Field Mapping**:
- For each check: `{ name, status: state_to_status(state), url: detailsUrl }`
- `state_to_status`: `"SUCCESS"` / `"NEUTRAL"` / `"SKIPPED"` → `"pass"`, `"FAILURE"` / `"ERROR"` → `"fail"`, `"PENDING"` / `"QUEUED"` / `"IN_PROGRESS"` → `"pending"`
- `ci_status` (aggregate): if any `"fail"` → `"fail"`, else if any `"pending"` → `"pending"`, else if all `"pass"` → `"pass"`, else `"none"` (no checks)

### 1c. Linked Issues

Parse linked issues from:
1. PR body: scan for `fixes #N`, `closes #N`, `resolves #N` (case-insensitive)
2. PR metadata: `gh pr view --json closingIssuesReferences`

Deduplicate and store as `linked_issues: ["#N", "#M"]`.

### 1d. Repo Identification

```bash
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

Store as `repo`.

---

## STEP 2: LOAD REVIEW CONFIG

### 2a. Attempt Config Load

```bash
cat .opencode/review-config.yaml 2>/dev/null
```

### 2b. Parse and Validate

If the file exists:
1. Parse YAML
2. Validate each field against the schema (see `corvus-review-extras`)
3. For invalid fields: log a warning, use the default for that field
4. For unknown keys: log a warning, ignore
5. Merge with defaults for any missing fields

If the file does not exist:
- Use all defaults (see `corvus-review-extras` for default values)
- This is normal and expected — config is optional

If the file has a YAML parse error:
- Log the error with line number
- Fall back to all defaults
- Set a flag: `config_parse_error: true` (included in review summary later)

### 2c. Apply Config

Store the validated config as `PR_CONTEXT.config`.

---

## STEP 3: TRIAGE

Evaluate the PR against triage checks and set flags in `PR_CONTEXT.flags`:

### 3a. Draft Check

```
flags.is_draft = PR_CONTEXT.is_draft
```

If draft:
```markdown
## Draft PR Detected

PR #[number] is marked as draft. Proceeding with review, but findings
will be posted as COMMENT_ONLY (not REQUEST_CHANGES) regardless of severity.
```

Set `config.action_override = "COMMENT_ONLY"` if draft and no explicit override exists.

### 3b. Large PR Check

```
flags.is_large_pr = (PR_CONTEXT.files_changed > config.large_pr_threshold)
```

If large PR, apply `config.large_pr_strategy`:

| Strategy | Action |
|----------|--------|
| `"warn"` | Add warning to review output, proceed normally |
| `"split-suggestion"` | Suggest splitting PR, then proceed with full review |
| `"proceed"` | No special handling |

For `"warn"` and `"split-suggestion"`, display:
```markdown
## Large PR Warning

This PR changes **[N] files** (threshold: [T]).
[If split-suggestion: Consider splitting this into smaller, focused PRs for easier review.]
Proceeding with review.
```

### 3c. Missing Description Check

```
flags.missing_description = (PR_CONTEXT.description == null or PR_CONTEXT.description.trim() == "")
```

If missing:
- Add a `note` finding to be included in the review: "PR has no description. Consider adding context for reviewers."
- Do NOT abort — this is a finding, not a blocker.

### 3d. CI Failure Check

```
flags.has_ci_failures = (PR_CONTEXT.ci_status == "fail")
```

If CI is failing:
- Note in context for R1's @researcher to analyze
- Do NOT abort — CI failures are analyzed and reported as part of the review

### 3e. Breaking Label Check

```
flags.has_breaking_labels = labels.any(l => 
  ["breaking-change", "breaking", "semver-major"].includes(l.toLowerCase())
)
```

If breaking labels found:
- Note for R2 passes: "PR has breaking-change label. Evaluate backward compatibility."

---

## STEP 4: PRODUCE PR_CONTEXT

Assemble the complete `PR_CONTEXT` object from all gathered data.

### Output Format

Present a summary to the user:

```markdown
## PR Review: #[number] — [title]

| Field | Value |
|-------|-------|
| Author | @[author] |
| Branch | [head_branch] → [base_branch] |
| Changes | +[additions] / -[deletions] across [files_changed] files |
| CI | [ci_status_emoji] [ci_status] |
| Draft | [yes/no] |

### Triage Flags
[List any active flags with their implications]

### Config
- Severity threshold: [threshold]
- Max nits: [max_nits]
- Passes enabled: [list]
- Autonomous: [yes/no]

**Proceeding to context gathering (R1)...**
```

Status emojis for CI: pass = `[PASS]`, fail = `[FAIL]`, pending = `[PENDING]`, none = `[NONE]`

---

## GATE ENFORCEMENT

<gate id="r0-exit" priority="9999">
  R0 MUST produce a valid PR_CONTEXT before proceeding to R1.
  
  PR_CONTEXT is VALID when ALL of the following are true:
  1. pr_number is a positive integer
  2. changed_files is a non-empty array (or review is skipped for empty diff)
  3. config is loaded (defaults are acceptable)
  4. All triage flags are set (boolean values, not undefined)
  
  If PR_CONTEXT cannot be produced (PR not found, auth error):
  → ABORT with clear error message. Do NOT proceed to R1.
  
  If PR has empty diff:
  → SKIP review entirely. Display "Review Skipped" message.
</gate>

---

## EDGE CASES

### Fork PRs
- `gh pr view` works for fork PRs. No special handling needed.
- Note: some CI checks may not run on fork PRs. Handle `ci_status: "none"` gracefully.

### Closed/Merged PRs
- Allow reviewing closed/merged PRs (useful for post-merge review).
- Add note: "This PR is already [closed/merged]. Review is informational only."
- Force `config.action_override = "COMMENT_ONLY"` for merged PRs.

### Very Large Diffs (1000+ files)
- If `files_changed > 100`, warn that review quality may degrade.
- The `changed_files` list from `gh pr view` may be truncated. Use `gh pr diff --name-only` as fallback:
  ```bash
  gh pr diff <number> --repo <owner/repo> --name-only
  ```

### Rate Limiting
- If `gh` commands fail with rate limiting errors, wait and retry once.
- If retry fails, abort with: "GitHub API rate limit exceeded. Try again later."

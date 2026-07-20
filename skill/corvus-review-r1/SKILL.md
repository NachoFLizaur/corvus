---
name: corvus-review-r1
description: PR Review Phase R1 - Parallel context gathering via pr-context-gatherer and researcher
---

# Phase R1: CONTEXT GATHERING

**Goal**: Build comprehensive context about the PR changes and their environment.

**Input**: `PR_CONTEXT` (from R0).

**Output**: `REVIEW_CONTEXT` object — schema owned by `corvus-review-extras`; reference it by name, do not restate it.

---

## LAUNCH PARALLEL WORKSTREAMS

Launch BOTH workstreams in a single message (parallel invocation) — sequential launches double R1 latency for no benefit.

The one exception: skip the @researcher workstream (launch only @pr-context-gatherer) when ALL of these are true — it would have nothing meaningful to research:

1. `PR_CONTEXT.linked_issues` is empty
2. `PR_CONTEXT.ci_status` is NOT `"fail"`
3. No dependency manifest files changed (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, and their lockfiles)
4. No `SECURITY.md` or security-related files changed

When skipping researcher, set these REVIEW_CONTEXT fields to empty: `linked_issues_detail: []`, `dependency_advisories: []`, `ci_failure_analysis: []`, `related_prs: []`.

---

## WORKSTREAM A: PR CONTEXT (@pr-context-gatherer)

**DELEGATE TO**: @pr-context-gatherer

```markdown
**TASK**: Analyze all changed files in PR #[pr_number] for code review context

**CHANGED FILES** ([files_changed] files):
[List all files from PR_CONTEXT.changed_files, one per line]

**EXPECTED OUTCOME**: Complete review context for every changed file — full post-change content, diff hunks, import/export analysis, callers of changed functions/exports, associated test files, and git history — plus a dependency graph and detected codebase conventions.

**MUST DO**:
- Read every changed file in full (not just diff hunks) — reviewers need full context
- For each changed file, identify its imports and exports
- For each changed export/public function, find callers in the rest of the codebase
- For each changed file, find associated test files (by convention: `*.test.*`, `*.spec.*`, `__tests__/`, or co-located)
- Run `git log --oneline -5 <file>` for each changed file to get recent history
- Build a dependency graph: which changed files depend on each other, and which unchanged files depend on changed files
- Detect codebase conventions by examining 3-5 existing files near the changed files:
  - Naming conventions (camelCase, snake_case, PascalCase)
  - File/directory structure patterns
  - Error handling patterns (try/catch style, Result types, error codes)
  - Test patterns (test framework, assertion style, mocking approach)
  - Import ordering conventions

**MUST NOT DO**:
- Modify any files
- Run tests or builds
- Skip any changed file (even if it looks trivial)
- Guess at conventions without examining actual code

**CONTEXT**:
- Repository: [repo]
- Base branch: [base_branch]
- Head branch: [head_branch]

**TO GET THE DIFF**:
```bash
gh pr diff [pr_number] --repo [repo]
```

**REPORT FORMAT**:
```
### File Map

#### [file_path]
- Language: [lang]
- Status: [modified|added|deleted|renamed]
- Diff: +[N]/-[M] lines
- Imports: [list or "none"]
- Exports: [list or "none"]
- Callers: [list of file:function that call into this file, or "none found"]
- Test files: [list or "none found"]
- Git history: last modified [date], recent authors: [list], frequency: [high/medium/low]
- Full content: [included / null (binary) / null (deleted)]

[Repeat for each file]

### Dependency Graph
[file_path]:
  depends_on: [list]
  depended_by: [list]

### Conventions Detected
- Naming: [description]
- File structure: [description]
- Error handling: [description]
- Test patterns: [description]
- Import order: [description]

### Test Coverage
- Files with tests: [list]
- Files without tests: [list]
- Test framework: [detected framework or "unknown"]

### Diff Hunks
[Per-file diff hunks]
```
```

---

## WORKSTREAM B: EXTERNAL CONTEXT (@researcher)

**DELEGATE TO**: @researcher

```markdown
**TASK**: Gather external context for PR #[pr_number] review

**PR METADATA**:
- Title: [title]
- Description: [description or "No description provided"]
- Author: @[author]
- Labels: [labels]
- Linked issues: [linked_issues]
- CI status: [ci_status]
- Changed files: [changed_files — abbreviated if > 20, showing first 10 + "and N more"]

**EXPECTED OUTCOME**:
- Detailed info on linked issues (acceptance criteria, context)
- Dependency advisory check (if dependency files changed)
- CI failure analysis (if CI is failing)
- Related PRs (recent PRs touching same files)

**MUST DO**:

1. **Linked Issues** (if any):
   For each issue in [linked_issues]:
   ```bash
   gh issue view <number> --repo [repo] --json title,body,labels
   ```
   Extract: title, body summary, labels, and any acceptance criteria
   (look for checkbox lists, "acceptance criteria" headers, or "requirements" sections)

2. **Dependency Advisories** (if dependency files changed):
   Check if any of these files are in the changed list: package.json, package-lock.json,
   yarn.lock, pnpm-lock.yaml, requirements.txt, Pipfile.lock, go.sum, Cargo.lock, Gemfile.lock

   If yes, check for known advisories:
   ```bash
   # For npm projects
   npm audit --json 2>/dev/null | jq '.vulnerabilities | to_entries[:5]'
   # For other ecosystems, use web search for recent advisories
   ```

3. **CI Failure Analysis** (if ci_status == "fail"):
   For each failing check:
   - Attempt to fetch logs if URL is available
   - Categorize: test failure, build error, lint error, other
   - Identify which changed files are likely related
   - Provide error summary

4. **Related PRs**:
   Find recent PRs that touch the same files:
   ```bash
   gh pr list --repo [repo] --state all --limit 10 --json number,title,files \
     --jq '[.[] | select(.files[]?.path as $p | [CHANGED_FILES] | any(. == $p))][:5]'
   ```
   If the above is complex, use a simpler approach:
   ```bash
   # Search for PRs mentioning the same directories
   gh pr list --repo [repo] --state merged --limit 20 --search "path:[key_directory]"
   ```

**MUST NOT DO**:
- Modify any files
- Run tests or builds
- Spend more than 2 queries per linked issue
- Fetch full CI logs (summaries only)

**REPORT FORMAT**:
```
### Linked Issues

#### #[number]: [title]
- Labels: [labels]
- Summary: [1-2 sentence summary]
- Acceptance Criteria: [extracted list or "none found"]

### Dependency Advisories
[List any advisories found, or "No dependency files changed" / "No advisories found"]

### CI Failure Analysis
[For each failing check: name, failure type, error summary, related files]
[Or "CI passing" / "No CI checks"]

### Related PRs
[List recent PRs touching same files with title and relevance]
[Or "No related PRs found"]
```
```

---

## MERGE WORKSTREAM RESULTS

After the workstreams complete (or the single workstream if researcher was skipped), assemble the `REVIEW_CONTEXT` object (schema: `corvus-review-extras`):

1. **file_map, dependency_graph, conventions**: direct from @pr-context-gatherer output
2. **test_coverage**: derived from @pr-context-gatherer's test file associations
3. **linked_issues_detail, dependency_advisories, ci_failure_analysis, related_prs**: from @researcher (or empty if skipped)

### Partial Failure Handling

If one workstream fails but the other succeeds, do not abort:

- **@pr-context-gatherer fails**: critical — the review cannot proceed without file context. Retry once; if the retry fails, abort with an error.
- **@researcher fails**: non-critical — proceed with empty researcher fields and add a note to REVIEW_CONTEXT: "External context gathering failed. Review proceeds without linked issue analysis, CI failure analysis, or dependency advisory checks."

### Validation

Before proceeding to R2, verify REVIEW_CONTEXT:

1. `file_map` has an entry for every file in `PR_CONTEXT.changed_files`
2. `conventions` has at least one non-empty field
3. `dependency_graph` exists (may be empty for unrelated files)

If validation fails, log a warning and proceed — a degraded review is better than no review.

---

## GATE ENFORCEMENT

<gate id="r1-exit">
  R2 reviews from the file map, so R1 exits only with a populated one.
  A valid REVIEW_CONTEXT requires:
  1. file_map is non-empty
  2. Every file in PR_CONTEXT.changed_files has a file_map entry
     (or a documented reason for absence, e.g., binary file, deleted file)
  3. conventions object exists

  If file_map is empty → abort (cannot review without file context)
  If file_map is partial → warn and proceed (degraded review)
</gate>

---

## EDGE CASES

- **Binary files** (images, compiled assets): cannot be read as text. file_map entry gets `full_content: null`, `language: "binary"`; skip from all R2 review passes. If the PR is ONLY binary files, skip to R3 with a note: "All changes are binary files. No code review applicable."
- **Deleted files**: no post-change content. file_map entry gets `full_content: null`, `deleted: true`. R2 reviewers should check that callers of deleted exports are updated.
- **Renamed/moved files**: `gh pr diff` shows renames. Track old → new path, read the new path for full content, and check that imports referencing the old path are updated.
- **Very large files (> 5000 lines)**: still read in full (reviewers need context) but mark `large_file: true`; R2 passes may focus primarily on changed hunks.
- **Submodule changes**: the pointer change shows as a single-line diff. file_map entry gets `language: "submodule"`, `full_content: null`. @researcher should check the submodule repo for what changed (if accessible).

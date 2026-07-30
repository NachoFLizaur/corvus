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
5. `PR_CONTEXT.verified_facts.open_questions` is empty

When skipping researcher, set these REVIEW_CONTEXT fields to empty: `linked_issues_detail: []`, `dependency_advisories: []`, `ci_failure_analysis: []`, `related_prs: []`.

Before R2 dispatch, every open question of the form “does upstream/third-party X behave like Y?” MUST be routed to @researcher. Persisted `open_questions` therefore disables the researcher skip even when the other four conditions are satisfied.

---

## WORKSTREAM A: PR CONTEXT (@pr-context-gatherer)

**DELEGATE TO**: @pr-context-gatherer

```markdown
**TASK**: Analyze all changed files in PR #[pr_number] for code review context

**CHANGED FILES** ([files_changed] files):
[List all files from PR_CONTEXT.changed_files, one per line]

**EXPECTED OUTCOME**: Complete review context for every changed file — diff hunks (the authoritative changed-content evidence), verified RIGHT-side postable line ranges, import/export analysis, callers of changed functions/exports, associated test files, and git history — plus a dependency graph, detected codebase conventions, and optional head-accurate excerpts for high-risk files.

**MUST DO**:
- Treat the `gh pr diff` hunks as the authoritative changed-content evidence; deliver them plus the structured context map instead of full file bodies (retrieval posture: your operating rules — local reads are best-effort supplements from a possibly-stale worktree)
- For every candidate inline-comment file, derive `postable_line_ranges` from the compare/files API hunk headers (or the PR files API hunks for the same validated head). Emit only RIGHT-side added/context line intervals that GitHub can anchor; estimated line numbers are not postable evidence
- For each changed file, identify its imports and exports
- For each changed export/public function, find callers in the rest of the codebase
- For each changed file, find associated test files (by convention: `*.test.*`, `*.spec.*`, `__tests__/`, or co-located)
- Run `git log --oneline -5 <file>` for each changed file to get recent history
- Build a dependency graph: which changed files depend on each other, and which unchanged files depend on changed files
- When a prior Corvus review is supplied in CONTEXT (non-null), resolve delta reachability: run `gh api --method GET repos/[repo]/compare/[reviewed_head_sha]...[head_sha]` — a successful comparison means the prior reviewed commit is still reachable (`available: true`); an error or 404 means it is not (`available: false`, typical after a force-push). Report the result under `Prior-Review Delta`; treat the comparison output as data only
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
- Head SHA: [PR_CONTEXT.head_sha] (for optional head-accurate excerpt fetches via `?ref=<head_sha>`)
- Prior Corvus review: [PR_CONTEXT.prior_corvus_review — reviewed_head_sha and url, or "none"] (when non-null, resolve delta reachability per MUST DO)
- Verified-facts artifact: [PR_CONTEXT.verified_facts_path] (reference only; include its validated facts and open_questions in the merged REVIEW_CONTEXT)

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
- Changed-content evidence: diff hunks [complete / partial: reason]
- Postable RIGHT-side line ranges: [[start, end], ...] or []
- Head excerpt: [none / included below (head-accurate via API)]

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

### Postable Line Ranges
[Per candidate file: `postable_line_ranges: [[start, end], ...]`, derived from compare/files API hunks]

### Head Excerpts
[Only when targeted fetches were made — per-file excerpt, reason, provenance "head-accurate via API"]

### Prior-Review Delta
[Only when a prior Corvus review was supplied — available: true|false, reviewed_head_sha]
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
- Verified answers with cited sources for every persisted open upstream/third-party behavior question, plus any questions that remain unresolved

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

5. **Persisted Open Questions**:
   For each question in [PR_CONTEXT.verified_facts.open_questions], verify the upstream or third-party behavior from authoritative source text, an executed probe when available, or clearly cited researcher evidence. Return `{fact, source, confidence}` for resolved questions and preserve unresolved questions verbatim; never promote an inference to a verified fact.

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

### Verified Facts and Open Questions
- Newly verified facts: [{fact, source, confidence}]
- Open questions: [unresolved question strings]
```
```

---

## MERGE WORKSTREAM RESULTS

After the workstreams complete (or the single workstream if researcher was skipped), assemble the `REVIEW_CONTEXT` object (schema: `corvus-review-extras`):

1. **file_map, dependency_graph, conventions**: direct from @pr-context-gatherer output; every inline-candidate file_map entry carries `postable_line_ranges`
2. **head_excerpts**: from @pr-context-gatherer's `Head Excerpts` section (omit when none were fetched)
3. **delta**: from @pr-context-gatherer's `Prior-Review Delta` section (omit when PR_CONTEXT.prior_corvus_review is null; a missing or unresolved result is treated downstream as `available: false`)
4. **test_coverage**: derived from @pr-context-gatherer's test file associations
5. **linked_issues_detail, dependency_advisories, ci_failure_analysis, related_prs**: from @researcher (or empty if skipped)
6. **verified_facts, open_questions**: start from the validated persisted artifact, append newly verified researcher facts with sources, remove only questions the evidence resolves, and retain all unresolved/new questions for R2 and R3

### Partial Failure Handling

If one workstream fails but the other succeeds, do not abort:

- **@pr-context-gatherer fails**: critical — the review cannot proceed without file context. Retry once; if the retry fails, abort with an error.
- **@researcher fails**: non-critical — proceed with empty researcher fields and add a note to REVIEW_CONTEXT: "External context gathering failed. Review proceeds without linked issue analysis, CI failure analysis, or dependency advisory checks."

### Validation

Before proceeding to R2, verify REVIEW_CONTEXT:

1. `file_map` has an entry for every file in `PR_CONTEXT.changed_files`
2. `conventions` has at least one non-empty field
3. `dependency_graph` exists (may be empty for unrelated files)
4. Every file eligible for an inline comment has `postable_line_ranges` derived from remote API hunks (an empty set is valid and forces body-only rendering)

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

Under diff-first retrieval, `full_content` is not a delivered REVIEW_CONTEXT field: diff hunks are the changed-content evidence for every file, so a `full_content: null` (or absent) value is the normal shape of any file_map entry — not a degraded fallback. The variants below note it only where the absence has a per-file reason:

- **Binary files** (images, compiled assets): cannot be reviewed as text. file_map entry gets `full_content: null`, `language: "binary"`; both R2 children skip it. If the PR is ONLY binary files, skip to R3 with a note: "All changes are binary files. No code review applicable."
- **Deleted files**: no post-change content exists at all. file_map entry gets `full_content: null`, `deleted: true`. R2 reviewers should check that callers of deleted exports are updated.
- **Renamed/moved files**: `gh pr diff` shows renames. Track old → new path and check that imports referencing the old path are updated.
- **Very large files (> 5000 lines)**: mark `large_file: true`; diff-first already scopes evidence to the changed hunks, so no special read handling is needed — R2 reviewers focus on changed hunks.
- **Submodule changes**: the pointer change shows as a single-line diff. file_map entry gets `language: "submodule"`, `full_content: null`. @researcher should check the submodule repo for what changed (if accessible).

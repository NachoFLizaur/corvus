---
name: corvus-review-extras
description: Shared schemas, Conventional Comments spec, config schema, and common templates for Corvus PR Review
---

# Corvus Review — Shared References

## SUBAGENT REFERENCE

| Phase | Subagent | Purpose | Parallel? |
|-------|----------|---------|-----------|
| R0 | (Corvus-Review direct) | Intake, triage, config | N/A |
| R1 | @pr-context-gatherer | Read changed files, trace deps, find tests, detect conventions | Yes (with researcher) |
| R1 | @researcher | Fetch linked issues, dependency advisories, CI failures, related PRs | Yes (with pr-context-gatherer) |
| R2 Pass 1 | @ux-dx-quality | Architecture & Design review | Yes (with Pass 2, 3) |
| R2 Pass 2 | @code-quality | Logic & Correctness review | Yes (with Pass 1, 3) |
| R2 Pass 3 | @security-reviewer | Security review | Yes (with Pass 1, 2) |
| R2 Pass 4 | (Corvus-Review direct) | Conventions & Polish | Sequential (after 1-3) |
| R3 | (Corvus-Review direct) | Comment synthesis | N/A |
| R4 | (Corvus-Review direct) | User gate / auto-proceed | N/A |
| R5 | @pr-comment-writer | GitHub posting | N/A |

### Invoking Subagents

Use the Task tool with `subagent_type` parameter:

```javascript
task(
  subagent_type: "pr-context-gatherer",
  description: "Gather PR context: changed files and dependencies",
  prompt: "**TASK**: Analyze all changed files in PR #NNN..."
)
```

### Parallel Invocation

When subagents are independent (R1, R2 Passes 1-3), invoke them in the same message:

```javascript
// R1: These run in parallel
task(subagent_type: "pr-context-gatherer", description: "PR file analysis", prompt: "...")
task(subagent_type: "researcher", description: "PR external context", prompt: "...")
```

---

## REVIEW CONFIG SCHEMA

File: `.opencode/review-config.yaml`

```yaml
# .opencode/review-config.yaml — Full Schema with Defaults
# All fields are optional. Defaults are applied for missing fields.

# Severity threshold: findings below this level are excluded from the review.
# Values: "blocker" | "critical" | "major" | "minor" | "nitpick"
# Default: "nitpick" (include everything)
severity_threshold: "nitpick"

# Maximum number of nitpick ("nit") comments allowed in the review.
# Excess nits are silently dropped (lowest-confidence first).
# Default: 3
max_nits: 3

# Toggle individual review passes on/off.
# Default: all true
passes:
  architecture: true    # Pass 1: Architecture & Design
  correctness: true     # Pass 2: Logic & Correctness
  security: true        # Pass 3: Security
  conventions: true     # Pass 4: Conventions & Polish

# Path-specific rules: override severity or suppress findings per glob pattern.
path_rules:
  # Example: suppress nitpicks in generated files
  - pattern: "**/*.generated.*"
    suppress_below: "major"
  # Example: elevate security findings in auth paths
  - pattern: "src/auth/**"
    elevate_security: true
  # Example: skip conventions pass for vendored code
  - pattern: "vendor/**"
    skip_passes: ["conventions"]

# Custom regex rules: additional pattern-based checks.
custom_rules:
  - id: "todo-no-issue"
    pattern: "TODO(?!.*#\\d+)"
    severity: "minor"
    message: "TODO comment without linked issue"
    include: ["*.ts", "*.js"]
    exclude: ["*.test.*"]

# Suppression rules: silence specific findings by ID or pattern.
suppressions:
  - id: "no-console-log"
    paths: ["src/debug/**"]
  - message_pattern: "unused import"
    reason: "Auto-imports will be cleaned by CI"

# Autonomous mode: when true, skip R4 user gate and auto-proceed.
# Default: false
autonomous: false

# Review action override: force a specific action.
# Values: null | "APPROVE" | "REQUEST_CHANGES" | "COMMENT_ONLY"
# Default: null (auto-determined by R3)
action_override: null

# Large PR threshold: number of changed files that triggers large-PR handling.
# Default: 20
large_pr_threshold: 20

# Large PR strategy: what to do when PR exceeds threshold.
# Values: "warn" | "split-suggestion" | "proceed"
# Default: "warn"
large_pr_strategy: "warn"
```

### Config Validation Rules

1. `severity_threshold` must be one of: `blocker`, `critical`, `major`, `minor`, `nitpick`
2. `max_nits` must be a non-negative integer
3. `passes` keys must be from: `architecture`, `correctness`, `security`, `conventions`
4. `path_rules[].pattern` must be valid glob syntax
5. `custom_rules[].pattern` must be valid regex
6. `custom_rules[].severity` must be a valid severity level
7. `suppressions[].message_pattern` must be valid regex (if present)
8. `large_pr_threshold` must be a positive integer
9. Unknown keys produce a warning but do not fail loading

### Config Loading Priority

1. `.opencode/review-config.yaml` (project-level)
2. Built-in defaults (for any missing fields)

---

## CONVENTIONAL COMMENTS SPECIFICATION

All review findings use the [Conventional Comments](https://conventionalcomments.org/) format.

### Labels

| Label | Meaning | Blocks Merge? |
|-------|---------|---------------|
| `blocker` | Must fix before merge. Correctness, security, or data-loss issue. | YES |
| `critical` | Strongly recommended fix. Significant design, performance, or reliability issue. | YES (when action = REQUEST_CHANGES) |
| `major` | Should fix. Logic error, missing edge case, poor abstraction. | Depends on threshold |
| `minor` | Consider fixing. Style, naming, small improvement. | No |
| `nitpick` | Optional polish. Cosmetic, subjective preference. | No |
| `praise` | Positive feedback. Highlight good patterns. | No |
| `thought` | Open question or suggestion for discussion. | No |
| `note` | Informational context. Not actionable. | No |

### Severity Mapping

| Severity Level | Label | Numeric Weight |
|----------------|-------|----------------|
| 5 (highest) | `blocker` | 50 |
| 4 | `critical` | 40 |
| 3 | `major` | 30 |
| 2 | `minor` | 20 |
| 1 (lowest) | `nitpick` | 10 |
| 0 (special) | `praise` / `thought` / `note` | 0 |

### Finding Structure

Each review finding MUST conform to this structure:

```yaml
- id: "<pass>-<sequence>"          # e.g., "arch-001", "logic-003", "sec-002", "conv-001"
  pass: "<pass_name>"              # "architecture" | "correctness" | "security" | "conventions"
  label: "<conventional_label>"    # From labels table above
  severity: <1-5>                  # Numeric severity (0 for praise/thought/note)
  file: "<file_path>"             # Relative path from repo root
  line_start: <number>            # Starting line (1-indexed)
  line_end: <number|null>         # Ending line (null for single-line)
  title: "<short_title>"          # Max 80 chars, imperative mood
  body: "<markdown_body>"         # Full explanation with context
  suggestion: "<code|null>"       # Suggested fix (optional, GitHub suggestion format)
  confidence: <0.0-1.0>           # How confident the reviewer is
  related_to: ["<finding_id>"]    # Cross-references to related findings (optional)
  suppressed: false               # Set to true if matched by a suppression rule
```

### Comment Rendering Format

When posting to GitHub, each finding renders as:

For inline comments (file + line):
```
**<label>** (<pass>): <title>

<body>

[suggestion block if present]
```

For the review summary body:
```
**<label>**: <title>
<body>
```

### Nit Budget Enforcement

- Maximum nits per review: `config.max_nits` (default: 3)
- When findings exceed the nit budget, drop lowest-confidence nits first
- Dropped nits are noted in the review summary: "N additional nitpicks suppressed"
- `praise`, `thought`, and `note` labels do NOT count toward nit budget

---

## DATA OBJECT SCHEMAS

### PR_CONTEXT (produced by R0)

```yaml
PR_CONTEXT:
  pr_number: <number>
  pr_url: "<url>"
  repo: "<owner/repo>"
  base_branch: "<branch>"
  head_branch: "<branch>"
  author: "<username>"
  title: "<string>"
  description: "<string|null>"
  labels: ["<label>"]
  reviewers_requested: ["<username>"]
  linked_issues: ["<issue_ref>"]
  is_draft: <boolean>
  mergeable: <boolean|null>
  ci_status: "pass" | "fail" | "pending" | "none"
  ci_checks:
    - name: "<check_name>"
      status: "pass" | "fail" | "pending"
      url: "<url|null>"
  files_changed: <number>
  additions: <number>
  deletions: <number>
  changed_files: ["<file_path>"]
  flags:
    is_large_pr: <boolean>
    missing_description: <boolean>
    has_ci_failures: <boolean>
    is_draft: <boolean>
    has_breaking_labels: <boolean>
  config: <ReviewConfig>
```

### REVIEW_CONTEXT (produced by R1)

```yaml
REVIEW_CONTEXT:
  file_map:
    "<file_path>":
      full_content: "<string>"
      diff_hunks: ["<hunk>"]
      language: "<lang>"
      imports: ["<import>"]
      exports: ["<export>"]
      callers: ["<file:function>"]
      test_files: ["<file_path>"]
      git_history:
        last_modified: "<date>"
        recent_authors: ["<username>"]
        change_frequency: "high" | "medium" | "low"
  dependency_graph:
    "<file_path>":
      depends_on: ["<file_path>"]
      depended_by: ["<file_path>"]
  conventions:
    naming: "<pattern_description>"
    file_structure: "<description>"
    error_handling: "<pattern>"
    test_patterns: "<description>"
    import_order: "<convention>"
  test_coverage:
    has_tests: <boolean>
    test_files_for_changes: ["<file_path>"]
    untested_files: ["<file_path>"]
  linked_issues_detail: [<IssueDetail>]
  dependency_advisories: [<Advisory>]
  ci_failure_analysis: [<CIFailure>]
  related_prs: [<RelatedPR>]
```

### REVIEW_FINDINGS (produced by R2)

```yaml
REVIEW_FINDINGS:
  pass_results:
    architecture:
      status: "completed" | "skipped" | "error"
      findings: [<Finding>]
      summary: "<string>"
    correctness:
      status: "completed" | "skipped" | "error"
      findings: [<Finding>]
      summary: "<string>"
    security:
      status: "completed" | "skipped" | "error"
      findings: [<Finding>]
      summary: "<string>"
    conventions:
      status: "completed" | "skipped" | "error"
      findings: [<Finding>]
      summary: "<string>"
  totals:
    blocker: <count>
    critical: <count>
    major: <count>
    minor: <count>
    nitpick: <count>
    praise: <count>
    thought: <count>
    note: <count>
```

### REVIEW_DOCUMENT (produced by R3)

```yaml
REVIEW_DOCUMENT:
  summary:
    title: "<one-line summary>"
    body: "<markdown>"
    stats:
      total_findings: <count>
      blockers: <count>
      criticals: <count>
      majors: <count>
      minors: <count>
      nits_shown: <count>
      nits_suppressed: <count>
      praises: <count>
  action: "APPROVE" | "REQUEST_CHANGES" | "COMMENT_ONLY"
  action_reasoning: "<string>"
  findings: [<Finding>]
  inline_comments:
    - path: "<file_path>"
      line: <number>
      start_line: <number|null>
      side: "RIGHT"
      body: "<rendered_comment>"
  review_body: "<rendered_markdown>"
  dedup_log: [<DedupEntry>]
  filtered_log: [<FilterEntry>]
```

### REVIEW_ACTION (produced by R4)

```yaml
REVIEW_ACTION:
  decision: "post" | "edit" | "local_only" | "rerun" | "auto_post"
  edits: [<Finding>]
  rerun_scope: ["<pass_name>"]
```

---

## TODO TRACKING PATTERNS

```javascript
// Initial setup (R0 start)
todowrite([
  { id: "r0-intake", content: "R0: Parse PR and load config", status: "in_progress", priority: "high" },
  { id: "r1-context", content: "R1: Gather context", status: "pending", priority: "high" },
  { id: "r2-review", content: "R2: Multi-pass review", status: "pending", priority: "high" },
  { id: "r3-synthesis", content: "R3: Synthesize comments", status: "pending", priority: "high" },
  { id: "r4-gate", content: "R4: User gate", status: "pending", priority: "medium" },
  { id: "r5-post", content: "R5: Post review", status: "pending", priority: "medium" },
])

// Phase transitions: mark completed, set next to in_progress
```

---

## ERROR HANDLING

### PR Not Found
```markdown
## Review Aborted
**Reason**: PR #[number] not found in [repo].
**Action**: Verify the PR number and repository.
```

### CI Still Running
Do NOT abort. Note `ci_status: "pending"` in PR_CONTEXT.
R3 adds a note: "CI checks were still running at review time."

### Empty Diff
```markdown
## Review Skipped
**Reason**: PR #[number] has no file changes. No code review needed.
```

### Config Parse Error
Log warning, fall back to all defaults, add note to review summary.

### Subagent Failure
- R1 workstream fails: proceed with partial context, note gap
- R2 pass fails: mark as "error", proceed with remaining passes
- R3 fails: escalate to user (cannot produce review without synthesis)
- R5 fails (posting): show rendered review locally, offer retry

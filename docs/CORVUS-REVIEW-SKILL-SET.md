# Corvus PR Review — Complete Skill Set Design

## Overview

This document defines the complete skill set for **Corvus PR Review**, a new variant of the Corvus multi-agent orchestrator specialized for automated PR/code review. These skills are entirely new — they share naming conventions and structural patterns with the existing Corvus implementation skills, but contain no implementation-workflow concepts (no MASTER_PLAN.md, no task files, no fix cycles).

### Workflow Phases

```
R0: Intake & Triage → R1: Context Gathering → R2: Multi-Pass Review → R3: Comment Synthesis → R4: User Gate → R5: Completion
```

### Skill Inventory

| Skill Name | Phase | Description |
|------------|-------|-------------|
| `corvus-review-r0` | R0 | Intake, triage, config loading |
| `corvus-review-r1` | R1 | Parallel context gathering |
| `corvus-review-r2` | R2 | Multi-pass review orchestration |
| `corvus-review-r3` | R3 | Comment synthesis and dedup |
| `corvus-review-r4` | R4 | User gate (interactive) / auto-proceed (autonomous) |
| `corvus-review-r5` | R5 | GitHub posting and completion |
| `corvus-review-extras` | Any | Shared data schemas, Conventional Comments spec, config schema, common templates |

### Data Flow

```
R0 → PR_CONTEXT
R1 → REVIEW_CONTEXT
R2 → REVIEW_FINDINGS
R3 → REVIEW_DOCUMENT
R4 → REVIEW_ACTION
R5 → (posted to GitHub)
```

---

## Design Decisions

### Why a shared extras skill?

Yes. `corvus-review-extras` carries:
- **Conventional Comments format** — referenced by R2 (all passes produce typed findings) and R3 (synthesis applies it), so embedding it in R3 alone would force R2 passes to invent their own format or load R3 prematurely.
- **Review config schema** — referenced by R0 (loading), R2 (pass toggles, severity threshold), and R3 (nit budget, suppression rules).
- **Data object schemas** — `PR_CONTEXT`, `REVIEW_CONTEXT`, `REVIEW_FINDINGS`, `REVIEW_DOCUMENT` are consumed across phases.
- **Common severity/label enumerations** — single source of truth avoids drift.

### Why Conventional Comments is NOT in R3?

R2 passes need the format to produce structured findings. If it lived only in R3, either:
1. R2 passes would produce unstructured text and R3 would have to re-parse everything (lossy, error-prone), or
2. R3's skill would need to be loaded during R2 (violates phase isolation).

By placing it in extras, any phase can reference it when needed.

### Config schema documentation

Documented in `corvus-review-extras` with the full YAML schema, defaults, and validation rules. R0 loads and validates against this schema.

---

## Skill 1: `corvus-review-extras`

**When loaded**: On demand by any phase that needs shared references. Typically loaded once at the start alongside R0, or by any phase that needs to reference the schemas.

**Input**: None (reference material).

**Output**: None (provides schemas and templates for other skills).

```markdown
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
| R1 | @researcher | Fetch linked issues, dependency advisories, CI failures, related PRs | Yes (with code-explorer) |
| R2 Pass 1 | @ux-dx-quality | Architecture & Design review | Yes (with Pass 2, 3) |
| R2 Pass 2 | @code-quality | Logic & Correctness review | Yes (with Pass 1, 3) |
| R2 Pass 3 | @security-reviewer | Security review | Yes (with Pass 1, 2) |
| R2 Pass 4 | (Corvus-Review direct) | Conventions & Polish | Sequential (after 1-3) |
| R3 | (Corvus-Review direct) | Comment synthesis | N/A |
| R4 | (Corvus-Review direct) | User gate / auto-proceed | N/A |
| R5 | @pr-comment-writer | GitHub posting | N/A |

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
# Excess nits are silently dropped (lowest-value first).
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
# Each rule produces a finding if the regex matches in a changed file.
custom_rules:
  # Example: flag TODO comments without issue references
  - id: "todo-no-issue"
    pattern: "TODO(?!.*#\\d+)"
    severity: "minor"
    message: "TODO comment without linked issue"
    include: ["*.ts", "*.js"]  # file patterns (optional, default: all)
    exclude: ["*.test.*"]       # exclusion patterns (optional)
  # Example: flag console.log statements
  - id: "no-console-log"
    pattern: "console\\.log\\("
    severity: "minor"
    message: "console.log left in production code"
    exclude: ["*.test.*", "*.spec.*"]

# Suppression rules: silence specific findings by ID or pattern.
suppressions:
  # Suppress by finding ID (from custom_rules or built-in checks)
  - id: "no-console-log"
    paths: ["src/debug/**"]
  # Suppress by message pattern (regex)
  - message_pattern: "unused import"
    reason: "Auto-imports will be cleaned by CI"

# Autonomous mode: when true, skip R4 user gate and auto-proceed.
# Default: false
autonomous: false

# Review action override: force a specific action regardless of findings.
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

### Severity Mapping to Labels

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
  severity: <1-5>                  # Numeric severity
  file: "<file_path>"             # Relative path from repo root
  line_start: <number>            # Starting line (1-indexed)
  line_end: <number|null>         # Ending line (null for single-line)
  title: "<short_title>"          # Max 80 chars, imperative mood
  body: "<markdown_body>"         # Full explanation with context
  suggestion: "<code|null>"       # Suggested fix (optional, GitHub suggestion format)
  confidence: <0.0-1.0>           # How confident the reviewer is (used for false-positive filtering)
  related_to: ["<finding_id>"]    # Cross-references to related findings (optional)
  suppressed: false               # Set to true if matched by a suppression rule
```

### Comment Rendering Format

When posting to GitHub, each finding renders as:

```
**<label>**: <title>

<body>

[suggestion block if present]
```

For inline comments (file + line):
```
**<label>** (<pass>): <title>

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
  # Identity
  pr_number: <number>
  pr_url: "<url>"
  repo: "<owner/repo>"
  base_branch: "<branch>"
  head_branch: "<branch>"
  author: "<username>"
  
  # Metadata
  title: "<string>"
  description: "<string|null>"      # null if missing
  labels: ["<label>"]
  reviewers_requested: ["<username>"]
  linked_issues: ["<issue_ref>"]     # Parsed from description + metadata
  
  # State
  is_draft: <boolean>
  mergeable: <boolean|null>          # null if unknown
  ci_status: "pass" | "fail" | "pending" | "none"
  ci_checks: 
    - name: "<check_name>"
      status: "pass" | "fail" | "pending"
      url: "<url|null>"
  
  # Diff stats
  files_changed: <number>
  additions: <number>
  deletions: <number>
  changed_files: ["<file_path>"]
  
  # Triage flags
  flags:
    is_large_pr: <boolean>           # files_changed > config.large_pr_threshold
    missing_description: <boolean>
    has_ci_failures: <boolean>
    is_draft: <boolean>
    has_breaking_labels: <boolean>    # e.g., "breaking-change" label
  
  # Config (loaded and validated)
  config: <ReviewConfig>             # Parsed from review-config.yaml + defaults
```

### REVIEW_CONTEXT (produced by R1)

```yaml
REVIEW_CONTEXT:
  # From @code-explorer
  file_map:
    "<file_path>":
      full_content: "<string>"        # Full file content (post-change)
      diff_hunks: ["<hunk>"]          # Individual diff hunks
      language: "<lang>"
      imports: ["<import>"]
      exports: ["<export>"]
      callers: ["<file:function>"]    # Functions that call into changed code
      test_files: ["<file_path>"]     # Associated test files
      git_history:                    # Recent history for this file
        last_modified: "<date>"
        recent_authors: ["<username>"]
        change_frequency: "high" | "medium" | "low"
  
  dependency_graph:
    "<file_path>": 
      depends_on: ["<file_path>"]
      depended_by: ["<file_path>"]
  
  conventions:
    naming: "<pattern_description>"    # e.g., "camelCase for functions, PascalCase for types"
    file_structure: "<description>"    
    error_handling: "<pattern>"        
    test_patterns: "<description>"     
    import_order: "<convention>"       
  
  test_coverage:
    has_tests: <boolean>
    test_files_for_changes: ["<file_path>"]
    untested_files: ["<file_path>"]
  
  # From @researcher
  linked_issues_detail:
    - ref: "<issue_ref>"
      title: "<string>"
      body_summary: "<string>"
      labels: ["<label>"]
      acceptance_criteria: ["<criterion>"]  # Extracted if present
  
  dependency_advisories:
    - package: "<name>"
      severity: "<level>"
      advisory_url: "<url>"
      description: "<string>"
  
  ci_failure_analysis:
    - check_name: "<name>"
      failure_type: "test" | "build" | "lint" | "other"
      error_summary: "<string>"
      related_files: ["<file_path>"]
  
  related_prs:
    - number: <number>
      title: "<string>"
      relevance: "<description>"
```

### REVIEW_FINDINGS (produced by R2)

```yaml
REVIEW_FINDINGS:
  pass_results:
    architecture:
      status: "completed" | "skipped" | "error"
      findings: [<Finding>]            # Finding structure from Conventional Comments spec
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
  # Summary
  summary:
    title: "<one-line summary>"
    body: "<markdown>"                 # 3-5 paragraph review summary
    stats:
      total_findings: <count>
      blockers: <count>
      criticals: <count>
      majors: <count>
      minors: <count>
      nits_shown: <count>
      nits_suppressed: <count>
      praises: <count>
  
  # Action
  action: "APPROVE" | "REQUEST_CHANGES" | "COMMENT_ONLY"
  action_reasoning: "<string>"
  
  # Deduplicated, filtered, ordered findings
  findings: [<Finding>]               # Ordered: blockers first, then by file order
  
  # Inline comments (for GitHub PR review API)
  inline_comments:
    - path: "<file_path>"
      line: <number>                   # Or use start_line + line for multi-line
      start_line: <number|null>
      side: "RIGHT"                    # Always RIGHT (reviewing the new code)
      body: "<rendered_comment>"       # Rendered Conventional Comment
  
  # Top-level review body
  review_body: "<rendered_markdown>"   # Full review summary + stats
  
  # Metadata
  dedup_log:                           # For transparency
    - merged: ["<finding_id>", "<finding_id>"]
      into: "<finding_id>"
      reason: "<string>"
  
  filtered_log:
    - finding_id: "<id>"
      reason: "below_threshold" | "suppressed" | "nit_budget" | "false_positive"
```

### REVIEW_ACTION (produced by R4)

```yaml
REVIEW_ACTION:
  decision: "post" | "edit" | "local_only" | "rerun" | "auto_post"
  edits: [<Finding>]                   # Only if decision = "edit" (user-modified findings)
  rerun_scope: ["<pass_name>"]         # Only if decision = "rerun"
```

---

## TODO TRACKING PATTERNS

```javascript
// R0: Intake
todowrite([
  { id: "r0-intake", content: "R0: Parse PR and load config", status: "in_progress", priority: "high" },
  { id: "r1-context", content: "R1: Gather context", status: "pending", priority: "high" },
  { id: "r2-review", content: "R2: Multi-pass review", status: "pending", priority: "high" },
  { id: "r3-synthesis", content: "R3: Synthesize comments", status: "pending", priority: "high" },
  { id: "r4-gate", content: "R4: User gate", status: "pending", priority: "medium" },
  { id: "r5-post", content: "R5: Post review", status: "pending", priority: "medium" },
])

// After R0 completes
todowrite([
  { id: "r0-intake", content: "R0: Parse PR and load config", status: "completed", priority: "high" },
  { id: "r1-context", content: "R1: Gather context", status: "in_progress", priority: "high" },
  // ... rest unchanged
])

// After R1 completes
todowrite([
  { id: "r1-context", content: "R1: Gather context", status: "completed", priority: "high" },
  { id: "r2-review", content: "R2: Multi-pass review (4 passes)", status: "in_progress", priority: "high" },
  // ... rest unchanged
])
```

---

## ERROR HANDLING

### PR Not Found
```markdown
## Review Aborted

**Reason**: PR #[number] not found in [repo].
**Action**: Verify the PR number and repository. Use `gh pr list` to find valid PRs.
```

### Private/Inaccessible Repo
```markdown
## Review Aborted

**Reason**: Cannot access repository [repo]. Authentication may be required.
**Action**: Ensure `gh auth status` shows valid authentication with repo access.
```

### CI Still Running
- Do NOT abort. Note in PR_CONTEXT: `ci_status: "pending"`.
- R2 proceeds without CI data. R3 adds a note: "CI checks were still running at review time."

### Empty Diff
```markdown
## Review Skipped

**Reason**: PR #[number] has no file changes.
**Action**: This may be a metadata-only PR. No code review needed.
```

### Config Parse Error
- Log warning with specific YAML error
- Fall back to all defaults
- Add note to review summary: "Review config had parse errors; using defaults."

### Subagent Failure
- If a R1 workstream fails: proceed with partial context, note gap in REVIEW_CONTEXT
- If a R2 pass fails: mark pass as "error", include error in REVIEW_FINDINGS, proceed with remaining passes
- If R3 fails: escalate to user (cannot produce review without synthesis)
- If R5 fails (posting): show rendered review locally, offer retry

### Large PR Handling
Based on `config.large_pr_strategy`:
- `"warn"`: Add warning to review summary, proceed normally
- `"split-suggestion"`: Suggest splitting PR, then proceed with review
- `"proceed"`: Review silently without warning
```


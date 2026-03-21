---
name: corvus-review-r3
description: PR Review Phase R3 - Comment synthesis, deduplication, filtering, and review document generation
---

# Phase R3: COMMENT SYNTHESIS

**Goal**: Transform raw REVIEW_FINDINGS into a polished, deduplicated, actionable REVIEW_DOCUMENT.

**Executor**: Corvus-Review direct (no subagent delegation).

**Input**: `PR_CONTEXT` (from R0) + `REVIEW_CONTEXT` (from R1) + `REVIEW_FINDINGS` (from R2).

**Output**: `REVIEW_DOCUMENT` object (see `corvus-review-extras` for schema).

---

## SYNTHESIS PIPELINE

```
REVIEW_FINDINGS
      │
      ▼
  ┌──────────────────┐
  │ 1. Deduplication  │  Merge overlapping findings across passes
  └────────┬─────────┘
           │
      ▼
  ┌──────────────────┐
  │ 2. False Positive │  Filter low-confidence findings
  │    Filtering      │
  └────────┬─────────┘
           │
      ▼
  ┌──────────────────┐
  │ 3. Severity       │  Apply threshold from config
  │    Filtering      │
  └────────┬─────────┘
           │
      ▼
  ┌──────────────────┐
  │ 4. Suppression    │  Apply suppression rules
  │    Application    │
  └────────┬─────────┘
           │
      ▼
  ┌──────────────────┐
  │ 5. Nit Budget     │  Enforce max_nits limit
  │    Enforcement    │
  └────────┬─────────┘
           │
      ▼
  ┌──────────────────┐
  │ 6. Ordering       │  Sort findings for presentation
  └────────┬─────────┘
           │
      ▼
  ┌──────────────────┐
  │ 7. Action         │  Determine APPROVE/REQUEST_CHANGES/COMMENT_ONLY
  │    Determination  │
  └────────┬─────────┘
           │
      ▼
  ┌──────────────────┐
  │ 8. Rendering      │  Generate GitHub-compatible review body
  └────────┬─────────┘
           │
      ▼
  REVIEW_DOCUMENT
```

---

## STEP 1: DEDUPLICATION

Identify and merge findings that describe the same issue from different passes.

### Deduplication Rules

Two findings are **duplicates** when ANY of these conditions is true:

| Condition | Example |
|-----------|---------|
| Same file + overlapping lines + similar concern | Pass 1 says "function too complex" on lines 10-30, Pass 2 says "too many branches" on lines 15-25 |
| Same root cause | Pass 2 says "missing null check" on file A line 10, Pass 3 says "null dereference vulnerability" on same location |
| Cross-file same issue | Pass 1 says "inconsistent error handling in module X" across 3 files, Pass 2 flags individual instances |

### Merge Strategy

When duplicates are found:
1. **Keep the higher-severity finding** as the primary
2. **Merge context** from the lower-severity finding into the primary's body
3. **Keep the higher confidence** value
4. **Add cross-reference**: set `related_to` on the primary to include the merged finding's ID
5. **Log the merge** in `dedup_log`:
   ```yaml
   - merged: ["arch-003", "logic-007"]
     into: "logic-007"
     reason: "Same issue: error handling in auth.ts:45-60. Kept logic finding (higher severity)."
   ```

### Deduplication Heuristics

- **Line overlap**: Findings within 5 lines of each other in the same file are candidates
- **Semantic overlap**: Findings with >50% word overlap in their titles are candidates
- **When in doubt, DON'T merge**: False deduplication is worse than duplicate comments

---

## STEP 2: FALSE POSITIVE FILTERING

Remove findings likely to be false positives.

### Filtering Rules

| Confidence | Action |
|------------|--------|
| >= 0.7 | Keep unconditionally |
| 0.5 - 0.69 | Keep only if severity >= major (3) |
| 0.3 - 0.49 | Keep only if severity >= critical (4) |
| < 0.3 | Drop (almost certainly false positive) |

### Exceptions to Filtering

- `praise`, `thought`, and `note` findings are NEVER filtered by confidence
- Security findings (pass == "security") use a lower threshold: keep if confidence >= 0.4 regardless of severity
- Findings with `suggestion` code are kept at confidence >= 0.5 (concrete suggestion implies higher value)

### Logging

For each filtered finding:
```yaml
- finding_id: "logic-005"
  reason: "false_positive"
  details: "Confidence 0.35 below threshold for severity minor"
```

---

## STEP 3: SEVERITY FILTERING

Apply the configured severity threshold.

```
threshold = PR_CONTEXT.config.severity_threshold  # default: "nitpick"
```

| Threshold | Drop findings with severity < |
|-----------|-------------------------------|
| `blocker` | 5 (drop everything except blockers) |
| `critical` | 4 |
| `major` | 3 |
| `minor` | 2 |
| `nitpick` | 1 (keep everything) |

### Exceptions

- `praise`, `thought`, and `note` findings (severity 0) are NEVER filtered by threshold
- If `action_override` is set, severity filtering still applies (override affects action, not content)

### Logging

For each filtered finding:
```yaml
- finding_id: "conv-002"
  reason: "below_threshold"
  details: "Severity nitpick (1) below threshold minor (2)"
```

---

## STEP 4: SUPPRESSION APPLICATION

Apply configured suppression rules from `PR_CONTEXT.config.suppressions`.

For each remaining finding, check against each suppression rule:

```yaml
suppressions:
  # By finding ID (exact match or prefix match for custom rules)
  - id: "no-console-log"
    paths: ["src/debug/**"]
  
  # By message pattern (regex against finding title + body)
  - message_pattern: "unused import"
    reason: "Auto-imports will be cleaned by CI"
```

### Suppression Matching

1. **ID-based**: If finding `id` starts with suppression `id` AND finding `file` matches any path in `paths`
2. **Message-based**: If suppression `message_pattern` regex matches finding `title` OR `body`

### Suppressed Finding Handling

- Set `suppressed: true` on the finding
- Do NOT remove it — keep in the finding list for transparency
- Suppressed findings do NOT count toward totals or action determination
- Suppressed findings are NOT rendered as inline comments
- Include a summary line: "N findings suppressed by configuration rules"

### Logging

```yaml
- finding_id: "logic-012"
  reason: "suppressed"
  details: "Matched suppression rule: message_pattern 'unused import'"
```

---

## STEP 5: NIT BUDGET ENFORCEMENT

Enforce the maximum number of nitpick comments.

```
max_nits = PR_CONTEXT.config.max_nits  # default: 3
```

### Budget Scope

Only these findings count toward nit budget:
- Label: `nitpick` (severity 1)
- Label: `minor` (severity 2)

These do NOT count toward nit budget:
- `blocker`, `critical`, `major` (severity 3-5)
- `praise`, `thought`, `note` (severity 0)
- Suppressed findings

### Enforcement

If (nitpick_count + minor_count) > max_nits:
1. Pool all nitpick and minor findings
2. Sort by: severity ASC, then confidence ASC (lowest-value first)
3. Drop from the bottom until count == max_nits
4. Log dropped findings with reason "nit_budget"
5. Track count for summary: `nits_suppressed = dropped_count`

### Logging

```yaml
- finding_id: "conv-003"
  reason: "nit_budget"
  details: "Nit budget exceeded (3/3). Dropped lowest-confidence nit."
```

---

## STEP 6: ORDERING

Sort remaining non-suppressed findings for presentation:

### Primary Sort: Severity (descending)
```
blocker (5) → critical (4) → major (3) → minor (2) → nitpick (1) → praise/thought/note (0)
```

### Secondary Sort: File order (as they appear in the diff)
```
Files sorted in the order they appear in PR_CONTEXT.changed_files
```

### Tertiary Sort: Line number (ascending)
```
Within the same file, findings sorted by line_start ASC
```

### Special Placement

- `praise` findings: interspersed at their file location (not grouped separately)
- `note` findings: placed at the end of their file's findings
- `thought` findings: placed after actionable findings for the same file

---

## STEP 7: ACTION DETERMINATION

Determine the review action: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT_ONLY`.

### Override Check

```
if PR_CONTEXT.config.action_override != null:
    action = config.action_override
    action_reasoning = "Action set by review configuration override"
    → Skip to Step 8
```

### Draft PR Override

```
if PR_CONTEXT.is_draft == true:
    action = "COMMENT_ONLY"
    action_reasoning = "Draft PR: providing feedback without blocking"
    → Skip to Step 8
```

### Action Rules

Based on the remaining non-suppressed findings:

| Condition | Action | Reasoning |
|-----------|--------|-----------|
| Any `blocker` findings | `REQUEST_CHANGES` | "Found [N] blocking issue(s) that must be fixed before merge" |
| Any `critical` findings (no blockers) | `REQUEST_CHANGES` | "Found [N] critical issue(s) that should be addressed" |
| Any `major` findings (no blockers/criticals) | `COMMENT_ONLY` | "Found [N] major suggestions but nothing blocking merge" |
| Only minor/nitpick/praise/thought/note | `APPROVE` | "No blocking issues found. [Summary of minor suggestions]" |
| No findings at all | `APPROVE` | "No issues found. Code looks good." |
| All passes errored | `COMMENT_ONLY` | "Review passes encountered errors. Partial review provided." |

### Confidence-Weighted Action

If the highest-severity finding has confidence < 0.7:
- Downgrade `REQUEST_CHANGES` → `COMMENT_ONLY`
- Add to reasoning: "Highest-severity finding has low confidence; requesting discussion rather than changes."

---

## STEP 8: RENDERING

Generate the GitHub-compatible review document.

### 8a. Review Summary Body

```markdown
## Code Review: PR #[pr_number] — [title]

**Action**: [ACTION_EMOJI] [ACTION]

[2-3 paragraph summary covering:
  - Overall assessment of the changes
  - Key findings (top 1-3 most important)
  - Any gaps in review coverage (skipped passes, partial context, CI issues)
]

### Summary

| Category | Count |
|----------|-------|
| Blockers | [N] |
| Critical | [N] |
| Major | [N] |
| Minor | [N] |
| Nitpicks | [N shown] ([M] suppressed) |
| Praise | [N] |

[If any passes were skipped or errored:]
> **Note**: [Pass name] was [skipped/encountered an error]. [Brief reason.]

[If CI was still running:]
> **Note**: CI checks were still running at review time. Results may change.

[If config had parse errors:]
> **Note**: Review configuration had parse errors; defaults were used.

[If findings were suppressed:]
> [N] findings suppressed by configured rules.

---

### Findings

[For each non-inline finding, render as:]
**[label]**: [title]
[body]
```

Action emojis:
- `APPROVE` → `[APPROVED]`
- `REQUEST_CHANGES` → `[CHANGES REQUESTED]`
- `COMMENT_ONLY` → `[COMMENTED]`

### 8b. Inline Comments

For each finding with `file` and `line_start`, generate an inline comment:

```yaml
inline_comments:
  - path: "<file_path>"
    line: <line_start>                    # For single-line comments
    start_line: <line_start if multi>     # For multi-line comments (when line_end != null)
    side: "RIGHT"                          # Always review new code
    body: |
      **<label>** (<pass>): <title>
      
      <body>
      
      [If suggestion is not null:]
      ```suggestion
      <suggestion>
      ```
```

### 8c. Assemble REVIEW_DOCUMENT

Combine all outputs into the final REVIEW_DOCUMENT:

```yaml
REVIEW_DOCUMENT:
  summary:
    title: "<one-line: e.g., 'Clean refactor with one edge case to handle'>"
    body: "<rendered review summary from 8a>"
    stats: <counts from Step 5/6>
  action: "<APPROVE|REQUEST_CHANGES|COMMENT_ONLY>"
  action_reasoning: "<from Step 7>"
  findings: <ordered list from Step 6>
  inline_comments: <from 8b>
  review_body: "<full rendered markdown from 8a>"
  dedup_log: <from Step 1>
  filtered_log: <from Steps 2-5>
```

---

## GATE ENFORCEMENT

<gate id="r3-exit" priority="9999">
  R3 MUST produce a valid REVIEW_DOCUMENT before proceeding to R4.
  
  VALID REVIEW_DOCUMENT requires:
  1. action is one of: APPROVE, REQUEST_CHANGES, COMMENT_ONLY
  2. action_reasoning is non-empty
  3. review_body is non-empty markdown
  4. findings list exists (may be empty)
  5. inline_comments list exists (may be empty)
  6. summary.title is non-empty
  7. All inline_comments have valid path + line
  
  If REVIEW_DOCUMENT cannot be produced → ABORT with error.
  R3 failures are critical and cannot be recovered from without re-running.
</gate>

---

## STATE CHECKPOINT

After R3 completes, output:

```
[R3 COMPLETE] Action: [ACTION] | Findings: [N] total ([M] inline)
Dedup: [N] merged | Filtered: [N] false-positive, [N] below-threshold, [N] nit-budget, [N] suppressed
→ Proceeding to R4 (User Gate)
```

---

## EDGE CASES

### All Findings Filtered
If every finding is removed by the pipeline:
- Action: `APPROVE`
- Summary: "No issues found after filtering. All detected patterns are within acceptable thresholds."
- This is valid — it means the code is clean or the config is aggressive.

### Only Praise Findings Remain
- Action: `APPROVE`
- Summary: Highlight the praised patterns.
- Post as a positive review (developers appreciate genuine praise).

### Very Large Finding Count (> 50)
- If more than 50 findings survive filtering, this is a code quality issue.
- Group findings by file in the summary.
- Consider: "This PR has a high density of findings. Consider addressing systemic issues."
- Still post all inline comments (GitHub handles this fine).

### Cross-Pass Conflicts
If Pass 1 (architecture) recommends an approach that conflicts with Pass 2 (correctness):
- Keep both findings.
- Add a `note` finding: "Findings arch-NNN and logic-MMM suggest different approaches. Author should evaluate trade-offs."
- Do NOT auto-resolve architectural conflicts.

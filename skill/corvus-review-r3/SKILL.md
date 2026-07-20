---
name: corvus-review-r3
description: PR Review Phase R3 - Comment synthesis, deduplication, filtering, and review document generation
---

# Phase R3: COMMENT SYNTHESIS

**Goal**: Transform raw REVIEW_FINDINGS into a polished, deduplicated, actionable REVIEW_DOCUMENT.

**Executor**: Corvus-Review direct (no subagent delegation).

**Input**: `PR_CONTEXT` (from R0) + `REVIEW_CONTEXT` (from R1) + `REVIEW_FINDINGS` (from R2).

**Output**: `REVIEW_DOCUMENT` object (see `corvus-review-extras` for schema).

**Single filter point**: R3 is the only place in the review pipeline where findings are dropped or suppressed. R2 detection passes report everything with severity and confidence attached; every config-driven filter — `severity_threshold`, `max_nits`, `suppressions`, path-rule `suppress_below` — is applied here. Filtering at detection time suppresses recall; filtering here keeps the full finding set available for transparent, config-driven decisions.

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
  │ 7. Reviewability  │  Derive complete/partial/skipped/failed once
  └────────┬─────────┘
           │
       ▼
  ┌──────────────────┐
  │ 8. Action         │  Apply fail-closed caps, override, then severity
  │    Determination  │
  └────────┬─────────┘
           │
       ▼
  ┌──────────────────┐
  │ 9. Rendering      │  Generate GitHub-compatible review body
  └────────┬─────────┘
           │
      ▼
  REVIEW_DOCUMENT
```

### Filter Logging

Every finding dropped or suppressed by Steps 2-5 gets a `filtered_log` entry, so filtering decisions stay auditable:

```yaml
- finding_id: "logic-005"
  reason: "<false_positive | below_threshold | suppressed | nit_budget>"
  details: "<one-line explanation, e.g., 'Confidence 0.35 below threshold for severity minor'>"
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

Pass 4 (conventions) marks suspected duplicates via `related_to` instead of dropping them — treat those as pre-screened merge candidates.

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

Log each drop in `filtered_log` with reason `false_positive`.

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

Log each drop in `filtered_log` with reason `below_threshold`.

---

## STEP 4: SUPPRESSION APPLICATION

Apply all configured suppression sources. R2 passes report findings unsuppressed — this step is the only place `suppressed: true` gets set.

### Suppression Sources

1. **Config suppressions** (`PR_CONTEXT.config.suppressions`): ID-based and message-based rules
2. **Path-rule suppressions** (`PR_CONTEXT.config.path_rules`): entries with `suppress_below`

```yaml
suppressions:
  # By finding ID (exact match or prefix match for custom rules)
  - id: "no-console-log"
    paths: ["src/debug/**"]
  
  # By message pattern (regex against finding title + body)
  - message_pattern: "unused import"
    reason: "Auto-imports will be cleaned by CI"

path_rules:
  # Suppress findings below a severity for matching paths
  - pattern: "**/*.generated.*"
    suppress_below: "major"
```

### Suppression Matching

1. **ID-based**: If finding `id` starts with suppression `id` AND finding `file` matches any path in `paths`
2. **Message-based**: If suppression `message_pattern` regex matches finding `title` OR `body`
3. **Path-rule-based**: If finding `file` matches a `path_rules` `pattern` that has `suppress_below` AND finding severity is below that threshold

### Suppressed Finding Handling

- Set `suppressed: true` on the finding
- Do NOT remove it — keep in the finding list for transparency
- Suppressed findings do NOT count toward totals or action determination
- Suppressed findings are NOT rendered as inline comments
- Include a summary line: "N findings suppressed by configuration rules"

Log each suppression in `filtered_log` with reason `suppressed`.

---

## STEP 5: NIT BUDGET ENFORCEMENT

Enforce the maximum number of nitpick comments only after deduplication, false-positive filtering, severity filtering, path suppression, and configured suppression have completed. This is the only nit budget enforcement in the pipeline — Pass 4 reports all conventions findings without pre-trimming.

```
max_nits = PR_CONTEXT.config.max_nits  # default: 3
```

### Budget Scope

Build `eligible_nitpicks` from the findings that remain retained and non-suppressed after Steps 1-4 and whose label is exactly `nitpick`. Do not infer eligibility from numeric severity or pass name.

Every other label bypasses this budget. Never count, drop, or mark `minor`, `major`, `critical`, `blocker`, `praise`, `thought`, or `note` as suppressed because of `max_nits`. Findings already suppressed by Step 4 are not eligible.

### Deterministic Strongest-First Selection

1. Sort `eligible_nitpicks` by confidence descending.
2. Break confidence ties by normalized file path ascending, then `line_start` ascending, then finding `id` ascending. Normalize a path by replacing `\\` with `/` and removing leading `./`; missing paths and lines sort after present values. Finding IDs are the final stable tie-break.
3. Keep (retain) the first `max_nits` findings. When `max_nits == 0`, retain none.
4. Mark every remaining eligible nitpick suppressed for presentation and action determination, but keep it in the finding list for auditability.
5. Add one `filtered_log` entry per remainder with `reason: "nit_budget"` and details that identify the configured limit and retained confidence order.
6. Set `nits_suppressed` to the number of nitpicks suppressed by this step.

Do not reuse the overall severity presentation order for this subset. Every candidate has the same exact label, so confidence is the strength key and the normalized location/ID sequence makes retention reproducible.

---

## STEP 6: ORDERING

Sort remaining non-suppressed findings for presentation:

1. **Primary — severity (descending)**: blocker (5) → critical (4) → major (3) → minor (2) → nitpick (1) → praise/thought/note (0)
2. **Secondary — file order**: files sorted in the order they appear in `PR_CONTEXT.changed_files`
3. **Tertiary — line number (ascending)**: within the same file, sort by `line_start` ASC

### Special Placement

- `praise` findings: interspersed at their file location (not grouped separately)
- `note` findings: placed at the end of their file's findings
- `thought` findings: placed after actionable findings for the same file

---

## STEP 7: AGGREGATE REVIEWABILITY

Derive aggregate reviewability exactly once from the four validated `REVIEW_FINDINGS.pass_results` statuses before determining action. Do not infer coverage from finding count.

Let `completed`, `skipped`, and `error` be the counts of those exact statuses:

| Reviewability | Exact derivation | Required visible state |
|---------------|------------------|------------------------|
| `complete` | `completed == 4` | Normal review; no aggregate coverage warning |
| `partial` | `completed >= 1` and `skipped + error >= 1` | Prominent coverage warning naming every skipped/error pass and reason |
| `skipped` | `skipped == 4` and `error == 0` | Informational notice that all four passes were skipped, with reasons |
| `failed` | `completed == 0` and `error >= 1` | Failure explanation; no actionable review and mandatory downstream `local_only` |

Mixed skipped/error statuses with zero completed passes are `failed`. A missing pass, duplicate pass result, unknown status, missing reason, or any status set other than exactly one result for each of the four passes is invalid control state: derive `failed`, explain the validation failure, and require downstream `local_only`.

Set `REVIEW_DOCUMENT.coverage_warning` from this derivation:

- `partial`: begin with `> [!WARNING]` and state that coverage is partial, how many passes completed, and which passes did not complete with their reasons.
- `skipped`: begin with `> [!NOTE]` and state that every review pass was intentionally skipped; this is an informational summary, not approval.
- `failed`: begin with `> [!CAUTION]` and state that no review pass completed, list errors/skips and reasons, and state that nothing will be posted.
- `complete`: use `null` for this aggregate warning.

Coverage text is derived control-plane evidence, not an editable finding. Preserve it through action overrides, interactive edits, and R5 posting.

---

## STEP 8: ACTION DETERMINATION

Determine the review action: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT_ONLY`.

Action is an opinion; it never authorizes a GitHub post. R4 produces the separate posting decision. Evaluate the canonical precedence from `corvus-review-extras` in this exact order, and never let a lower layer clear a rail or cap imposed by a higher one:

1. **Metadata/trust failures and no-post rails**: preserve any existing `local_only` requirement. Use informational `COMMENT_ONLY` only when an action is needed for schema compatibility. The comment-volume rail is evaluated after inline comments exist in R4 and again in R5.
2. **Draft/merged caps**: if `PR_CONTEXT.is_draft` or `PR_CONTEXT.is_merged`, force `COMMENT_ONLY` and preserve the informational state notice.
3. **Aggregate reviewability caps**:
   - `failed`: informational `COMMENT_ONLY`, with mandatory downstream `local_only`.
   - `skipped`: `COMMENT_ONLY` only.
   - `partial`: `REQUEST_CHANGES` is permitted only when a retained, non-suppressed blocker or critical exists; otherwise use `COMMENT_ONLY`. It never approves.
   - `complete`: no aggregate action cap.
4. **Trusted action override**: apply only a schema-valid `action_override` from verified base config or explicit trusted invocation, and only when it fits every cap above. It cannot create posting eligibility, clear `local_only`, remove a warning, approve `partial`/`skipped`, or make a draft/merged review blocking or approving.
5. **Severity/confidence action**: when no trusted override supplies an action, derive it from retained, non-suppressed findings using the table below.

| Condition | Action | Reasoning |
|-----------|--------|-----------|
| Any retained `blocker` findings | `REQUEST_CHANGES` | "Found [N] blocking issue(s) that must be fixed before merge" |
| Any retained `critical` findings (no blockers) | `REQUEST_CHANGES` | "Found [N] critical issue(s) that should be addressed" |
| Any retained `major` findings (no blockers/criticals) | `COMMENT_ONLY` | "Found [N] major suggestions but nothing blocking merge" |
| Only minor/nitpick/praise/thought/note | `APPROVE` | "No blocking issues found. [Summary of non-blocking feedback]" |
| No findings at all | `APPROVE` | "No issues found. Code looks good." |

### Confidence-Weighted Action

For a severity-derived `REQUEST_CHANGES`, require at least one retained blocker or critical with `confidence >= PR_CONTEXT.config.confidence_floor`. If none meets the floor, downgrade to `COMMENT_ONLY` and add: "Blocking findings are below the configured confidence floor; requesting discussion rather than changes."

This confidence downgrade applies only to severity-derived actions. It does not reorder a trusted override, but every override remains constrained by all higher rails and caps.

---

## STEP 9: RENDERING

Generate the GitHub-compatible review document.

### 9a. Review Summary Body

```markdown
## Code Review: PR #[pr_number] — [title]

**Action**: [ACTION_EMOJI] [ACTION]
**Reviewability**: [complete | partial | skipped | failed]

[If coverage_warning is non-null, render it here verbatim before the assessment.]

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

[For each pass, preserve its status and reason. Do not use these notes in place of coverage_warning:]
> **Note**: [Pass name] was [skipped/encountered an error]. [Brief reason.]

[If CI was still running:]
> **Note**: CI checks were still running at review time. Results may change.

[If PR_CONTEXT.config_provenance.fallback_warning is non-null, render that warning prominently and verbatim.]

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

### 9b. Inline Comments

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

### 9c. Assemble REVIEW_DOCUMENT

Combine all outputs into the final REVIEW_DOCUMENT:

```yaml
REVIEW_DOCUMENT:
  reviewability: "<complete|partial|skipped|failed>"
  coverage_warning: "<prominent partial/skipped/failed notice>" | null
  summary:
    title: "<one-line: e.g., 'Clean refactor with one edge case to handle'>"
    body: "<rendered review summary from 9a>"
    stats: <counts from Step 5/6>
  action: "<APPROVE|REQUEST_CHANGES|COMMENT_ONLY>"
  action_reasoning: "<from Step 8>"
  findings: <ordered list from Step 6>
  inline_comments: <from 9b>
  review_body: "<full rendered markdown from 9a>"
  dedup_log: <from Step 1>
  filtered_log: <from Steps 2-5>
```

---

## GATE ENFORCEMENT

<gate id="r3-exit">
  R3 must produce a valid REVIEW_DOCUMENT before proceeding to R4.

  VALID REVIEW_DOCUMENT requires:
  1. reviewability is exactly one of: complete, partial, skipped, failed
  2. reviewability was derived from exactly four named pass statuses with reasons; malformed status evidence is failed
  3. partial, skipped, and failed each have the required non-empty coverage_warning, and the same notice is present in review_body
  4. action is one of: APPROVE, REQUEST_CHANGES, COMMENT_ONLY and satisfies every reviewability/draft/merged cap
  5. failed records the mandatory downstream local_only/no-post requirement
  6. action_reasoning is non-empty
  7. review_body is non-empty markdown
  8. findings list exists (may be empty)
  9. inline_comments list exists (may be empty)
  10. summary.title is non-empty
  11. All inline_comments have valid path + line

  If REVIEW_DOCUMENT cannot be produced, emit a synthesis-failure reason and
  force the downstream posting decision to local_only. Display any available
  evidence locally and terminate the posting path; autonomous mode never asks
  for recovery or starts a re-run.
</gate>

---

## STATE CHECKPOINT

After R3 completes, output:

```
[R3 COMPLETE] Reviewability: [complete/partial/skipped/failed] | Action: [ACTION] | Findings: [N] total ([M] inline)
Dedup: [N] merged | Filtered: [N] false-positive, [N] below-threshold, [N] nit-budget, [N] suppressed
[If failed: → R4 must emit local_only without a posting prompt]
[Otherwise: → Proceeding to R4 (Decision Gate)]
```

---

## EDGE CASES

### All Findings Filtered
If every finding is removed by the pipeline:
- Reapply Step 8; only an uncapped `complete` review may derive `APPROVE` from the empty retained set.
- Summary: "No issues remain after filtering. Review action still reflects coverage and safety caps."
- A `partial`, `skipped`, `failed`, draft, or merged review does not manufacture approval from an empty finding set.

### Only Praise Findings Remain
- Reapply Step 8; only an uncapped `complete` review may derive `APPROVE`.
- Summary: Highlight the praised patterns.
- Praise bypasses the nit budget and remains visible.

### Very Large Finding Count (> 50)
- If more than 50 findings survive filtering, this is a code quality issue.
- Group findings by file in the summary.
- Consider: "This PR has a high density of findings. Consider addressing systemic issues."
- Do not infer posting eligibility. R4 applies the configured comment-volume rail to the final inline-comment count.

### Cross-Pass Conflicts
If Pass 1 (architecture) recommends an approach that conflicts with Pass 2 (correctness):
- Keep both findings.
- Add a `note` finding: "Findings arch-NNN and logic-MMM suggest different approaches. Author should evaluate trade-offs."
- Do NOT auto-resolve architectural conflicts.

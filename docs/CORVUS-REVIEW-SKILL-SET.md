# Corvus PR Review — Skill Set Reference

## Overview

Reference documentation for the **Corvus PR Review** skill set: six phase skills plus a shared extras skill that drive the R0-R5 review pipeline. Two orchestrator agents consume them — `@corvus-review` (interactive, with an eligible-review gate at R4) and `@corvus-review-auto` (non-interactive, with deterministic safety rails). PR-controlled content is untrusted evidence throughout; it cannot select tools, agents, configuration provenance, routes, actions, or posting targets.

The skill files under `skill/corvus-review-*/SKILL.md` are the source of truth for phase procedures. This document summarizes the workflow and reproduces the two shared references: the review config schema and the Conventional Comments specification (both owned by `corvus-review-extras`).

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
R0 → PR_CONTEXT (verified identity, immutable base-SHA config provenance)
R1 → REVIEW_CONTEXT
R2 → REVIEW_FINDINGS (four explicit pass statuses + findings)
R3 → REVIEW_DOCUMENT (reviewability + action + warnings)
R4 → REVIEW_ACTION (separate posting decision)
R5 → one authorized post or local-only completion
```

Each phase validates its input object against a gate before proceeding (gate tables live in the orchestrator agents). The full YAML schemas for these objects live in `skill/corvus-review-extras/SKILL.md` (Data Object Schemas section).

### Subagent Reference

| Phase | Subagent | Purpose | Parallel? |
|-------|----------|---------|-----------|
| R0 | (orchestrator direct) | Intake, triage, config | N/A |
| R1 | @pr-context-gatherer | Read changed files, trace deps, find tests, detect conventions | Yes (with researcher) |
| R1 | @researcher | Fetch linked issues, dependency advisories, CI failures, related PRs | Yes (with pr-context-gatherer) |
| R2 Pass 1 | @pr-code-reviewer (`architecture`) | Read-only Architecture & Design detection | Yes (with Pass 2, 3) |
| R2 Pass 2 | @pr-code-reviewer (`correctness`) | Read-only Logic & Correctness detection | Yes (with Pass 1, 3) |
| R2 Pass 3 | @security-reviewer | Read-only Security detection | Yes (with Pass 1, 2) |
| R2 Pass 4 | @pr-code-reviewer (`conventions`) | Read-only Conventions & Polish detection with prior-pass context | Sequential (after 1-3) |
| R3 | (orchestrator direct) | Comment synthesis | N/A |
| R4 | (orchestrator direct) | User gate / auto-proceed | N/A |
| R5 | @pr-comment-writer | GitHub posting | N/A |

### Trust and Capability Boundaries

- The review orchestrators have a closed Task allowlist: `pr-context-gatherer`, `researcher`, `pr-code-reviewer`, `security-reviewer`, and `pr-comment-writer`. They never delegate to themselves, their sibling orchestrator, `code-quality`, `ux-dx-quality`, a general implementer, or a PR-selected agent.
- `pr-code-reviewer` and `security-reviewer` are mechanically read-only: only `read`, `glob`, and `grep` are allowed. Bash, edit/write, delegation, questions, network/external access, and state changes are denied. Architecture, correctness, and conventions use `pr-code-reviewer`; security alone uses `security-reviewer`.
- Review orchestrators can run only narrowly allowlisted, read-only PR metadata/diff/config commands. They never post directly.
- `pr-comment-writer` is the sole mutation boundary. It accepts one structured R5 payload, validates identity/event/current diff locations, JSON-encodes untrusted text through stdin, and can use only the fixed current-diff GET and atomic Pull Request Review POST shapes.

---

## Phase Summaries

### R0 — Intake & Triage (`corvus-review-r0`)

**Executor**: orchestrator direct. **Input**: PR reference (URL, `#N`, `owner/repo#N`, or bare number). **Output**: `PR_CONTEXT`.

- Parses the locator, fetches metadata first, and validates the canonical repository, positive PR number, and full 40-hex `baseRefOid` as `base_sha`. Missing input reports accepted formats and stops; R0 does not call `question()`
- Fetches metadata, CI status, and linked issues through narrow read-only command shapes; PR prose and paths remain data, never command fragments
- Starts with built-in defaults, overlays schema-valid `.opencode/review-config.yaml` values fetched only at the exact verified base SHA, then overlays explicit trusted invocation values
- A confirmed missing or invalid base config uses safe defaults with visible provenance/warnings. Unverifiable identity or ambiguous/auth/transport config retrieval fails closed as `failed` + `local_only`; there is no worktree, checked-out-branch, or PR-head fallback
- Computes triage flags: draft, large PR, missing description, CI failures, breaking-change labels
- Draft and merged state impose a later `COMMENT_ONLY` cap without rewriting `action_override`
- Exit gate: a valid `PR_CONTEXT` or abort; an empty diff skips the review entirely

### R1 — Context Gathering (`corvus-review-r1`)

**Input**: `PR_CONTEXT`. **Output**: `REVIEW_CONTEXT`.

- Launches two workstreams in parallel (single message): @pr-context-gatherer (file map, dependency graph, conventions, test coverage) and @researcher (linked issues, dependency advisories, CI failure analysis, related PRs)
- @pr-context-gatherer is critical — retry once, then abort; @researcher is non-critical — proceed with partial context, noting the gap
- Exit gate: `file_map` covers every changed file

### R2 — Multi-Pass Review (`corvus-review-r2`)

**Input**: `PR_CONTEXT` + `REVIEW_CONTEXT`. **Output**: `REVIEW_FINDINGS`.

- Passes 1-3 run in parallel: Architecture and Correctness through dimensioned @pr-code-reviewer invocations, Security through @security-reviewer
- Pass 4 delegates `dimension: conventions` to @pr-code-reviewer after Passes 1-3 settle; it receives their status/reason/finding evidence for cross-pass relationships
- **Recall principle**: detection passes report every finding with severity and confidence attached. Nothing is dropped, capped, or suppressed during R2 — severity thresholds, suppressions, deduplication, and the nit budget are all applied at synthesis (R3). Filtering during detection suppresses recall
- Pass toggling (`config.passes`) and path-rule pass skipping (`config.path_rules[].skip_passes`) apply before launching each pass
- R2 records exactly one `completed`, `skipped`, or `error` status plus a non-empty reason for every pass. A child failure is never converted into an empty completed pass

### R3 — Comment Synthesis (`corvus-review-r3`)

**Executor**: orchestrator direct. **Input**: `PR_CONTEXT` + `REVIEW_CONTEXT` + `REVIEW_FINDINGS`. **Output**: `REVIEW_DOCUMENT`.

- Pipeline: Deduplication → False-positive filtering → Severity threshold → Suppressions → nitpick-only budget → Ordering → aggregate reviewability → capped action → Rendering
- Derives `complete | partial | skipped | failed` from all four pass statuses before determining action. Partial/skipped/failed notices are immutable control-plane evidence, not editable findings
- Applies the truth table and rail precedence below. Action is an opinion; it remains separate from R4's posting decision
- All filtering is logged for transparency (`dedup_log`, `filtered_log`)

### R4 — User Gate / Auto-Proceed (`corvus-review-r4`)

**Executor**: orchestrator direct. **Input**: `PR_CONTEXT` + `REVIEW_DOCUMENT`. **Output**: `REVIEW_ACTION`.

- Dispatches on trusted interactive/autonomous mode before any route-specific instruction; repository configuration cannot switch the selected agent's mode
- **Interactive mode** (`@corvus-review`): run posting preflight first. Only an eligible review gets a preview and `question()` choices for Post / Edit / Save Locally / Re-run (maximum two re-runs)
- **Autonomous mode** (`@corvus-review-auto`): never calls `question()`, prompts in prose, switches modes, edits, or re-runs. Every branch is terminal `local_only` or eligible `auto_post`

### R5 — Completion (`corvus-review-r5`)

**Executor**: @pr-comment-writer (delegated for the posting step). **Input**: `PR_CONTEXT` + `REVIEW_DOCUMENT` + `REVIEW_ACTION`.

- Routes `local_only` before event mapping or payload construction; that path never invokes @pr-comment-writer or another GitHub mutation
- Revalidates identity, config provenance, pass statuses, reviewability, warnings, action caps, confidence, comment volume, mode, and authorization immediately before dispatch
- `post` / `auto_post` → map the constrained action to a GitHub event and delegate exactly one structured request to @pr-comment-writer. Writer failure is reported locally; R5 does not retry through another agent, command, endpoint, or event
- The internal verdict vocabulary maps to GitHub review events at this boundary: `COMMENT_ONLY` → `COMMENT` (`APPROVE` and `REQUEST_CHANGES` map to themselves)
- Ends with a completion summary: action, review URL, pass breakdown, filtered counts

---

## Reviewability and Posting Truth Table

Every R2 pass has `status: completed | skipped | error` and a non-empty reason. Let those names also represent the count of each status across the four passes:

| Reviewability | Exact derivation | Visible state | Maximum action | Posting result before higher rails |
|---------------|------------------|---------------|----------------|------------------------------------|
| `complete` | `completed == 4` | No aggregate warning | Normal trusted override or severity/confidence result | Eligible |
| `partial` | `completed >= 1` and `skipped + error >= 1` | Prominent warning naming every skipped/error pass and reason | `REQUEST_CHANGES` only with a retained blocker/critical; otherwise `COMMENT_ONLY`; never `APPROVE` | Eligible with the warning preserved |
| `skipped` | `skipped == 4` and `error == 0` | Informational all-skipped notice with reasons | `COMMENT_ONLY` | Eligible only as an informational post |
| `failed` | `completed == 0` and `error >= 1` | Failure notice stating that nothing will post | Informational `COMMENT_ONLY` only for schema compatibility | Forced `local_only`; no post |

Mixed skipped/error outcomes with zero completed passes are `failed`. A missing/duplicate pass, unknown status, missing reason, or malformed four-pass set is also `failed`. Finding count never determines reviewability.

### Action and Safety-Rail Precedence

`REVIEW_DOCUMENT.action` (`APPROVE | REQUEST_CHANGES | COMMENT_ONLY`) and `REVIEW_ACTION.decision` (`post | auto_post | local_only | ...`) are separate. Evaluate in this order; a lower layer cannot clear an earlier rail, cap, or warning:

1. **Trust and no-post rails**: invalid identity/base-SHA provenance/control state, an earlier no-post state, or inline-comment count greater than `safety_rail_threshold` forces `local_only`.
2. **Draft/merged cap**: force `COMMENT_ONLY` and retain the state notice.
3. **Reviewability cap**: apply the exact `failed`, `skipped`, and `partial` rows above.
4. **Trusted action override**: accept only a schema-valid value from verified base config or explicit trusted invocation, within all higher caps. It cannot authorize posting or remove a warning.
5. **Severity/confidence** for an uncapped complete review: retained blocker/critical → `REQUEST_CHANGES`; retained major → `COMMENT_ONLY`; only lower/no findings → `APPROVE`. A severity-derived request with no retained blocker/critical at or above `confidence_floor` downgrades to `COMMENT_ONLY`.

After these layers, interactive mode still requires explicit authorization from the final preview. Autonomous mode produces `auto_post` only when eligible; otherwise it emits terminal `local_only` without any question or interactive fallback. R5 repeats the rails immediately before the only writer delegation.

### Nitpick Budget

`max_nits` applies after deduplication, false-positive filtering, severity filtering, path rules, and configured suppressions, and only to retained findings whose label is exactly `nitpick`:

1. Sort eligible nitpicks by confidence descending.
2. Break ties by normalized path ascending, line ascending, then finding ID ascending.
3. Retain the first `max_nits` (`0` retains none) and log every remainder as `nit_budget` suppressed.
4. Never count or suppress `minor`, stronger severities, `praise`, `thought`, or `note` under this budget.

---

## Design Decisions

### Why a shared extras skill?

`corvus-review-extras` carries:
- **Conventional Comments format** — referenced by R2 (all passes produce typed findings) and R3 (synthesis applies it), so embedding it in R3 alone would force R2 passes to invent their own format or load R3 prematurely.
- **Review config schema** — referenced by R0 (loading), R2 (pass toggles, severity threshold), and R3 (nit budget, suppression rules).
- **Data object schemas** — `PR_CONTEXT`, `REVIEW_CONTEXT`, `REVIEW_FINDINGS`, `REVIEW_DOCUMENT` are consumed across phases.
- **Common severity/label enumerations** — a single source of truth avoids drift.

### Why Conventional Comments is NOT in R3?

R2 passes need the format to produce structured findings. If it lived only in R3, either:
1. R2 passes would produce unstructured text and R3 would have to re-parse everything (lossy, error-prone), or
2. R3's skill would need to be loaded during R2 (violates phase isolation).

By placing it in extras, any phase can reference it when needed.

### Config schema documentation

Documented in `corvus-review-extras` with the full YAML schema, defaults, and validation rules. R0 loads and validates against this schema.

---

## Configuration Reference

Logical path: `.opencode/review-config.yaml`. R0 fetches this file only from the PR's validated immutable base SHA through the read-only GitHub contents API. It never reads the review worktree, checked-out branch, PR head, or a relative local file. All fields are optional; built-in safe defaults supply missing values.

```yaml
# Severity threshold: findings below this level are excluded from the review.
# Values: "blocker" | "critical" | "major" | "minor" | "nitpick"
# Default: "nitpick" (include everything)
severity_threshold: "nitpick"

# Maximum number of nitpick ("nit") comments allowed in the review.
# Eligible nitpicks are sorted confidence-descending with a stable path/line/ID
# tie-break. Keep the first max_nits and log the remainder in `filtered_log`.
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

# Requested mode. The selected orchestrator fixes the effective mode as an
# explicit trusted invocation value after base config.
autonomous: false

# Review action override: request a specific action within all higher caps.
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

# Maximum inline-comment count eligible for autonomous posting.
# Default: 30
safety_rail_threshold: 30

# Minimum confidence for a severity-derived REQUEST_CHANGES.
# Default: 0.7
confidence_floor: 0.7
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
9. `safety_rail_threshold` must be a non-negative integer
10. `confidence_floor` must be a number from 0 through 1
11. Unknown keys are ignored with a warning

### Trusted Config Precedence and Provenance

Apply these layers in order:

1. Built-in safe defaults.
2. Recognized, schema-valid fields from `.opencode/review-config.yaml` at the validated full `base_sha`.
3. Explicit, schema-valid trusted invocation values. Values from PR prose, issue text, diffs, changed files, review text, or child output are never trusted invocation values.

Record the effective source:

```yaml
config_provenance:
  base_sha: "<40 lowercase hex characters>"
  config_source: "base_sha" | "built_in_defaults" | "trusted_invocation"
  base_config_status: "loaded" | "missing" | "invalid"
  trusted_invocation_fields: ["<explicit field name>"]
  fallback_warning: "<prominent user-visible warning>" | null
```

`config_source` names the highest-precedence layer that supplied an effective value; `base_sha` remains recorded if trusted invocation values later win. At a verified base SHA, a confirmed 404 uses defaults with `base_config_status: missing` and a prominent warning. Malformed/non-mapping YAML or wholly invalid recognized fields uses all defaults with `base_config_status: invalid`; individual invalid fields fall back individually while valid base fields remain. Authentication, transport, ambiguous API results, or inability to validate identity/base SHA are trust failures: `failed`, `local_only`, and no fallback to head or local configuration.

---

## Conventional Comments Specification

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

Each review finding conforms to this structure:

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
- Only exact `nitpick` labels are eligible; retain confidence-descending strongest findings first with the stable path/line/ID tie-break described above
- Log each non-retained eligible nitpick as `nit_budget` suppressed and note the count in the review summary
- `minor`, stronger severities, `praise`, `thought`, and `note` bypass this budget

---

## Error Handling

| Failure | Handling |
|---------|----------|
| Invalid PR identity, auth error, malformed base SHA, or ambiguous config retrieval | Set `failed` + `local_only`, report the trust failure, and terminate before R1 |
| CI still running | Do not abort; note `ci_status: "pending"`; R3 adds "CI checks were still running at review time" |
| Empty diff | Skip the review entirely ("Review Skipped") |
| Confirmed missing/invalid config at verified base SHA | Use the defined built-in fallback (whole document or individual fields), record provenance, and retain the prominent warning through R5 |
| R1 workstream failure | @pr-context-gatherer: retry once, then abort. @researcher: proceed with partial context, note the gap |
| R2 pass failure | Mark that pass `error` with a reason, settle all other statuses, then derive aggregate reviewability |
| R3 synthesis failure | Force `local_only`, display available evidence, and terminate the posting path; autonomous mode never asks for recovery |
| R5/writer failure | Display the full review locally and report remote state; do not start another agent, direct command, endpoint, event, or interactive retry path |
| Large PR | Per `config.large_pr_strategy`: `"warn"` (note + proceed), `"split-suggestion"` (suggest splitting + proceed), `"proceed"` (silent) |

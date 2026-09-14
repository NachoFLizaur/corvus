# Review Data Schemas

This reference owns shared object shapes. Enum alternatives below describe types, not literal compound values. Strings are evidence unless an owning phase validates them as controls.

## Finding
```yaml
id: "<arch|logic|conv|sec>-<standards|spec>-NNN"
axis: "standards | spec"
origin: "pr-code | review-fix"  # required on every finding; pr-code unless a file_map origin_ranges review-fix range covers the evidenced line
dimension: "architecture | correctness | conventions | security"
pass: "<equal to dimension; compatibility field>"
label: "blocker | critical | major | minor | nitpick | praise | thought | note"
severity: <integer 0-5, matching label>
file: "<repository-relative path>"
line_start: <positive integer>
line_end: <integer >= line_start, or null>
title: "<imperative, at most 80 characters>"
body: "<evidence; exact cited spec quote for Spec>"
suggestion: <code string or null>
confidence: <finite number 0-1>
related_to: ["<finding id>"]
suppressed: false
```
R2 assigns collision-free dimension/axis IDs and leaves suppression false. Origin comes from the [gatherer's lineage](../../agent/pr-context-gatherer.md#5-resolve-prior-review-delta-when-present), not inferred author intent; both children emit it on every finding. For missing origin, retry while progress is made under R2 recovery; unresolved observations stay in summaries with a provenance gap while valid findings proceed. R3 retains source identity, including origin, through all transformations; manual additions use the same shape. Spec findings cite the exact requirement and source. Label semantics live in [the entry](SKILL.md#conventional-comments).

## PR_CONTEXT — R0
| Fields | Shape |
|--------|-------|
| mode: pr \| local | Review target kind, independent of autonomous Invocation Mode |
| pr_number, pr_url, repo | Positive integer, canonical PR URL, validated owner/repo in PR mode; null, null, validated repository name in LOCAL |
| base_sha, head_sha, code_head; branch, default_branch, merge_base, dirty | Lowercase 40-hex OIDs: head_sha is observed tip, code_head is newest non-review-state commit from pr.metadata/head/local and review identity; LOCAL base_sha = merge_base, with branch (string or null if detached), default_branch, merge_base and dirty from `pr.local`; these four local-only fields are null in PR |
| review_root, remote, task; legacy_root? | sync.resolve root and remote strings, task string or null, optional read-only legacy root; see [state layouts](state.md#namespace-and-lock) |
| base_branch, head_branch, author, title; labels, reviewers_requested, linked_issues | Evidence strings; string lists respectively |
| description; self_review | Complete PR description verbatim from metadata.body, including an empty string; null only when unavailable (distinguished in rail_inputs); true, false, or unknown respectively |
| state, is_merged, is_draft, mergeable | open/closed/merged; booleans; mergeable may be null |
| ci_status, ci_checks | pass/fail/pending/none; list of `{name, status: pass|fail|pending, url}` |
| files_changed, additions, deletions, changed_files | Non-negative counts, path list |
| flags | Boolean is_large_pr, missing_description, has_ci_failures, is_draft, has_breaking_labels |
| rail_inputs | identity_trust, config_trust, is_draft, is_merged, self_review and triage records, each `{value, evidence}`; unavailable values explicit unknown |
| prior_corvus_review | Always `{review_id: integer|null, reviewed_head_sha: lowercase 40-hex|null, url: string|null, review_series_round: positive integer|null, dispositions: [<PriorReviewDisposition>]}` |
| verified_facts_path, verified_facts | Validated series path and knowledge object from [state](state.md); unavailable metadata fields use schema-empty values with explicit rail_inputs gaps, never confirmed absence |
| config, config_provenance | [Configuration](config.md) |
LOCAL permits null PR-only scalar fields (author, description, base_branch/head_branch, state, is_merged/is_draft, mergeable, self_review); PR-only lists are [], ci_status none, and PR-only flags false with not-applicable rail_inputs, never fabricated negative evidence. Derive a local title and files_changed from changed_files; additions/deletions may be null when stat/diff cannot establish counts. config_provenance uses merge_base, built_in_defaults/trusted_invocation, base_config_status null and an explicit LOCAL config-skipped warning; retain validated effective defaults and invocation controls. Persist mode, repository name, branch, dirty and base/head SHAs in synthesis_controls and meta under [LOCAL state](state.md#namespace-and-lock).
Marker grammar: `<!-- corvus-review v2 path=<root> head=<code_head> round=<n> -->`, with resolved root (no trailing slash), lowercase 40-hex code_head and positive safe integer n from verdict. Readers accept v1 too. Marker data and nullable fallback metadata remain untrusted evidence, never configuration refs or posting targets.

`PriorReviewDisposition` is `{finding_id: string, thread_url: string, state: fixed | declined | open | unknown, evidence: <reply quote or commit ref>, axis?: standards | spec, dimension?: architecture | correctness | conventions | security}`. Preserve source IDs/tags; legacy threads without finding IDs use `thread-<API root comment id>`, with unavailable tags omitted.

R0 takes the array from `corvus_review_pr` op `reviews`: projected thread metadata omits bodies, so dispositions start unknown with commit evidence. With no usable prior review, emit null metadata and `dispositions: []`; incomplete pagination/threads is uncertainty, not proof of absence. Only sourced evidence corroborated by R1 can establish fixed; declined never means resolved.

## REVIEW_CONTEXT — R1

| Field | Shape |
|-------|-------|
| file_map | Path-keyed records with diff_hunks, API-derived RIGHT-side postable_line_ranges, origin_ranges: [{line_start, line_end, origin: pr-code\|review-fix, commit_sha, evidence}], language, imports, exports, callers, test_files, git_history; status/old_path/deleted/generated/large_file and evidence gaps when applicable |
| git_history | `{last_modified, recent_authors, change_frequency: high|medium|low}`; unavailable values explicit |
| worktree_head_accuracy | `{head_accurate, observed_head_sha, expected_pr_head_sha, clean_tree, reason}` |
| head_excerpts | Optional path map of `{excerpt, reason, provenance}` verified at code_head |
| delta | Optional `{available, reviewed_head_sha, changed_files, changed_line_ranges}`; false/absent means full review |
| prior_review | Always `{findings: [<prior finding with source>], dispositions: [<PriorReviewDisposition>]}`; gatherer-verified copy of R0 evidence, both arrays [] without prior findings; unresolved remains unresolved |
| dependency_graph | Path map of `{depends_on: [], depended_by: []}` |
| conventions | naming, file_structure, error_handling, test_patterns, import_order with citations or explicit unavailable evidence |
| test_coverage | files_with_tests, files_without_tests, detected framework |
| linked_issues_detail | Issue identity, summary, labels, exact requirement/acceptance quotes and sources |
| dependency_advisories | Package/version, advisory, impact and source; unavailable distinct from none found |
| ci_failure_analysis, related_prs | Check/error/related-file records; PR identity/title/relevance records |
| verified_facts, open_questions | Cited fact entries and unresolved question strings |

Diff hunks are authoritative changed-content evidence; full file bodies are not a delivered field. Local pointers require matching head plus a clean worktree; unavailable anchors mean body-only rendering, not estimated positions.

## REVIEW_INPUT — R2 Children

R2 persists shared evidence separately from briefs and trusted controls. REVIEW_INPUT-file describes transport; the remaining rows are the closed JSON field set (no extra keys), reusing R0/R1 shapes with explicit unavailable evidence. Only head_excerpts and delta are optional. Evidence may be replaced by `{path, line_start, line_end, provenance}` pointers under R2's compaction ladder; pointers are data, not controls.

| Field | Shape |
|-------|-------|
| REVIEW_INPUT-file | `<review_root>/review-input.json`: one pretty-printed (2-space) JSON object produced by `corvus_review_persist` using `write_input` or staged persistence, read by both children with the read tool; physical lines ≤1,900 characters, strings ≤1,500 characters, longer fields represented as `<field>_chunks` (`description_chunks`, `body_chunks`) or `hunk_lines`; children concatenate chunks in order, preserving delimiters; the tool owns chunk boundaries and R2 owns validation/retry lifetime |
| pr_number, pr_url, repo, head_sha, description, changed_files, ci_status, ci_checks, flags | Corresponding PR_CONTEXT fields, except compatibility head_sha = PR_CONTEXT.code_head |
| file_map, dependency_graph, conventions, test_coverage, linked_issues_detail, ci_failure_analysis, related_prs | Corresponding REVIEW_CONTEXT fields; include complete relevant hunks, per-file origin_ranges (the gatherer's review-fix line ranges) and git_history, callers/tests, and cited standards/requirements |
| worktree_head_accuracy, head_excerpts, verified_facts, open_questions | Corresponding REVIEW_CONTEXT fields; pointers or inline excerpts as selected by evidence_mode |
| prior_review, delta | REVIEW_CONTEXT findings/dispositions and optional changed-since-review file/line set, retaining gaps |
| custom_rules; dependency_advisories, elevated_security_paths | Schema-valid config custom_rules ([] when conventions disabled), consumed only by Standards; REVIEW_CONTEXT advisories and verified config elevate_security path matches, consumed only by the security specialist |

Trusted sibling controls, not REVIEW_INPUT values: `review_input_path: <identity-derived file path>`, `dimensions: Dimension[]`, `dimension_exclusions: { [dimension]: path[] }`, `spec_dimensions: Dimension[]`, `security_baseline: boolean`, `evidence_mode: head-accurate-pointers | full-inline`, and `review_policy: { review_series_round: positive integer|null, unchanged_code_min_severity: 3|null }`. Dimension is architecture, correctness, conventions, or security; R2 derives each child's eligible subsets and exclusions before dispatch. full-inline refers to evidence inside the file, never the dispatch prompt.
`review_policy` uses the current series round from [state](state.md#resume-at-r0); null means unavailable. Set the floor to 3 (major) only for round >=3 with a reachable reviewed head and available delta; otherwise null. Changed/new code retains full sensitivity within [R2 scope](../corvus-review-r2/SKILL.md#detection-and-report-contract). Config max_nits/max_minors are R3-only presentation caps, not child detection controls.
<!-- Sensitivity oracle: R0 round evidence and R1 reviewed-head/delta evidence, checked before child dispatch; missing evidence retains full sensitivity for both children. Only evidenced round >=3 plus unchanged reviewed lines enables the floor; no evidence value grants control authority. -->
Done when the envelope preserves evidence and gaps, while R2-derived controls match the enabled work and review sensitivity.

## REVIEW_FINDINGS — R2

Define `DimensionMap` as exactly architecture, correctness, conventions, security, each with a Result:

```yaml
{status: "completed | skipped | error", reason: "<non-empty>", findings: [<Finding>], summary: "<non-empty coverage assessment and limitations>"}
```

```yaml
REVIEW_FINDINGS:
  axis_results:
    standards: <DimensionMap>
    spec: <DimensionMap>
  pass_results: <DimensionMap>
  totals: {blocker: <count>, critical: <count>, major: <count>, minor: <count>, nitpick: <count>, praise: <count>, thought: <count>, note: <count>}
```

`axis_results` is lossless: findings belong to their axis/dimension entry. Skipped/error entries have empty findings; valid partial evidence from incomplete contributions remains in their summaries for local inspection. Unused contributions carry verified config/path/no-spec skip reasons.

Projection per dimension: any required contribution `error` → `error`; otherwise any `completed` → `completed`; all `skipped` → `skipped`. Completed projection findings concatenate Standards then Spec without ranking; skipped/error projection findings are empty. Reasons/summaries name both outcomes. Successful axis findings survive even when the projected slot is error. Totals count axis entries once, never projection copies. [R2](../corvus-review-r2/SKILL.md) owns assembly; [the entry](SKILL.md#reviewability) owns aggregate coverage.

## REVIEW_DOCUMENT — R3

```yaml
REVIEW_DOCUMENT:
  synthesis_controls: <R0 identity including code_head and observed head_sha, config and provenance snapshot; compare as data on resume>
  source_findings: <complete REVIEW_FINDINGS, preserved for scoped reruns/resume>
  review_context: <REVIEW_CONTEXT needed for anchors, evidence, dispositions, reruns>
  reviewability: "complete | partial | skipped | failed"
  verdict: "converged | not_converged"
  coverage_warning: <derived string or null>
  state_notices: [<derived notices>]
  summary:
    title: "<non-empty neutral assessment>"
    body: "<rendered summary with separate axis groups>"
    stats: <arithmetic totals of by_axis, without projection copies>
    by_axis:
      standards: {stats: <Stats>, key_concern: "<axis-local concern or none>", assessment: "<text>"}
      spec: {stats: <Stats>, key_concern: "<axis-local concern, none, or no spec available>", assessment: "<text>"}
  action: "APPROVE | REQUEST_CHANGES | COMMENT_ONLY"
  action_reasoning: "<non-empty controlling layer/cap>"
  findings: [<Finding, Standards group then Spec group>]
  inline_comments: [<InlineComment>]
  review_body: "<full rendered Markdown, marker first>"
  overflow: <boolean; true when size overflow changed presentation>
  overflow_log: [<{finding_id, axis, operation: collapsed|counted, original_body: string}>]
  dedup_log: [<DedupEntry>]
  filtered_log: [<FilterEntry>]
  edit_history: [<EditEntry>]
```
Stats contains total_findings, blockers, criticals, majors, minors, nits_shown, nits_suppressed, praises, thoughts, notes, actionable, suppressed. Presentation totals exclude suppressed findings; persistence additionally records all retained findings by label. Verdict uses [convergence](SKILL.md#convergence-and-continuation), independently of action and posting.

InlineComment is `{finding_id, axis, dimension, path, line, start_line: integer|null, side: RIGHT, body}`. `line` is the range's ending line; `start_line` exists only for a multi-line span. Body includes Conventional Comments identity. Strip internal identity fields only when mapping to POST_REQUEST; keep identity in the rendered body.

FilterEntry is `{finding_id, axis, dimension, reason, details}`; reasons: exact_duplicate, false_positive, below_threshold, suppressed, minor_budget, nit_budget, previously_reported, review_fix_polish, outside_delta. DedupEntry records `{finding_id, axis, dimension, into, reason}` or an evidence-backed confidence override with confidence_from, confidence_to, evidence. EditEntry records operation, finding_id, axis, dimension, and before/after Finding values as applicable. Keep the full removed/filtered originals in source_findings or edit_history.

## REVIEW_ACTION — R4

```yaml
REVIEW_ACTION:
  decision: "post | edit | local_only | rerun | auto_post"
  decision_reason: "<non-empty>"
  rails_applied: ["<rail/cap names in precedence order>"]
  edits: [<EditEntry>]
  rerun_scope: ["<dimension name>"]
```

## POST_REQUEST and POST_RESULT — R5/Writer

POST_REQUEST is the API-ready JSON shape, not a dispatch envelope: `corvus_review_persist` op `write_candidate` produces candidate.json at R3 and each overflow/relocation revision; R4 freezes post-request.json only after authorization, under [state](state.md#freeze-at-r4). Closed fields and key order:

```yaml
POST_REQUEST:
  commit_id: "<validated lowercase 40-hex head SHA>"
  event: "APPROVE | REQUEST_CHANGES | COMMENT"
  body: <opaque non-empty string>
  comments:
    - {path: "<repository-relative path>", line: <positive safe integer>, side: RIGHT, start_line?: <positive safe integer less than line>, start_side?: RIGHT, body: <opaque non-empty string>}
```

Multi-line comments include paired `start_line` and `start_side` before body; omit both for single-line comments. No wrapper, schema_version, repository, changed_files, or internal identity keys enter the JSON file. Preserve axis/dimension/ID in rendered strings and the full local document.

The tool serializes in the listed key order as UTF-8 JSON, two-space indentation, LF line endings, no BOM, and one final LF (equivalent to `JSON.stringify(payload, null, 2) + "\n"`). Preserve decoded strings exactly and array order (Standards then Spec); escape strings as JSON data, never shell text. Map APPROVE→APPROVE, REQUEST_CHANGES→REQUEST_CHANGES, COMMENT_ONLY→COMMENT; commit_id is PR_CONTEXT.code_head, body is exact review_body, comments map exact inline_comments with only the API keys above.

<!-- Size invariant: decoded bodies and canonical serialization are checked at R3 measurement before R4 writes and R5 dispatch. Overflow returns to R3 for a concise summary, not a delivery veto. No config, approval, resume or empty comments disables tool limits; the Delivery Principle governs recovery. -->
Posting-size limits are owned by `corvus_review_payload` (`LIMITS`), reported with violations in its results alongside measurements in code points and UTF-8 bytes. Local source findings and overflow_log retain full text outside the posting budget. Use [R3 overflow](../corvus-review-r3/SKILL.md#size-overflow) before authorization, never writer-side trimming.

R5 sends only the closed POST_ARTIFACT descriptor below. The writer carries these field sets inline because it has no skill access:
| Object | Fields / mapping |
|--------|------------------|
| POST_ARTIFACT | artifact_path: `<PR_CONTEXT.review_root>/post-request.json`; expected_sha256: 64 lowercase hex digits (SHA-256 of exact persisted bytes); repository: {owner: validated owner, name: validated repository}; pr_number: positive safe integer; head_sha: PR_CONTEXT.code_head; event: APPROVE/REQUEST_CHANGES/COMMENT |
| POST_RESULT | Writer maps TransportResult via [step 7](../../agent/pr-comment-writer.md#7-map-remote-truth) into the closed shape below: posted → posted/posted; rejected → local_only/not_posted with HTTP status in reason when supplied; unknown → local_only/unknown. Transport fields never become extra POST_RESULT keys |

Derive artifact_path from PR_CONTEXT.review_root, never review text: `.corvus/reviews/pr<pr_number>/post-request.json` or `.corvus/tasks/<task>/reviews/pr<pr_number>/post-request.json`; task is one `[A-Za-z0-9._-]+` segment excluding dot/dot-dot. The digest stays in the descriptor, not its hashed file. Tool arguments map artifact_path→artifactPath and expected_sha256→expectedSha256; post additionally maps repository→repo, pr_number→prNumber, head_sha→headSha, event unchanged; freeze returns sha256. Permission globs do not normalize paths: reject traversal, extra segments, shell decoration, or inequality to the resolved-root path before tools.

| TransportResult (`corvus_review_post`) | Shape |
|--------------------------------------|-------|
| outcome; tool_api_calls | posted/rejected/unknown; non-negative integer counting the tool's head/POST/retry attempts |
| http_status?; review_url?; reason? | HTTP status integer; review URL string; diagnostic string (optional fields, never invented) |

```yaml
POST_RESULT:
  status: "posted | not_posted | local_only"
  review_url: <GitHub review URL or null>
  reason: <failure explanation or null>
  remote_state: "posted | not_posted | unknown"
  inline_comments_posted: <non-negative integer>
  comments_moved_to_body: <non-negative integer>
  unverifiable_anchors: [{path: <string>, line_start: <positive safe integer>, line_end: <safe integer >= line_start>}] # required only for reason anchors-unverifiable; otherwise omitted
  api_calls: <non-negative integer>
```
Posted requires remote_state posted, a usable review URL and null reason; local_only requires a reason, null URL and truthful not_posted/unknown state. Status not_posted requires remote_state not_posted, null URL, zero inline_comments_posted and reason anchors-unverifiable, verify: <diagnostic>, head-moved or not-exposed: <inventory>. Only anchors-unverifiable includes non-empty unverifiable_anchors matching submitted anchors exactly; other reasons omit them and select R4 repair or the host exception. api_calls sums each writer `corvus_review_pr` result's api_calls and post tool_api_calls; reads/hashes/validators are not API calls. Count newly posted inline comments only; marker reuse reports 0 for this invocation. The writer's comments_moved_to_body is 0; R5 tracks relocation via [Conventional Comments](SKILL.md#conventional-comments). Done when identity, evidence, coverage and authorization remain separate.

---
name: corvus-review-r3
description: PR Review Phase R3 - Comment synthesis, deduplication, filtering, and review document generation
---

# Phase R3: Axis-Local Synthesis

Consume PR_CONTEXT, REVIEW_CONTEXT, and REVIEW_FINDINGS directly in the orchestrator. [Schemas](../corvus-review-extras/schemas.md) owns all shapes; [extras](../corvus-review-extras/SKILL.md) owns reviewability and action precedence. R3 is the sole configuration-driven finding filter.

## Validate and Partition

<!-- Synthesis invariant: validated axis_results, four projected statuses, evidence provenance, and config are read before filtering or checkpoint writes. Invalid input fails local-only; successful axis findings remain visible despite sibling errors. Verified skips disable contributions, not status validation; presentation budgets never change coverage. -->
Validate both `axis_results.standards` and `.spec`, each with architecture/correctness/conventions/security Result records, and the exact four-key `pass_results` projection against the shared projection rules. Check every status, non-empty reason/summary, empty skipped/error findings, tag/path consistency, and collision-free IDs. Retain the complete source_findings and review_context in REVIEW_DOCUMENT. Done when input is consistent or a synthesis failure has ended the posting path.

Read findings only from completed `axis_results` entries, including successes whose projected dimension is error because another contribution failed. `pass_results.findings` are compatibility copies, not additional findings or an eligibility filter. Reconcile R2 totals by label against raw axis entries once. Preserve contribution summaries, including valid partial evidence in error summaries as local-only evidence, outside successful findings. Done when every producer field is accounted for.

On edit loops, replay the validated edit-history overlay per [Edit Within Axis Groups](../corvus-review-extras/interactive.md#edit-within-axis-groups) before filtering; done when its identities and source coverage are preserved.

<!-- adapted from mattpocock/skills (MIT) -->
Process Standards and Spec independently through every step below. Keep their identities, totals, assessments, and key concerns separate; select/order findings only within their own axis. Related or conflicting cross-axis findings remain separate. A neutral shared introduction and arithmetic totals are allowed; a global ranking or competition for presentation budgets is not.

## Deduplicate Exact Copies

Within one axis, treat findings as exact duplicates only when all Finding fields except id are identical, including dimension/pass, evidence/body, location, severity, confidence, suggestion, related_to, and suppression. Keep the first in source order unchanged and log the removed ID and retained ID in dedup_log and filtered_log with axis/dimension. Similar concern, nearby lines, shared root cause, differing dimensions, or conflicting recommendations are not exact copies. Preserve them and any related_to references; resolve references to removed IDs through the audit log. Done when only exact same-axis copies have been removed.

Confidence overrides require the orchestrator's first-hand API/read evidence resolving the stated uncertainty; log finding identity, old/new confidence, evidence, and reason. Agreement between children is not evidence. For prior-review repeats, drop only same-axis/same-dimension, same-location/same-concern findings with explicit resolved disposition evidence, logging previously_reported. Unresolved repeats remain. Done when every override/drop is auditable and evidence-bounded.

## Filter Each Axis

For every dropped or suppressed finding, record finding_id, axis, dimension, reason, and details in filtered_log. Preserve originals in source_findings; edits have their own before/after history.

1. **Evidence ceiling**: apply [R2's evidence calibration](../corvus-review-r2/SKILL.md#detection-and-report-contract), retaining pending questions for series knowledge. Done when assumptions are distinguished from verified facts.
2. **Scope and origin**: enforce [R2 delta scope](../corvus-review-r2/SKILL.md#detection-and-report-contract), logging outside_delta; verify origin from gatherer evidence, with missing/mismatched provenance a synthesis failure, and keep the `origin` field on every retained finding through dedup, filtering, edits, and rendering. On `review-fix` code report only blocker/critical/major; silently drop minor/nitpick and informational findings as review_fix_polish, counting them only in the local document. Done when provenance and scope, not a claimed fix intent, govern retention.
3. **Confidence**: keep confidence ≥0.7; [0.5,0.7) only at major+; [0.3,0.5) only at critical+; below 0.3 drops. Exceptions: praise/thought/note bypass confidence; security dimension keeps ≥0.4 regardless of severity; a concrete remedy in suggestion/body keeps ≥0.5. Log false_positive drops. Done when every finding meets a stated rule or is logged.
4. **Severity**: apply severity_threshold by numeric label (blocker 5 through nitpick 1); praise/thought/note bypass it. Overrides affect action only. Log below_threshold. Done when retained findings meet the threshold or its informational exception.
5. **Suppression**: match configured ID prefixes plus paths, message regex against title/body, and path_rules.suppress_below. Set suppressed true, retain the finding for audit, exclude it from presentation/action totals and inline comments, and log suppressed. Done when every match is recorded without changing coverage.

## Budgets and Ordering Within Each Axis
<!-- Budget invariant: retained unsuppressed candidates, validated config totals and current delta/round evidence are read after filtering and before rendering. Missing controls fail local-only; overflow stays local. Allocation never exceeds either total, including zero, and never compares findings across axes. Config changes totals; no restoration, mode or edit disables the caps. -->
Build separate exact-label minor and nitpick lists for each axis using [config totals](../corvus-review-extras/config.md#defaults-and-validation). Delta rounds ≥2 use a zero nit cap; those nits are recorded in the local document only. For each label, let N be both lists' combined size and L=min(effective cap,N); N=0 gives both zero. Allocate floor(L×axis_count/N) to each axis, then any remaining slot by largest fractional remainder (tie: Standards). This allocates by share, never by cross-axis finding rank.
Sort each list by confidence descending, normalized path ascending (backslashes→slashes, remove leading ./), line_start ascending, then id ascending; missing locations sort last. Retain up to its allocation and mark overflow suppressed with minor_budget/nit_budget logs. There is no dimension-protection restoration; the sum stays within the total. Done when allocations and local-only suppression counts reconcile.

Order unsuppressed findings within each axis by severity descending, changed_files order, line_start, then id. Place praise at its file location, notes at that file's end, and thoughts after its actionable findings. Keep Standards then Spec as fixed presentation groups, not a severity comparison between groups. Done when every retained finding has a stable axis-local position.

## Derive Coverage and Action

Derive reviewability/coverage_warning solely from the four `pass_results.status` values and reasons using [extras](../corvus-review-extras/SKILL.md#reviewability). Use contribution summaries to explain missing spec, errors, and reduced coverage even when a projected slot completes. Apply [Fail-Closed Precedence](../corvus-review-extras/SKILL.md#fail-closed-precedence), including default action, draft/merged/self-review caps, override bounds, and confidence floor. Set action_reasoning to the determining layer and retain state_notices. Done when action is constrained without treating it as posting permission.

Compute summary.by_axis stats, assessments, and key_concern independently using [shared counts and convergence](../corvus-review-extras/SKILL.md#convergence-and-continuation); derive verdict separately from action. Arithmetic aggregate stats sum axis findings once; exclude suppressed findings from presentation/actionable totals and report their counts locally. Empty/praise-only output still obeys every coverage/state/default-action cap. Done when totals reconcile without projection double-counting or an overall winning concern.

## Render and Persist

Emit this exact first-line marker, replacing head_sha with R0's validated lowercase 40-hex head. R0 parses it; edits and posting preserve it:
```markdown
<!-- corvus-review v1 head:<head_sha> -->
```

Apply the shared converged opening and summary policy; otherwise render review_body with PR title/identity, action/reviewability, exact coverage_warning and state_notices before the assessment, then separate `Standards` and `Spec` sections. Each axis shows assessment, key concern, counts by label, actionable count, nitpicks shown/suppressed, and body-only findings using the shared Conventional Comments format. Delta nit counts and review_fix_polish counts stay local, not in posted prose. Show dimension status/reason/summary and axis contribution limitations without globally reranking concerns. For error summaries, publish coverage limitations only; their partial findings stay in local source evidence, outside postable body/inline findings.

Preserve config fallback_warning prominently, CI pending/failure notes, missing-description information, eligible suppression counts, and prior-review disposition context. With prior review but delta unavailable/absent, state that a full review was performed because delta-focus was unavailable; with verified delta, identify the prior head and outstanding prior blockers/criticals. Treat triage notes as body information rather than fabricating code locations. Required notices incompatible with a converged one-line summary keep it local-only, never omit a warning to post. Done when all control notices and branch-specific evidence survive rendering.

For a converged summary, apply the shared rendering policy before assembling the document; otherwise generate inline comments only for paths in file_map and spans wholly within API-derived RIGHT-side postable_line_ranges in one hunk. R3 may relocate/shrink to an in-range line representing the defect; otherwise render body-only. Preserve suggestion/range consistency. Set line to the ending line and start_line only for a multi-line span; side is RIGHT. Each inline record retains finding_id, axis, dimension, and the identity-bearing body. Done when every anchor is verified, not estimated.
When R1's gatherer reports an oversized/truncated diff or R0's additions+deletions exceeds 20,000, prefer body placement for comments whose file patches are unavailable in `review-input.json`'s file_map evidence gaps; R4 needs no new payload-tool preflight.

Give each axis an independent cap of three inline praise findings, selecting by significance then confidence and deterministic local order; unanchored/remaining praise stays in that axis's body and consumes no inline allowance. The combined inline count still meets R4's hard posting-volume rail or becomes local-only; that rail does not select one axis over another. Done when every visible finding is inline or body-only with its axis intact.

Assemble the shared REVIEW_DOCUMENT, including synthesis_controls, complete source_findings, review_context, findings, inline_comments, logs, edit_history, review_body, overflow false, overflow_log [], and summary. Validate schema, source projection, totals, exact marker/notices, and every inline identity/anchor. Failure reports local evidence and terminates local-only, with no judgment rerun in auto mode. Done when the document is valid or posting is closed.

Persist the full REVIEW_DOCUMENT checkpoint via [Persist at R3](../corvus-review-extras/state.md#persist-at-r3) BEFORE measurement; that procedure owns knowledge persistence and failure recovery. Its write bounds are guidance under the shared [Operating Rules](../corvus-review-extras/SKILL.md#operating-rules): a successful oversized write is logged and synthesis continues to measurement. A converged local-only outcome goes directly to R4 without measurement. Done when the complete checkpoint is available before any payload-tool call.

### Measure Candidate

Use the orchestrator write tool to write `.corvus/reviews/<owner>__<repo>__pr<pr_number>/candidate.json` from the [POST_REQUEST mapping](../corvus-review-extras/schemas.md#post_request-and-post_result--r5writer). This candidate is the ONLY place the model serializes the payload, once per presentation revision; freezing never retypes it. Call `corvus_review_payload` with `{op: "measure", candidatePath: ".corvus/reviews/<owner>__<repo>__pr<pr_number>/candidate.json"}`. Read `ok`, measurements (codePoints/utf8Bytes for body, indexed comments, total), violations, and sha256; results contain no body text. Retain the successful measurement's sha256 for R4 comparison. An unchanged recovered document takes this same step. Done when the persisted candidate is measured or [Posting Validation Failures](../corvus-review-extras/state.md#posting-validation-failures) ends local-only with evidence and recovery instructions.

### Size Overflow

Use the tool's measurements and violations, never manual character/byte counting. An `ok:true` measurement with no violations proceeds to R4; preserve any existing overflow audit on resume. For budget violations, apply these deterministic steps; each presentation revision sets overflow true and records its audit before persisting the updated complete checkpoint and candidate, then calling measure:

1. Collapse per-finding detail to one line each (identity, axis/dimension, severity, title, location, concise remedy) plus a link labeled local full text to the validated persisted `review_document_path` ending in `REVIEW_DOCUMENT.md`. Keep original text in findings/source_findings and overflow_log, including full inline bodies/suggestions. Preserve the first-line marker, coverage/state/config notices, axis assessments/counts, and inline anchors/count/order. Done when each detailed finding has a compact representation without losing its local text.
2. If still over budget, reserve space for the fixed envelope/notices, split remaining body and serialized capacity equally between Standards and Spec, and keep unused shares unused. Within each axis, demote lowest-severity body-only findings first (ties in reverse existing axis-local presentation order) to `N further notes in the local review document` plus its local path link, until that axis fits. Log every counted ID; keep evidence, action, totals, and coverage unchanged. Never compare axes or cull inline comments to satisfy the posting-volume rail. Done when both axis shares and all tool ceilings fit, or eligible demotions are exhausted.
3. Never drop blockers/critical findings: keep at least their one-line identity/severity/location/remedy visible, even if body-only notes are counted. Set `overflow: true` and record what was collapsed/counted by finding_id and axis in REVIEW_DOCUMENT. If protected findings/notices or an inline body still cannot fit, measurements are unavailable, or full-text persistence fails, terminate local-only via Posting Validation Failures with exact tool diagnostics rather than truncating or dispatching the writer. Done when overflow is auditable and either fits safely or closes posting.

Validate any revised document with the same schema, projection, totals, marker/notices, and inline checks before persistence. Done when the final checkpoint matches the successfully measured candidate. Emit `[R3 COMPLETE]` with coverage/action, separate Standards/Spec totals and concerns, inline count, and per-axis filter counts; then enter R4.

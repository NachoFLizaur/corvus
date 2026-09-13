---
name: corvus-review-r5
description: PR Review Phase R5 - Post review to GitHub and display completion summary
---

# Phase R5: Completion

Consume PR_CONTEXT, REVIEW_DOCUMENT, REVIEW_ACTION, and R4's POST_ARTIFACT for an authorized post. [Schemas](../corvus-review-extras/schemas.md) owns artifact/POST_RESULT shapes; [extras](../corvus-review-extras/SKILL.md#fail-closed-precedence) owns rails; [review state](../corvus-review-extras/state.md) owns checkpoint updates and lock cleanup. Only pr-comment-writer performs the approved atomic mutation.

## Route Before Preparing a Post

For PR_CONTEXT.mode local, force local_only regardless of any restored decision: dispatch no writer and perform no PR ops, payload preparation or POST. Print the review summary with both axes and `review_document_path` to chat, then use Complete Locally or Remotely for metadata and owned-lock release, with remote_state not_posted. Done when LOCAL completion preserves the document and reports that nothing was posted.
Read decision first. local_only displays the complete available review and reason, then goes directly to Complete Locally or Remotely. edit/rerun or any unknown decision reaching R5 is invalid and becomes local_only. Only post/auto_post can reach final revalidation. Done when a no-post branch has prepared neither event nor payload nor writer dispatch.
R0's already-posted resume goes directly to Complete Locally or Remotely with confirmed posted state and URL retained, without writer dispatch or changing posted to false.

<!-- No-post branches carry no publishing authority, including when an informational action is present. -->
You MUST NOT invoke the writer, run a GitHub review mutation, or offer an alternate posting command for a local-only decision or failed revalidation.

## Revalidate Immediately Before Dispatch

<!-- Dispatch invariant: current trusted PR/config controls, final approval/mode, complete axis/projection evidence, rendered document, and inline count are read before writer dispatch. Any mismatch fails local-only; previous local-only is terminal. No override, edited finding, or empty result disables the checks. -->
1. Require post in interactive mode with explicit authorization after the final preview, or auto_post in autonomous mode; decision_reason and rails_applied are present, with no pending edit/rerun. Done when authorization refers to this exact final document.
2. Validate repository/number, base/head SHA, provenance, self_review, synthesis_controls, document schema, and both source_findings.axis_results maps plus the four pass_results. Validate all status/reason/summary fields and projection consistency; use R4's unchanged tool counts. Done when coverage and findings remain distinct controls.
3. Apply canonical precedence and [Convergence and Continuation](../corvus-review-extras/SKILL.md#convergence-and-continuation); confirm verdict, existing action, reasoning, exact coverage_warning/state_notices, marker, and inline volume agree. Any incompatible state becomes local_only; report rather than silently remapping an event here. Partial-review gaps retain their coverage caps and notices in either mode. Done when every applicable rail is recorded.
4. Call `corvus_review_pr` op `metadata` with `{owner, name, pr}` before dispatch; require ok:true and unchanged code_head/base, state, draft and mergeability controls; retain the observed head_sha separately. Drift or another cap mismatch becomes local-only. Skip a known deterministic rejection only with unchanged evidenced preconditions. Done when no stale or known-invalid authorization reaches the writer.

## Dispatch One Artifact

After revalidation, require the current [POST_ARTIFACT](../corvus-review-extras/schemas.md#post_request-and-post_result--r5writer) from R4 or Anchor Relocation below to match current identity/head and the approved event, with authorization referring to that exact presentation revision. Call `corvus_review_verify` with `{op: "verify", artifactPath: <artifact_path>, expectedSha256: <expected_sha256>}` before dispatch, including each permitted re-dispatch; keep that descriptor's expected_sha256 unchanged. Require `ok:true`, sha256Match true, canonical true, no violations, and available measurements. Missing artifact, digest mismatch, changed authorization, or incomplete evidence ends local-only via [Posting Validation Failures](../corvus-review-extras/state.md#posting-validation-failures). Done when authorization binds these persisted bytes.

Call `corvus_review_pr` op `reviews` before dispatch to retain the complete baseline review IDs; use acquire.started_at as the observed run-window lower bound. Retain artifact bytes and descriptor unchanged during transport recovery; only Anchor Relocation creates a new presentation revision.

Dispatch literal `pr-comment-writer` with only this JSON object, substituting validated descriptor values:
```json
{
  "artifact_path": "<PR_CONTEXT.review_root>/post-request.json",
  "expected_sha256": "<current artifact SHA-256>",
  "repository": {"owner": "<owner>", "name": "<repo>"},
  "pr_number": <pr_number>,
  "head_sha": "<code_head>",
  "event": "<approved event>"
}
```
Include no review body text, comments, findings, TASK block, or extra controls in the dispatch. The writer reads the artifact, validates its current head/anchors and semantic controls, calls `corvus_review_verify` then `corvus_review_post`, and maps TransportResult into POST_RESULT without retyping content. Done when one authorized artifact descriptor has been dispatched.

## Reconcile Writer Transport
<!-- Recovery invariant: the writer result or complete read-only listing is inspected after each dispatch and before any repeat. Unknown/ambiguous remote state fails local-only; only a transport-invalid return plus verified absence allows bounded identical re-dispatch. A valid writer local_only disables re-dispatch, not read-only reconciliation of uncertainty. -->
Classify the return:

| Result | Handling |
|--------|----------|
| Valid POST_RESULT posted | Require remote_state posted and usable review_url; complete without another dispatch |
| Valid POST_RESULT not_posted, reason anchors-unverifiable | Follow Anchor Relocation, not transport recovery |
| Valid POST_RESULT local_only, remote_state not_posted | Terminal as reported, including tool rejection; display full review and reason |
| Valid POST_RESULT local_only, remote_state unknown | Terminal-uncertain; use the listing below to reconcile, never re-dispatch even on verified absence |
| Empty/malformed/truncated/schema-invalid result | Child-transport failure; verify remote state using the listing below before considering recovery |

Prefer `corvus_review_pr` op `reviews` with `{owner, name, pr}`; require ok:true, complete_pagination:true, exact body_marker, commit_id equal to code_head, usable html_url and valid submitted_at at/after acquire.started_at, with the review ID absent from the complete pre-dispatch baseline. Missing baseline/time or incomplete results leave remote_state unknown. Granted read-only GitHub bash may supplement diagnostics, not replace the required tool evidence or authorize posting.
- Exactly one matching review with usable URL: recover posted and the URL; the report was lost.
- Complete evidence proving no matching review: only for a transport-invalid return, re-dispatch the same writer with the identical POST_ARTIFACT descriptor and unchanged artifact bytes at most once interactively or twice autonomously. A valid local_only/unknown remains terminal-uncertain. Repeat verification after every transport-invalid return.
- Failed/incomplete listing, multiple matches, missing usable URL, or other ambiguity: terminate local_only with remote_state unknown and no re-dispatch.
- Verified absence with retry bound exhausted: terminate local_only with remote_state not_posted.

Absence verification is a prerequisite, not an idempotency guarantee against later concurrent activity. Keep unknown outcomes terminal and report uncertainty honestly. Done when posted/not_posted/unknown is established to the available evidence and the bounded route has settled.

<!-- Alternate mutations can duplicate an accepted review or bypass its authorized event. -->
You MUST NOT overcome writer-local-only or uncertain outcomes with another agent, endpoint/event, direct posting command, interactive fallback, or body-first/comments-later sequence. A failed writer path hands off the complete local document and reason, not an alternate publishing route.

## Anchor Relocation
<!-- Relocation invariant: a schema-valid anchors-unverifiable result with remote_state not_posted and exact candidate-anchor matches is read before any revision. Invalid matches or uncertain remote state fail local-only; only the first such result permits placement changes. Exhaustion, denied interactive consent or failed authorization/integrity checks disables recovery; no mode bypasses those checks. -->
On `anchors-unverifiable`, match each unique `{path,line_start,line_end}` in `unverifiable_anchors` to the frozen artifact and REVIEW_DOCUMENT (start_line or line through line); reject unknown positions. Relocate ONLY those matching inline comments into their own axis's review body using the existing [identity-preserving Conventional Comments format](../corvus-review-extras/SKILL.md#conventional-comments), adding the original path/range while preserving each entire comment body, identity and suggestion unchanged. Keep all other inline comments, their order, findings, action, marker, notices and counts unchanged; increment R5's cumulative `comments_moved_to_body` by the number moved, not the number of unique anchors, and retain it independently of the writer's zero count.
This is a new presentation revision, not a transport retry: autonomous mode needs no new authorization because content is unchanged, only placement; interactive mode shows the relocation in one question and proceeds only on explicit consent (missing question follows the state procedure). Invalidate the old descriptor, persist the revised complete checkpoint and candidate through R3 and `corvus_review_persist` op `write_candidate`, then re-run `corvus_review_payload` measure → freeze via [Freeze at R4](../corvus-review-extras/state.md#freeze-at-r4) → `corvus_review_verify` with the new digest, revalidate authorization/current PR controls, and re-dispatch the writer ONCE. The writer never edits either artifact; only the payload tool replaces frozen bytes. If the second attempt also fails to post for a non-transport reason, end local_only with its diagnostic; transport-invalid returns use Reconcile Writer Transport without resetting the relocation bound.

## Complete Locally or Remotely
Use [state completion](../corvus-review-extras/state.md#complete-at-r5) for every outcome. Retain existing metadata through `corvus_review_persist`: the verdict tool persists `verdict.yaml`; `write_meta` records `code_head`, observed `head_sha`, `verdict_file: verdict.yaml` and decision/completion fields — never copy counts. Never store state_commit in meta. For confirmed posted, a metadata-write failure reports the remote URL without repeating the post. For local-only/not-posted/unknown, retain posted false and disclose the exact uncertainty. Keep the full axis-preserving checkpoint path available for inspection.
<!-- Sync completion invariant: resolved root/remote, validated code_head and the final metadata/lock outcomes are read before push. A failed sync preserves the review locally and proceeds with a C-class note, never another POST. Only state_sync:false disables synchronization; no outcome or invocation mode bypasses reporting. -->
After `write_meta` and owned-lock release, call `corvus_review_sync` with `{op: "push", cwd, root: review_root, head_sha: code_head, pr: <SyncPr>, branch: <headRefName or current LOCAL branch>, remote}` on EVERY outcome: posted, local-only, not-posted, unknown and LOCAL. `state_sync: false` skips push with a note; an unavailable resolved root/branch reports the reason without guessing. LOCAL pushes only with an upstream; let the tool return its no-upstream note. Report `synced` plus returned `state_commit` or the reason in every terminal summary, including metadata failures; sync failures are C-class, never a stop.

Show the tool's round, counts and converged; missing_history stays unknown, never inferred zero. Use persisted tool counts for separate Standards/Spec trends and first-zero-major state only where available. Retain findings and summary.by_axis from the final document, not pass_results.findings, including successful axis evidence behind error projections. List all four projected statuses/reasons and both axes' contribution summaries/limitations, including skipped/no-spec and reduced coverage. Done when the summary uses tool evidence without a global concern ranking.

Call `corvus_review_lock` op `release` for this run via the state procedure on every terminal branch before the sync above, then display:
- Posted: review URL, constrained action, coverage/notices, separate axis totals/key concerns, actual inline/moved counts, filters, and series evidence.
- Local-only: full review plus inline comments grouped by axis, reason/rails, remote_state and checkpoint path; explicitly state posting was not performed or may have occurred when unknown.
- Autonomous: concise summary with both axes visible, caps/notices, URL or local-only reason, and series evidence; no request for input.

Mark todos with their actual completed/resumed/skipped/failed outcomes. Done when remote truth, local persistence, coverage, and cleanup are disclosed. R5 is terminal; follow-up work starts again at R0.

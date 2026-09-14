---
name: corvus-review-r5
description: PR Review Phase R5 - Post review to GitHub and display completion summary
---

# Phase R5: Completion

Consume PR_CONTEXT, REVIEW_DOCUMENT, REVIEW_ACTION, and R4's POST_ARTIFACT for an authorized post. [Schemas](../corvus-review-extras/schemas.md) owns artifact/POST_RESULT shapes; [extras](../corvus-review-extras/SKILL.md#fail-closed-precedence) owns rails; [review state](../corvus-review-extras/state.md) owns checkpoint updates and lock cleanup. Only pr-comment-writer performs the approved atomic mutation.
Follow the [Delivery Principle](../corvus-review-extras/SKILL.md#delivery-principle) for all recovery and terminal decisions. Metadata, sync and verdict failures add Review limits and never suppress delivery.

## Route Before Preparing a Post

Carry `checkpoint_failed` into Review limits and continue from R4's in-memory candidate; do not require a persisted document or verdict to attempt delivery.
For PR_CONTEXT.mode local, force local_only regardless of any restored decision: dispatch no writer and perform no PR ops, payload preparation or POST. Print the review summary with both axes and `review_document_path` to chat, then use Complete Locally or Remotely for metadata and owned-lock release, with remote_state not_posted. Done when LOCAL completion preserves the document and reports that nothing was posted.
Read decision first. Apply only Delivery Principle non-post reasons in autonomous mode; repair stale or malformed decisions through R4. Interactive edit/rerun returns to its owning phase; only current post/auto_post reaches final revalidation.
R0's already-posted resume goes directly to Complete Locally or Remotely with confirmed posted state and URL retained, without writer dispatch or changing posted to false.

<!-- No-post branches carry no publishing authority, including when an informational action is present. -->
You MUST NOT bypass the approved writer route or fabricate successful verification. Repair stale authorization through R4 under the Delivery Principle.

## Revalidate Immediately Before Dispatch

<!-- Dispatch invariant: trusted locator/mode, available synthesis and live metadata are read before writer dispatch. CLOSED/MERGED disables posting; code/base drift renews synthesis and authorization, unavailable metadata is disclosed. Invalid artifacts are repaired, never accepted; no override bypasses writer validation. -->
1. Require post in interactive mode with explicit authorization after the final preview, or auto_post in autonomous mode; decision_reason and rails_applied are present, with no pending edit/rerun. Done when authorization refers to this exact final document.
2. Validate repository/number, base/head SHA, provenance, self_review, synthesis_controls, document schema, and available source_findings.axis_results maps plus the four pass_results. Repair presentation from known evidence and retain missing coverage/counts as disclosed unknowns; use R4's tool counts when available, otherwise its labelled synthesis counts. Done when findings, coverage and unavailable tool evidence remain distinct.
3. Apply canonical precedence and [Convergence and Continuation](../corvus-review-extras/SKILL.md#convergence-and-continuation); preserve notices and Review limits. Repair incompatible presentation through R4; unknown verdict stays unknown and informational, not a delivery veto.
4. Call `corvus_review_pr` op `metadata` with `{owner, name, pr}` before dispatch; compare ONLY code_head, base_sha, and state for posting-authorization revalidation (base_sha is metadata.baseRefOid). CLOSED/MERGED selects the Delivery Principle exception; code/base changes renew R0–R4 against current evidence, not terminal silence. On metadata failure, retry with progress then disclose and still dispatch using the last validated identity. Retain observed head_sha separately. Mergeability (mergeable/mergeStateStatus) never invalidates posting; record its changes and CI/check changes only as notes in the terminal summary, never as posting controls.

## Dispatch One Artifact

After revalidation, require the current [POST_ARTIFACT](../corvus-review-extras/schemas.md#post_request-and-post_result--r5writer) from R4 or Anchor Relocation below to match current identity/head and the approved event, with authorization referring to that exact presentation revision. Call `corvus_review_verify` with `{op: "verify", artifactPath: <artifact_path>, expectedSha256: <expected_sha256>}` before dispatch, including each permitted re-dispatch; keep that descriptor's expected_sha256 unchanged. Require `ok:true`, sha256Match true, canonical true, no violations, and available measurements. Repair missing/invalid artifacts through R4; incomplete analysis evidence stays in Review limits. If the writer is absent from host inventory, record `writer_capability_not_exposed`. Done when authorization binds the candidate bytes or the observed host exception applies.

Call `corvus_review_pr` op `reviews` before dispatch to retain available baseline review IDs; missing history is disclosed, not a delivery gate. Retain artifact bytes and descriptor unchanged during transport recovery; Anchor Relocation or R4's explicit verification recovery owns replacement.

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
<!-- Recovery invariant: writer output and remote listings are read after dispatch before repetition. A confirmed URL ends posting; uncertain outcomes stay unknown while reconciliation makes progress. Verified absence permits the same writer route; no recovery bypasses artifact verification or changes the approved event. -->
Classify the return:

| Result | Handling |
|--------|----------|
| Valid POST_RESULT posted | Require remote_state posted and usable review_url; complete without another dispatch |
| Valid POST_RESULT not_posted, reason anchors-unverifiable | Follow Anchor Relocation, not transport recovery |
| Valid POST_RESULT not_posted, reason verify: <diagnostic> | Return to R4 Verification Recovery; a failed verification after its re-freeze attempt selects the fifth exception |
| Valid POST_RESULT not_posted, reason not-exposed: <inventory> | Report the observed host-capability exception, including which writer tool is missing |
| Valid POST_RESULT not_posted, reason head-moved | Renew R0–R4 for the current code head and continue delivery |
| Valid POST_RESULT local_only, remote_state not_posted | A confirmed GitHub POST rejection is the delivery exception; otherwise repair the reported prerequisite and retry with progress |
| Valid POST_RESULT local_only, remote_state unknown | Reconcile through read-only listings; disclose uncertainty rather than claiming rejection or absence |
| Empty/malformed/truncated/schema-invalid result | Child-transport failure; verify remote state using the listing below before considering recovery |

Call `corvus_review_pr` op `reviews` with `{owner, name, pr}`; match exact body_marker, commit_id equal to code_head, the approved event's API state and a usable html_url. A matching submitted review is delivery evidence even if it predates this run: marker lookup deliberately reuses prior delivery. Baseline/time gaps are notes, not disqualifiers. Require ok:true and complete_pagination:true to prove absence; partial listings can establish a matching review but not absence. Granted read-only GitHub bash supplements diagnostics, not tool evidence.
- Matching review with usable URL: recover posted and the URL; if several match, select newest submitted_at then id and disclose duplicates without another POST.
- Complete evidence proving no matching review after unknown/malformed transport: make ONE more writer dispatch with the identical descriptor and fresh verification. Track `transport_repost_attempted` for the run and preserve it across re-dispatches; the writer checks pr.reviews for the marker before POST to avoid repeating visible delivery. Reconcile again after that dispatch, without another ambiguous-transport POST.
- Failed/incomplete listing or missing URL: retry while progress is made; disclose the exact result and retain unknown remote truth. If reconciliation stalls after the authorized extra dispatch, report delivery unconfirmed with a recoverable checkpoint, never fabricate a URL or a GitHub rejection. This is unresolved delivery, not a new non-post exception.

Absence verification is not an idempotency guarantee against concurrent activity. Done when remote truth is established to available evidence under the Delivery Principle.

<!-- Alternate mutations can duplicate an accepted review or bypass its authorized event. -->
You MUST NOT use another agent, endpoint/event, direct posting command, interactive fallback, or body-first/comments-later sequence. Recovery stays with the same writer under the Delivery Principle.

## Anchor Relocation
<!-- Relocation invariant: not_posted anchor diagnostics and exact candidate matches are read before revision. Invalid child positions are corrected while progress is made; uncertain remote state uses reconciliation before replacement. Only matched comments move, preserving their full bodies. No mode bypasses authorization or artifact verification; relocation has no fixed attempt cap. -->
On `anchors-unverifiable`, match each unique `{path,line_start,line_end}` in `unverifiable_anchors` to the frozen artifact and REVIEW_DOCUMENT (start_line or line through line); reject unknown positions. Relocate ONLY those matching inline comments into their own axis's review body using the existing [identity-preserving Conventional Comments format](../corvus-review-extras/SKILL.md#conventional-comments), adding the original path/range while preserving each entire comment body, identity and suggestion unchanged. Keep all other inline comments, their order, findings, action, marker, notices and counts unchanged; increment R5's cumulative `comments_moved_to_body` by the number moved, not the number of unique anchors, and retain it independently of the writer's zero count.
This is a new presentation revision, not a transport retry: autonomous mode needs no new authorization because content is unchanged, only placement; interactive mode shows the relocation in a question and proceeds only on explicit consent (missing question follows the state procedure). Invalidate the old descriptor, attempt to persist the revised complete checkpoint and candidate through R3 and `corvus_review_persist` op `write_candidate`, then re-run `corvus_review_payload` measure → freeze via [Freeze at R4](../corvus-review-extras/state.md#freeze-at-r4) → `corvus_review_verify` with the new digest, revalidate authorization/current PR controls, and re-dispatch the writer. Retry while progress is made; each matched relocation removes those inline anchors while preserving their body evidence. The writer never edits artifacts. Verification failures use R4 Verification Recovery; unknown transport uses reconciliation, preserving both run-owned recovery flags.

## Complete Locally or Remotely
For `checkpoint_failed`, retain stage, failed_op, index/key, part and reason in completion diagnostics without replacing confirmed remote truth. Attempt metadata → owned-lock release → sync.push even after failures; `.staging/` is never synced. Preserve older complete checkpoints and disclose that this run's elaborated report was not durably confirmed. Never repeat an accepted POST to repair metadata, verdict or sync.
Use [state completion](../corvus-review-extras/state.md#complete-at-r5) for every outcome. Retain existing metadata through `corvus_review_persist`: the verdict tool persists `verdict.yaml`; `write_meta` records `code_head`, observed `head_sha`, `verdict_file: verdict.yaml` and decision/completion fields — never copy counts. Never store state_commit in meta. For confirmed posted, a metadata-write failure reports the remote URL without repeating the post. For local-only/not-posted/unknown, retain posted false and disclose the exact uncertainty. Keep the full axis-preserving checkpoint path available for inspection.
<!-- Sync completion invariant: resolved root/remote, validated code_head and the final metadata/lock outcomes are read before push. A failed sync preserves the review locally and proceeds with a C-class note, never another POST. Only state_sync:false disables synchronization; no outcome or invocation mode bypasses reporting. -->
After `write_meta` and owned-lock release, call `corvus_review_sync` with `{op: "push", cwd, root: review_root, head_sha: code_head, pr: <SyncPr>, branch: <headRefName or current LOCAL branch>, remote}` on EVERY outcome: posted, local-only, not-posted, unknown and LOCAL. `state_sync: false` skips push with a note; an unavailable resolved root/branch reports the reason without guessing. LOCAL pushes only with an upstream; let the tool return its no-upstream note. Report `synced` plus returned `state_commit` or the reason in every terminal summary, including metadata failures; sync failures are C-class, never a stop.

Show the tool's round, counts and converged; missing_history stays unknown, never inferred zero. Use persisted tool counts for separate Standards/Spec trends and first-zero-major state only where available. Retain findings and summary.by_axis from the final document, not pass_results.findings, including successful axis evidence behind error projections. List all four projected statuses/reasons and both axes' contribution summaries/limitations, including skipped/no-spec and reduced coverage. Done when the summary uses tool evidence without a global concern ranking.

Call `corvus_review_lock` op `release` for this run via the state procedure on every terminal branch before the sync above, then display:
- Posted: review URL, constrained action, coverage/notices, separate axis totals/key concerns, actual inline/moved counts, filters, and series evidence.
- Local-only: full review plus inline comments grouped by axis, reason/rails, remote_state and checkpoint path; explicitly state posting was not performed or may have occurred when unknown.
- Autonomous: concise summary with both axes visible, caps/notices, URL or local-only reason, and series evidence; no request for input.

Mark todos with actual outcomes. Terminal summary always ends with the posted review URL or the applicable exact non-post reason from the Delivery Principle; never substitute a source gap, checkpoint failure or sync/verdict error. Report uncertainty truthfully if transport cannot establish either outcome. Done when remote truth, local persistence, coverage and cleanup are disclosed.

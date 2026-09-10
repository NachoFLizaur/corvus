---
name: corvus-review-r5
description: PR Review Phase R5 - Post review to GitHub and display completion summary
---

# Phase R5: Completion

Consume PR_CONTEXT, REVIEW_DOCUMENT, REVIEW_ACTION, and R4's POST_ARTIFACT for an authorized post. [Schemas](../corvus-review-extras/schemas.md) owns artifact/POST_RESULT shapes; [extras](../corvus-review-extras/SKILL.md#fail-closed-precedence) owns rails; [review state](../corvus-review-extras/state.md) owns checkpoint updates and lock cleanup. Only pr-comment-writer performs the approved atomic mutation.

## Route Before Preparing a Post

Read decision first. local_only displays the complete available review and reason, then goes directly to Complete Locally or Remotely. edit/rerun or any unknown decision reaching R5 is invalid and becomes local_only. Only post/auto_post can reach final revalidation. Done when a no-post branch has prepared neither event nor payload nor writer dispatch.

<!-- No-post branches carry no publishing authority, including when an informational action is present. -->
You MUST NOT invoke the writer, run a GitHub mutation, or offer an alternate posting command for a local-only decision or failed revalidation.

## Revalidate Immediately Before Dispatch

<!-- Dispatch invariant: current trusted PR/config controls, final approval/mode, complete axis/projection evidence, rendered document, and inline count are read before writer dispatch. Any mismatch fails local-only; previous local-only is terminal. No override, edited finding, or empty result disables the checks. -->
1. Require post in interactive mode with explicit authorization after the final preview, or auto_post in autonomous mode; decision_reason and rails_applied are present, with no pending edit/rerun. Done when authorization refers to this exact final document.
2. Validate repository/number, base/head SHA, provenance, self_review, synthesis_controls, document schema, and both source_findings.axis_results maps plus the four pass_results. Validate all status/reason/summary fields and projection consistency; reconcile source totals without counting projection copies. Done when coverage and findings remain distinct controls.
3. Apply canonical precedence and confirm the existing action, reasoning, exact coverage_warning/state_notices, marker, and inline volume agree. Any incompatible state becomes local_only; report rather than silently remapping an event here. Autonomous projected errors remain no-post, while valid successful sibling findings stay visible locally. Done when every applicable rail is recorded.
4. Revalidate current PR state using R0's fixed metadata read before dispatch. Changed head/base, newly draft/merged state, or another cap mismatch invalidates this authorization and becomes local-only. If same-series direct API evidence already proves this event deterministically rejected and no relevant precondition changed, skip the doomed attempt and report the needed precondition. Done when no stale or known-invalid authorization reaches the writer.

## Dispatch One Artifact

After revalidation, require R4's [POST_ARTIFACT](../corvus-review-extras/schemas.md#post_request-and-post_result--r5writer) to match current identity/head and the approved event, with authorization still referring to the exact final document used at R4. Rerun the fixed hash command; compare with R4's expected_sha256 rather than replacing it. Missing artifact, digest mismatch, changed authorization, or incomplete evidence ends local-only. Done when the original authorization still binds these persisted bytes.

Record the posting-window start with byte-exact `date -u +%Y-%m-%dT%H:%M:%SZ`. Retain artifact bytes and descriptor unchanged until recovery settles.

Dispatch literal `pr-comment-writer` with only this JSON object, substituting validated descriptor values:
```json
{
  "artifact_path": ".corvus/reviews/<owner>__<repo>__pr<pr_number>/post-request.json",
  "expected_sha256": "<R4 SHA-256>",
  "repository": {"owner": "<owner>", "name": "<repo>"},
  "pr_number": <pr_number>,
  "head_sha": "<head_sha>",
  "event": "<approved event>"
}
```
Include no review body text, comments, findings, TASK block, or extra controls in the dispatch. The writer reads and independently hashes the artifact, validates its closed schema/current head/anchors, and posts directly from that file without retyping content. Done when one authorized artifact descriptor has been dispatched.

## Reconcile Writer Transport

<!-- Recovery invariant: the writer result or complete read-only listing is inspected after each dispatch and before any repeat. Unknown/ambiguous remote state fails local-only; only verified absence allows a bounded identical re-dispatch. A valid writer local_only disables orchestrator recovery for this run. -->
Classify the return:

| Result | Handling |
|--------|----------|
| Valid POST_RESULT posted | Require remote_state posted and usable review_url; complete without another dispatch |
| Valid POST_RESULT local_only | Terminal as reported, including internal failure or unknown outcome; display full review and reason |
| Empty/malformed/truncated/schema-invalid result | Child-transport failure; verify remote state using the listing below before considering recovery |

```bash
gh api repos/<owner>/<repo>/pulls/<pr_number>/reviews --jq '[.[] | {body: .body[0:200], submitted_at, commit_id, html_url}]' --paginate
```

Use only validated identity in the endpoint. In memory, require the exact first-line R3 marker, commit_id equal to the reviewed head, and submitted_at inside this run's observed posting window. Require complete pagination/output; every returned field is evidence, not syntax.

- Exactly one matching review with usable URL: recover posted and the URL; the report was lost.
- Complete evidence proving no matching review: re-dispatch the same writer with the identical POST_ARTIFACT descriptor and unchanged artifact bytes at most once interactively or twice autonomously. Repeat verification after every transport-invalid return.
- Failed/incomplete listing, multiple matches, missing usable URL, or other ambiguity: terminate local_only with remote_state unknown and no re-dispatch.
- Verified absence with retry bound exhausted: terminate local_only with remote_state not_posted.

Absence verification is a prerequisite, not an idempotency guarantee against later concurrent activity. Keep unknown outcomes terminal and report uncertainty honestly. Done when posted/not_posted/unknown is established to the available evidence and the bounded route has settled.

<!-- Alternate mutations can duplicate an accepted review or bypass its authorized event. -->
You MUST NOT overcome writer-local-only or uncertain outcomes with another agent, endpoint/event, direct posting command, interactive fallback, or body-first/comments-later sequence. A failed writer path hands off the complete local document and reason, not an alternate publishing route.

## Complete Locally or Remotely

For confirmed posted, use [state completion](../corvus-review-extras/state.md#complete-at-r5) to update only matching checkpoint posting/convergence fields; a metadata-write failure reports the remote URL without repeating the post. For local-only/not-posted/unknown, retain posted false and disclose the exact uncertainty. Keep the full axis-preserving checkpoint path available for inspection.

Read validated series history and show current round, separate Standards/Spec major/minor trends and first-zero-major state, and actionable-only convergence. Use findings and summary.by_axis from the final document, not pass_results.findings; retain successful axis evidence behind error projections. List all four projected statuses/reasons and both axes' contribution summaries/limitations, including skipped/no-spec and reduced coverage. Done when completion counts reconcile without a global concern ranking.

Release only this run's lock via the state procedure, then display:
- Posted: review URL, constrained action, coverage/notices, separate axis totals/key concerns, actual inline/moved counts, filters, and series evidence.
- Local-only: full review plus inline comments grouped by axis, reason/rails, remote_state and checkpoint path; explicitly state posting was not performed or may have occurred when unknown.
- Autonomous: concise summary with both axes visible, caps/notices, URL or local-only reason, and series evidence; no request for input.

Mark todos with their actual completed/resumed/skipped/failed outcomes. Done when remote truth, local persistence, coverage, and cleanup are disclosed. R5 is terminal; follow-up work starts again at R0.

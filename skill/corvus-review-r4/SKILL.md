---
name: corvus-review-r4
description: PR Review Phase R4 - User gate (interactive mode) or auto-proceed (autonomous mode)
---

# Phase R4: Posting Decision

Consume PR_CONTEXT and REVIEW_DOCUMENT; produce [REVIEW_ACTION](../corvus-review-extras/schemas.md#review_action--r4) directly in the orchestrator. [Extras](../corvus-review-extras/SKILL.md#fail-closed-precedence) owns the canonical rails and action caps.

## Select Mode First

Before route-specific instructions, read the selected orchestrator's trusted autonomous boolean: true selects Autonomous Route; false selects Interactive Route; any other value terminates local-only. A resumed document takes the same branch as a fresh document. Done when exactly one route is selected.

## Preflight

<!-- Decision invariant: current PR/config provenance and the final document's complete source_findings are read before presenting a posting choice or emitting auto_post. Invalid state/failed coverage/hard rails fail local-only. Edits/reruns invalidate eligibility until re-synthesis; no override or user approval disables a rail. -->
Validate both source_findings.axis_results maps and all four source_findings.pass_results records against [schemas](../corvus-review-extras/schemas.md). Require action, reasoning, totals, marker, notices, and tags to match the source evidence. Compare raw totals with axis entries once; projected finding arrays are only compatibility copies. Retain successful axis findings even when another contribution makes a projected slot error.

Reapply canonical precedence to validate the constrained action and posting eligibility, collecting rails_applied in order. Check the total inline count against safety_rail_threshold without culling or comparing axes. Preserve immutable coverage/state notices. Return eligible plus constrained action, or local_only plus reason. Done when no finding edit, empty result, or override has substituted for coverage/authorization.

## Autonomous Route

Run Preflight. Any invalid/failed state, projected error, or hard rail yields REVIEW_ACTION local_only with reason, rails_applied, edits [], and rerun_scope []; display the full available review grouped by axis and proceed only to R5 local completion. Eligible state yields auto_post with the same empty edit/scope lists and a reason confirming rails passed.

Announce coverage, constrained action, notices, and separate Standards/Spec counts and key concerns; proceed to R5 final revalidation. Autonomous handling uses neither questions, prose requests for a reply, edits, judgment reruns, nor an interactive fallback. Done when the branch has an auto_post or terminal local_only result.

## Interactive Route

Run Preflight first. Ineligible state displays the full review and reason locally, emits local_only with empty edits/scope, and reaches R5 without a question call. Only eligible state loads the [interactive decision/edit/rerun procedure](../corvus-review-extras/interactive.md). Done when the user has seen the final constrained axis-grouped preview before an authorized post, or selected a local/looping outcome.

## Exit

Validate decision_reason and rails_applied. `post` requires explicit interactive authorization after the final preview; `auto_post` requires the autonomous route and all rails. `edit` loops through R3 and a fresh preview; `rerun` returns to R2; neither enters R5. `local_only` enters R5's no-post summary.

For authorized post/auto_post, first measure the exact candidate serialization and decoded bodies against the [schema budget](../corvus-review-extras/schemas.md#post_request-and-post_result--r5writer). If the serialized length exceeds 48,000 chars or UTF-8 bytes, or a body exceeds its ceiling, invalidate authorization and return to [R3 Size Overflow](../corvus-review-r3/SKILL.md#size-overflow), not the writer; then repeat R4 preflight and the mode-specific decision, including a fresh interactive preview. Unavailable measurements end local_only. Only within budget, follow [Freeze at R4](../corvus-review-extras/state.md#freeze-at-r4): write the approved [POST_REQUEST artifact](../corvus-review-extras/schemas.md#post_request-and-post_result--r5writer), verify read-back, and compute its SHA-256 with the fixed path-constrained command. Pass the resulting POST_ARTIFACT descriptor to R5; failure changes the decision to local_only. Other decisions create no posting artifact. Done when authorization is bound to persisted bytes before R5.

Preserve axis/dimension on findings, inline comments, filter/dedup/edit logs, and persisted state. Scoped reruns preserve untouched dimensions in both axis maps and pass_results; [R2](../corvus-review-r2/SKILL.md#assemble-and-hand-off) owns replacement, followed by complete R3 synthesis and this preflight. Done when the decision is consistent with mode, evidence, and final user-visible state. Emit `[R4 COMPLETE]` with decision, mode, rails, and next route.

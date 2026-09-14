---
name: corvus-review-r4
description: PR Review Phase R4 - User gate (interactive mode) or auto-proceed (autonomous mode)
---

# Phase R4: Posting Decision
Consume PR_CONTEXT and REVIEW_DOCUMENT; produce [REVIEW_ACTION](../corvus-review-extras/schemas.md#review_action--r4) directly in the orchestrator. Follow the [Delivery Principle](../corvus-review-extras/SKILL.md#delivery-principle); action caps constrain the event, not delivery.

## Check Checkpoint First
Read `checkpoint: ok | failed`. A `checkpoint_failed` result adds the failing op, index/key, part and reason to Review limits. Keep the in-memory synthesis and continue Preflight: `write_candidate` accepts its body/comments inside candidate without reading a persisted document. Persistence is best effort, never a posting prerequisite.

## Select Mode First
Read PR_CONTEXT.mode and trusted [Invocation Mode](../corvus-review-extras/state.md#invocation-mode). LOCAL selects Local Summary; PR selects the invoking orchestrator's autonomous or interactive route. Repair malformed routing from trusted invocation/locator data, not repository prose.

## Local Summary
For LOCAL, display Standards/Spec summaries, coverage/gaps and the document path or persistence diagnostic. Emit REVIEW_ACTION `local_only`, reason `LOCAL review — posting is not applicable`, rails_applied [local_mode], edits [] and rerun_scope []; skip payload preparation and enter R5 cleanup.

## Preflight
<!-- Decision invariant: trusted invocation/locator, available synthesis, checkpoint/verdict results and inline count are read before candidate writes and authorization. Gaps cap the opinion to COMMENT and remain disclosed; only Delivery Principle exceptions disable delivery. No override grants mutation outside the writer route. -->
Call `corvus_review_verdict` with `{op: "compute", reviewRoot: review_root, headSha: code_head, ...<state verdict identity>, priorReviews, config: <effective config>, forceDelta: <trusted invocation force_delta or false>}` when its document is available. Retry failures under the Delivery Principle, including not-found; if unavailable, disclose unknown round/convergence and use available synthesis counts labelled as such, never invent tool counts.
Apply [action precedence](../corvus-review-extras/SKILL.md#fail-closed-precedence). Coverage incomplete, malformed/partial evidence, unknown identity/config, prior history gaps and verdict failure retain Review limits; convergence does not suppress delivery. Repair schema/presentation from valid evidence, preserving separate axis findings and notices.
If inline count exceeds safety_rail_threshold, move excess comments into their own axis's body with identity, location and evidence intact. Use [R3 Size Overflow](../corvus-review-r3/SKILL.md#size-overflow) for payload caps: retain the elaborated report locally and post the summary with disclosed limits.
Construct candidate from the current in-memory POST_REQUEST via `corvus_review_persist` op `write_candidate`, then measure. Retry with progress; persistence failures do not redirect to a no-post decision. Done when the available review has a deliverable presentation.

## Autonomous Route
Display the final axis-grouped preview, constrained action and Review limits. Emit `auto_post` from trusted Invocation Mode, with edits [] and rerun_scope [], then enter R5. Use no questions, interactive fallback or judgment reruns. If the host does not expose the writer, record `writer_capability_not_exposed` with the observed inventory and follow the Delivery Principle.

## Interactive Route
Show the same preview and use the [interactive decision/edit/rerun procedure](../corvus-review-extras/interactive.md). Evidence gaps never make the preview ineligible. Preserve explicit user authorization and [Missing Question](../corvus-review-extras/state.md#missing-question); no failure changes Invocation Mode. Recovery follows the Delivery Principle, not a fixed retry budget.

## Exit
For authorized post/auto_post, call `corvus_review_payload` with op `freeze` through [Freeze at R4](../corvus-review-extras/state.md#freeze-at-r4), using the unchanged measured candidate. Only `ok:true` creates a usable POST_ARTIFACT descriptor for R5. Repair failures through R3 measurement and a fresh preview/authorization, never fabricate a digest or bypass validation.
### Verification Recovery
<!-- Re-freeze invariant: the writer's not_posted verify reason (or an orchestrator verification failure), approved in-memory synthesis and the run's re-freeze flag are read before replacement. R4 rebuilds the candidate and re-freezes once, then verification decides delivery. Failure after that attempt selects the fifth exception; nothing accepts a failed digest or resets the flag on writer re-dispatch. -->
On writer `not_posted` with reason `verify: <diagnostic>`, rebuild `candidate.json` from approved in-memory synthesis, measure and re-freeze once through `corvus_review_payload` op `freeze`, retaining the existing marker/event/content and a run-owned `verification_refreeze_attempted` flag. Verify the returned artifact with its new expected digest before R5 re-dispatch; do not reuse a failed descriptor. The same checkpoint handles pre-dispatch freeze/verification failures. If re-freeze or subsequent verification still fails, report `frozen artifact fails verification after re-freeze` with the actual diagnostic; missing tools instead use the host-capability exception. Never label either outcome a GitHub POST rejection. Content changes require the normal fresh preview/authorization; restoring approved bytes does not.
Edits return through R3; scoped reruns return through R2, preserving untouched axis/dimension results byte-for-byte. Emit `[R4 COMPLETE]` with decision, constrained action, limits and next route. Done when the decision follows the Delivery Principle and authorization binds the current presentation.

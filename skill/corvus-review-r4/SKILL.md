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
<!-- Decision invariant: trusted invocation/locator, available synthesis and checkpoint/verdict results are read before candidate writes; freeze/preview results are read before authorization. Shared precedence constrains the opinion, state notices remain informational, and gaps remain disclosed; only Delivery Principle exceptions disable delivery. No override grants mutation outside the writer route or authorizes bytes absent from the preview. -->
Call `corvus_review_verdict` with `{op: "compute", reviewRoot: review_root, headSha: code_head, ...<state verdict identity>, priorReviews, config: <effective config>, forceDelta: <trusted invocation force_delta or false>}` when its document is available. Retry failures under the Delivery Principle, including not-found; if unavailable, disclose unknown round/convergence and use available synthesis counts labelled as such, never invent tool counts.
Apply [action precedence](../corvus-review-extras/SKILL.md#fail-closed-precedence); state notices do not select the event. Coverage incomplete, malformed/partial evidence, unknown identity/config, prior history gaps and verdict failure retain Review limits; convergence does not suppress delivery. Repair schema/presentation through R3 from valid evidence, preserving separate axis findings and notices.
For PR delivery, use stage candidate → measure (size violations are expected input to freeze, not a stop) → freeze → `preview` op → authorization → R5.
Reuse R3's completed stage/measure pair when the current in-memory POST_REQUEST is unchanged; otherwise follow [R3 Measure Candidate](../corvus-review-r3/SKILL.md#measure-candidate) once for the new revision, including staged `candidate` persistence for an oversized body or comment `path`/`body`. Document-checkpoint failure does not prevent this route. Retry schema/I/O failures with progress, not size loops.
Call `corvus_review_payload` op `freeze` through [Freeze at R4](../corvus-review-extras/state.md#freeze-at-r4) on that measured candidate, before either mode's authorization. Only `ok:true` supplies the artifact path, digest and measurements for POST_ARTIFACT via that mapping; retain `fitted` and `omitted` bound to the returned artifact sha256, not the pre-fit candidate digest. When `fitted:true`, record `size_fit` in rails_applied and disclose `omitted.comments` and `omitted.findings` in Review limits and the terminal summary; the footer count is their sum. Keep the full local REVIEW_DOCUMENT separately, not replaced by the fitted body.
Call `corvus_review_payload` with `{op: "preview", artifactPath: <artifact_path>, expectedSha256: <expected_sha256>}` from the frozen descriptor. Show its actual decoded `body` and `comments`, including anchors/bodies and zero inline comments when fitting dropped them; label the full REVIEW_DOCUMENT and its counts as local, not posted content. Preview via this op, not host file reads: escaped JSON body lines can be truncated there. A failed preview returns no body text and goes to Artifact Repair, never a reconstructed preview. Done when authorization can bind the exact previewed artifact digest, event and presentation.

## Autonomous Route
Display the frozen preview, constrained action and Review limits. If the host does not expose the writer, record `writer_capability_not_exposed` with the observed inventory and follow the Delivery Principle; an inert frozen artifact is fine without authorized writer dispatch. Otherwise emit `auto_post` from trusted Invocation Mode bound to the previewed digest, with edits [] and rerun_scope [], then enter R5. Use no questions, interactive fallback or judgment reruns.

## Interactive Route
Show the same frozen body/comments preview and use the [interactive decision/edit/rerun procedure](../corvus-review-extras/interactive.md), distinguishing posted content from the full local REVIEW_DOCUMENT. Evidence gaps never make the preview ineligible. Preserve explicit user authorization bound to the previewed digest and [Missing Question](../corvus-review-extras/state.md#missing-question); no failure changes Invocation Mode. Recovery follows the Delivery Principle, not a fixed retry budget.

## Artifact Repair
<!-- Repair invariant: freeze/preview failures or the writer's not_posted diagnostic and validated in-memory synthesis are read before replacement. Invalid descriptors lose authorization and return through Preflight; failures never authorize dispatch or become fabricated GitHub rejections. Only a fresh preview and the invoking mode's authorization enable R5 revalidation; no mode bypasses posting integrity. -->
R4 owns artifact repair (re-stage → measure → freeze → preview → re-authorize). On writer `not_posted` with reason `verify: <diagnostic>`, including `artifact-verify-failed:<detail>`, invalidate the descriptor, re-stage and measure via R3 Measure Candidate, then follow Preflight from the validated in-memory synthesis, preserving marker/event and available content. Pre-dispatch freeze/preview failures use the same progress-based repair. Every replacement needs the mode's fresh authorization, even when restoring earlier content. If the post tool rejects the artifact bytes and repair stalls, report that Delivery Principle exception with the actual diagnostic; missing tools use the observed host-capability exception. Never label either a GitHub POST rejection.

## Exit
For authorized post/auto_post, hand R5 only the current frozen descriptor with authorization bound to its previewed digest; freeze/preview already occurred in Preflight. Repair missing/invalid descriptors through Artifact Repair, never fabricate a digest or bypass validation.
Edits return through R3; scoped reruns return through R2, preserving untouched axis/dimension results byte-for-byte. Emit `[R4 COMPLETE]` with decision, constrained action, limits and next route. Done when the decision follows the Delivery Principle and authorization binds the current presentation.

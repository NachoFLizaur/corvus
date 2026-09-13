# Phase 4 Dispatch Templates

## Prepare Dispatch Inputs

<!-- Dispatch invariant: trusted controls and brief size are read before dispatch; child results and bounded recovery outcomes before phase advancement or turn end. Compact oversized briefs within their cap, preserving controls. Missing/malformed reports use transport-retry.md, then available evidence continues with gaps noted. No mode or acknowledgement supplies PASS or disables an approval, ownership, or validation gate. -->
Dispatch children in the FOREGROUND. Never select background/async mode; if the tool exposes `background`, set it `false`. Two parallel calls in one message are fine — parallel is not background. A session id or `status: running` acknowledgement is not a child result. Account for each child through its result or bounded recovery before ending the turn.

Read approved PLAN.md and current repository instructions; use [ownership resolution](#ownership-resolution) for per-task write allowlists and resolve environment-derived checks under caller policy and [Tests](../../corvus-phase-2/SKILL.md#tests). Commands belong in dispatches, not the plan.
Missing companion, CONTEXT.md, or DISCOVERY.md: continue with available context and a note, without inventing approval or ownership. Trim over-cap child briefs by removing redundant prose and using verified evidence pointers; preserve trusted controls, scope, and safety constraints rather than rejecting the brief.

Cite dispatch-authored premises inline with session output or `file:line`; send uncited premises as verification questions. Apply [Evidence and Preservation](../../../agent/code-implementer.md#evidence-and-preservation) to premise verification. For derived constants, supply the governing property and require derivation; pin literals only for sourced external requirements.

For current/previous/outgoing/baseline reasoning, discover the default branch and compute `git merge-base HEAD <default-branch>`; supply its full SHA and provenance, not branch HEAD, for every baseline comparison and fix.
<!-- Provenance oracle: session-read sources and the computed merge base, checked before dispatch. Unverified claims become questions; an unavailable required baseline leaves comparison unknown while current-state analysis continues with a note. Only a dispatch with no baseline reasoning may mark the SHA not applicable. -->
Done when inputs are grounded, concurrent ownership is disjoint, and every task has a validation allowlist with policy omissions.

## Ownership Resolution

Send to code-explorer for the wave selected in 4a; scope exploration to its task lines.

```markdown
**TASK**: Resolve ownership for frontier wave <ID> in Phase <N>; read-only.
**Repository**: <canonical user-repository root>
**Plan**: <absolute PLAN.md path>
**Task Lines**: <all wave task IDs and verbatim PLAN.md lines: behavior, seams, blocks, done when>
**Tests**: <selected plan policy; candidate coverage follows its authoring permissions>
**Scope**: Trace those behaviors through their seams and relevant consumers; identify candidate
existing/new paths, including policy-permitted tests and docs. Reuse existing patterns;
ground proposed new paths in `file:line` evidence from neighboring code or conventions.
**Report Back**: Per-task candidate file list with roles and `file:line` evidence; a pairwise
overlap matrix listing shared paths or explicit disjointness; unresolved ownership questions.
Report candidates only; the orchestrator derives write allowlists and schedules dispatches.
```

Done when every wave task has evidenced candidates and each pair has an overlap result; missing evidence remains unresolved, not permission to write.

## Implementer Payload

Send to code-implementer; repeat task-specific fields for each member of a small group.

```markdown
**TASK**: Implement <task IDs> in Phase <N>.
**DELEGATED MODE**: Pre-approved via PLAN.md. Execute without another approval request.
**Repository**: <canonical user-repository root>
**Plan**: <absolute PLAN.md path; read requirements, decisions, and assigned tasks>
**Task Line**: <verbatim task line from PLAN.md, including blocks and done when>
**Write Allowlist**: <task ID → exact paths; only these paths are writable>
**Tests**: <selected plan policy; apply corvus-phase-2 §Tests>
**Authorized Validation**: <task ID → exact environment-derived commands and source>
**Not Run By Policy**: <checks excluded by the caller/workflow and why>
**Merge Base SHA**: <full SHA and command provenance, or NOT APPLICABLE with reason>
**Premises**: <sourced mechanical facts; evidenced analytical claims; verification questions>
**AUDIT INHERITED STATE**: <NONE, or cancelled task ID, overlapping paths, observed state;
preserve/reconcile partial edits before mutation, within the original allowlist>
**Report Back**: One section per task: ID; PASS/FAIL/BLOCKED; changed paths and summaries;
done-when evidence; every authorized command with actual output; policy-based omissions;
issues and resolutions; deviations with reasons and preservation evidence; remaining work.
```

Apply code-implementer's Delegated Mode per task, including its two-attempt failure rule and dependent blocking; never pool file or command permissions.
Done when each task has a conforming report and disk-verified artifacts, or a precise failure to route.

## Acceptance Check Payload

Send to code-quality for the whole phase, including every frontier batch and fix; fold phase metadata into this payload, without a separate extraction pass.

```markdown
**TASK**: Validate Phase <N> against every task's done-when and applicable acceptance criteria.
**Repository**: <canonical user-repository root>
**Plan**: <absolute PLAN.md path>
**Phase Tasks**: <IDs and verbatim task lines, preserving any review tags>
**Ownership And Changes**: <per task: dispatched allowlist, actual changed paths, report pointer>
**Mode**: ACCEPTANCE-ONLY
**Tests**: <selected policy; timing is owned by corvus-phase-2 §Tests>
**Authorized Validation**: <exact permitted checks, sources, and 4a output already available>
**Not Run By Policy**: <excluded checks and controlling policy>
**Merge Base SHA**: <sourced full SHA from the implementation dispatch, or justified N/A>
**Evidence**: <4a reports, prior gate/fix reports, review tags, and finding lineage>
**Report Back**: QUALITY GATE STATUS: PASS / FAIL; a task/criterion/status/evidence row
for every done-when and applicable acceptance criterion; command/output rows and policy
omissions; regressions; task attribution for every failure; failing-task-only fix scope;
finding origins and any unresolved evidence gaps.
```

Apply code-quality's Phase-Level Validation and Evidence Rules to acceptance, regressions, prose accuracy, and configurable-invariant boundaries; evidence from defaults alone leaves those invariants open.
Done when the whole phase has an evidenced verdict with actionable task attribution.

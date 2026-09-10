# Phase 4 Dispatch Templates

## Prepare Dispatch Inputs

Read the approved PLAN.md and current repository instructions before filling a template.
Use [ownership resolution](#ownership-resolution) for per-task write allowlists. Resolve
authorized checks from the environment, narrowed by caller policy and
[Tests](../../corvus-phase-2/SKILL.md#tests). Keep commands in dispatch payloads rather
than storing an environment snapshot in the plan.

Cite every dispatch-authored factual premise inline with this session's command output
or `file:line`; send uncited premises as questions to verify. Check mechanical premises
directly. Security-relevant or durable analytical claims require a call-path trace or
failing-test demonstration permitted by the active policy. For derived constants, give
the governing property and require derivation; pin a literal only for a sourced external requirement.

When reasoning about current, previous, outgoing, or baseline state, discover the default
branch and compute `git merge-base HEAD <default-branch>`. Supply the full SHA and its
provenance; branch HEAD is not the baseline. Use that SHA for every baseline comparison
and preserve it through fixes.
<!--
Provenance oracle: session-read sources and the computed merge base, checked before dispatch.
Unverified claims become questions; an unavailable required baseline blocks comparison.
Only a dispatch with no baseline reasoning may mark the SHA not applicable.
-->
Done when inputs are grounded, ownership is disjoint across concurrent dispatches, and
each task has an explicit validation allowlist, including policy-based omissions.

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

Done when every wave task has evidenced candidates and each pair has an overlap result;
report missing evidence as unresolved, not as permission to write.

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

Read the task context before editing; implement and validate each task against its own
contract, without pooling file or command permissions. The implementer's delegated
two-attempt rule applies per task; report failures and keep blocked dependents pending.
Done when every assigned task has a conforming report and every claimed artifact is
verified on disk, or the caller has a precise failure to route.

## Acceptance Check Payload

Send to code-quality for the whole phase, including every frontier batch and fix.
Fold phase metadata into this payload rather than issuing a separate extraction pass.

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

Verify acceptance through file inspection, code review, and authorized command evidence.
Account for actual 4a checks rather than assuming generic commands ran. Policy omissions
are not failures; missing authorized output or unsupported acceptance claims are gaps.
Review regressions and prose accuracy; re-derive configurable invariants at minimum,
shipped default, and maximum. Evidence from defaults alone leaves those invariants open.
Done when the whole phase has an evidenced verdict with actionable task attribution.

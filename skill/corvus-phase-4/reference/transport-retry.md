# Child Transport Recovery

Apply this procedure to build-pipeline children, including planners, implementers,
reviewers, quality agents, analysts, explorers, and researchers. An empty report,
critical truncation, missing required report section, or claimed artifact absent on disk
is a transport failure. A well-formed failure is a real result, not a retry opportunity.

<!--
Recovery oracle: the saved dispatch bytes, report schema, retry counters, and workspace
state, read before recovery or redispatch. Unknown mutation state blocks implementer
recovery; exhausted transport allowance follows the step's failure path. Both callers use
the same allowance; retries replace the original call and never extend fix/judgment budgets.
-->
1. Check the required report schema and read every claimed written artifact directly,
   including hidden plan paths. Done when the result is valid or transport loss is identified.
2. Before recovering an implementer, inspect read-only Git status and expected artifacts
   against its allowlist. Brief it on observed partial edits as separate recovery metadata:
   preserve/reconcile existing work, avoid repeating completed mutations, and retain the
   original file/validation contract. If state cannot be established, take the step's
   failure path. Done when mutation state is known or recovery is blocked.
3. Resume the same child once, requesting only its final report. If still invalid,
   redispatch once with byte-identical task inputs; keep recovery metadata separate and
   refresh the mutation audit for implementers first. Check each returned report using
   step 1. Done when a conforming replacement arrives or both recovery opportunities expire.
4. On exhaustion, follow the owning step's failure path: 4b FAIL, 5b fail-closed, or a
   blocked phase as applicable. Recovery replaces a dispatch in existing counters rather
   than adding a workflow decision. Done when the result is routed without budget extension.

## Cancelled Dispatches

Record `working tree may contain partial edits from task <ID>` when a dispatch is cancelled
or aborted. Before another dispatch overlaps its files, inspect Git status and expected
artifacts, then include `AUDIT INHERITED STATE` naming the cancelled task, overlapping
paths, and observed state. Require preservation/reconciliation before further edits under
the unchanged scope; unknown state blocks the overlap. This applies even without a retry.
Done when the next owner receives the audited state, or the overlap is held and reported.

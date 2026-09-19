# Child Transport Recovery

Apply this procedure to build-pipeline children, including planners, implementers,
reviewers, quality agents, analysts, explorers, and researchers. An empty report,
critical truncation, missing required report section, or claimed artifact absent on disk
is a transport failure. A well-formed failure is a real result, not a retry opportunity.

<!-- Recovery oracle: saved dispatch bytes, report schema, retry count, and workspace state, read before recovery. Unknown mutation state blocks implementer recovery; exhausted or unavailable recovery continues available evidence with a note, not PASS or mutation authority. Both callers allow one same-session retry; it never extends fix/judgment budgets or disables approval, ownership, or validation gates. -->
1. Check the required report schema and read every claimed written artifact directly,
   including hidden plan paths. Done when the result is valid or transport loss is identified.
2. Before recovering an implementer, inspect read-only Git status and expected artifacts
   against its allowlist. Brief it on observed partial edits as separate recovery metadata:
   preserve/reconcile existing work, avoid repeating completed mutations, and retain the
   original file/validation contract. If state cannot be established, take the step's
   failure path. Done when mutation state is known or recovery is blocked.
3. Retry once in the same child session, requesting only its final report, with unchanged task inputs and separate recovery metadata. Check the result using step 1; if the session is unavailable, record that instead of launching a replacement. Done when the retry returns or is unavailable.
4. Then continue with available results and a note naming the child, retry outcome, and unresolved evidence. Preserve valid sibling findings; mark unknown coverage honestly. Continue independent authorized work or a partial summary, not dependent mutations, false PASS, or completion with failed validation. Done when results and gaps are routed without budget extension.

## Cancelled Dispatches

Record `working tree may contain partial edits from task <ID>` when a dispatch is cancelled
or aborted. Before another dispatch overlaps its files, inspect Git status and expected
artifacts, then include `AUDIT INHERITED STATE` naming the cancelled task, overlapping
paths, and observed state. Require preservation/reconciliation before further edits under
the unchanged scope; unknown state blocks the overlap. This applies even without a retry.
Done when the next owner receives the audited state, or the overlap is held and reported.

# Interactive Review Decision

Load only after [R4](../corvus-review-r4/SKILL.md) selects interactive mode and passes Preflight. The autonomous branch never loads this procedure.

## Preview and Choose

Show the complete review_body, action_reasoning, exact notices, and separate Standards/Spec totals, key concerns, and inline previews. Display finding ID and axis/dimension with path/range. If previews are shortened, show up to ten per axis and disclose each omitted count; make the full group available before approval. Done when neither axis is hidden by the other's size or severity.

Use question() with Post Review, Edit Comments, Save Locally, and Re-run Review buttons. Post describes the constrained action and total inline count. Post emits decision post only for this final preview; Save Locally emits local_only and `This review was NOT posted to GitHub.` Done when the user has explicitly selected a route.

## Edit Within Axis Groups

Present findings in their existing Standards/Spec groups, addressable by stable ID. Support remove ID, edit ID, add, change action, and done. Additions require all Finding fields, including explicit axis and dimension/pass, fresh collision-free ID, and cited evidence; a Spec addition requires its spec source/quote. Preserve tags on ordinary edits; an explicit user reclassification records both before/after identities rather than silently moving groups. Done when every edit is schema-valid or its missing input is requested.

Store each operation in edit_history with full before/after values and identity. Maintain source_findings unchanged as coverage evidence; apply the edit overlay before R3 filters so removal stays removed without fabricating review completion. A user action request becomes a trusted override inside the canonical caps. Done when modifications can be replayed and audited after resume.

Emit an intermediate edit decision with the non-empty edit list, then run R3's full axis-local filtering, budgets, ordering, action, rendering, and persistence against the unchanged coverage statuses. Restore derived marker/notices from controls. Re-run R4 Preflight: hard rails now terminate locally without another prompt; otherwise show a new complete preview and ask again. Earlier approval does not carry over. Done when any post refers to the final edited bytes and constrained action.

## Dimension-Scoped Rerun

<!-- Rerun invariant: trusted user scope and complete saved source_findings are read before replacement. Missing scope/source state fails local-only. At most two judgment reruns are offered; this limit disables that option only, while R2's separate transport recovery remains available. -->
Use question() to select the scope; retain dimension names as the wire vocabulary:

| Option | rerun_scope | Work via R2 |
|--------|-------------|-------------|
| Full Review | architecture, correctness, conventions, security | Both children, subject to configured eligibility |
| Architecture Dimension | architecture | Standards child plus eligible Spec work |
| Correctness Dimension | correctness | Standards child plus eligible Spec work |
| Conventions Dimension | conventions | Standards child plus eligible Spec work |
| Security Child | security | Specialist only: independent security plus eligible Spec security |

Emit decision rerun with the selected non-empty list, empty edits, and a reason. Retain untouched dimensions byte-for-byte in BOTH source_findings.axis_results maps and pass_results; replace only selected dimensions using R2's mapping. Retain untouched IDs and edit overlays; retire overlays tied to replaced findings with an audit note, and preserve independent manual additions. Done when replacement has complete axis/projection evidence and no unrelated result was lost.

Recompute totals from full axis_results, then run R3 and R4 again, recomputing synthesis, coverage warnings, action, persistence, and all rails. Count this as one judgment rerun regardless of child count. After two reruns remove the option and display `Maximum re-runs reached. Please post, edit, or save locally.` Done when rerun output reaches a new eligible preview or terminal local-only result.

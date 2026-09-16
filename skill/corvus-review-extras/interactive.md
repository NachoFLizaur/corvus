# Interactive Review Decision

Load only after [R4](../corvus-review-r4/SKILL.md) selects interactive mode and passes Preflight. The autonomous branch never loads this procedure.

## Preview and Choose

Show the complete decoded `body` and `comments` returned by `corvus_review_payload` op `preview` for R4's frozen descriptor before asking for authorization. Preview via this op, not host file reads: escaped JSON body lines can be truncated there. Draw per-axis inline previews only from that posted set, displaying finding ID and axis/dimension with path/range; fitted artifacts have zero inline comments. Label the full local REVIEW_DOCUMENT and its separate Standards/Spec totals/key concerns as local evidence, not posted content. Show action_reasoning, exact previewed notices and fitted omission counts. Done when the complete proposed post is visible and distinct from the local report.

Before a question call, apply [Missing Question](state.md#missing-question) if the host does not advertise the tool; preserve the preview/checkpoint without authorizing a post.

Use question() with Post Review, Edit Comments, Save Locally, and Re-run Review buttons. Post describes the constrained action and actual previewed inline count. Post emits decision post only for this final preview's digest and event; Save Locally emits local_only and `This review was NOT posted to GitHub.` Done when the user has explicitly selected a route.

## Edit Within Axis Groups
Present findings in their existing Standards/Spec groups, addressable by stable ID. Support remove ID, edit ID, add, change action, and done. Additions require all Finding fields, including explicit axis and dimension/pass, fresh collision-free ID, and cited evidence; a Spec addition requires its spec source/quote. Preserve tags on ordinary edits; an explicit user reclassification records both before/after identities rather than silently moving groups. Retain the original finding on an incomplete edit; leave incomplete additions unapplied and note the gap. Done when valid edits proceed and incomplete requests remain visible.
Store each operation in edit_history with full before/after values and identity. Maintain source_findings unchanged as coverage evidence; apply the edit overlay before R3 filters so removal stays removed without fabricating review completion. A user action request becomes a trusted override under [configured-action/delivery precedence](SKILL.md#fail-closed-precedence), including its coverage constraints; state notices do not select the event. Done when modifications can be replayed and audited after resume.

Emit an intermediate edit decision with the non-empty edit list, then run R3's full axis-local synthesis and `corvus_review_persist` checkpoint/candidate ops against unchanged coverage; restore derived notices and re-run R4 Preflight. Disclose gaps under the [Delivery Principle](SKILL.md#delivery-principle), show the new complete preview and ask again. Earlier approval never carries over.

## Dimension-Scoped Rerun
<!-- Rerun invariant: trusted user scope and available source_findings are read before replacement. Missing scope/source evidence retains the existing review with a limitation, not an invented replacement. User scope disables only unselected work; recovery follows progress, with no attempt-count gate. -->
Use supplied scope or offer question(); without a selection retain the existing review, note that no rerun occurred, and return to the preview without a replacement dispatch. Retain dimension names as the wire vocabulary:
| Option | rerun_scope | Work via R2 |
|--------|-------------|-------------|
| Full Review | architecture, correctness, conventions, security | Both children, subject to configured eligibility |
| Architecture Dimension | architecture | Standards child plus eligible Spec work |
| Correctness Dimension | correctness | Standards child plus eligible Spec work |
| Conventions Dimension | conventions | Standards child plus eligible Spec work |
| Security Child | security | Specialist only: independent security plus eligible Spec security |

Emit decision rerun with the selected non-empty list, empty edits, and a reason. Retain untouched dimensions byte-for-byte in BOTH source_findings.axis_results maps and pass_results; replace only selected dimensions using R2's mapping. Retain untouched IDs and edit overlays; retire overlays tied to replaced findings with an audit note, and preserve independent manual additions. Done when replacement has complete axis/projection evidence and no unrelated result was lost.

Recompute totals from full axis_results, then run R3 and R4 again, recomputing synthesis, coverage warnings, action, persistence, and action caps. Retry while progress is made; retain user-selected rerun scope and disclose stalled results rather than removing the option by count. Done when available rerun output and limits reach a fresh preview.

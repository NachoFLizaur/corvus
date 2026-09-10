# Phase 4 Fix Handling

## Finding Lineage And Stop Rule

Classify each finding as requested functional change, pre-existing code, or apparatus
introduced by a prior remediation; carry task, defect class, origin, and iteration lineage.
Track external review rounds separately from 4b iterations. Two consecutive rounds with
the same defect class or prior-remediation apparatus pause further fixes for root-cause
analysis and a revert/simplify evaluation. Apply the same pause to two consecutive 4b
iterations finding prior-remediation apparatus. Disclosed symptom patches retain lineage;
review boundaries preserve it.
<!--
Remediation oracle: current and previous finding lineage, read before each fix dispatch.
The repeated-class/apparatus signal holds further edits until an evidenced root-cause and
revert/simplify decision exists; missing lineage holds triage. A new review boundary or
transport replacement never disables tracking.
-->
Trace the common decision point, then record keep/revert/simplify with evidence. Apply
[production-gap escalation](../SKILL.md#production-gap-escalation) to the implementation report.
Done when lineage and any required root-cause/revert evaluation justify the next action,
or the unresolved gap is escalated.

## Analysis Payload

Use at the iteration selected by [Phase 4](../SKILL.md#failure-routing), after triage.

```markdown
**MODE**: FAILURE_ANALYSIS
**Repository**: <canonical user-repository root>
**Plan**: <absolute PLAN.md path>
**Phase And Iteration**: <phase ID, fix iteration of 3>
**Failing Tasks**: <IDs, quoted task lines, failed criteria, exact errors, observed paths>
**Evidence**: <gate report, prior fixes, finding origins, repeated-class evaluation>
**Report Back**: Root cause per failing task; why earlier fixes missed it; wrong-plan or
missing-context gaps; actionable fix instructions; observable recovery checks.
```

Use task-planner's diagnostic mode; route necessary plan edits back through planning.
Done when each failure has an evidenced cause and fix direction, or a blocking evidence gap.

## Fix Payload And Revalidation

Reuse the [implementer payload](dispatch-templates.md#implementer-payload), restricted to
failing tasks, with their original per-task ownership, validation policy, and baseline.
Append the gate report at iteration 1; append FAILURE_ANALYSIS as well from iteration 2.

```markdown
**Fix Inputs**: <failure report, analysis when required, origins, and keep/revert/simplify decision>
**Passing Tasks**: <IDs to preserve unchanged>
**Fix Method**: Apply code-implementer's Defect-Fix Protocol; treat observed sites as
symptom reports, trace origins before editing, enumerate siblings, and disclose placement.
**Additional Report Back**: Root-cause trace; root fix or disclosed symptom patch with
reason; sibling-site coverage and remaining exposure; verification evidence; ready for 4b.
```

Fixes inherit the original mirror, documentation, and prose-verification obligations at
their blast radius. An undisclosed symptom patch blocks acceptance of the fix report.
After a conforming report, dispatch the original whole-phase 4b check with updated evidence;
keep its scope and permitted commands unchanged, even for prose-only fixes.
Done when a real 4b report passes or returns the next attributed failure for routing.

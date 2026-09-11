# Review Remediation

## Verify and Scope

Trace each reported symptom to its originating decision point and search sibling sites
before choosing files. Reviewer assertions are hypotheses: verify mechanical premises
directly, and security-relevant analytical claims with a call-path trace or an authorized
failing-test demonstration. Keep unverified claims open rather than encoding them as facts.
Done when each finding has evidence, a root cause or explicit gap, and a defect-class label.

Combine verified findings into one remediation contract. Dispatch once per defect class,
covering the root and siblings; treat self-contained findings separately. Prefer removing
redundant apparatus or stating an invariant before introducing reviewer-suggested machinery.
When a review reverses a settled request, surface the prior rationale on the first flip;
reopen declined findings only with new evidence. If the root fix exceeds authorized scope,
report `production would need to change` with required paths/behavior and route for planning.
Done when the contract covers the class without disguising symptom patches as root fixes.

## Remediation Ledger

Keep `.corvus/tasks/<feature>/REMEDIATION_LEDGER.md` as the durable review-series record.
Read previous-series ledger evidence even after a plan copy-forward; carry its rows and
source pointer into the active ledger. Use one row per finding per round:

| Round | Finding ID | Defect Class | Origin | Disposition | Fixing Commit |
|-------|------------|--------------|--------|-------------|---------------|
| N | stable ID | class | functional-change / pre-existing / prior-round-apparatus / reviewer-suggested-apparatus | open / fixed / declined / deferred | SHA or pending |

Corvus reads the ledger and computes a prospective update from current verified findings;
it delegates persistence. Include the active ledger in the child's exact write allowlist.
The child verifies the supplied calculation and persists the rows and gate evidence before
any implementation write. Preserve earlier rounds and dispositions; use pending for an
uncommitted fix rather than inventing a commit reference.
Done when the next dispatch carries the complete prospective ledger and its calculation.

## Mechanical Lineage Gate

Before every remediation dispatch, compute over the entire prospective review-series ledger:
- Denominator: all finding/round rows, deduplicated by that pair.
- Numerator: rows whose origin is `prior-round-apparatus` or whose defect class also occurs
  in another round; count a row satisfying both only once. Record counts and the fraction.
- Block symptom-fix dispatch when the fraction is greater than 50%, or when the N=2
  consecutive-round trigger in [Phase 4's lineage rule](../corvus-phase-4/reference/fix-loop.md#finding-lineage-and-stop-rule) fires.

At a trigger, the next dispatch is root-cause analysis: identify the common decision point
or invariant and evaluate removal/revert/simplification first. Record the keep/revert/simplify
decision with evidence before admitting an implementation dispatch. Keep fired triggers
visible until this analysis resolves them; later rows cannot dilute an unresolved trigger.
<!-- Ledger oracle: verified current rows plus the full prior-series ledger, read before dispatch and rechecked by the child before persistence or product edits. Missing lineage or inconsistent counts holds both consumers; a trigger permits analysis and ledger persistence, not symptom edits. Zero rows admits no remediation. Plan copies, new rounds, and fast mode disable neither trigger; only an evidenced root-cause/removal decision resolves a fired hold. -->
Done when the recorded calculation admits an evidenced root fix, routes analysis, or holds
the dispatch for missing evidence.

## Review-Fix Dispatch

Use the eligibility boundary in [Phase 7](SKILL.md#external-review-remediation), then send:

```markdown
**TASK**: Remediate <review round and defect classes> in REVIEW-FIX ROUND MODE.
**Repository**: <canonical user-repository root>
**Source Context**: <read-only plan/history and verified request>
**Contract**: <verified findings as symptoms, root traces, siblings, settled dispositions>
**Write Allowlist**: <exact root/sibling paths and active ledger path>
**REMEDIATION_LEDGER**: <prospective rows, lineage, counts, triggers, analysis disposition>
**Tests**: <selected policy; see corvus-phase-2 §Tests>
**Authorized Validation**: <environment-derived checks narrowed by caller policy>
**Not Run By Policy**: <excluded checks and reasons>
**Fix Method**: Apply Defect-Fix Protocol; persist the verified ledger before product writes.
Sweep docs/comments describing touched contracts or constants and affected derived claims;
preserve accepted ADRs through their repository's supersession procedure.
**REPORT BACK**: Root fix or disclosed symptom patch; sibling coverage and remaining exposure;
changed paths; actual validation output; policy omissions; ledger and disposition evidence.
```

Apply [Phase 4 fix inheritance](../corvus-phase-4/reference/fix-loop.md#fix-payload-and-revalidation)
at this blast radius, including prose verification. Follow the selected
[Tests policy](../corvus-phase-2/SKILL.md#tests) without a fast-mode override; code-quality
checks the whole remediation batch and Phase 5 owns final evidence. Later edits invalidate
affected checks, including prose-only edits. Preserve source plans per Phase 7.
Done when the batch has a conforming report and validation evidence, or a scoped failure.

## Contested Estimates

Move an acknowledged estimated constant at most once per review series without new
measurement evidence. Record the move and the production data, benchmark, or observation
needed to justify another. Include that measurement debt in the hand-off; further proposed
moves without the named evidence receive a declined disposition with rationale.
<!-- Estimate oracle: series move history and specified measurements, read before authorizing a change. Missing history holds the move; absent new evidence after the first move declines it. A new review round preserves the limit; the named measurement evidence permits reassessment. -->
Done when the proposed move is evidenced or declined and its measurement debt is visible.

## Finding Disposition

Account for every finding: fixed with evidence and fixing commit or pending, declined with
rationale, or explicitly deferred with owner and reason. Prepare one thread disposition per
finding; an unposted reply remains a hand-off, not a completed delivery claim. Use only a
separately authorized delivery flow for posting; this skill grants no posting permissions.
Send GitHub text through `--body-file` or tool-managed stdin, preserving literal text.
For paginated lists, retrieve until the item count matches `totalCount` before claiming
complete coverage. Re-derive prepared PR/reply claims from the current diff after changes.
Follow [Phase 6](../corvus-phase-6/SKILL.md#6b-final-summary) for user-owned delivery boundaries.
Done when every finding has a disposition and each reply is verified posted or explicitly
handed off as pending; the review series stays open for unresolved findings.

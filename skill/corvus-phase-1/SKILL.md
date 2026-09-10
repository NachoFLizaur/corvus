---
name: corvus-phase-1
description: Discovery phase - research and codebase exploration
---

# Phase 1: Discovery

Gather the requested context once and return it to the declared caller.

## Required Dispatch Envelope

Every Phase 1 invocation includes this routing envelope:

```markdown
**DISCOVERY_ORIGIN**: <PHASE_0A or DIRECT_CALLER>
**RETURN_TARGET**: <PHASE_0B or original caller identity>
**DISCOVERY_SCOPE**: <specific unresolved questions>
**EXISTING_FINDINGS**: <accumulated findings, or none>
**Depth**: <selected effort and reason>
```

Validate the route before dispatch: `PHASE_0A` → `PHASE_0B`; `DIRECT_CALLER` → original
caller identity. Treat `EXISTING_FINDINGS` as completed work and investigate only the delta.
<!--
Routing oracle: the supplied origin and target, read before launching children. Missing or
inconsistent fields hold discovery for correction; neither depth nor caller disables routing.
-->
Done when the target and unanswered scope are unambiguous.

## Discovery Breadth

Discovery runs at every depth. Depth scales breadth, not whether this phase runs:

| Depth | Scope and Children |
|-------|--------------------|
| quick | Targeted scope; code-explorer only unless external technology is involved. |
| standard | Code-explorer and researcher; cover affected seams and external evidence. |
| deep | Both, wider integration scope, plus an in-scope ADR scan of `docs/decisions/` and relevant `.corvus/tasks/learnings.md` entries. |

Launch researcher and code-explorer in parallel when both are selected; an external
scope with no open questions returns an explicit no-new-research result. Pass applicable
ADR constraints onward for planning and review; record an absent decisions/learnings file.
Done when each unanswered item has an assigned investigator at the selected breadth.

## Concurrent-Work Check

Include this check in the code-explorer brief for a Git repository with a GitHub remote:

```bash
gh pr list --state open --json number,title,headRefName,files --limit 20
```

Intersect returned PR files with discovered paths. Report **competing in-flight work**
with PR number, title, head branch, and overlapping paths. Record command failures or
listing limits as unresolved coverage, rather than claiming no overlap. Carry competing
work through Phase 0b and later plan inputs; interactive corvus surfaces it before planning.
Done when overlap evidence or an explicit coverage gap is included in the findings.

### 1a. External Research (researcher)

```markdown
**TASK**: Research <external questions in DISCOVERY_SCOPE> using your Complexity Router.
**DISCOVERY_ORIGIN**: <forward the validated envelope value unchanged>
**RETURN_TARGET**: <forward the validated envelope value unchanged>
**CONTEXT**: <request, selected depth, EXISTING_FINDINGS, technologies and constraints>
**SCOPE**: Read-only investigation of unanswered questions; your research workflow owns tools and fallback.
**REPORT BACK**: Cited findings, recommendations with rationale, risks, and unresolved questions.
```

Use researcher for research mechanics rather than copying them.
Done when cited evidence or explicit gaps cover the assigned external scope.

### 1b. Codebase Investigation (code-explorer)

```markdown
**TASK**: Investigate <codebase questions in DISCOVERY_SCOPE> without edits.
**DISCOVERY_ORIGIN**: <forward the validated envelope value unchanged>
**RETURN_TARGET**: <forward the validated envelope value unchanged>
**CONTEXT**: <repository, selected depth, relevant areas, EXISTING_FINDINGS>
**SCOPE**: <unanswered delta; include Concurrent-Work Check and depth-specific scans above>
**REPORT BACK**: file:line evidence; affected paths and seams; entry points and consumers;
patterns; dependencies; risks; project environment and scripts; competing in-flight work;
applicable ADRs and process learnings; unresolved questions.
```

Done when repository evidence or named blockers cover the assigned codebase scope.

## Completion Payload

Return one payload to `RETURN_TARGET`:

```markdown
**DISCOVERY_ORIGIN**: <unchanged from dispatch>
**RETURN_TARGET**: <unchanged from dispatch>
**NEW_FINDINGS**: <findings from this invocation>
**ACCUMULATED_FINDINGS**: <EXISTING_FINDINGS merged with NEW_FINDINGS, deduplicated>
**COMPETING IN-FLIGHT WORK**: <overlapping PRs and paths, none, not applicable, or coverage gap>
**UNRESOLVED_SCOPE**: <remaining questions, or none>
```

For `PHASE_0A`, return `ACCUMULATED_FINDINGS` to Phase 0b for analyst `POST_DISCOVERY`.
For `DIRECT_CALLER`, return the payload to the original caller and stop.
Phase 1 never invokes task-planner; the caller owns subsequent workflow routing.
Done when scope is answered or listed in `UNRESOLVED_SCOPE` and the payload reaches its target.

---
name: corvus-phase-5
description: Final validation - comprehensive objective and subjective checks
---

# Phase 5: Final Validation

Run 5a after every implementation phase has closed through
[Phase 4](../corvus-phase-4/SKILL.md); run 5b when required below. Use PLAN.md's acceptance
criteria, immutable requirements, Gates evidence, and dispatch-ownership history.
Test policy is owned by [Phase 2 Tests](../corvus-phase-2/SKILL.md#tests).

## 5a: Objective Validation

Dispatch code-quality for the entire feature. For deferred, this is the single full-suite
run: resolve the project's full test command from AGENTS.md and current scripts, including
required environment prefixes and prerequisites. For none, verify all acceptance criteria
with concrete evidence and regression review; acceptance-only is a complete validation mode.
Honor narrower caller restrictions; unresolved conflicts hold the gate rather than silently
omitting required evidence or widening permissions.

For cross-package changes, use the runner's verified cache-defeating option so the full
suite actually executes. Label a cached replay `CACHED REPLAY`; it is not fresh gate evidence.
<!--
Final-evidence oracle: selected Tests policy, current project instructions, final workspace
bytes, and actual check output, read before the verdict. Missing required output, stale
evidence, cached replay in place of a fresh run, or unmet criteria hold completion. None
selects acceptance evidence; it never disables the gate. Later edits invalidate affected evidence.
-->

```markdown
**TASK**: Perform Phase 5a final objective validation for <feature>.
**Repository**: <canonical user-repository root>
**Plan**: <absolute PLAN.md path>
**Tests**: <selected policy>
**Scope**: Entire feature; all acceptance criteria, immutable requirements, and regressions.
**Evidence**: <phase reports, Gates pointers, task ownership, actual changed paths>
**Authorized Validation**: <environment-resolved final checks and prerequisites, narrowed by policy>
**Not Run By Policy**: <excluded commands with the controlling policy>
**Report Back**: 5a OBJECTIVE GATE STATUS: PASS / FAIL; mode (DEFERRED TEST RUN or
ACCEPTANCE-ONLY); every command with actual output and freshness evidence; criterion/status/
evidence rows for all criteria; regressions and remaining issues attributed to task IDs;
policy omissions; scoped fix requirements on FAIL.
```

- PASS: proceed to 5b when required, otherwise Phase 6.
- FAIL: dispatch task-planner `AMEND_PLAN add-fix-tasks` per corvus-phase-7 §AMEND_PLAN Dispatch with plan path, phase, task lines,
  and the 5a gate-report pointer ([mode](../../agent/task-planner.md#amend_plan)); return
  to Phase 4's frontier of fixes and its gates, then rerun 5a. This failed-final-gate recovery
  authorizes another full run under deferred, not extra suite runs during Phase 4.
Done when an evidenced objective PASS selects the next step or attributed failures return
to Phase 4; a blocked evidence contract holds finalization.

### Pre-Delivery Adversarial Sweep

Include this final payload in the code-quality 5a dispatch; feature-scoped, not a repo-wide audit:
1. Grep every doc/docblock claim introduced by this feature quoting a value, default, count, or behavior; compare it with its source.
2. Trace every new signal introduced by this feature from producer to every consumer.
3. Diff every stated default introduced by this feature against the actual default.
Done when code-quality reports evidence for all three checks; findings fail 5a and require scoped recovery plus mechanical rechecks before PASS.

## 5b: Subjective Validation

Flag UX/DX review with `[ux]` on a task line, for example `T3 — [ux] <behavior>`; task-planner
records the tag when planning or adding tasks. Any tagged task requires one feature-level
ux-dx-quality review after 5a PASS, covering applicable UI, API, docs, and architecture.

```markdown
**TASK**: Perform Phase 5b final UX/DX review for <feature>.
**Repository**: <canonical user-repository root>
**Plan**: <absolute PLAN.md path>
**Review Tasks**: <tagged task lines and focus areas>
**Scope**: All user-facing and developer-facing changes; <5a PASS evidence pointer>.
**Assessment**: Review subjective quality and consistency; report issues without editing.
Use ux-dx-quality's assessment modes and scoring; avoid repeating 5a's objective checks.
**Report Back**: Emit exactly one 5b SUBJECTIVE GATE STATUS with one allowed bare token;
Scored Evidence for every required dimension (or N/A with reason); Top 3 Strengths;
Blocking Issues with evidence and required fixes (or None); Non-Blocking Recommendations
with evidence and expected benefits (or None); Detailed Assessments for applicable modes.
```

Accept these verdicts, using ux-dx-quality's scoring thresholds:
- `PASS`: every required dimension meets the pass threshold, with no blocking issues → Phase 6.
- `NEEDS_IMPROVEMENT`: non-blocking recommendations only → carry them to Phase 6 and proceed.
- `CRITICAL_ISSUES`: dispatch task-planner `AMEND_PLAN add-fix-tasks` per corvus-phase-7 §AMEND_PLAN Dispatch with plan path, phase,
  task lines, and the 5b gate-report pointer; Phase 4, then rerun both 5a and 5b.

<!--
Subjective oracle: tagged plan tasks and the complete scored report, read before advancing.
Missing/malformed status or required sections block completion. Unmet immutable acceptance
criteria, security failures, or critical usability failures force the critical-issues path
regardless of score. Only absence of tagged tasks disables this review, never its consumer checks.
-->
Apply [child transport recovery](../corvus-phase-4/reference/transport-retry.md) to malformed
or missing child reports in either step; exhausted 5b recovery remains fail-closed and
escalates the contract error. Record final evidence for the Phase 6 handoff; that phase
alone owns success extraction.
Done when a conforming non-blocking verdict reaches Phase 6, scoped critical fixes return
to Phase 4, or an unresolved contract error holds completion.

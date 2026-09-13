---
id: ADR-0001
status: accepted
date: 2026-09-09
scope:
  - agent/task-planner.md
  - agent/requirements-analyst.md
  - agent/plan-reviewer.md
  - agent/corvus.md
  - agent/corvus-auto.md
  - skill/corvus-phase-*/SKILL.md
  - skill/corvus-review-r2/SKILL.md
  - agent/pr-code-reviewer.md
  - agent/security-reviewer.md
  - src/__tests__/prompt-structure.test.ts
  - prompt-budgets.json
  - docs/CORVUS-STATE-MACHINE.md
---

# ADR-0001: One adaptive plan, decision records instead of dense task files

## Context and Problem

Planning today asks the user to pick a plan type — Lightweight, Standard, Spec-Driven, or
No Plan — from a 16-point rubric (`agent/requirements-analyst.md:116-143`), then runs a
1,490-line `agent/task-planner.md` whose 810 lines (54%) sit in fenced output templates: 2
MASTER_PLAN variants, 2 task-file variants, a test-task variant, 3 spec variants, plus a
14-rule "Authoring Integrity" list at `:74-160`. It emits per-task files with 10 mandated
H2s, then a mandatory multi-round Phase 3.5 review (`agent/plan-reviewer.md` 493 lines +
`skill/corvus-phase-2/SKILL.md` 329 = 822, across 6 files: 3 verdict tiers, category A/B/C
findings, changed-lines manifests, a 2-REJECT budget with a one-time carve-out). The triad
`tests_enabled`/`tests_deferred`/`test_scope` appears 440 times across 17 files, 281 in
`agent/` and `skill/` prompts.

- **The taxonomy carries almost no payload** — task-count hints, skip Phase 1
  (Lightweight), skip Phase 5 (Lightweight unless tests deferred), an optional specs
  layer (Spec-Driven). The planner already overrides it: `task-planner.md:68-70,100-108`
  calls its budget "a HARD apparatus budget, not a plan-type hint."
- **Cost is documented in-repo.** `task-planner.md:107` records 2,871 planning lines for
  a 13-line functional diff — remediated by adding rule 5, not by removing apparatus.
  That rule-per-incident pattern is why the prompt is 1,490 lines.
- **Field runs repeat it.** Session logs record 1,899 planning lines for a 12-file diff
  (309-line MASTER_PLAN, 17 task files averaging 86 lines, plus CONTEXT), ≈39% task-file
  boilerplate, 17 "Validation Commands" blocks encoding 3 unique commands; another run
  produced a 4,386-line MASTER_PLAN and 112 task files. `.corvus/` is untracked:
  external observations, not reproducible here.
- **Mirrors drift.** `docs/CORVUS-STATE-MACHINE.md` still calls Phase 3.5
  optional (`:7`, `:98`, `:719`) while both orchestrators make it mandatory.
- **Prose is frozen.** `src/__tests__/prompt-contracts.test.ts` is 5,393 lines with 274
  assertions pinning exact strings including line-wrap positions, `:2534` pins template
  duplication (`toBe(2)`), and its spec `prompt-modernization/specs/frozen-contracts.md` is gone.
- **The "why" has no home.** `learnings.md` entries are ADR-shaped in substance (claim +
  evidence + rejected alternative) but carry no id, status, scope, or supersession. Three
  prompt sites — `agent/task-planner.md`, `agent/code-implementer.md`,
  `skill/corvus-phase-7/SKILL.md` — assume ADRs exist in the user's repo, yet none is written.
- **An external reference point exists.** [mattpocock/skills](https://github.com/mattpocock/skills)
  runs idea → grill → spec → tickets → implement → review in 37 skills of median 74 lines
  (largest 140; `implement` is 15): execution prompts shrink when the plan artifact is good.

The environment moved too. Frontier tools converged on one editable model-drafted plan plus
one human gate, no taxonomy and no automated review loop:
[Cursor](https://cursor.com/blog/dynamic-planning-agents), [Claude Code](https://code.claude.com/docs/en/common-workflows), [Amp](https://ampcode.com/manual), [OpenCode](https://opencode.ai/docs/agents/);
even [spec-kit 1.0](https://github.com/github/spec-kit) reframed around adaptability. Long
instruction lists degrade adherence
([Chroma, Context Rot](https://research.trychroma.com/context-rot); [Anthropic, Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
on "right altitude" and a finite attention budget), and 50%-time-horizons outgrew METR's
16-hour suite ([METR](https://metr.org/time-horizons/)), so pre-chewed task files buy less.
ADRs re-emerged as agent-facing context because agents delete constraints whose reason they
cannot see
([clearly.sh](https://www.clearly.sh/decision-records-for-ai-agents); [AgDR](https://github.com/me2resh/agent-decision-record); [braingrid](https://www.braingrid.ai/blog/architecture-decision-records-for-ai-coding-agents)).

## Considered Options

1. **Keep the taxonomy, prune prompts** — shrink `task-planner.md`, keep 3 plan types and
   the review loop. Rejected: the payload is 2 skip rules plus specs, and every past
   pruning regrew via the rule-per-incident pattern at `:74-160`.
2. **Spec-kit / Kiro style** — formal spec → plan → tasks pipeline. Rejected: heavier than
   today, the community now right-sizes it away, and it fails the review-cost test —
   reviewing the artifacts costs more than reviewing the diff
   ([astro2049](https://astro2049.com/blogs/pomptmaster/when-spec-driven-development-is-overkill-and-how-to-right-size-it)).
3. **Ephemeral plan, no artifact (Amp-style)** — Rejected: Corvus resumes across sessions
   and dispatches parallel implementers, needing a persistent, git-trackable plan.
4. **One adaptive plan + decision records** — chosen; see below.

## Decision

- **One plan artifact**, `PLAN.md` per feature, replacing `MASTER_PLAN.md` + `NN-*.md` + `CONTEXT.md` + `specs/` as planning artifacts.
  `DISCOVERY.md` is a non-plan companion holding discovery evidence so sessions resume without re-discovery; discovery paths live there, not in the plan.
  Depth is one model-chosen line — `depth: quick | standard | deep`, from blast radius × ambiguity × repo familiarity — shown at the single approval gate where the user may override it. No plan-type question is asked.
  Depth is an effort dial, never a skip: `quick` = narrow discovery and a terse plan; `standard` = default; `deep` = wider discovery plus a mandatory check of the plan against every ADR whose `scope` it touches.
  Every depth runs Phase 1 discovery, the plan-review loop, the per-phase 4b gate, and Phase 5.
  Because the taxonomy's payload is two skip rules, and every surveyed tool lets depth emerge from one scaling artifact. A skip is a taxonomy in disguise, and the review loop is cheap relative to a wrong plan.
<!-- adapted from mattpocock/skills (MIT) -->
- **Tasks are vertical slices**: each cuts "a narrow but COMPLETE path through every layer" it
  touches (`to-tickets/SKILL.md:31`), is demoable or verifiable on its own, and fits one fresh
  context window. Tasks declare `blocks:` edges; Phase 4 works the **frontier** — every
  unblocked task in parallel — replacing planner-assigned workstream tags, and wide refactors
  sequence expand–contract instead. Because edges plus context sizing are what parallel dispatch
  consumes; tags cached them by hand.
<!-- adapted from mattpocock/skills (MIT) -->
- **No file paths or code snippets in the plan**: PLAN.md names behaviors and seams — "Do NOT
  include specific file paths or code snippets. They may end up being outdated very quickly."
  (`to-spec/SKILL.md:55`). File ownership for parallel implementers is resolved at Phase 4
  dispatch time and recorded in `## Log` as history. Because paths rot before the plan is
  executed, and history cannot go stale. The same rule drops "Validation Commands" blocks: the
  environment (`AGENTS.md`, package scripts) answers that in one lookup, and "a document that
  restates it is a **cache**" (`writing-for-agents/SKILL.md:79`).
<!-- adapted from mattpocock/skills (MIT) -->
- **Decision records** live in the *user's* repo at `docs/decisions/NNNN-slug.md` (MADR-minimal
  plus this directory's frontmatter). The planner writes one only when **all three** hold
  (`domain-modeling/SKILL.md:68-72`): "Hard to reverse", "Surprising without context", "The
  result of a real trade-off"; any one missing, no ADR. The plan links them by id, the reviewer
  checks the plan against ADRs whose `scope` it touches, `AGENTS.md` points here, and
  `learnings.md` keeps Corvus-process learnings only. Because the "why" is the expensive
  knowledge nothing else stores, and a per-feature plan is the wrong place to keep it.
- **Plan review is a loop**: the reviewer (a different model from the planner where configured — the collision is the point; a same-model review proceeds with a visible degraded warning because a default install has one model) returns `OK`, or `REJECT` plus a flat list of concrete fixes (line ref → replacement).
  `REJECT` → one `PLAN_FIX` → automatic re-review of the whole plan. The loop runs until `OK` at every depth; it has no round cap and no skip.
  Stall guard: after each `PLAN_FIX`, when a re-review returns the same fixes as the previous round, stop the loop and take the residual list to the user at the gate, not as `OK`.
  Verdict tiers, finding categories, changed-lines manifests, REJECT budgets, and carve-outs are removed; one rule is retained — *if execution diverges from the approved plan, stop and re-plan.*
  **Calibration**: a finding is a defect only when it would change execution outcome — an orphaned requirement, an unowned file or surface, a wrong count or reference, a sequencing hazard, an unverifiable done-when, or a contradiction of an ADR in scope. Wording, style, and preference are not findings.
  Because cross-model review catches defects the planner cannot see: in user-reported field runs, the v2 plan needed a fix-located re-review and this feature's plan drew 14 concrete fixes on round 1; the removed apparatus is what cost the lines.
  The industry converged on one human gate ([Cursor](https://cursor.com/blog/dynamic-planning-agents), [Claude Code](https://code.claude.com/docs/en/common-workflows)); Corvus deliberately diverges by keeping the automated loop because its planner and reviewer are different models.
- **Test flags collapse** to `tests: deferred | none`, default `deferred`, full suite at final
  validation. Because the non-deferred path was never selected in practice and cost 440
  replication sites.
- **The prompt freeze is retired**: delete `prompt-contracts.test.ts` and replace it with a
  small structural contract — frontmatter keys, required section headings, dispatch keywords,
  v1/v2 agent-name parity. Because byte-pins on prose block every prompt improvement, and the
  spec that justified them is lost.
- **Retained as load-bearing**: the `**Status**:` line for cross-session resume; the immutable
  user-requirements section; the per-phase 4b gate and Phase 5 full suite; one batched progress
  update per phase; disjoint file sets across parallel implementers; corvus-auto as a
  same-skeleton mirror. Because dropping any one costs a recovery path: resume state,
  requirement fidelity, gate coverage, or write isolation.
<!-- adapted from mattpocock/skills (MIT) -->
- **Scope**: the same change set reworks `corvus-review-r2` into a two-axis review — Standards
  and Spec as parallel children, a pasted Fowler smell baseline, sub-agent briefs under 400
  words, findings never merged or reranked across axes (`code-review/SKILL.md:11,38,64,76`). It
  earns its own ADR only if planning surfaces a decision passing the three-condition gate.
  Because the user chose to include it, and the rework does not itself clear "hard to reverse".
- **Budget targets**: `task-planner.md` ≤ 250 lines; `plan-reviewer.md` ≤ 150; Phase 3.5
  machinery ≤ 40 lines total; planning corpus for a 12-file feature ≤ 150 lines. Because a
  stated budget is the check that stops the cut regrowing rule by rule; the loop rules fit in a paragraph.

## Consequences

**Good**: planning time collapses; fewer mirrors to drift; the durable "why"
survives sessions; prompts become editable again.

**Bad**: a one-time migration of orchestrator and skill prompts plus the state-machine
doc; existing `.corvus/tasks/*/MASTER_PLAN.md` plans stay readable but resume logic must
accept both `MASTER_PLAN.md` (legacy) and `PLAN.md`; loss of byte-level prompt regression
detection; ADR discipline can rot if over-applied — mitigated by the three-condition gate
(hard to reverse, surprising without context, a real trade-off; all three required); each plan costs at least two model dispatches (plan + review), more on REJECT.

**Neutral**: no runtime (`src/`) changes except tests; No-Plan direct delegation unchanged.

## Verification

- `wc -l agent/task-planner.md` ≤ 250
- `grep -c "LIGHTWEIGHT\|SPEC_DRIVEN" agent/*.md skill/*/SKILL.md` = 0
- `test ! -f src/__tests__/prompt-contracts.test.ts`; a structural prompt test passes
- `docs/decisions/` is referenced from `AGENTS.md`
- `grep -rn "Validation Commands" agent/ skill/` = 0
- the planner's PLAN.md task template carries no ownership field: `grep -c "files:" <produced PLAN.md ## Tasks section>` = 0

## Appendix: target `PLAN.md`

````markdown
# Plan: status-json-output

**Status**: [ ] Planning | [~] In Progress | [x] Complete
**Depth**: standard — 3 files, one new output path, existing CLI patterns apply
**Tests**: deferred
**Source**: issue #214

## Intent
`corvus status` prints a human table only, so CI scrapes stdout. Add `--json` emitting one object, leaving the human path byte-identical.

## User Requirements (Immutable)
- `--json` writes a single JSON object to stdout and nothing else
- exit codes unchanged
- human output byte-identical when `--json` is absent

## Acceptance Criteria
- [ ] `corvus status --json | jq .phase` returns the current phase
- [ ] `corvus status` matches the 0.9.0 output snapshot
- [ ] the flag and its envelope are documented in the CLI reference

## Decisions
- [ADR-0004](0004-status-json-envelope.md) — flat envelope, not nested per-phase

## Fog of War
- whether CI consumers need the envelope versioned; unticketable until one asks

## Tasks
- [ ] T1 — `--json` emits the whole envelope through the existing status-render seam — blocks: T2, T3 — done when: `corvus status --json | jq .phase` returns the current phase
- [ ] T2 — absent flag leaves the human table byte-identical — blocks: none — done when: `corvus status` matches the 0.9.0 snapshot
- [ ] T3 — document the flag and envelope in the CLI reference — blocks: none — done when: the flag and a field table for every envelope key are present

## Gates
P1 4b: PASS 2026-09-09 — typecheck and lint clean, see session log

## Log
- 2026-09-09 approved at gate, depth kept at standard
- 2026-09-09 P1 dispatched T1,T2 as ws-A (files: src/cli/status.ts, src/cli/types.ts), T3 as ws-B (docs/CLI.md)
````

## Amendment 2026-09-13: planning records are committed

> `.corvus/` is committed to the repo by default — if we don't commit it we lose track of the files, changes and intent behind what has been built; it's as if we didn't commit the ADRs. Users who want corvus local can only run reviews locally. This repo (corvus itself) is the exception.

- **Decision:** Plans, discovery companions, ledgers, and review state under `.corvus/tasks/<feature>/**` are committed project memory by default, alongside the work, because uncommitted intent is lost just as an uncommitted ADR loses its rationale. This supersedes the three-condition "ADRs in the user's repo" gate as a condition for preserving planning records: these records are always committed, whether or not a separate ADR qualifies for creation. Keeping `.corvus/` local is supported for local reviews only, not planning or implementation; this is distinct from deferring Git delivery to the user. The Corvus repository itself is the sole exception, with `.corvus/` in its parent workspace and `.gitignore` retaining the exclusion here.

---
id: ADR-0002
status: accepted
date: 2026-09-09
scope:
  - agent/*.md
  - command/*.md
  - skill/*/SKILL.md
  - AGENTS.md
---

# ADR-0002: Prompt authoring standard

## Context and Problem

The prompt corpus is 38 files and 13,762 lines: 16 agents (8,036), 18 skills (5,197), 4
commands (529). The two largest are `agent/task-planner.md` at 1,490 lines and
`skill/corvus-phase-4/SKILL.md` at 744.

- **Rules are restated across mirrors.** The test-flag triad
  `tests_enabled`/`tests_deferred`/`test_scope` occurs 440 times across 17 files, 281 in
  `agent/` and `skill/`; `MASTER_PLAN` 107 times across 10 prompt files; the Phase 3.5
  dispatch template is written twice, at `skill/corvus-phase-2/SKILL.md:226` and
  `agent/corvus.md:379-391`, the former calling itself "the canonical sender template ...
  keep the two in sync" — a mirror the prompt admits it hand-maintains.
- **Prohibition load is real, but not where it looks.** `grep -c "MUST NOT" agent/*.md
  skill/*/SKILL.md` totals **24** lines across 12 of 38 files, peaking at 6 in
  `skill/corvus-phase-4/SKILL.md` — not a list per dispatch template. The load sits in
  softer negation: `MUST NOT`, `do not`, `never` occur 548 times across 34 of 38 files.
- **The rule exists; nothing enforces it.** `AGENTS.md:11`: "state each rule once ...
  drifted duplicates read as contradictions" — prose, not a check.
- **Growth is incident-driven.** `agent/task-planner.md:74-160` accreted 14 "Authoring
  Integrity" rules one per incident; ADR-0001 cuts these prompts, then they regrow.

Long instruction lists degrade adherence
([Chroma, Context Rot](https://research.trychroma.com/context-rot);
[Anthropic, Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
on "right altitude" and a finite attention budget); for the Pocock corpus datum see
ADR-0001 §Context.

## Considered Options

1. **Keep the `AGENTS.md` style guide only** — Rejected: unenforced and already violated
   inside its own corpus (`AGENTS.md:11` against 440 triad sites).
2. **Byte-pin prompts in tests** — today's 5,393-line `prompt-contracts.test.ts`. Rejected:
   it pins strings down to line-wrap positions, so prompt improvement fails tests; ADR-0001
   retires it.
3. **An explicit authoring standard with structural tests and line budgets** — chosen,
   adapted from `writing-for-agents`.

## Decision

Rules adapted from `skills/productivity/writing-for-agents/SKILL.md` (cited as `SKILL.md`)
and its `SKILL-MECHANICS.md`; each quotes its source, then binds Corvus.

<!-- adapted from mattpocock/skills (MIT) -->
- **Hunt no-ops** — "an instruction the model already obeys by default pays load to say
  nothing" (`SKILL.md:81`). Delete it, whole sentences at a time. Because a retained no-op
  spends attention budget and buys no behavior change.
- **Phrase positively** — "A prohibition earns its place only as a hard guardrail you
  cannot phrase positively" (`SKILL.md:74`). State the wanted behavior; keep a prohibition
  only for irreversible actions, data loss, secrets, or publishing, each with a one-line
  justification comment. Because negation "drags the forbidden behaviour into context and
  makes it _more_ available, not less" (`SKILL.md:74`).
- **One authoritative location, pointers elsewhere** — "Keep each meaning in a **single
  source of truth**" (`SKILL.md:78`). Every rule lives once; other sites carry a pointer
  (`see <skill> §<section>`), never a restatement. Dispatch templates live in the skill and
  agents point at them. Because 440 triad sites and a hand-synced Phase 3.5 template are
  the maintenance a pointer removes.
- **Disclose by branch** — "inline what every branch needs, and push behind a pointer what
  only some branches reach" (`SKILL.md:39`). Branch-specific material moves to a sibling
  reference file loaded on demand. Because always-loaded material sits in context every
  turn, "spending tokens and attention whether or not it fires" (`SKILL.md:24`).
- **End every procedure with "done when"** — "Every step ends on a **completion
  criterion**, the condition that tells the agent the work is done" (`SKILL.md:47`). Because
  a fuzzy bound invites premature completion and an absent one invites work past the end.
- **Cache nothing the environment answers** — a document restating the environment "is a
  **cache**: a copy of a lookup, earning its load only when the lookup is expensive"
  (`SKILL.md:79`). Commands, paths, and versions stay in `AGENTS.md` and package scripts,
  because a cached lookup goes stale where the environment cannot.
- **Compose instead of duplicating** — a router skill "names the others and when to reach
  for each" (`SKILL-MECHANICS.md:22`). Corvus binds one skill per `skill()` call; a composite
  step is a short wrapper skill, not repeated prose. Because a wrapper keeps one copy of the
  steps where inlining forks them per caller.
- **Coin leading words once** — a leading word is "Repeated as a token, never as a
  sentence" (`SKILL.md:63`). Define *frontier*, *slice*, and *gate* once, then reuse the
  token. Because one token retires the spelled-out triads that inflate these files.
- **Line budgets** — orchestrator agents ≤ 300 lines; every other agent ≤ 200, except
  task-planner ≤ 250 because it owns the canonical plan template (≤150 lines of it); every
  `SKILL.md` ≤ 150 with sibling reference files ≤ 200 each; the whole corpus ≤ 5,000 lines,
  from 13,762. The corpus cap binds before the per-file ceilings, whose sum exceeds 6,000.
  Because length degrades adherence (Chroma, Anthropic) and Pocock's corpus fits the budget.
- **Enforce shape, not bytes** — one structural test replaces the byte-pins: frontmatter
  keys per file class, required section headings per agent class, the budgets above, a
  per-file `MUST NOT` ceiling of 5, and a "stated once" check over a short canonical-phrase
  list. The ceiling is 5 because it sits one below today's worst file (6 in
  `skill/corvus-phase-4/SKILL.md`), biting there alone while blocking regrowth. Because a
  shape test lets prose improve while structure cannot regress.

## Consequences

**Good**: one place to change any rule; drift becomes a test failure instead of a
contradiction; prompts shrink to a length models follow.

**Bad**: a one-time rewrite of all 38 files; safety-critical prohibitions survive but each
now needs an explicit justification comment; the 150-line `SKILL.md` budget likely forces
splitting `skill/corvus-phase-4/SKILL.md` (744) into a skill plus reference files.

**Neutral**: no runtime (`src/`) change beyond replacing the prompt test.

## Verification

- the structural prompt test passes
- `cat agent/*.md command/*.md skill/*/SKILL.md | wc -l` ≤ 5,000; no file over its budget
- `grep -c "MUST NOT"` ≤ 5 for every file in `scope`

## Attribution

Rules above are adapted from [mattpocock/skills](https://github.com/mattpocock/skills)
(MIT, © 2026 Matt Pocock). Every prompt or doc carrying adapted text includes a one-line
`<!-- adapted from mattpocock/skills (MIT) -->` comment at the passage. Open item, not
decided here: whether the notice ships as a `LICENSE` appendix or a `NOTICE` file.

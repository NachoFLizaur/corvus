# Decision Records

<!-- adapted from mattpocock/skills (MIT) -->
Architecture Decision Records for Corvus. A decision belongs here only when **all
three** hold: it is **hard to reverse** (the cost of changing your mind later is
meaningful), **surprising without context** (a future reader will wonder "why did
they do it this way?"), and **the result of a real trade-off** (genuine
alternatives existed and one was picked for specific reasons). If any of the three
is missing, skip the ADR: routine choices any competent implementer would make the
same way, library picks with no live alternative, and naming or formatting
conventions stay out. Process learnings about how Corvus itself plans and executes
belong in `.corvus/tasks/learnings.md`; that file records how the system behaves,
an ADR records what the system decided and why.

## Naming and lifecycle

- Filename `NNNN-kebab-slug.md`, zero-padded, assigned in order.
- Once `status: accepted`, the record is **immutable**. Never rewrite an accepted
  ADR to describe a newer decision.
- Change an accepted decision by adding a new ADR carrying
  `supersedes: ADR-NNNN`, then setting `superseded_by:` on the old record. That
  pointer is the only permitted edit to an accepted ADR.

## Frontmatter

```yaml
---
id: ADR-0001                 # ADR-NNNN, matches the filename
status: proposed             # proposed | accepted | superseded | rejected
date: 2026-09-09             # ISO 8601; date of the current status
scope:                       # path globs this decision constrains
  - agent/task-planner.md
  - skill/corvus-phase-*/SKILL.md
supersedes: ADR-0000         # optional
superseded_by: ADR-0002      # optional
---
```

## Body template

Adapted from
[MADR-minimal](https://github.com/adr/madr/blob/develop/template/adr-template-minimal.md),
shortening its `Context and Problem Statement` to `Context and Problem` and its
`Decision Outcome` to `Decision`:

- `## Context and Problem` — the forces, with evidence: `file:line` for in-repo
  facts, inline markdown links for external ones.
- `## Considered Options` — every option actually weighed, each with the reason
  it was rejected.
- `## Decision` — what was chosen. Every claim carries a **because** clause.
- `## Consequences` — `Good` / `Bad` / `Neutral`.
- `## Verification` — optional: a command or check that proves conformance.

## Agents

`task-planner` and `plan-reviewer` MUST read this directory before planning or
reviewing changes that touch any ADR's `scope`; `AGENTS.md` points here.

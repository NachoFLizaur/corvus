---
name: deep-research
description: Deep research methodology for complex technical questions requiring comprehensive analysis. Loaded by the researcher's complexity router for comparative analysis, architectural decisions, and multi-faceted topics.
---

# Deep Research Methodology

Use the researcher Complexity Router
to select this branch. It covers multi-source investigation, including technology
evaluation and complex debugging.

## Workflow

<!-- adapted from mattpocock/skills (MIT) -->
1. **Plan** — restate the question, constraints, key dimensions, query strategy, and
   expected source types. Done when each dimension has a research angle.
2. **Search** — use `web-research_multi_search` with 5-10 queries covering at least
   three angles: supporting and contrary evidence, recent developments, and production
   experience. Use the current year where useful. Done when results cover the planned
   angles or a tooling limitation is recorded.
3. **Read** — use `web-research_fetch_pages` for all unique, relevant URLs, including
   contrasting viewpoints. Prioritize official docs, technical blogs, Stack Overflow,
   then forums. Done when promising full pages have been read or access gaps recorded.
4. **Synthesize** — apply Evidence Quality below and the researcher's
   Evidence Discipline (owner pointer: `../../agent/researcher.md#evidence-discipline`; informational, no file read).
   Done when consensus, conflicts, and missing evidence are distinguished.
5. **Report** — extend the researcher's Output Format (owner pointer: `../../agent/researcher.md#output-format`; informational, no file read),
   starting with its TL;DR. Add Detailed Analysis by dimension, Conflicting Information
   with resolutions, and Research Gaps feeding `UNRESOLVED_SCOPE`.
   Done when the Quality Checklist is satisfied or each shortfall is explained.

## Evidence Quality

For each source, extract its claims, supporting data or experience, recency, author
context, and conflicts. Weigh evidence quality when resolving disagreements; show
both claims with citations and explain any unresolved difference.
Read full pages, seek disconfirming evidence, and diversify source types. Balance
current developments with established practices and calibrate confidence to evidence.

## Branch Analysis

- **Comparison Table**: for comparative questions, assess each option against the same
  criteria, including complexity, performance, and maintenance; tie the choice to constraints.
- **Architecture**: explain the proposed structure and each consequential trade-off.
- **Debugging**: trace the reported failure to its origin before proposing a fix.

## Quality Checklist

- [ ] 10+ unique sources consulted and cited.
- [ ] 500+ words of synthesis, excluding code blocks and tables.
- [ ] Evidence Discipline and Evidence Quality applied, with confidence levels
      (High/Medium/Low) for key claims and the overall recommendation.
- [ ] Relevant Branch Analysis included; recommendation gives an actionable next step.

Explain every unmet item in the report. Done when the query budget is exhausted or
the checklist is met; synthesize the available evidence and make remaining gaps explicit.

## Fallback Behavior

Follow the researcher's Three-Tier Fallback Chain (owner pointer: `../../agent/researcher.md#three-tier-fallback-chain`; informational, no file read).
When tooling limits coverage, explain checklist shortfalls, including fewer sources,
and mark the resulting gaps as unresolved. Done when the degraded report makes its
incompleteness explicit.

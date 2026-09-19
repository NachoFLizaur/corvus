---
name: web-search
description: Quick web search methodology for focused factual lookups. Loaded by the researcher's complexity router for simple questions requiring 1-3 targeted queries.
---

# Quick Web Search Methodology

Use the researcher Complexity Router (owner pointer: `../../agent/researcher.md#complexity-router`; informational, no file read)
to select this branch, including focused version/compatibility and error-message lookups.

## Workflow

<!-- adapted from mattpocock/skills (MIT) -->
### Step 1: Formulate Queries

Use `web-research_multi_search` for 1-3 targeted queries with specific technical terms,
relevant versions, and verbatim error messages. Vary the angle only where useful.
Done when results address the question or a tooling limitation is recorded.

### Step 2: Scan Snippets

Identify 2-3 relevant URLs from titles and snippets. Prioritize official documentation,
then well-supported answers, known technical authors, and GitHub issues/discussions.
Done when the answer is supported by snippets or promising pages are selected.

### Step 3: Fetch Top Pages

Use `web-research_fetch_pages` for selected pages where snippets leave gaps; fetch at
most 3 pages. Apply the researcher's Evidence Discipline (owner pointer: `../../agent/researcher.md#evidence-discipline`; informational, no file read).
Done when the direct answer is supported or an Escalation trigger below is reached.

### Step 4: Synthesize Answer

Use the researcher's Output Format (owner pointer: `../../agent/researcher.md#output-format`; informational, no file read), with a
minimal code example when useful. Done when the Quality Bar is met or unresolved
coverage is explicit under the fallback contract.

## Quality Bar

- **Sources**: 1-3 authoritative sources, cited under Evidence Discipline.
- **Length**: Typically under 300 words.
- **Confidence**: High for a clear answer; ambiguity triggers Escalation.

## Escalation to Deep Research

Escalate when the question proves more complex, answers conflict, comparison is needed,
or a complete answer needs more than 3 queries, pages, or sources. Stop quick search
and load `skill({ name: "deep-research" })`; carry findings into its methodology.
Done when the deep-research skill takes over the unresolved question.

## Fallback Behavior

Follow the researcher's Three-Tier Fallback Chain (owner pointer: `../../agent/researcher.md#three-tier-fallback-chain`; informational, no file read).
Done when the answer or tooling-limited coverage is reported under that contract.

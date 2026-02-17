---
name: deep-research
description: Deep research methodology for complex technical questions requiring comprehensive analysis. Loaded by the researcher's complexity router for comparative analysis, architectural decisions, and multi-faceted topics.
---

# Deep Research Methodology

This skill provides the methodology for comprehensive, multi-source research. Use when the complexity router classifies a question as requiring comparative analysis, architectural decisions, or multi-faceted investigation.

## When This Skill Applies

- Comparative analysis (e.g., "Prisma vs Drizzle for our use case")
- Architectural decisions (e.g., "Best auth pattern for microservices")
- Multi-faceted topics requiring synthesis from many sources
- Best practices where context and trade-offs matter
- Technology evaluations and recommendations
- Complex debugging requiring deep investigation

## Workflow

### Phase 1: Research Planning

Before searching, create a research plan:

```markdown
## Research Plan

**Question**: [Restate the question clearly]
**Type**: [Comparison | Architecture | Best Practice | Investigation | Evaluation]
**Key Dimensions**: [What aspects need to be covered?]
**Query Strategy**: [How to approach from multiple angles]
**Expected Sources**: [What types of sources will be most valuable?]
```

Plan 5-10 queries that cover:
- The core question from multiple angles
- Each dimension/aspect identified
- Contrasting viewpoints (e.g., "pros of X" AND "problems with X")
- Recent developments (include year in queries)

### Phase 2: Broad Search (5-10 queries)

Execute a comprehensive search across multiple query angles:

```javascript
web-research_multi_search({
  queries: [
    "primary question exact terms",
    "alternative framing of question",
    "aspect 1 specific query",
    "aspect 2 specific query",
    "comparison dimension 1",
    "comparison dimension 2",
    "known problems or limitations",
    "recent developments 2025 2026",
    "real-world experience production",
    "expert opinion or analysis"
  ],
  results_per_query: 8  // higher for deep research
})
```

**Query crafting rules**:
- Cover the topic from at least 3 different angles
- Include queries for both positive and negative perspectives
- Include queries for recent/current information
- Include queries for real-world experience (not just docs)
- Use 5-10 queries — fewer means insufficient coverage

### Phase 3: Deep Page Fetching

Fetch ALL promising URLs from search results (not just top 2-3):

```javascript
web-research_fetch_pages({
  urls: [
    // Fetch all unique, relevant URLs from search results
    // Typically 8-15 pages for deep research
    "url1", "url2", "url3", "url4", "url5",
    "url6", "url7", "url8", "url9", "url10"
  ],
  max_chars: 15000,  // full content for deep analysis
  timeout: 30
})
```

**Page selection rules**:
- Fetch ALL unique URLs that appear relevant (don't pre-filter aggressively)
- Prioritize: official docs > technical blogs > Stack Overflow > forums
- Include contrasting viewpoints intentionally
- Aim for 10+ unique sources

### Phase 4: Analysis & Synthesis

For each source, extract and categorize:

1. **Key claims** — What does this source assert?
2. **Evidence quality** — Is it backed by data, benchmarks, or experience?
3. **Recency** — When was this written? Is it still current?
4. **Perspective** — What's the author's context/bias?
5. **Conflicts** — Does this contradict other sources?

Build a synthesis that:
- Identifies consensus across sources
- Highlights genuine disagreements
- Notes gaps in available information
- Weighs evidence quality

### Phase 5: Structured Output

Produce a comprehensive research report following this structure:

```markdown
## Executive Summary
[2-3 sentence overview of findings and recommendation]

## Research Question
[Clear restatement of what was investigated]

## TL;DR
[Recommended approach in 1-3 sentences]
**Effort**: [S/M/L/XL]

## Detailed Analysis

### [Dimension 1]
[Analysis with citations]

### [Dimension 2]
[Analysis with citations]

### [Dimension 3]
[Analysis with citations]

## Comparison Table
| Criteria | Option A | Option B | Option C |
|----------|----------|----------|----------|
| [Criterion 1] | [Assessment] | [Assessment] | [Assessment] |
| [Criterion 2] | [Assessment] | [Assessment] | [Assessment] |

## Recommendation
**Choice**: [Recommended option]
**Confidence**: [High/Medium/Low]
**Rationale**: [Why this choice, given the evidence]

## Conflicting Information
- **[Topic]**: Source A says X ([link]), but Source B says Y ([link]). Resolution: [analysis]
- **[Topic]**: [Similar pattern]

## Research Gaps
- [What couldn't be determined from available sources]
- [Areas where more investigation would be valuable]

## Risks & Guardrails
- [Risk]: [Mitigation]
- [Risk]: [Mitigation]

## When to Reconsider
- [Trigger that would justify revisiting this decision]

## Sources
1. [Title] - [URL] - [Brief note on what it contributed]
2. [Title] - [URL] - [Brief note]
...
```

## Quality Checklist

**Every deep research report MUST meet ALL of these criteria before delivery:**

- [ ] **10+ unique sources** consulted and cited
- [ ] **500+ words** in the synthesis (excluding code blocks and tables)
- [ ] **Citations for all major claims** — no unsupported assertions
- [ ] **Conflicting information addressed** — disagreements between sources identified and analyzed
- [ ] **Confidence levels noted** — High/Medium/Low for the overall recommendation and key claims
- [ ] **Comparison table included** (for comparative questions)
- [ ] **Research gaps identified** — what couldn't be determined
- [ ] **Recency verified** — sources are current and relevant
- [ ] **Multiple perspectives represented** — not just one viewpoint
- [ ] **Actionable recommendation** — clear next step, not just information

**If any checklist item cannot be met**, note it explicitly in the report with an explanation of why.

## Anti-Patterns

- **Shallow breadth**: Searching 10 queries but only reading snippets — fetch the full pages
- **Confirmation bias**: Only searching for evidence that supports a preconceived answer
- **Source monoculture**: All sources from the same type (e.g., all Stack Overflow) — diversify
- **Recency bias**: Ignoring established best practices in favor of newest trends
- **Analysis paralysis**: Researching indefinitely — cap at 10 queries and synthesize what you have
- **Missing conflicts**: Presenting a clean narrative when sources actually disagree — surface the disagreements
- **Unsupported confidence**: Claiming "High confidence" without sufficient evidence

## Fallback Behavior

If MCP tools are unavailable or return insufficient results:
1. Fall through the three-tier fallback chain (MCP → webfetch → curl)
2. Note the degradation in the report
3. Adjust the quality checklist expectations (e.g., fewer sources acceptable if tools are degraded)
4. Be explicit about limitations: "This research was conducted with limited tooling — results may be incomplete"

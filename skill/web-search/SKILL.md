---
name: web-search
description: Quick web search methodology for focused factual lookups. Loaded by the researcher's complexity router for simple questions requiring 1-3 targeted queries.
---

# Quick Web Search Methodology

This skill provides the methodology for quick, focused web searches. Use when the complexity router classifies a question as a simple factual lookup, specific API/syntax question, or single-topic query.

## When This Skill Applies

- Simple factual lookups (e.g., "What's the default port for Redis?")
- Specific API or syntax questions (e.g., "How to use useEffect cleanup?")
- Single-topic queries with clear, direct answers
- Version/compatibility checks
- Error message lookups

## Workflow

### Step 1: Formulate Queries (1-3 queries max)

Craft 1-3 precise, targeted search queries. Each query should approach the topic from a slightly different angle:

```javascript
web-research_multi_search({
  queries: [
    "exact technical question with key terms",
    "alternative phrasing or related aspect"  // optional 2nd query
  ],
  results_per_query: 5
})
```

**Query crafting rules**:
- Use specific technical terms, not natural language
- Include version numbers when relevant (e.g., "React 19 useEffect")
- Include error codes/messages verbatim when debugging
- Max 3 queries — needing more signals deep research (see Escalation below)

### Step 2: Scan Snippets

Review the search result snippets and titles. Identify the 2-3 most relevant URLs:
- Official documentation (highest priority)
- Stack Overflow answers with high votes
- Recent blog posts from known authors
- GitHub issues/discussions

### Step 3: Fetch Top Pages (2-3 pages max)

```javascript
web-research_fetch_pages({
  urls: ["top-result-url", "second-result-url"],
  max_chars: 10000  // shorter limit for quick searches
})
```

**Page selection rules**:
- Prefer official docs over third-party
- Prefer recent content over old
- Skip pages whose snippets already answered the question
- Max 3 pages — needing more signals deep research (see Escalation below)

### Step 4: Synthesize Answer

Combine findings into a concise response following the researcher's output format:
- TL;DR (1-3 sentences)
- Direct answer with code example if applicable
- Source citations
- Effort estimate

## Quality Bar

- **Sufficient sources**: 1-3 authoritative sources
- **Answer length**: Concise — typically under 300 words
- **Citations**: Every claim backed by a source
- **Confidence**: High (clear answer found) or redirect to deep research if ambiguous

## Escalation to Deep Research

If during quick search you discover:
- The question is more complex than initially assessed
- Multiple conflicting answers exist
- The topic requires comparative analysis
- More than 3 sources are needed for a complete answer

**Stop and escalate**: Load the `deep-research` skill instead and restart with the deep methodology.

## Anti-Patterns

- **Over-researching**: A simple question needs 2-3 pages, not 10
- **Query sprawl**: Needing 5+ queries signals deep research — escalate instead
- **Skipping snippets**: Scan snippets before fetching — the answer is often already there
- **Ignoring official docs**: When official docs answer the question, stop searching

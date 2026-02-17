---
name: corvus-phase-1
description: Discovery phase - research and codebase exploration
---

## Phase 1: DISCOVERY

**Goal**: Gather all context needed for planning.

Launch these subagents **IN PARALLEL** using the Task tool:

### 1a. External Research (researcher)

Use when the task involves technologies, patterns, or best practices that benefit from external documentation.

```markdown
**TASK**: Research best practices and documentation for [specific topic]

**EXPECTED OUTCOME**:
- Relevant documentation links
- Best practice recommendations  
- Code examples from authoritative sources
- Effort estimate (S/M/L/XL)

**MUST DO**:
- Use web-research MCP tools (`web-research_multi_search`, `web-research_fetch_pages`) for web research
- Use complexity router: quick search for factual lookups, deep research for comparative/architectural questions
- Follow three-tier fallback: MCP tools → webfetch → curl
- Cite all sources with links
- Focus on [specific technology/pattern]
- Provide actionable recommendations
- Include effort estimates

**MUST NOT DO**:
- Make changes to any files
- Provide generic advice without evidence
- Skip the fallback chain if MCP tools fail

**REPORT BACK**:
- TL;DR (1-3 sentences)
- Key findings with source citations
- Recommended approach with rationale
- Potential risks or gotchas
```

### 1b. Codebase Investigation (code-explorer)

Always required to understand the target codebase.

```markdown
**TASK**: Analyze codebase to understand [relevant area/feature]

**EXPECTED OUTCOME**:
- List of files that need modification
- Existing patterns to follow
- Dependencies and constraints
- Entry points and data flow
- Project environment details (venv, package manager, build tools)

**MUST DO**:
- Use parallel search (3+ tools simultaneously)
- Provide file:line references for all findings
- Rate pattern quality where relevant
- Identify potential risks or blockers
- Detect project environment (venv, package manager, scripts)

**MUST NOT DO**:
- Make any file modifications
- Guess at implementations without evidence

**CONTEXT**: 
- Project path: [path]
- Relevant directories: [list]
- Looking for: [specific patterns/files]

**REPORT BACK**:
- Files to modify (with line references)
- Files to create
- Patterns to follow (with examples)
- Dependencies to be aware of
- Potential risks or blockers
- Project environment (venv path, package manager, available scripts)
```

**Exit Criteria**: Have both research findings AND codebase analysis (or just codebase analysis if no external research needed).

**Next Step**: Immediately invoke task-planner (Phase 2). Do NOT summarize findings and ask user for approval - the approval comes AFTER task-planner creates the plan files.

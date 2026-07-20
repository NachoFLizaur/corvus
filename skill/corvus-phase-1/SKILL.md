---
name: corvus-phase-1
description: Discovery phase - research and codebase exploration
---

## Phase 1: DISCOVERY

**Goal**: Gather the requested context once and return it to the declared caller.

## Required Dispatch Envelope

Every Phase 1 invocation includes this routing envelope:

```markdown
**DISCOVERY_ORIGIN**: [PHASE_0A | DIRECT_CALLER]
**RETURN_TARGET**: [PHASE_0B | original caller identity]
**DISCOVERY_SCOPE**: [specific unresolved questions]
**EXISTING_FINDINGS**: [accumulated research/codebase findings, or "none"]
```

Valid routes are fixed:

| `DISCOVERY_ORIGIN` | Required `RETURN_TARGET` | Meaning |
|--------------------|--------------------------|---------|
| `PHASE_0A` | `PHASE_0B` | Phase 0a requested discovery; completion must feed Requirements Analyst `POST_DISCOVERY` before selection or planning |
| `DIRECT_CALLER` | Original caller identity | A user/caller requested discovery directly; completion returns findings only, with no implicit planning |

Treat `EXISTING_FINDINGS` as already completed work. Scope researcher and code-explorer only to unanswered items; do not repeat research or code exploration already supplied to Phase 0b or the direct caller.

Launch these subagents in parallel using the Task tool:

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
- Investigate only DISCOVERY_SCOPE gaps not answered by EXISTING_FINDINGS
- Provide actionable recommendations
- Include effort estimates

**MUST NOT DO**:
- Make changes to any files
- Provide generic advice without evidence
- Skip the fallback chain if MCP tools fail
- Repeat research already present in EXISTING_FINDINGS

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
- Investigate only DISCOVERY_SCOPE gaps not answered by EXISTING_FINDINGS

**MUST NOT DO**:
- Make any file modifications
- Guess at implementations without evidence
- Repeat code exploration already present in EXISTING_FINDINGS

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

## Completion Payload

Return one payload to `RETURN_TARGET`:

```markdown
**DISCOVERY_ORIGIN**: [unchanged from dispatch]
**RETURN_TARGET**: [unchanged from dispatch]
**NEW_FINDINGS**: [research/codebase findings produced by this invocation]
**ACCUMULATED_FINDINGS**: [EXISTING_FINDINGS merged with NEW_FINDINGS, without duplicates]
**UNRESOLVED_SCOPE**: [remaining questions, or "none"]
```

| Origin | Completion action |
|--------|-------------------|
| `PHASE_0A` | Return `ACCUMULATED_FINDINGS` to Phase 0b, which invokes Requirements Analyst in `POST_DISCOVERY`. Do not select a plan or invoke task-planner from Phase 1. |
| `DIRECT_CALLER` | Return the payload to the original caller and stop. The caller decides whether any later action, including planning, is appropriate. |

**Exit Criteria**: Requested scope is answered or explicitly listed in `UNRESOLVED_SCOPE`, and the payload has been returned to the declared target. Phase 1 never invokes task-planner directly.

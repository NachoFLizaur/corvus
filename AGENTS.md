# OpenCode Custom Agents

Documentation-only repo for OpenCode agent definitions. No build/test commands.

## Style Guidelines (Markdown)
- **Files**: `kebab-case.md` in `agent/` or `command/`
- **Frontmatter**: YAML with `description`, `mode: subagent`, `temperature`, `tools`, `permissions`
- **Sections**: ALL CAPS for critical rules (e.g., `## CRITICAL RULES`), Title Case otherwise
- **Code blocks**: Use language hints (```typescript, ```bash)
- **Validation**: Use emoji checkmarks (✅ ❌) for criteria lists

## IMPORTANT: Default to Delegation

When a user request clearly matches an agent's purpose, **delegate IMMEDIATELY** without extensive pre-exploration or clarifying questions. The specialized agents are equipped to gather their own context and make appropriate decisions.

**Do NOT:**
- Manually explore the codebase before delegating
- Ask clarifying questions about scope/style when defaults are reasonable
- Treat obvious delegation tasks as "simple" to handle directly

**Examples of immediate delegation triggers:**
- "Update the README" → `@documentation`
- "Find where X is implemented" → `@code-explorer`
- "Add feature Y" → `@code-implementer`
- "Review this code" → `@code-quality`

## Available Agents

| Agent | Use For | Invoke |
|-------|---------|--------|
| code-explorer | Finding files, understanding architecture, discovering patterns | `@code-explorer` |
| code-implementer | Writing/modifying production code | `@code-implementer` |
| code-quality | Testing, code review, security audits, build validation | `@code-quality` |
| documentation | README, API docs, architecture docs, user guides | `@documentation` |
| task-planner | Breaking down complex features into subtasks | `@task-planner` |
| researcher | Technical questions, best practices, external research | `@researcher` |
| agent-generator | Creating new custom agents and workflows | `@agent-generator` |
| media-processor | Analyzing images, PDFs, diagrams | `@media-processor` |
| orchestrator | Orchestrating complex multi-step workflows | `@orchestrator` |
| requirements-analyst | Analyzing requests, identifying gaps, asking clarifying questions | `@requirements-analyst` |
| ux-dx-quality | Subjective quality: UX, DX, docs, architecture | `@ux-dx-quality` |

## When to Delegate

**Use @code-explorer when:**
- Finding files by pattern or content
- Understanding how code works
- Tracing data flow or dependencies
- Discovering existing patterns to follow

**Use @code-implementer when:**
- Writing new features (4+ lines of code)
- Modifying existing code
- Bug fixes requiring code changes
- Refactoring

**Use @code-quality when:**
- Writing tests (unit, integration)
- Reviewing code for issues
- Security audits
- Validating builds pass

**Use @documentation when:**
- Creating or updating README
- Writing API documentation
- Architecture documentation
- User guides or tutorials

**Use @task-planner when:**
- Complex features requiring multiple steps
- Work spanning 4+ files
- Need to track dependencies between tasks

**Use @researcher when:**
- "How do I..." questions
- Best practice recommendations
- Comparing approaches
- External library/API questions

**Use @agent-generator when:**
- Creating new custom agents
- Building workflow definitions
- Setting up context files

**Use @media-processor when:**
- Analyzing screenshots or diagrams
- Extracting info from PDFs
- Understanding visual content

**Use @orchestrator when:**
- Large features requiring multiple specialists
- Complex workflows with dependencies
- Need automated delegation and tracking

**Use @requirements-analyst when:**
- User request is ambiguous or incomplete
- Need to identify gaps before starting work
- Want structured clarification with priority tiers
- Orchestrator Phase 0 (automatic - usually not invoked directly)

**Use @ux-dx-quality when:**
- Evaluating user interface intuitiveness
- Assessing code readability and developer experience
- Reviewing documentation quality
- Evaluating architectural decisions
- Need subjective quality assessment beyond pass/fail

## Delegation Pattern

When delegating, provide clear context:

```
@code-explorer find all files related to user authentication,
focusing on JWT token handling and refresh logic
```

For complex delegations, use the 7-section format:
- TASK: What to do
- EXPECTED OUTCOME: Deliverables
- MUST DO: Requirements
- MUST NOT DO: Constraints
- CONTEXT: Relevant info

## Simple vs Complex Tasks

**Handle directly** (no delegation needed):
- Single file, simple changes
- Quick questions answerable from context
- Straightforward bug fixes

**Delegate to specialists**:
- Multi-file changes → @task-planner first
- Deep code analysis → @code-explorer
- Production code → @code-implementer
- Quality assurance → @code-quality

## Decision-Making Framework

When agents face trade-off decisions, apply this hierarchy:

### Priority Hierarchy

```
1. MAINTAINABILITY (Highest)
   └── Can future developers understand and modify this?
   
2. EXTENSIBILITY
   └── Can this be extended without major rewrites?
   
3. CONSISTENCY
   └── Does this follow existing patterns in the codebase?
   
4. SIMPLICITY
   └── Is this the simplest solution that works?
   
5. PERFORMANCE (Lowest)
   └── Is this fast enough for the use case?
```

### Applying the Hierarchy

When two concerns conflict, the higher-priority concern wins:

| Conflict | Resolution |
|----------|------------|
| Maintainability vs Performance | Choose maintainable code; optimize later if needed |
| Extensibility vs Simplicity | Choose extensible if future needs are clear; otherwise simple |
| Consistency vs Simplicity | Follow existing patterns even if slightly more complex |
| Simplicity vs Performance | Choose simple; optimize only with evidence of need |

### Technical Debt Policy

<critical_policy priority="999">
  NEVER create technical debt to save time.
  
  - Do NOT skip tests to ship faster
  - Do NOT use shortcuts that require "cleanup later"
  - Do NOT ignore type safety for convenience
  - Do NOT copy-paste instead of abstracting
  
  If a proper solution takes longer, take the time.
  If scope must be reduced, reduce scope - don't reduce quality.
</critical_policy>

### Quality Indicators

**Good decisions exhibit:**
- Clear intent (code explains itself)
- Single responsibility (one thing done well)
- Explicit dependencies (no hidden coupling)
- Testable design (easy to verify)
- Graceful error handling (failures are informative)

**Bad decisions exhibit:**
- Magic values (unexplained constants)
- God objects (doing too many things)
- Hidden state (surprising side effects)
- Tight coupling (changes cascade)
- Silent failures (errors swallowed)

### When to Deviate

Deviation from this framework requires:
1. **Explicit documentation** of why the deviation is necessary
2. **User approval** for significant deviations
3. **Plan for remediation** if creating temporary shortcuts

Example deviation documentation:
```markdown
**Deviation**: Using inline styles instead of CSS modules
**Reason**: Third-party component doesn't support CSS modules
**Impact**: Reduced maintainability for this component
**Remediation**: Track in tech debt; refactor when component updated
```

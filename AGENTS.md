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
| coordinator | Orchestrating complex multi-step workflows | `@coordinator` |

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

**Use @coordinator when:**
- Large features requiring multiple specialists
- Complex workflows with dependencies
- Need automated delegation and tracking

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

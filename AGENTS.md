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
- "Review this PR" → `@corvus-review`
- "Check PR #123 for security issues" → `@corvus-review`

## Available Agents

| Agent | Use For | Invoke |
|-------|---------|--------|
| code-explorer | Finding files, understanding architecture, discovering patterns | `@code-explorer` |
| code-implementer | Writing/modifying production code | `@code-implementer` |
| code-quality | Testing, code review, security audits, build validation | `@code-quality` |
| task-planner | Breaking down complex features into subtasks | `@task-planner` |
| researcher | Technical questions, best practices, external research | `@researcher` |
| corvus | Orchestrating complex multi-step workflows | `@corvus` |
| corvus-auto | Fully autonomous multi-step workflows (zero interruptions) | `@corvus-auto` |
| requirements-analyst | Analyzing requests, identifying gaps, asking clarifying questions | `@requirements-analyst` |
| ux-dx-quality | Subjective quality: UX, DX, docs, architecture | `@ux-dx-quality` |
| corvus-review | Interactive multi-pass PR code review | `@corvus-review` |
| corvus-review-auto | Autonomous PR review (zero interruptions, auto-posts) | `@corvus-review-auto` |
| security-reviewer | Dedicated security analysis with OWASP/CWE knowledge | `@security-reviewer` |
| pr-context-gatherer | PR-specific context gathering (diffs, deps, conventions) | `@pr-context-gatherer` |
| pr-comment-writer | GitHub review posting with error recovery | `@pr-comment-writer` |

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

**Use @task-planner when:**
- Complex features requiring multiple steps
- Work spanning 4+ files
- Need to track dependencies between tasks

**Use @researcher when:**
- "How do I..." questions
- Best practice recommendations
- Comparing approaches
- External library/API questions

**Use @corvus when:**
- Large features requiring multiple specialists
- Complex workflows with dependencies
- Need automated delegation and tracking

**Use @corvus-auto when:**
- Large features requiring multiple specialists AND you want zero interruptions
- CI/CD pipelines or automated workflows where question() calls would block execution
- You trust the heuristic plan-type selection (no manual override needed)
- You want mandatory Phase 3.5 plan review without being asked
- You want git commit + push + PR creation automatically after completion

**Use @requirements-analyst when:**
- User request is ambiguous or incomplete
- Need to identify gaps before starting work
- Want structured clarification with priority tiers
- Corvus Phase 0 (automatic - usually not invoked directly)

**Use @ux-dx-quality when:**
- Evaluating user interface intuitiveness
- Assessing code readability and developer experience
- Reviewing documentation quality
- Evaluating architectural decisions
- Need subjective quality assessment beyond pass/fail

**Use @corvus-review when:**
- Reviewing pull requests with user oversight
- PR reviews where you want to preview/edit before posting
- Reviews of sensitive PRs (security, breaking changes)
- First-time review setup (to calibrate before going autonomous)

**Use @corvus-review-auto when:**
- Automated PR review in CI/CD pipelines
- Reviewing PRs where zero interaction is desired
- Batch reviewing multiple PRs
- You trust the review config and want auto-posting

**Use @security-reviewer when:**
- Deep security analysis of code changes
- OWASP Top 10 vulnerability scanning
- Taint analysis and secrets detection
- Usually invoked by @corvus-review, not directly

**Use @pr-context-gatherer when:**
- Gathering structured context about a PR's changes
- Building file maps with dependency analysis
- Usually invoked by @corvus-review, not directly

**Use @pr-comment-writer when:**
- Posting formatted reviews to GitHub
- Usually invoked by @corvus-review, not directly

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
- PR review → @corvus-review

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

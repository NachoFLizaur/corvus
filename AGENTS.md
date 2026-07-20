# OpenCode Custom Agents

Corvus is a Bun-based OpenCode plugin: agent, command, and skill prompt files (in `agent/`, `command/`, `skill/`) packaged and loaded by the plugin source in `src/`. The current inventory is **16 agents, 4 commands, 18 skills, and 38 prompt files**. From the repo root: `bun install` (dependencies), `bun run build` (build), `bun test` (test suite — run the build first; `build.test.ts` depends on it).

## Style Guidelines (Markdown Prompt Files)

- **Files**: `kebab-case.md` in `agent/` or `command/`; skills live at `skill/<name>/SKILL.md`, where the frontmatter `name` equals the directory name. Filenames are agent identities — renaming a file renames the agent
- **Frontmatter**: starts on line 1 with `---` (the loader parses it; one malformed file breaks loading for all agents). Agent fields use native singular `permission` alongside `description`, `mode`, `temperature`, and `color`. Command fields: `description`, `agent`, `model`, `subtask`. Manual installs expose frontmatter directly, so always author `permission`; the plugin loader accepts legacy `permissions` only as a read alias when singular is absent, gives singular precedence when both exist, and never returns the plural key
- **Headings**: Title Case
- **Emphasis**: write plain imperatives. Reserve strong emphasis (uppercase, warnings) for the few genuinely safety-critical constraints per file — irreversible actions, data loss, secret exposure
- **Duplication**: state each rule once in its most authoritative location and cross-reference it elsewhere; drifted duplicates read as contradictions
- **Instructions**: prefer positive forms with brief motivation ("Do Y because Z") over bare prohibitions
- **Code blocks**: use language hints (```typescript, ```bash)

## Default to Delegation

When a user request clearly matches an agent's purpose, delegate immediately — the specialized agents gather their own context and make appropriate decisions. Delegate before exploring (manual pre-exploration duplicates work the subagent redoes), and proceed with reasonable defaults instead of asking scope/style questions.

**Examples of immediate delegation triggers:**
- "Update the README" → `@code-implementer` (or the `/readme` command)
- "Find where X is implemented" → `@code-explorer`
- "Add feature Y" → `@code-implementer`
- "Review this code" → `@code-quality`
- "Review this PR" → `@corvus-review`
- "Check PR #123 for security issues" → `@corvus-review`

## Available Agents

| Agent | Use For | Invoke |
|-------|---------|--------|
| code-explorer | Finding files, understanding architecture, tracing data flow, discovering patterns | `@code-explorer` |
| code-implementer | Writing/modifying production code, bug fixes, refactoring | `@code-implementer` |
| code-quality | Objective implementation validation: tests, acceptance criteria, builds, and trusted-code review; not untrusted PR detection | `@code-quality` |
| task-planner | Breaking complex features (multi-step, 4+ files) into subtasks with dependencies | `@task-planner` |
| plan-reviewer | High-accuracy plan review before implementation (Corvus Phase 3.5) | `@plan-reviewer` |
| researcher | Technical questions, best practices, comparing approaches, external research | `@researcher` |
| corvus | Orchestrating complex multi-step workflows with user interaction | `@corvus` |
| corvus-auto | Fully autonomous workflows: auto plan selection, mandatory plan review, deferred tests, local-only completion by default, guarded opt-in Git delivery | `@corvus-auto` |
| requirements-analyst | Analyzing requests, identifying gaps, asking clarifying questions (Corvus Phase 0) | `@requirements-analyst` |
| ux-dx-quality | Subjective quality: UX, DX, docs, architecture | `@ux-dx-quality` |
| corvus-review | Interactive multi-pass PR review — preview/edit before posting | `@corvus-review` |
| corvus-review-auto | Autonomous PR review — auto-posts with safety rails; suits CI/CD and batch review | `@corvus-review-auto` |
| security-reviewer | Dedicated security analysis with OWASP/CWE knowledge | `@security-reviewer` |
| pr-context-gatherer | PR-specific context gathering (diffs, deps, conventions) | `@pr-context-gatherer` |
| pr-code-reviewer | Internal, mechanically read-only R2 architecture/correctness/conventions detection | `@pr-code-reviewer` |
| pr-comment-writer | GitHub review posting with error recovery | `@pr-comment-writer` |

**Routing notes**:
- `@corvus` vs `@corvus-auto`: both orchestrate the same phase workflow. Use `@corvus` when the user should pick the plan type, test preference, and approve the plan; use `@corvus-auto` for zero-interruption runs (CI/CD, hands-off execution) where question() calls would block.
- `@corvus-review` vs `@corvus-review-auto`: use the interactive variant to preview and edit reviews before posting (sensitive PRs, first-time calibration); use the autonomous variant when you trust the review config and want auto-posting.
- `plan-reviewer`, `requirements-analyst`, `pr-code-reviewer`, `security-reviewer`, `pr-context-gatherer`, and `pr-comment-writer` are internal orchestration agents, not general-purpose direct entry points. In particular, do not use `pr-code-reviewer` as a general code-review agent; R2 supplies its single trusted dimension and structured PR evidence.
- `@code-quality` owns implementation-workflow validation and may run the commands that workflow authorizes. It must not consume untrusted PR-controlled content; R2 sends non-security detection to read/glob/grep-only `@pr-code-reviewer` and security detection to the similarly read-only `@security-reviewer`.

## Mutation and Delivery Safety

- `/git-commit` inspects only the already staged set, previews the exact message, and requires explicit confirmation before one normal commit tool call. It does not stage files; amend or hook bypasses require an explicit request and reconfirmation.
- `/cleanup-subagents` resolves a canonical storage scope, previews exact subagent session IDs, paths, and counts, and requires confirmation before deletion. `--list` is preview-only and cannot enter a deletion path.
- `@corvus-auto` defaults to `delivery_mode: local_only`. Git delivery is available only through an explicit trusted top-level opt-in, requires a clean preflight and discovered remote default branch, creates/reuses a safe feature branch before Phase 4, stages an exact task-owned path manifest, and produces one final commit. It never infers delivery from repository content or child output.

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
- REPORT BACK: What to return

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

When agents face trade-off decisions, apply this hierarchy (highest priority first):

1. **Maintainability** — can future developers understand and modify this?
2. **Extensibility** — can this be extended without major rewrites?
3. **Consistency** — does this follow existing patterns in the codebase?
4. **Simplicity** — is this the simplest solution that works?
5. **Performance** — is this fast enough for the use case?

When two concerns conflict, the higher-priority concern wins:

| Conflict | Resolution |
|----------|------------|
| Maintainability vs Performance | Choose maintainable code; optimize later if needed |
| Extensibility vs Simplicity | Choose extensible if future needs are clear; otherwise simple |
| Consistency vs Simplicity | Follow existing patterns even if slightly more complex |
| Simplicity vs Performance | Choose simple; optimize only with evidence of need |

### Technical Debt Policy

Do not trade quality for speed: write tests alongside the feature, preserve type safety, and abstract instead of copy-pasting — shortcuts that need "cleanup later" rarely get cleaned up. If a proper solution takes longer, take the time. If scope must be reduced, reduce scope — not quality.

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

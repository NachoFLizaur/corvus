<div align="center">

# Corvus

**Multi-agent development workflow for [OpenCode](https://opencode.ai).**

Structured planning. Delegated execution. Quality gates at every boundary.

[![npm](https://img.shields.io/npm/v/corvus-ai)](https://www.npmjs.com/package/corvus-ai)
[![Bun](https://img.shields.io/badge/Bun-compatible-pink.svg)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

## Table of Contents

- [About Corvus](#about-corvus)
- [What Corvus Does](#what-corvus-does)
  - [Usage](#usage)
- [Installation](#installation)
  - [Plugin Install (Recommended)](#plugin-install-recommended)
  - [Manual Install](#manual-install)
  - [Customizing Models](#customizing-models)
- [What's Included](#whats-included)
  - [Agents (16)](#agents-16)
  - [Commands (4)](#commands-4)
  - [Skills (18)](#skills-18)
- [How Corvus Works](#how-corvus-works)
- [Corvus PR Review](#corvus-pr-review)
- [Project Structure](#project-structure)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## About Corvus

> *In Norse mythology, Odin's ravens Huginn (thought) and Muninn (memory) fly across the world each day, gathering information and reporting back. Corvus works the same way — sending specialized agents out to research, explore, implement, and validate, then synthesizing their findings into a coherent whole.*

---

## What Corvus Does

One agent to drive your entire workflow. Describe what you need, and Corvus handles the rest — clarifying requirements, exploring the codebase, planning, implementing, testing, and validating.

- **Single point of entry** — no need to pick the right agent or remember who does what
- **Adaptive planning depth** — automatically scales from zero-ceremony quick fixes to spec-driven workflows based on task complexity
- **Full lifecycle management** — from requirements through implementation to validation
- **Context across phases** — maintains coherence across a complex, multi-step task
- **Quality gates at every boundary** — objective and subjective validation before moving on

### Usage

Have a complex task in mind? Tell `@corvus` what you need. It handles clarification, planning, implementation, and validation automatically — scaling its process to match the task:

```
@corvus fix the typo in the footer              # no plan — direct delegation
@corvus add a dark mode toggle with tests        # lightweight plan — minimal ceremony
@corvus refactor the payment module to use the new API  # standard plan — full workflow
@corvus redesign the plugin architecture         # spec-driven — formal specs + full workflow
```

Need something quick? Talk to `@corvus` directly, it'll know which specialists to involve:

```
@corvus find all auth files
@corvus review the login endpoint
@corvus how does JWT refresh rotation work?
```

---

## Installation

### Plugin Install (Recommended)

```bash
npx corvus-ai
# or for a global install
npx corvus-ai --global
```

This adds `corvus-ai@latest` to your OpenCode plugin config. All agents, commands, and skills are loaded automatically. Corvus contributes defaults; your existing agent and command configuration is merged last and remains authoritative.

### Manual Install

Clone the repo and symlink the three product directories into your OpenCode config. Use this form only when the destination directories do not already exist; otherwise inspect and merge individual entries so existing configuration is not replaced.

```bash
git clone https://github.com/NachoFLizaur/corvus.git
cd corvus

ln -s "$(pwd)/agent" ~/.config/opencode/agent
ln -s "$(pwd)/command" ~/.config/opencode/command
ln -s "$(pwd)/skill" ~/.config/opencode/skill
```

Or copy instead of symlinking:

```bash
cp -r agent/ ~/.config/opencode/agent/
cp -r command/ ~/.config/opencode/command/
cp -r skill/ ~/.config/opencode/skill/
```

Manual installs expose agent frontmatter directly to OpenCode, so the native singular `permission` field is required. Corvus's plugin loader still accepts legacy `permissions` metadata when `permission` is absent, but that read-compatibility path is not the canonical format and should not be used for new or manually installed agents.

### Configuration Precedence

Corvus registration follows these rules:

- **Agents and commands are user-last**: Corvus defaults are loaded first, then the pre-existing user record is recursively merged over them. Nested user values win; user arrays, scalars, and `null` replace defaults; user-only and unknown native fields remain available. An `undefined` user value is treated as absent.
- **MCP collisions are preserved exactly**: if the user configuration already has its own `mcp["web-research"]` property, Corvus does not merge, replace, or mutate that value. Only when the property is absent does Corvus add the local default with `command: ["npx", "-y", "web-research-mcp@0.1.0"]`.
- **Skill registration is idempotent**: the resolved absolute Corvus skill directory is appended to `skills.paths` only when that exact path is not already present. Existing entries and their order are preserved.

These rules apply to the OpenCode configuration passed to the plugin hook. A repository-local `.opencode/opencode.jsonc` is user-local state, not a Corvus package input or a source of plugin defaults.

### Customizing Models

Corvus agents work with whichever model you've set up as default in opencode, but you can assign specific models per agent in your OpenCode config if you wish to:

```json
{
  "plugin": ["corvus-ai"],
  "agent": {
    "corvus": {
      "model": "anthropic/claude-opus-4"
    },
    "code-implementer": {
      "model": "anthropic/claude-sonnet-4"
    },
    "code-explorer": {
      "model": "anthropic/claude-haiku-4"
    }
  }
}
```

Any agent field (`model`, `temperature`, `permission`, etc.) can be overridden this way. Your config is the user-last layer, while omitted Corvus defaults remain available.

---

## What's Included

Corvus contains **38 prompt files**: 16 agents, 4 commands, and 18 skills.

### Agents (16)

| Agent | Purpose |
|-------|---------|
| `@corvus` | **Coordinator** — orchestrates complex multi-step workflows |
| `@corvus-auto` | **Autonomous Coordinator** — zero-interruption workflow with mandatory Phase 3.5, deferred tests, local-only delivery by default, and guarded opt-in Git delivery |
| `@code-explorer` | Find files, understand architecture, discover patterns |
| `@code-implementer` | Write production code with plan-approve workflow |
| `@code-quality` | Objective implementation validation: tests, acceptance criteria, builds, and trusted-code review |
| `@task-planner` | Break complex features into subtasks |
| `@plan-reviewer` | High-accuracy plan review before implementation |
| `@researcher` | Technical questions, best practices |
| `@requirements-analyst` | Analyze requests, identify gaps, clarify requirements |
| `@ux-dx-quality` | Subjective quality: UX, DX, docs, architecture |
| `@corvus-review` | **PR Review Coordinator** — interactive multi-pass PR review with user gates |
| `@corvus-review-auto` | **Autonomous PR Review** — zero-interruption PR review with safety rails |
| `@security-reviewer` | Dedicated security analysis: OWASP Top 10, CWE, taint analysis |
| `@pr-context-gatherer` | PR-specific context gathering: diffs, dependencies, conventions |
| `@pr-code-reviewer` | Internal mechanically read-only R2 detection for architecture, correctness, and conventions |
| `@pr-comment-writer` | GitHub review posting: API payloads, error recovery, line validation |

### Commands (4)

| Command | Purpose |
|---------|---------|
| `/git-commit` | Smart git commit with conventional commit message generation |
| `/readme` | Analyze commits and update README with relevant changes |
| `/summary` | Generate summary of current conversation for portability |
| `/cleanup-subagents` | Clean up subagent sessions |

### Skills (18)

Skills are loaded on-demand to minimize initial context size. Each Corvus phase has a dedicated skill that's loaded only when entering that phase.

| Skill | Purpose |
|-------|---------|
| `corvus-phase-0` | Requirements analysis |
| `corvus-phase-1` | Discovery and research |
| `corvus-phase-2` | Planning, user approval, and optional plan review (Phase 3.5) |
| `corvus-phase-4` | Implementation loop |
| `corvus-phase-5` | Final validation |
| `corvus-phase-6` | Completion and summary |
| `corvus-phase-7` | Follow-up triage |
| `corvus-extras` | Utilities (subagent reference, todo patterns, error handling) |
| `frontend-design` | Frontend UI/UX design guidelines |
| `deep-research` | Deep research for complex technical questions |
| `web-search` | Quick web search for focused factual lookups |

*PR Review Skills:*

| Skill | Purpose |
|-------|---------|
| `corvus-review-r0` | PR intake, triage, config loading |
| `corvus-review-r1` | Parallel context gathering |
| `corvus-review-r2` | Multi-pass review orchestration |
| `corvus-review-r3` | Comment synthesis and filtering |
| `corvus-review-r4` | User gate / autonomous auto-proceed |
| `corvus-review-r5` | GitHub posting and completion |
| `corvus-review-extras` | Shared schemas, Conventional Comments, config |

---

## How Corvus Works

Under the hood, Corvus follows a structured multi-phase workflow:

```
User Request
    │
    ▼
Phase 0a: Requirements Clarification (@requirements-analyst)
    │
    ├─── QUESTIONS_NEEDED ──► Corvus presents one batch ──► Phase 0a
    ├─── DISCOVERY_NEEDED ──► Phase 1 ──► Phase 0b POST_DISCOVERY
    │                                      ├── questions/discovery delta ──► Phase 0b
    │                                      └── clear ──────────────────────┐
    └─── CLEAR ────────────────────────────────────────────────────────────┤
                                                                           ▼
Plan Input (consume preselection; otherwise interactive choice/auto heuristic)
    │
    ├─── No Plan ────────► Direct delegation (single task, done)
    └─── Lightweight / Standard / Spec-Driven
              │
              └──► Test Input (consume supplied flags; ask/default only missing values)
    │
    ▼
Phase 2: Planning (@task-planner creates MASTER_PLAN.md)
    │
    ▼
Phase 3: User Approval (single approval gate)
    │
    ▼
User Choice: "Start Implementation" → Phase 4
             "High Accuracy Review" → Phase 3.5
    │
    ▼
Phase 3.5: Plan Review (@plan-reviewer) [optional]
    │   OKAY → user confirms → Phase 4
    │   REJECT → @task-planner fixes → User chooses: re-review or proceed
    │
    ▼
Phase 4: Implementation Loop (per-PHASE, not per-task)
    │   4a: @code-implementer (all phase tasks, parallel where possible)
    │   4b: @code-quality (entire phase, with failure attribution)
    │       FAIL → FAILURE_ANALYSIS → fix → revalidate
    │   4c: @task-planner PROGRESS_UPDATE → verify plan-only diff → next phase
    │
    ▼
Phase 5: Final Validation
    │   5a: @code-quality (objective PASS / FAIL)
    │   5b: @ux-dx-quality (PASS / NEEDS_IMPROVEMENT / CRITICAL_ISSUES, when flagged)
    │
    ▼
Phase 6: Completion
    │   @task-planner SUCCESS_EXTRACTION (feature-wide, once)
```

Key features:
- **Adaptive plan-type selection**: Scores task complexity across 6 dimensions, recommends one of 4 tiers (No Plan → Lightweight → Standard → Spec-Driven), user can override
- **Test preference**: Choose tests at every quality gate, deferred to final validation only, or skipped entirely (`@corvus-auto` always defers tests to Phase 5)
- **Phase-level validation**: Quality checks run once per phase, not per task
- **Parallel execution**: Independent tasks within a phase run simultaneously
- **Conditional clarification**: Phase 0b skipped when requirements are already clear
- **Two-tier quality gates**: Objective (@code-quality) at phase boundaries + Subjective (@ux-dx-quality) at feature completion
- **Failure attribution**: Quality gate identifies exactly which task(s) failed
- **Learning loops**: Analyze failures before fixing; Phase 6 alone extracts feature-wide success learnings
- **Optional plan review**: Phase 3.5 validates plan quality before implementation begins
- **Safe autonomous completion**: `@corvus-auto` finishes locally by default; Git delivery requires an explicit trusted opt-in and guarded single-commit route

> 📖 **Detailed Documentation**: See [docs/CORVUS-STATE-MACHINE.md](./docs/CORVUS-STATE-MACHINE.md) for complete state machine diagrams, parallel execution rules, and constraint tables.

---

## Corvus PR Review

Corvus PR Review is a multi-pass code review system that brings the same structured, multi-agent approach to pull request reviews. It runs dedicated review passes in parallel, synthesizes findings, and posts formatted reviews to GitHub — either interactively with user gates or fully autonomously.

### When to Use

- You want a thorough, structured review that goes beyond surface-level linting
- You need security-focused analysis with OWASP/CWE knowledge
- You want consistent review quality across your team
- You want to preview and edit review comments before posting

### Usage

```
@corvus-review review PR #123
@corvus-review review https://github.com/owner/repo/pull/123
@corvus-review-auto #456    # autonomous; auto-posts only when every rail passes
```

### Workflow

```
User: "Review PR #123"
    │
    ▼
R0: Intake & Triage (parse PR, fetch metadata, load config)
    │
    ▼
R1: Context Gathering [parallel]
    ├── @pr-context-gatherer (files, deps, tests, conventions)
    └── @researcher (issues, CI, advisories)
    │
    ▼
R2: Multi-Pass Review
    ├── Pass 1: Architecture (@pr-code-reviewer, read-only) ─┐
    ├── Pass 2: Correctness (@pr-code-reviewer, read-only)   ├─ parallel
    ├── Pass 3: Security (@security-reviewer, read-only)     ─┘
    └── Pass 4: Conventions (@pr-code-reviewer, read-only)   ─ sequential
    │
    ▼
R3: Comment Synthesis (dedup, filter, severity, nit budget)
    │
    ▼
R4: User Gate or deterministic autonomous rails
    │
    ▼
R5: Authorized post via @pr-comment-writer, or local-only completion
```

### Key Features

- **Multi-pass review** across architecture, correctness, security, and conventions
- **Dedicated security agent** with OWASP Top 10 and CWE knowledge base
- **Aggressive false-positive filtering** with confidence scores and nit budget enforcement
- **Conventional Comments format** for consistent, actionable feedback
- **Trusted configuration** from `.opencode/review-config.yaml` at the PR's verified immutable base SHA, with safe built-in fallback and visible provenance
- **Least-privilege detection** — untrusted PR content is analyzed only by mechanically read-only R2 reviewers; `@code-quality` remains on the implementation-validation path
- **Interactive and autonomous modes** — preview before posting, or let it run hands-free
- **Fail-closed posting** — failed/invalid reviews stay local; eligible posts go only through the structured, command-safe `@pr-comment-writer` boundary
- **Just-in-time context gathering** — no pre-built index needed, works on any repo

### Configuration

```yaml
# .opencode/review-config.yaml at the PR's verified base SHA
severity_threshold: "nitpick"
max_nits: 3
passes:
  architecture: true
  correctness: true
  security: true
  conventions: true
path_rules:
  - pattern: "src/auth/**"
    elevate_security: true
  - pattern: "vendor/**"
    skip_passes: ["conventions"]
```

> 📖 **Detailed Documentation**: See [docs/CORVUS-REVIEW-SKILL-SET.md](./docs/CORVUS-REVIEW-SKILL-SET.md) for complete review workflow documentation, configuration reference, and Conventional Comments specification.

---

## Project Structure

```
.
├── agent/                  # Agent definitions (16 agents)
│   ├── corvus.md           # Implementation orchestrator
│   ├── corvus-auto.md      # Autonomous implementation orchestrator
│   ├── corvus-review.md    # PR review orchestrator
│   ├── corvus-review-auto.md # Autonomous PR review orchestrator
│   ├── security-reviewer.md  # Security analysis specialist
│   ├── pr-context-gatherer.md # PR context gathering
│   ├── pr-code-reviewer.md    # Read-only non-security PR detection
│   ├── pr-comment-writer.md   # GitHub review posting
│   └── ...                 # (8 more agents)
├── command/                # Custom slash commands (4 commands)
├── skill/                  # On-demand skills (18 skills)
│   ├── corvus-phase-*/     # Corvus workflow phases (7)
│   ├── corvus-review-*/    # PR review phases (7)
│   └── *.../               # Utilities (corvus-extras, frontend-design, deep-research, web-search)
├── src/                    # Plugin source code
├── docs/                   # Detailed documentation
│   ├── CORVUS-STATE-MACHINE.md
│   └── CORVUS-REVIEW-SKILL-SET.md
├── AGENTS.md
└── README.md
```

See [AGENTS.md](./AGENTS.md) for delegation instructions and [docs/CORVUS-STATE-MACHINE.md](./docs/CORVUS-STATE-MACHINE.md) for detailed workflow documentation.

---

## Development

The published package keeps `@opencode-ai/plugin` peer compatibility broad (`*`). Contributor installs pin the development SDK baseline to `@opencode-ai/plugin@1.18.3` so local build and type behavior is reproducible without narrowing consumer compatibility.

```bash
# Install dependencies
bun install

# Build
bun run build

# Type check
bun x tsc --noEmit

# Run tests (build first; build.test.ts consumes dist/)
bun test
```

### Safe Local Development

- Treat `.opencode/opencode.jsonc` in a checkout as developer-local OpenCode state. Do not overwrite, copy into the package, commit, or use it as an implicit product input when developing Corvus.
- Product inputs are the checked-in `agent/`, `command/`, and `skill/` prompts plus the plugin source. Manual-install experiments should copy or link only those prompt directories after inspecting the destination.
- Keep local OpenCode configuration changes explicit and separate from source changes. The plugin's user-last merge means local hardening does not need to be copied into Corvus defaults.

---

## Troubleshooting

**Plugin not loading** — Verify your OpenCode config (`~/.config/opencode/config.json` or `.opencode/config.json`) has `"corvus-ai": true` under `plugins`.

**Agents not appearing** — Make sure `bun install` or `npm install` completed successfully. The package must be present in `node_modules` with its `agent/`, `command/`, and `skill/` directories.

**Skills not found** — Skills are loaded from the package's `skill/` directory at runtime. If you used the manual install method, verify your symlinks point to the correct location (`ls -la ~/.config/opencode/skill/`).

**Duplicate agents** — If you have both the plugin install and manual symlinks active, agents may appear twice. Pick one installation method and remove the other.

---

## License

[MIT](LICENSE) © Nacho F. Lizaur

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
  - [Agents (15)](#agents-15)
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

This adds `corvus-ai@latest` to your OpenCode plugin config. All agents, commands, and skills are loaded automatically.

### Manual Install

Clone the repo and symlink the directories into your OpenCode config:

```bash
git clone https://github.com/NachoFLizaur/corvus.git
cd corvus

ln -s $(pwd)/agent ~/.config/opencode/agent
ln -s $(pwd)/command ~/.config/opencode/command
ln -s $(pwd)/skill ~/.config/opencode/skill
```

Or copy instead of symlinking:

```bash
cp -r agent/ ~/.config/opencode/agent/
cp -r command/ ~/.config/opencode/command/
cp -r skill/ ~/.config/opencode/skill/
```

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

Any agent field (`model`, `temperature`, `tools`, etc.) can be overridden this way. Your config takes precedence over the plugin defaults.

---

## What's Included

### Agents (15)

| Agent | Purpose |
|-------|---------|
| `@corvus` | **Coordinator** — orchestrates complex multi-step workflows |
| `@corvus-auto` | **Autonomous Coordinator** — zero-interruption workflow: auto-selects plan type, mandatory Phase 3.5, tests deferred to Phase 5, git commit/push/PR in Phase 6 |
| `@code-explorer` | Find files, understand architecture, discover patterns |
| `@code-implementer` | Write production code with plan-approve workflow |
| `@code-quality` | Test, review, validate, security audit |
| `@task-planner` | Break complex features into subtasks |
| `@plan-reviewer` | High-accuracy plan review before implementation |
| `@researcher` | Technical questions, best practices |
| `@requirements-analyst` | Analyze requests, identify gaps, clarify requirements |
| `@ux-dx-quality` | Subjective quality: UX, DX, docs, architecture |
| `@corvus-review` | **PR Review Coordinator** — interactive multi-pass PR review with user gates |
| `@corvus-review-auto` | **Autonomous PR Review** — zero-interruption PR review with safety rails |
| `@security-reviewer` | Dedicated security analysis: OWASP Top 10, CWE, taint analysis |
| `@pr-context-gatherer` | PR-specific context gathering: diffs, dependencies, conventions |
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
| `corvus-phase-2` | Planning and user approval |
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
    ├─── CLEAR ──────────────────────────────────► Plan-Type Selection
    └─── DISCOVERY_NEEDED ──► Phase 1 ──► Phase 0b ──► Plan-Type Selection
    │
    ▼
Phase 1: Discovery (@researcher + @code-explorer) [parallel]
    │
    ▼
Plan-Type Selection (complexity heuristic → user override)
    │
    ├─── No Plan ────────► Direct delegation (single task, done)
    ├─── Lightweight ────► Phase 2 (1 phase, 3-6 tasks, skip discovery + final validation)
    ├─── Standard ───────► Phase 2 (full workflow, unchanged)
    └─── Spec-Driven ───► Formal specs → Phase 2 (full workflow)
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
    │   OKAY → Phase 4
    │   REJECT → @task-planner fixes → User chooses: re-review or proceed
    │
    ▼
Phase 4: Implementation Loop (per-PHASE, not per-task)
    │   4a: @code-implementer (all phase tasks, parallel where possible)
    │   4b: @code-quality (entire phase, with failure attribution)
    │       FAIL → FAILURE_ANALYSIS → fix → revalidate
    │   4c: Update master plan → next phase
    │
    ▼
Phase 5: Final Validation
    │   5a: @code-quality (comprehensive)
    │   5b: @ux-dx-quality (if any task flagged it)
    │
    ▼
Phase 6: Completion
```

Key features:
- **Adaptive plan-type selection**: Scores task complexity across 6 dimensions, recommends one of 4 tiers (No Plan → Lightweight → Standard → Spec-Driven), user can override
- **Phase-level validation**: Quality checks run once per phase (~70% fewer subagent invocations)
- **Parallel execution**: Independent tasks within a phase run simultaneously
- **Conditional clarification**: Phase 0b skipped when requirements are already clear
- **Two-tier quality gates**: Objective (@code-quality) at phase boundaries + Subjective (@ux-dx-quality) at feature completion
- **Failure attribution**: Quality gate identifies exactly which task(s) failed
- **Learning loops**: Analyze failures before fixing, extract learnings after success
- **Optional plan review**: Phase 3.5 validates plan quality before implementation begins

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
@corvus-review-auto #456    # autonomous, auto-posts
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
    ├── Pass 1: Architecture & Design (@ux-dx-quality)     ─┐
    ├── Pass 2: Logic & Correctness (@code-quality)         ├─ parallel
    ├── Pass 3: Security (@security-reviewer)               ─┘
    └── Pass 4: Conventions & Polish (max 3 nits)           ─ sequential
    │
    ▼
R3: Comment Synthesis (dedup, filter, severity, nit budget)
    │
    ▼
R4: User Gate → Post / Edit / Save Locally / Re-run
    │
    ▼
R5: Post to GitHub via @pr-comment-writer
```

### Key Features

- **Multi-pass review** following Google's priority order (correctness → design → security → style)
- **Dedicated security agent** with OWASP Top 10 and CWE knowledge base
- **Aggressive false-positive filtering** with confidence scores and nit budget enforcement
- **Conventional Comments format** for consistent, actionable feedback
- **Configurable** via `.opencode/review-config.yaml` for per-project tuning
- **Interactive and autonomous modes** — preview before posting, or let it run hands-free
- **Just-in-time context gathering** — no pre-built index needed, works on any repo

### Configuration

```yaml
# .opencode/review-config.yaml
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
├── agent/                  # Agent definitions (15 agents)
│   ├── corvus.md           # Implementation orchestrator
│   ├── corvus-auto.md      # Autonomous implementation orchestrator
│   ├── corvus-review.md    # PR review orchestrator
│   ├── corvus-review-auto.md # Autonomous PR review orchestrator
│   ├── security-reviewer.md  # Security analysis specialist
│   ├── pr-context-gatherer.md # PR context gathering
│   ├── pr-comment-writer.md   # GitHub review posting
│   └── ...                 # (8 more existing agents)
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

```bash
# Install dependencies
bun install

# Run tests
bun test

# Build
bun run build

# Type check
bun x tsc --noEmit
```

---

## Troubleshooting

**Plugin not loading** — Verify your OpenCode config (`~/.config/opencode/config.json` or `.opencode/config.json`) has `"corvus-ai": true` under `plugins`.

**Agents not appearing** — Make sure `bun install` or `npm install` completed successfully. The package must be present in `node_modules` with its `agent/`, `command/`, and `skill/` directories.

**Skills not found** — Skills are loaded from the package's `skill/` directory at runtime. If you used the manual install method, verify your symlinks point to the correct location (`ls -la ~/.config/opencode/skill/`).

**Duplicate agents** — If you have both the plugin install and manual symlinks active, agents may appear twice. Pick one installation method and remove the other.

---

## License

[MIT](LICENSE) © Nacho F. Lizaur

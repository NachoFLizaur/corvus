# Corvus — Multi-Agent Development Workflow

Custom agents, commands, and MCP servers for [OpenCode](https://opencode.ai).

## About Corvus

> *In Norse mythology, Odin's ravens Huginn (thought) and Muninn (memory) fly across the world each day, gathering information and reporting back. Corvus works the same way — sending specialized agents out to research, explore, implement, and validate, then synthesizing their findings into a coherent whole.*

## What Corvus Does

One agent to drive your entire workflow. Describe what you need, and Corvus handles the rest — clarifying requirements, exploring the codebase, planning, implementing, testing, and validating.

- **Single point of entry** — no need to pick the right agent or remember who does what
- **Full lifecycle management** — from requirements through implementation to validation
- **Context across phases** — maintains coherence across a complex, multi-step task
- **Quality gates at every boundary** — objective and subjective validation before moving on

## Usage

Have a complex task in mind? Tell `@corvus` what you need. It handles clarification, planning, implementation, and validation automatically.

```
@corvus add a dark mode toggle with tests
@corvus refactor the payment module to use the new API
```

Need something quick? Talk to `@corvus` directly, it'll know which specialists to involve:

```
@corvus find all auth files
@corvus review the login endpoint
@corvus how does JWT refresh rotation work?
```

## The Agent System

Corvus coordinates a team of specialized agents. Each handles a specific domain.

| Agent | Purpose |
|-------|---------|
| `@corvus` | **Coordinator** — orchestrates complex multi-step workflows |
| `@code-explorer` | Find files, understand architecture, discover patterns |
| `@code-implementer` | Write production code with plan-approve workflow |
| `@code-quality` | Test, review, validate, security audit |
| `@documentation` | README, API docs, architecture docs |
| `@task-planner` | Break complex features into subtasks |
| `@researcher` | Technical questions, best practices |
| `@agent-generator` | Create new custom agents |
| `@media-processor` | Analyze images, PDFs, diagrams |
| `@requirements-analyst` | Analyze requests, identify gaps, clarify requirements |
| `@ux-dx-quality` | Subjective quality: UX, DX, docs, architecture |

## How Corvus Works

Under the hood, Corvus follows a structured multi-phase workflow:

```
User Request
    │
    ▼
Phase 0a: Requirements Clarification (@requirements-analyst)
    │
    ├─── CLEAR ──────────────────────────────────► Phase 2
    └─── DISCOVERY_NEEDED ──► Phase 1 ──► Phase 0b
    │
    ▼
Phase 1: Discovery (@researcher + @code-explorer) [parallel]
    │
    ▼
Phase 2: Planning (@task-planner creates MASTER_PLAN.md)
    │
    ▼
Phase 3: User Approval (single approval gate)
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
- **Phase-level validation**: Quality checks run once per phase (~70% fewer subagent invocations)
- **Parallel execution**: Independent tasks within a phase run simultaneously
- **Conditional clarification**: Phase 0b skipped when requirements are already clear
- **Two-tier quality gates**: Objective (@code-quality) at phase boundaries + Subjective (@ux-dx-quality) at feature completion
- **Failure attribution**: Quality gate identifies exactly which task(s) failed
- **Learning loops**: Analyze failures before fixing, extract learnings after success

> 📖 **Detailed Documentation**: See [docs/CORVUS-STATE-MACHINE.md](./docs/CORVUS-STATE-MACHINE.md) for complete state machine diagrams, parallel execution rules, and constraint tables.

## Commands

| Command | Purpose |
|---------|---------|
| `/cleanup-subagents` | Clean up subagent sessions |
| `/git-commit` | Smart git commit with conventional commit message generation |
| `/readme` | Analyze commits and update README with relevant changes |
| `/summary` | Generate summary of current conversation for portability |

## Installation

Copy to your OpenCode config directory:

```bash
cp -r agent/ ~/.config/opencode/agent/
cp -r command/ ~/.config/opencode/command/
cp -r skill/ ~/.config/opencode/skill/
cp AGENTS.md ~/.config/opencode/
```

Or symlink for easy updates:

```bash
ln -s $(pwd)/agent ~/.config/opencode/agent
ln -s $(pwd)/command ~/.config/opencode/command
ln -s $(pwd)/skill ~/.config/opencode/skill
```

> Opencode Supported plugin in the works!

## Corvus Skills

Corvus uses **on-demand skill loading** to minimize initial context size:

- **Skills are loaded per-phase**: Each Corvus phase has a dedicated skill that's loaded only when entering that phase
- **Reduced initial prompt**: Initial context drops from ~16k tokens to ~3k tokens
- **Better context utilization**: More room for actual task content and code

## Structure

```
.
├── agent/              # Custom agent definitions
├── command/            # Custom slash commands
├── skill/              # Corvus phase skills (loaded on-demand)
│   ├── corvus-phase-0/ # Requirements analysis
│   ├── corvus-phase-1/ # Discovery
│   ├── corvus-phase-2/ # Planning + Approval
│   ├── corvus-phase-4/ # Implementation loop
│   ├── corvus-phase-5/ # Final validation
│   ├── corvus-phase-6/ # Completion
│   ├── corvus-phase-7/ # Follow-up triage
│   └── corvus-extras/  # Utilities
├── docs/               # Detailed documentation
│   └── CORVUS-STATE-MACHINE.md
├── AGENTS.md           # Delegation guidelines for agents
└── README.md
```

See [AGENTS.md](./AGENTS.md) for delegation instructions and [docs/CORVUS-STATE-MACHINE.md](./docs/CORVUS-STATE-MACHINE.md) for detailed workflow documentation.

---

## License

[MIT](LICENSE) © Nacho F. Lizaur
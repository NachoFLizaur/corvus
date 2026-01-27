# OpenCode Features

Custom agents, commands, and MCP servers for [OpenCode](https://opencode.ai).

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

## Usage

Invoke agents via `@` mentions:

```
@code-explorer find all authentication files
@researcher how does JWT refresh rotation work?
@code-implementer add validation to the login endpoint
@code-quality write tests for the auth module
```

## Agents

| Agent | Purpose |
|-------|---------|
| `@code-explorer` | Find files, understand architecture, discover patterns |
| `@code-implementer` | Write production code with plan-approve workflow |
| `@code-quality` | Test, review, validate, security audit |
| `@documentation` | README, API docs, architecture docs |
| `@task-planner` | Break complex features into subtasks |
| `@researcher` | Technical questions, best practices |
| `@agent-generator` | Create new custom agents |
| `@media-processor` | Analyze images, PDFs, diagrams |
| `@orchestrator` | Orchestrate complex multi-step workflows |
| `@requirements-analyst` | Analyze requests, identify gaps, clarify requirements |
| `@ux-dx-quality` | Subjective quality: UX, DX, docs, architecture |

## Commands

| Command | Purpose |
|---------|---------|
| `/cleanup-subagents` | Clean up subagent sessions |
| `/git-commit` | Smart git commit with conventional commit message generation |
| `/readme` | Analyze commits and update README with relevant changes |
| `/summary` | Generate summary of current conversation for portability |

## Orchestrator Workflow

The `@orchestrator` agent coordinates complex multi-step tasks through a structured workflow optimized for efficiency:

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

> 📖 **Detailed Documentation**: See [docs/ORCHESTRATOR-STATE-MACHINE.md](./docs/ORCHESTRATOR-STATE-MACHINE.md) for complete state machine diagrams, parallel execution rules, and constraint tables.

## Orchestrator Skills

The orchestrator uses **on-demand skill loading** to minimize initial context size:

- **Skills are loaded per-phase**: Each orchestrator phase has a dedicated skill that's loaded only when entering that phase
- **Reduced initial prompt**: Initial context drops from ~16k tokens to ~3k tokens
- **Better context utilization**: More room for actual task content and code

Skills are stored in `skill/` and should be copied to `~/.config/opencode/skill/`. They include:
- `orch-phase-0/` - Requirements analysis
- `orch-phase-1/` - Discovery
- `orch-phase-2/` - Planning + Approval
- `orch-phase-4/` - Implementation loop
- `orch-phase-5/` - Final validation
- `orch-phase-6/` - Completion
- `orch-phase-7/` - Follow-up triage
- `orch-extras/` - Utilities

## Structure

```
.
├── agent/              # Custom agent definitions
├── command/            # Custom slash commands
├── skill/              # Orchestrator phase skills (loaded on-demand)
│   ├── orch-phase-0/   # Requirements analysis
│   ├── orch-phase-1/   # Discovery
│   ├── orch-phase-2/   # Planning + Approval
│   ├── orch-phase-4/   # Implementation loop
│   ├── orch-phase-5/   # Final validation
│   ├── orch-phase-6/   # Completion
│   ├── orch-phase-7/   # Follow-up triage
│   └── orch-extras/    # Utilities
├── docs/               # Detailed documentation
│   └── ORCHESTRATOR-STATE-MACHINE.md
├── AGENTS.md           # Delegation guidelines for agents
└── README.md
```

See [AGENTS.md](./AGENTS.md) for delegation instructions and [docs/ORCHESTRATOR-STATE-MACHINE.md](./docs/ORCHESTRATOR-STATE-MACHINE.md) for detailed workflow documentation.

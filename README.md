# OpenCode Features

Custom agents, commands, and MCP servers for [OpenCode](https://opencode.ai).

## Installation

Copy to your OpenCode config directory:

```bash
cp -r agent/ ~/.config/opencode/agent/
cp -r command/ ~/.config/opencode/command/
cp AGENTS.md ~/.config/opencode/
```

Or symlink for easy updates:

```bash
ln -s $(pwd)/agent ~/.config/opencode/agent
ln -s $(pwd)/command ~/.config/opencode/command
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
| `@coordinator` | Orchestrate complex multi-step workflows |

## Commands

| Command | Purpose |
|---------|---------|
| `/cleanup-subagents` | Clean up subagent sessions |

## Structure

```
.
├── agent/              # Custom agent definitions
├── command/            # Custom slash commands
├── AGENTS.md           # Delegation guidelines for agents
└── README.md
```

See [AGENTS.md](./AGENTS.md) for detailed delegation instructions.

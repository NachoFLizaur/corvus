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
  - [OpenCode v2](#opencode-v2)
  - [Configuration Precedence](#configuration-precedence)
  - [Customizing Models](#customizing-models)
- [What's Included](#whats-included)
  - [Agents (18)](#agents-18)
  - [Commands (4)](#commands-4)
  - [Skills (19)](#skills-19)
- [How Corvus Works](#how-corvus-works)
  - [What Corvus commits to your repo](#what-corvus-commits-to-your-repo)
- [Corvus PR Review](#corvus-pr-review)
- [Upgrading from 0.9 to 0.10](#upgrading-from-09-to-010)
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
- **Adaptive planning depth** — one model-chosen effort level, from narrow discovery to wider architectural investigation; simple fixes still delegate directly
- **Full lifecycle management** — from requirements through implementation to validation
- **Context across phases** — maintains coherence across a complex, multi-step task
- **Quality gates at every boundary** — objective and subjective validation before moving on

### Usage

Have a complex task in mind? Tell `@corvus` what you need. It handles clarification, planning, implementation, and validation automatically — scaling its process to match the task:

```
@corvus fix the typo in the footer              # no plan — direct delegation
@corvus add a dark mode toggle with tests        # one adaptive plan, deferred tests
@corvus refactor the payment module to use the new API  # reviewed implementation slices
@corvus redesign the plugin architecture         # wider discovery for architectural change
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

This adds `corvus-ai@latest` to your OpenCode plugin config. All agents, commands, and skills are loaded automatically. Corvus contributes defaults only, and your own settings stay authoritative on both hosts — on OpenCode v1 Corvus merges your agent and command configuration last, and on OpenCode v2 host ordering guarantees it, so Corvus performs no merge at all. See [Configuration Precedence](#configuration-precedence) for the per-host details and [OpenCode v2](#opencode-v2) for v2 installs.

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

These instructions target OpenCode v1's config layout. On OpenCode v2, use the plugin procedure and compatibility notes under [OpenCode v2](#opencode-v2).

### OpenCode v2

Corvus ships one package with two entry points: `dist/index.js` remains the legacy OpenCode v1 function entry, while `dist/server.js` serves both OpenCode 1.18.30+ and OpenCode v2 through the `corvus-ai/server` subpath. The shared entry exports `{ id, server, setup }`: v1 invokes the legacy hook function through `server`, and v2 invokes `setup`. Both register the same 18 agents, 4 commands, 19 skills, and the default `web-research` MCP server.

**Release availability:** Corvus 0.10.0 loads on OpenCode v2 ≤2.0.3, but its missing skill `path` causes the host to disable it on v2 ≥2.0.4 (boundary per [PR #12](https://github.com/NachoFLizaur/corvus/pull/12)'s schema decode across published `@opencode/schema` 2.0.x). Use **0.10.1 or later** on those hosts; see the [0.10.1 changelog](CHANGELOG.md#0101--2026-09-30). 0.10.1 has been verified on OpenCode **2.0.20** and **1.18.33**; see [Release Gates](#release-gates) for the checks and remaining limitations.

Install with the CLI. Pass `--v2` explicitly: installer autodetection checks binary names, not versions, so a stable v2 executable named `opencode` is not recognized as v2. The CLI writes the plural `plugins` key into the existing `opencode.jsonc` or `opencode.json` under `$XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`), creating `opencode.json` if neither exists:

```bash
npx corvus-ai@latest --v2
```

No beta tag is needed. The CLI pins the config entry to its own package version, so check that the written entry is 0.10.1 or later before using a v2 host ≥2.0.4.

Or add the entry by hand:

```json
{
  "plugins": ["corvus-ai"]
}
```

An existing v1 `plugin` entry is never rewritten for you: keep the singular key for a v1 host and the plural key for v2. Quit and restart OpenCode after changing the config.

#### Config Key Renames

v2 renamed the configuration keys Corvus interacts with. When you move a machine to v2, rename them in your own config too:

| v1 | v2 | Notes |
|----|----|-------|
| `plugin: []` | `plugins: []` | The host still auto-migrates the singular key |
| `agent: {}` | `agents: {}` | Same record shape, renamed key |
| `command: {}` | `commands: {}` | Same record shape, renamed key |
| `skills.paths: []` | `skills: []` | A flat array of skill directories |
| `mcp.<name>` | `mcp.servers.<name>` | Server records moved one level down |
| `permission: {}` | `permissions: []` | Per-agent rules became an ordered list |

#### Agent Overrides Under v2

Agent fields were renamed with the rest of the v2 schema. Under `agents.<name>`:

| v1 field | v2 field | Notes |
|----------|----------|-------|
| `prompt` | `system` | The instruction body |
| `temperature` | `request.body.temperature` | `request.body` also carries other provider body parameters |
| `permission: {action: effect}` | `permissions: [{action, resource, effect}]` | Ordered rules; the LAST matching rule wins |
| `maxSteps` | `steps` | |
| `disable` | `disabled` | |
| `model` | `model` | Unchanged — still `"provider/model"` |

Permission action names moved to the v2 tool names: `bash` → `shell`, `task` → `subagent`, and both `write` and `patch` → `edit`. Rules you write are appended after Corvus's, and because the last matching rule wins, yours decide — except for the protected-agent and light fixed-deny boundaries described under [Protected Agents Under v2](#protected-agents-under-v2). Six actions in Corvus's own corpus have no v2 tool (`list`, `todowrite`, `todoread`, `codesearch`, `lsp`, `doom_loop`); their rules are translated unchanged and are harmless, because `action` is a free-form string.

#### Skill Name Collisions

Corvus registers skills as records keyed by id, so three packaged ids that lack the `corvus-` prefix can collide with a skill of your own: `deep-research`, `frontend-design`, and `web-search`. Your definition wins by host ordering — user skills load after package plugins — and no configuration is needed. Corvus keeps the plain names rather than renaming them, so a collision replaces the packaged skill instead of shadowing it under a second name.

#### Protected Agents Under v2

All agents default to `permission: { "*": "allow" }`. `pr-context-gatherer`, `pr-comment-writer`, `pr-code-reviewer`, `pr-light-reviewer`, and `security-reviewer` deny `edit`/`write`; `corvus-auto`, `corvus-review-auto`, and `corvus-review-light` deny `question`; `corvus` and `corvus-auto` retain their destructive-bash denies. The four protected agents (`pr-code-reviewer`, `pr-light-reviewer`, `security-reviewer`, and `pr-comment-writer`) retain these v2 guarantees:

- **Edit/write boundary — enforced.** Corvus registers a `permission.hook("evaluate")` that re-applies the authored rules at request time from its own packaged files. The hook can only tighten: the host resolves its own rules first and Corvus never writes `allow`, so a denial cannot be widened by any configuration. Denials name the boundary — for example, `corvus: pr-code-reviewer is mechanically read-only; edit is denied by the plugin's security boundary.` (illustrative wording; the message itself lives with the code).
- **Prompt immutability — demoted to a presence-only guarantee.** v2 has no configuration hook and no agent field that stays out of reach afterwards, so Corvus can no longer guarantee that a protected agent runs its authored prompt unchanged. A `session.hook("context")` re-appends the authored body when no system part carries it, which restores an absent prompt but cannot remove or override instructions supplied elsewhere. Shell permissions now default-allow: read-only review and tool-only posting are prompt obligations, not a shell sandbox. Existing PR/verdict/sync caller checks run inside the tool adapters, independently of frontmatter.

`corvus-review-light` separately has fixed `question`/edit/write/patch denies and default-deny shell and child-dispatch allowlists derived from its packaged permission block. Shell access covers only the light skill's head preparation, remote/lock inspection and literal UTC timing commands; dispatch is limited to `pr-light-reviewer` and `pr-comment-writer`. Shell metacharacter denies block composition, redirection and substitution in matched command text. Only `corvus_review_worktree` owns the disposable sibling worktree lifecycle. On v1 the plugin restores authored shell/task maps plus additional user denies after merging; on v2 its request hook requires an authored allow and preserves host denials. User allows cannot widen these capabilities; extra denials (including the smoke harness's writer-dispatch denial) and model overrides survive. See [ADR-0007](docs/decisions/0007-light-review-single-detector-shared-namespace.md).

`src/v2/enforce-protected.ts` and `src/fixed-denies.ts` own the rationale and fail directions; this section summarizes them rather than restating the enforcement rules.

### Configuration Precedence

Your configuration wins on both hosts, by different mechanisms.

**OpenCode v1** — Corvus is handed the resolved config in a plugin hook and merges yours over its defaults:

- **Agents and commands are user-last**: Corvus defaults are loaded first, then the pre-existing user record is recursively merged over them. Nested user values win; user arrays, scalars, and `null` replace defaults; user-only and unknown native fields remain available. An `undefined` user value is treated as absent.
- **MCP collisions are preserved exactly**: if the user configuration already has its own `mcp["web-research"]` property, Corvus does not merge, replace, or mutate that value. Only when the property is absent does Corvus add the local default with `command: ["npx", "-y", "web-research-mcp@0.1.0"]`.
- **Skill registration is idempotent**: the resolved absolute Corvus skill directory is appended to `skills.paths` only when that exact path is not already present. Existing entries and their order are preserved.

**OpenCode v2** — there is no configuration hook. Corvus contributes records through registration transforms, and the host applies your agent, command, and skill configuration afterwards:

- **Agents and commands are user-last by host ordering**: Corvus upserts each agent (assigning only the fields its prompt files declare) and registers each command as a function. Your `agents` and `commands` entries are applied after package plugins, so your permission rules are appended after Corvus's, where last-match-wins normally makes them decisive. Corvus runs no merge of its own — see [Protected Agents Under v2](#protected-agents-under-v2) for the boundaries re-applied at request time.
- **Skills are keyed records**: a skill of yours sharing an id replaces the packaged one, again by host ordering.
- **MCP collisions are preserved exactly**: the `web-research` default is added only when `mcp.servers["web-research"]` is absent. A present entry is left exactly as it is, even when it is disabled or points elsewhere.

These rules apply to the OpenCode configuration Corvus is given by the host. A repository-local `.opencode/opencode.jsonc` is user-local state, not a Corvus package input or a source of plugin defaults.

For Corvus agents only, the plugin preserves any hook-visible output budget (normally already seeded on v1), otherwise sets the smaller of the model output limit and 32,000 tokens. On v2 it reads and writes `options.maxTokens`; the hook exposes the agent ID but only a model reference, so it falls back to 32,000 without a model-limit clamp and can replace a larger unobservable route/model generation default.

### Customizing Models

Corvus agents work with whichever model you've set up as default in opencode, but you can assign specific models per agent in your OpenCode config if you wish to.

On OpenCode v1:

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

The same overrides on OpenCode v2, with the plural keys:

```json
{
  "plugins": ["corvus-ai"],
  "agents": {
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

Agent fields can be overridden this way — `model`, `permission`/`permissions`, `temperature` (`request.body.temperature` on v2), and so on — subject to the [protected and fixed-deny boundaries](#protected-agents-under-v2). Your config is the last layer to be applied, while omitted Corvus defaults remain available. The v1 and v2 field names differ: see [Agent Overrides Under v2](#agent-overrides-under-v2).

For light reviews, point `corvus-review-light` and `pr-light-reviewer` at a fast model you trust using `agent.<name>.model` on v1 or `agents.<name>.model` on v2 in your per-user OpenCode config. Model choice is not packaged prompt frontmatter: Corvus's loader drops an agent frontmatter `model` key. For example, merge this v2 fragment with your existing settings, replacing the placeholder with an installed model ID:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "corvus-review-light": { "model": "<provider/fast-model>" },
    "pr-light-reviewer": { "model": "<provider/fast-model>" }
  }
}
```

Faster feedback and finding quality depend on the selected models; neither savings nor parity with full review has been measured for the light path.

---

## What's Included

Corvus contains **41 prompt files**: 18 agents, 4 commands, and 19 skills.

### Agents (18)

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
| `@corvus-review-light` | **Autonomous Light PR Review** — concurrent axis shards per attempt (up to three attempts), disposable PR-head worktree, compact output and local-only artifacts; stops on merge/close, never APPROVE |
| `@security-reviewer` | R2 Spec-axis review plus independent security analysis: OWASP Top 10, CWE, taint analysis |
| `@pr-context-gatherer` | PR-specific context gathering: diffs, dependencies, conventions |
| `@pr-code-reviewer` | Internal R2 Standards-axis detection with edit/write denied: architecture, correctness, and conventions in one invocation |
| `@pr-light-reviewer` | Internal protected light detector identity, dispatched with a Standards or Spec/security brief |
| `@pr-comment-writer` | GitHub review posting: API payloads, error recovery, line validation |

### Commands (4)

| Command | Purpose |
|---------|---------|
| `/git-commit` | Smart git commit with conventional commit message generation |
| `/readme` | Analyze commits and update README with relevant changes |
| `/summary` | Generate summary of current conversation for portability |
| `/cleanup-subagents` | Clean up subagent sessions |

### Skills (19)

Skills are loaded on-demand to minimize initial context size. Each Corvus phase has a dedicated skill that's loaded only when entering that phase.

| Skill | Purpose |
|-------|---------|
| `corvus-phase-0` | Requirements analysis |
| `corvus-phase-1` | Discovery and research |
| `corvus-phase-2` | One adaptive plan, mandatory plan-review loop, and approval |
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
| `corvus-review-r2` | Parallel Standards and Spec review with independent security coverage |
| `corvus-review-r3` | Comment synthesis and filtering |
| `corvus-review-r4` | User gate / autonomous auto-proceed |
| `corvus-review-r5` | GitHub posting and completion |
| `corvus-review-extras` | Shared schemas, Conventional Comments, config |
| `corvus-review-light` | Single-skill autonomous light procedure with reduced coverage and local-only artifacts |

---

## How Corvus Works

Simple requests delegate directly to a specialist without a plan. Planned work follows the [phase map](docs/CORVUS-STATE-MACHINE.md); its links lead to the skills that own each procedure.

### One Plan, Adaptive Effort

The model chooses `depth: quick | standard | deep`, recorded as one `**Depth**` line with a reason in `.corvus/tasks/<feature>/PLAN.md`. Quick narrows discovery and plan prose, standard is the default, and deep widens discovery and checks every touched ADR scope. Every depth retains discovery, the review loop, phase gates, and final validation.

<!-- adapted from mattpocock/skills (MIT) -->
The single plan holds immutable user requirements, acceptance criteria, decisions, unknowns, tasks, gates, and history. Tasks are vertical slices with `blocks:` dependencies and observable done-whens. Implementation paths and code snippets stay out of the plan body; exact file ownership is resolved at dispatch and recorded in its Log. See [Plan Format](agent/task-planner.md#plan-format).

### What Corvus commits to your repo

`.corvus/` is committed to your repo by default: `.corvus/tasks/<feature>/**` contains PLAN.md, DISCOVERY.md, ledgers, and task-scoped full-review state as project memory, not scratch. Keep these records with the product diff so the files, changes, and intent remain traceable. Interactive Corvus lists them in its commit handoff; Corvus Auto includes their exact file paths in opted-in Git delivery and otherwise leaves that commit to you. Light-review artifacts are the exception: `<review-root>/.light/` is never synchronized, and light review never commits or pushes state; see [Light Review and Local Artifacts](#light-review-and-local-artifacts). Keeping review records local does not opt the planning/implementation workflow out of committed project memory; `delivery_mode: local_only` defers Git delivery rather than changing that policy. The Corvus repository itself is the exception described in [AGENTS.md](AGENTS.md#planning-records).

### From Request to Completion

- **Clarify and discover** — [requirements grilling](skill/corvus-phase-0/SKILL.md) returns question batches; [discovery](skill/corvus-phase-1/SKILL.md) grounds the plan at every depth. A spec-complete request can bypass grilling, not discovery.
- **Plan, review, approve** — [planning and approval](skill/corvus-phase-2/SKILL.md) creates the plan, then runs mandatory Phase 3.5 plan review: `REJECT → PLAN_FIX → whole-plan re-review` until `OK`, without a round cap. Unchanged findings produce `STALLED` and remain unresolved, never OK. The single approval gate offers **Start Implementation** only after OK, **Request Changes**, or **Override Depth**; changes return through planning and review, refreshing discovery as needed.
- **Implement the frontier** — [execution](skill/corvus-phase-4/SKILL.md) works unblocked tasks in the current phase with disjoint parallel file sets. Each phase closes through `4a → 4b → 4c`: implementation, acceptance-only gate, then one batched `PROGRESS_UPDATE`. Failure iteration 1 gets a direct fix; iteration ≥2 gets `FAILURE_ANALYSIS` first; three unsuccessful fix iterations stop execution. Material divergence from the approved plan returns to planning.
- **Validate the feature** — [final validation](skill/corvus-phase-5/SKILL.md) runs objective 5a and, when a task carries `[ux]`, subjective 5b. Blocking findings return to scoped fixes; missing evidence holds completion.
- **Extract and summarize** — [completion](skill/corvus-phase-6/SKILL.md) owns feature-wide `SUCCESS_EXTRACTION`, Corvus-process learnings, and the final summary. [Follow-up triage](skill/corvus-phase-7/SKILL.md) routes subsequent requests while preserving completed history.

### Cross-model plan review (recommended)

Assign different models to `task-planner` and `plan-reviewer` through host configuration, not packaged prompt frontmatter. With neither override set, both use the host default: Phase 0 emits one degraded warning and review proceeds. The gate summary reports `review_mode: same-model` (degraded) or `review_mode: cross-model` for distinct resolved models, without a degraded warning.

On v1, merge these per-agent overrides into `opencode.json`:

```json
{"agent":{"task-planner":{"model":"<provider/model-a>"},"plan-reviewer":{"model":"<provider/model-b>"}}}
```

On v2, use the plural `agents` key in `$XDG_CONFIG_HOME/opencode/opencode.json` (default `~/.config/opencode/opencode.json`), the same file that holds `plugins`; see [Agent Overrides Under v2](#agent-overrides-under-v2):

```json
{"agents":{"task-planner":{"model":"<provider/model-a>"},"plan-reviewer":{"model":"<provider/model-b>"}}}
```

### Tests and Resume

`tests: deferred | none` is recorded as `**Tests**` in the plan and defaults to deferred. Deferred authors coverage during implementation but executes no tests before the single full-suite run at Phase 5a. None neither authors nor runs tests. Both use acceptance-only 4b gates and retain final validation; see the authoritative [Tests policy](skill/corvus-phase-2/SKILL.md#tests).

Intake reads PLAN.md's `**Status**` and resumes at the first incomplete step, checking the last gate's evidence. `@corvus` asks before resuming; `@corvus-auto` selects deterministically. Legacy plans are read-only context; resume and follow-up use task-planner's `AMEND_PLAN copy-forward` into a fresh PLAN.md with a DISCOVERY.md companion; completed plans are likewise preserved for follow-ups.

Interactive Corvus uses `question()` for choices and lets the user override depth at approval. Corvus Auto accepts supplied inputs or defaults, records assumptions, auto-approves only OK, and halts on stalled review. It finishes locally by default; [Git delivery](agent/corvus-auto.md#git-delivery) requires trusted opt-in renewed on resume and its guarded delivery checks. Interactive delivery remains a user handoff.

### Decision Records

<!-- adapted from mattpocock/skills (MIT) -->
Architecture decisions belong in the user's repository at [`docs/decisions/`](docs/decisions/README.md) only when all three conditions hold: **hard to reverse**, **surprising without context**, and **the result of a real trade-off**. Otherwise, no ADR is needed. The plan links records by ID, and review checks those whose scope it touches. Accepted decisions change through superseding records; `.corvus/tasks/learnings.md` keeps only Corvus-process learnings.

---

## Corvus PR Review

Corvus PR Review reviews pull requests and local changes. The full path runs two detection children in parallel — Standards (`@pr-code-reviewer`) and Spec plus independent security (`@security-reviewer`) — and keeps findings separate by axis through synthesis. The light path uses concurrent `@pr-light-reviewer` shards for both axes, covering all eligible changed hunks by default. PR reviews post to GitHub with interactive authorization or autonomously, depending on the agent; LOCAL reviews finish with local evidence and a chat summary, never a post.

### When to Use

| Agent | Choose It When |
|-------|----------------|
| `@corvus-review` | You want the full two-axis review and to preview/edit before posting, such as sensitive PRs or first-time calibration |
| `@corvus-review-auto` | You want the same full pipeline to publish autonomously with configured safety rails |
| `@corvus-review-light` | You want a shorter pipeline for a moving PR, including large diffs; parallel shards cover eligible hunks, artifacts stay local and it never APPROVEs |

Light review is not a full security audit or a quality-parity promise. Use full review for deeper context, specialist detection and resumable delta reviews.

### Usage

```
@corvus-review review PR #123
@corvus-review review https://github.com/owner/repo/pull/123
@corvus-review-auto #456    # autonomous; posts by default, with limits disclosed
@corvus-review-auto review this PR    # discover the current branch's PR
@corvus-review-light #123            # autonomous, reduced coverage, local-only artifacts
@corvus-review-light https://github.com/owner/repo/pull/123
@corvus-review-light review my local changes  # LOCAL when no PR is found; never posts
@corvus-review review my changes      # LOCAL when no PR is found
```

**Intake precedence:** GitHub PR URL → `owner/repo#N` → `#N`/`N` (resolve the repository) → named branch → auto-find the current branch's PR → LOCAL when no PR is found. Branch discovery uses `corvus_review_pr` op `find`; LOCAL evidence uses op `local`. Missing input is not a stop. Ambiguous candidates use an interactive selection when available, otherwise OPEN first and then greatest PR number, with the choice disclosed.

**LOCAL mode:** review the current worktree's changes against the default-branch merge base, including uncommitted edits. Full-review state uses the resolved review root described below: namespace-level `review-input.json` plus `<code_head>/REVIEW_DOCUMENT.md` and `meta.yaml` (`mode: local`, dirty state recorded). The local lock and best-effort history-only/head verdict calls remain; unavailable verdicts are disclosed, with synthesis counts labelled as such. PR identity, repository config, CI checks, prior PR reviews and remote-lock semantics are skipped with notes; built-in defaults plus trusted invocation settings apply. R3 creates no candidate or posting artifact, R4 offers no posting choice, and R5 releases the owned lock and prints the document path or persistence diagnostic and separate axis counts to chat without a writer dispatch. Light LOCAL instead retains an inert COMMENT artifact under `.light/` and prints the chosen approach, actual reviewed/omitted/unavailable scope, axis/severity counts and the attempt ledger, with zero writer or post attempts. A clean default branch with no PR, no commits ahead and no changes ends with a one-sentence no-work result.

**Review state and layout:** full-review state is committed by default on the feature branch. `corvus_review_sync` resolves `.corvus/tasks/<task>/reviews/pr<N>/` when the unfiltered changed-file inventory identifies exactly one task, otherwise `.corvus/reviews/pr<N>/`; LOCAL substitutes `local-<branch-slug>` for `pr<N>`. Legacy `<owner>__<repo>__pr<N>` and `local__<repo>__<slug>` roots remain readable through `legacy_root` for one release and are never written again. `.corvus/**` is excluded from review scope. `.corvus/reviews/` must not be gitignored in target repositories or state commits cannot land; keep task-scoped review roots trackable too. `state_sync: false` skips state pull/push, not PR review posting; sync is best-effort, and failures retain local state and never block posting. Fork PR state is never pushed, and LOCAL sync requires an upstream. Light artifacts use the same resolved namespace with the local-only class below.

**Friction policy:** once R3 synthesis exists, autonomous PR delivery is the default under the [Delivery Principle](skill/corvus-review-extras/SKILL.md#delivery-principle); recoverable gaps proceed with a note and available evidence. A `refuse_delta: true` verdict is retained and disclosed while the requested review proceeds once; only a trusted invocation supplies `force_delta`. Frontmatter defaults to allow; review prompts retain read-only shell discipline, and coordinators may perform small read-only checks directly. Interactive authorization, containment, owned-state writes, the tool-side writer caller check and the post tool's head/artifact checks remain required; recovery never grants missing authority or an alternate posting endpoint. LOCAL never posts, and CLOSED/MERGED at R5 revalidation excludes delivery.

**Token scopes:** `repo` covers reading PRs, diffs and reviews and posting reviews; without suitable repository access, required reads or posting fail (public repositories may use narrower access). `corvus_review_pr` op `identity` owns identity lookup and its 403 fallback; unavailable identity adds an `identity_unknown` notice with `read:user` guidance, not an action cap. `checks:read` (Checks read permission for fine-grained tokens) enables CI verification; without check access, CI is reported unavailable, never assumed passing.

**Notices, not caps:** draft PRs, self-review and unknown authenticated identity produce `state_notices` (`draft_pr`, `self_review`, `identity_unknown`); state notices do not select the event. Action precedence is **Delivery → Coverage caps → Trusted override → Configured action**. The shipped `default_action: COMMENT_ONLY` still selects COMMENT; `auto` derives the event from findings within coverage caps. GitHub can reject an author's own APPROVE/REQUEST_CHANGES; Corvus reports that rejection rather than silently changing the configured action.

### Light Review and Local Artifacts

Light review uses parallel read-only shards to produce a compact Corvus review with separate Standards and Spec findings. “Light” means a shorter pipeline, not size-based sampling: every eligible changed hunk is assigned for review. It reviews PR-head files in a temporary worktree next to your repository, posts autonomously, and keeps review artifacts local without switching your branch.

Illustrative review body:

> <!-- corvus-review v2 path=.corvus/reviews/pr42 head=1111111111111111111111111111111111111111 round=1 -->
> ## Corvus Light Review — #42 Bound Request Retries
> **COMMENT · `1111111` · 2 files, +18/−4 · Standards 1 · Spec 1 · inline 1**
>
> ## Standards
> **Cap retries on repeated upstream failures.** · 1 major
> - **major** · [`src/retry.ts:42`](https://github.com/owner/repo/pull/42/files#diff-928375adac7dc0d06fed23cc88cb532c2f0b86ef75c55652326b1577a957a169R42) — Enforce the retry limit
>
> ## Spec
> **Preserve the promised cancellation behavior.** · 1 major
>
> **major** (spec/correctness, lsp1-logic-spec-001): Honor cancellation before the next retry
> `src/retry.ts:35` — The PR promises “cancel pending retries,” but cancellation during backoff still sends the next request.
>
> Check the abort signal before issuing the next request.

One inline comment on `src/retry.ts:42`:

> **major** (standards/correctness, ls1-logic-standards-001): Enforce the retry limit
> When the upstream keeps returning 503, this loop never reaches its retry limit and the request remains open.
>
> Increment the attempt counter before retrying and stop at the configured limit.

**What you'll see:** during a PR run, a sibling directory `../<repo>.corvus-review-pr<N>-<sha7>-<6hex>` and its `git worktree list` entry appear; `6hex` is the first six hex characters of the runId's SHA-256. Normal cleanup removes both, but an interrupted session can leave them behind. After confirming no active review uses that path, remove a leftover registered tree with `git worktree remove --force '<path>'`; if the directory is unregistered, delete that exact leftover directory and run `git worktree prune`. Creation has a 60-second operation budget, a 256 MiB content limit and a 100,000-file/tree-entry limit (plus 64 MiB per-command output); exceeding a limit falls back to prepared-object reads with a disclosed gap. LOCAL creates no review worktree.

The [light skill](skill/corvus-review-light/SKILL.md) owns the shorter procedure: metadata-first intake → batched reads/shared lock/config/history → tool-owned PR-head sibling worktree → all `pr-light-reviewer` shards in one concurrent foreground batch → compact in-session synthesis and inline-path anchors → candidate/measure/freeze/preview → digest-bound autonomous authorization → live head/base/state revalidation → existing writer → owned-worktree removal → lock release. It loads no R0–R5 skills and writes no review input, document checkpoint, metadata or facts. See the [light call map](docs/CORVUS-REVIEW-SKILL-SET.md#light-call-map) for the structural comparison, not a runtime guarantee.

All shards retain the same protected identity. The Standards brief inspects architecture, correctness and conventions; the Spec/security brief checks stated intent across eligible dimensions and independently detects vulnerabilities, attributed to Standards/security. The orchestrator plans from trusted file names and any available per-file sizes without reading untrusted code: one shard per axis when comfortably reviewable, otherwise cohesive directory/module groups with tests beside their code and docs together. Each changed file belongs to exactly one shard per axis. All shards run in one foreground batch, with no fixed shard/file/line caps or review time limits; shared-lock expiry and restart admission remain safety constraints, not detector time budgets.

Each shard reviews every eligible hunk in its `focus_paths`, using `all_diff_files` by default (meaning all assigned files), and may read other worktree files for context. Only non-reviewable generated/vendored code, lockfiles, binaries, snapshots or minified assets are omitted with reasons; `risk_focus`/`sampled_by_area` require unavailable evidence, never size alone. Supplementary reads have soft value guidance, not a ceiling. `large_pr_threshold`/`large_pr_strategy` stay advisory in light mode; full-pipeline behavior is unchanged. Transport-truncated or HTTP 406/413 diffs use per-file patches; remaining unavailable evidence stays a gap.

Head preparation fetches only through a named Git remote whose `git remote get-url` matches the PR owner/repository, including SSH-configured remotes; direct URLs and paths are denied. Without a matching named remote, light skips fetch and worktree creation, discloses the gap and uses GitHub API reads or available objects. After lock acquisition and successful head-object preparation, `corvus_review_worktree` creates the detached sibling described above. The skill uses the tool-returned path, never a PR-supplied directory. Population reads raw blobs with hooks/filter execution avoided and symlinks stored as regular files; submodules are skipped and reported. Detectors confirm HEAD equals `code_head`, then read files there without running PR code, builds or tests. Inside that tree the only permitted Git command is the HEAD check: other reads such as status/diff could invoke clean filters on its unstatted index. Creation or verification failure falls back to prepared-object reads, with the gap disclosed.

Each report echoes its axis, `shard: k/n` and `focus_paths`, and records strategy, selected scope, discovered/selected/reviewed/omitted/unavailable counts, paths/regions and every supplementary evidence-read attempt, including failures. Unknown counts stay `null`. The orchestrator validates reports without analyzing code; combined coverage uses path/region unions, not overlapping count sums. Findings are unioned per axis; exact duplicates across shards keep the higher severity/confidence. A failed shard preserves the others' valid evidence and adds one Review-limits gap naming uncovered paths, without a rerun. Full inventories and diagnostics stay in the local ledger, alongside `Actual coverage: <approach>; reviewed <n> of <m> files (<lines> changed lines); omitted <k>; unavailable <u>`.

The posted review opens with PR identity, action, head/statistics and axis counts, followed by separate **Standards** and **Spec** sections with one-line assessment headlines. Inline details stay inline; each has a one-line severity/location/title index under its primary axis headline linking to the exact diff line. Range indexes show `path:start–end` and use `Rstart-Rend` links. The orchestrator obtains tool-verified postability and `diff_anchor` from the compact files `anchors` result, moving unpostable findings body-only before freeze; LOCAL has no inline comments or links. Body-only findings retain their full compact Conventional Comments block: at most three short problem/impact lines and one suggestion/fix. Eligible code placements pass through unchanged; PR title/body/description findings stay body-only with intent-source attribution, never proxy code anchors. The writer verifies comment coordinates via the same `anchors` input (up to 50 per call), without fetching patch text even for huge diffs. Unverifiable anchors replace only their index lines with the compact findings in their primary axis body, then renew freeze/preview/authorization.

Light alone merges cross-axis copies of the same defect at overlapping lines of one path, retaining the first ID, highest severity/confidence and `standards+spec` attribution. Shared defects appear once under Standards, count once in both axes and add `(<n> shared)` to Spec's severity counts. Full-review axis separation is unchanged.

Coverage stays internally partial, including zero findings, without a generic reduced-coverage banner. Review limits use at most three short factual bullets for applicable scope/rationale, scope omissions and material gaps; complete inventories stay local. When GitHub omits a patch, the anchors tool can verify a local object diff against stable validated PR head/base SHAs, reporting `source: local`; missing objects or mismatched SHAs leave anchors unpostable and findings in the body. These are anchor checks, not a claim that worktree-based review used object-only reads. Full-review advice needs a named consequential uncovered risk, material evidence gap or complexity requiring deeper coverage, not size or omission alone. Zero findings means none found in reviewed scope, not approval or complete coverage. Evidenced blocker/critical findings survive presentation caps, and light never APPROVEs, even through overrides; shared [action precedence](skill/corvus-review-extras/SKILL.md#fail-closed-precedence) selects COMMENT or eligible REQUEST_CHANGES.

Every retained eligible minor is disclosed with full compact details, inline with its linked axis index when postable or as a body block otherwise. Light ignores `max_minors`; nitpicks are not posted (`max_nits: 0`). The soft inline target is not a cap; `safety_rail_threshold` overflow moves findings into their axis body, never into count-only minor summaries. Full-review filtering limits are unchanged.

For PRs, CLOSED or MERGED at intake stops before lock acquisition, detection or posting. After detection, immediately before every writer dispatch (including recovery), and after writer `head-moved`, light reads metadata first: CLOSED/MERGED stops further work; otherwise a `code_head` or verified base-SHA move starts a fresh bounded pass. Raw-head-only changes with unchanged code head/base are ignored. A restart refreshes metadata, files, diff, review history and head content, reloads config if the base moved, and regenerates findings, artifact, preview and authorization without delta reuse. It retains the shared lock and invocation identity, with fresh-ownership checks after detection and before artifact mutation or writer dispatch.

The bound is three detection attempts total (initial pass plus at most two restarts); each restart re-plans and dispatches all shards on the new head. Further drift stops without posting and names the latest observed head. A restart is also refused if the resolved review root changes or lock age exceeds 90 minutes; lost or unverifiable fresh ownership stops artifact mutation and posting. Other posting failures, including unknown transport, are not restart triggers. The local ledger reports `Detection attempts: N`, one `attempt N: code_head=… base_sha=… worktree=… cleanup=…` line per attempt with full SHAs, and `Terminal reason:`, alongside actual coverage and observed or unmeasured timing. Each invocation reviews the current change set, not a persisted delta; light posts count as rounds, but a later full review takes full scope. Full-review restart and disclosure behavior is unchanged.

On every exit after successful creation, the tool removes only this run's owned worktree and verifies both directory and registration absence before lock release, including after ownership loss or posting failure. Restart removes the old tree after a fresh lock check and before re-creation. Existing or stale-looking Corvus worktrees are reported, never removed or pruned. Cleanup failure is disclosed with the exact path and a manual remedy; failed-create rollback needs manual inspection before removal. No lock admission, intake CLOSED/MERGED and LOCAL create none.

Light tools place candidate, staging and frozen files under `<review-root>/.light/`, sharing the full review's namespace and lock. Light calls sync only to resolve the namespace; `state_sync: true` cannot enable pull/push. Every Corvus state sync excludes this class, including a later or overlapping full review. The light path performs no Git staging, commits or pushes, leaves the branch/index/ignore files untouched, and names the artifact path on completion. **Files may appear untracked**; the agent does not assume they are ignored.

To hide only these local artifacts, optionally add these namespace-scoped lines yourself to this clone's `.git/info/exclude` (not a blanket `.corvus/` exclusion):

```gitignore
.corvus/reviews/*/.light/
.corvus/tasks/*/reviews/*/.light/
```

Git's [pattern rules](https://git-scm.com/docs/gitignore#_pattern_format) make `*` match one path component and the trailing slash match directories only. These patterns hide direct `.light/` children of review namespaces, including task-scoped roots, without excluding full-review head records, candidates or metadata outside that class. The shorter `.corvus/**/.light/` uses `/**/` to match zero or more directories, so it also hides non-class directories such as a task named `.light`; prefer the scoped patterns above. Existing tracked files are unaffected; the scoped exclusion does not disable full-review state commits.

One visible shared-lock consequence remains: if the root already had a committed `lock.yaml`, delete-mode light cleanup can leave ` D <review-root>/lock.yaml` in status. Leave that deletion out of your commits; after the run, restore it yourself with `git restore -- <review-root>/lock.yaml` if desired. The retained `.light/` selector makes sync exclude that root's `lock.yaml` and `.lock` records too, protecting both active lock bytes and tracked deletions. Other full-review state remains sync-eligible. [ADR-0007](docs/decisions/0007-light-review-single-detector-shared-namespace.md) records the design trade-off.

### Workflow

The diagram and feature list below describe the full R0–R5 pipeline; light uses the separate procedure above.

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
R2: Two-Axis Review [parallel]
    ├── Standards: architecture + correctness + conventions (@pr-code-reviewer, read-only)
    └── Spec across eligible dimensions + independent security (@security-reviewer, read-only)
        → separate axis results; four projected dimension-status slots
    │
    ▼
R3: Axis-Local Synthesis (dedup, filter, severity, coverage caps, notices)
    │
    ▼
R4: Stage → measure → freeze (fit if oversized) → preview → authorization
    → approved artifact descriptor + SHA-256
    │
    ▼
R5: Descriptor-only dispatch to @pr-comment-writer for file-input posting, or local-only completion
```

### Key Features

- **Two independent axes** — Standards checks repository rules and the Fowler baseline; Spec checks requirements. The security specialist also detects vulnerabilities without a spec. Axis is separate from dimension; four projected `pass_results` slots retain coverage status, while findings are never merged or reranked across axes
- **Dedicated security agent** with OWASP Top 10 and CWE knowledge base
- **Aggressive false-positive filtering** with confidence scores and nit budget enforcement
- **Conventional Comments format** for consistent, actionable feedback
- **Trusted configuration** from `.opencode/review-config.yaml` at the PR's verified immutable base SHA, with safe built-in fallback and visible provenance
- **Delta re-reviews** — a hidden review marker records the reviewed commit; R0 collects prior-review `dispositions`, R1 verifies them against the diff, and both axes use them to skip resolved findings, check prior blockers, and focus on verified changes; unavailable delta evidence falls back to a full review. Posts pin to the reviewed head SHA (`commit_id`) behind a pre-post drift guard
- **Review-role separation** — untrusted PR content is analyzed by R2 reviewers with edit/write denied and read-only prompt obligations; `@code-quality` remains on the implementation-validation path
- **Interactive and autonomous modes** — preview before posting, or let it run hands-free
- **Artifact posting** — R4 freezes `post-request.json`, previews its decoded body/comments, then binds authorization to its SHA-256; R5 sends only the descriptor. The writer checks controls, head, anchors and an existing marker; `corvus_review_post` verifies the artifact internally before its GET and every POST, submitting unchanged file bytes
- **Automatic size fitting** — freeze fits every schema-valid over-budget candidate into a bounded summary with no inline comments, retained marker/notices and per-axis headlines (or a leading-summary anchor), plus exactly one `Review limits: N findings omitted for size` footer. No model size loop or size-based no-post remains; the preview shows the actual fitted artifact and labels the full `REVIEW_DOCUMENT` as local evidence
- **Just-in-time context gathering** — no pre-built index needed, works on any repo

The plugin exposes [eight review tools](docs/CORVUS-REVIEW-SKILL-SET.md#posting-by-artifact), including the light-only worktree lifecycle; models never edit review-state files. `corvus_review_persist` stages documents, input and candidates via `begin` → `append` → `finalize`. Large candidates split the body and each comment's `path`/`body` losslessly, keeping complete serialized calls ≤6,000 characters including JSON escaping. Candidate staging is independent of document-checkpoint success. `corvus_review_payload` owns `measure`, `freeze` and read-only `preview`; the [fitting contract](skill/corvus-review-extras/state.md#freeze-at-r4) defines `fitted`, `omitted` and the footer count. In-budget canonical bytes stay unchanged.

The writer preflights only `corvus_review_pr` and `corvus_review_post`, then follows descriptor validation → controls/head/anchor reads → marker lookup → post → result mapping. Writer PR reads are limited to `head`/`diff`/`files`/`reviews`. Post resolves workspace-relative artifact paths against the host session directory, not the process cwd; absolute paths still work, with traversal/outside-root/symlink escapes rejected. `artifact-verify-failed:*` maps to writer `not_posted` / `verify: <diagnostic>` and [R4 artifact repair](skill/corvus-review-r4/SKILL.md#artifact-repair): re-stage → measure → freeze → preview → re-authorize. There is no standalone verification call or one-shot re-freeze ritual.

On the full path, checkpoint, verdict, metadata and sync calls stay in place as best-effort bookkeeping, never posting prerequisites. Checkpoint failure retains in-memory synthesis for delivery. The [bookkeeping audit](docs/CORVUS-REVIEW-SKILL-SET.md#bookkeeping-and-audit-evidence) accepts consistent evidence or disclosed unavailability, fails undisclosed failures and forged success distinctly, and accepts explicitly labelled synthesis counts when verdict counts are unavailable. Disclosure requires a final assistant note naming the operation and its diagnostic (or explicitly saying no diagnostic exists), including when failure metadata itself could not be written.

Capability failures preserve any complete checkpoint and invocation mode. Say `post` to restart R0, revalidate head/base/config, resume compatible unchanged-head synthesis, and renew measurement, freeze, preview and authorization; interactive posting requires question. Use `@corvus-review-auto` deliberately for question-free posting. A confirmed GitHub POST rejection is reported as such; unknown transport uses [R5 read-only reconciliation](skill/corvus-review-r5/SKILL.md#reconcile-writer-transport), with one additional identical-descriptor writer dispatch only after complete listings prove absence. Missing tool storage or source evidence is disclosed, never repaired with manual writes or invented content.

### Configuration

```yaml
# .opencode/review-config.yaml at the PR's verified base SHA
severity_threshold: "nitpick"
# See the review config reference for cap allocation and validation.
max_nits: 3
max_minors: 6
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

> 📖 **Detailed Documentation**: See [docs/CORVUS-REVIEW-SKILL-SET.md](./docs/CORVUS-REVIEW-SKILL-SET.md) for the review pipeline map and links to the authoritative skills, configuration, schemas, and Conventional Comments specification.

### Convergence and calibration

Review rounds distinguish document counts from the `converged` verdict and human-approval recommendation; [Convergence and Continuation](skill/corvus-review-extras/SKILL.md#convergence-and-continuation) owns the predicate, optional concise `post_converged_summary` presentation, and proceed-with-note continuation with trusted-only `force_delta` input. Convergence does not suppress delivery or override the event. [Configuration](skill/corvus-review-extras/config.md) owns shared nit/minor totals, [R3](skill/corvus-review-r3/SKILL.md) owns allocation and review-fix/delta polish filtering, and [R2](skill/corvus-review-r2/SKILL.md) owns delta scope and the merge-blocking Fowler baseline. [Finding origin](skill/corvus-review-extras/schemas.md#finding) is lineage evidence, not inferred fix intent; [state](skill/corvus-review-extras/state.md) retains local and posted outcomes without changing invocation mode.

---

## Upgrading from 0.9 to 0.10

- **Models** — Distinct `task-planner` and `plan-reviewer` models are optional and preferred. Without distinct overrides, review proceeds with a visible same-model degraded warning; see [Cross-model plan review](#cross-model-plan-review-recommended) for both hosts' configuration.
- **Plans** — Legacy `MASTER_PLAN.md` and task files remain read-only. Resume or follow-up runs task-planner's `AMEND_PLAN copy-forward` into a fresh `PLAN.md`, preserving requirements, history and remaining work. Its `DISCOVERY.md` companion persists discovery evidence and environment context; see [amendments](agent/task-planner.md#amend_plan) and [discovery](agent/task-planner.md#discovery-companion).
- **Tests** — Replace the old flags using this mapping:

| 0.9 `tests_enabled` | 0.9 `tests_deferred` | 0.9 `test_scope` | 0.10 `tests` |
|---------------------|----------------------|------------------|--------------|
| `true` | `true` | Any | `deferred` |
| `false` | Any | Any | `none` |
| `true` | `false` | Any | `deferred` |

The per-phase test run is gone: deferred coverage is authored during implementation and executed at final validation; `none` neither authors nor runs tests. See [Tests policy](skill/corvus-phase-2/SKILL.md#tests).

- **Review** — Finding IDs are `<dim>-<axis>-NNN` (`arch`, `logic`, `conv`, `sec`; `standards` or `spec`). Standards and Spec stay separate through synthesis; see [Convergence and calibration](#convergence-and-calibration) for finding caps and series policy. Posting uses a persisted artifact plus SHA-256, not retyped review text. Prior-review `dispositions` carry evidenced fixed/declined/open/unknown states to both axes; see the [review reference](docs/CORVUS-REVIEW-SKILL-SET.md).
- **Prompt tests** — The byte-pin test is removed. Contributors use [`prompt-budgets.json`](prompt-budgets.json) and [`src/__tests__/prompt-structure.test.ts`](src/__tests__/prompt-structure.test.ts) for budgets and structural contracts, alongside prose review.

See [CHANGELOG](CHANGELOG.md#0100-beta0--2026-09-09) for breaking changes and review-round-1 fixes.

---

## Project Structure

```
.
├── agent/                  # Agent definitions (18 agents)
│   ├── corvus.md           # Implementation orchestrator
│   ├── corvus-auto.md      # Autonomous implementation orchestrator
│   ├── corvus-review.md    # PR review orchestrator
│   ├── corvus-review-auto.md # Autonomous PR review orchestrator
│   ├── corvus-review-light.md # Autonomous reduced-coverage PR review
│   ├── security-reviewer.md  # Spec review and independent security analysis
│   ├── pr-context-gatherer.md # PR context gathering
│   ├── pr-code-reviewer.md    # Read-only Standards-axis PR detection
│   ├── pr-light-reviewer.md   # Protected identity for concurrent axis shards
│   ├── pr-comment-writer.md   # GitHub review posting
│   └── ...                 # (8 more agents)
├── command/                # Custom slash commands (4 commands)
├── skill/                  # On-demand skills (19 skills)
│   ├── corvus-phase-*/     # Corvus workflow phases (7)
│   ├── corvus-phase-4/reference/ # Dispatch, fix-loop, and transport procedures
│   ├── corvus-phase-7/remediation.md # Review-fix round policy
│   ├── corvus-review-*/    # PR review skills (8: phases, extras, light)
│   ├── corvus-review-extras/{config,interactive,schemas,state}.md # Shared references
│   └── *.../               # Utilities (corvus-extras, frontend-design, deep-research, web-search)
├── src/                    # Plugin source code
├── docs/                   # Detailed documentation
│   ├── decisions/          # Architecture decision records and convention
│   ├── CORVUS-STATE-MACHINE.md
│   └── CORVUS-REVIEW-SKILL-SET.md
├── AGENTS.md
├── NOTICE                  # Third-party attribution
├── prompt-budgets.json     # Repo-time structural prompt contract
└── README.md
```

See [AGENTS.md](./AGENTS.md) for delegation instructions and [docs/CORVUS-STATE-MACHINE.md](./docs/CORVUS-STATE-MACHINE.md) for the workflow diagram and phase-skill pointers.

---

## Development

The published package keeps optional `@opencode-ai/plugin` peer compatibility broad (`*`). Contributor installs pin two development SDKs: `@opencode-ai/plugin@1.18.3` for v1 and stable `@opencode/plugin@2.0.20` for v2. The v2 SDK is a dev-only, type-only dependency, not a runtime import. These type baselines are distinct from the verified host versions listed under [OpenCode v2](#opencode-v2).

```bash
# Install dependencies
bun install

# Build
bun run build

# Type check production and tests
bun run typecheck
bun x tsc --noEmit -p tsconfig.test.json

# Run tests (build first; build.test.ts consumes dist/)
bun test
```

### Release Gates

#### Host Selection And Isolation

Select each installed host by absolute path, using `--opencode-bin` or `CORVUS_SMOKE_OPENCODE_V1` / `CORVUS_SMOKE_OPENCODE_V2`; the flag wins. Without either selector, the harness warns and falls back to PATH lookup. Each harness prints the resolved realpath and reported version and rejects a major-version mismatch before packaging or model execution. `@opencode/cli@2.0.20` installs both `opencode` and `opencode2` bin names: keep that install off PATH beside v1 so it cannot shadow the v1 executable.

Set `CORVUS_SMOKE_TMP_ROOT` to choose the temporary parent. Harnesses isolate XDG directories and service ports, then compare live-config/global-install digests from before host use to after cleanup; unreadable or changed snapshots fail. The measured paths include `~/.config/opencode`, `~/.opencode/opencode.json(c)`, inherited XDG config, the configured global CLI roots and selected executable (see `scripts/host.sh`). Equality is evidence for that run's measured interval, not complete machine isolation: HOME is not redirected, so the host still sees `~/.agents/skills` and inherited AWS resolution.

#### Deterministic V2 Gates

After building, run the modes used for stable-host verification below. Replace the example absolute paths with your installed binaries; keep the same selectors for the review gates.

```bash
export CORVUS_SMOKE_TMP_ROOT=/abs/corvus-smoke
export CORVUS_SMOKE_OPENCODE_V2=/abs/oc2-2.0.20/node_modules/.bin/opencode2
export CORVUS_SMOKE_OPENCODE_V1=/abs/v1/opencode

bash scripts/smoke-v2.sh --full --host v2 --opencode-bin "$CORVUS_SMOKE_OPENCODE_V2"
bash scripts/smoke-v2.sh --refs --host v2 --opencode-bin "$CORVUS_SMOKE_OPENCODE_V2"
bash scripts/smoke-v2.sh --tarball --host v2 --opencode-bin "$CORVUS_SMOKE_OPENCODE_V2"
bash scripts/smoke-v2.sh --negative-control --host v2 --opencode-bin "$CORVUS_SMOKE_OPENCODE_V2"
```

- Default mode boots the real v2 host with the local-directory plugin. `--full` also asserts all 18 agents, 4 commands, 19 skills with absolute `path`s, and the default MCP server. Skill records retain both `location` and `path`; see [0.10.1](CHANGELOG.md#0101--2026-09-30) for contributor credit.
- `--refs` checks host-registered permission maps through the local matcher and probes all eight review tools through built bundles and fake host contexts; `--full` includes these probes. Their `fake/local probe` labels distinguish them from real-host registration assertions and model execution.
- `--tarball` packs and installs the working tree for npm-specifier resolution emulation; it does not boot a host, and `--full` / `--refs` are inert in that mode. `--registry <spec>` is a post-publish real-host check only, never evidence for unpublished local changes.
- `--negative-control` strips skill `path` in a temporary copy. Expect exit 1 at the named plugin-state assertion, not a passing gate; the repaired source remains untouched.

The v2 load oracle requires exactly one Corvus server with `state.status == "active"` and `features.server == true` from `GET /api/plugin`, scoped with `x-opencode-directory`. It also requires the log veto: reject `failed to load plugin` or `disabled plugin after transform failure`. An API snapshot can read `active` before a lazy transform fails, so the log check is mandatory, not redundant. The deterministic gate checks state around registration/probes and settles logs afterwards; review preflight checks before model dispatch and audits again after the run. Missing/failed state fails the gate. See `scripts/host.sh`, `scripts/smoke-v2.sh` and `scripts/check-review-artifacts.ts` for the owning guards.

#### Review Gates

With model cost authorized, run the non-posting paid full review on v2, then v1, using the host selection above (`--agent auto` is the default):

```bash
bun run smoke:review --host v2 --opencode-bin "$CORVUS_SMOKE_OPENCODE_V2" --keep
bun run smoke:review --host v1 --opencode-bin "$CORVUS_SMOKE_OPENCODE_V1" --keep
```

This packs the working tree, clones PR #8 by default, uses Bedrock/GitHub authentication and denies writer dispatch through a host permission override. A separate owned, network-free `scripts/probe-gh-shim.sh` sentinel proves the POST barrier with a recording-only forward target and zero forwarded bytes; a live writer POST is not required on the denied route. The shim protects that PATH route, not arbitrary network clients. The checker reads both v1 (`session`/`message`/`part`, consuming `session`/`part`) and v2 (`session_v2`/`session_message`) stores. It audits artifact provenance/digests, measure → freeze → `preview` → authorization, and the offline `built verify()` result. Bookkeeping follows the [evidence-precedence audit](#corvus-pr-review), not checkpoint success as a delivery gate; fitted artifacts add the conditional `size fit` row. An inert frozen artifact does not authorize writer dispatch or POST.

For model-free diagnosis on either host, use `--preflight-host` (pack/install, agents/logs; v2 also boots and checks scoped plugin state); on v2, add `--negative-control` to expect exit 3 for the missing-path copy. `--preflight-only` instead checks host version and intake setup without packaging or booting. Other options include `--agent auto|light`, `--intake url|branch|local` (branch intake is auto-only), `--pr <url>`, `--model <id>` (default `amazon-bedrock/global.openai.gpt-6-astra`), `--timeout-min <minutes>` (default 40) and `--keep`. Consult `bash scripts/smoke-review.sh --help` and `bash scripts/smoke-v2.sh --help` for the flag inventory.

For the non-posting light fixture, separately authorize model cost and supply an OPEN PR URL with `--pr`. The default fixture PR #8 is CLOSED, so light now stops at intake without detection or an artifact; that is terminal-state evidence, not a detection/publication-path run. Replace the example URL with an OPEN PR:

```bash
bash scripts/smoke-review.sh --agent light --host v2 --opencode-bin "$CORVUS_SMOKE_OPENCODE_V2" --pr https://github.com/owner/repo/pull/123 --keep
```

Light mode starts on an unrelated branch with staged/unstaged sentinels and denies writer dispatch while intercepting gh mutations. It writes `<sandbox>/light-metrics.json` with agent-controlled wall clock, child-session count, orchestrator turns, tool-call counts and local-only evidence rows. `--keep` retains those metrics and `result.txt` even on success; live runs copy provider auth into the private sandbox, so do not upload it wholesale and delete it after extracting non-secret evidence. The fixture compares sentinel bytes/index, branch/HEAD, ignore files, worktree registrations and sibling directories; it checks zero state commits/pushes and forwarded mutations. A separate model-free full-review sync probe checks that light files stay out of the resulting state commit. The checker audits both axis briefs, create→dispatch→remove→release ordering, worktree leaks and compact render structure, and labels full-pipeline-only rows by-contract N/A with disclosure. These are harness checks, not proof that a live light run passed.

**Baseline and current evidence:** the 0.11.0-beta.0 light run on PR #15 recorded 35 orchestrator turns, 43 calls, 8m15s orchestrator elapsed and approximately $2.04 total cost (task `corvus-review-light-v2/DISCOVERY.md`, kept in `../.corvus/tasks/`). The current skill targets ≤21 orchestrator turns; its explicit-OPEN-PR, no-restart, single-call-candidate read-through is one mandatory skill load, 19 tool batches and a final summary, or 21 turns—not a live result. The task's `EVIDENCE.md` records the comparison protocol; live metrics for this revision remain **UNVERIFIED**, pending separate cost authorization after final validation. The older full-review history (17 rounds, 27–74 min, about 43 min mean and 69 turns, different repository/model mix) is not a controlled light comparison. No runtime/cost savings or finding-quality parity is claimed.

#### Optional Controlled Comparison

Authorize both runs' costs first. Review the same immutable PR head/base snapshot with full and light paths, using the same host and matching orchestrator/detector/writer model assignments and config. Use LOCAL against the same merge base or writer-denied non-posting mode, and retain artifacts. Exclude approval wait from agent-controlled elapsed time; record child sessions, turns and tool calls alongside elapsed time. Compare findings by severity with human adjudication of correctness and missed defects, not raw finding count. Report source gaps, omissions and the reduced light scope alongside any timings; a result on one snapshot does not establish general savings or parity.

`--writer` / `--full` remains v1-only and was not part of the stable-compatibility live runs. It executes the real writer and requires dispatch after freeze, post after the writer's head read/marker lookup, internal artifact verification by `corvus_review_post`, and the exact POST blocked by the shim with a non-`posted` result and no shell measurement commands. `bash scripts/smoke-writer.sh --opencode-bin "$CORVUS_SMOKE_OPENCODE_V1"` exercises only the writer with canned GitHub reads (still a paid model run) and a review body longer than the host read tool's 2,000-character line limit; `--head-moved` moves the canned head after the writer's check to require the post tool's rejection without a POST.

Historical stable-compatibility full-corpus, refs and tarball checks passed on 2.0.20; the missing-path negative control failed as intended, and the 1.18.33 registration baseline passed. Both full-path live reviews completed model/delegation paths with no writer dispatch and zero forwarded mutations. They are not fully green review gates or light-run evidence: see [Known Issues](CHANGELOG.md#known-issues) for the offline recheck results and remaining model-contract failures. The CLOSED fork fixture did not exercise live posting, successful state pushes, or branch/LOCAL intake. Failures and `--keep` retain logs/artifacts and private sandbox auth; do not upload the whole sandbox. Exit codes: 0 pass, 3 host/plugin/auth, 4 fixture/GitHub read, 5 incomplete review/unexpected denial, 6 posting barrier breach, 124 timeout.

### Safe Local Development

- Treat `.opencode/opencode.jsonc` in a checkout as developer-local OpenCode state. Do not overwrite, copy into the package, commit, or use it as an implicit product input when developing Corvus.
- Product inputs are the checked-in `agent/`, `command/`, and `skill/` prompts plus the plugin source. Manual-install experiments should copy or link only those prompt directories after inspecting the destination.
- Keep local OpenCode configuration changes explicit and separate from source changes. Your configuration is applied last on both hosts, so local hardening does not need to be copied into Corvus defaults.

---

## Troubleshooting

**Plugin not loading** — Check the config entry: v1 reads `"plugin": ["corvus-ai"]`; for v2's plural key, config path and release compatibility, see [OpenCode v2](#opencode-v2). Both expect an array of package specifiers, not a boolean map. Stable v2 logs `Plugin entrypoint not found` for an unresolved entrypoint; use the [load oracle](#deterministic-v2-gates) to distinguish resolution from a later transform failure.

**Agents not appearing** — Make sure `bun install` or `npm install` completed successfully. The package must be present in `node_modules` with its `agent/`, `command/`, and `skill/` directories.

**Skills not found** — Skills are loaded from the package's `skill/` directory at runtime. If you used the manual install method, verify your symlinks point to the correct location (`ls -la ~/.config/opencode/skill/`).

**Duplicate agents** — If you have both the plugin install and manual symlinks active, agents may appear twice. Pick one installation method and remove the other.

---

## License

[MIT](LICENSE) © Nacho F. Lizaur

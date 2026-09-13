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
  - [Agents (16)](#agents-16)
  - [Commands (4)](#commands-4)
  - [Skills (18)](#skills-18)
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

These instructions target OpenCode v1's config layout. On OpenCode v2, install the plugin instead — `npx corvus-ai@beta --v2`, or a `plugins` array entry (see [OpenCode v2](#opencode-v2)) — so the same agents, commands, and skills are registered from the package. The `@beta` tag is required while v2 support ships on the `beta` dist-tag, because `latest` has no `--v2` flag; drop it once v2 reaches `latest`.

### OpenCode v2

Corvus ships one package with two entry points: `dist/index.js` remains the legacy OpenCode v1 function entry, while `dist/server.js` serves both OpenCode 1.18.30+ and OpenCode v2 through the `corvus-ai/server` subpath. The shared entry exports `{ id, server, setup }`: v1 invokes the legacy hook function through `server`, and v2 invokes `setup`. Both register the same 16 agents, 4 commands, 18 skills, and the default `web-research` MCP server.

Install with the CLI, which writes the plural `plugins` key into `$XDG_CONFIG_HOME/opencode/opencode.json` (default `~/.config/opencode`):

```bash
npx corvus-ai@beta --v2
```

The `@beta` tag is required while v2 support ships on the `beta` dist-tag: `latest` is the v1-only release and rejects `--v2` with `Unknown option: --v2`. Drop `@beta` once v2 reaches `latest`.

Or add the entry by hand:

```json
{
  "plugins": ["corvus-ai@beta"]
}
```

An existing v1 `plugin` entry is never rewritten for you: keep the singular key for a v1 host and the plural key for v2.

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

Permission action names moved to the v2 tool names: `bash` → `shell`, `task` → `subagent`, and both `write` and `patch` → `edit`. Rules you write are appended after Corvus's, and because the last matching rule wins, yours decide — with the single exception described under [Protected Agents Under v2](#protected-agents-under-v2). Six actions in Corvus's own corpus have no v2 tool (`list`, `todowrite`, `todoread`, `codesearch`, `lsp`, `doom_loop`); their rules are translated unchanged and are harmless, because `action` is a free-form string.

#### Skill Name Collisions

Corvus registers skills as records keyed by id, so three packaged ids that lack the `corvus-` prefix can collide with a skill of your own: `deep-research`, `frontend-design`, and `web-search`. Your definition wins by host ordering — user skills load after package plugins — and no configuration is needed. Corvus keeps the plain names rather than renaming them, so a collision replaces the packaged skill instead of shadowing it under a second name.

#### Protected Agents Under v2

`pr-code-reviewer`, `security-reviewer`, and `pr-comment-writer` analyze untrusted PR content, so their read-only capability limit is a security boundary rather than a default:

- **Permission boundary — fully enforced.** Corvus registers a `permission.hook("evaluate")` that re-applies the authored rules at request time from its own packaged files. The hook can only tighten: the host resolves its own rules first and Corvus never writes `allow`, so a denial cannot be widened by any configuration. Denials name the boundary — for example, `corvus: pr-code-reviewer is mechanically read-only; edit is denied by the plugin's security boundary.` (illustrative wording; the message itself lives with the code).
- **Prompt immutability — demoted to a presence-only guarantee.** v2 has no configuration hook and no agent field that stays out of reach afterwards, so Corvus can no longer guarantee that a protected agent runs its authored prompt unchanged. A `session.hook("context")` re-appends the authored body when no system part carries it, which restores an absent prompt but cannot remove or override instructions supplied elsewhere. A protected agent can therefore run with extra or contradictory instructions — but never with capabilities Corvus did not authorize, because the capability limit above is what makes "mechanically read-only" true.

`src/v2/enforce-protected.ts` is the owning location for the rationale, host-source citations, and fail directions; this section summarizes it rather than restating it.

### Configuration Precedence

Your configuration wins on both hosts, by different mechanisms.

**OpenCode v1** — Corvus is handed the resolved config in a plugin hook and merges yours over its defaults:

- **Agents and commands are user-last**: Corvus defaults are loaded first, then the pre-existing user record is recursively merged over them. Nested user values win; user arrays, scalars, and `null` replace defaults; user-only and unknown native fields remain available. An `undefined` user value is treated as absent.
- **MCP collisions are preserved exactly**: if the user configuration already has its own `mcp["web-research"]` property, Corvus does not merge, replace, or mutate that value. Only when the property is absent does Corvus add the local default with `command: ["npx", "-y", "web-research-mcp@0.1.0"]`.
- **Skill registration is idempotent**: the resolved absolute Corvus skill directory is appended to `skills.paths` only when that exact path is not already present. Existing entries and their order are preserved.

**OpenCode v2** — there is no configuration hook. Corvus contributes records through registration transforms, and the host applies your agent, command, and skill configuration afterwards:

- **Agents and commands are user-last by host ordering**: Corvus upserts each agent (assigning only the fields its prompt files declare) and registers each command as a function. Your `agents` and `commands` entries are applied after package plugins, so every field you set wins and your permission rules are appended after Corvus's, where last-match-wins makes them decisive. Corvus runs no merge of its own — see [Protected Agents Under v2](#protected-agents-under-v2) for the one boundary that is re-applied at request time.
- **Skills are keyed records**: a skill of yours sharing an id replaces the packaged one, again by host ordering.
- **MCP collisions are preserved exactly**: the `web-research` default is added only when `mcp.servers["web-research"]` is absent. A present entry is left exactly as it is, even when it is disabled or points elsewhere.

These rules apply to the OpenCode configuration Corvus is given by the host. A repository-local `.opencode/opencode.jsonc` is user-local state, not a Corvus package input or a source of plugin defaults.

For Corvus agents only, the plugin preserves any hook-visible output budget (normally already seeded on v1), otherwise sets the smaller of the model output limit and 32,000 tokens; v2 exposes the agent ID but only a model reference, so it falls back to 32,000 without a model-limit clamp and can replace a larger unobservable route/model generation default.

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
  "plugins": ["corvus-ai@beta"],
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

Any agent field can be overridden this way — `model`, `permission`/`permissions`, `temperature` (`request.body.temperature` on v2), and so on. Your config is the last layer to be applied, while omitted Corvus defaults remain available. The v1 and v2 field names differ: see [Agent Overrides Under v2](#agent-overrides-under-v2).

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
| `@security-reviewer` | R2 Spec-axis review plus independent security analysis: OWASP Top 10, CWE, taint analysis |
| `@pr-context-gatherer` | PR-specific context gathering: diffs, dependencies, conventions |
| `@pr-code-reviewer` | Internal mechanically read-only R2 Standards-axis detection: architecture, correctness, and conventions in one invocation |
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

---

## How Corvus Works

Simple requests delegate directly to a specialist without a plan. Planned work follows the [phase map](docs/CORVUS-STATE-MACHINE.md); its links lead to the skills that own each procedure.

### One Plan, Adaptive Effort

The model chooses `depth: quick | standard | deep`, recorded as one `**Depth**` line with a reason in `.corvus/tasks/<feature>/PLAN.md`. Quick narrows discovery and plan prose, standard is the default, and deep widens discovery and checks every touched ADR scope. Every depth retains discovery, the review loop, phase gates, and final validation.

<!-- adapted from mattpocock/skills (MIT) -->
The single plan holds immutable user requirements, acceptance criteria, decisions, unknowns, tasks, gates, and history. Tasks are vertical slices with `blocks:` dependencies and observable done-whens. Implementation paths and code snippets stay out of the plan body; exact file ownership is resolved at dispatch and recorded in its Log. See [Plan Format](agent/task-planner.md#plan-format).

### What Corvus commits to your repo

`.corvus/` is committed to your repo by default: `.corvus/tasks/<feature>/**` contains PLAN.md, DISCOVERY.md, ledgers, and task-scoped `reviews/` state as project memory, not scratch. Keep these records with the product diff so the files, changes, and intent remain traceable. Interactive Corvus lists them in its commit handoff; Corvus Auto includes their exact file paths in opted-in Git delivery and otherwise leaves that commit to you. Keeping Corvus's records local is supported only for local reviews, not the planning/implementation workflow; `delivery_mode: local_only` defers Git delivery rather than opting out of committed planning records. The Corvus repository itself is the exception described in [AGENTS.md](AGENTS.md#planning-records).

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

Corvus PR Review is a multi-pass code review system for pull requests and local changes. It runs two detection children in parallel — Standards (`@pr-code-reviewer`) and Spec plus independent security (`@security-reviewer`) — keeps findings separate by axis through synthesis, and posts formatted PR reviews to GitHub — either interactively with user gates or fully autonomously. LOCAL reviews finish with a saved document and a chat summary, never a post.

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
@corvus-review-auto review this PR    # discover the current branch's PR
@corvus-review review my changes      # LOCAL when no PR is found
```

**Intake precedence:** GitHub PR URL → `owner/repo#N` → `#N`/`N` (resolve the repository) → named branch → auto-find the current branch's PR → LOCAL when no PR is found. Branch discovery uses `corvus_review_pr` op `find`; LOCAL evidence uses op `local`. Missing input is not a stop. Ambiguous candidates use an interactive selection when available, otherwise OPEN first and then greatest PR number, with the choice disclosed.

**LOCAL mode:** review the current worktree's changes against the default-branch merge base, including uncommitted edits. State uses the resolved review root described below: namespace-level `review-input.json` plus `<code_head>/REVIEW_DOCUMENT.md` and `meta.yaml` (`mode: local`, dirty state recorded). The local lock, history-only verdict and head verdict still run. PR identity, repository config, CI checks, prior PR reviews and remote-lock semantics are skipped with notes; built-in defaults plus trusted invocation settings apply. R3 creates no candidate or posting artifact, R4 offers no posting choice, and R5 releases the owned lock and prints the document path and separate axis counts to chat without a writer dispatch. A clean default branch with no PR, no commits ahead and no changes ends with a one-sentence no-work result.

**Review state and layout:** review state is committed by default on the feature branch. `corvus_review_sync` resolves `.corvus/tasks/<task>/reviews/pr<N>/` when the unfiltered changed-file inventory identifies exactly one task, otherwise `.corvus/reviews/pr<N>/`; LOCAL substitutes `local-<branch-slug>` for `pr<N>`. Legacy `<owner>__<repo>__pr<N>` and `local__<repo>__<slug>` roots remain readable through `legacy_root` for one release and are never written again. `.corvus/**` is excluded from review scope. `state_sync: false` skips state pull/push, not PR review posting; sync failures retain local state and proceed with a note. Fork PR state is never pushed, and LOCAL sync requires an upstream.

**Friction policy:** recoverable gaps proceed with a note and available evidence, within existing retry bounds. A `refuse_delta: true` verdict is retained and disclosed while the requested review proceeds once; only a trusted invocation supplies `force_delta`. Reviewers may use frontmatter-granted read-only bash; coordinators may perform small read-only checks directly. A/B safety and artifact-integrity stops remain: missing authority, invalid identity, failed verification and lock-ownership failures do not authorize posting or mutation. Diagnostics never substitute for verification, and POST stays tool-only.

**Token scopes:** `repo` covers reading PRs, diffs and reviews and posting reviews; without suitable repository access, required reads or posting fail (public repositories may use narrower access). `corvus_review_pr` op `identity` owns identity lookup and its 403 fallback; unavailable identity retains the `COMMENT_ONLY` cap with `read:user` guidance. `checks:read` (Checks read permission for fine-grained tokens) enables CI verification; without check access, CI is reported unavailable, never assumed passing.

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
R2: Two-Axis Review [parallel]
    ├── Standards: architecture + correctness + conventions (@pr-code-reviewer, read-only)
    └── Spec across eligible dimensions + independent security (@security-reviewer, read-only)
        → separate axis results; four projected dimension-status slots
    │
    ▼
R3: Axis-Local Synthesis (dedup, filter, severity, shared caps)
    │
    ▼
R4: User Gate or deterministic autonomous rails → approved artifact + SHA-256
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
- **Least-privilege detection** — untrusted PR content is analyzed only by mechanically read-only R2 reviewers; `@code-quality` remains on the implementation-validation path
- **Interactive and autonomous modes** — preview before posting, or let it run hands-free
- **Artifact posting** — R4 persists approved `post-request.json` bytes and their SHA-256; R5 sends only the descriptor. `@pr-comment-writer` verifies digest, schema, current head and anchors before posting from the file; failed verification stays local
- **Just-in-time context gathering** — no pre-built index needed, works on any repo

Review state and transport use plugin tools: `corvus_review_persist` writes input, checkpoint, metadata and candidate files and reads document sections; `corvus_review_lock` acquires/releases ownership; `corvus_review_pr` supplies structured PR reads, with writer access limited to head/diff/files. Models never edit review-state files. `corvus_review_payload` measures the candidate and freezes authorized bytes; `corvus_review_verify` checks them before the writer-only `corvus_review_post` rechecks the artifact/head and submits the unchanged file. Rejection stays local-only/not-posted; uncertainty permits read-only reconciliation, not another attempt. Capability failures preserve any complete checkpoint and invocation mode. Say `post` to restart R0, revalidate head/base/config, resume compatible unchanged-head synthesis, remeasure and authorize again; interactive posting requires question. Use `@corvus-review-auto` deliberately for question-free posting. Missing tool storage or projected source evidence is reported explicitly, never repaired with manual writes or invented content.

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

Review rounds distinguish document counts from the `converged` verdict and human-approval recommendation; [Convergence and Continuation](skill/corvus-review-extras/SKILL.md#convergence-and-continuation) owns the predicate, local-only default, optional `post_converged_summary`, and proceed-with-note continuation with trusted-only `force_delta` input. [Configuration](skill/corvus-review-extras/config.md) owns shared nit/minor totals, [R3](skill/corvus-review-r3/SKILL.md) owns allocation and review-fix/delta polish filtering, and [R2](skill/corvus-review-r2/SKILL.md) owns delta scope and the merge-blocking Fowler baseline. [Finding origin](skill/corvus-review-extras/schemas.md#finding) is lineage evidence, not inferred fix intent; [state](skill/corvus-review-extras/state.md) retains local and posted outcomes without changing invocation mode.

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
├── agent/                  # Agent definitions (16 agents)
│   ├── corvus.md           # Implementation orchestrator
│   ├── corvus-auto.md      # Autonomous implementation orchestrator
│   ├── corvus-review.md    # PR review orchestrator
│   ├── corvus-review-auto.md # Autonomous PR review orchestrator
│   ├── security-reviewer.md  # Spec review and independent security analysis
│   ├── pr-context-gatherer.md # PR context gathering
│   ├── pr-code-reviewer.md    # Read-only Standards-axis PR detection
│   ├── pr-comment-writer.md   # GitHub review posting
│   └── ...                 # (8 more agents)
├── command/                # Custom slash commands (4 commands)
├── skill/                  # On-demand skills (18 skills)
│   ├── corvus-phase-*/     # Corvus workflow phases (7)
│   ├── corvus-phase-4/reference/ # Dispatch, fix-loop, and transport procedures
│   ├── corvus-phase-7/remediation.md # Review-fix round policy
│   ├── corvus-review-*/    # PR review phases (7)
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

### Release Gates

After building, run `bun run smoke:review --host v2`, then `bun run smoke:review --host v1 --full`. This paid, real-model gate packs the working tree, clones PR #8 by default, isolates host state, and requires review artifacts plus measure → freeze → verify. By default the writer dispatch is denied by a host permission override; with `--writer` (included in `--full`, v1 only) the real `pr-comment-writer` executes and the gate requires its own `corvus_review_verify` call, one `corvus_review_post` call whose exact `POST` reaches the read-only `gh` shim and is blocked, no shell measurement commands, and a non-`posted` result. It uses Bedrock/GitHub authentication without logging credentials; the shim blocks posting through that route, not arbitrary network clients. Options: `--pr <url>`, `--model <id>` (default `amazon-bedrock/global.openai.gpt-6-astra`), `--timeout-min <minutes>` (default 40), `--writer`/`--full`, and `--keep`. `bash scripts/smoke-writer.sh` runs only the writer against canned PR reads (no network) for a fast tool-path check with a review body longer than the host read tool's 2,000-character line limit; `--head-moved` moves the canned head after the writer's own check so the gate asserts the post tool's `head-moved` rejection with no POST issued. Failures always retain logs/artifacts and private sandbox auth; do not upload the whole sandbox. Exit codes: 0 pass, 3 host/plugin/auth, 4 fixture/GitHub read, 5 incomplete review/unexpected denial, 6 posting barrier breach, 124 timeout.

### Safe Local Development

- Treat `.opencode/opencode.jsonc` in a checkout as developer-local OpenCode state. Do not overwrite, copy into the package, commit, or use it as an implicit product input when developing Corvus.
- Product inputs are the checked-in `agent/`, `command/`, and `skill/` prompts plus the plugin source. Manual-install experiments should copy or link only those prompt directories after inspecting the destination.
- Keep local OpenCode configuration changes explicit and separate from source changes. Your configuration is applied last on both hosts, so local hardening does not need to be copied into Corvus defaults.

---

## Troubleshooting

**Plugin not loading** — Check the plugin entry in your OpenCode config (`~/.config/opencode/opencode.json`, or a project-local `.opencode/opencode.json`). Both hosts expect an ARRAY of package specifiers rather than a boolean map: v1 reads `"plugin": ["corvus-ai"]` and v2 reads `"plugins": ["corvus-ai@beta"]`.

**Agents not appearing** — Make sure `bun install` or `npm install` completed successfully. The package must be present in `node_modules` with its `agent/`, `command/`, and `skill/` directories.

**Skills not found** — Skills are loaded from the package's `skill/` directory at runtime. If you used the manual install method, verify your symlinks point to the correct location (`ls -la ~/.config/opencode/skill/`).

**Duplicate agents** — If you have both the plugin install and manual symlinks active, agents may appear twice. Pick one installation method and remove the other.

---

## License

[MIT](LICENSE) © Nacho F. Lizaur

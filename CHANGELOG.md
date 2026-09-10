# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.10.0-beta.0 — 2026-09-09

### Breaking

- The plan-type question is removed. The model proposes `depth: quick | standard | deep`
  as an effort dial, user-overridable at the single approval gate; depth never skips
  discovery, review, or required gates (ADR-0001).
- `MASTER_PLAN.md`, task files, `CONTEXT.md`, and `specs/` are replaced by one `PLAN.md`
  per feature. Legacy plans remain read-only; resume and follow-up copy relevant
  requirements, history, and remaining work forward into a fresh plan (ADR-0001).
- The `tests_enabled`/`tests_deferred`/`test_scope` triad collapses to
  `tests: deferred | none`, defaulting to deferred execution at final validation (ADR-0001).
- The byte-pin test `src/__tests__/prompt-contracts.test.ts` is deleted in favor of
  `src/__tests__/prompt-structure.test.ts` and the root `prompt-budgets.json`
  structural contract (ADR-0001, ADR-0002).

### Added

- ADRs under `docs/decisions/`, with records written only when all three conditions
  hold: hard to reverse, surprising without context, and the result of a real
  trade-off. Accepted records change through superseding ADRs (ADR-0001).
- Cross-model whole-plan review: `REJECT` → `PLAN_FIX` → automatic re-review until
  `OK`, with no round cap. A stall guard surfaces unchanged findings as unresolved
  and holds execution rather than treating them as `OK` (ADR-0001).
- Vertical-slice tasks with `blocks:` edges and frontier dispatch, resolving
  disjoint parallel file ownership at dispatch time (ADR-0001).
- Two-axis PR review: parallel Standards and Spec review, a pasted Fowler smell
  baseline, and axis-preserving aggregation without cross-axis merging or reranking
  (ADR-0001).
- Packaged root `NOTICE` with MIT attribution for text adapted from
  mattpocock/skills, alongside attribution comments at adapted passages (ADR-0002).
- Structural prompt test with per-class budgets, frontmatter and heading checks,
  dispatch and identity contracts, a prohibition ceiling, and stated-once checks
  (ADR-0002).

### Changed

- All 38 prompt entries are rewritten to the ADR-0002 authoring standard; the
  corpus shrinks from 13,762 to ~4,898 lines including sibling reference files.
- `docs/CORVUS-STATE-MACHINE.md` becomes a 61-line diagram and navigation map with
  pointers to the phase skills (ADR-0001).
- requirements-analyst adopts design-tree grilling: whole-frontier question batches
  with recommended answers, agent-led fact-finding, and user decisions, retaining
  the three-round cap and recording unresolved decisions as assumptions (ADR-0001).
- The `[ux]` task tag replaces `requires_ux_dx_review` for routing subjective review.

### Removed

- Plan-type taxonomy and the /16 recommendation rubric (ADR-0001).
- Phase 3.5 verdict tiers, finding categories, changed-lines manifests, REJECT
  budget, and carve-out (ADR-0001).
- Validation Commands blocks from agent and skill prompts (ADR-0001).
- Planner-assigned workstream tags, replaced by dependency edges (ADR-0001).

### Fixed

Review round 1:

- Same-model plan review now proceeds with a visible degraded warning; distinct
  planner/reviewer models remain preferred (R1-B1).
- Agent skill references respect tool access; the posting writer carries its closed
  schemas inline instead of depending on an inaccessible skill reference (R1-B2).
- R4 freezes approved review bytes and SHA-256; R5 sends only the artifact descriptor,
  and the writer verifies and posts from the unchanged file (R1-B3).
- `AMEND_PLAN` adds phases or scoped fixes and copies legacy plans forward without
  modifying sources; `DISCOVERY.md` persists evidence for resume (R1-M1, M4, M5).
- Plan-review stalls use defect-key sets and full round history, detecting reworded
  repeats and oscillation rather than comparing fix prose (R1-M3).
- Frontier dispatch resolves file ownership through code-explorer, serializes overlaps,
  and escalates out-of-scope production gaps on initial and fix reports (R1-M2).
- Prior-review dispositions reach both axes; concrete security indicators, safety pins
  and closed permission boundaries are restored or hardened (R1-M6–M9).
- Review docs and upgrade guidance now describe both axes, per-axis caps and artifact
  posting; ADR-0002 records the canonical-template planner budget exception (R1-M10, M12, M13).

- Review round 2 (external): 10 minor consistency fixes — host-config path resolution, `AMEND_PLAN add-fix-tasks` for production gaps, REVIEW HISTORY reset on Request Changes, `REVIEW_INPUT` schema, `review_mode` token, docs
- Review round 3 (external): AMEND_PLAN dispatch template homed in the phase-7 skill; `unchanged_code_min_severity` consumer rule; `.jsonc` config path
- Review round 4 (user-reported): review orchestrators can materialize the validated PR head with detached checkout, preserving named branches and falling back to inline evidence on failure (R4-1).
- Review round 4 (user-reported): hard review size budgets (24k body / 4k inline / 48k serialized, characters and UTF-8 bytes), deterministic R3 overflow preserving blockers/criticals, and R4 read-back verification before hashing (R4-2).

### Known Limitations

- The structural test validates prompt shape, not prose meaning or behavioral
  correctness; it does not replace review of prompt changes (ADR-0002).
- `prompt-budgets.json` is a repo-time contract consumed by the structural test,
  not a runtime dependency; it is not included in the published package.

## 0.9.0-beta.0 — 2026-09-05

First release with OpenCode v2 support. Corvus loads on OpenCode v2 (`opencode2`
v0.0.0-beta-19086) and OpenCode v1 (1.18.x) from the same package, registering
the same 16 agents, 4 commands, 18 skills, and the default `web-research` MCP
server on both hosts.

### Added

- Second entry point for OpenCode v2: `dist/server.js` exports the object shape
  v2 requires (`{ id, setup }`), because v2 rejects v1's default async function
  with `Expected object at ["default"]`. The v2 host resolves it through the
  `corvus-ai/server` subpath, and a root `server.js` shim re-exports it for
  local-directory plugin entries, which ignore `exports` entirely. `dist/index.js`
  remains the v1 entry with unchanged behavior.
- Registration through v2 transforms. v2 has no `config` hook, so agents,
  commands, skills, and the MCP server are contributed via
  `ctx.agent`/`command`/`skill`/`mcp`.`transform`. Registration is
  all-or-nothing: if any registrar fails, the ones that already ran are unwound
  in reverse order and the host reports a failed load rather than a partially
  registered corpus. Every transform is idempotent, because the host replays them
  on config reload.
- Commands are registered as functions, which is what v2 accepts in place of v1's
  template strings. Corvus ports the host's own template bridge: the optional
  `agent`/`model` switch, `$ARGUMENTS` and `$N` substitution, and `` !`cmd` ``
  shell interpolation, then a session prompt that preserves the attachments,
  mentions, and metadata of the invocation.
- Translation of the packaged corpus to the v2 schema: `prompt` → `system`,
  `temperature` → `request.body.temperature`, and the `permission` map or scalar
  → an ordered `permissions[]` rule list, including the tool renames `bash` →
  `shell`, `task` → `subagent`, and `write`/`patch` → `edit`. Permission rules
  are appended rather than assigned, so the host's own baseline allows survive.
- Installer support for v2: `npx corvus-ai@beta --v2` writes the plural `plugins`
  key into `$XDG_CONFIG_HOME/opencode/opencode.json` (default
  `~/.config/opencode`). An existing singular v1 `plugin` key is never rewritten
  for you. The `@beta` tag is required while v2 ships on the `beta` dist-tag,
  because `latest` predates `--v2` and rejects it; drop `@beta` once v2 reaches
  `latest`.
- `OpenCode v2` README section covering the v2 install, the config key renames
  (`plugin`→`plugins`, `agent`→`agents`, `command`→`commands`,
  `skills.paths`→`skills`, `mcp.<name>`→`mcp.servers.<name>`,
  `permission`→`permissions`), the renamed agent-override fields, skill-name
  collisions, and the protected-agent guarantees.
- `scripts/smoke-v2.sh`, a hermetic harness that gates the built plugin against
  the real `opencode2` binary. It runs under isolated XDG directories on a
  verified-free service port, and `--full` asserts that the whole packaged corpus
  reached the host — all 16 agents, 4 commands, 18 skills, and the
  `web-research` MCP server. A `--tarball` mode packs and installs the package
  into an isolated project to exercise the `corvus-ai/server` subpath resolution
  that local-directory entries bypass.

### Changed

- Protected agents (`pr-code-reviewer`, `security-reviewer`,
  `pr-comment-writer`) are enforced on v2 by a `permission.hook("evaluate")` that
  re-applies the authored rules at request time from Corvus's own packaged files.
  The hook can only tighten, never widen: Corvus never writes `allow`, so no
  configuration can loosen a denial on the agents that ingest untrusted PR
  content.
- Corvus performs no configuration merge on the v2 path. v1's user-wins deep
  merge is unnecessary there because host ordering already applies your agent,
  command, and skill configuration after package plugins.
- `command/summary.md` no longer carries `mode` and `temperature`, which are not
  command fields on either host and were silently dropped at load; the
  prompt-corpus contract test now keeps them out of `command/*.md`.
- The four non-executable `` !`…` `` sites in `command/readme.md` and
  `command/git-commit.md` were rewritten so shell interpolation no longer trips
  over placeholder-bearing and prose occurrences.

### Known Limitations

- Prompt immutability is demoted to a presence-only guarantee on v2. v2 has no
  configuration hook and no agent field that stays out of reach after
  registration, so a protected agent can run with extra or contradictory
  instructions. A `session.hook("context")` re-appends the authored body when no
  system part carries it, which restores an absent prompt but cannot remove or
  override instructions supplied elsewhere. The capability limit above is
  unaffected, and it is what makes "mechanically read-only" true. v1 keeps the
  full deep-replace guarantee.
- `dist/server.d.ts` carries a type-only `import type { Plugin } from
  "@opencode-ai/plugin-v2"`, and that specifier is an alias local to this
  repository's devDependencies. TypeScript consumers who import types from
  `corvus-ai/server` therefore cannot resolve it. Runtime is unaffected —
  `dist/server.js` contains zero `@opencode-ai` imports, deliberately, so that
  the beta v2 SDK never becomes a runtime dependency of v1 hosts.
- Six permission actions in Corvus's corpus have no v2 tool (`list`,
  `todowrite`, `todoread`, `codesearch`, `lsp`, `doom_loop`). Their rules are
  translated unchanged and are harmless, because `action` is a free-form string.
- Three packaged skill ids lack the `corvus-` prefix and can collide with your
  own (`deep-research`, `frontend-design`, `web-search`). Your definition wins by
  host ordering, and no configuration is needed.
- On OpenCode v2, a malformed `agent/*.md` frontmatter aborts the whole Corvus
  load (fail-closed) rather than skipping the one bad file, because the parse step
  lives in the loader shared with v1. Per-file isolation applies to translation
  and validation failures only.
- Pre-existing v1 installer behavior: `npx corvus-ai --migrate --dry-run` writes
  the plugin entry when there are no manual files to remove, instead of only
  previewing it. It is unchanged for v1, which is frozen, and fixed on the `--v2`
  path.

## 0.8.0 — 2026-09-04

Stable release of the `0.8.0-beta.0` … `0.8.0-beta.22` line. Inventory is now
16 agents, 4 commands, and 18 skills (38 prompt files).

### Added

- `pr-code-reviewer` agent: a mechanically read-only PR review child covering the
  architecture, correctness, and conventions dimensions in one holistic
  invocation (agent count 15 → 16).
- Protected-agents guard: `pr-code-reviewer`, `security-reviewer`, and
  `pr-comment-writer` keep the plugin's `permission` and `prompt` via
  deep-replace, so repo-local configuration cannot widen the security-boundary
  agents that ingest untrusted content.
- User and project configuration now deep-merges over the plugin's agent
  defaults (user-wins), with idempotent skill-path registration and preservation
  of user-defined `web-research` MCP entries.
- Workstream batching: Phase 4 dispatches one `code-implementer` per workstream
  of 1–5 dependency-ordered tasks instead of one per task, with per-task
  validation, per-task fix budget, and PASS/FAIL/BLOCKED partial-failure
  reporting.
- Per-feature `CONTEXT.md` discovery artifact, so downstream dispatches point at
  persisted discovery instead of re-pasting context.
- Learnings loop: reusable defect classes are distilled to
  `.corvus/tasks/learnings.md` and consumed by planning and plan review.
- Cross-session resume for both pipelines: in-progress `MASTER_PLAN`s are
  detected at intake, and synthesized-but-unposted reviews persist under
  `.corvus/reviews/` keyed by PR and head SHA.
- `REMEDIATION_LEDGER.md` per feature with a hard gate before remediation
  dispatches, blocking repeat symptom fixes in favor of root-cause analysis.
- Root-cause-first Defect-Fix Protocol for `code-implementer`: trace before
  editing, classify root-cause fix vs symptom patch, enumerate the defect class,
  and demonstrate the defect at the root-cause level.
- `test_scope` (`targeted` | `full` | `none`) on test-capable dispatches, with
  documented run-count budgets per plan type.
- New review configuration keys: `default_action` (`COMMENT_ONLY` | `auto`,
  default `COMMENT_ONLY`) and `max_minors` (default 10).
- Per-PR persisted `verified_facts.yaml` and open questions, reloaded each review
  round.
- `prompt-contracts.test.ts`: a contract suite pinning the frozen inter-agent
  string contracts across all prompt files, plus a consumer-contract test
  asserting every entry-module export is a function.

### Changed

- Phase 3.5 plan review is now mandatory and automatic in interactive mode; the
  flow is Phase 2 → automatic review loop → a single Phase 3 approval that
  presents the plan together with the review outcome.
- PR review R2 collapses four dimension passes into two parallel children (the
  holistic reviewer and the dedicated security reviewer); findings still fan out
  into the four result slots, so downstream gates and surfaces are unchanged.
- Review retrieval is diff-first: diff hunks plus a structured context map travel
  in the review input, and reviewer local reads are provenance-flagged.
- Delta re-reviews: prior findings are supplied with don't-repeat and delta-focus
  instructions; a force-push degrades to a full review with a note.
- Head-SHA pinning end to end: the review marker and post request carry the head
  SHA/`commit_id`, and the writer's drift guard is SHA equality.
- Nitpick-grade findings are non-actionable by definition — reported as
  take-or-leave comments that never derive an action or block convergence; all
  reporting surfaces show `N total | X actionable | Y nitpicks`.
- Phase 0a requirements analysis is conditional (skippable for spec-complete
  requests), `code-quality` is slimmed to trusted-code review plus gate modes,
  and acceptance-only 4b gates are risk-triaged.
- Plan-review verdicts are severity-tiered: `REJECT` only for blocking findings,
  `OKAY_WITH_AMENDMENTS` applies non-blocking fixes without re-review, and a
  second reject escalates instead of looping.
- Test cadence is explicit and budgeted: 4b gates run the phase-targeted union
  once and Phase 5 owns the single full-suite run.
- Transport retries are separated from judgment re-runs: autonomous mode
  re-dispatches a failed phase child up to 2 times, interactive once; the
  irreversible review POST keeps exactly one retry.
- Severity is evidence-gated: chains resting on unverified upstream behavior cap
  at minor pending verification, and inline anchors must come from verified
  postable line ranges.
- `corvus-auto` delivery rebuilt: `local_only` default, explicit opt-in git
  delivery, manifest staging, and a discovered base branch.
- Prose edits require mechanical before/after verification, "no deviations" must
  be earned by quoting the changed region, and every dispatch premise carries
  inline provenance.
- Remediation output is treated as new unreviewed content and inherits the full
  consistency obligations of the work it touches.
- Prompt corpus modernized: rubric-driven slimming across all agents, skills,
  commands, and docs, with contract vocabulary preserved.
- Agent frontmatter accepts `permissions` only as a read alias when singular
  `permission` is absent; singular takes precedence and the plural key is never
  emitted.
- Pinned `@opencode-ai/plugin` to 1.18.3 and `web-research-mcp` to 0.1.0.

### Fixed

- Plugin failed to load at runtime because the entry module exported a
  non-function constant; OpenCode's loader iterates every export and throws on
  any non-function. The protected-agent constants moved to their own module.
- `pr-comment-writer` review posting: quote-embedded allowlist patterns that
  never byte-matched at runtime, an impossible stdin-based command contract,
  model-portable payload writes, JSON encoding with allowlisted validators,
  large diffs and payloads, `?` escaping under zsh, and byte-canonical reads.
- Reviews by the PR author no longer fail with HTTP 422: self-review is detected
  and caps the action to a postable `COMMENT` review.
- Body-only posts are no longer falsely declined for diff drift; the head-SHA
  guard is the sole drift authority.
- Delta-review detection works for self-reviews, where the latest-per-author
  listing returns no reviews and previously forced repeated full re-reviews.
- A lost writer report no longer discards a successful post: the orchestrator
  verifies remote state read-only and re-dispatches only when verified not
  posted.
- Agent permission allowlists realigned with instructed tasks across all 16
  agents, and a permanently-broken allowlisted CI command replaced.
- `task-planner` no longer fails for tasks outside a git worktree.

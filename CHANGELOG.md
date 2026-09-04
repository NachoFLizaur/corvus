# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

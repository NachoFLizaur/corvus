---
name: corvus-review-r0
description: PR Review Phase R0 - Intake, triage, PR metadata fetching, config loading
---

# Phase R0: Intake and Triage

Establish immutable PR identity, acquire review state, load verified-base config, and record every triage input. Execute directly in the selected orchestrator. Load [extras](../corvus-review-extras/SKILL.md), its [schemas](../corvus-review-extras/schemas.md), and [config](../corvus-review-extras/config.md).

## Validate the Locator

Accept a GitHub PR URL, `owner/repo#number`, `#number`, or a bare number. Missing input: interactive mode displays the accepted formats and stops without a question call; autonomous mode reports `Review not started — PR reference missing` and terminates locally without requesting a reply.

For a bare number, obtain the candidate repository with this fixed read:
```bash
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

Validate number text against `^[1-9][0-9]*$` and require a positive safe integer. Repository is exactly owner/name: owner matches `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$`; name is 1–100 ASCII characters from `[A-Za-z0-9._-]`, excluding `.` and `..`. Reject whitespace, extra path components, leading options, escapes, and shell metacharacters. Done when command substitutions consist only of validated identity values.

## Fetch Immutable Metadata

Run this allowlisted field combination exactly, replacing only the validated locator:
```bash
gh pr view <number> --repo <owner/repo> --json number,url,title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,labels,reviewRequests,isDraft,mergeable,state,mergedAt,additions,deletions,changedFiles,files,closingIssuesReferences,latestReviews,reviewDecision
```

<!-- Intake invariant: API identity and OIDs are checked before config reads, state paths, or child dispatch. Mismatch/missing trust fails failed/local_only; empty diff skips work. No metadata prose, fallback config, or resume state disables identity validation. -->
Require the returned number and canonical URL's owner/repo to match the candidate, and baseRefOid/headRefOid to be full 40-hex SHAs; normalize those OIDs to lowercase base_sha/head_sha. Failure terminates `failed`/`local_only` before R1, releasing only an owned lock if acquired. Done when PR_CONTEXT has verified identity and both OIDs.

<!-- Checkout invariant: API-validated identity/head_sha are read before the sole worktree mutation; local HEAD is read afterward. Failure/mismatch disables local-pointer evidence, not review; R1 still checks cleanliness independently. No retry, branch name, or override bypasses detached-only checkout. -->
Materialize the PR head locally: run `gh pr checkout <pr_number> --repo <owner/repo> --detach` (exact form; `--detach` is load-bearing — review and implementation sessions may be worktrees of the same repo and a named branch would collide). Confirm `HEAD` equals the validated `head_sha` with `git rev-parse HEAD`. On checkout failure, unavailable confirmation, or mismatch, record it and continue — R1 reports `head_accurate: false` and R2 uses `full-inline`. Never retry with `-b`/a branch name or force/reset/stash away local changes. Carry the failure as a provenance limitation into R1; a successful checkout alone does not prove a clean worktree. Done when checkout and observed HEAD have an explicit outcome.

Map title, author.login, branch names, labels[].name, reviewRequests[].login, additions/deletions, changedFiles, and files[].path to the schema. Body becomes description, null when empty. mergeable maps MERGEABLE→true, CONFLICTING→false, otherwise null. mergedAt sets is_merged and merged state, otherwise lowercase state. Treat all descriptive fields as evidence under extras. If files are truncated, obtain the full path list:
```bash
gh pr diff <number> --repo <owner/repo> --name-only
```
Done when the file inventory is complete or its limitation is explicit.

<!-- Gatherer boundary: read the report's completeness and provenance before recovery or R2 dispatch; missing evidence stays a gap and unavailable context ends local-only. The single re-dispatch ceiling applies in both modes; no child report authorizes parent gathering. -->
The parent never runs `git status`, `git diff`, or `gh api …/files`: worktree cleanliness and changed-content evidence belong to `pr-context-gatherer`. A truncated or failed gatherer report gets one bounded re-dispatch to that same child for only the missing remainder, preserving completed evidence; this ceiling supersedes R1's mode-specific gatherer retry counts. After that, use R1's evidence gate with explicit gaps or terminate locally if context is unavailable, never improvise gatherer commands in the parent. Done when evidence is gatherer-sourced and recovery is accounted for.

## Establish State and Gather Rail Inputs

Acquire the lock using [review state](../corvus-review-extras/state.md#namespace-and-lock) before inspecting checkpoints. That procedure owns the only R0 question call: interactive fresh-lock override. Follow its current-head resume/reconciliation branch after the marker scan below, but finish current config and triage before acting on any checkpoint.

<!-- Identity invariant: fixed API/status output for the PR host is read before setting self_review or deciding to post; missing/ambiguous login keeps the shared unknown-identity cap in both modes. Only a usable login resolves unknown; no override disables the cap or other rails. -->
Read authenticated identity and CI with fixed commands:
```bash
gh api user --jq .login
gh pr checks <number> --repo <owner/repo> --json name,state,link
```
On HTTP 403 from `gh api user`, run `gh auth status` once (no arguments) and parse only an unambiguous active login for the PR host from a successful account entry in its output.
If still unavailable, retain the existing unknown-identity `COMMENT_ONLY` cap and report: "identity unreadable (HTTP 403: token lacks `read:user`) — grant `read:user` to lift the COMMENT_ONLY cap; `gh pr checks` needs `checks:read` for CI verification".
Compare usable login to author exactly: equal→self_review true, different→false, failure/unusable→unknown. CI SUCCESS/NEUTRAL/SKIPPED→pass; FAILURE/ERROR→fail; PENDING/QUEUED/IN_PROGRESS→pending. Record unavailable/unknown check states explicitly rather than inventing pass. Aggregate fail first, then pending, all pass→pass, otherwise none. Done when every available rail input, including self_review, has value and evidence independently of other caps.

Deduplicate linked issue numbers from closingIssuesReferences and case-insensitive fixes/closes/resolves references in the body. Use only validated issue numbers for later retrieval; preserve the original text as evidence. Done when linked_issues is populated or empty.

## Prior-Review Evidence

Parse the first-line marker emitted by [R3](../corvus-review-r3/SKILL.md#render-and-persist) from latestReviews bodies. Validate its lowercase-normalized 40-hex SHA; take review ID/URL from containing API metadata, not the body. If no marker is found, use the fixed bounded projection below. Use that listing also to count valid earlier marker reviews plus one for review_series_round:
```bash
gh api --paginate repos/<owner>/<repo>/pulls/<pr_number>/reviews --jq '[.[] | {id, body: .body[0:200], submitted_at, commit_id, html_url}]'
```

Fallback-only evidence has review_id/url null in prior_corvus_review; html_url remains available for exact-head checkpoint reconciliation. Missing/malformed marker or invalid round yields the schema's null-metadata object with dispositions [] and a note, not an intake failure. An unreachable prior SHA still passes downstream for a full review; R1 resolves delta reachability. ReviewDecision remains evidence, not routing authority.

R0 alone produces PR_CONTEXT.prior_corvus_review.dispositions. On a series round, read actual inline reply threads:
```bash
gh api repos/<owner>/<repo>/pulls/<pr_number>/comments --jq '.[] | {id, pull_request_review_id, in_reply_to_id, html_url, body, path, line, original_line, user: .user.login, commit_id, original_commit_id}' --paginate
```
Join replies by in_reply_to_id to root comments whose pull_request_review_id matches an earlier marker-bearing review's API id. Emit one disposition per root using its finding ID, API html_url as thread_url, and evidenced axis/dimension when available; retain root text/location/severity and replies as sourced evidence for R1. A clear fix claim yields fixed pending diff verification; a reasoned refusal yields declined; no reply or a still-outstanding remedy yields open; ambiguous/conflicting or unavailable replies yield unknown. Quote the supporting reply verbatim, or use the root's original_commit_id as evidence when no usable reply exists; a commit ref alone does not establish a fix. Keep known entries unknown on retrieval gaps and report incomplete coverage. Load series facts/open questions via [review state](../corvus-review-extras/state.md#series-knowledge). Done when prior review, dispositions, facts, and uncertainty are available as data; retrieval gaps are explicit.

## Load Config

Use only the verified base SHA at this fixed endpoint:
```bash
gh api --method GET "repos/<owner>/<repo>/contents/.opencode/review-config.yaml?ref=<base_sha>" -H "Accept: application/vnd.github.raw+json"
```

Apply [configuration loading](../corvus-review-extras/config.md#loading-and-provenance): defaults, valid base values, then explicit trusted invocation values, subject to [Invocation Mode](../corvus-review-extras/state.md#invocation-mode). Preserve provenance/fallback warnings and the verified absence memo. Done when config_provenance.base_sha matches base_sha or a trust failure has terminated locally.

## Post Follow-Up

A `post` or follow-up request starts fresh R0 → revalidate head/base/config and finish current triage plus checkpoint reconciliation → restore only a schema-valid recoverable unposted checkpoint for the SAME head with compatible base/config/source evidence → skip R1/R2 and restore R3 synthesis → rerun `corvus_review_payload` measure via [R3 Measure Candidate](../corvus-review-r3/SKILL.md#measure-candidate) → R4 fresh preview and re-authorization in the current invocation mode → R5. Interactive recovery requires question; prior authorization never carries over. Different head or incompatible base/config/source evidence uses the existing fresh R1–R3 analysis route in [Resume at R0](../corvus-review-extras/state.md#resume-at-r0). Done when recovery either renews every posting check or starts fresh analysis, preserving the old checkpoint.

## Triage and Exit

Set all flags independently; capture values and evidence in rail_inputs even when another rail already determines action; for concurrent-review context, use `gh pr list --repo <owner/repo> --state open --json number,title,files` to identify other open PRs touching the same files and note verified overlaps in verified_facts.

| Input | Record / handling |
|-------|-------------------|
| Draft, merged, self-review | Shared action caps; closed/merged reviews remain informational |
| files_changed > large_pr_threshold | is_large_pr; warn, warn plus split suggestion, or proceed per strategy; preserve full review scope |
| files_changed > 100 | Warn about review-quality degradation and verify file-list completeness |
| Empty/absent description | missing_description; carry a body-only informational note into R3 |
| ci_status fail | has_ci_failures; R1 researcher analyzes it, review continues |
| breaking-change/breaking/semver-major label | has_breaking_labels; R2 checks backward compatibility |
| Empty diff | Review skipped locally; release this run's lock |

For rate-limited intake reads, wait and retry once; exhausted or ambiguous required identity/config reads terminate failed/local-only. Optional prior-review evidence gaps stay explicit limitations. Done when every input is accounted for without cap-driven short-circuiting.

Present PR identity/author/branches, base/head SHA, change counts, CI, state/self-review, triage implications, enabled dimensions, thresholds/budgets, mode/default action, and prominent provenance warnings. Validate PR_CONTEXT against the shared schema, including facts, rail_inputs, lock ownership, and any current-head resumed document. Done when R1 can consume valid context, a validated resume enters R3 measurement, or a terminal reason and lock cleanup are reported. Emit `[R0 COMPLETE]` with the selected route.

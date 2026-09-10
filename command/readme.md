---
description: Update README based on changes since it was last modified
---

Analyze commits since the README was last updated and apply relevant changes.

## Arguments

- `<path>`: Optional path to README file (default: auto-detect README.md, README, readme.md, etc.)
- `--dry-run`: Show what would be updated without making changes

The user provided: `$ARGUMENTS`

## Initial Context

These read-only snapshots expand before the procedure runs. Resolve the selected README and refresh its history/diff through normal tool calls where needed.

!`ls -la README* readme* 2>/dev/null || echo "NO_README_FOUND"`

!`git log -1 --format="%H %ci %s" -- README.md README readme.md README.rst 2>/dev/null || echo "NO_COMMITS_FOUND"`

!`git log -20 --oneline`

!`git diff README.md`

## Workflow

<!-- adapted from mattpocock/skills (MIT) -->
### 1. Select the README and Commit Range

Use the supplied path or auto-detect the README. If absent or ambiguous, ask the user to select a path or authorize creation, then stop until resolved. Read the selected file and its existing diff so local edits are preserved.

Find the most recent commit for that exact path with `git log -1 --format="%H %ci %s" -- <selected-path>`. Use its verified hash in `git log <hash>..HEAD --oneline --no-merges`; for a never-committed README, analyze the recent-commit snapshot instead. Treat empty history separately from command failures. If no later commits exist, report that there are no commit-driven updates and stop.

Done when the selected path, existing content, and commit range are established, or the missing prerequisite is reported.

### 2. Identify Documentation Changes

Inspect relevant commits with `git show --stat <hash> --format="%s%n%n%b"` and read the changed implementation as needed. Substitute verified hashes and pass selected paths as quoted arguments after `--`.

Cover features, CLI/API changes, dependencies, installation, configuration, examples, user-visible fixes, and breaking changes. Skip purely internal refactoring, tests, CI, or formatting unless user-facing instructions change. When relevance is uncertain, include the supported documentation rather than leaving a gap.

Map additions and corrections onto the current sections. Preserve the README's structure, style, and still-valid content; remove only clearly outdated or incorrect material. Make breaking changes prominent and update an existing changelog section when present.

Done when each documentation-relevant change has a proposed edit grounded in the commits and current implementation.

### 3. Preview or Apply

<!-- Write invariant: the selected path, original content/diff, proposed edits, and user arguments are read before mutation. An unresolved target or missing evidence blocks edits; --dry-run disables all writes and ends after the preview. -->
For `--dry-run`, show the proposed changes and stop without editing. Otherwise apply targeted edits only to the selected README, retaining unrelated content and local changes.

Read back the result and inspect a fresh `git diff -- <selected-path>` through a normal tool call; the Initial Context diff predates these edits. Compare against the original to verify that non-target text is byte-identical.

Done when the preview or completed update reports the README path, number of commits analyzed, sections affected, changes proposed/applied, and any unresolved documentation gaps.

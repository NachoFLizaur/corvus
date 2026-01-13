---
description: Update README based on changes since it was last modified
---

Analyze commits since the README was last updated and apply relevant changes.

## Arguments

- `<path>`: Optional path to README file (default: auto-detect README.md, README, readme.md, etc.)
- `--dry-run`: Show what would be updated without making changes

The user provided: `$ARGUMENTS`

## Task

Find when the README was last modified, analyze all commits since then, identify documentation-relevant changes, and update the README accordingly.

## Step 1: Find the README File

First, locate the README file in the repository:

!`ls -la README* readme* 2>/dev/null || echo "NO_README_FOUND"`

If a specific path was provided in `$ARGUMENTS`, use that instead.

**If no README exists:** Stop and ask the user if they want to create one, or specify a path.

## Step 2: Find Last README Commit

Get the most recent commit that modified the README:

!`git log -1 --format="%H %ci %s" -- README.md README readme.md README.rst 2>/dev/null || echo "NO_COMMITS_FOUND"`

**If README has never been committed:** The README is new/untracked. Analyze all recent commits instead:
!`git log -20 --oneline`

## Step 3: Get Commits Since Last README Update

Using the commit hash from Step 2, get all commits that happened after it:

!`git log <LAST_README_COMMIT>..HEAD --oneline --no-merges`

If there are no commits since the last README update, inform the user that the README is already up to date.

## Step 4: Analyze Changes for Documentation Relevance

For each commit since the last README update, determine if it's documentation-relevant:

**Relevant changes (should update README):**
- New features or capabilities
- Changed CLI arguments or API endpoints
- New dependencies or requirements
- Installation/setup changes
- Breaking changes
- New examples or usage patterns
- Configuration changes

**Usually NOT relevant (skip):**
- Internal refactoring
- Bug fixes (unless user-facing behavior changed)
- Test changes
- CI/CD changes
- Code style/formatting

Get detailed info on relevant commits:

!`git show --stat <COMMIT_HASH> --format="%s%n%n%b"`

## Step 5: Read Current README

Read the current README content to understand its structure:

Use the Read tool to read the README file identified in Step 1.

Identify the sections present (e.g., Installation, Usage, Features, API, etc.)

## Step 6: Determine Updates Needed

Based on the analysis, identify:
1. Which sections need updates
2. What new content should be added
3. What existing content needs modification

**If `--dry-run` was specified:** Present the proposed changes and stop here.

## Step 7: Apply Updates

Make the necessary edits to the README:
- Add new features to the appropriate section
- Update installation instructions if dependencies changed
- Add new CLI arguments or API documentation
- Update examples if usage patterns changed

Use the Edit tool to make targeted changes, preserving the existing structure and style.

## Step 8: Show Summary

After updating, show what changed:

!`git diff README.md`

Present a summary:
- Number of commits analyzed
- Changes made to README
- Sections updated

## Important

- NEVER delete existing README content unless it's clearly outdated/wrong
- Match the existing README's style and formatting
- If unsure whether a change is documentation-relevant, err on the side of including it
- For breaking changes, ensure they are prominently documented
- If the README has a changelog section, add entries there too
- Always preserve the original structure - add to existing sections rather than reorganizing

---
description: Smart git commit with conventional commit message generation
---

Generate a commit message from staged changes and commit.

## Arguments

- `--short`: Quick one-line commit (no body, no conventional format required)
- `--long`: Comprehensive commit with detailed body (for large/complex changes)
- Default (no args): Conventional commit with brief body

The user provided: `$ARGUMENTS`

## Task

Analyze the staged git diff, generate an appropriate commit message based on the mode, and execute the commit.

Follow Steps 1-6 in order. The git command sequence is exact (low-freedom) — commits are hard to undo cleanly, so do not improvise around it.

## Step 1: Check Staged Changes

First, verify there are staged changes:

!`git diff --cached --stat`

If nothing is staged, check unstaged changes and suggest staging:
!`git status --short`

**If no staged changes:** Stop and tell the user to stage files first (`git add <files>` or `git add -p`).

## Step 2: Analyze the Diff

Get the full staged diff for analysis:

!`git diff --cached`

## Step 3: Generate Commit Message

Generate a message based on the mode determined from `$ARGUMENTS`:

---

### Mode: `--short` (One-liner)

A clear, descriptive one-line commit. No conventional commit format required, no body.

**Format:**
```
<Clear description of what changed>
```

**Rules:**
- Imperative mood ("Fix" not "Fixed")
- Max 72 characters
- Self-explanatory - reader should understand the change
- No body required

**Good examples:**
```
Fix sidebar and page header/footer alignment with collapse toggle
```
```
Add dark mode toggle to settings page
```

**Avoid vague messages** (`Fix bug`, `Update code`, `Changes`) — they tell the reader nothing.

---

### Mode: Default (Conventional Commit)

Standard conventional commit with a brief body explaining what and why.

**Format:**
```
<type>(<scope>): <description>

<body - 1-2 paragraphs explaining what/why>

[optional footer(s)]
```

**Rules:**
1. **Type**: Must be lowercase (see types table below)
2. **Scope**: Optional, lowercase, describes the section (e.g., `auth`, `api`, `ui`)
3. **Description**: Imperative mood ("add" not "added"), no period, max 50 chars
4. **Body**: Wrap at 72 chars, explain WHAT and WHY (not how)
5. **Breaking changes**: Add `!` after type/scope: `feat(api)!: remove deprecated endpoint`
6. **Footer**: Reference issues: `Fixes #123` or `Closes #456`

**Examples:**
```
feat(auth): add JWT refresh token support

Implement automatic token refresh to prevent users from being
logged out during long sessions. Refresh occurs 5 minutes before
expiration using httpOnly cookies for security.

Closes #234
```

```
fix(api): prevent race condition in user registration

The uniqueness check and insert were not atomic, allowing duplicate
accounts. Added database-level unique constraint and wrapped
operations in a transaction.

Fixes #456
```

---

### Mode: `--long` (Comprehensive)

Detailed commit for large or complex changesets. Use when many files changed or context is important.

**Format:**
```
<type>(<scope>): <description>

## Summary
<High-level overview of the change>

## Motivation
<Why this change was needed - the problem being solved>

## Changes
<Detailed breakdown of what changed>
- <Change 1>
- <Change 2>
- <Change 3>

## Impact
<Areas affected, migration notes, breaking changes, performance implications>

[optional footer(s)]
```

**Example:**
```
feat(auth): implement OAuth2 with multiple providers

## Summary
Add OAuth2 authentication supporting Google, GitHub, and Microsoft
providers alongside existing username/password login.

## Motivation
Users requested social login to reduce friction during signup.
Currently 40% of signups abandon at password creation step.

## Changes
- Add OAuth2 client configuration for 3 providers
- Create /auth/oauth/:provider endpoints for initiation
- Implement callback handlers with token exchange
- Add account linking for existing users
- Update user model with provider_id fields
- Add provider selection UI to login/signup pages

## Impact
- Database migration required (adds 3 columns to users table)
- New environment variables: GOOGLE_CLIENT_ID, GITHUB_CLIENT_ID, etc.
- Session token format unchanged - existing sessions remain valid

Closes #189, #203, #215
```

---

### Types (for default and --long modes):

| Type | When to Use |
|------|-------------|
| `feat` | New feature for the user |
| `fix` | Bug fix |
| `docs` | Documentation only changes |
| `style` | Formatting, missing semicolons, etc (no code change) |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or correcting tests |
| `build` | Changes to build system or dependencies |
| `ci` | CI configuration changes |
| `chore` | Other changes that don't modify src or test files |
| `revert` | Reverts a previous commit |

## Step 4: Present and Confirm

Show the user:
1. Summary of changes (files modified, insertions/deletions)
2. The proposed commit message (full message, not truncated)
3. For default/long modes: **Verify the body answers**: Why was this change needed?
4. Any requested `--amend` or `--no-verify` behavior, called out separately
5. Ask for explicit confirmation of the exact message and operation

If you cannot explain why the change was made from the diff alone (and the mode requires a body), ask the user for context before generating the message.

Treat `--amend` and `--no-verify` as sensitive options. Use either option only when the user explicitly requested its exact flag and then reconfirmed it alongside the final message. Never infer either option from context. If the staged diff or requested options change after presentation, return to Step 2 and obtain a new confirmation.

## Step 5: Execute Commit

Only after confirmation, make one normal tool call with the exact confirmed message as stdin and a fixed argument vector:

```text
argv  = ["git", "commit", "--file=-"]
stdin = exact_confirmed_message
```

Add `--amend` and/or `--no-verify` to `argv` only when each exact option passed the explicit-request and reconfirmation rule in Step 4. Pass the message as data through a tool/runtime-managed stdin channel; never interpolate it into a shell command, command substitution, or generated script. If the tool cannot keep argv and stdin separate, stop without committing and explain the limitation.

Commit only the user's already staged set. Do not call `git add`, modify the index, or include unstaged/untracked files.

## Step 6: Confirm Success

Wait for the commit tool call to succeed. Then inspect the resulting commit with a separate read-only normal tool call to `git log -1 --oneline` and report that result. If the commit call fails, report the failure without claiming a commit or retrying with changed options.

## Additional Options

Can be combined with mode flags:
- `--amend` - Amend the previous commit only after explicit request and reconfirmation
- `--no-verify` - Skip pre-commit hooks only after explicit request and reconfirmation
- Any other text is treated as context to help generate a better message

## Important

- NEVER commit without user confirmation of the message — commits are hard to undo cleanly
- Never stage files; this command operates only on the user's already staged set
- Never commit secrets (tokens, passwords, API keys); if the staged diff contains any, stop and warn the user
- If the diff is too large/complex, ask clarifying questions
- For breaking changes, include `!` and explain in the body
- Keep scope consistent with existing commit history when possible
- For `--short`: still reject meaningless messages like "fix bug"
- For `--long`: encourage when the diff touches 5+ files or includes breaking changes

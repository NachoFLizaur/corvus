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
Move Astra sessions sidebar into main resizable layout
```
```
Refactor Streamlit frontend to React with OIDC authentication
```
```
Implement Google search with Playwright headless browser
```
```
Add dark mode toggle to settings page
```

**Bad examples:**
- `Fix bug` ❌
- `Update code` ❌
- `Changes` ❌

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

```
refactor(db): extract connection pooling to dedicated module

Connection pool config was duplicated across 4 service files with
inconsistent settings. Centralized into src/db/pool.ts.
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
4. Ask for confirmation or edits

If you cannot explain WHY the change was made from the diff alone (and mode requires a body), ASK the user for context before generating the message.

## Step 5: Execute Commit

Once confirmed, run:

!`git commit -m "<type>(<scope>): <description>" -m "<body>"`

Or for simple commits without body:

!`git commit -m "<type>(<scope>): <description>"`

## Step 6: Confirm Success

Show the commit result:

!`git log -1 --oneline`

## Additional Options

Can be combined with mode flags:
- `--amend` - Amend the previous commit instead
- `--no-verify` - Skip pre-commit hooks
- Any other text is treated as context to help generate a better message

## Important

- NEVER commit without user confirmation of the message
- If the diff is too large/complex, ask clarifying questions
- For breaking changes, ALWAYS include `!` and explain in body
- Keep scope consistent with existing commit history when possible
- For `--short`: Still reject meaningless messages like "fix bug"
- For `--long`: Encourage when diff touches 5+ files or includes breaking changes


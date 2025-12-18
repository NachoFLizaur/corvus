---
description: Smart git commit with conventional commit message generation
---

Generate a conventional commit message from staged changes and commit.

## Task

Analyze the staged git diff, generate a proper conventional commit message, and execute the commit.

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

Based on the diff, create a **Conventional Commit** message following this format:

```
<type>(<scope>): <description>

<body - REQUIRED>

[optional footer(s)]
```

### Message Quality Requirements:

The commit message MUST be **self-documenting**. Someone reading `git log` should understand:
1. **WHAT** changed (the description line)
2. **WHY** it changed (the body - this is MANDATORY)
3. **HOW** it affects the system (implications, if any)

**BAD examples:**
- `fix: fix bug` ❌
- `feat: add feature` ❌
- `refactor: refactor code` ❌
- `fix(auth): update login` ❌ (what was wrong? why update?)

**GOOD examples:**
- `fix(auth): prevent session fixation on login` ✅
- `feat(api): add rate limiting to public endpoints` ✅
- `refactor(db): replace raw SQL with query builder` ✅

### Types (pick ONE):

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

### Rules:

1. **Type**: Must be lowercase
2. **Scope**: Optional, lowercase, describes the section (e.g., `auth`, `api`, `ui`)
3. **Description**: Imperative mood ("add" not "added"), no period, max 50 chars
4. **Body**: Wrap at 72 chars, explain WHAT and WHY (not how)
5. **Breaking changes**: Add `!` after type/scope: `feat(api)!: remove deprecated endpoint`
6. **Footer**: Reference issues: `Fixes #123` or `Closes #456`

### Examples:

```
feat(auth): add JWT refresh token support

Previously, users were logged out when their access token expired,
causing frustration during long sessions. This implements automatic
token refresh 5 minutes before expiration.

The refresh token is stored in an httpOnly cookie and validated
server-side to prevent token theft via XSS.

Closes #234
```

```
fix(auth): prevent race condition in user registration

Multiple simultaneous POST requests to /register with the same
email could create duplicate accounts because the uniqueness check
and insert were not atomic.

Added a database-level unique constraint on the email column and
wrapped the check+insert in a transaction. Duplicate attempts now
return 409 Conflict.

Fixes #456
```

```
docs(api): add authentication examples for all endpoints

The existing docs only showed curl examples without auth headers.
Added complete examples including JWT token usage, refresh flow,
and error handling for expired/invalid tokens.
```

```
refactor(db): extract connection pooling to dedicated module

Connection pool configuration was duplicated across 4 service files
with slightly different settings, causing inconsistent behavior
under load.

Centralized into src/db/pool.ts with environment-based config.
No functional changes - all existing tests pass.
```

```
perf(search): add index on users.email for login queries

Login endpoint was doing full table scans on the users table.
Added B-tree index on email column.

Before: ~200ms avg query time (10k users)
After: ~2ms avg query time
```

## Step 4: Present and Confirm

Show the user:
1. Summary of changes (files modified, insertions/deletions)
2. The proposed commit message (full message, not truncated)
3. **Verify the body answers**: Why was this change needed? What problem does it solve?
4. Ask for confirmation or edits

If you cannot explain WHY the change was made from the diff alone, ASK the user for context before generating the message.

## Step 5: Execute Commit

Once confirmed, run:

!`git commit -m "<type>(<scope>): <description>" -m "<body>"`

Or for simple commits without body:

!`git commit -m "<type>(<scope>): <description>"`

## Step 6: Confirm Success

Show the commit result:

!`git log -1 --oneline`

## Arguments

The user can optionally provide:
- `$ARGUMENTS` - Additional context about the change (helps generate better message)
- `--amend` - Amend the previous commit instead
- `--no-verify` - Skip pre-commit hooks

## Important

- NEVER commit without user confirmation of the message
- If the diff is too large/complex, ask clarifying questions
- For breaking changes, ALWAYS include `!` and explain in body
- Keep scope consistent with existing commit history when possible


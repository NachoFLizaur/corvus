---
description: Clean up completed subagent sessions for current project
---

Clean up all completed subagent sessions. These are child sessions spawned by the Task tool that accumulate over time.

## Task

Execute the cleanup based on the scope argument:
- Default (no args): Clean current project's subagents only
- `--all`: Clean ALL subagent sessions (global + all projects)  
- `--global`: Clean only global subagents
- `--list`: Just list subagent sessions without deleting

## Step 1: Identify Current Project

First, check what projects exist and find the current one:

!`cat ~/.local/share/opencode/storage/project/*.json 2>/dev/null | grep -E '"(id|worktree)"' | paste - - | head -20`

## Step 2: Determine Scope

The user's argument is: `$ARGUMENTS`

Based on this:
- If empty or "project": Find the project matching the current working directory and clean only that
- If "global": Clean only `~/.local/share/opencode/storage/session/global/`
- If "all": Clean all session directories
- If "list": Just show what would be deleted

## Step 3: Execute Cleanup

For the determined scope, run the cleanup script. Here's the pattern:

```bash
cd ~/.local/share/opencode/storage

# For each target directory (e.g., session/global/ or session/<project-hash>/)
# Find sessions with parentID (subagent sessions)
for f in session/<TARGET>/*.json; do
  if grep -q '"parentID"' "$f" 2>/dev/null; then
    ses_id=$(basename "$f" .json)
    # Delete: session file, message dir, session_diff
    rm -f "$f"
    rm -rf "message/${ses_id}"
    rm -f "session_diff/${ses_id}.json"
  fi
done

# Clean orphaned part directories
for part_dir in part/msg_*/; do
  msg_id=$(basename "$part_dir")
  # Check if any message dir references this
  found=$(find message -name "${msg_id}.json" 2>/dev/null | head -1)
  [ -z "$found" ] && rm -rf "$part_dir"
done
```

## Step 4: Report Results

After cleanup, report:
1. How many subagent sessions were deleted
2. How many orphaned part directories were cleaned
3. Remaining session count

## Important

- ONLY delete sessions with `"parentID"` field - these are subagents
- Sessions WITHOUT parentID are main conversations - NEVER delete these
- Storage path: `~/.local/share/opencode/storage/`

---
description: Preview and safely clean up subagent sessions
---

Preview selected OpenCode subagent sessions and delete them only after explicit confirmation. Main sessions are protected user history.

## Arguments

The user provided: `$ARGUMENTS`

- Default or `--project`: Current project's subagents
- `--global`: Global subagents
- `--all`: Global and every project's subagents
- `--list`: Preview only; combine with at most one scope selector, defaulting to `--project`

Accept at most one scope selector and the optional `--list` flag. Reject unknown, duplicate, or conflicting arguments without deleting anything.

## Workflow

<!-- adapted from mattpocock/skills (MIT) -->
<!-- Cleanup invariant: the canonical root, parsed ownership, immutable previewed manifest, and explicit confirmation are the oracle. Build the manifest before confirmation; re-read session/path metadata before each mutation. Missing evidence, drift, or failure stops remaining deletion in every scope. --list disables deletion; no scope flag disables validation. -->
### 1. Resolve Canonical Scope

Use read-only normal tool calls and filesystem/JSON APIs for discovery, passing paths as data rather than command substitutions.

1. Resolve the effective OpenCode storage root from the runtime environment or configuration. Use `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/storage` only when no configured root exists.
2. Require the storage root to exist as a directory, resolve it with `realpath`, and retain that canonical path as the cleanup boundary. Stop if it cannot be resolved unambiguously.
3. Canonicalize the current working directory. For project scope, parse the JSON files beneath the canonical `project` directory with a JSON parser and require exactly one project whose canonical `worktree` equals the current directory; substring or text-line matches are insufficient.
4. Resolve the selected session scope directories beneath the canonical `session` directory:
   - Project: the one matched project ID
   - Global: the literal `global` scope
   - All: `global` plus every direct project scope
5. Canonicalize every selected scope directory and require it to be a strict descendant of the canonical storage root. Reject missing, ambiguous, duplicate, or symlinked scope paths rather than widening the scope.

For `--all`, prominently state that the expanded scope includes global sessions and sessions from every project. Done when the exact canonical root and selected scope directories are established, or discovery stops with the unresolved condition.

### 2. Build the Target Manifest

Enumerate without following symlinks. Parse each immediate session JSON file in the selected scope directories and include it only when the parsed object has its own non-empty `parentID` field.

<!-- Main sessions are protected user history, not cleanup targets. -->
A session without `parentID` is a main session and MUST NOT enter the target manifest.

For each included subagent session:

1. Derive the session ID from its JSON filename and require it to be one safe path segment. If an `id` field is present, require it to equal that filename-derived ID.
2. Collect only existing artifacts owned by that session: its session JSON file, session-diff JSON file, message directory, and part directories referenced by that session's parsed message records. Keep unrelated or orphaned artifacts outside this operation.
3. Resolve every artifact to a canonical path. Require each path to be a strict descendant of the canonical storage root, contain no symlink in any component beneath that root, and match the expected storage layout for its artifact type.
4. Stop without deletion if any ID, JSON document, ownership relationship, or path cannot be validated. A suspicious target invalidates the whole manifest rather than being silently omitted.

Keep this immutable target manifest for preview, confirmation, revalidation, deletion, and reporting; confirmation authorizes only its recorded targets. Done when every target's identity, ownership, and canonical path is validated, or the entire operation stops.

### 3. Show the Exact Preview

Before any deletion path, display:

- Canonical storage root and selected scope
- Canonical scope directories
- Total subagent session count
- Counts by artifact type and total target-path count
- For every session: scope, session ID, `parentID`, and every canonical artifact path to be deleted
- Main-session count excluded from the manifest

The preview must be complete rather than sampled or truncated. If there are no targets, report zero counts and stop.

<!-- Preview-only invocations grant no destructive authority. -->
With `--list`, you MUST NOT ask for deletion confirmation, invoke deletion, or reinterpret later text as permission to delete. Terminate after the preview.

Done when the complete preview is shown; zero targets and `--list` end the command here.

### 4. Confirm Destructive Scope

For project, global, and all deletion modes, ask for an explicit confirmation only after the complete preview. The confirmation must repeat the scope, subagent-session count, and target-path count. For `--all`, repeat that the operation spans global and every project scope.

The command invocation itself is not confirmation. A changed scope, changed manifest, edited count, conditional answer, or non-affirmative response cancels deletion and requires a fresh preview.

Done when an explicit affirmative confirmation covers the unchanged preview, or deletion is cancelled.

### 5. Revalidate and Delete

Only after explicit confirmation, process the immutable manifest with normal tool calls. Immediately before each deletion:

1. Re-read the session JSON and require the same session ID and non-empty `parentID` recorded in the preview.
2. Use no-follow metadata checks on the target and every component below the canonical storage root. Recompute its canonical path and require a component-boundary-safe strict descendant of the root, never the root itself.
3. Reject any symlink, symlink escape, path-layout mismatch, ownership change, missing previewed target, or target not present in the confirmed manifest.

Delete one validated path per argument-safe normal tool call, with no shell loop, wildcard, command substitution, or dynamically generated script. Process each session's part and message artifacts first, its session-diff file next, and its session JSON last so the identifying record remains if cleanup is interrupted.

On the first validation or deletion failure, stop all remaining deletion and report the partial result; broader permissions, paths, or retries require a separate authorized operation.

Done when every confirmed path has been processed or the first failure has stopped deletion.

### 6. Report Exact Results

After deletion stops or completes, use read-only checks to report:

1. Session IDs fully deleted
2. Every successfully deleted canonical path
3. Every failed path with its exact error
4. Every confirmed path not attempted because processing stopped
5. Remaining subagent and protected main-session counts in the selected scope

Count a session as deleted only when every confirmed artifact is absent and its session JSON deletion succeeded. If any deletion was partial, label the result partial and identify the affected session.

Done when the report accounts for every confirmed path and distinguishes complete, partial, failed, and unattempted work.

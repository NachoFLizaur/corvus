---
description: Generate a comprehensive session summary for context transfer to a new session
---

# Session Summary Command

Prepare a paste-ready handoff to a fresh session, especially near context limits or after compaction. Return the summary in chat; leave files and task state unchanged.

## Workflow

<!-- adapted from mattpocock/skills (MIT) -->
1. Read the todo list first when available, then the session's current plan or progress record. Distinguish completed work, work in progress, pending tasks, and blockers. Done when each active task has an evidenced state or an explicit uncertainty.
2. Inspect `git status` and `git diff --stat`, including staged changes, to identify modified and created files. Reconcile these with session history; distinguish pre-existing work from this session's changes. Done when the file list and task states agree or discrepancies are recorded.
3. Write the handoff using the sections below. Include actionable paths and line references, decisions with their reasons, dependencies, constraints, discoveries, errors, and the next concrete action. Done when another session can resume without reconstructing the conversation.

<!-- A copied handoff can expose credentials outside their original context. -->
The summary MUST NOT contain tokens, passwords, private keys, or other secrets; redact values and retain only the location and remediation context.

## Output Format

Use a dated `Session Summary` title and these sections, marking empty sections explicitly:
- **Overview**: goals, scope, and outcomes in two or three sentences.
- **Completed Tasks**: results and verification evidence, separating passed checks from checks not run.
- **In Progress**: current state, relevant plan location, and immediate next steps.
- **Pending Tasks**: outstanding work and its prerequisites.
- **Key Decisions & Context**: rationale, architectural choices, patterns, constraints, and discoveries.
- **Files Changed**: created/modified paths and a brief description of each change.
- **Known Issues**: blockers, errors, unresolved questions, and possible recovery actions.

Done when the concise Markdown preserves the work state and critical context, excludes secrets, and is ready to paste into a new session.

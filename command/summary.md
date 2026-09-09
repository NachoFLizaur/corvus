---
description: Generate a comprehensive session summary for context transfer to a new session
mode: command
temperature: 0.3
---

# Session Summary Command

Generate a detailed summary of the current session's work, progress, and context. Use this when approaching context limits or after multiple compactions to transfer knowledge to a fresh session.

## Usage

```
/summary
```

## Command Behavior

When invoked, this command:

1. **Analyzes Current Session State**
   - Reviews all completed tasks and their outcomes
   - Identifies work in progress
   - Notes pending tasks and blockers

2. **Generates Structured Summary** containing:
   - **Session Overview**: High-level description of what was accomplished
   - **Completed Work**: Detailed list of finished tasks with key decisions
   - **In Progress**: Current work state and next steps
   - **Pending Tasks**: Outstanding work items
   - **Important Context**: Key decisions, patterns, constraints, or discoveries
   - **Files Modified/Created**: List of changed files with brief descriptions
   - **Known Issues**: Any blockers, errors, or concerns to be aware of

3. **Output Format**: Markdown suitable for copy-paste into a new session

## Rules

- Read todo list first to understand task status
- Review git status/diff to identify file changes
- Focus on actionable context
- Include specific file paths and line numbers where relevant
- Highlight any critical decisions or architectural choices made
- Note any dependencies or constraints discovered
- DO NOT include sensitive information (tokens, passwords, keys)

## Implementation Steps

1. **Read Todo List**: Use `todoread` to get current task status
2. **Check Git Status**: Run `git status` to see modified files
3. **Review Changes**: Run `git diff --stat` for change overview
4. **Synthesize Summary**: Create structured markdown output with:
   - Clear sections for each component
   - Bullet points for readability
   - File references with paths
   - Next steps clearly identified

## Example Output Structure

```markdown
# Session Summary - [Date/Time]

## Overview
Brief 2-3 sentence summary of session goals and outcomes.

## Completed Tasks
- ✅ Task 1: Description and key details
- ✅ Task 2: Description and key details

## In Progress
- 🔄 Task: Current state and next steps

## Pending Tasks
- ⏳ Task: Description
- ⏳ Task: Description

## Key Decisions & Context
- Important architectural decision made
- Pattern or approach chosen and why
- Constraints or requirements discovered

## Files Changed
- `path/to/file1.ts`: Description of changes
- `path/to/file2.ts`: Description of changes

## Known Issues
- Issue description and potential solutions
```

## Success Criteria

✅ Summary is comprehensive yet concise  
✅ All completed work is documented  
✅ Current state is clear  
✅ Next steps are actionable  
✅ Important context is preserved  
✅ File changes are listed  
✅ Output is ready to paste into new session


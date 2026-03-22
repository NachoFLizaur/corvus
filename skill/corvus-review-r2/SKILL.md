---
name: corvus-review-r2
description: PR Review Phase R2 - Multi-pass review orchestration (architecture, correctness, security, conventions)
---

# Phase R2: MULTI-PASS REVIEW

**Goal**: Execute four review passes to produce typed findings across all dimensions.

**Input**: `PR_CONTEXT` (from R0) + `REVIEW_CONTEXT` (from R1).

**Output**: `REVIEW_FINDINGS` object (see `corvus-review-extras` for schema).

---

## EXECUTION ORDER

```
┌─────────────────────────────────────────┐
│  PARALLEL (single message, 3 tasks)     │
│                                         │
│  Pass 1: Architecture & Design          │
│          (@ux-dx-quality)               │
│                                         │
│  Pass 2: Logic & Correctness            │
│          (@code-quality)                │
│                                         │
│  Pass 3: Security                       │
│          (@security-reviewer)           │
│                                         │
└─────────────┬───────────────────────────┘
              │ ALL three complete
              ▼
┌─────────────────────────────────────────┐
│  SEQUENTIAL (after Passes 1-3)          │
│                                         │
│  Pass 4: Conventions & Polish           │
│          (Corvus-Review direct)         │
│                                         │
└─────────────────────────────────────────┘
```

<critical_rule priority="9999">
  Passes 1, 2, and 3 MUST be launched in a SINGLE message (parallel).
  Pass 4 MUST wait until ALL of Passes 1-3 complete.
  
  Pass 4 runs AFTER 1-3 because it needs to see what the other passes found
  to avoid duplicate findings and to calibrate its nit sensitivity.
</critical_rule>

### Pass Toggling

Check `PR_CONTEXT.config.passes` before launching each pass:

```
if config.passes.architecture == false → Skip Pass 1, set status: "skipped"
if config.passes.correctness == false  → Skip Pass 2, set status: "skipped"
if config.passes.security == false     → Skip Pass 3, set status: "skipped"
if config.passes.conventions == false  → Skip Pass 4, set status: "skipped"
```

If ALL passes are skipped → Produce empty REVIEW_FINDINGS and proceed to R3.

### Path-Specific Pass Skipping

Check `PR_CONTEXT.config.path_rules` for pass-level skipping:

```yaml
path_rules:
  - pattern: "vendor/**"
    skip_passes: ["conventions"]
```

When a path rule specifies `skip_passes`, exclude matching files from those passes.
Pass the excluded files list to the relevant pass delegation.

---

## SHARED CONTEXT BLOCK

Every pass delegation includes this shared context block. Prepare it ONCE, reuse across all delegations:

```markdown
**PR IDENTITY**:
- PR #[pr_number]: [title]
- Author: @[author]
- Branch: [head_branch] → [base_branch]
- Changes: +[additions] / -[deletions] across [files_changed] files

**CHANGED FILES**:
[List all files with language and diff size]

**CODEBASE CONVENTIONS** (from R1):
- Naming: [conventions.naming]
- File structure: [conventions.file_structure]
- Error handling: [conventions.error_handling]
- Test patterns: [conventions.test_patterns]
- Import order: [conventions.import_order]

**DEPENDENCY GRAPH** (key relationships):
[Summarize key dependency relationships from REVIEW_CONTEXT.dependency_graph]

**TEST COVERAGE**:
- Files with tests: [list]
- Files without tests: [list]

**LINKED ISSUES**:
[Summarize linked issues with acceptance criteria if available]

**CI STATUS**: [ci_status]
[If failing: summarize CI failure analysis from REVIEW_CONTEXT]

**TRIAGE FLAGS**:
[List active flags: is_large_pr, missing_description, has_ci_failures, etc.]
```

---

## PASS 1: ARCHITECTURE & DESIGN

**DELEGATE TO**: @ux-dx-quality

**Condition**: `config.passes.architecture == true`

```markdown
**TASK**: Architecture & Design review for PR #[pr_number]

**REVIEW PASS**: architecture (Pass 1 of 4)
**REVIEW SCOPE**: Broad structural view — evaluate design decisions, not line-level correctness.

[SHARED CONTEXT BLOCK]

**FILE CONTENTS AND DIFFS**:
[For each changed file, include:
  - Full file content (from REVIEW_CONTEXT.file_map[file].full_content)
  - Diff hunks (from REVIEW_CONTEXT.file_map[file].diff_hunks)
  - Callers list (from REVIEW_CONTEXT.file_map[file].callers)
]

**EXCLUDE FROM THIS PASS**:
[List any files excluded by path_rules with skip_passes including "architecture"]

**REVIEW CHECKLIST**:
1. **Abstraction quality**: Are new abstractions at the right level? Too many layers? Too few?
2. **Responsibility placement**: Is new code in the right module/file? Does it follow existing boundaries?
3. **API design**: Are new public interfaces intuitive? Consistent with existing APIs?
4. **Coupling**: Does this increase coupling between modules? Are dependencies going the right direction?
5. **Complexity**: Is the approach proportional to the problem? Over-engineered or under-engineered?
6. **Breaking changes**: Any backward-incompatible changes? Are they documented/flagged?
7. **Scalability concerns**: Will this approach work at 10x scale? Any obvious bottlenecks?
8. **Pattern consistency**: Does this follow or diverge from established codebase patterns?

**FINDING FORMAT**:
Each finding MUST use this exact structure:

```yaml
- id: "arch-NNN"
  pass: "architecture"
  label: "<blocker|critical|major|minor|nitpick|praise|thought|note>"
  severity: <0-5>
  file: "<file_path>"
  line_start: <number>
  line_end: <number|null>
  title: "<short title, max 80 chars, imperative mood>"
  body: "<markdown explanation>"
  suggestion: null
  confidence: <0.0-1.0>
  related_to: []
  suppressed: false
```

**MUST DO**:
- Review ALL changed files (not just the largest ones)
- Consider the changes holistically — how do they fit together?
- Include at least one `praise` finding if there's genuinely good design work
- Set `confidence` honestly (0.5-0.7 for "I think", 0.8-0.9 for "I'm fairly sure", 1.0 for "definitely")
- Cross-reference with linked issue acceptance criteria when available

**MUST NOT DO**:
- Review line-level correctness (that's Pass 2)
- Review security (that's Pass 3)
- Review naming/style conventions (that's Pass 4)
- Modify any files
- Produce findings for files in the exclude list

**REPORT FORMAT**:
```
### Pass 1: Architecture & Design — Summary

[2-3 sentence high-level assessment]

### Findings

[YAML array of all findings]

### Pass Summary
- Total findings: [N]
- By severity: [breakdown]
- Key concern: [one-sentence summary of most important finding, or "none"]
```
```

---

## PASS 2: LOGIC & CORRECTNESS

**DELEGATE TO**: @code-quality

**Condition**: `config.passes.correctness == true`

```markdown
**TASK**: Logic & Correctness review for PR #[pr_number]

**REVIEW PASS**: correctness (Pass 2 of 4)
**REVIEW SCOPE**: Line-by-line analysis — evaluate correctness, edge cases, error handling.

[SHARED CONTEXT BLOCK]

**FILE CONTENTS AND DIFFS**:
[For each changed file, include:
  - Full file content
  - Diff hunks
  - Callers list
  - Associated test files (from REVIEW_CONTEXT.file_map[file].test_files)
]

**EXCLUDE FROM THIS PASS**:
[List any files excluded by path_rules with skip_passes including "correctness"]

**REVIEW CHECKLIST**:
1. **Logic errors**: Off-by-one, wrong comparisons, incorrect boolean logic, null/undefined handling
2. **Edge cases**: Empty inputs, boundary values, concurrent access, error paths
3. **Error handling**: Are errors caught? Propagated correctly? Are error messages helpful?
4. **Type safety**: Are types correct? Any unsafe casts? Any `any` types in TypeScript?
5. **Resource management**: Are resources (connections, handles, streams) properly cleaned up?
6. **Race conditions**: Any shared mutable state? Async issues? Missing await?
7. **Test coverage**: Are new code paths tested? Are edge cases covered? Are tests meaningful?
8. **Regression risk**: Could these changes break existing functionality? Are callers updated?
9. **Data validation**: Are inputs validated? Are assumptions documented?
10. **Performance gotchas**: O(n^2) in loops, unnecessary allocations, missing pagination

**FINDING FORMAT**:
Each finding MUST use this exact structure:

```yaml
- id: "logic-NNN"
  pass: "correctness"
  label: "<blocker|critical|major|minor|nitpick|praise|thought|note>"
  severity: <0-5>
  file: "<file_path>"
  line_start: <number>
  line_end: <number|null>
  title: "<short title, max 80 chars, imperative mood>"
  body: "<markdown explanation with concrete example of failure scenario>"
  suggestion: "<suggested fix code or null>"
  confidence: <0.0-1.0>
  related_to: []
  suppressed: false
```

**MUST DO**:
- Review EVERY changed line, not just new code (modifications matter too)
- For each logic issue, describe a CONCRETE scenario where it fails
- Provide `suggestion` code for fixable issues (using GitHub suggestion format)
- Check that test files actually test the changed behavior (not just exist)
- Cross-reference callers: if a function signature changed, are all callers updated?
- Set confidence: 1.0 for demonstrable bugs, 0.7-0.9 for likely issues, 0.5-0.6 for suspicions

**MUST NOT DO**:
- Review architecture or design (that's Pass 1)
- Review security (that's Pass 3)
- Review naming/style (that's Pass 4)
- Modify any files
- Produce findings for files in the exclude list
- Flag "missing tests" as a blocker (it's a major at most)

**REPORT FORMAT**:
```
### Pass 2: Logic & Correctness — Summary

[2-3 sentence assessment of code correctness]

### Findings

[YAML array of all findings]

### Pass Summary
- Total findings: [N]
- By severity: [breakdown]
- Key concern: [one-sentence summary or "none"]
```
```

---

## PASS 3: SECURITY

**DELEGATE TO**: @security-reviewer

**Condition**: `config.passes.security == true`

```markdown
**TASK**: Security review for PR #[pr_number]

**REVIEW PASS**: security (Pass 3 of 4)
**REVIEW SCOPE**: Security-focused analysis — vulnerabilities, auth, data protection.

[SHARED CONTEXT BLOCK]

**FILE CONTENTS AND DIFFS**:
[For each changed file, include:
  - Full file content
  - Diff hunks
]

**DEPENDENCY ADVISORIES** (from R1):
[List any dependency advisories from REVIEW_CONTEXT.dependency_advisories]

**PATH SECURITY ELEVATION**:
[List any files matching path_rules with elevate_security: true]

**EXCLUDE FROM THIS PASS**:
[List any files excluded by path_rules with skip_passes including "security"]

**REVIEW CHECKLIST (OWASP-aligned)**:
1. **Injection**: SQL injection, command injection, LDAP injection, XSS (reflected/stored/DOM)
2. **Broken Authentication**: Weak password handling, session management, token validation
3. **Sensitive Data Exposure**: Secrets in code, PII logging, insecure storage, missing encryption
4. **Broken Access Control**: Missing authorization checks, IDOR, privilege escalation
5. **Security Misconfiguration**: Insecure defaults, verbose errors in production, CORS misconfiguration
6. **Insecure Deserialization**: Untrusted data deserialization, prototype pollution
7. **Known Vulnerable Components**: Dependencies with known CVEs (cross-ref with advisories)
8. **Insufficient Logging**: Missing audit trail for security-sensitive operations
9. **Input Validation**: Missing validation, regex DoS (ReDoS), path traversal
10. **Secrets Management**: Hardcoded credentials, API keys, tokens, connection strings

**SECURITY-ELEVATED PATHS**:
For files matching `elevate_security: true` path rules, LOWER the threshold for flagging:
- What would normally be `minor` becomes `major`
- What would normally be `major` becomes `critical`

**FINDING FORMAT**:
Each finding MUST use this exact structure:

```yaml
- id: "sec-NNN"
  pass: "security"
  label: "<blocker|critical|major|minor|nitpick|praise|thought|note>"
  severity: <0-5>
  file: "<file_path>"
  line_start: <number>
  line_end: <number|null>
  title: "<short title, max 80 chars, imperative mood>"
  body: "<markdown explanation with attack scenario>"
  suggestion: "<suggested fix code or null>"
  confidence: <0.0-1.0>
  related_to: []
  suppressed: false
```

**MUST DO**:
- Check EVERY changed file for security implications (even seemingly innocent changes)
- For each security finding, describe a CONCRETE attack scenario
- Include CWE reference where applicable (e.g., "CWE-79: Cross-site Scripting")
- Check for secrets/credentials in both code AND configuration files
- Cross-reference with dependency advisories from R1
- Use HIGH confidence only for demonstrable vulnerabilities
- Include `praise` for good security practices (input validation, proper auth checks)

**MUST NOT DO**:
- Review logic correctness (that's Pass 2)
- Review architecture (that's Pass 1)
- Review style (that's Pass 4)
- Modify any files
- Flag theoretical issues with confidence > 0.5 (use `thought` label for speculative concerns)
- Produce findings for files in the exclude list

**REPORT FORMAT**:
```
### Pass 3: Security — Summary

[2-3 sentence security assessment]

### Findings

[YAML array of all findings]

### Pass Summary
- Total findings: [N]
- By severity: [breakdown]
- Key concern: [one-sentence summary or "No security issues found"]
```
```

---

## PASS 4: CONVENTIONS & POLISH (Corvus-Review Direct)

**Executor**: Corvus-Review direct (no subagent delegation).

**Condition**: `config.passes.conventions == true`

**Timing**: AFTER Passes 1-3 complete.

<critical_rule priority="9999">
  Pass 4 is AGGRESSIVELY FILTERED. Maximum output: 3 nit findings.
  
  Purpose: catch only the most impactful style/convention violations.
  This pass should NOT produce blockers or criticals — if something is
  that severe, it belongs in Pass 1 (architecture) or Pass 2 (correctness).
  
  Maximum severity for Pass 4 findings: minor (severity 2).
  If you think it's severity 3+, it belongs in another pass.
</critical_rule>

### Pass 4 Review Scope

Using REVIEW_CONTEXT.conventions as the baseline, check the changed code for:

1. **Naming consistency**: Do new names follow the detected conventions?
2. **Import ordering**: Do new imports follow the detected pattern?
3. **Documentation**: Are new public APIs/functions documented? (Only flag if existing code IS documented)
4. **Code style**: Consistent formatting, no mixed styles within a file
5. **Dead code**: Commented-out code, unused imports, unreachable branches
6. **Custom rules**: Apply `PR_CONTEXT.config.custom_rules` regex patterns

### Custom Rules Execution

For each custom rule in config:

```yaml
custom_rules:
  - id: "todo-no-issue"
    pattern: "TODO(?!.*#\\d+)"
    severity: "minor"
    message: "TODO comment without linked issue"
    include: ["*.ts", "*.js"]
    exclude: ["*.test.*"]
```

1. Filter changed files by `include`/`exclude` patterns
2. Search each matching file for the `pattern` regex
3. If found, produce a finding with the specified `severity` and `message`
4. Custom rule findings count toward the nit budget

### Pass 4 Finding Format

```yaml
- id: "conv-NNN"
  pass: "conventions"
  label: "<minor|nitpick|praise|thought|note>"  # NO blocker/critical/major allowed
  severity: <0-2>                        # Maximum severity: 2 (minor)
  file: "<file_path>"
  line_start: <number>
  line_end: <number|null>
  title: "<short title>"
  body: "<brief explanation>"
  suggestion: "<suggested fix or null>"
  confidence: <0.0-1.0>
  related_to: []
  suppressed: false
```

### Pass 4 Deduplication Against Passes 1-3

Before finalizing Pass 4 findings:
1. Check each Pass 4 finding against all Pass 1-3 findings
2. If a Pass 4 finding overlaps with a finding from Passes 1-3 (same file, overlapping lines, similar concern), DROP the Pass 4 finding
3. Log dropped findings with reason "duplicate of [other_finding_id]"

### Pass 4 Budget Enforcement

After deduplication:
1. Count remaining findings (excluding `praise` and `note`)
2. If count > `config.max_nits` (default: 3):
   - Sort by confidence (ascending)
   - Drop lowest-confidence findings until count == max_nits
   - Log dropped findings with reason "nit_budget_exceeded"

---

## ASSEMBLE REVIEW_FINDINGS

After all passes complete (or are skipped), assemble the `REVIEW_FINDINGS` object:

### Assembly Steps

1. **Collect** findings from all completed passes
2. **Apply path-rule suppressions**: For each finding, check if its file matches a `path_rules` entry with `suppress_below`. If finding severity is below the threshold, set `suppressed: true`
3. **Apply suppression rules**: Check each finding against `config.suppressions` (by ID and message pattern). If matched, set `suppressed: true`
4. **Count totals**: Aggregate counts by label (excluding suppressed findings)
5. **Set pass statuses**: `"completed"`, `"skipped"`, or `"error"` for each pass

### Error Handling for Individual Passes

If a pass subagent fails:
1. Set that pass's status to `"error"`
2. Set its findings to `[]`
3. Add an error summary: "Pass [N] ([name]) failed: [error description]"
4. PROCEED with remaining passes — do NOT abort the review
5. R3 will note the failed pass in the review summary

---

## GATE ENFORCEMENT

<gate id="r2-exit" priority="9999">
  R2 MUST produce a REVIEW_FINDINGS object before proceeding to R3.
  
  VALID REVIEW_FINDINGS requires:
  1. At least ONE pass has status "completed" (not all skipped/errored)
  2. All findings conform to the Finding structure
  3. Totals are accurately calculated
  4. Pass 4 findings respect the max severity (2) and nit budget constraints
  
  If ALL passes are skipped → Valid (empty findings, proceed to R3)
  If ALL passes errored → ABORT with error. Cannot produce review.
  If SOME passes errored → Valid (proceed with partial results)
</gate>

---

## STATE CHECKPOINT

After R2 completes, output:

```
[R2 COMPLETE] Passes: [N] completed, [N] skipped, [N] errored
Findings: [blocker]B [critical]C [major]M [minor]m [nit]n [praise]p
→ Proceeding to R3 (Comment Synthesis)
```

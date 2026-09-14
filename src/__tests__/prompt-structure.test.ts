import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { posix, resolve } from "node:path"
import { evaluateRules } from "../evaluate-rules"
import v1Plugin from "../index"
import { parseFrontmatter } from "../parse-frontmatter"
import { root, skillDir } from "../paths"
import v2Plugin from "../server"
import { toV2Permissions } from "../to-v2-permissions"
import { createFakeContext } from "./fake-context"

type Corpus = Record<string, string>
type Kind = "agent" | "command" | "skill" | "reference"
type FileRule = { class: string; budget: string; headings: string[] }
type Definition = { owner: string; heading?: string; field?: string; values?: string[] }
type Contract = {
  version: number; totalLines: number; mustNotPerFile: number
  budgetClasses: Record<string, number>
  enforcementClasses: Record<string, { enforced: boolean }>
  frontmatter: Record<Kind, { allowed: string[]; required: string[] }>
  files: Record<string, FileRule>
  definitions: Record<string, Definition>
  sections: Record<string, { maxLines: number; owners: { file: string; heading: string }[]; requiredHeadings: string[] }>
  dispatches: Record<string, string[]>
}
const budgets: Contract = JSON.parse(readFileSync(resolve(root, "prompt-budgets.json"), "utf8"))
const identities = {
  agent: ["code-explorer", "code-implementer", "code-quality", "corvus", "corvus-auto", "corvus-review", "corvus-review-auto", "plan-reviewer", "pr-code-reviewer", "pr-comment-writer", "pr-context-gatherer", "requirements-analyst", "researcher", "security-reviewer", "task-planner", "ux-dx-quality"],
  command: ["cleanup-subagents", "git-commit", "readme", "summary"],
  skill: ["corvus-extras", "corvus-phase-0", "corvus-phase-1", "corvus-phase-2", "corvus-phase-4", "corvus-phase-5", "corvus-phase-6", "corvus-phase-7", "corvus-review-extras", "corvus-review-r0", "corvus-review-r1", "corvus-review-r2", "corvus-review-r3", "corvus-review-r4", "corvus-review-r5", "deep-research", "frontend-design", "web-search"],
}
const expectedFiles = Object.entries(identities).flatMap(([kind, names]) => names.map(name =>
  kind === "skill" ? `skill/${name}/SKILL.md` : `${kind}/${name}.md`))
const sameNames = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
const lines = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")
const countLines = (text: string) => text === "" ? 0 : lines(text).length
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const kindOf = (path: string): Kind => path.startsWith("skill/") && !/^skill\/[^/]+\/SKILL\.md$/.test(path)
  ? "reference" : path.split("/")[0] as Kind
const entryOf = (path: string) => kindOf(path) === "reference" ? `${path.split("/").slice(0, 2).join("/")}/SKILL.md` : path
const ruleOf = (path: string, c: Contract) => c.files[entryOf(path)]
const enabled = (path: string, c: Contract) => c.enforcementClasses[ruleOf(path, c)?.class]?.enforced === true

function readCorpus(dir = root, prefix = ""): Corpus {
  return Object.fromEntries(readdirSync(resolve(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry): [string, string][] => {
    const path = posix.join(prefix, entry.name)
    if (!prefix && !["agent", "command", "skill"].includes(entry.name)) return []
    if (entry.isSymbolicLink()) throw new Error(`Symlink in prompt corpus: ${path}`)
    return entry.isDirectory() ? Object.entries(readCorpus(dir, path)) : path.endsWith(".md") ? [[path, readFileSync(resolve(dir, path), "utf8")]] : []
  }))
}

function sections(text: string, title: string): string[] {
  const rows = lines(text), headings: { title: string; level: number; row: number }[] = []
  let fence = ""
  rows.forEach((line, row) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1]) fence = ""
    } else if (!fence) {
      const match = line.match(/^(#{1,6})\s+(.+?)\s*#*$/)
      if (match) headings.push({ title: match[2].toLowerCase(), level: match[1].length, row })
    }
  })
  return headings.flatMap((h, i) => h.title !== title.toLowerCase() ? [] : [rows.slice(h.row,
    headings.slice(i + 1).find(next => next.level <= h.level)?.row ?? rows.length).join("\n").trimEnd()])
}
const substantive = (section: string) => lines(section).slice(1).some(line => line.trim() && !/^\s*(?:#|<!--|```|~~~)/.test(line))
const writer = "agent/pr-comment-writer.md", r2 = "skill/corvus-review-r2/SKILL.md", r4 = "skill/corvus-review-r4/SKILL.md", r5 = "skill/corvus-review-r5/SKILL.md"
const reviewOrchestrators = ["agent/corvus-review.md", "agent/corvus-review-auto.md"]
const reviewStateResources = [".corvus/reviews/x/lock.yaml", ".corvus/reviews/x/.lock",
  `.corvus/reviews/x/${"a".repeat(40)}/REVIEW_DOCUMENT.md`, ".corvus/reviews/x/candidate.json", ".corvus/reviews/x/review-input.json",
  ".corvus/tasks/topic/reviews/pr1/lock.yaml", ".corvus/tasks/topic/reviews/local-topic/review-input.json"]
const externalSkillReferences = [
  "/cache/opencode/packages/corvus-ai@0.10.0-beta.1/node_modules/corvus-ai/skill/corvus-review-extras/schemas.md",
  "/home/user/.cache/opencode/packages/corvus-ai@0.10.0-beta.2/node_modules/corvus-ai/skill/corvus-review-extras/config.md",
  "C:\\Users\\user\\AppData\\Local\\opencode\\packages\\corvus-ai@0.10.0-beta.2\\node_modules\\corvus-ai\\skill\\corvus-review-extras\\state.md",
  "/cache/opencode2/plugins/corvus-ai/skill/corvus-review-extras/schemas.md",
  "/home/user/.cache/opencode/npm/corvus-ai/123/node_modules/corvus-ai/skill/corvus-review-extras/schemas.md",
  "/home/user/.config/opencode/skill/corvus-review-extras/config.md",
  "/home/user/.config/opencode/skills/corvus-review-extras/state.md",
  "/custom/config/opencode/skills/corvus-review-extras/schemas.md",
]
const externalSkillResources = externalSkillReferences.flatMap(path => [path, `${posix.dirname(path.replaceAll("\\", "/"))}/*`])
const reviewTools = ["corvus_review_payload", "corvus_review_verify", "corvus_review_post", "corvus_review_persist", "corvus_review_lock", "corvus_review_pr", "corvus_review_verdict", "corvus_review_sync"]
const detectors = ["agent/pr-code-reviewer.md", "agent/security-reviewer.md"]
const leafReviewers = [...detectors, writer, "agent/pr-context-gatherer.md"]
const autonomous = ["agent/corvus-auto.md", "agent/corvus-review-auto.md"]
const orchestrators = ["agent/corvus.md", "agent/corvus-auto.md"]
const gitDenies: Record<string, string[]> = {
  "git init*": ["git init", "git init --bare repo"],
  "git reset --hard*": ["git reset --hard", "git reset --hard HEAD~1"],
  "git push --force*": ["git push --force", "git push --force-with-lease origin HEAD"],
  "git push -f*": ["git push -f", "git push -f origin HEAD"],
  "git rebase*": ["git rebase", "git rebase origin/topic"],
  "rm -rf *": ["rm -rf build", "rm -rf build cache"],
  "rm -rf /*": ["rm -rf /tmp/example"],
  "rm -fr *": ["rm -fr build"],
  "rm -r *": ["rm -r build"],
  "sudo *": ["sudo command"],
}
const permissionFor = (path: string): Record<string, unknown> => ({
  "*": "allow",
  ...(leafReviewers.includes(path) ? { edit: "deny", write: "deny" } : {}),
  ...(autonomous.includes(path) ? { question: "deny" } : {}),
  ...(orchestrators.includes(path) ? { bash: { "*": "allow", ...Object.fromEntries(Object.keys(gitDenies).map(pattern => [pattern, "deny"])) } } : {}),
})
const permissionEntries = (permission: Record<string, unknown>): [string, unknown][] => Object.entries(permission)
  .flatMap(([action, effect]): [string, unknown][] => record(effect) ? Object.entries(effect).map(([pattern, value]) => [`${action}:${pattern}`, value]) : [[action, effect]])
type BodyPin = { name: string; required?: RegExp; forbidden?: RegExp; section?: string }
const bodyPins: Record<string, BodyPin[]> = {
  [r2]: [
    { name: "evidence-file", section: "Evidence Envelope", required: /<review_root>\/review-input\.json/ },
    { name: "dispatch-cap", section: "Evidence Envelope", required: /each complete dispatch prompt is ≤ (?:12,000|12000) characters/i },
    { name: "compaction", section: "Evidence Envelope", required: /compaction ladder.*drop pasted hunks → drop file summaries → pointer-only/i },
  ],
  [r4]: [
    { name: "authorized-artifact", required: /For authorized post\/auto_post, call corvus_review_payload with op freeze.*Only ok:true creates a usable POST_ARTIFACT descriptor for R5/i },
  ],
  [r5]: [
    { name: "metadata-controls", section: "Revalidate Immediately Before Dispatch", required: /Call corvus_review_pr op metadata with \{owner, name, pr\} before dispatch; compare ONLY code_head, base_sha, and state for posting-authorization revalidation.*CLOSED\/MERGED selects the Delivery Principle exception/i },
    { name: "metadata-notes", section: "Revalidate Immediately Before Dispatch", required: /Mergeability \(mergeable\/mergeStateStatus\) never invalidates posting; record its changes and CI\/check changes only as notes in the terminal summary, never as posting controls\./i },
    { name: "artifact-verification", required: /Call corvus_review_verify with \{op: "verify", artifactPath: <artifact_path>, expectedSha256: <expected_sha256>\} before dispatch, including each permitted re-dispatch.*Require ok:true\s*, sha256Match true, canonical true, no violations, and available measurements/i },
  ],
  [writer]: [
    { name: "inline-schema", section: "Closed Field Sets", required: /POST_ARTIFACT.*POST_REQUEST.*Comment.*POST_RESULT/ },
    { name: "no-skill-read", forbidden: /\.\.\/skill\// },
    { name: "digest-failure", required: /re-run verify once with the same descriptor; a digest mismatch is never accepted.*If it still fails, return not_posted\s*, reason verify: <tool diagnostic>/i },
    { name: "anchor-failure", required: /any anchor mismatch requests R5 relocation without changing the artifact\./i },
    { name: "no-retyping", required: /Never re-type, copy, rewrite, relocate or re-encode review content\./i },
    { name: "final-verification", required: /Call corvus_review_verify immediately before corvus_review_post\s*, with \{op: "verify", artifactPath: <artifact_path>, expectedSha256: <original expected_sha256>\}/i },
    { name: "verification-success", required: /Require ok:true\s*, sha256Match true, canonical true, no violations, and available measurements/i },
    { name: "tool-preflight", section: "1. Preflight Tools", required: /Preflight: before reading the artifact, confirm.*corvus_review_pr.*corvus_review_verify.*corvus_review_post.*callable.*not-exposed, cause unknown.*observed inventory.*Diagnostics never substitute for missing verification or posting tools/i },
    { name: "post-tool", required: /Call corvus_review_post once with \{artifactPath: <artifact_path>, expectedSha256: <expected_sha256>, repo: <repository>, prNumber: <pr_number>, headSha: <head_sha>, event: <event>\}/i },
    { name: "no-shell-post", forbidden: /gh api --method POST/ },
    { name: "shell-diagnostic-only", required: /Frontmatter-granted read-only bash is available for diagnostics; it never satisfies any verification step.*POST stays tool-only\./i },
    { name: "controls-only-read", section: "2. Validate Descriptor and Payload", required: /Body-line truncation is expected, not an incomplete controls read; never reconstruct or re-type content.*Granted JSON diagnostics may inspect the unchanged file, not supply verification/i, forbidden: /incomplete read fails local-only|consecutive windows/i },
  ],
  "command/git-commit.md": [
    { name: "staged-only", required: /\b(?:commit|operates?)\s+only\s+(?:on\s+)?(?:the\s+)?user['’]s\s+already\s+staged\s+(?:set|changes)\b/i },
    { name: "confirmation", required: /\b(?:ask\s+for|request)\s+(?:an?\s+)?explicit\s+(?:user\s+)?confirmation\b/i },
    { name: "no-staging", required: /\b(?:must\s+not|never)\s+stage\s+files\b/i, forbidden: /\bgit\s+add\b/i },
  ],
  "command/cleanup-subagents.md": [
    { name: "list-preview-only", required: /\b(?:with|if)\s+--list\b[^.]*\b(?:must\s+not|never)\b[^.]*\b(?:invoke|perform)\s+deletion\b[^.]*\.\s*(?:terminate|stop|end)\b[^.]*\bafter\s+(?:the\s+)?preview\b/i },
    { name: "confirmation", required: /\b(?:ask\s+for|request)\s+(?:an?\s+)?explicit\s+confirmation\s+only\s+after\s+(?:the\s+)?complete\s+preview\b/i },
  ],
  "agent/corvus-auto.md": [
    { name: "no-bulk-staging", forbidden: /\bgit\s+add\s+(?:-A\b|\.(?=\s|$))/i },
    { name: "discovered-base", forbidden: /--base(?:\s+|=)["']?(?:main|master)\b/i },
    { name: "no-per-phase-commits", section: "Git Delivery", forbidden: /\b(?:commit(?:s|[_ -](?:mode|granularity))?\b[^.]*\bper[- ]phase\b|per[- ]phase\s+commits?\b|commit(?:s|ting)?\s+(?:after|at\s+the\s+end\s+of|for)\s+(?:each|every)\s+phase\b|after\s+(?:each|every)\s+phase\b[^.]*\bcommit)\b/i },
  ],
}
const safetyFixtureBodies: Corpus = {
  [r2]: "## Evidence Envelope\n<review_root>/review-input.json\nEach complete dispatch prompt is ≤ 12,000 characters. The compaction ladder is: drop pasted hunks → drop file summaries → pointer-only evidence.",
  [r4]: "For authorized post/auto_post, call corvus_review_payload with op freeze. Only ok:true creates a usable POST_ARTIFACT descriptor for R5.",
  [r5]: '## Dispatch One Artifact\nCall corvus_review_verify with {op: "verify", artifactPath: <artifact_path>, expectedSha256: <expected_sha256>} before dispatch, including each permitted re-dispatch. Require ok:true, sha256Match true, canonical true, no violations, and available measurements.\n```json\n{"artifact_path":"<path>","expected_sha256":"<digest>","repository":{"owner":"<owner>","name":"<name>"},"pr_number":<pr_number>,"head_sha":"<head>","event":"<event>"}\n```'
    + '\n## Revalidate Immediately Before Dispatch\nCall corvus_review_pr op metadata with {owner, name, pr} before dispatch; compare ONLY code_head, base_sha, and state for posting-authorization revalidation. CLOSED/MERGED selects the Delivery Principle exception. Mergeability (mergeable/mergeStateStatus) never invalidates posting; record its changes and CI/check changes only as notes in the terminal summary, never as posting controls.',
  [writer]: '## Closed Field Sets\nPOST_ARTIFACT POST_REQUEST Comment POST_RESULT\nRe-run verify once with the same descriptor; a digest mismatch is never accepted. If it still fails, return not_posted, reason verify: <tool diagnostic>. Any anchor mismatch requests R5 relocation without changing the artifact. Never re-type, copy, rewrite, relocate or re-encode review content. Call corvus_review_verify immediately before corvus_review_post, with {op: "verify", artifactPath: <artifact_path>, expectedSha256: <original expected_sha256>}. Require ok:true, sha256Match true, canonical true, no violations, and available measurements. Call corvus_review_post once with {artifactPath: <artifact_path>, expectedSha256: <expected_sha256>, repo: <repository>, prNumber: <pr_number>, headSha: <head_sha>, event: <event>}. Frontmatter-granted read-only bash is available for diagnostics; it never satisfies any verification step. POST stays tool-only.\n### 1. Preflight Tools\nPreflight: before reading the artifact, confirm `corvus_review_pr`, `corvus_review_verify` and `corvus_review_post` are callable. Record absent tools as `not-exposed, cause unknown` with the observed inventory. Diagnostics never substitute for missing verification or posting tools.\n### 2. Validate Descriptor and Payload\nRead the artifact to extract only the controls anchor validation needs. Body-line truncation is expected, not an incomplete controls read; never reconstruct or re-type content. Granted JSON diagnostics may inspect the unchanged file, not supply verification.',
  "command/git-commit.md": "Commit only the user's already staged changes. Never stage files. Request explicit confirmation.",
  "command/cleanup-subagents.md": "With --list, never invoke deletion. Stop after the preview. Request explicit confirmation only after the complete preview.",
  "agent/corvus-auto.md": "## Git Delivery\nStage exact task-owned paths; use the discovered base and commit after final validation.",
}
const safetyText = (text: string) => text.replace(/`+/g, " ").replace(/\*/g, "").replace(/\s+/g, " ").trim()
const schemaValue = (value: string) => value.replace(/[`*]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
function definitionMatches(body: string, d: Definition): { valid: boolean }[] {
  if (d.heading) return sections(body, d.heading).map(text => ({ valid: substantive(text) }))
  const pattern = new RegExp(`^\\*\\*${escape(d.field!)}\\*\\*:([^\\n]*(?:\\n[ \\t]+[^\\n]+)*)`, "gm")
  return [...body.matchAll(pattern)].filter(m => m[1].includes("|")).map(m => ({
    valid: sameNames(m[1].split("|").map(schemaValue), d.values!.map(schemaValue)),
  }))
}

/**
 * Oracle: the supplied corpus snapshot, JSON contract and test-owned safety pins, read before validation;
 * validation never mutates its inputs. Missing files, malformed metadata, identity/dispatch
 * loss and permission-contract drift fail in every mode. A false cohort flag disables
 * its size/heading/definition/prohibition checks, not those unconditional checks. References inherit
 * their entry's cohort. Total size binds when all cohorts are on or final mode is requested;
 * final mode additionally rejects every false flag. No consumer treats an absent file as
 * an exemption. Fixtures clone inputs before seeding violations; no fixture writes disk.
 * Safety pins inspect parsed permission maps and whitespace-normalized prompt bodies
 * before any rollout skip; comments cannot satisfy required clauses. Missing clauses, unexpected rules or
 * ineffective destructive-bash denies fail for every consumer; no flag disables them.
 * The top-level wildcard allows all actions except the exact test-owned deny set. Ordered
 * translation must preserve those denies. R5's dispatch keys and writer artifact guards are pinned before any skip;
 * a missing guard or body-bearing descriptor fails regardless of rollout flags.
 * Posting and shell discipline are prompt contracts, not frontmatter tool ownership.
 * Skill-reference access uses the default allow and the host-mirrored ordered evaluator
 * over test-owned install paths, before any corpus mutation or rollout skip. Every consumer
 * fails on ineffective read or external-directory access; no flag disables this pin.
 */
function validate(corpus: Corpus, c: Contract, final = false): string[] {
  const errors: string[] = [], check = (ok: boolean, code: string) => { if (!ok) errors.push(code) }
  check(c.version === 1 && [c.totalLines, c.mustNotPerFile, ...Object.values(c.budgetClasses)].every(n => Number.isInteger(n) && n > 0), "config:budgets")
  check(sameNames(Object.keys(c.files), expectedFiles), "config:inventory")
  check(sameNames(Object.keys(c.definitions), ["plan-format", "frontier", "slice", "gate", "depth", "tests", "status"]), "config:definitions")
  check(sameNames(Object.keys(c.dispatches), ["AMEND_PLAN", "PLAN_FIX", "PROGRESS_UPDATE", "FAILURE_ANALYSIS", "SUCCESS_EXTRACTION", "REMEDIATION_LEDGER"]) && Object.values(c.dispatches).every(targets => targets.length > 0), "config:dispatches")
  check(sameNames(Object.keys(c.sections), ["plan-template", "review-machinery"]) && Object.values(c.sections).every(s => Number.isInteger(s.maxLines) && s.maxLines > 0 && s.owners.length > 0), "config:sections")
  check(Object.values(c.definitions).every(d => !!d.heading !== !!d.field && (d.heading || d.values?.length)), "config:definitions")
  for (const [name, flag] of Object.entries(c.enforcementClasses)) {
    check(typeof flag.enforced === "boolean" && Object.values(c.files).some(f => f.class === name), `config:class:${name}`)
    if (final) check(flag.enforced === true, `final:class:${name}`)
  }
  for (const [path, rule] of Object.entries(c.files)) check(!!c.enforcementClasses[rule.class] && rule.budget in c.budgetClasses, `config:file:${path}`)
  const owners = [...Object.values(c.definitions).map(d => d.owner), ...Object.values(c.sections).flatMap(s => s.owners.map(o => o.file)), ...Object.values(c.dispatches).flat()]
  for (const owner of owners) check(!!ruleOf(owner, c), `config:owner:${owner}`)
  if (errors.some(error => error.startsWith("config:"))) return errors
  check(sameNames(Object.keys(corpus).filter(p => kindOf(p) !== "reference"), expectedFiles), "inventory")
  for (const owner of owners) check(owner in corpus, `missing:${owner}`)
  const bodies: Corpus = {}, links = new Map<string, string[]>()
  for (const [path, text] of Object.entries(corpus)) {
    const kind = kindOf(path), rule = ruleOf(path, c)
    check(!!rule, `inventory:${path}`)
    if (!rule) continue
    let fm: Record<string, unknown> = {}, body = text
    try {
      if (kind !== "reference" || /^---\r?\n/.test(text)) {
        const parsed = parseFrontmatter(text)
        if (!record(parsed.frontmatter)) throw new Error("Expected a mapping")
        fm = parsed.frontmatter; body = parsed.body
      }
      const schema = c.frontmatter[kind]
      check(Object.keys(fm).every(k => schema.allowed.includes(k)) && schema.required.every(k => k in fm), `frontmatter:${path}`)
      if (kind !== "reference") check(typeof fm.description === "string" && !!fm.description.trim() && !!body.trim(), `frontmatter:${path}`)
      if (kind === "skill") check(fm.name === path.split("/")[1], `identity:${path}`)
      if (kind === "agent") {
        check(fm.mode === (posix.basename(path).startsWith("corvus") ? "primary" : "subagent") && typeof fm.temperature === "number" && Number.isFinite(fm.temperature) && record(fm.permission), `frontmatter:${path}`)
        check(fm.color === undefined || typeof fm.color === "string" && /^#[\da-f]{6}$/i.test(fm.color), `frontmatter:${path}`)
        const permission = record(fm.permission) ? fm.permission : {}
        const expected = permissionFor(path), entries = permissionEntries(permission), rules = toV2Permissions(permission)
        check(permission["*"] === "allow" && Object.keys(permission)[0] === "*"
          && sameNames(Object.keys(permission), Object.keys(expected))
          && (!orchestrators.includes(path) || record(permission.bash) && Object.keys(permission.bash)[0] === "*")
          && sameNames(entries.filter(([, effect]) => effect === "deny").map(([key]) => key),
            permissionEntries(expected).filter(([, effect]) => effect === "deny").map(([key]) => key))
          && entries.every(([key, effect]) => effect === (key === "*" || key === "bash:*" ? "allow" : "deny")), `safety:${path}`)
        check(externalSkillResources.every(resource => ["read", "external_directory"].every(action =>
          evaluateRules(rules, action, resource) === "allow")), `safety:${path}:skill-references`)
        check(evaluateRules(rules, "edit", "src/file.ts") === (leafReviewers.includes(path) ? "deny" : "allow")
          && evaluateRules(rules, "question", "*") === (autonomous.includes(path) ? "deny" : "allow"), `safety:${path}`)
        if (orchestrators.includes(path)) {
          const bash = record(permission.bash) ? permission.bash : {}, rules = toV2Permissions(permission)
          for (const [pattern, commands] of Object.entries(gitDenies)) check(bash[pattern] === "deny"
            && bash["*"] === "allow" && Object.keys(bash)[0] === "*" && commands.every(command => evaluateRules(rules, "shell", command) === "deny"), `safety:${path}:${pattern}`)
        }
      }
    } catch { check(false, `frontmatter:${path}`) }
    bodies[path] = body
    if (path === r5) {
      const blocks = [...sections(body, "Dispatch One Artifact").join("\n").matchAll(/```json\n([\s\S]*?)\n```/g)]
      let descriptor: unknown
      try { descriptor = JSON.parse(blocks[0]?.[1].replaceAll("<pr_number>", "1") ?? "") } catch { descriptor = null }
      check(blocks.length === 1 && record(descriptor)
        && sameNames(Object.keys(descriptor), ["artifact_path", "expected_sha256", "repository", "pr_number", "head_sha", "event"])
        && record(descriptor.repository) && sameNames(Object.keys(descriptor.repository), ["owner", "name"]), `safety:${path}:artifact-dispatch`)
    }
    if (kind === "command") check(!/!`\s*(?:git\s+(?:add|commit|push|checkout|switch|branch|reset|clean)\b|gh\s+pr\s+create\b|(?:rm|mv|cp)\s)/i.test(body), `safety:${path}`)
    for (const pin of bodyPins[path] ?? []) {
      const parts = pin.section ? sections(body, pin.section) : [body]
      const text = parts.join("\n"), instructions = safetyText(text.replace(/<!--[\s\S]*?-->/g, ""))
      check(parts.length === 1 && (!pin.required || pin.required.test(instructions))
        && (!pin.forbidden || !pin.forbidden.test(safetyText(text))), `safety:${path}:${pin.name}`)
    }
    for (const link of body.matchAll(/\]\(([^\s)]+\.md)(?:#[^\s)]*)?\)/g)) {
      if (/^(?:[a-z]+:|\/)|[<{]/i.test(link[1])) continue
      const target = posix.normalize(posix.join(posix.dirname(path), link[1]))
      if (/^(?:agent|command|skill)\//.test(target)) {
        check(target in corpus, `reference:${target}`)
        links.set(path, [...(links.get(path) ?? []), target])
      }
    }
    if (!enabled(path, c)) continue
    const limit = c.budgetClasses[kind === "reference" ? "reference" : rule.budget]
    check(countLines(text) <= limit, `lines:${path}`)
    check((text.match(/\bMUST\s+NOT\b/g) ?? []).length <= c.mustNotPerFile, `must-not:${path}`)
    for (const heading of kind === "reference" ? [] : rule.headings) check(sections(body, heading).some(substantive), `heading:${path}:${heading}`)
  }
  const reachable = new Set(expectedFiles.filter(path => path in corpus))
  for (const path of reachable) for (const target of links.get(path) ?? []) if (target in corpus) reachable.add(target)
  for (const path of Object.keys(corpus)) if (kindOf(path) === "reference") check(reachable.has(path), `reference-unlinked:${path}`)
  for (const [token, targets] of Object.entries(c.dispatches)) for (const target of targets) {
    const family = Object.entries(bodies).filter(([path]) => path === target || entryOf(path) === target).map(([, body]) => body).join("\n")
    check(target in corpus && new RegExp(`\\b${escape(token)}\\b`).test(family), `dispatch:${target}:${token}`)
  }
  for (const [name, d] of Object.entries(c.definitions)) {
    const occurrences = Object.entries(bodies).filter(([p]) => enabled(p, c))
      .flatMap(([path, body]) => definitionMatches(body, d).map(match => ({ path, ...match })))
    check(occurrences.every(o => o.path === d.owner && o.valid) && occurrences.length === (enabled(d.owner, c) ? 1 : 0), `definition:${name}`)
  }
  for (const [name, section] of Object.entries(c.sections)) {
    if (!section.owners.every(o => enabled(o.file, c))) continue
    const found = section.owners.flatMap(o => sections(bodies[o.file] ?? "", o.heading))
    check(section.owners.every(o => sections(bodies[o.file] ?? "", o.heading).length === 1) && found.every(substantive), `section:${name}`)
    check(found.reduce((sum, text) => sum + countLines(text), 0) <= section.maxLines, `section-lines:${name}`)
    for (const heading of section.requiredHeadings) check(new RegExp(`^#{1,6}\\s+${escape(heading)}\\s*$`, "mi").test(found.join("\n")), `schema:${name}:${heading}`)
  }
  if (final || Object.values(c.enforcementClasses).every(flag => flag.enforced)) check(Object.values(corpus).reduce((sum, text) => sum + countLines(text), 0) <= c.totalLines, "lines:total")
  return [...new Set(errors)].sort()
}

function fixture(): { corpus: Corpus; contract: Contract } {
  const contract = structuredClone(budgets), corpus: Corpus = {}
  for (const flag of Object.values(contract.enforcementClasses)) flag.enforced = true
  for (const [path, rule] of Object.entries(contract.files)) {
    const kind = kindOf(path), name = path.split("/")[1].replace(/\.md$/, "")
    const permission = permissionFor(path)
    const fm = kind === "agent" ? { description: "Fixture", mode: name.startsWith("corvus") ? "primary" : "subagent", temperature: 0.1, permission }
      : kind === "skill" ? { name, description: "Fixture" } : { description: "Fixture" }
    const parts = new Map(rule.headings.map(h => [h, "Fixture content."]))
    for (const d of Object.values(contract.definitions)) if (d.owner === path && d.heading) parts.set(d.heading, "Fixture definition.")
    for (const s of Object.values(contract.sections)) for (const o of s.owners) if (o.file === path) parts.set(o.heading,
      s.requiredHeadings.length ? "```markdown\n" + s.requiredHeadings.map(h => `## ${h}\nFixture content.`).join("\n") + "\n```" : "Fixture procedure.")
    const fields = Object.values(contract.definitions).filter(d => d.owner === path && d.field).map(d => `**${d.field}**: ${d.values!.join(" | ")}`)
    const dispatch = Object.entries(contract.dispatches).filter(([, owners]) => owners.includes(path)).map(([token]) => token)
    corpus[path] = `---\n${JSON.stringify(fm)}\n---\n# ${name}\n${fields.join("\n")}\n${dispatch.join("\n")}\n` + [...parts].map(([h, body]) => `## ${h}\n${body}\n`).join("\n")
    if (path in safetyFixtureBodies) corpus[path] += `\n${safetyFixtureBodies[path]}\n`
  }
  return { corpus, contract }
}
const withLines = (text: string, count: number) => text + "\n".repeat(count - countLines(text))
const planner = "agent/task-planner.md", phase4 = "skill/corvus-phase-4/SKILL.md"

function mutatePermission(corpus: Corpus, path: string, mutate: (permission: Record<string, unknown>) => void): Corpus {
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(corpus[path])
  if (!record(frontmatter.permission)) throw new Error(`Missing permission map: ${path}`)
  const before = JSON.stringify(frontmatter.permission)
  mutate(frontmatter.permission)
  expect(JSON.stringify(frontmatter.permission)).not.toBe(before)
  return { ...corpus, [path]: `---\n${JSON.stringify(frontmatter)}\n---\n${body}` }
}

describe("prompt structure", () => {
  test("delivery principle is canonical and rejects an added coverage no-post trigger", () => {
    const corpus = readCorpus(), extras = "skill/corvus-review-extras/SKILL.md"
    const principle = "Delivery is the default. Once R3 synthesis exists, the review IS posted in autonomous mode (COMMENT event when identity/config cap applies)."
    const reasons = ["LOCAL mode (no PR)", "PR state CLOSED/MERGED at R5 revalidation", "the writer agent or its required tools are not exposed by the host", "GitHub rejected the POST after the writer's attempt", "frozen artifact fails verification after re-freeze"]
    const delivery = sections(corpus[extras], "Delivery Principle")[0].replace(/<!--[^]*?-->/g, "")
    expect(delivery).toContain(principle)
    expect(delivery.match(/The ONLY reasons not to post: ([^]*?)\. Everything else/)?.[1].split("; ")).toEqual(reasons)
    expect(delivery).toContain("stop retrying only when two consecutive attempts yield the identical result, then proceed with what exists")
    expect(Object.values(corpus).filter(text => text.includes(principle))).toHaveLength(1)
    // The owning R4 prose is the oracle before in-memory seeding; unlisted no-post
    // clauses reject, with no rollout exemption and no writes from this check.
    const invalidTrigger = (text: string) => text.split(/\n/).some(line => /local_only/.test(line)
      && !/For LOCAL,.*Emit REVIEW_ACTION `local_only`, reason `LOCAL review — posting is not applicable`/.test(line))
    expect(invalidTrigger(corpus[r4])).toBe(false)
    expect(invalidTrigger(corpus[r4] + "\nIf coverage is incomplete, emit local_only.\n")).toBe(true)
    expect(corpus[r4]).toContain("writer_capability_not_exposed")
    for (let phase = 0; phase <= 5; phase++) expect(corpus[`skill/corvus-review-r${phase}/SKILL.md`]).toContain("Delivery Principle")
    expect(corpus[r2]).toContain("complete PR description verbatim")
    for (const path of detectors) {
      const sentence = "If the brief lacks evidence you need, fetch it yourself with corvus_review_pr read ops `metadata|head|files|diff|reviews|checks`; note what you fetched."
      expect(corpus[path]).toContain(sentence)
      expect(corpus[path].replace(sentence, "")).not.toContain(sentence)
    }
  })
  test("review recovery removes old stop rails and fixed retry limits at every consumer", () => {
    const corpus = readCorpus()
    const obsolete = /stop locally|terminate|local[- ]only unless|at most (one|once|two)|single (retry|correction)|exactly one retry/i
    for (const [path, text] of Object.entries(corpus).filter(([path]) => path.startsWith("skill/corvus-review-")
      || /^agent\/(?:corvus-review.*|pr-.*|security-reviewer)\.md$/.test(path))) expect(text, path).not.toMatch(obsolete)
    for (const seed of ["stop locally", "terminate", "local-only unless", "at most once", "single retry", "single correction", "exactly one retry"])
      expect(corpus[r4] + `\nOn a coverage gap, ${seed}.`).toMatch(obsolete)
  })
  test("writer verification repair and ambiguous transport recovery preserve delivery and remote truth", () => {
    const corpus = readCorpus()
    // Owning prose is read before seeded changes; missing recovery, marker identity,
    // or verification fails regardless of rollout flags. These probes never write files.
    const cases: [string, string, RegExp, string, string][] = [
      [writer, "3. Verify Current Head", /op: "head".*Missing head evidence is fetched.*retry while progress is made.*post tool perform its independent head read/,
        "retry while progress is made", "give up immediately"],
      [writer, "5. Verify the Artifact", /re-run verify once with the same descriptor.*If it still fails, return not_posted\s*, reason verify: <tool diagnostic>.*R4's re-freeze checkpoint/,
        "re-run verify once", "accept verification failure"],
      [r4, "Verification Recovery", /On writer not_posted with reason verify: <diagnostic>.*re-freeze once.*verification_refreeze_attempted.*new expected digest.*frozen artifact fails verification after re-freeze/,
        "re-freeze once", "reuse invalid bytes"],
      [writer, "6. Submit Through the Tool", /Before POST, check corvus_review_pr op reviews.*exact body_marker and commit_id with matching event.*return a matching usable html_url instead of posting again/,
        "commit_id with matching event", "marker alone"],
      [r5, "Reconcile Writer Transport", /Require ok:true and complete_pagination:true to prove absence.*Complete evidence proving no matching review after unknown\/malformed transport: make ONE more writer dispatch.*transport_repost_attempted.*without another ambiguous-transport POST/,
        "complete_pagination:true to prove absence", "incomplete pagination proves absence"],
    ]
    for (const [path, section, pattern, before, after] of cases) {
      const text = sections(corpus[path], section).join("\n").replace(/<!--[^]*?-->/g, "")
      expect(safetyText(text), `${path}: ${section}`).toMatch(pattern)
      const changed = text.replace(before, after)
      expect(changed).not.toBe(text)
      expect(safetyText(changed)).not.toMatch(pattern)
    }
    expect(corpus[writer]).toContain("not an idempotency guarantee")
  })
  test("validates the corpus at its rollout flags; CORVUS_PROMPT_FINAL=1 requires convergence", () => {
    const corpus = readCorpus()
    expect(validate(corpus, budgets, process.env.CORVUS_PROMPT_FINAL === "1")).toEqual([])
    const total = Object.values(corpus).reduce((sum, text) => sum + countLines(text), 0)
    expect(total).toBeLessThanOrEqual(4800)
    if (process.env.CORVUS_PROMPT_FINAL === "1") {
      console.info(`Prompt corpus: ${total}/4800 lines`)
      for (const [path, text] of Object.entries(corpus).filter(([path]) => reviewOrchestrators.includes(path)
        || [...detectors, writer, "agent/pr-context-gatherer.md"].includes(path) || /^skill\/corvus-review-(?:r[0-5]\/SKILL|extras\/(?:SKILL|state|schemas|config|interactive))\.md$/.test(path))) {
        const rule = ruleOf(path, budgets), cap = budgets.budgetClasses[kindOf(path) === "reference" ? "reference" : rule.budget]
        console.info(`${path}: ${countLines(text)}/${cap} lines`)
      }
    }
  })
  test("both source host entries retain the exact identities", async () => {
    const hooks = await v1Plugin({} as Parameters<typeof v1Plugin>[0])
    if (!hooks.config) throw new Error("Missing v1 config hook")
    const config: Parameters<NonNullable<typeof hooks.config>>[0] & { skills: { paths: string[] } } = { skills: { paths: [] } }
    await hooks.config(config)
    const fake = createFakeContext(), cleanup = await v2Plugin.setup(fake.ctx)
    try {
      expect(config.skills.paths).toEqual([skillDir])
      const v1 = { agent: Object.keys(config.agent ?? {}), command: Object.keys(config.command ?? {}), skill: readdirSync(config.skills.paths[0]).filter(name => existsSync(resolve(config.skills.paths[0], name, "SKILL.md"))) }
      const v2 = { agent: [...fake.agents.keys()], command: [...fake.commands.keys()], skill: [...fake.skills.keys()] }
      for (const kind of ["agent", "command", "skill"] as const) {
        expect(sameNames(v1[kind], identities[kind])).toBe(true)
        expect(sameNames(v2[kind], identities[kind])).toBe(true)
      }
      for (const name of identities.agent) {
        const v1Rules = toV2Permissions(config.agent![name]!.permission)
        const v2Rules = fake.agents.get(name)!.permissions
        if (detectors.includes(`agent/${name}.md`)) for (const rules of [v1Rules, v2Rules]) {
          expect(evaluateRules(rules, "read", ".corvus/reviews/x/review-input.json")).toBe("allow")
        }
        for (const tool of reviewTools) {
          expect(evaluateRules(v1Rules, tool, "*")).toBe("allow")
          expect(evaluateRules(v2Rules, tool, "*")).toBe("allow")
        }
      }
    } finally { await cleanup() }
  })
  test("the all-on fixture passes without freezing prose or ordinary uses of canonical words", () => {
    const { corpus, contract } = fixture()
    corpus[planner] += "\nUse the frontier, slice and gate; see the canonical plan format.\n**Depth**: quick\n**Tests**: deferred\n**Status**: [~] In Progress\n"
    corpus[planner] = corpus[planner].replace("## Workflow", "## WORKFLOW").replace("quick | standard | deep", "quick |\n  standard | deep")
    corpus[phase4] = corpus[phase4].replace("Fixture definition.", "A differently wrapped\ndefinition still has substance.")
    for (const field of ["status", "Status", "**status**"]) corpus[phase4] += `\n${field}: "completed | skipped | error"\n`
    expect(definitionMatches(corpus[phase4], contract.definitions.status)).toEqual([])
    expect(validate(corpus, contract, true)).toEqual([])
  })
  test("each metadata class rejects extra keys, missing keys, malformed YAML and identity loss even with flags off", () => {
    for (const path of [planner, "command/summary.md", phase4]) for (const mutation of ["extra", "missing", "yaml", "delete", "rename"]) {
      const { corpus, contract } = fixture()
      for (const f of Object.values(contract.enforcementClasses)) f.enforced = false
      if (mutation === "extra") corpus[path] = corpus[path].replace('"description":', '"unsupported":true,"description":')
      if (mutation === "missing") corpus[path] = corpus[path].replace('"description":"Fixture",', "").replace('"description":"Fixture"', "")
      if (mutation === "yaml") corpus[path] = "---\ninvalid: [\n---\nBody"
      if (mutation === "rename") corpus[path.replace(/\.md$/, "-renamed.md")] = corpus[path]
      if (["delete", "rename"].includes(mutation)) delete corpus[path]
      expect(validate(corpus, contract)).toContain(["delete", "rename"].includes(mutation) ? "inventory" : `frontmatter:${path}`)
    }
    const { corpus, contract } = fixture()
    corpus[phase4] = corpus[phase4].replace('"name":"corvus-phase-4"', '"name":"other"')
    expect(validate(corpus, contract)).toContain(`identity:${phase4}`)
    expect(sameNames(identities.agent.slice(1), identities.agent)).toBe(false)
    expect(sameNames([...identities.command, "extra"], identities.command)).toBe(false)
    for (const [before, after] of [['"mode":"subagent"', '"mode":"primary"'], ['"temperature":0.1', '"temperature":"cold"'], [`"permission":${JSON.stringify(permissionFor(planner))}`, '"permission":null'], ['"description":"Fixture"', '"description":""']]) {
      const f = fixture(); f.corpus[planner] = f.corpus[planner].replace(before, after)
      expect(validate(f.corpus, f.contract)).toContain(`frontmatter:${planner}`)
    }
    const f = fixture(); f.corpus[planner] = f.corpus[planner].replace('"description":', '"color":"not-hex","description":')
    expect(validate(f.corpus, f.contract)).toContain(`frontmatter:${planner}`)
  })
  test("every cohort independently activates budgets, headings and the prohibition ceiling at their boundaries", () => {
    for (const cohort of Object.keys(budgets.enforcementClasses)) {
      const { corpus, contract } = fixture()
      for (const flag of Object.values(contract.enforcementClasses)) flag.enforced = false
      const paths = Object.keys(contract.files).filter(p => contract.files[p].class === cohort)
      for (const path of paths) {
        const rule = contract.files[path], limit = contract.budgetClasses[rule.budget]
        corpus[path] += "\n" + "MUST NOT repeat. ".repeat(contract.mustNotPerFile)
        corpus[path] = withLines(corpus[path] + "\n", limit)
        contract.enforcementClasses[cohort].enforced = true
        expect(validate(corpus, contract)).not.toContain(`lines:${path}`)
        expect(validate(corpus, contract)).not.toContain(`must-not:${path}`)
        corpus[path] += "MUST NOT overflow.\n"
        for (const h of rule.headings) corpus[path] = corpus[path].replace(`## ${h}\n`, "## Removed\n")
        const active = validate(corpus, contract)
        expect(active).toContain(`lines:${path}`)
        expect(active).toContain(`must-not:${path}`)
        for (const h of rule.headings) expect(active).toContain(`heading:${path}:${h}`)
        contract.enforcementClasses[cohort].enforced = false
        expect(validate(corpus, contract)).toEqual([])
      }
    }
  })
  test("references inherit flags, consume both budgets, reject frontmatter and cannot hide missing targets", () => {
    const { corpus, contract } = fixture(), ref = "skill/corvus-phase-4/references/dispatch.md"
    corpus[phase4] += "\n[Dispatch](references/dispatch.md)\n"
    expect(validate(corpus, contract)).toContain(`reference:${ref}`)
    corpus[ref] = withLines("# Dispatch\n", contract.budgetClasses.reference)
    expect(validate(corpus, contract)).toEqual([])
    const unlinked = { ...corpus, [phase4]: corpus[phase4].replace("[Dispatch](references/dispatch.md)", "Dispatch") }
    expect(validate(unlinked, contract)).toContain(`reference-unlinked:${ref}`)
    const total = Object.values(corpus).reduce((sum, text) => sum + countLines(text), 0)
    contract.totalLines = total
    expect(validate(corpus, contract, true)).toEqual([])
    corpus[ref] += "overflow\n"
    expect(validate(corpus, contract)).toEqual([`lines:${ref}`, "lines:total"].sort())
    contract.enforcementClasses.execution.enforced = false
    expect(validate(corpus, contract)).toEqual([])
    expect(validate(corpus, contract, true)).toContain("final:class:execution")
    expect(validate(corpus, contract, true)).toContain("lines:total")
    corpus[ref] = '---\nname: hidden\n---\nBody'
    expect(validate(corpus, contract)).toContain(`frontmatter:${ref}`)
    delete corpus[phase4]
    expect(validate(corpus, contract, true)).toContain("inventory")
  })
  test("every canonical definition rejects omission, duplication, wrong ownership and empty or malformed definitions", () => {
    for (const [name, d] of Object.entries(budgets.definitions)) for (const mutation of ["missing", "duplicate", "moved", "invalid"]) {
      const { corpus, contract } = fixture()
      const original = d.heading ? sections(corpus[d.owner], d.heading)[0] : `**${d.field}**: ${d.values!.join(" | ")}`
      if (mutation !== "duplicate") corpus[d.owner] = corpus[d.owner].replace(original, "")
      if (mutation === "duplicate") corpus[d.owner] += `\n${original}\n`
      if (mutation === "moved") corpus["agent/code-explorer.md"] += `\n${original}\n`
      if (mutation === "invalid") corpus[d.owner] += d.heading ? `\n## ${d.heading}\n` : `\n**${d.field}**: invalid | values\n`
      expect(validate(corpus, contract)).toContain(`definition:${name}`)
    }
    const f = fixture(); f.corpus[planner] = f.corpus[planner].replace("quick | standard | deep", "quick | standard | deep | unknown")
    expect(validate(f.corpus, f.contract)).toContain("definition:depth")
  })
  test("section budgets and the plan schema reject overflow, omission and headings hidden in code examples", () => {
    for (const [name, s] of Object.entries(budgets.sections)) {
      const { corpus, contract } = fixture(), owner = s.owners[0]
      const original = sections(corpus[owner.file], owner.heading)[0]
      corpus[owner.file] = corpus[owner.file].replace(original, original + "\nexcess".repeat(s.maxLines))
      expect(validate(corpus, contract)).toContain(`section-lines:${name}`)
      corpus[owner.file] = corpus[owner.file].replace(sections(corpus[owner.file], owner.heading)[0], `\`\`\`markdown\n${original}\n\`\`\``)
      expect(validate(corpus, contract)).toContain(`section:${name}`)
      for (const h of s.requiredHeadings) {
        const f = fixture(); f.corpus[owner.file] = f.corpus[owner.file].replace(`## ${h}\n`, "## Removed\n")
        expect(validate(f.corpus, f.contract)).toContain(`schema:${name}:${h}`)
      }
    }
  })
  test("dispatch pins survive moving to references but each required endpoint rejects removal or suffix-only matches", () => {
    for (const [token, owners] of Object.entries(budgets.dispatches)) for (const owner of owners) {
      const { corpus, contract } = fixture()
      corpus[owner] = corpus[owner].replaceAll(token, `${token}_REMOVED`)
      expect(validate(corpus, contract)).toContain(`dispatch:${owner}:${token}`)
      if (owner.startsWith("skill/")) {
        corpus[owner.replace("SKILL.md", "dispatch.md")] = `# Dispatch\n${token}\n`
        corpus[owner] += "\n[Dispatch](dispatch.md)\n"
        expect(validate(corpus, contract)).not.toContain(`dispatch:${owner}:${token}`)
      }
    }
    const { corpus, contract } = fixture()
    for (const [token, pin] of [["review-input.json", "evidence-file"], ["12,000", "dispatch-cap"], ["compaction ladder", "compaction"]]) {
      const changed = corpus[r2].replace(token, "removed")
      expect(changed).not.toBe(corpus[r2])
      expect(validate({ ...corpus, [r2]: changed }, contract)).toContain(`safety:${r2}:${pin}`)
    }
  })
  test("capability widening and eager command mutations fail before rollout", () => {
    for (const path of [...autonomous, ...leafReviewers, ...orchestrators]) {
      const { corpus, contract } = fixture()
      contract.enforcementClasses[contract.files[path].class].enforced = false
      corpus[path] = corpus[path].replaceAll('"deny"', '"allow"')
      expect(validate(corpus, contract)).toContain(`safety:${path}`)
    }
    const { corpus, contract } = fixture(), command = "command/git-commit.md"
    corpus[command] += '\n!`git commit -m unsafe`\n'
    expect(validate(corpus, contract)).toContain(`safety:${command}`)
    contract.enforcementClasses.planner.enforced = false
    expect(validate(corpus, contract, true)).toContain("final:class:planner")
    delete contract.enforcementClasses.planner
    expect(validate(corpus, contract)).toContain(`config:file:${planner}`)
  })
  describe("safety", () => {
    const contract = structuredClone(budgets)
    for (const flag of Object.values(contract.enforcementClasses)) flag.enforced = false

    test.each(reviewOrchestrators)("review-state access inherits default allow without path maps: %s", path => {
      const { permission } = parseFrontmatter(readCorpus()[path]).frontmatter
      const rules = toV2Permissions(permission)
      for (const resource of [...reviewStateResources, "src/foo.ts", ".corvus/tasks/x/PLAN.md"])
        for (const target of [resource, `../${resource}`]) expect(evaluateRules(rules, "edit", target)).toBe("allow")
      expect(permission).not.toHaveProperty("edit")
      expect(permission).not.toHaveProperty("write")
    })

    test("lock acquisition checks both names and denial preserves evidence without halting analysis", () => {
      const lock = sections(readCorpus()["skill/corvus-review-extras/state.md"], "Namespace and Lock")[0]
      expect(lock).toContain("lock_path = <review_root>/lock.yaml")
      expect(lock).toContain("legacy_lock_path = <review_root>/.lock")
      const instructions = safetyText(lock.replace(/<!--[\s\S]*?-->/g, ""))
      expect(instructions).toMatch(/corvus_review_lock with \{op: "acquire", reviewRoot: review_root, runId\}/)
      expect(instructions).toMatch(/Only interactive question explicitly authorizes force:true/)
      expect(instructions).toMatch(/Every terminal branch calls corvus_review_lock with \{op: "release"/)
      expect(instructions).not.toMatch(/date -u|write the active YAML|Read BOTH/)
      const denial = safetyText(sections(lock, "Lock Permission Denial")[0])
      expect(denial).toMatch(/disclose and continue analysis in memory/)
      for (const field of ["attempted path", "resolved path/resource", "session/workspace root", "verbatim denial text", "unverified"])
        expect(denial).toContain(field)
      expect(denial).toContain("without claiming lock ownership or durability")
    })

    test("every agent defaults to allow with exactly its expected denies and no extra rules", () => {
      const corpus = readCorpus()
      expect(validate(corpus, contract)).toEqual([])
      for (const name of identities.agent) {
        const path = `agent/${name}.md`, { permission } = parseFrontmatter(corpus[path]).frontmatter
        const rules = toV2Permissions(permission)
        for (const tool of reviewTools) expect(evaluateRules(rules, tool, "*")).toBe("allow")
        for (const mutate of [
          (p: Record<string, unknown>) => { delete p["*"] },
          (p: Record<string, unknown>) => { p["*"] = "deny" },
          (p: Record<string, unknown>) => { p.skill = "deny" },
          (p: Record<string, unknown>) => { p.corvus_review_pr = "allow" },
          (p: Record<string, unknown>) => { p.external_directory = { "/cache/*": "deny" } },
          (p: Record<string, unknown>) => { p.task = "ask" },
        ]) expect(validate(mutatePermission(corpus, path, mutate), contract)).toContain(`safety:${path}`)
        if (!orchestrators.includes(path)) expect(validate(mutatePermission(corpus, path, p => { p.bash = { "*": "allow" } }), contract)).toContain(`safety:${path}`)
        for (const key of [...(leafReviewers.includes(path) ? ["edit", "write"] : []), ...(autonomous.includes(path) ? ["question"] : [])]) {
          for (const effect of [undefined, "allow", "ask"]) expect(validate(mutatePermission(corpus, path, p => {
            if (effect === undefined) delete p[key]
            else p[key] = effect
          }), contract)).toContain(`safety:${path}`)
        }
      }
    })

    test.each(reviewOrchestrators)("review orchestrators read external skill references: %s", path => {
      const { frontmatter } = parseFrontmatter(readCorpus()[path])
      const permission = frontmatter.permission as Record<string, unknown>
      const resource = externalSkillReferences[0]
      const hostAllows = toV2Permissions({ external_directory: { [`${posix.dirname(resource)}/*`]: "allow" } })
      const beforeRules = [...hostAllows, ...toV2Permissions({ ...permission, "*": "deny" })]
      const rules = [...hostAllows, ...toV2Permissions(permission)]
      for (const target of [resource, `${posix.dirname(resource)}/*`]) {
        expect(evaluateRules(hostAllows, "external_directory", target)).toBe("allow")
        expect(evaluateRules(beforeRules, "external_directory", target)).toBe("deny")
        expect({ path, target, effect: evaluateRules(rules, "external_directory", target) })
          .toEqual({ path, target, effect: "allow" })
      }
      for (const target of externalSkillResources) {
        expect(evaluateRules(rules, "external_directory", target)).toBe("allow")
        expect(evaluateRules(rules, "read", target)).toBe("allow")
        expect(evaluateRules(rules, "edit", target)).toBe("allow")
      }
      expect(evaluateRules(rules, "shell", "git rev-parse HEAD")).toBe("allow")
      expect(evaluateRules(rules, "shell", "git rev-parse --show-toplevel")).toBe("allow")
      for (const target of ["/etc/passwd", "/home/user/.ssh/id_ed25519", "/home/user/.config/opencode/opencode.json",
        "/cache/opencode/packages-other/secret", "/cache/opencode2-other/secret", "/custom/config/opencode/agents/reviewer.md"]) {
        expect(evaluateRules(rules, "external_directory", target)).toBe("allow")
      }
    })

    test("every agent reads installed references without injected grants with rollout flags off", () => {
      const corpus = readCorpus()
      for (const name of identities.agent) {
        const path = `agent/${name}.md`
        const code = `safety:${path}:skill-references`
        expect(validate(corpus, contract)).not.toContain(code)
        for (const action of ["read", "external_directory", "*"]) {
          const changed = mutatePermission(corpus, path, p => {
            p[action] = "deny"
          })
          expect(validate(changed, contract)).toContain(code)
        }
      }
    })

    test("artifact handoff guards reject retyped dispatches and fail-open writer procedures", () => {
      const corpus = readCorpus()
      const cases: [string, string, string, string][] = [
        [r4, "authorized-artifact", "For authorized post/auto_post", "For any decision"],
        [r5, "artifact-dispatch", '"expected_sha256": "<current artifact SHA-256>",', '"body": "<review_body>",'],
        [r5, "artifact-dispatch", '"event": "<approved event>"', '"event": "<approved event>", "comments": []'],
        [writer, "inline-schema", "## Closed Field Sets", "## Read the Shared Schema"],
        [writer, "no-skill-read", "no skill-directory read is needed", "read ../skill/corvus-review-extras/schemas.md"],
        [r4, "authorized-artifact", "Only `ok:true` creates a usable POST_ARTIFACT", "Any result creates a usable POST_ARTIFACT"],
        [r5, "artifact-verification", "before dispatch, including each permitted re-dispatch", "after dispatch"],
        [r5, "artifact-verification", "expectedSha256: <expected_sha256>", "expectedSha256: <new_digest>"],
        [r5, "metadata-controls", "compare ONLY code_head, base_sha, and state for posting-authorization revalidation", "unchanged code_head/base, state, draft and mergeability controls;"],
        [r5, "metadata-controls", "code_head, base_sha, and state", "code_head, base_sha, state, and mergeability"],
        [r5, "metadata-controls", "code_head, base_sha, and state", "code_head, base_sha, state, and draft"],
        [r5, "metadata-controls", "code_head, base_sha, and state", "code_head and state"],
        [r5, "metadata-controls", "CLOSED/MERGED selects the Delivery Principle exception", "CLOSED/MERGED never selects an exception"],
        [r5, "metadata-notes", "Mergeability (mergeable/mergeStateStatus) never invalidates posting", "Mergeability (mergeable/mergeStateStatus) invalidates posting"],
        [r5, "metadata-notes", "CI/check changes only as notes in the terminal summary", "CI/check changes as posting controls"],
        [writer, "digest-failure", "re-run verify once with the same descriptor", "accept the failed artifact"],
        [writer, "digest-failure", "a digest mismatch is never accepted", "a digest mismatch is accepted"],
        [writer, "anchor-failure", "any anchor mismatch requests R5 relocation without changing the artifact.", "any anchor mismatch permits guessed positions."],
        [writer, "no-retyping", "Never re-type, copy, rewrite, relocate or re-encode review content.", "Reconstruct the payload with the write tool."],
        [writer, "final-verification", "Call `corvus_review_verify` immediately before `corvus_review_post`", "Trust the earlier digest before submission"],
        [writer, "final-verification", "expectedSha256: <original expected_sha256>", "expectedSha256: <new_digest>"],
        [writer, "verification-success", "sha256Match true", "sha256Match false"],
        [writer, "verification-success", "canonical true", "canonical false"],
        [writer, "tool-preflight", "confirm `corvus_review_pr`, `corvus_review_verify` and `corvus_review_post` are callable", "assume all tools are callable"],
        [writer, "tool-preflight", "and `corvus_review_post` are callable", "and an optional tool is callable"],
        [writer, "tool-preflight", "Diagnostics never substitute for missing verification or posting tools", "Diagnostics substitute for missing verification or posting tools"],
        [writer, "tool-preflight", "Record absent tools as `not-exposed, cause unknown`", "Record absent tools as `anchors-unverifiable`"],
        [writer, "shell-diagnostic-only", "it never satisfies any verification step", "it may satisfy any verification step"],
        [writer, "shell-diagnostic-only", "POST stays tool-only.", "POST may use shell commands."],
        [writer, "post-tool", "Call `corvus_review_post` once with", "Construct a posting command with"],
        [writer, "post-tool", "repo: <repository>", "repo: <override>"],
        [writer, "no-shell-post", "The tool submits the file", "Run gh api --method POST"],
        [writer, "controls-only-read", "Body-line truncation is expected, not an incomplete controls read", "an incomplete read fails local-only"],
        [writer, "controls-only-read", "never reconstruct or re-type content", "use consecutive windows for large files"],
        [writer, "controls-only-read", "not supply verification", "supply verification"],
        [writer, "controls-only-read", "Read the artifact with the read tool to extract ONLY the small controls", "Read the artifact with the read tool to extract ONLY the small controls (an incomplete read fails local-only)"],
      ]
      expect(validate(corpus, contract)).toEqual([])
      for (const [path, pin, before, after] of cases) {
        const changed = corpus[path].replace(before, after)
        expect(changed).not.toBe(corpus[path])
        expect(validate({ ...corpus, [path]: changed }, contract)).toContain(`safety:${path}:${pin}`)
      }
    })

    test("writer maps transport outcomes into the closed result and R5 reconciles before a recovery POST", () => {
      const corpus = readCorpus()
      const mapping = safetyText(sections(corpus[writer], "7. Map Remote Truth").join("\n"))
      for (const row of [
        /posted \| status posted, remote_state posted, review_url from tool \(require usable URL\), reason null/,
        /rejected \| status local_only, remote_state not_posted, review_url null, reason <reason> \(HTTP <http_status>\) when supplied, otherwise tool reason/,
        /unknown \| status local_only, remote_state unknown, review_url null, reason from tool/,
        /api_calls = sum of corvus_review_pr result api_calls \+ post tool_api_calls/,
        /Body-only success includes commit-history reads; use reported counts, not a fixed total/,
        /When newly posted, inline_comments_posted is the artifact's comments count; otherwise 0, including marker reuse\. comments_moved_to_body is always 0/,
      ]) expect(mapping).toMatch(row)
      const reconcile = safetyText(sections(corpus[r5], "Reconcile Writer Transport").join("\n"))
      expect(reconcile).toMatch(/confirmed GitHub POST rejection is the delivery exception/)
      expect(reconcile).toMatch(/disclose uncertainty rather than claiming rejection or absence/)
      expect(reconcile).toMatch(/Empty\/malformed\/truncated\/schema-invalid result \| Child-transport failure/)
      expect(reconcile).toMatch(/Complete evidence proving no matching review after unknown\/malformed transport: make ONE more writer dispatch/)
    })

    test("large-diff recovery keeps evidence, progress-based relocation and bounded persistence payloads", () => {
      const corpus = readCorpus(), schemas = "skill/corvus-review-extras/schemas.md"
      const cases: [string, string, RegExp, string, string][] = [
        [writer, "4. Validate Inline Locations", /canonical diff.*oversized:true \(HTTP 406\/413\) or partial\/truncated diff text.*corvus_review_pr op files.*paginate: true/,
          "oversized:true", "oversized:false"],
        [writer, "4. Validate Inline Locations", /each file's complete patch.*path membership.*complete hunk counts.*added\/context RIGHT-side lines.*multi-line span in one hunk/,
          "added/context RIGHT-side lines", "estimated local lines"],
        [writer, "4. Validate Inline Locations", /absent patch.*truncated patch.*incomplete pagination makes that anchor unverifiable.*If ALL anchors verify, proceed; otherwise finish available anchor diagnostics and hand off to R5's relocation with status not_posted\s*, reason anchors-unverifiable\s*, and unverifiable_anchors: \[\{path,line_start,line_end\}\].*only unresolved anchors.*no POST attempted/,
          "only unresolved anchors", "all anchors"],
        [writer, "4. Validate Inline Locations", /If ALL anchors verify, proceed; otherwise finish available anchor diagnostics and hand off to R5's relocation/,
          "If ALL anchors verify, proceed", "Proceed even with unverifiable anchors"],
        [writer, "Closed Field Sets", /Status not_posted requires remote_state not_posted, null URL, zero inline_comments_posted and a reason: anchors-unverifiable, verify: <diagnostic>, head-moved or not-exposed: <inventory>.*Only anchors-unverifiable includes a non-empty unverifiable_anchors array/,
          "Only anchors-unverifiable", "Every reason"],
        [schemas, "POST_REQUEST and POST_RESULT — R5/Writer", /status: "posted \| not_posted \| local_only".*unverifiable_anchors:.*line_start:.*line_end:.*required only for reason anchors-unverifiable; otherwise omitted/,
          "unverifiable_anchors:", "missing_positions:"],
        [r5, "Reconcile Writer Transport", /Valid POST_RESULT not_posted, reason anchors-unverifiable \| Follow Anchor Relocation, not transport recovery/,
          "Follow Anchor Relocation", "Terminate local_only"],
        [r5, "Anchor Relocation", /match each unique \{path,line_start,line_end\} in unverifiable_anchors.*frozen artifact and REVIEW_DOCUMENT.*reject unknown positions.*Relocate ONLY those matching inline comments.*own axis's review body.*preserving each entire comment body, identity and suggestion unchanged/,
          "Relocate ONLY those matching inline comments", "Relocate every inline comment"],
        [r5, "Anchor Relocation", /increment R5's cumulative comments_moved_to_body by the number moved, not the number of unique anchors.*independently of the writer's zero count/,
          "number moved, not the number of unique anchors", "number of unique anchors"],
        [r5, "Anchor Relocation", /autonomous mode needs no new authorization because content is unchanged, only placement; interactive mode shows the relocation in a question.*explicit consent/,
          "in a question", "without a question"],
        [r5, "Anchor Relocation", /Invalidate the old descriptor.*persist the revised complete checkpoint and candidate.*corvus_review_payload measure → freeze.*corvus_review_verify with the new digest.*revalidate authorization\/current PR controls.*re-dispatch the writer\. Retry while progress is made/,
          "Retry while progress is made", "Abandon delivery after a fixed count"],
        ["skill/corvus-review-r3/SKILL.md", "Render and Persist", /gatherer reports an oversized\/truncated diff.*additions\+deletions exceeds 20,000.*prefer body placement.*patches are unavailable in review-input\.json.*R4 needs no new payload-tool preflight/,
          "prefer body placement", "guess inline positions"],
        [r2, "Evidence Envelope", /corvus_review_persist.*op: "write_input".*Require ok:true.*before advertising the file to either child/,
          'op: "write_input"', 'op: "write_document"'],
      ]
      for (const [path, section, guard, before, after] of cases) {
        const prose = sections(corpus[path], section).join("\n").replace(/<!--[\s\S]*?-->/g, "")
        expect(safetyText(prose)).toMatch(guard)
        const changed = prose.replace(before, after)
        expect(changed).not.toBe(prose)
        expect(safetyText(changed)).not.toMatch(guard)
      }
      const command = "gh api --method GET --paginate repos/o/r/pulls/1/files -H Accept:application/vnd.github+json"
      expect(evaluateRules(toV2Permissions(parseFrontmatter(corpus[writer]).frontmatter.permission), "shell", command)).toBe("allow")
      expect(sections(corpus[r2], "Evidence Envelope").join("\n")).not.toMatch(/in ONE call|whole-JSON retry|never write JSON in two halves/)
    })

    test("tool-owned state and PR operations are pinned at each owner with negative controls", () => {
      const corpus = readCorpus(), extras = "skill/corvus-review-extras/", r0 = "skill/corvus-review-r0/SKILL.md", r3 = "skill/corvus-review-r3/SKILL.md"
      const owners: Array<[string, string, string, string[]]> = [
        [r0, "Validate the Locator", "corvus_review_pr", ["repo", "find", "local"]],
        [r0, "Fetch Immutable Metadata", "corvus_review_pr", ["metadata", "files"]],
        [r0, "Resolve and Pull State", "corvus_review_sync", ["resolve", "pull"]],
        [r0, "Establish State and Gather Rail Inputs", "corvus_review_pr", ["identity", "checks"]],
        [r0, "Prior-Review Evidence", "corvus_review_pr", ["reviews"]],
        [r0, "Load Config", "corvus_review_pr", ["config"]],
        [r2, "Evidence Envelope", "corvus_review_persist", ["write_input", "begin", "append", "finalize"]],
        [r3, "Render and Persist", "corvus_review_persist", ["begin", "append", "finalize", "read_document", "write_meta"]],
        [r3, "Measure Candidate", "corvus_review_persist", ["write_candidate"]],
        [r3, "Size Overflow", "corvus_review_persist", ["write_candidate"]],
        [r5, "Revalidate Immediately Before Dispatch", "corvus_review_pr", ["metadata"]],
        [r5, "Reconcile Writer Transport", "corvus_review_pr", ["reviews"]],
        [r5, "Anchor Relocation", "corvus_review_persist", ["write_candidate"]],
        [r5, "Complete Locally or Remotely", "corvus_review_sync", ["push"]],
        [`${extras}state.md`, "Namespace and Lock", "corvus_review_lock", ["acquire", "release"]],
        [`${extras}state.md`, "Persist at R3", "corvus_review_persist", ["begin", "append", "finalize", "read_document", "write_meta"]],
        [writer, "3. Verify Current Head", "corvus_review_pr", ["head"]],
        [writer, "4. Validate Inline Locations", "corvus_review_pr", ["diff", "files"]],
      ]
      for (const [path, section, tool, ops] of owners) {
        const prose = sections(corpus[path], section).join("\n").replace(/<!--[\s\S]*?-->/g, "")
        for (const token of [tool, ...ops.map(op => `"${op}"`)]) {
          const literal = token.startsWith('"') ? new RegExp(`(?:"|\x60)${escape(token.slice(1, -1))}(?:"|\x60)`) : new RegExp(escape(token))
          expect(prose, `${path} ${section}`).toMatch(literal)
          expect(prose.replace(new RegExp(literal.source, "g"), "removed")).not.toMatch(literal)
        }
      }
      // Oracle: authored clauses, checked before in-memory mutation. Missing order, identity,
      // layout or receipt separation fails regardless of rollout flags; no option disables these pins.
      const syncCases: [string, string, RegExp, string, string][] = [
        [r0, "Fetch Immutable Metadata", /op: "metadata".*op files.*include_corvus: true, names_only: true.*unfiltered layout inventory.*before lock\/resume\/verdict/,
          "include_corvus: true", "include_corvus: false"],
        [r0, "Resolve and Pull State", /corvus_review_sync with \{op: "resolve".*changed_files: <unfiltered inventory>.*Record returned root as review_root, task, remote and optional legacy_root.*Then call corvus_review_sync with \{op: "pull".*remote\}/,
          'op: "resolve"', 'op: "pull"'],
        [r0, "Resolve and Pull State", /state_sync: false skips pull with a note/,
          "skips pull", "skips resolve"],
        [r0, "Resolve and Pull State", /PR checkout failure\/unconfirmed tip or LOCAL detached scope also skips pull with a note/,
          "also skips pull", "also runs pull"],
        [r0, "LOCAL Intake", /Resolve and Pull State with pr\.local\.changed_files/,
          "pr.local.changed_files", "filtered_files"],
        [r5, "Complete Locally or Remotely", /write_meta records code_head\s*, observed head_sha\s*, verdict_file: verdict\.yaml.*Never store state_commit in meta.*After write_meta and owned-lock release, call corvus_review_sync with \{op: "push".*head_sha: code_head.*remote\}/,
          "After `write_meta`", "Before `write_meta`"],
        [r5, "Complete Locally or Remotely", /EVERY outcome: posted, local-only, not-posted, unknown and LOCAL.*state_sync: false skips push with a note.*Report synced plus returned state_commit or the reason/,
          "unknown and LOCAL", "unknown"],
        [r5, "Complete Locally or Remotely", /Never store state_commit in meta/,
          "Never store state_commit in meta", "Store state_commit in meta"],
        [`${extras}state.md`, "Namespace and Lock", /corvus_review_sync.*\.corvus\/tasks\/<task>\/reviews\/pr<N>.*local-<slug>.*\.corvus\/reviews\/pr<N>.*legacy_root is read-only for resume.*never a write\/lock target/,
          "read-only for resume", "writable for resume"],
        [`${extras}state.md`, "Namespace and Lock", /head_review_dir = <review_root>\/<code_head>/,
          "<review_root>/<code_head>", "<review_root>/<head_sha>"],
        [`${extras}config.md`, "Defaults and Validation", /state_sync \| true \| Boolean; false skips pull\/push with a note, not root resolution/,
          "state_sync |", "removed_sync |"],
        [writer, "2. Validate Descriptor and Payload", /R5 derives artifact_path from PR_CONTEXT\.review_root.*\.corvus\/reviews\/pr<pr_number>\/post-request\.json.*\.corvus\/tasks\/<task>\/reviews\/pr<pr_number>\/post-request\.json/,
          "PR_CONTEXT.review_root", "review_text.path"],
        [writer, "3. Verify Current Head", /require ok:true and lowercase 40-hex code_head equal to commit_id/,
          "code_head equal to commit_id", "head_sha equal to commit_id"],
        [r5, "Reconcile Writer Transport", /commit_id equal to code_head/,
          "commit_id equal to code_head", "commit_id equal to head_sha"],
        ...reviewOrchestrators.map((path): [string, string, RegExp, string, string] => [path, "Operating Rules",
          /A state commit at the tip is not a head move; compare code_head/,
          "not a head move", "a head move"]),
      ]
      for (const [path, section, guard, before, after] of syncCases) {
        const prose = sections(corpus[path], section).join("\n").replace(/<!--[\s\S]*?-->/g, "")
        expect(safetyText(prose), `${path}: ${section}`).toMatch(guard)
        const changed = prose.replace(before, after)
        expect(changed).not.toBe(prose)
        expect(safetyText(changed)).not.toMatch(guard)
      }
      const marker = "<!-- corvus-review v2 path=<root> head=<code_head> round=<n> -->"
      const rendering = sections(corpus[r3], "Render and Persist").join("\n")
      expect(rendering).toContain("```markdown\n" + marker + "\n```")
      expect(rendering.replace(marker, "<!-- corvus-review v1 head:<head_sha> -->")).not.toContain(marker)
      const completion = safetyText(sections(corpus[r5], "Complete Locally or Remotely").join("\n"))
      const metaFields = (text: string) => /write_meta records (.*?) — never copy counts/.exec(text)?.[1]
      expect(metaFields(completion)).toBeDefined()
      expect(metaFields(completion)).not.toContain("state_commit")
      expect(metaFields(completion.replace("write_meta records", "write_meta records state_commit,"))).toContain("state_commit")
      const legacyRoot = /\.corvus\/reviews\/<owner>__|\breview_root\s*=\s*[^\n]*local__/
      for (const path of Object.keys(corpus).filter(path => path.startsWith("skill/corvus-review-")
        || reviewOrchestrators.includes(path) || [writer, "agent/pr-context-gatherer.md"].includes(path))) {
        const body = kindOf(path) === "reference" ? corpus[path] : parseFrontmatter(corpus[path]).body
        expect(body, path).not.toMatch(legacyRoot)
        expect(body + "\nreview_root = .corvus/reviews/local__repo__slug").toMatch(legacyRoot)
      }
      for (const [path, section, forbidden, seed] of [
        [r0, "", /gh api|gh pr view|gh pr checks/, "gh api"],
        [r0, "Validate the Locator", /stops without a question call|terminates locally/, "Missing input stops without a question call; autonomous mode terminates locally."],
        ...detectors.flatMap(path => [
          [path, "Trust and Capability Boundary", /Use only read, glob, and grep/, "Use only read, glob, and grep."],
          [path, "Trust and Capability Boundary", /execute commands/, "Never execute commands."],
        ] as const),
        [r5, "", /gh api|gh pr view|date -u/, "gh api"],
        [writer, "", /gh api|gh pr view/, "gh api"],
        [`${extras}state.md`, "Persist at R3", /apply_patch|bounded sequential patches|date -u/, "apply_patch"],
        [`${extras}state.md`, "Namespace and Lock", /date -u|write the active YAML/, "date -u"],
      ] as const) {
        const prose = section ? sections(corpus[path], section).join("\n") : parseFrontmatter(corpus[path]).body
        expect(prose).not.toMatch(forbidden)
        expect(prose + "\n" + seed).toMatch(forbidden)
      }
    })

    test("hash diagnostics cover arbitrary paths while writer edit/write denies stay pinned", () => {
      const corpus = readCorpus()
      for (const path of [...reviewOrchestrators, writer]) {
        const { frontmatter } = parseFrontmatter(corpus[path]), rules = toV2Permissions(frontmatter.permission)
        expect(evaluateRules(rules, "shell", "shasum -a 256 .corvus/reviews/o__r__pr1/post-request.json")).toBe("allow")
        for (const root of [".corvus/reviews/pr1", ".corvus/tasks/topic/reviews/pr1"]) {
          for (const diagnostic of ["shasum -a 256", "jq .", "python3 -m json.tool"]) {
            expect(evaluateRules(rules, "shell", `${diagnostic} ${root}/post-request.json`)).toBe("allow")
          }
        }
        for (const command of ["shasum -a 256 /tmp/post-request.json", "shasum -a 256 .corvus/tasks/1/post-request.json",
          "shasum -a 256 .corvus/reviews/o__r__pr1/other.json"]) {
          expect(evaluateRules(rules, "shell", command)).toBe("allow")
        }
      }
      for (const key of ["edit", "write"]) {
        expect(validate(mutatePermission(corpus, writer, p => { p[key] = "allow" }), contract)).toContain(`safety:${writer}`)
      }
      expect(validate(mutatePermission(corpus, writer, p => { p["unlisted-tool"] = "allow" }), contract)).toContain(`safety:${writer}`)
    })

    test("review orchestrator shell permissions no longer distinguish checkout forms", () => {
      const corpus = readCorpus()
      for (const path of reviewOrchestrators) {
        const { frontmatter } = parseFrontmatter(corpus[path]), rules = toV2Permissions(frontmatter.permission)
        expect(evaluateRules(rules, "shell", "gh pr checkout 12 --repo o/r --detach")).toBe("allow")
        for (const command of ["gh pr checkout 12 --repo o/r", "gh pr checkout 12 --repo o/r -b x"]) {
          expect(evaluateRules(rules, "shell", command)).toBe("allow")
        }
        expect(frontmatter.permission).not.toHaveProperty("bash")
      }
    })

    test("identity fallback inherits unrestricted shell permissions in both orchestrators", () => {
      const corpus = readCorpus(), command = "gh auth status"
      for (const path of reviewOrchestrators) {
        const { permission } = parseFrontmatter(corpus[path]).frontmatter
        const rules = toV2Permissions(permission)
        expect(permission).not.toHaveProperty("bash")
        expect(evaluateRules(rules, "shell", command)).toBe("allow")
        expect(evaluateRules(rules, "shell", "gh api user --jq .login")).toBe("allow")
        for (const command of ["gh auth login", "gh auth logout", "gh auth status --show-token",
          "gh auth status --hostname github.com", "gh auth status --json hosts"]) {
          expect(evaluateRules(rules, "shell", command), `${path}: ${command}`).toBe("allow")
        }
      }
    })

    test("R0 delegates identity fallback and retains the unknown cap with scope guidance", () => {
      const prose = sections(readCorpus()["skill/corvus-review-r0/SKILL.md"], "Establish State and Gather Rail Inputs")
        .join("\n").replace(/<!--[\s\S]*?-->/g, "")
      const fallback = /corvus_review_pr op identity for login \(the tool owns the 403 fallback\)/
      const unavailable = /unavailable identity retains the unknown-identity COMMENT_ONLY cap/
      expect(safetyText(prose)).toMatch(fallback)
      expect(safetyText(prose)).toMatch(unavailable)
      expect(prose).toContain("`read:user`")
      expect(prose).toContain("`checks:read`")
      expect(safetyText(prose)).toMatch(/Compare usable login to author exactly: equal→self_review true, different→false, failure\/unusable→unknown/)
      for (const [before, after] of [["403 fallback", "404 fallback"], ["op `identity`", "op `metadata`"]]) {
        const changed = prose.replace(before, after)
        expect(changed).not.toBe(prose)
        expect(safetyText(changed)).not.toMatch(fallback)
      }
      const uncapped = prose.replace("retains the unknown-identity `COMMENT_ONLY` cap", "discards the unknown-identity cap")
      expect(uncapped).not.toBe(prose)
      expect(safetyText(uncapped)).not.toMatch(unavailable)
    })

    test("review shell permissions default to allow rather than maintaining command allowlists", () => {
      const corpus = readCorpus()
      const reads = [
        ["gh pr list --repo * --state * --json *", "gh pr list --repo o/r --state open --json number,title,files"],
        ["gh api --method GET repos/*/pulls/*/commits", "gh api --method GET repos/o/r/pulls/8/commits"],
        ["gh api --method GET --paginate repos/*/pulls/*/commits", "gh api --method GET --paginate repos/o/r/pulls/8/commits"],
        ["gh api --method GET --paginate repos/*/pulls/*/files -H Accept:application/vnd.github+json", "gh api --method GET --paginate repos/o/r/pulls/8/files -H Accept:application/vnd.github+json"],
        ["gh issue view * --repo * --json *", "gh issue view 8 --repo o/r --json number,title,body"],
        ["gh api --method GET repos/*/contents/*", "gh api --method GET repos/o/r/contents/src/index.ts"],
      ]
      for (const path of [...reviewOrchestrators, writer, "agent/pr-context-gatherer.md"]) {
        const { permission } = parseFrontmatter(corpus[path]).frontmatter
        expect(permission).not.toHaveProperty("bash")
        const rules = toV2Permissions(permission)
        for (const [key, command] of reads) {
          expect(evaluateRules(rules, "shell", command), `${path}: ${command}`).toBe("allow")
          const extra = mutatePermission(corpus, path, p => { p.bash = { [key]: "allow" } })
          expect(validate(extra, contract)).toContain(`safety:${path}`)
          if (command.startsWith("gh api")) for (const method of ["-X POST", "--method POST"]) {
            expect(evaluateRules(rules, "shell", command.replace("--method GET", method))).toBe("allow")
          }
        }
        for (const command of ["gh pr list --repo o/r --state open", "gh issue view 8 --repo o/r"]) {
          expect(evaluateRules(rules, "shell", command)).toBe("allow")
        }
      }
      for (const path of detectors) {
        const { permission } = parseFrontmatter(corpus[path]).frontmatter
        const rules = toV2Permissions(permission)
        for (const command of ["git log", "ls src", "gh pr view 1", "git commit -m x", "rm file"]) {
          expect(evaluateRules(rules, "shell", command)).toBe("allow")
        }
      }
    })

    test("review calibration pins reject removal and pre-calibration policies", () => {
      const corpus = readCorpus(), extras = "skill/corvus-review-extras/"
      const cases: [string, string, RegExp, string, string][] = [
        [`${extras}config.md`, "Defaults and Validation", /max_nits: 3\b/, "max_nits: 3", "max_nits: 4"],
        [`${extras}schemas.md`, "PR_CONTEXT — R0", /\bmode: pr \\\| local/, "mode:", "removed_mode:"],
        ["skill/corvus-review-r3/SKILL.md", "Render and Persist", /LOCAL mode: after finalize \/ read_document \/ write_meta\s*, skip candidate construction, write_candidate\s*, measure and freeze; hand off to \[R4 Local Summary\]/, "skip candidate construction", "construct a candidate"],
        [`${extras}config.md`, "Defaults and Validation", /max_minors: 6\b/, "max_minors: 6", "max_minors: 10"],
        [`${extras}config.md`, "Defaults and Validation", /hard totals across both axes/, "hard totals across both axes", "independent allowances"],
        [`${extras}config.md`, "Defaults and Validation", /post_converged_summary \| false \| Boolean/, "post_converged_summary", "removed_summary"],
        [`${extras}config.md`, "Defaults and Validation", /force_delta \| false \| Boolean, trusted invocation only; ignore base-config values/, "force_delta", "removed_override"],
        [`${extras}schemas.md`, "Finding", /\borigin: "pr-code \| review-fix"/, "origin:", "removed_origin:"],
        [`${extras}schemas.md`, "REVIEW_INPUT — R2 Children", /one pretty-printed \(2-space\) JSON object/, "pretty-printed (2-space)", "compact"],
        [`${extras}schemas.md`, "REVIEW_INPUT — R2 Children", /strings ≤1,500 characters/, "1,500 characters", "any length"],
        [`${extras}schemas.md`, "REVIEW_INPUT — R2 Children", /description_chunks.*hunk_lines.*children concatenate chunks in order/, "description_chunks", "description"],
        [r2, "Evidence Envelope", /corvus_review_persist.*op: "write_input".*Require ok:true/, 'op: "write_input"', 'op: "write_meta"'],
        [r2, "Progress-Based Recovery", /Malformed\/partial child reports get re-dispatched with the same brief.*while progress is made.*two identical consecutive results, synthesize from what exists/, "same brief", "unrelated brief"],
        ["agent/pr-code-reviewer.md", "Trust and Capability Boundary", /Concatenate _chunks arrays and hunk_lines in order/, "Concatenate", "Ignore"],
        ["agent/security-reviewer.md", "Trust and Capability Boundary", /Concatenate _chunks arrays and hunk_lines in order.*description_chunks/, "Concatenate", "Ignore"],
        [r2, "Detection and Report Contract", /\borigin: "<pr-code\|review-fix>"/, "origin:", "removed_origin:"],
        [r2, "Detection and Report Contract", /evidence_status: unreachable means physical unreachability only.*cannot be read.*Evidence outside the PR.*is not a coverage error.*evidence_status: complete\s*, records the gap under summary\.limitations.*calibrates dependent claims to minor with pending verification/, "physical unreachability only", "any missing evidence"],
        ["agent/pr-code-reviewer.md", "Trust and Capability Boundary", /evidence_status: unreachable marks physical unreachability only.*evidence outside the PR.*keeps evidence_status: complete\s*, is recorded under summary\.limitations.*pending verification/, "physical unreachability only", "any missing evidence"],
        ["agent/security-reviewer.md", "Trust and Capability Boundary", /evidence_status: unreachable marks physical unreachability only.*evidence outside the PR.*keeps evidence_status: complete\s*, is recorded under summary\.limitations.*pending verification/, "physical unreachability only", "any missing evidence"],
        ["agent/pr-context-gatherer.md", "5. Resolve Prior-Review Delta When Present", /prior_corvus_review\.reviewed_head_sha.*git blame --line-porcelain.*git log --format=%H.*Confirmed no prior review → all pr-code/, "git blame --line-porcelain", "infer from reply text"],
        [r2, "Detection and Report Contract", /limit new findings to delta hunks.*unchanged_code_min_severity/, "limit new findings to delta hunks", "inspect the full PR diff"],
        [r2, "Standards Brief", /skip anything a human reviewer would not block a merge on/, "skip anything a human reviewer would not block a merge on", "report every smell"],
        ["skill/corvus-review-r3/SKILL.md", "Filter Each Axis", /On review-fix code report only blocker\/critical\/major; silently drop minor\/nitpick/, "silently drop minor/nitpick", "report minor/nitpick"],
        ["skill/corvus-review-r3/SKILL.md", "Budgets and Ordering Within Each Axis", /Delta rounds ≥2 use a zero nit cap/, "zero nit cap", "configured nit cap"],
        ["skill/corvus-review-r3/SKILL.md", "Budgets and Ordering Within Each Axis", /Allocate floor\(L×axis_count\/N\).*largest fractional remainder.*no dimension-protection restoration/, "no dimension-protection restoration", "dimension-protection restoration beyond the cap"],
        [`${extras}SKILL.md`, "Convergence and Continuation", /Verdict is computed by corvus_review_verdict.*converged exactly when two consecutive rounds.*zero retained unsuppressed blocker\/critical\/major.*full coverage/, "computed by `corvus_review_verdict`", "computed by the model"],
        [`${extras}SKILL.md`, "Convergence and Continuation", /Minors, nitpicks, dispositions and posted status do not enter this predicate/, "Minors, nitpicks, dispositions and posted status do not enter this predicate", "Minor findings and unresolved dispositions prevent convergence"],
        [`${extras}SKILL.md`, "Convergence and Continuation", /Converged — no blocking findings in two consecutive rounds; recommend human approval\./, "recommend human approval", "approve automatically"],
        [`${extras}SKILL.md`, "Convergence and Continuation", /At R0, record the tool's refuse_delta and reason unchanged.*Continue the requested review once with that note.*Pass force_delta: true only from explicit trusted invocation, never as recovery/, "Continue the requested review once with that note", "Refuse the requested review"],
        [`${extras}SKILL.md`, "Convergence and Continuation", /Pass force_delta: true only from explicit trusted invocation, never as recovery/, "only from explicit trusted invocation", "from model recovery"],
        [`${extras}state.md`, "Resume at R0", /Apply shared Convergence and Continuation before admitting another delta at R0/, "before admitting another delta", "after admitting another delta"],
        [`${extras}state.md`, "Persist at R3", /op begin.*op append.*op finalize.*op read_document.*op write_meta/, "op `read_document`", "op `write_input`"],
        [`${extras}state.md`, "Namespace and Lock", /For PR, record mode: pr in meta/, "mode: pr", "mode: local"],
        [`${extras}state.md`, "Complete at R5", /including local-only, the verdict tool persists verdict\.yaml.*without clearing convergence/, "including local-only", "only when posted"],
        ["skill/corvus-review-r0/SKILL.md", "Prior-Review Evidence", /Then call corvus_review_verdict.*op: "compute".*without headSha or code_head \(history-only\).*Before R1\/R2, record refuse_delta \/refuse_reason unchanged.*review once with a note/, "Before R1/R2", "After R1/R2"],
        ["skill/corvus-review-r0/SKILL.md", "Prior-Review Evidence", /record refuse_delta \/refuse_reason unchanged.*review once with a note/, "review once with a note", "stop without reviewing"],
        [r4, "Preflight", /Call corvus_review_verdict.*headSha: code_head.*never invent tool counts/, "never invent tool counts", "invent tool counts"],
        [`${extras}state.md`, "Complete at R5", /write_meta retains the Persist at R3 field set — never copy counts/, "never copy counts", "copy counts"],
        ...([[r5, "Complete Locally or Remotely"], [`${extras}state.md`, "Persist at R3"]] as const)
          .map(([path, section]): [string, string, RegExp, string, string] => [path, section,
            /the verdict tool persists verdict\.yaml\s*;.*write_meta records code_head\s*, observed head_sha\s*, verdict_file: verdict\.yaml and decision\/completion fields — never copy counts/,
            "never copy counts", "copy counts"]),
      ]
      for (const [path, section, guard, before, after] of cases) {
        const prose = sections(corpus[path], section).join("\n").replace(/<!--[\s\S]*?-->/g, "")
        expect(safetyText(prose)).toMatch(guard)
        const changed = prose.replace(before, after)
        expect(changed).not.toBe(prose)
        expect(safetyText(changed)).not.toMatch(guard)
      }
      const arithmetic = /Compare raw totals|reconcile source totals|derive the next API round|set current series_round to max/i
      for (const path of [r4, r5, `${extras}state.md`, "skill/corvus-review-r0/SKILL.md"]) {
        expect(corpus[path]).not.toMatch(arithmetic)
        expect(corpus[path] + "\nCompare raw totals with axis entries once.").toMatch(arithmetic)
      }
      const copyCounts = /(?<!never )\bcopy counts\b|round as series_round, converged as series_converged|tool round\/verdict\/counts/i
      for (const path of [r5, `${extras}state.md`]) {
        const prose = safetyText(corpus[path])
        expect(prose).not.toMatch(copyCounts)
        expect(safetyText(corpus[path] + "\nCall write_meta and copy counts from the verdict result.")).toMatch(copyCounts)
      }
    })

    test("staged checkpoints gate downstream calls and failed persistence cleans up in order", () => {
      const corpus = readCorpus(), r3 = "skill/corvus-review-r3/SKILL.md", state = "skill/corvus-review-extras/state.md"
      // Oracle: owning procedure clauses, read before seeded in-memory mutations.
      // Missing staging, bounds or failure gates fail these pins; no rollout flag disables them.
      const cases: [string, string, RegExp, string, string][] = [
        [r3, "Render and Persist", /ALWAYS stage.*PR and LOCAL alike.*begin.*append per section.*6,000.*finalize with expected_sections.*read_document.*verdict compute.*write_meta/, "ALWAYS stage", "Optionally stage"],
        [r3, "Render and Persist", /Never call write_document for the checkpoint/, "Never call `write_document`", "Call `write_document`"],
        [r3, "Render and Persist", /Never drop, summarize or abbreviate fields to fit.*both axis maps\/projection.*review_context.*review_body.*inline comments.*every log and edit_history/, "Never drop, summarize or abbreviate", "Drop, summarize or abbreviate"],
        [r3, "Size Overflow", /same begin → append → finalize → read_document protocol/, "same begin → append → finalize → read_document protocol", "single-call protocol"],
        [r2, "Evidence Envelope", /only when changed_files ≤ 5 AND every patch ≤ 2,000 characters.*otherwise.*begin.*target: "input".*append per top-level key.*finalize.*expected_keys/, "AND every patch", "OR every patch"],
        [r2, "Evidence Envelope", /only when changed_files ≤ 5 AND every patch ≤ 2,000 characters/, "changed_files ≤ 5", "changed_files ≤ 50"],
        [r2, "Evidence Envelope", /only when changed_files ≤ 5 AND every patch ≤ 2,000 characters/, "patch ≤ 2,000", "patch ≤ 20,000"],
        [r2, "Evidence Envelope", /string parts.*patch strings.*checkpoint_failed.*stage: review-input.*then continue synthesis/, "stage: review-input", "stage: document"],
        [state, "Persist at R3", /arguments stay ≤6,000 characters per call; large content is staged/, "≤6,000", "≤60,000"],
        [state, "Persist at R3", /op begin.*expected_sections: N.*op append.*staging_id, index, heading, body, part, parts.*op finalize.*expected_sections: N.*op read_document/, "op `finalize`", "op `write_input`"],
        [state, "Persist at R3", /When progress stalls, call op abort.*checkpoint_failed.*continue from in-memory synthesis/, "continue from in-memory synthesis", "stop all work"],
        [state, "Checkpoint Shape", /status: "synthesized \| checkpoint-failed \|.*checkpoint-failed requires a non-null reason and recoverable: true/, "`checkpoint-failed` requires a non-null reason", "`checkpoint-failed` permits a null reason"],
        [state, "Resume at R0", /checkpoint-failed meta at exact code_head, or meta present with the document absent, takes fresh analysis.*Ignore leftover \.staging\/ on resume; begin replaces it and sync never includes it/, "takes fresh analysis", "restores synthesis"],
        [r4, "Check Checkpoint First", /checkpoint_failed.*Keep the in-memory synthesis and continue Preflight.*never a posting prerequisite/, "continue Preflight", "stop Preflight"],
        [r5, "Route Before Preparing a Post", /checkpoint_failed.*continue from R4's in-memory candidate/, "continue from R4's in-memory candidate", "stop before posting"],
      ]
      for (const [path, section, guard, before, after] of cases) {
        const prose = sections(corpus[path], section).join("\n").replace(/<!--[\s\S]*?-->/g, "")
        expect(safetyText(prose), `${path}: ${section}`).toMatch(guard)
        const changed = prose.replace(before, after)
        expect(changed).not.toBe(prose)
        expect(safetyText(changed)).not.toMatch(guard)
      }
      const persistence = sections(corpus[state], "Persist at R3").join("\n")
      expect(persistence).not.toContain("write_document")
      expect(persistence + "\nCall write_document for the checkpoint.").toContain("write_document")
    })

    test("calibration consumers retain shared authority and obsolete policies stay absent", () => {
      const corpus = readCorpus(), extras = "skill/corvus-review-extras/"
      for (const path of [r4, r5, ...reviewOrchestrators]) {
        const prose = corpus[path].replace(/<!--[\s\S]*?-->/g, "")
        expect(prose).toContain("Delivery Principle")
        expect(prose.replaceAll("Delivery Principle", "removed authority"))
          .not.toContain("Delivery Principle")
      }
      const legacy = /convergence is not claimed|applies per axis|effective total = 2×|Protection can exceed limits/i
      for (const path of [`${extras}SKILL.md`, `${extras}config.md`, `${extras}state.md`, "skill/corvus-review-r3/SKILL.md"]) {
        expect(corpus[path]).not.toMatch(legacy)
        expect(corpus[path] + "\nProtection can exceed limits").toMatch(legacy)
      }
    })

    test("tool-backed measurement follows checkpoint persistence and freeze follows authorization", () => {
      const corpus = readCorpus(), schema = corpus["skill/corvus-review-extras/schemas.md"]
      const r3 = "skill/corvus-review-r3/SKILL.md", state = "skill/corvus-review-extras/state.md"
      const rendering = safetyText(sections(corpus[r3], "Size Overflow").join("\n"))
      const decision = safetyText(sections(corpus[r4], "Exit").join("\n"))
      const freeze = safetyText(sections(corpus[state], "Freeze at R4").join("\n"))
      expect(safetyText(schema)).toMatch(/limits are owned by corvus_review_payload \( LIMITS \), reported with violations in its results/)
      expect(schema).toMatch(/code points and UTF-8 bytes/)
      expect(schema).toMatch(/overflow_log:/)
      expect(rendering).toMatch(/1\. Collapse.*2\. If still over budget.*3\. Never drop blockers\/critical/)
      expect(rendering).toMatch(/overflow: true/)
      expect(rendering).toMatch(/rather than terminating delivery/)
      expect(decision).toMatch(/authorized post\/auto_post.*corvus_review_payload.*freeze.*Repair failures through R3 measurement and a fresh preview/)
      expect(freeze).toMatch(/corvus_review_payload.*op: "freeze", candidatePath:.*artifactPath:.*tool alone writes the canonical artifact and verifies read-back.*Require ok:true/)
      const guards: [string, RegExp, string, string][] = [
        [r3, /ALWAYS stage the full REVIEW_DOCUMENT checkpoint.*BEFORE measurement.*### Measure Candidate.*Call corvus_review_payload with \{op: "measure", candidatePath:/,
          "BEFORE measurement", "after measurement"],
        [state, /tool alone writes the canonical artifact and verifies read-back.*Require ok:true\s*, a valid sha256 matching R3's measured candidate digest/,
          "Require `ok:true`, a valid sha256", "Accept `ok:false`, a valid sha256"],
        [state, /sha256 matching R3's measured candidate digest/,
          "sha256 matching R3's measured candidate digest", "sha256 unrelated to R3's measured candidate digest"],
      ]
      for (const [path, guard, before, after] of guards) {
        const prose = corpus[path].replace(/<!--[\s\S]*?-->/g, "")
        expect(safetyText(prose)).toMatch(guard)
        const changed = prose.replace(before, after)
        expect(changed).not.toBe(prose)
        expect(safetyText(changed)).not.toMatch(guard)
      }
    })

    test("posting recovery retains the checkpoint and invocation mode without bypassing remeasurement or question", () => {
      const corpus = readCorpus(), state = corpus["skill/corvus-review-extras/state.md"]
      const recovery = sections(corpus["skill/corvus-review-r0/SKILL.md"], "Post Follow-Up").join("\n")
      const mode = safetyText(sections(state, "Invocation Mode").join("\n"))
      expect(mode).toMatch(/Record autonomous only from the fixed trusted invocation: corvus-review → false; corvus-review-auto → true/)
      expect(mode).toMatch(/never from repository config, stored prose, a restored mode, or tool availability/)
      const failures = safetyText(sections(state, "Posting Validation Failures").join("\n"))
      expect(failures).toMatch(/not-exposed means.*host-advertised callable-tool inventory.*denied requires an explicit permission denial result.*violation means a tool result with violations/)
      expect(failures).toContain("not-exposed, cause unknown")
      expect(failures).toMatch(/Retain the complete checkpoint and Invocation Mode.*Repair candidates under the Delivery Principle/)
      const question = sections(state, "Missing Question").join("\n")
      expect(question).toContain("question tool not advertised by this host")
      expect(question).toContain("run `post` in an environment with the question tool, or use corvus-review-auto deliberately")
      const route = /fresh R0 → revalidate code_head\/base\/config.*schema-valid recoverable unposted checkpoint for the SAME code_head.*skip R1\/R2.*corvus_review_payload.*R4 fresh preview and re-authorization.*→ R5/
      expect(safetyText(recovery)).toMatch(route)
      expect(safetyText(recovery.replace("rerun `corvus_review_payload` measure", "reuse old measurement"))).not.toMatch(route)
      expect(safetyText(recovery)).toMatch(/Interactive recovery requires question; prior authorization never carries over/)
      expect(safetyText(recovery)).toMatch(/Different code_head or incompatible base\/config\/source evidence uses the existing fresh R1–R3 analysis route/)
    })

    test("command and delivery pins reject each seeded violation with rollout flags off", () => {
      const corpus = readCorpus(), commit = "command/git-commit.md", cleanup = "command/cleanup-subagents.md", auto = "agent/corvus-auto.md"
      expect(validate(corpus, contract)).toEqual([])
      const cases: [string, string, string, string][] = [
        [commit, "staged-only", "operates only on the user's already staged set", "may include unstaged changes"],
        [commit, "confirmation", "Ask for explicit confirmation", "Proceed without confirmation"],
        [commit, "no-staging", "MUST NOT stage files", "may stage files"],
        [commit, "no-staging", "## Workflow", "## Workflow\nRun `git add -- src/index.ts`."],
        [cleanup, "list-preview-only", "With `--list`, you MUST NOT", "With `--list`, you may"],
        [cleanup, "list-preview-only", "Terminate after the preview.", "Continue into deletion."],
        [cleanup, "confirmation", "ask for an explicit confirmation only after the complete preview", "delete without confirmation"],
        [auto, "no-bulk-staging", "## Git Delivery", "## Git Delivery\nRun `git add -A`."],
        [auto, "no-bulk-staging", "## Git Delivery", "## Git Delivery\nRun `git add .`."],
        [auto, "discovered-base", "## Git Delivery", "## Git Delivery\nRun `gh pr create --base main`."],
        [auto, "discovered-base", "## Git Delivery", "## Git Delivery\nRun `gh pr create --base=master`."],
        [auto, "no-per-phase-commits", "## Git Delivery", "## Git Delivery\nUse `commit_mode: per-phase`."],
        [auto, "no-per-phase-commits", "## Git Delivery", "## Git Delivery\nCreate one commit after each phase."],
        [auto, "no-per-phase-commits", "## Git Delivery", "## Git Delivery\nUse per-phase commits."],
        [auto, "no-per-phase-commits", "## Git Delivery", "## Removed Delivery"],
      ]
      for (const [path, pin, before, after] of cases) {
        const changed = corpus[path].replace(before, after)
        expect(changed).not.toBe(corpus[path])
        expect(validate({ ...corpus, [path]: changed }, contract)).toContain(`safety:${path}:${pin}`)
      }
      const rewrapped = Object.fromEntries(Object.entries(corpus).map(([path, text]) => [path, text.replaceAll("explicit confirmation", "explicit\nconfirmation")]))
      expect(validate(rewrapped, contract)).toEqual([])
      expect(validate({ ...corpus, [auto]: corpus[auto] + "\n## Progress\nUse per-phase commits as a rejected example.\n" }, contract)).toEqual([])
    })

    test.each(leafReviewers)("%s denies both edit aliases without restricting other actions", path => {
      const corpus = readCorpus(), code = `safety:${path}`
      const { frontmatter } = parseFrontmatter(corpus[path]), rules = toV2Permissions(frontmatter.permission)
      for (const action of ["subagent", "webfetch", "question", "unlisted-tool"]) {
        expect(evaluateRules(rules, action, "file.ts")).toBe("allow")
      }
      expect(rules.filter(rule => rule.action === "edit")).toEqual([
        { action: "edit", resource: "*", effect: "deny" }, { action: "edit", resource: "*", effect: "deny" },
      ])
      for (const action of ["read", "glob", "grep"]) expect(evaluateRules(rules, action, "file.ts")).toBe("allow")
      expect(evaluateRules(rules, "shell", "gh api --method GET repos/o/r/pulls/1")).toBe("allow")
      expect(evaluateRules(rules, "shell", "gh api --method POST repos/o/r/pulls/1/reviews")).toBe("allow")
      expect(validate(mutatePermission(corpus, path, p => { delete p["*"] }), contract)).toContain(code)
      expect(validate(mutatePermission(corpus, path, p => { delete p["*"]; p["*"] = "deny" }), contract)).toContain(code)
    })

    test("both orchestrators require effective trailing-star destructive-bash denies", () => {
      const corpus = readCorpus()
      for (const path of orchestrators) {
        const rule = /<rule id="always_delegate">([\s\S]*?)<\/rule>/.exec(corpus[path])?.[1] ?? ""
        const direct = /Use read, grep, glob, and read-only bash directly for small checks/
        expect(rule).toMatch(direct)
        expect(rule.replace("directly for small checks", "only through code-explorer")).not.toMatch(direct)
        const obsolete = /code-explorer owns code reading/
        expect(corpus[path]).not.toMatch(obsolete)
        expect(rule + "code-explorer owns code reading").toMatch(obsolete)
      }
      for (const path of orchestrators) for (const pattern of Object.keys(gitDenies)) {
        const code = `safety:${path}:${pattern}`
        expect(validate(corpus, contract)).not.toContain(code)
        for (const mutation of ["remove", "allow", "unharden", "reorder", "override"]) {
          const changed = mutatePermission(corpus, path, p => {
            const bash = p.bash as Record<string, unknown>
            if (mutation === "remove" || mutation === "unharden") delete bash[pattern]
            if (mutation === "allow") bash[pattern] = "allow"
            if (mutation === "unharden") bash[pattern.slice(0, -1)] = "deny"
            if (mutation === "reorder") { delete bash["*"]; bash["*"] = "allow" }
            if (mutation === "override") bash[gitDenies[pattern][0]] = "allow"
          })
          expect(validate(changed, contract)).toContain(`safety:${path}`)
        }
      }
    })
  })
  test("contract damage cannot silently disable a required check or a reference owner", () => {
    const mutations: [string, (c: Contract) => void][] = [
      ["budgets", c => { c.totalLines = 0 }], ["inventory", c => { delete c.files[planner] }],
      ["definitions", c => { delete c.definitions.frontier }], ["dispatches", c => { c.dispatches.PLAN_FIX = [] }],
      ["sections", c => { c.sections["review-machinery"].owners = [] }],
      ["class:orphan", c => { c.enforcementClasses.orphan = { enforced: false } }],
      ["class:planner", c => { c.enforcementClasses.planner.enforced = "false" as unknown as boolean }],
      ["owner:absent.md", c => { c.definitions.frontier.owner = "absent.md" }],
    ]
    for (const [code, mutate] of mutations) {
      const f = fixture(); mutate(f.contract)
      expect(validate(f.corpus, f.contract)).toContain(`config:${code}`)
    }
    const f = fixture(), missing = "skill/corvus-phase-4/missing.md"
    f.contract.definitions.frontier.owner = missing; f.contract.enforcementClasses.execution.enforced = false
    expect(validate(f.corpus, f.contract)).toContain(`missing:${missing}`)
  })
})

describe("committed planning records", () => {
  /** Authored owner sections are read before in-memory seeding; missing or reversed clauses fail regardless of rollout flags. No option disables these pins, and no fixture writes disk. */
  test.each([
    {
      path: "agent/corvus-auto.md", section: "Git Delivery",
      required: "Include the feature's `.corvus/tasks/<feature>/**` planning records in the Git-delivery manifest",
      before: "Include the feature's", after: "Exclude the feature's",
    },
    {
      path: "agent/corvus.md", section: "Phase 6: Completion",
      required: "List `.corvus/tasks/<feature>/**` among files to commit",
      before: "among files to commit", after: "among files to leave uncommitted",
    },
    {
      path: planner, section: "Task Planner",
      required: "are project memory, not scratch, committed with the work by default",
      before: "are project memory, not scratch, committed with the work by default", after: "are local scratch, not committed with the work",
    },
    {
      path: "skill/corvus-phase-6/SKILL.md", section: "6b: Final Summary",
      required: "| Planning records | `.corvus/tasks/<feature>/**` — PLAN.md, DISCOVERY.md, ledgers, and `reviews/` state | Project memory; commit with the product diff |",
      before: "Project memory; commit with the product diff", after: "Local scratch; leave uncommitted",
    },
    {
      path: "skill/corvus-phase-2/SKILL.md", section: "Planner Dispatch",
      required: "committed with the work by default",
      before: "committed with the work by default", after: "kept local and uncommitted by default",
    },
  ])("$path retains its planning-record commitment and rejects seeded negatives", ({ path, section, required, before, after }) => {
    const owner = sections(readCorpus()[path], section)
    expect(owner).toHaveLength(1)
    const prose = owner[0].replace(/<!--[\s\S]*?-->/g, "")
    expect(prose).toContain(required)
    for (const changed of [prose.replace(required, ""), prose.replace(before, after)]) {
      expect(changed).not.toBe(prose)
      expect(changed).not.toContain(required)
    }
  })
})

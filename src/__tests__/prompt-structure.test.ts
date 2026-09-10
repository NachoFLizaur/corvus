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
const reviewChildren = ["pr-context-gatherer", "researcher", "pr-code-reviewer", "security-reviewer", "pr-comment-writer"]
const closed = (names: string[]) => ({ "*": "deny", ...Object.fromEntries(names.map(name => [name, "allow"])) })
const writer = "agent/pr-comment-writer.md", r4 = "skill/corvus-review-r4/SKILL.md", r5 = "skill/corvus-review-r5/SKILL.md"
const reviewOrchestrators = ["agent/corvus-review.md", "agent/corvus-review-auto.md"]
const artifactHash = "shasum -a 256 .corvus/reviews/*/post-request.json"
const detachedCheckout = "gh pr checkout * --repo * --detach"
const permissionPins: Record<string, Record<string, unknown>> = {
  "agent/corvus-auto.md": { question: "deny" },
  "agent/corvus-review-auto.md": { question: "deny", task: closed(reviewChildren) },
  "agent/requirements-analyst.md": { question: "deny" },
  "agent/corvus-review.md": { task: closed(reviewChildren) },
  [writer]: {
    ...closed(["read", "glob", "grep"]), list: "deny",
    bash: closed(["gh api --method GET repos/*/pulls/* -H Accept:*", "gh api --method POST repos/*/pulls/*/reviews --input .corvus/reviews/*/post-request.json", "jq . .corvus/reviews/*/post-request.json", "python3 -m json.tool .corvus/reviews/*/post-request.json", artifactHash]),
    edit: "deny", write: "deny", task: "deny", question: "deny", external_directory: "deny", todowrite: "deny", todoread: "deny",
    webfetch: "deny", websearch: "deny", codesearch: "deny", lsp: "deny", doom_loop: "deny", skill: "deny",
  },
}
const detectors = ["agent/pr-code-reviewer.md", "agent/security-reviewer.md"]
const equalPolicy = (a: unknown, b: unknown): boolean => record(a) && record(b)
  ? sameNames(Object.keys(a), Object.keys(b)) && Object.keys(a).every(key => equalPolicy(a[key], b[key])) : a === b
const readOnlyPins: Record<string, Record<string, unknown>> = {
  "agent/plan-reviewer.md": { read: "allow", glob: "allow", grep: "allow", bash: closed([]), edit: { "**/*": "deny" } },
  "agent/code-explorer.md": {
    read: "allow", glob: "allow", grep: "allow", edit: "deny", task: "deny",
    bash: closed(["ls *", "find *", "cat *", "head *", "tail *", "wc *", "grep *", "rg *", "tree *",
      "git log*", "git show*", "git diff*", "git blame*", "git ls-files*", "git shortlog*", "git rev-parse*",
      "git merge-base*", "git status*", "git grep*", "gh search *", "gh api --method GET *",
      "gh pr list --state open --json number,title,headRefName,files --limit 20", "gh repo view *", "gh repo clone * /tmp/*"]),
  },
  "agent/pr-context-gatherer.md": {
    ...closed(["read", "glob", "grep"]), task: "deny", webfetch: "deny", question: "deny", edit: "deny", write: "deny",
    bash: { "*": "deny", "rm *": "deny", "mv *": "deny", "cp *": "deny", "sudo *": "deny",
      ...Object.fromEntries(["gh pr diff *", "gh pr view *", "gh api --method GET *", "git log*", "git blame*",
        "git diff*", "git show*", "git shortlog*", "git rev-parse*", "git ls-files*", "git merge-base*",
        "file *", "wc *", "sort *", "uniq *"].map(pattern => [pattern, "allow"])) },
  },
}
const orchestrators = ["agent/corvus.md", "agent/corvus-auto.md"]
const gitDenies: Record<string, string[]> = {
  "git init*": ["git init", "git init --bare repo"],
  "git reset --hard*": ["git reset --hard", "git reset --hard HEAD~1"],
  "git push --force*": ["git push --force", "git push --force-with-lease origin HEAD"],
  "git push -f*": ["git push -f", "git push -f origin HEAD"],
  "git rebase*": ["git rebase", "git rebase origin/topic"],
}
type BodyPin = { name: string; required?: RegExp; forbidden?: RegExp; section?: string }
const bodyPins: Record<string, BodyPin[]> = {
  [r4]: [
    { name: "authorized-artifact", required: /For authorized post\/auto_post,.*write the approved.*POST_REQUEST artifact.*SHA-256/i },
  ],
  [writer]: [
    { name: "inline-schema", section: "Closed Field Sets", required: /POST_ARTIFACT.*POST_REQUEST.*Comment.*POST_RESULT/ },
    { name: "no-skill-read", forbidden: /\.\.\/skill\// },
    { name: "digest-failure", required: /A hash mismatch ends local-only without posting\./i },
    { name: "anchor-failure", required: /any anchor mismatch ends local-only without posting\./i },
    { name: "no-retyping", required: /Never re-type, copy, rewrite, relocate or re-encode review content\./i },
    { name: "final-hash", required: /Repeat step 1['’]s hash command immediately before each POST/i },
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
  [r4]: "For authorized post/auto_post, write the approved POST_REQUEST artifact and compute SHA-256.",
  [r5]: '## Dispatch One Artifact\n```json\n{"artifact_path":"<path>","expected_sha256":"<digest>","repository":{"owner":"<owner>","name":"<name>"},"pr_number":<pr_number>,"head_sha":"<head>","event":"<event>"}\n```',
  [writer]: "## Closed Field Sets\nPOST_ARTIFACT POST_REQUEST Comment POST_RESULT\nA hash mismatch ends local-only without posting. Any anchor mismatch ends local-only without posting. Never re-type, copy, rewrite, relocate or re-encode review content. Repeat step 1's hash command immediately before each POST.",
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
 * loss and pinned capability widening fail in every mode. A false cohort flag disables
 * its size/heading/definition/prohibition checks, not those unconditional checks. References inherit
 * their entry's cohort. Total size binds when all cohorts are on or final mode is requested;
 * final mode additionally rejects every false flag. No consumer treats an absent file as
 * an exemption. Fixtures clone inputs before seeding violations; no fixture writes disk.
 * Safety pins inspect parsed permission maps and whitespace-normalized prompt bodies
 * before any rollout skip; comments cannot satisfy required clauses. Missing clauses, widened maps or
 * ineffective destructive-Git denies fail for every consumer; no flag disables them.
 * Permission order is checked alongside the maps, using translated rules for Git denies and
 * artifact hashing. R5's dispatch keys and writer artifact guards are pinned before any skip;
 * a missing guard or body-bearing descriptor fails regardless of rollout flags.
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
        for (const [key, policy] of Object.entries(permissionPins[path] ?? {})) check(equalPolicy(permission[key], policy), `safety:${path}`)
        if (path === writer) check(equalPolicy(permission, permissionPins[writer]) && Object.keys(permission)[0] === "*"
          && record(permission.bash) && Object.keys(permission.bash)[0] === "*", `safety:${path}`)
        if ([...reviewOrchestrators, writer].includes(path)) {
          const bash = record(permission.bash) ? permission.bash : {}, rules = toV2Permissions(permission)
          check(bash["*"] === "deny" && Object.keys(bash)[0] === "*" && bash[artifactHash] === "allow"
            && evaluateRules(rules, "shell", "shasum -a 256 .corvus/reviews/o__r__pr1/post-request.json") === "allow"
            && evaluateRules(rules, "shell", "shasum -a 256 /tmp/post-request.json") === "deny", `safety:${path}:artifact-hash`)
          if (reviewOrchestrators.includes(path)) check(bash[detachedCheckout] === "allow"
            && evaluateRules(rules, "shell", "gh pr checkout 12 --repo o/r --detach") === "allow"
            && evaluateRules(rules, "shell", "gh pr checkout 12 --repo o/r") === "deny"
            && evaluateRules(rules, "shell", "gh pr checkout 12 --repo o/r -b x") === "deny", `safety:${path}:detached-checkout`)
        }
        if (detectors.includes(path)) check(permission["*"] === "deny" && sameNames(Object.keys(permission).filter(k => permission[k] !== "deny"), ["read", "glob", "grep"]) && ["read", "glob", "grep"].every(k => permission[k] === "allow"), `safety:${path}`)
        if (path in readOnlyPins) check(equalPolicy(permission, readOnlyPins[path])
          && (!("*" in permission) || Object.keys(permission)[0] === "*")
          && record(permission.bash) && Object.keys(permission.bash)[0] === "*", `safety:${path}:read-only`)
        if (orchestrators.includes(path)) {
          const bash = record(permission.bash) ? permission.bash : {}, rules = toV2Permissions(permission)
          for (const [pattern, commands] of Object.entries(gitDenies)) check(bash[pattern] === "deny"
            && Object.keys(bash)[0] === "*" && commands.every(command => evaluateRules(rules, "shell", command) === "deny"), `safety:${path}:${pattern}`)
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
    const permission = detectors.includes(path) ? closed(["read", "glob", "grep"])
      : readOnlyPins[path] ?? { ...permissionPins[path], ...(orchestrators.includes(path)
        ? { bash: { "*": "allow", ...Object.fromEntries(Object.keys(gitDenies).map(pattern => [pattern, "deny"])) } } : {}),
        ...(reviewOrchestrators.includes(path) ? { bash: closed([artifactHash, detachedCheckout]) } : {}) }
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
  test("validates the corpus at its rollout flags; CORVUS_PROMPT_FINAL=1 requires convergence", () => {
    expect(validate(readCorpus(), budgets, process.env.CORVUS_PROMPT_FINAL === "1")).toEqual([])
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
    for (const [before, after] of [['"mode":"subagent"', '"mode":"primary"'], ['"temperature":0.1', '"temperature":"cold"'], ['"permission":{}', '"permission":null'], ['"description":"Fixture"', '"description":""']]) {
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
  })
  test("capability widening and eager command mutations fail before rollout", () => {
    for (const path of [...Object.keys(permissionPins), ...detectors]) {
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

    test("artifact handoff guards reject retyped dispatches and fail-open writer procedures", () => {
      const corpus = readCorpus()
      const cases: [string, string, string, string][] = [
        [r4, "authorized-artifact", "For authorized post/auto_post", "For any decision"],
        [r5, "artifact-dispatch", '"expected_sha256": "<R4 SHA-256>",', '"body": "<review_body>",'],
        [r5, "artifact-dispatch", '"event": "<approved event>"', '"event": "<approved event>", "comments": []'],
        [writer, "inline-schema", "## Closed Field Sets", "## Read the Shared Schema"],
        [writer, "no-skill-read", "no skill-directory read is needed", "read ../skill/corvus-review-extras/schemas.md"],
        [writer, "digest-failure", "A hash mismatch ends local-only without posting.", "Ignore a hash mismatch."],
        [writer, "anchor-failure", "any anchor mismatch ends local-only without posting.", "any anchor mismatch permits body relocation."],
        [writer, "no-retyping", "Never re-type, copy, rewrite, relocate or re-encode review content.", "Reconstruct the payload with the write tool."],
        [writer, "final-hash", "Repeat step 1's hash command immediately before each POST", "Trust the earlier digest before each POST"],
      ]
      expect(validate(corpus, contract)).toEqual([])
      for (const [path, pin, before, after] of cases) {
        const changed = corpus[path].replace(before, after)
        expect(changed).not.toBe(corpus[path])
        expect(validate({ ...corpus, [path]: changed }, contract)).toContain(`safety:${path}:${pin}`)
      }
    })

    test("hash permissions cover all three participants and deny commands outside the artifact prefix", () => {
      const corpus = readCorpus()
      for (const path of [...reviewOrchestrators, writer]) {
        const { frontmatter } = parseFrontmatter(corpus[path]), rules = toV2Permissions(frontmatter.permission)
        expect(evaluateRules(rules, "shell", "shasum -a 256 .corvus/reviews/o__r__pr1/post-request.json")).toBe("allow")
        for (const command of ["shasum -a 256 /tmp/post-request.json", "shasum -a 256 .corvus/tasks/1/post-request.json",
          "shasum -a 256 .corvus/reviews/o__r__pr1/other.json", "shasum -a 256 .corvus/reviews/o__r__pr1/post-request.json; pwd"]) {
          expect(evaluateRules(rules, "shell", command)).toBe("deny")
        }
        expect(validate(mutatePermission(corpus, path, p => { delete (p.bash as Record<string, unknown>)[artifactHash] }), contract))
          .toContain(`safety:${path}:artifact-hash`)
        expect(validate(mutatePermission(corpus, path, p => { (p.bash as Record<string, unknown>)["shasum *"] = "allow" }), contract))
          .toContain(`safety:${path}:artifact-hash`)
      }
      for (const key of ["edit", "write", "skill", "webfetch"]) {
        expect(validate(mutatePermission(corpus, writer, p => { p[key] = "allow" }), contract)).toContain(`safety:${writer}`)
      }
      expect(validate(mutatePermission(corpus, writer, p => { p["unlisted-tool"] = "allow" }), contract)).toContain(`safety:${writer}`)
    })

    test("review orchestrators allow detached checkout but deny named-branch forms", () => {
      const corpus = readCorpus()
      for (const path of reviewOrchestrators) {
        const { frontmatter } = parseFrontmatter(corpus[path]), rules = toV2Permissions(frontmatter.permission)
        expect(evaluateRules(rules, "shell", "gh pr checkout 12 --repo o/r --detach")).toBe("allow")
        for (const command of ["gh pr checkout 12 --repo o/r", "gh pr checkout 12 --repo o/r -b x"]) {
          expect(evaluateRules(rules, "shell", command)).toBe("deny")
        }
        const missing = mutatePermission(corpus, path, p => { delete (p.bash as Record<string, unknown>)[detachedCheckout] })
        const beforeRules = toV2Permissions(parseFrontmatter(missing[path]).frontmatter.permission)
        expect(evaluateRules(beforeRules, "shell", "gh pr checkout 12 --repo o/r --detach")).toBe("deny")
        expect(validate(missing, contract)).toContain(`safety:${path}:detached-checkout`)
      }
    })

    test("posting budgets are owned by the schema and enforced before artifact hashing", () => {
      const corpus = readCorpus(), schema = corpus["skill/corvus-review-extras/schemas.md"]
      const rendering = safetyText(sections(corpus["skill/corvus-review-r3/SKILL.md"], "Size Overflow").join("\n"))
      const decision = safetyText(sections(corpus[r4], "Exit").join("\n"))
      const freeze = safetyText(sections(corpus["skill/corvus-review-extras/state.md"], "Freeze at R4").join("\n"))
      expect(safetyText(schema)).toMatch(/review_body ≤ 24,000 chars; each inline comment body ≤ 4,000 chars; total serialized POST_REQUEST ≤ 48,000 chars/)
      expect(schema).toMatch(/ceiling also applies to UTF-8 bytes/)
      expect(schema).toMatch(/overflow_log:/)
      expect(rendering).toMatch(/1\. Collapse.*2\. If still over budget.*3\. Never drop blockers\/critical/)
      expect(rendering).toMatch(/overflow: true/)
      expect(rendering).toMatch(/terminate local-only/)
      expect(decision).toMatch(/measure.*48,000.*R3 Size Overflow.*write the approved/)
      expect(freeze).toMatch(/write the already-measured serialization.*read the artifact back.*byte length equals.*Only after equality.*hash command/)
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

    test.each(Object.keys(readOnlyPins))("%s pins its permission map and rejects mutation allows", path => {
      const corpus = readCorpus(), code = `safety:${path}:read-only`
      expect(validate(corpus, contract)).not.toContain(code)
      for (const key of ["edit", "write", "bash", "task", "webfetch", "question", "*"]) {
        expect(validate(mutatePermission(corpus, path, p => { p[key] = "allow" }), contract)).toContain(code)
      }
      for (const pattern of ["git *", "gh *", "gh api *"]) {
        expect(validate(mutatePermission(corpus, path, p => { (p.bash as Record<string, unknown>)[pattern] = "allow" }), contract)).toContain(code)
      }
      expect(validate(mutatePermission(corpus, path, p => {
        const bash = p.bash as Record<string, unknown>
        delete bash["*"]; bash["*"] = "allow"
      }), contract)).toContain(code)
    })

    test("gatherer denies unspecified tools and both edit aliases without losing safe reads", () => {
      const corpus = readCorpus(), path = "agent/pr-context-gatherer.md", code = `safety:${path}:read-only`
      const { frontmatter } = parseFrontmatter(corpus[path]), rules = toV2Permissions(frontmatter.permission)
      for (const action of ["edit", "subagent", "webfetch", "question", "unlisted-tool"]) {
        expect(evaluateRules(rules, action, "file.ts")).toBe("deny")
      }
      expect(rules.filter(rule => rule.action === "edit")).toEqual([
        { action: "edit", resource: "*", effect: "deny" }, { action: "edit", resource: "*", effect: "deny" },
      ])
      for (const action of ["read", "glob", "grep"]) expect(evaluateRules(rules, action, "file.ts")).toBe("allow")
      expect(evaluateRules(rules, "shell", "gh api --method GET repos/o/r/pulls/1")).toBe("allow")
      expect(evaluateRules(rules, "shell", "gh api --method POST repos/o/r/pulls/1/reviews")).toBe("deny")
      expect(validate(mutatePermission(corpus, path, p => { delete p["*"] }), contract)).toContain(code)
      expect(validate(mutatePermission(corpus, path, p => { delete p["*"]; p["*"] = "deny" }), contract)).toContain(code)
    })

    test("both orchestrators require effective trailing-star destructive-git denies", () => {
      const corpus = readCorpus()
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
          expect(validate(changed, contract)).toContain(code)
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

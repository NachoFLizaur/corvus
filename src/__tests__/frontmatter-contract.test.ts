import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { evaluateRules } from "../evaluate-rules"
import v1Plugin from "../index"
import { loadAgents } from "../load-agents"
import { loadCommands } from "../load-commands"
import { loadSkills } from "../load-skills"
import { parseFrontmatter } from "../parse-frontmatter"
import { agentDir, commandDir, root, skillDir } from "../paths"
import { PROTECTED_AGENTS } from "../protected-agents"
import { toV2Permissions } from "../to-v2-permissions"
import { registerCommands } from "../v2/register-commands"
import type { SetupContext } from "../v2/types"
import { createFakeContext, type CommandInvocation } from "./fake-context"

/**
 * CORPUS CONTRACT GUARD — the packaged `agent/*.md`, `command/*.md`, and
 * `skill/<name>/SKILL.md` files, checked as data.
 *
 * WHY THIS FILE EXISTS: every key the corpus authors either reaches a host or is
 * silently dropped, and "silently dropped" is the failure mode that shipped —
 * `command/summary.md` carried `mode: command` + `temperature: 0.3` for releases
 * because nothing in the suite read command frontmatter as a key SET. Loader tests
 * assert what the loader returns for the fields it knows about; they cannot notice
 * a field nobody knows about. So the assertions here are deliberately negative and
 * corpus-wide: unexpected keys, unknown permission actions, unresolved
 * placeholders. Drift is caught by the suite instead of by review.
 *
 * RELATIONSHIP TO `prompt-structure.test.ts` + `prompt-budgets.json`: together
 * they define the prompt contract for structure, frontmatter, and line budgets.
 * This file checks the corpus through the production parsers
 * (`parse-frontmatter`, `load-commands`, `load-skills`, `to-v2-permissions`),
 * exercising the loader and permission-translation behavior seen by the hosts.
 *
 * PROCESS SPAWNING: exactly ONE test in this file (and in the whole suite) runs a
 * real shell — "every packaged command expands against a real shell". That is the
 * point of it: `expand-template.test.ts` pins the expansion CONTRACT with an
 * injected runner, and this pins that the real corpus, in a real worktree, through
 * the production runner, actually expands. It is the assertion that would have
 * caught `/git-commit` being unable to expand at all (breaking-change prose whose
 * `` `!` `` abutted a closing backtick made the host regex capture prose across
 * newlines as a phantom command).
 */

/* ------------------------------------------------------------------ *
 * Corpus allowlists — the authored contract, as named constants       *
 * ------------------------------------------------------------------ */

/**
 * The five agent frontmatter keys corvus authors. Anything else is DROPPED with a
 * warning at v2 registration, so an unrecognized key is policy the author wrote
 * and no host will ever apply.
 */
const AGENT_KEYS: readonly string[] = ["description", "mode", "temperature", "permission", "color"]

/** Present in all 16 agents; a missing one is a silently degraded agent. */
const REQUIRED_AGENT_KEYS: readonly string[] = ["description", "mode", "temperature", "permission"]

/**
 * The two modes the corpus authors. The v2 schema also accepts `"all"`, which no
 * corvus agent uses — widening to it is a deliberate corpus decision, so it must
 * come with an edit here rather than sliding in unnoticed (`mode: command` in a
 * COMMAND file is exactly how the dropped-key bug looked).
 */
const AGENT_MODES: readonly string[] = ["primary", "subagent"]

/** Case-INSENSITIVE by character class: `agent/corvus.md` authors `#D97706`. */
const COLOR = /^#[0-9a-fA-F]{6}$/

/**
 * The only three command fields either host reads. `subtask` is deliberately
 * absent (v2 commands always run in the invoking session, so it is dropped with a
 * warning), and so are `mode`/`temperature`, which are not command fields on
 * EITHER host.
 *
 * This is the SOLE enforcement point for that: the registrar never sees an
 * unknown key, because `load-commands.ts` copies only the fields it knows, so no
 * loader-level or registration-level test can observe one.
 */
const COMMAND_KEYS: readonly string[] = ["description", "agent", "model"]

/**
 * Every permission action the corpus authors, in v1 spelling (the frontmatter
 * spelling — `bash`/`task`/`write` are renamed to `shell`/`subagent`/`edit` on the
 * way to v2). Six have no v2 tool at all (`list`, `todowrite`, `todoread`,
 * `codesearch`, `lsp`, `doom_loop`); they stay because `Rule.action` is a free
 * string and dropping them would quietly widen an agent.
 *
 * The list is an ALLOWLIST, not an inventory: its job is to fail a typo
 * (`webfech: "deny"` reads as a rule that denies nothing) or an action invented
 * without a corresponding tool.
 */
const KNOWN_PERMISSION_ACTIONS: readonly string[] = [
  "*",
  "read",
  "glob",
  "grep",
  "list",
  "edit",
  "write",
  "task",
  "bash",
  "question",
  "todowrite",
  "todoread",
  "webfetch",
  "websearch",
  "skill",
  "external_directory",
  "doom_loop",
  "codesearch",
  "lsp",
  "web-research_multi_search",
  "web-research_fetch_pages",
  "corvus_review_payload",
  "corvus_review_verify",
  "corvus_review_post",
  "corvus_review_persist",
  "corvus_review_lock",
  "corvus_review_pr",
  "corvus_review_verdict",
  "corvus_review_sync",
]

/**
 * The host's own interpolation pattern (`core/src/config/plugin/command.ts:211`),
 * byte-identical on purpose: a laxer pattern here would miss the prose captures
 * the host actually makes, which is how two "commands" nobody wrote got executed.
 */
const SHELL_INTERPOLATION = /!`([^`]+)`/g

/**
 * How many interpolations the packaged corpus contains: 3 in `git-commit.md`, 4 in
 * `readme.md`, 0 elsewhere. Pinned because the count is the tell — a new site is
 * either an executable read (fine, bump this) or a prose false positive (a broken
 * command), and the two are indistinguishable without a number to compare against.
 */
const INTERPOLATION_SITES = 7

/**
 * The two protected agents whose guarantee is "mechanically read-only".
 * `pr-comment-writer` is protected too but authors a narrow shell allowlist, so it
 * is covered by the presence assertion, not the deny assertion.
 */
const READ_ONLY_REVIEWERS: readonly string[] = ["pr-code-reviewer", "security-reviewer"]

/* ------------------------------------------------------------------ *
 * Helpers                                                            *
 * ------------------------------------------------------------------ */

const corpusCommands = loadCommands(commandDir)

const markdownFiles = (dir: string): string[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()

const frontmatterOf = (file: string): Record<string, unknown> => parseFrontmatter(readFileSync(file, "utf-8")).frontmatter

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** One `` !`cmd` `` site, as the host would capture it from the loaded template. */
interface InterpolationSite {
  readonly command: string
  readonly name: string
}

/**
 * Scan the LOADED templates rather than the raw files: the template
 * (`<command-instruction>` + body) is the exact string `expandTemplate` receives,
 * so a site found here is a site that will really be run.
 */
const interpolationSites = (): InterpolationSite[] =>
  Object.entries(corpusCommands).flatMap(([name, config]) =>
    [...config.template.matchAll(SHELL_INTERPOLATION)].map((match) => ({ name, command: match[1] ?? "" })),
  )

/** Drive one registered command the way the host would. */
const invoke = async (definition: { execute: (input: CommandInvocation) => Promise<void> }, text: string) =>
  definition.execute({ sessionID: "ses_fake", prompt: { text }, delivery: "queue" } as unknown as CommandInvocation)

/* ------------------------------------------------------------------ *
 * Agents                                                             *
 * ------------------------------------------------------------------ */

describe("agent corpus frontmatter", () => {
  test("discovery uses the existing PR tool grant without separate find/local actions", () => {
    for (const file of markdownFiles(agentDir)) {
      const permission = frontmatterOf(resolve(agentDir, file)).permission as Record<string, unknown>
      const allowed = ["corvus-review.md", "corvus-review-auto.md", "pr-context-gatherer.md", "pr-comment-writer.md"].includes(file)
      expect(permission.corvus_review_pr ?? permission["*"], file).toBe(allowed ? "allow" : "deny")
      expect(permission).not.toHaveProperty("corvus_review_find")
      expect(permission).not.toHaveProperty("corvus_review_local")
    }
  })

  test("carries only the five allowlisted keys, and always the four required ones", () => {
    const files = markdownFiles(agentDir)
    expect(files).toHaveLength(16)

    const unexpected: string[] = []
    const missing: string[] = []

    for (const file of files) {
      const keys = Object.keys(frontmatterOf(resolve(agentDir, file)))

      for (const key of keys) if (!AGENT_KEYS.includes(key)) unexpected.push(`${file}: ${key}`)
      for (const key of REQUIRED_AGENT_KEYS) if (!keys.includes(key)) missing.push(`${file}: ${key}`)
    }

    expect(unexpected).toEqual([])
    expect(missing).toEqual([])
  })

  test("keeps mode, color and permission actions inside the authored value sets", () => {
    const badModes: string[] = []
    const badColors: string[] = []
    const badPermissions: string[] = []
    const unknownActions: string[] = []

    for (const file of markdownFiles(agentDir)) {
      const frontmatter = frontmatterOf(resolve(agentDir, file))

      const mode = frontmatter.mode
      if (typeof mode !== "string" || !AGENT_MODES.includes(mode)) badModes.push(`${file}: ${JSON.stringify(mode)}`)

      // Optional, but malformed when present: the host coerces a non-`#` value to
      // `#aaaaaa` during migration, so a typo silently loses the authored color.
      const color = frontmatter.color
      if (color !== undefined && (typeof color !== "string" || !COLOR.test(color)))
        badColors.push(`${file}: ${JSON.stringify(color)}`)

      const permission = frontmatter.permission
      if (!isRecord(permission)) {
        badPermissions.push(`${file}: ${JSON.stringify(permission)}`)
        continue
      }

      // Only TOP-LEVEL keys are actions; one level down they are resource
      // patterns (`"git log*"`, `"**/*.env*"`), which no allowlist can enumerate.
      for (const action of Object.keys(permission))
        if (!KNOWN_PERMISSION_ACTIONS.includes(action)) unknownActions.push(`${file}: ${action}`)
    }

    expect(badModes).toEqual([])
    expect(badColors).toEqual([])
    expect(badPermissions).toEqual([])
    expect(unknownActions).toEqual([])

    // Self-check on the matcher, not on the corpus: an uppercase hex color is
    // authored today, so a case-SENSITIVE pattern would reject a valid file.
    expect(COLOR.test("#D97706")).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * Commands                                                           *
 * ------------------------------------------------------------------ */

describe("command corpus frontmatter", () => {
  test("carries only description, agent or model — never mode or temperature", () => {
    const files = markdownFiles(commandDir)
    expect(files).toHaveLength(4)

    const unexpected: string[] = []
    const undescribed: string[] = []

    for (const file of files) {
      const frontmatter = frontmatterOf(resolve(commandDir, file))

      for (const key of Object.keys(frontmatter)) if (!COMMAND_KEYS.includes(key)) unexpected.push(`${file}: ${key}`)
      if (typeof frontmatter.description !== "string" || frontmatter.description.trim() === "")
        undescribed.push(file)
    }

    expect(unexpected).toEqual([])
    expect(undescribed).toEqual([])
  })
})

describe("command shell interpolation", () => {
  test("every interpolation is a real command, not a placeholder or captured prose", () => {
    const sites = interpolationSites()

    expect(sites).toHaveLength(INTERPOLATION_SITES)

    // An unresolved `<...>` token is meant for the AGENT to fill in from an
    // earlier step. As a shell command it can never exit zero, and corvus fails
    // an interpolation closed rather than substituting empty output, so such a
    // site does not degrade the command — it kills it.
    const placeholders = sites.filter((site) => /<[^>]+>/.test(site.command))
    expect(placeholders.map((site) => `${site.name}: ${site.command}`)).toEqual([])

    // A capture spanning a newline is never a command: `[^`]+` matches `\n`, so
    // this is the signature of prose (a `` `!` `` marker abutting a closing
    // backtick) being read as one. That shape made `/git-commit` unexpandable.
    const prose = sites.filter((site) => site.command.includes("\n"))
    expect(prose.map((site) => `${site.name}: ${JSON.stringify(site.command)}`)).toEqual([])
  })

  test(
    "every packaged command expands against a real shell rooted at the repo",
    async () => {
      const fake = createFakeContext()

      // The registrar builds its runner from `ctx.location.directory` and exposes
      // no injection point, so pointing that at the repo root is what makes the
      // interpolations run where they were authored to run: `git diff --cached`,
      // `git log -20 --oneline`, `ls -la README*`. All seven sites are read-only.
      const ctx = {
        ...(fake.ctx as unknown as Record<string, unknown>),
        location: { directory: root, project: { id: "prj_corvus", directory: root, canonical: root } },
      } as unknown as SetupContext

      await registerCommands(ctx)
      expect(fake.commands.size).toBe(4)

      // No exclusions: expansion failing for ANY command is a broken command, and
      // a rejection here is the whole assertion — `expandTemplate` throws on a
      // non-zero exit instead of substituting empty output.
      for (const [name, definition] of fake.commands) {
        const position = fake.sessionCalls.length

        await invoke(definition, "")

        const call = fake.sessionCalls[position]
        const text = call?.method === "prompt" ? call.input.text : ""

        // The wrapper survives expansion byte-identically, so a template that
        // expanded at all still opens with it.
        expect({ name, wrapped: text.startsWith("<command-instruction>\n") }).toEqual({ name, wrapped: true })

        // An interpolation-bearing template MUST come back changed: its
        // `` !`cmd` `` sites were replaced by real output. The output itself is
        // deliberately not asserted — these commands read the worktree, and a
        // staged diff of this very repository can legitimately contain any string,
        // interpolation markers included.
        const template = corpusCommands[name].template
        if (template.match(SHELL_INTERPOLATION) !== null)
          expect({ name, expanded: text !== template }).toEqual({ name, expanded: true })
      }

      expect(fake.sessionCalls.map((call) => call.method)).toEqual(["prompt", "prompt", "prompt", "prompt"])
    },
    60_000,
  )
})

/* ------------------------------------------------------------------ *
 * Skills                                                             *
 * ------------------------------------------------------------------ */

describe("skill corpus identity", () => {
  test("every SKILL.md authors a name equal to its directory", () => {
    const records = loadSkills(skillDir)

    expect(records).toHaveLength(18)

    // Read the FILE's frontmatter, not `record.name`: the loader falls back to the
    // directory basename when `name` is absent (mirroring the host), so comparing
    // the record against its own id could never fail.
    const mismatched: string[] = []
    for (const record of records) {
      const authored = frontmatterOf(record.location).name
      if (authored !== record.id) mismatched.push(`${record.id}: ${JSON.stringify(authored)}`)
    }

    expect(mismatched).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * Protected agents (Requirement 5)                                   *
 * ------------------------------------------------------------------ */

describe("protected agent coverage", () => {
  test("every protected agent ships, and reviewers allow shell reads but deny explicit writes and edits", () => {
    const agents = loadAgents(agentDir)

    // A protected name with no corpus file is the worst failure mode available:
    // v1's deep-replace and v2's `enforceProtected` both key off this list, so a
    // renamed file turns a security boundary into a no-op for that agent.
    const missing = PROTECTED_AGENTS.filter(
      (name) => !existsSync(resolve(agentDir, `${name}.md`)) || agents[name] === undefined,
    )
    expect(missing).toEqual([])

    // Evaluated through the TRANSLATORS, not through the hook: this asks whether
    // the authored files still deny write capability once translated to v2 rules.
    // `protected-policy.test.ts` asks the different question of whether the hook
    // applies that ruleset correctly.
    const widened: string[] = []
    for (const agent of READ_ONLY_REVIEWERS) {
      const rules = toV2Permissions(agents[agent].permission)
      for (const command of ["git log --oneline", "git show HEAD", "ls src"]) expect(evaluateRules(rules, "shell", command)).toBe("allow")

      for (const action of ["shell", "edit"])
        for (const resource of ["src/index.ts", "rm -rf /", "*"]) {
          const effect = evaluateRules(rules, action, resource)
          if (effect !== "deny") widened.push(`${agent}: ${action} ${resource} → ${String(effect)}`)
        }
    }

    expect(widened).toEqual([])
  })
})

/**
 * The ordered pre-compaction forms plus approved restorations below are the oracle. Read packaged maps and
 * v1 config before comparing; changed keys, effects, order or overlong bash lines
 * fail these assertions. No rollout flag bypasses the preservation checks.
 */
test("bash compaction preserves captured entry order and v1 hook allow counts for all six review agents", async () => {
  const gh = ["gh pr view *", "gh pr diff *", "gh pr checks *", "gh pr list *", "gh pr status*",
    "gh issue view *", "gh issue list *", "gh repo view *", "gh api --method GET *", "gh api user*",
    "gh search *", "gh run list *", "gh run view *", "gh auth status"]
  const git = ["git status*", "git log*", "git show*", "git diff*", "git blame*", "git shortlog*",
    "git branch --list*", "git branch -a*", "git branch --show-current", "git remote -v", "git remote get-url *",
    "git rev-parse*", "git merge-base*", "git ls-files*", "git rev-list*", "git cat-file -p *", "git worktree list*", "git fetch *"]
  const utilities = ["ls *", "wc *", "head *", "tail *", "cat *", "uniq *", "file *", "stat *", "jq *", "shasum *",
    "sha256sum *", "date *", "python3 -m json.tool *", "test *", "printf *", "echo *", "pwd", "which *", "env", "bun --version", "node --version"]
  const barePr = ["gh api repos/*/pulls/*", "gh api repos/*/pulls/*/*"]
  const bareApi = [...barePr, "gh api --paginate repos/*/pulls/*/*", "gh api repos/*/commits/*",
    "gh api repos/*/compare/*", "gh api repos/*/contents/*", "gh api repos/*/issues/*"]
  const legacyApi = ["gh api repos/*/pulls/*/reviews --jq *", "gh api --paginate repos/*/pulls/*/reviews --jq *",
    "gh api repos/*/pulls/*/comments --jq *", "gh api repos/*/compare/* --jq *"]
  const orchestrator = ["date -u +%Y-%m-%dT%H:%M:%SZ", "shasum -a 256 .corvus/reviews/*/post-request.json",
    "git rev-parse HEAD", "gh auth status", "gh pr checkout * --repo * --detach", ...gh, ...legacyApi, ...bareApi, ...git, ...utilities]
  const before: Array<[string, number, string[]]> = [
    ["corvus-review", 68, orchestrator],
    ["corvus-review-auto", 68, orchestrator],
    ["pr-context-gatherer", 61, ["gh api --method GET *", "git log*", "git blame*", "git diff*", "git show*",
      "git shortlog*", "git rev-parse*", "git ls-files*", "git merge-base*", ...gh, ...bareApi, ...git, ...utilities, "sort *"]],
    ["pr-comment-writer", 58, ["jq . .corvus/reviews/*/post-request.json",
      "python3 -m json.tool .corvus/reviews/*/post-request.json", "shasum -a 256 .corvus/reviews/*/post-request.json",
      ...gh, ...barePr, ...git, ...utilities]],
    ["pr-code-reviewer", 39, [...git, ...utilities]],
    ["security-reviewer", 39, [...git, ...utilities]],
  ]
  const hooks = await v1Plugin({} as Parameters<typeof v1Plugin>[0])
  if (!hooks.config) throw new Error("Missing v1 config hook")
  const config: Parameters<NonNullable<typeof hooks.config>>[0] = {}
  await hooks.config(config)
  const loaded = loadAgents(agentDir)
  for (const [name, count, forms] of before) {
    const expected: [string, string][] = [["*", "deny"], ...[...new Set(forms)].map((form): [string, string] => [form, "allow"])]
    const raw = readFileSync(resolve(agentDir, `${name}.md`), "utf8")
    const permission = parseFrontmatter(raw).frontmatter.permission
    if (!isRecord(permission)) throw new Error(`Missing permission: ${name}`)
    for (const bash of [permission.bash, loaded[name].permission?.bash, config.agent?.[name]?.permission?.bash]) {
      if (!isRecord(bash)) throw new Error(`Missing bash map: ${name}`)
      expect(Object.entries(bash), name).toEqual(expected)
    }
    const hostRules = toV2Permissions(config.agent?.[name]?.permission).filter(rule => rule.action === "shell")
    expect(hostRules, name).toEqual(toV2Permissions({ bash: Object.fromEntries(expected) }))
    expect(hostRules.filter(rule => rule.effect === "allow"), name).toHaveLength(count)
    const block = raw.match(/^  bash: \{\n[\s\S]*?^  \}/m)?.[0]
    if (!block) throw new Error(`Missing flow mapping: ${name}`)
    expect(block.split("\n")[1]).toBe('    "*": "deny",')
    for (const line of block.split("\n")) expect(line.length, `${name}: ${line}`).toBeLessThanOrEqual(110)
  }
})

import { describe, expect, test } from "bun:test"
import { loadAgents } from "../load-agents"
import { agentDir, root } from "../paths"
import { toV2Agent } from "../to-v2-agent"
import { renameAction, toV2Permissions } from "../to-v2-permissions"
import { evaluateRules } from "../evaluate-rules"

/**
 * Translator contract tests (task 06).
 *
 * The REAL packaged corpus is the primary fixture: these translators only have to
 * be right about the 16 files corvus actually ships, and a synthetic fixture would
 * not notice the day one of them grows a key nobody reviewed. Synthetic fixtures
 * are used only for the failure and edge shapes the corpus deliberately does not
 * contain.
 */

const corpus = loadAgents(agentDir)
const ids = Object.keys(corpus)
type ShellPolicy = Record<string, "allow" | "deny" | "ask">

/** Translate a synthetic single-file corpus without touching the real `agent/`. */
const translate = (frontmatter: Record<string, unknown>, prompt = "Body") =>
  toV2Agent({ name: "fixture", config: { ...frontmatter, prompt } })

describe("toV2Agent over the real corpus", () => {
  test("allows installed references through the wildcard without a runtime grant", () => {
    const pattern = `${root.replaceAll("\\", "/")}/*`
    for (const [name, config] of Object.entries(corpus)) {
      const rules = toV2Agent({ name, config }).fields.permissions!
      expect(rules.some(rule => rule.resource === pattern)).toBe(false)
      for (const resource of [`${root}/skill/corvus-review-extras/schemas.md`, `${root}/skill/corvus-review-extras/*`]) {
        expect(evaluateRules(rules, "external_directory", resource)).toBe("allow")
        expect(evaluateRules(rules, "read", resource)).toBe("allow")
      }
    }
  })

  test("translates all 16 agents with zero warnings", () => {
    expect(ids).toHaveLength(16)

    const warnings = ids.flatMap((name) => toV2Agent({ name, config: corpus[name] }).warnings)

    expect(warnings).toEqual([])
  })

  test("every agent contributes the fields the host needs", () => {
    for (const name of ids) {
      const { fields } = toV2Agent({ name, config: corpus[name] })

      expect(typeof fields.description).toBe("string")
      expect(fields.mode).toBeOneOf(["subagent", "primary", "all"])
      expect(typeof fields.system).toBe("string")
      expect(typeof fields.request?.body.temperature).toBe("number")
      expect(fields.permissions?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test("maps mode, temperature, and case-insensitive hex color", () => {
    const { fields } = toV2Agent({ name: "corvus", config: corpus["corvus"] })

    expect(fields.mode).toBe("primary")
    expect(fields.request).toEqual({ body: { temperature: 0.2 } })
    // Uppercase hex is authored in `agent/corvus.md:2` and must survive.
    expect(fields.color).toBe("#D97706")

    const colored = ids.filter((name) => toV2Agent({ name, config: corpus[name] }).fields.color !== undefined)

    expect(colored.sort()).toEqual(["corvus", "corvus-auto", "corvus-review", "corvus-review-auto"])
  })
})

describe("toV2Agent field mapping", () => {
  test("renames the markdown body onto `system` and never emits `prompt`", () => {
    const { fields } = translate({ description: "d" }, "The authored body")

    expect(fields.system).toBe("The authored body")
    expect(fields).not.toHaveProperty("prompt")
  })

  test("omits absent optional fields instead of emitting undefined", () => {
    const { fields } = translate({ description: "only a description" })

    expect(Object.keys(fields).sort()).toEqual(["description", "system"])
    expect(fields).not.toHaveProperty("permissions")
    expect(fields).not.toHaveProperty("request")
  })

  test("drops an unknown frontmatter key with one `file:key` warning", () => {
    const { fields, warnings } = translate({ description: "d", tools: { read: true } })

    expect(warnings).toEqual(["fixture.md:tools — unknown agent frontmatter key, dropped"])
    expect(fields).not.toHaveProperty("tools")
    expect(fields.description).toBe("d")
  })

  test("throws on an invalid mode, color, temperature, description, or permission", () => {
    expect(() => translate({ mode: "supervisor" })).toThrow('fixture.md: Invalid "mode"')
    expect(() => translate({ color: "red" })).toThrow('fixture.md: Invalid "color"')
    expect(() => translate({ color: "#D9770" })).toThrow('fixture.md: Invalid "color"')
    expect(() => translate({ temperature: "hot" })).toThrow('fixture.md: Invalid "temperature"')
    expect(() => translate({ description: 42 })).toThrow('fixture.md: Invalid "description"')
    // A permission failure is re-thrown under the same file label.
    expect(() => translate({ permission: { read: "maybe" } })).toThrow(
      'fixture.md: Invalid permission value for action "read"',
    )
  })
})

describe("toV2Permissions", () => {
  test("review tools inherit default allow; caller checks are not frontmatter rules", () => {
    for (const config of Object.values(corpus)) {
      const rules = toV2Permissions(config.permission)
      for (const op of ["find", "local"]) expect(evaluateRules(rules, "corvus_review_pr", op)).toBe("allow")
      for (const op of ["resolve", "pull", "push"]) expect(evaluateRules(rules, "corvus_review_sync", op)).toBe("allow")
      expect(rules.some(rule => rule.action.startsWith("corvus_review_"))).toBe(false)
    }
  })

  test("real corvus-review uses a single wildcard for state and project access", () => {
    const rules = toV2Permissions(corpus["corvus-review"].permission)
    expect(rules).toEqual([{ action: "*", resource: "*", effect: "allow" }])
    for (const resource of [".corvus/reviews/x/lock.yaml", ".corvus/reviews/x/.lock",
      `.corvus/reviews/x/${"a".repeat(40)}/REVIEW_DOCUMENT.md`, ".corvus/reviews/x/candidate.json"]) {
      for (const target of [resource, `../${resource}`]) expect(evaluateRules(rules, "edit", target)).toBe("allow")
    }
    for (const resource of ["src/foo.ts", ".corvus/tasks/x/PLAN.md"]) expect(evaluateRules(rules, "edit", resource)).toBe("allow")
  })

  test("turns a scalar effect into one rule scoped to `*`", () => {
    expect(toV2Permissions({ read: "allow", edit: "deny", doom_loop: "ask", corvus_review_payload: "deny", corvus_review_post: "allow", corvus_review_persist: "deny", corvus_review_lock: "deny", corvus_review_pr: "allow", corvus_review_verdict: "deny", corvus_review_sync: "deny" })).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "doom_loop", resource: "*", effect: "ask" },
      { action: "corvus_review_payload", resource: "*", effect: "deny" },
      { action: "corvus_review_post", resource: "*", effect: "allow" },
      { action: "corvus_review_persist", resource: "*", effect: "deny" },
      { action: "corvus_review_lock", resource: "*", effect: "deny" },
      { action: "corvus_review_pr", resource: "*", effect: "allow" },
      { action: "corvus_review_verdict", resource: "*", effect: "deny" },
      { action: "corvus_review_sync", resource: "*", effect: "deny" },
    ])
  })

  test("turns a resource map into one rule per resource in frontmatter order", () => {
    for (const name of ids) {
      const rules = toV2Permissions(corpus[name].permission)
      const shell = rules.filter(rule => rule.action === "shell")
      const orchestrator = ["corvus", "corvus-auto"].includes(name)
      const leaf = ["pr-context-gatherer", "pr-comment-writer", "pr-code-reviewer", "security-reviewer"].includes(name)
      const autonomous = ["corvus-auto", "corvus-review-auto"].includes(name)
      expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "allow" })
      expect(rules).toHaveLength(1 + (orchestrator ? 11 : 0) + (leaf ? 2 : 0) + (autonomous ? 1 : 0))
      expect(rules.filter(rule => rule.effect === "deny")).toHaveLength((orchestrator ? 10 : 0) + (leaf ? 2 : 0) + (autonomous ? 1 : 0))
      if (!orchestrator) {
        expect(shell).toEqual([])
        continue
      }
      expect(shell[0]).toEqual({ action: "shell", resource: "*", effect: "allow" })
      expect(shell).toEqual(Object.entries(corpus[name].permission!.bash as ShellPolicy).map(([resource, effect]) => ({ action: "shell", resource, effect })))
      expect(shell).toHaveLength(11)
    }
  })

  test("renames v1 actions onto their v2 tool names, collapsing write and patch", () => {
    expect(toV2Permissions({ bash: "allow", task: "allow", write: "deny", patch: "ask" })).toEqual([
      { action: "shell", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "ask" },
    ])

    // Already-v2 names and actions with no v2 tool pass through, so the rename is
    // idempotent and safe to re-apply at hook time.
    for (const action of ["shell", "subagent", "edit", "read", "lsp", "doom_loop", "corvus_review_payload", "corvus_review_post", "corvus_review_persist", "corvus_review_lock", "corvus_review_pr", "corvus_review_verdict", "corvus_review_sync"])
      expect(renameAction(action)).toBe(action)
  })

  test("returns an empty ruleset for an absent block and skips nullish entries", () => {
    expect(toV2Permissions(undefined)).toEqual([])
    expect(toV2Permissions(null)).toEqual([])
    expect(toV2Permissions({ read: null, edit: undefined, grep: "allow" })).toEqual([
      { action: "grep", resource: "*", effect: "allow" },
    ])
  })

  test("throws on a malformed block, action value, or resource effect", () => {
    expect(() => toV2Permissions("allow")).toThrow("Invalid permission block")
    expect(() => toV2Permissions(["read"])).toThrow("Invalid permission block")
    expect(() => toV2Permissions({ read: 1 })).toThrow('Invalid permission value for action "read"')
    expect(() => toV2Permissions({ bash: { "ls *": "maybe" } })).toThrow(
      'Invalid permission effect for action "bash", resource "ls *"',
    )
  })
})

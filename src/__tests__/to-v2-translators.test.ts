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

/** Translate a synthetic single-file corpus without touching the real `agent/`. */
const translate = (frontmatter: Record<string, unknown>, prompt = "Body") =>
  toV2Agent({ name: "fixture", config: { ...frontmatter, prompt } })

describe("toV2Agent over the real corpus", () => {
  test("keeps the runtime grant last across translation and denies after its removal", () => {
    const pattern = `${root.replaceAll("\\", "/")}/*`
    for (const [name, config] of Object.entries(corpus)) {
      const rules = toV2Agent({ name, config }).fields.permissions!
      if (config.permission?.skill === "allow")
        expect(rules.at(-1)).toEqual({ action: "external_directory", resource: pattern, effect: "allow" })
      else expect(rules.some(rule => rule.resource === pattern)).toBe(false)
    }
    const rules = toV2Agent({ name: "corvus-review", config: corpus["corvus-review"] }).fields.permissions!
    for (const resource of [`${root}/skill/corvus-review-extras/schemas.md`, `${root}/skill/corvus-review-extras/*`]) {
      expect(evaluateRules(rules, "external_directory", resource)).toBe("allow")
      expect(evaluateRules(rules.slice(0, -1), "external_directory", resource)).toBe("deny")
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
  test("turns a scalar effect into one rule scoped to `*`", () => {
    expect(toV2Permissions({ read: "allow", edit: "deny", doom_loop: "ask", corvus_review_payload: "deny", corvus_review_verify: "allow" })).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "doom_loop", resource: "*", effect: "ask" },
      { action: "corvus_review_payload", resource: "*", effect: "deny" },
      { action: "corvus_review_verify", resource: "*", effect: "allow" },
    ])
  })

  test("turns a resource map into one rule per resource in frontmatter order", () => {
    const rules = toV2Permissions(corpus["pr-comment-writer"].permission)

    // `agent/pr-comment-writer.md:12-18`: a `*` deny followed by five allowlisted
    // commands. Order is the whole precedence model (last match wins), so the
    // deny MUST come first and the allows MUST keep their authored sequence.
    expect(rules.filter((rule) => rule.action === "shell")).toEqual([
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "gh api --method GET repos/*/pulls/* -H Accept:*", effect: "allow" },
      {
        action: "shell",
        resource: "gh api --method POST repos/*/pulls/*/reviews --input .corvus/reviews/*/post-request.json",
        effect: "allow",
      },
      { action: "shell", resource: "jq . .corvus/reviews/*/post-request.json", effect: "allow" },
      { action: "shell", resource: "python3 -m json.tool .corvus/reviews/*/post-request.json", effect: "allow" },
      { action: "shell", resource: "shasum -a 256 .corvus/reviews/*/post-request.json", effect: "allow" },
    ])
    // T27: 24 existing rules + one verify tool allow = 25; the shell rules are unchanged.
    expect(rules).toHaveLength(25)
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
    for (const action of ["shell", "subagent", "edit", "read", "lsp", "doom_loop", "corvus_review_payload", "corvus_review_verify"])
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

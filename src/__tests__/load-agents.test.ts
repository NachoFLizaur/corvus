import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { loadAgents } from "../load-agents"
import { root } from "../paths"
import { parseFrontmatter } from "../parse-frontmatter"
import { evaluateRules } from "../evaluate-rules"
import { toV2Permissions } from "../to-v2-permissions"

const ROOT = resolve(import.meta.dir, "../..")
const AGENT_DIR = resolve(ROOT, "agent")

const loadAgentFixture = (source: string, installRoot = root) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-test-"))
  try {
    writeFileSync(join(tmpDir, "fixture.md"), source)
    return loadAgents(tmpDir, installRoot)["fixture"]
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
}

describe("loadAgents", () => {
  test("loads all agent files", () => {
    const agents = loadAgents(AGENT_DIR)

    expect(Object.keys(agents)).toHaveLength(16)
  })

  test("appends the canonical root only for authored skill allows, preserving all other rules", () => {
    const agents = loadAgents(AGENT_DIR)
    const pattern = `${realpathSync(root).replaceAll("\\", "/")}/*`
    for (const [name, agent] of Object.entries(agents)) {
      const { permission } = parseFrontmatter<{ permission: Record<string, unknown> }>(
        readFileSync(resolve(AGENT_DIR, `${name}.md`), "utf8"),
      ).frontmatter
      const rules = toV2Permissions(agent.permission)
      if (permission.skill !== "allow") {
        expect(agent.permission).toEqual(permission)
        expect(rules.some(rule => rule.resource === pattern)).toBe(false)
        continue
      }
      expect(Object.keys(agent.permission!).at(-1)).toBe("external_directory")
      expect(rules.at(-1)).toEqual({ action: "external_directory", resource: pattern, effect: "allow" })
      const { external_directory, ...other } = agent.permission!
      const { external_directory: authoredExternal, ...authoredOther } = permission
      expect(other).toEqual(authoredOther)
      expect(Object.entries(external_directory as object).slice(0, -1)).toEqual(
        typeof authoredExternal === "string" ? [["*", authoredExternal]] : Object.entries(authoredExternal as object),
      )
    }
    for (const agent of Object.values(agents)) {
      expect(agent.permission?.["*"]).toBe("allow")
      expect(agent.permission).not.toHaveProperty("skill")
    }
  })

  test("moves an existing root entry and external action after later authored denies", () => {
    const pattern = `${root.replaceAll("\\", "/")}/*`
    const agent = loadAgentFixture(`---
permission:
  skill: allow
  external_directory:
    ${JSON.stringify(pattern)}: deny
    '*': deny
  '*': deny
  read: allow
---
Body`)
    const rules = toV2Permissions(agent.permission)
    expect(rules.at(-1)).toEqual({ action: "external_directory", resource: pattern, effect: "allow" })
    expect(rules.filter(rule => rule.resource === pattern)).toHaveLength(1)
    const target = `${root}/skill/corvus-review-extras/schemas.md`
    expect(evaluateRules(rules, "external_directory", target)).toBe("allow")
    expect(evaluateRules(rules.slice(0, -1), "external_directory", target)).toBe("deny")
    expect(evaluateRules(rules, "external_directory", `${root}-other/secret`)).toBe("deny")
  })

  test("preserves scalar external effects and handles an absent map", () => {
    for (const effect of ["allow", "deny", "ask", undefined]) {
      const agent = loadAgentFixture(`---\npermission:\n  skill: allow\n${effect ? `  external_directory: ${effect}\n` : ""}---\nBody`)
      expect(Object.entries(agent.permission!.external_directory as object)).toEqual([
        ...(effect ? [["*", effect] as [string, string]] : []), [`${root.replaceAll("\\", "/")}/*`, "allow"],
      ])
    }
  })

  test("resolves symlink installs and keeps regex punctuation literal", () => {
    const dir = mkdtempSync(join(tmpdir(), "corvus-install[.+]-"))
    try {
      const alias = join(dir, "alias")
      symlinkSync(root, alias, "dir")
      const source = "---\npermission:\n  skill: allow\n  '*': deny\n---\nBody"
      expect(loadAgentFixture(source, alias).permission).toEqual(loadAgentFixture(source, root).permission)
      const rules = toV2Permissions(loadAgentFixture(source, dir).permission)
      const canonical = realpathSync(dir)
      expect(evaluateRules(rules, "external_directory", `${canonical}/skill/ref.md`)).toBe("allow")
      expect(evaluateRules(rules, "external_directory", `${canonical.replace("[.+]", "xyz")}/skill/ref.md`)).toBe("deny")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("rejects unescapable wildcard and POSIX backslash install roots", () => {
    for (const character of ["*", "?", "\\"]) {
      const dir = mkdtempSync(join(tmpdir(), `corvus-${character}-`))
      try {
        expect(() => loadAgentFixture("---\npermission:\n  skill: allow\n---\nBody", dir))
          .toThrow(character === "\\" ? "Failed to parse fixture.md:" : "Cannot safely grant a wildcard-containing install root")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  test("agent names from filenames", () => {
    const agents = loadAgents(AGENT_DIR)
    const names = Object.keys(agents)

    expect(names).toContain("corvus")
    expect(names).toContain("code-implementer")
    expect(names).toContain("researcher")
    expect(names).toContain("code-explorer")
    expect(names).toContain("code-quality")
    expect(names).toContain("pr-code-reviewer")
  })

  test("maps description field", () => {
    const agents = loadAgents(AGENT_DIR)

    expect(typeof agents["researcher"].description).toBe("string")
    expect(agents["researcher"].description!.length).toBeGreaterThan(0)
  })

  test("maps mode field", () => {
    const agents = loadAgents(AGENT_DIR)

    expect(agents["corvus"].mode).toBe("primary")
  })

  test("maps temperature field", () => {
    const agents = loadAgents(AGENT_DIR)

    expect(agents["corvus"].temperature).toBe(0.2)
  })

  test("preserves native singular permission", () => {
    const agent = loadAgentFixture(
      "---\npermission:\n  read: allow\n---\nNative permission",
    )

    expect(agent.permission).toEqual({ read: "allow" })
    expect(agent).not.toHaveProperty("permissions")
  })

  test("loads legacy plural permissions as a singular alias", () => {
    const agent = loadAgentFixture(
      "---\npermissions:\n  read: allow\n---\nLegacy permission",
    )

    expect(agent.permission).toEqual({ read: "allow" })
    expect(agent).not.toHaveProperty("permissions")
  })

  test("prefers singular permission when both forms are present", () => {
    const agent = loadAgentFixture(
      [
        "---",
        "permission:",
        "  read: allow",
        "permissions:",
        "  read: deny",
        "  write: allow",
        "---",
        "Conflicting permissions",
      ].join("\n"),
    )

    expect(agent.permission).toEqual({ read: "allow" })
    expect(agent).not.toHaveProperty("permissions")
  })

  test("passes unknown frontmatter fields through", () => {
    const agent = loadAgentFixture(
      "---\nnative_option:\n  enabled: true\n---\nNative metadata",
    )

    expect(agent.native_option).toEqual({ enabled: true })
  })

  test("uses the Markdown body as the authoritative prompt", () => {
    const agent = loadAgentFixture(
      "---\nprompt: Frontmatter prompt\n---\nMarkdown body prompt",
    )

    expect(agent.prompt).toBe("Markdown body prompt")
  })

  test("handles agent with minimal frontmatter", () => {
    const agent = loadAgentFixture(
      "---\ndescription: minimal agent\n---\nHello",
    )

    expect(agent.description).toBe("minimal agent")
    expect(agent.prompt).toBe("Hello")
    // Only defined fields should be set
    expect(agent.mode).toBeUndefined()
    expect(agent.temperature).toBeUndefined()
    expect(agent.tools).toBeUndefined()
    expect(agent.permission).toBeUndefined()
  })
})

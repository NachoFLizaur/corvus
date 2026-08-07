import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { loadAgents } from "../load-agents"

const ROOT = resolve(import.meta.dir, "../..")
const AGENT_DIR = resolve(ROOT, "agent")

const loadAgentFixture = (source: string) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-test-"))
  try {
    writeFileSync(join(tmpDir, "fixture.md"), source)
    return loadAgents(tmpDir)["fixture"]
  } finally {
    rmSync(tmpDir, { recursive: true })
  }
}

describe("loadAgents", () => {
  test("loads all agent files", () => {
    const agents = loadAgents(AGENT_DIR)

    expect(Object.keys(agents)).toHaveLength(16)
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

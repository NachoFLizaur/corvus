import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { loadAgents } from "../load-agents"

const ROOT = resolve(import.meta.dir, "../..")
const AGENT_DIR = resolve(ROOT, "agent")

describe("loadAgents", () => {
  test("loads all agent files", () => {
    const agents = loadAgents(AGENT_DIR)

    expect(Object.keys(agents)).toHaveLength(10)
  })

  test("agent names from filenames", () => {
    const agents = loadAgents(AGENT_DIR)
    const names = Object.keys(agents)

    expect(names).toContain("corvus")
    expect(names).toContain("code-implementer")
    expect(names).toContain("researcher")
    expect(names).toContain("code-explorer")
    expect(names).toContain("code-quality")
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

  test("maps tools field", () => {
    const agents = loadAgents(AGENT_DIR)
    const tools = agents["corvus"].tools

    expect(tools).toBeDefined()
    expect(typeof tools).toBe("object")
    // All tool values should be booleans
    for (const value of Object.values(tools!)) {
      expect(typeof value).toBe("boolean")
    }
  })

  test("renames permissions to permission", () => {
    const agents = loadAgents(AGENT_DIR)
    const implementer = agents["code-implementer"]

    expect(implementer).toHaveProperty("permission")
    expect(implementer).not.toHaveProperty("permissions")
  })

  test("maps body to prompt", () => {
    const agents = loadAgents(AGENT_DIR)

    expect(typeof agents["corvus"].prompt).toBe("string")
    expect(agents["corvus"].prompt!.length).toBeGreaterThan(0)
  })

  test("handles agent with minimal frontmatter", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-test-"))
    try {
      writeFileSync(
        join(tmpDir, "minimal.md"),
        "---\ndescription: minimal agent\n---\nHello",
      )

      const agents = loadAgents(tmpDir)

      expect(agents["minimal"].description).toBe("minimal agent")
      expect(agents["minimal"].prompt).toBe("Hello")
      // Only defined fields should be set
      expect(agents["minimal"].mode).toBeUndefined()
      expect(agents["minimal"].temperature).toBeUndefined()
      expect(agents["minimal"].tools).toBeUndefined()
      expect(agents["minimal"].permission).toBeUndefined()
    } finally {
      rmSync(tmpDir, { recursive: true })
    }
  })
})

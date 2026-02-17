import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseFrontmatter } from "../parse-frontmatter"

const ROOT = resolve(import.meta.dir, "../..")
const SKILL_PATH = resolve(ROOT, "skill/corvus-phase-1/SKILL.md")

describe("Phase 1 Template", () => {
  // Arrange - read file once, share across tests (read-only, no shared mutable state)
  const content = readFileSync(SKILL_PATH, "utf-8")
  const { frontmatter } = parseFrontmatter<Record<string, any>>(content)

  test("template references multi_search", () => {
    // Assert
    expect(content).toContain("web-research_multi_search")
  })

  test("template references fetch_pages", () => {
    // Assert
    expect(content).toContain("web-research_fetch_pages")
  })

  test("template mentions complexity router", () => {
    // Assert - should mention complexity router or its paths
    const hasRouter =
      content.toLowerCase().includes("complexity router") ||
      (content.toLowerCase().includes("quick search") &&
        content.toLowerCase().includes("deep research"))
    expect(hasRouter).toBe(true)
  })

  test("template mentions fallback", () => {
    // Assert
    expect(content.toLowerCase()).toContain("fallback")
  })

  test("no context7 references", () => {
    // Assert
    expect(content.toLowerCase()).not.toContain("context7")
  })

  test("code explorer template preserved", () => {
    // Assert - section 1b must still exist
    expect(content).toContain("1b. Codebase Investigation")
  })

  test("has valid frontmatter", () => {
    // Assert - frontmatter must parse and have correct name
    expect(frontmatter).toBeDefined()
    expect(frontmatter.name).toBe("corvus-phase-1")
  })
})

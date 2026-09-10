import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseFrontmatter } from "../parse-frontmatter"

const ROOT = resolve(import.meta.dir, "../..")
const SKILL_PATH = resolve(ROOT, "skill/web-search/SKILL.md")

describe("Web Search Skill", () => {
  // Arrange - read file once, share across tests (read-only, no shared mutable state)
  const content = readFileSync(SKILL_PATH, "utf-8")
  const { frontmatter } = parseFrontmatter<Record<string, any>>(content)

  test("skill file exists", () => {
    // Assert - if we got here, the file was readable
    expect(content.length).toBeGreaterThan(0)
  })

  test("has valid frontmatter with name", () => {
    // Assert
    expect(frontmatter.name).toBe("web-search")
  })

  test("has description in frontmatter", () => {
    // Assert
    expect(typeof frontmatter.description).toBe("string")
    expect(frontmatter.description.length).toBeGreaterThan(0)
  })

  test("references multi_search tool", () => {
    // Assert
    expect(content).toContain("web-research_multi_search")
  })

  test("references fetch_pages tool", () => {
    // Assert
    expect(content).toContain("web-research_fetch_pages")
  })

  test("has query limit guidance", () => {
    // Assert - should contain "1-3" for query limits
    expect(content).toContain("1-3 targeted queries")
  })

  test("has page limit guidance", () => {
    // Assert - should contain "2-3" for page limits
    expect(content).toContain("Identify 2-3 relevant URLs")
    expect(content).toContain("most 3 pages")
  })

  test("has escalation section", () => {
    // Assert - complexity and scope limits select the deep-research branch
    expect(content).toContain("## Escalation to Deep Research")
    expect(content).toContain("question proves more complex, answers conflict, comparison is needed")
    expect(content).toContain("more than 3 queries, pages, or sources")
    expect(content).toContain('skill({ name: "deep-research" })')
  })

  test("has workflow steps", () => {
    // Assert - should contain Step 1 through Step 4
    expect(content).toContain("Step 1")
    expect(content).toContain("Step 2")
    expect(content).toContain("Step 3")
    expect(content).toContain("Step 4")
    expect(content).toContain("../../agent/researcher.md#complexity-router")
    expect(content).toContain("../../agent/researcher.md#evidence-discipline")
    expect(content).toContain("../../agent/researcher.md#output-format")
    expect(content).toContain("../../agent/researcher.md#three-tier-fallback-chain")
    expect(content).toContain("tooling-limited coverage is reported under that contract")
  })
})

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseFrontmatter } from "../parse-frontmatter"

const ROOT = resolve(import.meta.dir, "../..")
const SKILL_PATH = resolve(ROOT, "skill/deep-research/SKILL.md")

describe("Deep Research Skill", () => {
  // Arrange - read file once, share across tests (read-only, no shared mutable state)
  const content = readFileSync(SKILL_PATH, "utf-8")
  const { frontmatter } = parseFrontmatter<Record<string, any>>(content)

  test("skill file exists", () => {
    // Assert - if we got here, the file was readable
    expect(content.length).toBeGreaterThan(0)
  })

  test("has valid frontmatter with name", () => {
    // Assert
    expect(frontmatter.name).toBe("deep-research")
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

  test("has quality checklist section", () => {
    // Assert
    expect(content).toContain("Quality Checklist")
  })

  test("checklist requires 10+ sources", () => {
    // Assert
    expect(content).toContain("10+")
    expect(content.toLowerCase()).toContain("sources")
  })

  test("checklist requires 500+ words", () => {
    // Assert
    expect(content).toContain("500+")
    expect(content.toLowerCase()).toContain("words")
  })

  test("checklist requires citations", () => {
    // Assert
    expect(content.toLowerCase()).toMatch(/citation/)
    expect(content).toContain("../../agent/researcher.md#evidence-discipline")
  })

  test("checklist requires conflict analysis", () => {
    // Assert
    expect(content.toLowerCase()).toMatch(/conflict/)
  })

  test("checklist requires confidence levels", () => {
    // Assert
    expect(content.toLowerCase()).toMatch(/confidence/)
  })

  test("has structured output template", () => {
    // Assert
    expect(content).toContain("../../agent/researcher.md#output-format")
    expect(content).toContain("starting with its TL;DR")
  })

  test("has comparison table in template", () => {
    // Assert
    expect(content).toContain("Comparison Table")
  })

  test("has research gaps section", () => {
    // Assert
    expect(content).toContain("Research Gaps")
    expect(content).toContain("`UNRESOLVED_SCOPE`")
  })

  test("has evidence quality guidance", () => {
    // Assert
    expect(content).toContain("## Evidence Quality")
    expect(content).toContain("Read full pages, seek disconfirming evidence, and diversify source types")
  })

  test("has fallback behavior section", () => {
    // Assert
    expect(content).toContain("## Fallback Behavior")
    expect(content).toContain("../../agent/researcher.md#three-tier-fallback-chain")
    expect(content).toContain("explain checklist shortfalls, including fewer sources")
    expect(content).toContain("mark the resulting gaps as unresolved")
  })

  test("has 5-10 query guidance", () => {
    // Assert
    expect(content).toContain("5-10")
  })
})

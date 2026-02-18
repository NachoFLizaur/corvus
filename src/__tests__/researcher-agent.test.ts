import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseFrontmatter } from "../parse-frontmatter"

const ROOT = resolve(import.meta.dir, "../..")
const RESEARCHER_PATH = resolve(ROOT, "agent/researcher.md")

describe("Researcher Agent", () => {
  // Arrange - read file once, share across tests (read-only, no shared mutable state)
  const content = readFileSync(RESEARCHER_PATH, "utf-8")
  const { frontmatter } = parseFrontmatter<Record<string, any>>(content)

  test("no context7 references", () => {
    // Assert - no context7 in any case
    expect(content.toLowerCase()).not.toContain("context7")
  })

  test("no exa references", () => {
    // Assert - no exa tool references
    expect(content).not.toMatch(/exa_web_search|websearch_exa/i)
  })

  test("permissions has web-research_multi_search", () => {
    // Assert
    expect(frontmatter.permissions["web-research_multi_search"]).toBe("allow")
  })

  test("permissions has web-research_fetch_pages", () => {
    // Assert
    expect(frontmatter.permissions["web-research_fetch_pages"]).toBe("allow")
  })

  test("curl permission is allow", () => {
    // Assert - curl must be "allow" for fallback tier 3
    expect(frontmatter.permissions.bash["curl *"]).toBe("allow")
  })

  test("has complexity router section", () => {
    // Assert
    expect(content).toContain("COMPLEXITY ROUTER")
  })

  test("has quick search path", () => {
    // Assert
    expect(content).toContain("Quick Search")
  })

  test("has deep research path", () => {
    // Assert
    expect(content).toContain("Deep Research")
  })

  test("has three-tier fallback section", () => {
    // Assert - check for either heading variant
    const hasFallback =
      content.includes("THREE-TIER FALLBACK") || content.includes("FALLBACK CHAIN")
    expect(hasFallback).toBe(true)
  })

  test("has tier 1 mcp tools", () => {
    // Assert
    expect(content).toContain("Tier 1")
    expect(content).toContain("MCP")
  })

  test("has tier 2 webfetch", () => {
    // Assert
    expect(content).toContain("Tier 2")
    expect(content).toContain("webfetch")
  })

  test("has tier 3 curl", () => {
    // Assert
    expect(content).toContain("Tier 3")
    expect(content).toContain("curl")
  })

  test("valid yaml frontmatter", () => {
    // Assert - parseFrontmatter would throw if YAML is invalid
    // The fact that we got here means it parsed, but let's verify structure
    expect(frontmatter).toBeDefined()
    expect(frontmatter.description).toBeDefined()
    expect(frontmatter.mode).toBe("subagent")
    expect(frontmatter.permissions).toBeDefined()
  })

  test("preserves output format sections", () => {
    // Assert - all three output format variants must exist
    expect(content).toContain("Technical Questions")
    expect(content).toContain("Debugging Questions")
    expect(content).toContain("Architecture Questions")
  })

  test("no git log bash permission", () => {
    // Assert - git log is code-explorer territory
    expect(frontmatter.permissions.bash["git log*"]).toBeUndefined()
  })

  test("no git show bash permission", () => {
    // Assert - git show is code-explorer territory
    expect(frontmatter.permissions.bash["git show*"]).toBeUndefined()
  })

  test("no local codebase research source section", () => {
    // Assert - codebase analysis is code-explorer territory
    expect(content).not.toContain("Local Codebase")
  })

  test("no thoughts directory references", () => {
    // Assert - thoughts/ is target-project convention, not researcher tool
    expect(content).not.toContain("thoughts/research/")
    expect(content).not.toContain("thoughts/tickets/")
    expect(content).not.toContain("thoughts/architecture/")
  })

  test("description does not mention codebase analysis", () => {
    // Assert - researcher is external research only
    expect(frontmatter.description).not.toContain("codebase analysis")
  })

  test("gh bash permission preserved", () => {
    // Assert - GitHub-wide research is external research
    expect(frontmatter.permissions.bash["gh *"]).toBe("allow")
  })

  test("read/glob/grep permissions preserved", () => {
    // Assert - still needed for quick context checks (e.g., reading package.json)
    expect(frontmatter.permissions.read).toBe("allow")
    expect(frontmatter.permissions.glob).toBe("allow")
    expect(frontmatter.permissions.grep).toBe("allow")
  })
})

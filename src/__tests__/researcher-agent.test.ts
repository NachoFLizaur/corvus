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
  const permission = frontmatter.permission

  test("no context7 references", () => {
    // Assert - no context7 in any case
    expect(content.toLowerCase()).not.toContain("context7")
  })

  test("no exa references", () => {
    // Assert - no exa tool references
    expect(content).not.toMatch(/exa_web_search|websearch_exa/i)
  })

  test("permission has web-research_multi_search", () => {
    // Assert
    expect(permission["web-research_multi_search"]).toBe("allow")
  })

  test("permission has web-research_fetch_pages", () => {
    // Assert
    expect(permission["web-research_fetch_pages"]).toBe("allow")
  })

  test("curl permission is allow", () => {
    // Assert - curl must be "allow" for fallback tier 3
    expect(permission.bash["curl *"]).toBe("allow")
  })

  test("has complexity router section", () => {
    // Assert
    expect(content).toContain("## Complexity Router")
  })

  test("has quick search path", () => {
    // Assert
    expect(content).toContain('| Quick Search | Factual lookup, specific API/syntax, or a single topic with a direct answer | `skill({ name: "web-search" })` |')
  })

  test("has deep research path", () => {
    // Assert
    expect(content).toContain('| Deep Research | Comparative analysis, architectural decisions, multi-faceted topics, or context-dependent best practices | `skill({ name: "deep-research" })` |')
  })

  test("has three-tier fallback section", () => {
    // Assert - one owner defines ordered fallback and explicit failure reporting
    expect(content).toContain("## Three-Tier Fallback Chain")
    expect(content).toContain("Start at Tier 1; advance in order")
    expect(content).toContain("unavailable, errors, or returns empty or insufficient results")
    expect(content).toContain("active tier and include each degradation and its coverage impact")
    expect(content).toContain("If all tiers fail, report research sources unavailable")
  })

  test("has tier 1 mcp tools", () => {
    // Assert
    expect(content).toContain("1. **Tier 1: MCP tools**")
    expect(content).toContain("search with `web-research_multi_search`")
    expect(content).toContain("full pages with `web-research_fetch_pages`")
  })

  test("has tier 2 webfetch", () => {
    // Assert
    expect(content).toContain("2. **Tier 2: webfetch**")
    expect(content).toContain("fetch known URLs one page at a time")
    expect(content).toContain("capability is unavailable and coverage is limited to known URLs")
  })

  test("has tier 3 curl", () => {
    // Assert
    expect(content).toContain("3. **Tier 3: curl via bash**")
    expect(content).toContain("retrieve raw page content as a last resort")
    expect(content).toContain("raw HTML, lack of parsing, and single-page retrieval")
  })

  test("valid yaml frontmatter", () => {
    // Assert - parseFrontmatter would throw if YAML is invalid
    // The fact that we got here means it parsed, but let's verify structure
    expect(frontmatter).toBeDefined()
    expect(frontmatter.description).toBeDefined()
    expect(frontmatter.mode).toBe("subagent")
    expect(frontmatter.permission).toBeDefined()
  })

  test("preserves output format sections", () => {
    // Assert - one shared report retains all question branches and the routed handoff
    expect(content).toContain("Technical Questions")
    expect(content).toContain("Debugging Questions")
    expect(content).toContain("Architecture Questions")
    for (const heading of ["TL;DR", "Findings", "Recommendation", "Risks & Guardrails", "Verification Scope", "Sources"]) {
      expect(content).toContain(`## ${heading}`)
    }
    expect(content).toContain("**Effort**: <S/M/L/XL>")
    expect(content).toContain("**Rationale**:")
    expect(content).toContain("Link every claim")
    expect(content).toContain("Record publication/update dates")
    expect(content).toContain("flag stale sources")
    expect(content).toContain("**Tested**:")
    expect(content).toContain("**Not tested**:")
    expect(content).toContain("only a contract claim; behavioral safety needs behavioral evidence")
    for (const field of ["DISCOVERY_ORIGIN", "RETURN_TARGET", "DISCOVERY_SCOPE", "EXISTING_FINDINGS", "UNRESOLVED_SCOPE"]) {
      expect(content).toContain(field)
    }
    expect(content).toContain("## Phase 1 Handoff")
    expect(content).toContain("NEW_FINDINGS")
    expect(content).toContain("ACCUMULATED_FINDINGS")
  })

  test("no git log bash permission", () => {
    // Assert - git log is code-explorer territory
    expect(permission.bash["git log*"]).toBeUndefined()
  })

  test("no git show bash permission", () => {
    // Assert - git show is code-explorer territory
    expect(permission.bash["git show*"]).toBeUndefined()
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
    expect(permission.bash["gh *"]).toBe("allow")
  })

  test("read/glob/grep permission rules preserved", () => {
    // Assert - still needed for quick context checks (e.g., reading package.json)
    expect(permission.read).toBe("allow")
    expect(permission.glob).toBe("allow")
    expect(permission.grep).toBe("allow")
  })
})

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

  test("template carries discovery origin and return target", () => {
    // Assert
    expect(content).toContain("**DISCOVERY_ORIGIN**: <PHASE_0A or DIRECT_CALLER>")
    expect(content).toContain("**RETURN_TARGET**: <PHASE_0B or original caller identity>")
  })

  test("template carries unresolved scope and existing findings", () => {
    // Assert
    expect(content).toContain("**DISCOVERY_SCOPE**: <specific unresolved questions>")
    expect(content).toContain("**EXISTING_FINDINGS**: <accumulated findings, or none>")
  })

  test("template mentions complexity router", () => {
    // Assert - should mention complexity router or its paths
    const hasRouter =
      content.toLowerCase().includes("complexity router") ||
      (content.toLowerCase().includes("quick search") &&
        content.toLowerCase().includes("deep research"))
    expect(hasRouter).toBe(true)
  })

  test("completion payload preserves routing and accumulates findings", () => {
    // Assert
    expect(content).toContain("**DISCOVERY_ORIGIN**: <unchanged from dispatch>")
    expect(content).toContain("**RETURN_TARGET**: <unchanged from dispatch>")
    expect(content).toContain("**NEW_FINDINGS**: <findings from this invocation>")
    expect(content).toContain("**ACCUMULATED_FINDINGS**: <EXISTING_FINDINGS merged with NEW_FINDINGS, deduplicated>")
    expect(content).toContain("**COMPETING IN-FLIGHT WORK**: <overlapping PRs and paths, none, not applicable, or coverage gap>")
    expect(content).toContain("**UNRESOLVED_SCOPE**: <remaining questions, or none>")
  })

  test("no context7 references", () => {
    // Assert
    expect(content.toLowerCase()).not.toContain("context7")
  })

  test("code explorer template preserved", () => {
    // Assert - section 1b must still exist
    expect(content).toContain("1b. Codebase Investigation")
  })

  test("routes discovery results by origin", () => {
    expect(content).toContain("`PHASE_0A` → `PHASE_0B`; `DIRECT_CALLER` → original")
    expect(content).toContain("For `PHASE_0A`, return `ACCUMULATED_FINDINGS` to Phase 0b for analyst `POST_DISCOVERY`.")
    expect(content).toContain("For `DIRECT_CALLER`, return the payload to the original caller and stop.")
  })

  test("does not unconditionally enter planning", () => {
    expect(content).not.toContain("Immediately invoke task-planner")
    expect(content).toContain("Phase 1 never invokes task-planner; the caller owns subsequent workflow routing.")
  })

  test("has valid frontmatter", () => {
    // Assert - frontmatter must parse and have correct name
    expect(frontmatter).toBeDefined()
    expect(frontmatter.name).toBe("corvus-phase-1")
  })
})

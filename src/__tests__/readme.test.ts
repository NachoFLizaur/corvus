import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")
const readme = readFileSync(resolve(ROOT, "README.md"), "utf-8")

describe("README.md", () => {
  test("mentions corvus-ai package name", () => {
    expect(readme).toContain("corvus-ai")
  })

  test("documents plugin installation", () => {
    // Should contain plugin config example
    expect(readme).toMatch(/plugin/i)
    expect(readme).toContain("corvus-ai")
  })

  test("documents manual installation", () => {
    // Should mention symlink or manual copy
    expect(readme).toMatch(/symlink|ln -s|manual|copy/i)
  })

  test("lists agents", () => {
    // Should mention key agents
    expect(readme).toMatch(/corvus/i)
    expect(readme).toMatch(/code-implementer|code.implementer/i)
  })

  test("lists commands", () => {
    // Should mention commands
    expect(readme).toMatch(/git-commit|git.commit/i)
  })

  test("includes development setup", () => {
    // Should have dev instructions
    expect(readme).toMatch(/bun (install|test|run build)/i)
  })
})

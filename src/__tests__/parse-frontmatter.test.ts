import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseFrontmatter } from "../parse-frontmatter"

const ROOT = resolve(import.meta.dir, "../..")

describe("parseFrontmatter", () => {
  test("parses basic frontmatter", () => {
    const result = parseFrontmatter("---\ntitle: hello\n---\nbody")

    expect(result).toEqual({
      frontmatter: { title: "hello" },
      body: "body",
    })
  })

  test("parses nested YAML objects", () => {
    const input = [
      "---",
      "permissions:",
      "  bash:",
      '    "rm -rf *": "deny"',
      '    "sudo *": "deny"',
      "---",
      "body",
    ].join("\n")

    const result = parseFrontmatter(input)

    expect(result.frontmatter).toEqual({
      permissions: {
        bash: {
          "rm -rf *": "deny",
          "sudo *": "deny",
        },
      },
    })
  })

  test("parses boolean values", () => {
    const input = "---\ntools:\n  write: true\n  edit: false\n---\n"

    const result = parseFrontmatter(input)

    expect(result.frontmatter).toEqual({
      tools: { write: true, edit: false },
    })
  })

  test("parses numeric values", () => {
    const input = "---\ntemperature: 0.2\n---\n"

    const result = parseFrontmatter(input)

    expect(result.frontmatter).toEqual({ temperature: 0.2 })
  })

  test("trims body whitespace", () => {
    const input = "---\nk: v\n---\n\n  body  \n\n"

    const result = parseFrontmatter(input)

    expect(result.body).toBe("body")
  })

  test("throws on missing frontmatter", () => {
    expect(() => parseFrontmatter("no frontmatter here")).toThrow(Error)
  })

  test("handles empty frontmatter", () => {
    const result = parseFrontmatter("---\n---\nbody")

    expect(result).toEqual({
      frontmatter: {},
      body: "body",
    })
  })

  test("handles Windows line endings", () => {
    const input = "---\r\nk: v\r\n---\r\nbody"

    const result = parseFrontmatter(input)

    expect(result.frontmatter).toEqual({ k: "v" })
    expect(result.body).toBe("body")
  })

  test("parses real agent file", () => {
    const content = readFileSync(
      resolve(ROOT, "agent/researcher.md"),
      "utf-8",
    )

    const result = parseFrontmatter(content)

    expect(result.frontmatter).toHaveProperty("description")
    expect(result.frontmatter).toHaveProperty("mode")
    expect(result.frontmatter).toHaveProperty("permissions")
    expect(result.body).toBeTruthy()
  })

  test("parses real command file", () => {
    const content = readFileSync(
      resolve(ROOT, "command/git-commit.md"),
      "utf-8",
    )

    const result = parseFrontmatter(content)

    expect(result.frontmatter).toHaveProperty("description")
    expect(result.body).toBeTruthy()
  })
})

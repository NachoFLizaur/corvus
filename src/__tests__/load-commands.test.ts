import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { loadCommands } from "../load-commands"

const ROOT = resolve(import.meta.dir, "../..")
const COMMAND_DIR = resolve(ROOT, "command")

describe("loadCommands", () => {
  test("loads all command files", () => {
    const commands = loadCommands(COMMAND_DIR)

    expect(Object.keys(commands)).toHaveLength(4)
  })

  test("command names from filenames", () => {
    const commands = loadCommands(COMMAND_DIR)
    const names = Object.keys(commands)

    expect(names).toContain("git-commit")
    expect(names).toContain("summary")
    expect(names).toContain("readme")
    expect(names).toContain("cleanup-subagents")
  })

  test("wraps body in command-instruction tags", () => {
    const commands = loadCommands(COMMAND_DIR)

    expect(commands["git-commit"].template).toStartWith("<command-instruction>")
  })

  test("template ends with closing tag", () => {
    const commands = loadCommands(COMMAND_DIR)

    expect(commands["git-commit"].template).toEndWith(
      "</command-instruction>",
    )
  })

  test("maps description field", () => {
    const commands = loadCommands(COMMAND_DIR)

    expect(typeof commands["git-commit"].description).toBe("string")
    expect(commands["git-commit"].description!.length).toBeGreaterThan(0)
  })

  test("ignores non-standard frontmatter fields", () => {
    const commands = loadCommands(COMMAND_DIR)
    const summary = commands["summary"] as Record<string, unknown>

    // summary.md has mode and temperature in frontmatter,
    // but these are not part of CommandConfig and should not appear
    expect(summary).not.toHaveProperty("mode")
    expect(summary).not.toHaveProperty("temperature")
  })

  test("template is always set", () => {
    const commands = loadCommands(COMMAND_DIR)

    for (const command of Object.values(commands)) {
      expect(command.template).toBeDefined()
      expect(typeof command.template).toBe("string")
      expect(command.template.length).toBeGreaterThan(0)
    }
  })
})

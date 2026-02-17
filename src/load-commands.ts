import { readdirSync, readFileSync } from "node:fs"
import { resolve, basename } from "node:path"
import { parseFrontmatter } from "./parse-frontmatter"

interface CommandFrontmatter {
  description?: string
  agent?: string
  model?: string
  subtask?: boolean
}

interface CommandConfig {
  template: string
  description?: string
  agent?: string
  model?: string
  subtask?: boolean
}

/**
 * Load all command markdown files from the given directory.
 * Returns a Record<string, CommandConfig> keyed by command name (filename without .md).
 *
 * The markdown body is wrapped in <command-instruction> tags to form the template,
 * matching OpenCode's expected command format.
 */
export function loadCommands(commandDir: string): Record<string, CommandConfig> {
  const commands: Record<string, CommandConfig> = {}

  const files = readdirSync(commandDir).filter((f) => f.endsWith(".md"))

  for (const file of files) {
    const filePath = resolve(commandDir, file)
    const content = readFileSync(filePath, "utf-8")

    try {
      const { frontmatter, body } =
        parseFrontmatter<CommandFrontmatter>(content)

      const name = basename(file, ".md")

      const config: CommandConfig = {
        template: `<command-instruction>\n${body}\n</command-instruction>`,
      }

      if (frontmatter.description !== undefined)
        config.description = frontmatter.description
      if (frontmatter.agent !== undefined) config.agent = frontmatter.agent
      if (frontmatter.model !== undefined) config.model = frontmatter.model
      if (frontmatter.subtask !== undefined) config.subtask = frontmatter.subtask

      commands[name] = config
    } catch (e) {
      throw new Error(`Failed to parse ${file}: ${(e as Error).message}`)
    }
  }

  return commands
}

import { readdirSync, readFileSync, realpathSync } from "node:fs"
import { resolve, basename } from "node:path"
import { parseFrontmatter } from "./parse-frontmatter"
import { root } from "./paths"

interface AgentFrontmatter {
  description?: string
  mode?: "primary" | "subagent" | "all"
  temperature?: number
  permission?: Record<string, unknown>
  permissions?: Record<string, unknown>
  color?: string
  [key: string]: unknown
}

interface AgentConfig {
  description?: string
  mode?: "primary" | "subagent" | "all"
  prompt?: string
  temperature?: number
  permission?: Record<string, unknown>
  color?: string
  [key: string]: unknown
}

/**
 * Load all agent markdown files from the given directory.
 * Returns a Record<string, AgentConfig> keyed by agent name (filename without .md).
 *
 * Install-root grant invariant: the oracle is authored `skill: allow` and the
 * realpath of this package, read before either host receives an agent. Move the
 * external-directory map after every authored action, and its root rule after
 * every authored resource: both hosts use last-match-wins, and v2 translation
 * preserves insertion order. Other permissions and user overrides stay intact.
 * Missing/non-allow skill permission (including protected agents' deny) disables
 * injection. Unresolvable or unrepresentable roots abort loading on both hosts,
 * never widen a literal path: their matchers expand both `*` and `?`, normalize
 * backslashes, and offer no literal wildcard escape. Regex punctuation is already
 * escaped by the hosts; POSIX literal backslashes cannot be represented safely.
 */
export function loadAgents(agentDir: string, installRoot = root): Record<string, AgentConfig> {
  const agents: Record<string, AgentConfig> = {}

  const files = readdirSync(agentDir).filter((f) => f.endsWith(".md"))

  for (const file of files) {
    const filePath = resolve(agentDir, file)
    const content = readFileSync(filePath, "utf-8")

    try {
      const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content)

      const name = basename(file, ".md")

      const { permissions, ...nativeFrontmatter } = frontmatter
      const config: AgentConfig = { ...nativeFrontmatter }

      if (!("permission" in frontmatter) && permissions !== undefined)
        config.permission = permissions

      if (config.permission?.skill === "allow") {
        const resolvedRoot = realpathSync(installRoot)
        if (/[*?]/.test(resolvedRoot) || (process.platform !== "win32" && resolvedRoot.includes("\\")))
          throw new Error("Cannot safely grant a wildcard-containing install root")
        const pattern = `${resolvedRoot.replaceAll("\\", "/").replace(/\/$/, "")}/*`
        const { external_directory, ...authored } = config.permission
        const resources = typeof external_directory === "string"
          ? { "*": external_directory }
          : external_directory == null ? {} : external_directory
        if (typeof resources !== "object" || Array.isArray(resources))
          throw new Error("Invalid external_directory permission map")
        const { [pattern]: _previous, ...otherResources } = resources as Record<string, unknown>
        config.permission = { ...authored, external_directory: { ...otherResources, [pattern]: "allow" } }
      }

      config.prompt = body

      agents[name] = config
    } catch (e) {
      throw new Error(`Failed to parse ${file}: ${(e as Error).message}`)
    }
  }

  return agents
}

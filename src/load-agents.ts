import { readdirSync, readFileSync } from "node:fs"
import { resolve, basename } from "node:path"
import { parseFrontmatter } from "./parse-frontmatter"

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

export type ResourceLoadErrorHandler = (file: string, error: Error) => void

/**
 * Load all agent markdown files from the given directory.
 * Returns a Record<string, AgentConfig> keyed by agent name (filename without .md).
 */
export function loadAgents(
  agentDir: string,
  onError?: ResourceLoadErrorHandler,
): Record<string, AgentConfig> {
  const agents: Record<string, AgentConfig> = {}

  const files = readdirSync(agentDir).filter((f) => f.endsWith(".md"))

  for (const file of files) {
    const filePath = resolve(agentDir, file)
    try {
      const content = readFileSync(filePath, "utf-8")
      const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content)

      const name = basename(file, ".md")

      const { permissions, ...nativeFrontmatter } = frontmatter
      const config: AgentConfig = { ...nativeFrontmatter }

      if (!("permission" in frontmatter) && permissions !== undefined)
        config.permission = permissions

      config.prompt = body

      agents[name] = config
    } catch (e) {
      const error = new Error(`Failed to load ${file}: ${(e as Error).message}`)
      if (!onError) throw error
      onError(file, error)
    }
  }

  return agents
}

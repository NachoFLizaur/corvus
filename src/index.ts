import { resolve } from "node:path"
import { existsSync } from "node:fs"
import type { Plugin } from "@opencode-ai/plugin"
import { loadAgents } from "./load-agents"
import { loadCommands } from "./load-commands"

/**
 * Extended config type that includes the `skills` field.
 *
 * The `skills` property exists at runtime and in newer SDK versions,
 * but may be absent from the installed SDK type definitions.
 * This interface bridges that gap without requiring a specific SDK version.
 */
interface ConfigWithSkills {
  skills?: {
    paths?: string[]
  }
}

/**
 * Corvus AI plugin for OpenCode.
 *
 * Registers agents, commands, and skills from the corvus package
 * into OpenCode's configuration via the config hook.
 */
const plugin: Plugin = async (_input) => {
  // Package root is one level up from src/ (dev) or dist/ (built)
  const root = resolve(import.meta.dir, "..")

  return {
    config: async (config) => {
      // Load and register agents
      const agentDir = resolve(root, "agent")
      if (existsSync(agentDir)) {
        const agents = loadAgents(agentDir)
        if (!config.agent) {
          config.agent = {}
        }
        for (const [name, agentConfig] of Object.entries(agents)) {
          config.agent[name] = agentConfig
        }
      }

      // Load and register commands
      const commandDir = resolve(root, "command")
      if (existsSync(commandDir)) {
        const commands = loadCommands(commandDir)
        if (!config.command) {
          config.command = {}
        }
        for (const [name, commandConfig] of Object.entries(commands)) {
          config.command[name] = commandConfig
        }
      }

      // Register skill directory
      // Cast needed: `skills` exists at runtime but may be absent from older SDK types
      const cfg = config as typeof config & ConfigWithSkills
      const skillDir = resolve(root, "skill")
      if (existsSync(skillDir)) {
        if (!cfg.skills) {
          cfg.skills = { paths: [] }
        }
        if (!cfg.skills.paths) {
          cfg.skills.paths = []
        }
        cfg.skills.paths.push(skillDir)
      }

      // Register web-research MCP server (always enabled, no API key required)
      if (!config.mcp) {
        config.mcp = {}
      }
      config.mcp["web-research"] = {
        type: "local",
        command: ["npx", "-y", "web-research-mcp"],
        enabled: true,
      }
    },
  }
}

export default plugin

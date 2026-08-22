import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { PluginContext } from "@opencode-ai/plugin/v2/promise"
import { loadAgents } from "../load-agents"
import { loadCommands } from "../load-commands"
import { PLUGIN_ID, registerAgents, registerCommands, registerSkills, warnResource } from "./register"

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..")
}

async function setup(ctx: PluginContext): Promise<void> {
  const root = packageRoot()
  const agentDir = resolve(root, "agent")
  const commandDir = resolve(root, "command")
  const skillDir = resolve(root, "skill")

  if (existsSync(agentDir)) {
    const agents = loadAgents(agentDir, (file, error) => warnResource("agent", file, error))
    await ctx.agent.transform((draft) => registerAgents(draft, agents))
  }

  if (existsSync(commandDir)) {
    const commands = loadCommands(commandDir, (file, error) => warnResource("command", file, error))
    await ctx.command.transform((draft) => registerCommands(draft, commands))
  }

  if (existsSync(skillDir)) {
    await ctx.skill.transform((draft) => registerSkills(draft, skillDir))
  }
}

export default { id: PLUGIN_ID, setup }

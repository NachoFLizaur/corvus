import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { PluginContext } from "@opencode-ai/plugin/v2/promise"
import { createLegacyPlugin } from "../index"
import { loadAgents } from "../load-agents"
import { loadCommands } from "../load-commands"
import { PLUGIN_ID, registerAgents, registerCommands, registerSkills, warnResource } from "./register"

interface RuntimeSessionContext {
  prompt(input: Record<string, unknown> & {
    sessionID: string
    text: string
    delivery: "steer" | "queue"
  }): Promise<unknown>
}

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
    // The installed beta type package still describes the legacy mutable
    // CommandDraft, while current OpenCode exposes add-only executable
    // commands plus ctx.session. Widen structurally at this compatibility seam.
    const session = (ctx as PluginContext & { session?: RuntimeSessionContext }).session
    await ctx.command.transform((draft) => registerCommands(
      draft,
      commands,
      session
        ? async (input) => {
            await session.prompt(input)
          }
        : undefined,
    ))
  }

  if (existsSync(skillDir)) {
    await ctx.skill.transform((draft) => registerSkills(draft, skillDir))
  }
}

// Universal entrypoint: OpenCode 2 calls setup(), while OpenCode 1 treats
// server() as the legacy plugin factory. Keeping both on one default export
// lets the same configured path work in either runtime without duplicate
// plugin declarations or version-specific symlinks.
export default { id: PLUGIN_ID, setup, server: createLegacyPlugin(packageRoot()) }

import { existsSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  AgentDraft,
  CommandDraft,
  PluginContext,
  SkillDraft,
} from "@opencode-ai/plugin/v2/promise"
import type { SkillV2Info } from "@opencode-ai/sdk/v2/types"
import { loadAgents } from "../load-agents"
import { loadCommands } from "../load-commands"
import { convertAgent, convertCommand, type LegacyAgentConfig, type LegacyCommandConfig } from "./convert"
import { loadSkills, type RegistrySkillInfo } from "./load-skills"

const PLUGIN_ID = "corvus-ai"

export interface DirectSkillDraft {
  list(): readonly RegistrySkillInfo[]
  add(skill: RegistrySkillInfo): void
  update(id: string, update: (skill: SkillV2Info) => void): void
  remove(id: string): void
}

function isDirectSkillDraft(draft: SkillDraft | DirectSkillDraft): draft is DirectSkillDraft {
  return (
    "add" in draft && typeof draft.add === "function" &&
    "update" in draft && typeof draft.update === "function" &&
    "remove" in draft && typeof draft.remove === "function"
  )
}

function warnResource(kind: string, id: string, error: unknown): void {
  console.warn(`${PLUGIN_ID}: failed to register ${kind} ${id}:`, error)
}

function isInside(directory: string, path: string): boolean {
  const pathFromDirectory = relative(directory, path)
  return pathFromDirectory !== "" && !pathFromDirectory.startsWith("..") && !isAbsolute(pathFromDirectory)
}

export function syncDirectSkills(
  draft: DirectSkillDraft,
  skillDir: string,
  skills: readonly RegistrySkillInfo[],
): void {
  const packagedIds = new Set(skills.map((skill) => skill.id))
  const existing = new Map(draft.list().map((skill) => [skill.id, skill]))

  for (const skill of existing.values()) {
    if (isInside(skillDir, skill.location) && !packagedIds.has(skill.id)) {
      try {
        draft.remove(skill.id)
      } catch (error) {
        warnResource("skill", skill.id, error)
      }
    }
  }

  for (const skill of skills) {
    const current = existing.get(skill.id)
    try {
      if (!current) {
        draft.add(skill)
      } else if (current.location === skill.location || isInside(skillDir, current.location)) {
        draft.update(skill.id, (target) => {
          target.name = skill.name
          target.location = skill.location
          target.content = skill.content
          if (skill.description === undefined) delete target.description
          else target.description = skill.description
          if (skill.slash === undefined) delete target.slash
          else target.slash = skill.slash
        })
      } else {
        console.warn(`${PLUGIN_ID}: skipped skill ${skill.id}; the id is already owned by ${current.location}`)
      }
    } catch (error) {
      warnResource("skill", skill.id, error)
    }
  }
}

export function registerAgents(
  draft: AgentDraft,
  agents: Record<string, LegacyAgentConfig>,
): void {
  for (const [id, legacy] of Object.entries(agents)) {
    try {
      const converted = convertAgent(id, legacy)
      draft.update(id, (agent) => Object.assign(agent, converted))
    } catch (error) {
      warnResource("agent", id, error)
    }
  }
}

export function registerCommands(
  draft: CommandDraft,
  commands: Record<string, LegacyCommandConfig>,
): void {
  for (const [name, legacy] of Object.entries(commands)) {
    try {
      const converted = convertCommand(name, legacy)
      draft.update(name, (command) => Object.assign(command, converted))
    } catch (error) {
      warnResource("command", name, error)
    }
  }
}

export function registerSkills(
  draft: SkillDraft | DirectSkillDraft,
  skillDir: string,
): void {
  if ("source" in draft && typeof draft.source === "function") {
    const alreadyRegistered = draft.list().some(
      (source) => source.type === "directory" && source.path === skillDir,
    )
    if (alreadyRegistered) return
    try {
      draft.source({ type: "directory", path: skillDir })
    } catch (error) {
      warnResource("skill source", skillDir, error)
    }
    return
  }

  if (isDirectSkillDraft(draft)) {
    const skills = loadSkills(skillDir, (file, error) => warnResource("skill", file, error))
    syncDirectSkills(draft, skillDir, skills)
    return
  }

  console.warn(`${PLUGIN_ID}: this OpenCode build cannot register plugin skills`)
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
    await ctx.command.transform((draft) => registerCommands(draft, commands))
  }

  if (existsSync(skillDir)) {
    await ctx.skill.transform((draft) => registerSkills(draft, skillDir))
  }
}

export default { id: PLUGIN_ID, setup }

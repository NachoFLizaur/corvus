import type {
  AgentV2Info,
  CommandV2Info,
  ModelRef,
  PermissionV2Effect,
  PermissionV2Ruleset,
} from "@opencode-ai/sdk/v2/types"

export interface LegacyAgentConfig {
  description?: string
  mode?: "primary" | "subagent" | "all"
  prompt?: string
  temperature?: number
  permission?: Record<string, unknown>
  color?: string
}

export interface LegacyCommandConfig {
  template: string
  description?: string
  agent?: string
  model?: string
  subtask?: boolean
}

const ACTION_RENAMES: Record<string, string> = {
  bash: "shell",
  task: "subagent",
}

function permissionEffect(value: unknown, action: string, resource: string): PermissionV2Effect {
  if (value === "allow" || value === "deny" || value === "ask") return value
  throw new Error(`Invalid permission effect for ${action}:${resource}: ${String(value)}`)
}

/** Convert V1's nested permission object into V2's ordered rule list. */
export function convertPermissions(permission?: Record<string, unknown>): PermissionV2Ruleset {
  if (!permission) return []

  const rules: PermissionV2Ruleset = []
  for (const [legacyAction, value] of Object.entries(permission)) {
    const action = ACTION_RENAMES[legacyAction] ?? legacyAction
    if (typeof value === "string") {
      rules.push({ action, resource: "*", effect: permissionEffect(value, action, "*") })
      continue
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Invalid permission rules for ${legacyAction}`)
    }

    for (const [resource, effect] of Object.entries(value)) {
      rules.push({ action, resource, effect: permissionEffect(effect, action, resource) })
    }
  }
  return rules
}

export function parseModelRef(value: string): ModelRef {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`Model must use provider/model syntax: ${value}`)
  }

  const providerID = value.slice(0, slash)
  const modelAndVariant = value.slice(slash + 1)
  const hash = modelAndVariant.lastIndexOf("#")
  if (hash < 0) return { providerID, id: modelAndVariant }
  return {
    providerID,
    id: modelAndVariant.slice(0, hash),
    variant: modelAndVariant.slice(hash + 1),
  }
}

export function convertAgent(id: string, agent: LegacyAgentConfig): AgentV2Info {
  // OpenCode 2's current runtime requires request.settings even though the
  // published SDK type has not caught up yet. Keep it on a separately inferred
  // object so TypeScript permits the forward-compatible field.
  const request = {
    settings: {},
    headers: {},
    body: agent.temperature === undefined ? {} : { temperature: agent.temperature },
  }

  return {
    id,
    request,
    system: agent.prompt,
    description: agent.description,
    mode: agent.mode ?? "all",
    hidden: false,
    color: agent.color,
    permissions: convertPermissions(agent.permission),
  }
}

export function convertCommand(name: string, command: LegacyCommandConfig): CommandV2Info {
  return {
    name,
    template: command.template,
    ...(command.description === undefined ? {} : { description: command.description }),
    ...(command.agent === undefined ? {} : { agent: command.agent }),
    ...(command.model === undefined ? {} : { model: parseModelRef(command.model) }),
    ...(command.subtask === undefined ? {} : { subtask: command.subtask }),
  }
}

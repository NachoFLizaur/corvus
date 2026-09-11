import { existsSync } from "node:fs"
import type { Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import { agentDir, commandDir, skillDir } from "./paths"
import { loadAgents } from "./load-agents"
import { loadCommands } from "./load-commands"
import { resolveOutputBudget } from "./output-budget"
import { createReviewToolExecutors } from "./review-payload"

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

type PlainObject = Record<string, unknown>

// Kept in a separate module: the opencode plugin loader rejects any
// non-function export on this entry module (see src/protected-agents.ts).
import { PROTECTED_AGENTS, PROTECTED_AGENT_KEYS } from "./protected-agents"

const isPlainObject = (value: unknown): value is PlainObject => {
  if (value === null || typeof value !== "object") return false

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const mergePlainObjects = (
  defaults: PlainObject,
  user: PlainObject,
): PlainObject =>
  Object.entries(user).reduce<PlainObject>((merged, [key, userValue]) => {
    if (userValue === undefined) return merged

    const defaultValue = defaults[key]
    const value =
      isPlainObject(defaultValue) && isPlainObject(userValue)
        ? mergePlainObjects(defaultValue, userValue)
        : userValue

    return { ...merged, [key]: value }
  }, { ...defaults })

/**
 * Deep-replace (never merge) the plugin's protected keys onto a merged agent,
 * so user config cannot inject even one widened sub-key under `permission`.
 */
const enforceProtectedKeys = (
  pluginAgent: PlainObject,
  mergedAgent: PlainObject,
): PlainObject =>
  PROTECTED_AGENT_KEYS.reduce<PlainObject>((agent, key) => {
    const { [key]: _dropped, ...rest } = agent
    return pluginAgent[key] === undefined
      ? rest
      : { ...rest, [key]: pluginAgent[key] }
  }, mergedAgent)

/**
 * After the general user-wins merge, re-assert the plugin's `permission` and
 * `prompt` for each protected agent present in the plugin's agent set.
 * Non-protected agents and non-protected keys are left untouched.
 */
const enforceProtectedAgents = (
  pluginAgents: PlainObject,
  merged: PlainObject,
): PlainObject =>
  PROTECTED_AGENTS.reduce<PlainObject>((result, name) => {
    const pluginAgent = pluginAgents[name]
    if (!isPlainObject(pluginAgent)) return result

    // A non-object user override cannot carry the guaranteed permission
    // block, so fall back to the plugin definition wholesale.
    const mergedAgent = result[name]
    const base = isPlainObject(mergedAgent) ? mergedAgent : { ...pluginAgent }

    return { ...result, [name]: enforceProtectedKeys(pluginAgent, base) }
  }, merged)

/**
 * Corvus AI plugin for OpenCode.
 *
 * Registers agents, commands, and skills from the corvus package
 * into OpenCode's configuration via the config hook.
 */
const plugin: Plugin = async (input) => {
  const review = createReviewToolExecutors(input.directory || input.worktree)
  const corvusAgents = new Set(existsSync(agentDir) ? Object.keys(loadAgents(agentDir)) : [])
  return {
    /**
     * Scope oracle: packaged names read at plugin initialization, never user config.
     * Read the hook-visible budget before mutation; non-Corvus agents and defined
     * values bypass this default. v1 normally seeds the value, so this is a no-op;
     * only an unset value uses resolveOutputBudget's limit/fallback rule.
     */
    "chat.params": async (input, output) => {
      if (!corvusAgents.has(input.agent) || output.maxOutputTokens !== undefined) return
      const budget = resolveOutputBudget({ current: output.maxOutputTokens, modelLimit: input.model.limit.output })
      if (budget !== undefined) output.maxOutputTokens = budget
    },
    tool: {
      corvus_review_payload: {
        description: "Measure or freeze a review candidate under .corvus/reviews. Paths are relative to the session directory or absolute; freeze requires artifactPath.",
        args: {
          op: z.enum(["measure", "freeze"]),
          candidatePath: z.string().min(1),
          artifactPath: z.string().min(1).optional(),
        },
        execute: async (args) => review.payload(args),
      },
      corvus_review_verify: {
        description: "Verify a frozen review artifact and its expected SHA-256 under .corvus/reviews without writing. Paths are session-relative or absolute.",
        args: {
          op: z.literal("verify"),
          artifactPath: z.string().min(1),
          expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
        },
        execute: async (args) => review.verify(args),
      },
    },
    config: async (config) => {
      // Load and register agents
      if (existsSync(agentDir)) {
        const agents = loadAgents(agentDir)
        const existingAgents = config.agent
        const merged = mergePlainObjects(
          agents,
          (existingAgents ?? {}) as PlainObject,
        )
        config.agent = enforceProtectedAgents(
          agents,
          merged,
        ) as NonNullable<typeof config.agent>
      }

      // Load and register commands
      if (existsSync(commandDir)) {
        const commands = loadCommands(commandDir)
        const existingCommands = config.command
        config.command = mergePlainObjects(
          commands,
          (existingCommands ?? {}) as PlainObject,
        ) as NonNullable<typeof config.command>
      }

      // Register skill directory
      // Cast needed: `skills` exists at runtime but may be absent from older SDK types
      const cfg = config as typeof config & ConfigWithSkills
      if (existsSync(skillDir)) {
        if (!cfg.skills) {
          cfg.skills = { paths: [] }
        }
        if (!cfg.skills.paths) {
          cfg.skills.paths = []
        }
        if (!cfg.skills.paths.includes(skillDir)) {
          cfg.skills.paths.push(skillDir)
        }
      }

      // Register the default MCP only when the user has not configured it
      if (!config.mcp) {
        config.mcp = {}
      }
      if (!Object.prototype.hasOwnProperty.call(config.mcp, "web-research")) {
        config.mcp["web-research"] = {
          type: "local",
          command: ["npx", "-y", "web-research-mcp@0.1.0"],
          enabled: true,
        }
      }
    },
  }
}

export default plugin

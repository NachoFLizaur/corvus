import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type {
  AgentDraft,
  CommandDraft,
  PluginContext,
  SkillDraft,
} from "@opencode-ai/plugin/v2/promise"
import type { AgentV2Info, CommandV2Info, SkillV2Info, SkillV2Source } from "@opencode-ai/sdk/v2/types"
import { loadAgents } from "../load-agents"
import plugin from "../v2"
import {
  registerAgents,
  registerCommands,
  registerSkills,
  type DirectSkillDraft,
} from "../v2/register"
import {
  convertAgent,
  convertCommand,
  convertPermissions,
  parseModelRef,
} from "../v2/convert"

type DirectSkillInfo = SkillV2Info & { id: string }

function registration() {
  return { dispose: async () => {} }
}

function createAgentDraft(
  agents: Map<string, AgentV2Info>,
  failAgent?: string,
): AgentDraft {
  const agentDraft: AgentDraft = {
    list: () => [...agents.values()],
    get: (id) => agents.get(id),
    default: () => {},
    update: (id, update) => {
      if (id === failAgent) throw new Error("synthetic registration failure")
      // Like the real runtime, update() mutates an existing entry in place.
      const agent: AgentV2Info = agents.get(id) ?? {
        id,
        request: { headers: {}, body: {} },
        mode: "all",
        hidden: false,
        permissions: [],
      }
      update(agent)
      agents.set(id, agent)
    },
    remove: (id) => {
      agents.delete(id)
    },
  }
  return agentDraft
}

function createCommandDraft(commands: Map<string, CommandV2Info>): CommandDraft {
  const commandDraft: CommandDraft = {
    list: () => [...commands.values()],
    get: (name) => commands.get(name),
    update: (name, update) => {
      // Like the real runtime, update() mutates an existing entry in place.
      const command: CommandV2Info = commands.get(name) ?? { name, template: "" }
      update(command)
      commands.set(name, command)
    },
    remove: (name) => {
      commands.delete(name)
    },
  }
  return commandDraft
}

function createPluginContext(options: {
  agents: Map<string, AgentV2Info>
  commands: Map<string, CommandV2Info>
  skillDraft: SkillDraft
}): PluginContext {
  return {
    options: {},
    agent: {
      transform: async (callback) => {
        await callback(createAgentDraft(options.agents))
        return registration()
      },
    },
    aisdk: {
      sdk: async () => registration(),
      language: async () => registration(),
    },
    catalog: {
      transform: async () => registration(),
    },
    command: {
      transform: async (callback) => {
        await callback(createCommandDraft(options.commands))
        return registration()
      },
    },
    integration: {
      transform: async () => registration(),
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
    plugin: {
      add: async () => {},
      remove: async () => {},
    },
    reference: {
      transform: async () => registration(),
    },
    skill: {
      transform: async (callback) => {
        await callback(options.skillDraft)
        return registration()
      },
    },
  }
}

describe("V2 conversion", () => {
  test("converts nested V1 permissions in source order and renames actions", () => {
    expect(
      convertPermissions({
        "*": "deny",
        read: "allow",
        task: "allow",
        bash: { "*": "allow", "git push --force": "deny" },
      }),
    ).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "shell", resource: "git push --force", effect: "deny" },
    ])
  })

  test("rejects invalid permission effects instead of silently weakening policy", () => {
    expect(() => convertPermissions({ bash: { "*": "sometimes" } })).toThrow(
      "Invalid permission effect",
    )
  })

  test("maps prompt, temperature, metadata, and permissions to an AgentV2Info", () => {
    expect(
      convertAgent("reviewer", {
        description: "Review changes",
        mode: "subagent",
        prompt: "Review carefully",
        temperature: 0.1,
        color: "#123456",
        permission: { task: "deny" },
      }),
    ).toEqual({
      id: "reviewer",
      request: { settings: {}, headers: {}, body: { temperature: 0.1 } },
      system: "Review carefully",
      description: "Review changes",
      mode: "subagent",
      hidden: false,
      color: "#123456",
      permissions: [{ action: "subagent", resource: "*", effect: "deny" }],
    })
  })

  test("parses provider/model and optional variant", () => {
    expect(parseModelRef("anthropic/claude-sonnet-4-5#high")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
      variant: "high",
    })
  })

  test("maps commands to the V2 shape", () => {
    expect(
      convertCommand("review", {
        template: "Review $ARGUMENTS",
        description: "Review changes",
        agent: "reviewer",
        model: "anthropic/claude-sonnet-4-5#high",
        subtask: true,
      }),
    ).toEqual({
      name: "review",
      template: "Review $ARGUMENTS",
      description: "Review changes",
      agent: "reviewer",
      model: { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "high" },
      subtask: true,
    })
  })

  test("omits absent optional command fields", () => {
    expect(convertCommand("review", { template: "Review $ARGUMENTS" })).toEqual({
      name: "review",
      template: "Review $ARGUMENTS",
    })
  })

  test("rejects an agent mode outside the V2 union", () => {
    expect(() => convertAgent("reviewer", { mode: "sometimes" as never })).toThrow(
      'Invalid mode for agent reviewer: "sometimes"',
    )
  })

  test("rejects a non-finite agent temperature", () => {
    expect(() => convertAgent("reviewer", { temperature: Number.NaN })).toThrow(
      "Invalid temperature for agent reviewer",
    )
    expect(() => convertAgent("reviewer", { temperature: "hot" as never })).toThrow(
      'Invalid temperature for agent reviewer: "hot"',
    )
  })

  test("rejects a command without a string template", () => {
    expect(() => convertCommand("review", {} as never)).toThrow(
      "Invalid template for command review",
    )
    expect(() => convertCommand("review", { template: 42 as never })).toThrow(
      "Invalid template for command review: 42",
    )
  })

  test("rejects a non-boolean command subtask", () => {
    expect(() => convertCommand("review", { template: "t", subtask: "yes" as never })).toThrow(
      'Invalid subtask for command review: "yes"',
    )
  })
})

describe("V2 plugin", () => {
  test("exports the V2 object contract and registers every package resource", async () => {
    const agents = new Map<string, AgentV2Info>()
    const commands = new Map<string, CommandV2Info>()
    const skills: SkillV2Source[] = []
    const skillDraft: SkillDraft = {
      source: (source) => skills.push(source),
      list: () => skills,
    }

    expect(plugin.id).toBe("corvus-ai")
    expect(typeof plugin.setup).toBe("function")
    const context = createPluginContext({ agents, commands, skillDraft })
    await plugin.setup(context)
    await plugin.setup(context)

    expect(agents.size).toBe(16)
    expect(commands.size).toBe(4)
    // Re-registering the plugin keeps the typed source list idempotent.
    expect(skills).toHaveLength(1)
    expect(skills[0]).toEqual({ type: "directory", path: expect.stringMatching(/\/skill$/) })
    expect(agents.get("corvus")?.permissions).toContainEqual({
      action: "subagent",
      resource: "*",
      effect: "allow",
    })
    expect(agents.get("corvus")?.permissions).toContainEqual({
      action: "shell",
      resource: "rm -rf *",
      effect: "deny",
    })
  })

  test("registers packaged skills with beta runtimes that expose the direct registry", async () => {
    const root = resolve(import.meta.dir, "../..")
    const packagedSkillDir = resolve(root, "skill")
    const skills = new Map<string, DirectSkillInfo>([
      ["corvus-extras", {
        id: "corvus-extras",
        name: "stale",
        description: "stale description",
        slash: true,
        location: resolve(packagedSkillDir, "corvus-extras/SKILL.md"),
        content: "stale",
      }],
      ["removed-skill", {
        id: "removed-skill",
        name: "removed-skill",
        location: resolve(packagedSkillDir, "removed-skill/SKILL.md"),
        content: "stale",
      }],
      ["builtin", {
        id: "builtin",
        name: "Builtin",
        location: "/builtin/skill.md",
        content: "builtin",
      }],
    ])
    const directSkillDraft: DirectSkillDraft = {
      list: () => [...skills.values()],
      add: (skill) => {
        if (skills.has(skill.id)) throw new Error(`duplicate skill ${skill.id}`)
        skills.set(skill.id, skill)
      },
      update: (id, update) => {
        const skill = skills.get(id)
        if (!skill) return
        update(skill)
      },
      remove: (id) => {
        skills.delete(id)
      },
    }
    registerSkills(directSkillDraft, packagedSkillDir)
    expect([...skills.values()].filter((skill) => skill.location.startsWith(packagedSkillDir))).toHaveLength(18)
    expect(skills.get("corvus-extras")).toMatchObject({
      id: "corvus-extras",
      name: "corvus-extras",
      description: "Extra utilities - subagent reference, todo patterns, error handling",
      location: expect.stringMatching(/\/corvus-extras\/SKILL\.md$/),
    })
    expect("slash" in skills.get("corvus-extras")!).toBe(false)
    expect(skills.get("corvus-extras")?.content).toStartWith("\n## SUBAGENT REFERENCE")
    expect(skills.has("removed-skill")).toBe(false)
    expect(skills.has("builtin")).toBe(true)
  })

  test("continues after one agent fails to register", async () => {
    const root = resolve(import.meta.dir, "../..")
    const agents = new Map<string, AgentV2Info>()

    registerAgents(
      createAgentDraft(agents, "code-explorer"),
      loadAgents(resolve(root, "agent")),
    )
    expect(agents.has("code-explorer")).toBe(false)
    expect(agents.size).toBe(15)
  })

  test("re-registering an agent clears optional fields the new config omits", () => {
    const agents = new Map<string, AgentV2Info>([
      ["reviewer", {
        id: "reviewer",
        request: { headers: {}, body: {} },
        mode: "all",
        hidden: false,
        permissions: [],
        model: { providerID: "anthropic", id: "stale-model" },
        steps: 5,
        description: "stale description",
        color: "#abcdef",
      }],
    ])

    registerAgents(createAgentDraft(agents), { reviewer: { prompt: "Fresh prompt" } })

    const agent = agents.get("reviewer")!
    expect(agent.system).toBe("Fresh prompt")
    expect("model" in agent).toBe(false)
    expect("steps" in agent).toBe(false)
    expect("description" in agent).toBe(false)
    expect("color" in agent).toBe(false)
  })

  test("re-registering a command clears optional fields the new config omits", () => {
    const commands = new Map<string, CommandV2Info>([
      ["review", {
        name: "review",
        template: "stale template",
        description: "stale description",
        agent: "stale-agent",
        model: { providerID: "anthropic", id: "stale-model" },
        subtask: true,
      }],
    ])

    registerCommands(createCommandDraft(commands), { review: { template: "Fresh $ARGUMENTS" } })

    const command = commands.get("review")!
    expect(command.template).toBe("Fresh $ARGUMENTS")
    expect("description" in command).toBe(false)
    expect("agent" in command).toBe(false)
    expect("model" in command).toBe(false)
    expect("subtask" in command).toBe(false)
  })
})

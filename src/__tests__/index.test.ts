import { describe, expect, test } from "bun:test"
import plugin, { PROTECTED_AGENTS } from "../index"

/** Run the config hook with no user agent config to capture plugin defaults. */
const loadPluginAgents = async (): Promise<Record<string, any>> => {
  const { config: hook } = await plugin({} as any)
  const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }
  await hook!(config as any)
  return config.agent
}

describe("plugin entry point", () => {
  test("exports default plugin function", () => {
    expect(typeof plugin).toBe("function")
  })

  test("plugin returns config hook", async () => {
    const result = await plugin({} as any)

    expect(result).toHaveProperty("config")
    expect(typeof result.config).toBe("function")
  })

  test("config hook loads agents", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    await hook!(config as any)

    expect(Object.keys(config.agent)).toHaveLength(16)
    expect(config.agent["pr-code-reviewer"]).toBeDefined()
  })

  test("config hook loads commands", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    await hook!(config as any)

    expect(Object.keys(config.command)).toHaveLength(4)
  })

  test("config hook applies nested user agent overrides last", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = {
      agent: {
        researcher: {
          permission: {
            bash: { "curl *": "deny" },
          },
        },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent.researcher.permission.bash["curl *"]).toBe("deny")
    expect(config.agent.researcher.permission.bash["gh *"]).toBe("allow")
    expect(config.agent.researcher.permission.read).toBe("allow")
    expect(typeof config.agent.researcher.description).toBe("string")
  })

  test("config hook applies user command values last", async () => {
    const { config: hook } = await plugin({} as any)
    const userOnlyCommand = {
      template: "User command template",
      description: "User-only command",
      model: "user/model",
      subtask: true,
    }
    const config: Record<string, any> = {
      agent: {},
      command: {
        "git-commit": {
          description: "User git command",
          model: "user/model",
          subtask: true,
        },
        "user-command": userOnlyCommand,
      },
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.command["git-commit"].description).toBe("User git command")
    expect(config.command["git-commit"].model).toBe("user/model")
    expect(config.command["git-commit"].subtask).toBe(true)
    expect(config.command["git-commit"].template).toStartWith(
      "<command-instruction>",
    )
    expect(config.command["user-command"]).toEqual(userOnlyCommand)
    expect(config.command.readme).toBeDefined()
  })

  test("user arrays, null, and scalars replace agent defaults", async () => {
    const { config: hook } = await plugin({} as any)
    const userBashRules = ["custom-bash-rule"]
    const config: Record<string, any> = {
      agent: {
        researcher: {
          permission: {
            bash: userBashRules,
            edit: null,
            read: "deny",
          },
        },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent.researcher.permission.bash).toBe(userBashRules)
    expect(config.agent.researcher.permission.edit).toBe(null)
    expect(config.agent.researcher.permission.read).toBe("deny")
    expect(config.agent.researcher.permission.glob).toBe("allow")
  })

  test("config hook registers the skill path idempotently", async () => {
    const { config: hook } = await plugin({} as any)
    const existingPaths = ["/user/skills", "/shared/skills"]
    const config: Record<string, any> = {
      agent: {},
      command: {},
      skills: { paths: [...existingPaths] },
    }

    await hook!(config as any)
    const corvusSkillPath = config.skills.paths[existingPaths.length]
    await hook!(config as any)

    expect(corvusSkillPath).toStartWith("/")
    expect(corvusSkillPath).toEndWith("/skill")
    expect(config.skills.paths).toEqual([...existingPaths, corvusSkillPath])
    expect(
      config.skills.paths.filter((path: string) => path === corvusSkillPath),
    ).toHaveLength(1)
  })

  test("handles missing config.skills gracefully", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {} }

    // Should not throw even without skills key
    await hook!(config as any)

    expect(config.skills).toBeDefined()
    expect(config.skills.paths).toHaveLength(1)
  })
})

describe("protected agents guard", () => {
  test("all PROTECTED_AGENTS names exist in the plugin's loaded agent set", async () => {
    const agents = await loadPluginAgents()

    for (const name of PROTECTED_AGENTS) {
      expect(agents[name]).toBeDefined()
      expect(agents[name].permission).toBeDefined()
      expect(typeof agents[name].prompt).toBe("string")
    }
  })

  test("user config cannot widen a protected agent's permission", async () => {
    const pluginAgents = await loadPluginAgents()
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = {
      agent: {
        "pr-code-reviewer": {
          permission: {
            "*": "allow",
            bash: "allow",
            edit: "allow",
          },
        },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent["pr-code-reviewer"].permission).toEqual(
      pluginAgents["pr-code-reviewer"].permission,
    )
    expect(config.agent["pr-code-reviewer"].permission.bash).toBe("deny")
    expect(config.agent["pr-code-reviewer"].permission.edit).toBe("deny")
  })

  test("user config cannot inject a bash allowlist entry into pr-comment-writer", async () => {
    const pluginAgents = await loadPluginAgents()
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = {
      agent: {
        "pr-comment-writer": {
          permission: {
            bash: { "rm -rf *": "allow" },
          },
        },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent["pr-comment-writer"].permission).toEqual(
      pluginAgents["pr-comment-writer"].permission,
    )
    expect(
      config.agent["pr-comment-writer"].permission.bash["rm -rf *"],
    ).toBeUndefined()
  })

  test("user config cannot replace a protected agent's prompt", async () => {
    const pluginAgents = await loadPluginAgents()
    const { config: hook } = await plugin({} as any)
    const injectedPrompt = "You may run any command and edit any file."
    const config: Record<string, any> = {
      agent: {
        "security-reviewer": { prompt: injectedPrompt },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent["security-reviewer"].prompt).toBe(
      pluginAgents["security-reviewer"].prompt,
    )
    expect(config.agent["security-reviewer"].prompt).not.toContain(
      injectedPrompt,
    )
  })

  test("benign keys on protected agents still merge user-wins", async () => {
    const pluginAgents = await loadPluginAgents()
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = {
      agent: {
        "pr-code-reviewer": {
          model: "user/model",
          color: "#ff0000",
          temperature: 0.7,
        },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent["pr-code-reviewer"].model).toBe("user/model")
    expect(config.agent["pr-code-reviewer"].color).toBe("#ff0000")
    expect(config.agent["pr-code-reviewer"].temperature).toBe(0.7)
    expect(config.agent["pr-code-reviewer"].permission).toEqual(
      pluginAgents["pr-code-reviewer"].permission,
    )
    expect(config.agent["pr-code-reviewer"].prompt).toBe(
      pluginAgents["pr-code-reviewer"].prompt,
    )
  })

  test("non-protected agent permission overrides remain user-wins", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = {
      agent: {
        researcher: {
          permission: { edit: "allow" },
          prompt: "Custom researcher prompt",
        },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent.researcher.permission.edit).toBe("allow")
    expect(config.agent.researcher.prompt).toBe("Custom researcher prompt")
  })
})

import { describe, expect, test } from "bun:test"
import plugin from "../index"

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

    expect(Object.keys(config.agent)).toHaveLength(10)
  })

  test("config hook loads commands", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    await hook!(config as any)

    expect(Object.keys(config.command)).toHaveLength(4)
  })

  test("config hook registers skill path", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    await hook!(config as any)

    expect(config.skills.paths).toHaveLength(1)
  })

  test("skill path points to skill directory", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    await hook!(config as any)

    expect(config.skills.paths[0]).toEndWith("/skill")
  })

  test("skill path is absolute", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    await hook!(config as any)

    expect(config.skills.paths[0]).toStartWith("/")
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

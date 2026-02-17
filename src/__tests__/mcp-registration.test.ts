import { describe, expect, test } from "bun:test"
import plugin from "../index"

describe("MCP Registration", () => {
  test("config hook sets mcp['web-research']", async () => {
    // Arrange
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    // Act
    await hook!(config as any)

    // Assert
    expect(config.mcp).toBeDefined()
    expect(config.mcp["web-research"]).toBeDefined()
  })

  test("mcp config has correct type", async () => {
    // Arrange
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    // Act
    await hook!(config as any)

    // Assert
    expect(config.mcp["web-research"].type).toBe("local")
  })

  test("mcp config has correct command", async () => {
    // Arrange
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    // Act
    await hook!(config as any)

    // Assert
    expect(config.mcp["web-research"].command).toEqual(["npx", "-y", "web-research-mcp"])
  })

  test("mcp config is enabled", async () => {
    // Arrange
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    // Act
    await hook!(config as any)

    // Assert
    expect(config.mcp["web-research"].enabled).toBe(true)
  })

  test("mcp registration works with empty config.mcp", async () => {
    // Arrange - config without mcp field
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {} }

    // Act - should not throw
    await hook!(config as any)

    // Assert
    expect(config.mcp).toBeDefined()
    expect(config.mcp["web-research"]).toBeDefined()
    expect(config.mcp["web-research"].type).toBe("local")
  })

  test("mcp registration preserves existing mcp entries", async () => {
    // Arrange - config with existing mcp entry
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = {
      agent: {},
      command: {},
      skills: { paths: [] },
      mcp: {
        "other-server": { type: "local", command: ["other"], enabled: true },
      },
    }

    // Act
    await hook!(config as any)

    // Assert - both entries should exist
    expect(config.mcp["other-server"]).toBeDefined()
    expect(config.mcp["other-server"].command).toEqual(["other"])
    expect(config.mcp["web-research"]).toBeDefined()
    expect(config.mcp["web-research"].type).toBe("local")
  })
})

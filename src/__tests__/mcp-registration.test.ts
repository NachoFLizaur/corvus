import { describe, expect, test } from "bun:test"
import plugin from "../index"

describe("MCP registration", () => {
  test("registers the pinned default when web-research is absent", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    await hook!(config as any)

    expect(config.mcp["web-research"]).toEqual({
      type: "local",
      command: ["npx", "-y", "web-research-mcp@0.1.0"],
      enabled: true,
    })
  })

  test("preserves a colliding web-research object exactly", async () => {
    const { config: hook } = await plugin({} as any)
    const customWebResearch = {
      type: "remote",
      url: "https://example.com/mcp",
      enabled: false,
      headers: { Authorization: "Bearer user-token" },
    }
    const expectedWebResearch = {
      type: "remote",
      url: "https://example.com/mcp",
      enabled: false,
      headers: { Authorization: "Bearer user-token" },
    }
    const config: Record<string, any> = {
      agent: {},
      command: {},
      skills: { paths: [] },
      mcp: { "web-research": customWebResearch },
    }

    await hook!(config as any)

    expect(config.mcp["web-research"]).toBe(customWebResearch)
    expect(config.mcp["web-research"]).toEqual(expectedWebResearch)
  })

  test("preserves other MCP entries alongside the default", async () => {
    const { config: hook } = await plugin({} as any)
    const otherServer = { type: "local", command: ["other"], enabled: true }
    const config: Record<string, any> = {
      agent: {},
      command: {},
      skills: { paths: [] },
      mcp: { "other-server": otherServer },
    }

    await hook!(config as any)

    expect(config.mcp["other-server"]).toBe(otherServer)
    expect(config.mcp["web-research"]).toBeDefined()
  })
})

import { describe, expect, test, beforeAll } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")
const DIST = resolve(ROOT, "dist")

describe("build output", () => {
  test("dist/index.js exists", () => {
    expect(existsSync(resolve(DIST, "index.js"))).toBe(true)
  })

  test("dist/index.d.ts exists", () => {
    expect(existsSync(resolve(DIST, "index.d.ts"))).toBe(true)
  })
})

describe("built plugin", () => {
  let plugin: any

  beforeAll(async () => {
    const mod = await import(resolve(DIST, "index.js"))
    plugin = mod.default
  })

  test("exports default function", () => {
    expect(typeof plugin).toBe("function")
  })

  test("config hook loads agents", async () => {
    const config = { agent: {}, command: {}, skills: { paths: [] } } as any
    const hooks = await plugin({})
    await hooks.config(config)
    expect(Object.keys(config.agent).length).toBe(10)
  })

  test("config hook loads commands", async () => {
    const config = { agent: {}, command: {}, skills: { paths: [] } } as any
    const hooks = await plugin({})
    await hooks.config(config)
    expect(Object.keys(config.command).length).toBe(4)
  })

  test("config hook registers skill path", async () => {
    const config = { agent: {}, command: {}, skills: { paths: [] } } as any
    const hooks = await plugin({})
    await hooks.config(config)
    expect(config.skills.paths.length).toBe(1)
    expect(config.skills.paths[0]).toMatch(/\/skill$/)
  })
})

describe("package.json", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"))

  test("files field covers required directories", () => {
    expect(pkg.files).toContain("dist")
    expect(pkg.files).toContain("agent")
    expect(pkg.files).toContain("command")
    expect(pkg.files).toContain("skill")
  })
})

import { describe, expect, test, beforeAll } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")
const DIST = resolve(ROOT, "dist")

beforeAll(() => {
  rmSync(DIST, { recursive: true, force: true })
  const result = Bun.spawnSync(["bun", "run", "build"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`.trim()
    throw new Error(`Build failed before artifact verification:\n${output}`)
  }
})

describe("build output", () => {
  test("dist/index.js exists", () => {
    expect(existsSync(resolve(DIST, "index.js"))).toBe(true)
  })

  test("dist/index.d.ts exists", () => {
    expect(existsSync(resolve(DIST, "index.d.ts"))).toBe(true)
  })

  test("V2 JavaScript and declarations exist", () => {
    expect(existsSync(resolve(DIST, "v2/index.js"))).toBe(true)
    expect(existsSync(resolve(DIST, "v2/index.d.ts"))).toBe(true)
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

  test("every entry-module export is a plugin function (opencode loader contract)", async () => {
    // opencode's plugin loader (getLegacyPlugins) iterates Object.values(mod)
    // over the ENTRY module and throws TypeError("Plugin export is not a
    // function") if any export is not a plugin function. A stray constant
    // export (e.g. PROTECTED_AGENTS, shipped in 0.8.0-beta.0) breaks the
    // entire plugin at load time even though the default export is valid.
    const mod = await import(resolve(DIST, "index.js"))
    const entries = Object.entries(mod)
    expect(entries.length).toBeGreaterThanOrEqual(1)
    for (const [name, value] of entries) {
      expect(`${name}:${typeof value}`).toBe(`${name}:function`)
    }
  })

  test("config hook loads agents", async () => {
    const config = { agent: {}, command: {}, skills: { paths: [] } } as any
    const hooks = await plugin({})
    await hooks.config(config)
    expect(Object.keys(config.agent).length).toBe(16)
    expect(config.agent["pr-code-reviewer"]).toBeDefined()
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

describe("built V2 plugin", () => {
  test("loads the object plugin contract", async () => {
    const mod = await import(resolve(DIST, "v2/index.js"))
    expect(mod.default.id).toBe("corvus-ai")
    expect(typeof mod.default.setup).toBe("function")
    expect(typeof mod.default.server).toBe("function")
  })

  test("universal server contract loads legacy agents from the package root", async () => {
    const mod = await import(resolve(DIST, "v2/index.js"))
    const config = { agent: {}, command: {}, skills: { paths: [] } } as any
    const hooks = await mod.default.server({})
    await hooks.config(config)

    expect(Object.keys(config.agent)).toHaveLength(16)
    expect(config.agent.corvus).toBeDefined()
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

  test("exports a separate V2 entrypoint without replacing V1", () => {
    expect(pkg.exports["."].import).toBe("./dist/index.js")
    expect(pkg.exports["./v2"].import).toBe("./dist/v2/index.js")
  })
})

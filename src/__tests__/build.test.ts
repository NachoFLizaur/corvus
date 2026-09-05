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

describe("v2 entry (dist/server.js)", () => {
  test("dist/server.js exists", () => {
    expect(existsSync(resolve(DIST, "server.js"))).toBe(true)
  })

  test("dist/server.d.ts exists", () => {
    expect(existsSync(resolve(DIST, "server.d.ts"))).toBe(true)
  })

  test("default export is an object with id \"corvus\" and a setup function", async () => {
    // opencode v2's plugin loader decodes the default export as an OBJECT
    // { id, setup } and rejects v1's default async function with
    // SchemaError: Expected object at ["default"].
    const mod = await import(resolve(DIST, "server.js"))
    const plugin = mod.default
    expect(typeof plugin).toBe("object")
    expect(typeof plugin.id).toBe("string")
    expect(plugin.id).toBe("corvus")
    expect(typeof plugin.setup).toBe("function")
  })

  test("root server.js shim re-exports the dist default unchanged", async () => {
    // Local-directory entries in the v2 `plugins` array ignore package
    // `exports` and probe <dir>/server.* on disk, so the committed root shim
    // must resolve to the very same plugin object as the dist artifact.
    const shim = await import(resolve(ROOT, "server.js"))
    const dist = await import(resolve(DIST, "server.js"))
    expect(shim.default).toBe(dist.default)
  })

  test("carries no runtime @opencode-ai import (v1 hosts lack the v2 SDK)", () => {
    // The v2 SDK must stay a type-only dependency: a value import would make
    // the beta SDK a runtime requirement and break v1 hosts that never ship it.
    const source = readFileSync(resolve(DIST, "server.js"), "utf-8")
    expect(source).not.toContain("@opencode-ai")
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

  test("files field ships the root server.js shim", () => {
    expect(pkg.files).toContain("server.js")
  })

  test("exports[\"./server\"] declares types, import and default in that order", () => {
    // Condition order is significant: `types` must precede the runtime
    // conditions so type resolution wins before `import`/`default` match.
    const subpath = pkg.exports["./server"]
    expect(Object.keys(subpath)).toEqual(["types", "import", "default"])
    expect(subpath.types).toBe("./dist/server.d.ts")
    expect(subpath.import).toBe("./dist/server.js")
    expect(subpath.default).toBe("./dist/server.js")
  })

  test("v2 SDK devDependency alias is pinned to the exact beta version", () => {
    // Exact-string pin: beta SDK types churn between prereleases, and the
    // target host is opencode2 v0.0.0-beta-19086 specifically.
    expect(pkg.devDependencies["@opencode-ai/plugin-v2"]).toBe(
      "npm:@opencode-ai/plugin@0.0.0-beta-19086",
    )
  })
})

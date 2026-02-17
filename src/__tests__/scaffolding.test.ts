import { describe, expect, test } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")
const readJSON = (name: string) =>
  JSON.parse(readFileSync(resolve(ROOT, name), "utf-8"))

describe("package.json", () => {
  const pkg = readJSON("package.json")

  test("has correct name", () => {
    expect(pkg.name).toBe("corvus-ai")
  })

  test("has correct exports", () => {
    expect(pkg.exports["."]).toEqual({
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    })
  })

  test("files includes agent dir", () => {
    expect(pkg.files).toContain("agent")
  })

  test("files includes command dir", () => {
    expect(pkg.files).toContain("command")
  })

  test("files includes skill dir", () => {
    expect(pkg.files).toContain("skill")
  })

  test("has js-yaml dependency", () => {
    expect(pkg.dependencies["js-yaml"]).toBeDefined()
  })

  test("has opencode-plugin peer dependency", () => {
    expect(pkg.peerDependencies["@opencode-ai/plugin"]).toBeDefined()
  })
})

describe("tsconfig.json", () => {
  const tsconfig = readJSON("tsconfig.json")

  test("has strict mode enabled", () => {
    expect(tsconfig.compilerOptions.strict).toBe(true)
  })

  test("has declaration enabled", () => {
    expect(tsconfig.compilerOptions.declaration).toBe(true)
  })
})

describe("project structure", () => {
  test("src/index.ts exists", () => {
    expect(existsSync(resolve(ROOT, "src/index.ts"))).toBe(true)
  })
})

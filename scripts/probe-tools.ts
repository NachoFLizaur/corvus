import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import { createFakeContext } from "../src/__tests__/fake-context"

/**
 * Review-tool registration and function probe for BOTH hosts, against the BUILT
 * bundles of an install root (default: this repo).
 *
 * WHY NOT THE HOST API: the v2 protocol lists commands, skills, MCP servers and
 * plugins (`v2.command.list`, `v2.skill.list`, `v2.mcp.list`, `v2.plugin.list`)
 * but has no tool group, and `opencode2 debug` exposes only agents/config/paths.
 * There is no non-interactive host oracle for "which tools did a plugin add", so
 * this probe instantiates `dist/server.js`'s `setup()` with the same host double
 * the registration tests use, and `dist/index.js`'s v1 hook function, then
 * asserts both tool names on both hosts. Every assertion throws; no flag bypasses.
 *
 * FUNCTIONAL LEG: in a throwaway workspace the probe writes a valid candidate
 * under `.corvus/reviews/probe/`, then drives measure → freeze → verify through
 * the registered executors, checks the SHA-256 roundtrip against an independent
 * digest of the artifact bytes, and confirms an over-limit body yields a
 * `limit-exceeded` violation naming its unit.
 */

const TOOLS = ["corvus_review_payload", "corvus_review_verify"] as const
const LIMIT_BODY = 24000

const messages: string[] = []
const check = (ok: boolean, message: string): void => {
  if (!ok) throw new Error(message)
  messages.push(`OK: ${message}`)
}
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const parse = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string") throw new Error(`tool returned ${typeof value}, expected JSON string`)
  return JSON.parse(value) as Record<string, unknown>
}

type Call = (name: (typeof TOOLS)[number], args: Record<string, unknown>) => Promise<Record<string, unknown>>

/**
 * The built tools' registered JSON schemas (v1 after Zod conversion) are the
 * oracle, checked before each host's functional probe writes candidate files.
 * A missing object schema or root combinator aborts the gate for either host;
 * nested schemas are not restricted here, and no flag disables this check.
 */
function checkToolSchema(host: string, name: string, schema: unknown): void {
  check(schema !== null && typeof schema === "object" && !Array.isArray(schema)
    && "type" in schema && schema.type === "object", `${host}: ${name} input schema is an object`)
  for (const combinator of ["oneOf", "anyOf", "allOf"]) {
    check(!Object.hasOwn(schema as object, combinator), `${host}: ${name} input schema has no top-level ${combinator}`)
  }
}

async function functionalProbe(host: string, workspace: string, call: Call): Promise<void> {
  const relative = ".corvus/reviews/probe"
  const dir = join(workspace, relative)
  mkdirSync(dir, { recursive: true })
  const candidate = {
    commit_id: "a".repeat(40),
    event: "COMMENT",
    body: "Probe review body — naïve ✓ 😀",
    comments: [{ path: "src/example.ts", line: 3, side: "RIGHT", body: "Inline probe comment" }],
  }
  const candidatePath = `${relative}/candidate.json`
  const artifactPath = `${relative}/post-request.json`
  writeFileSync(join(workspace, candidatePath), JSON.stringify(candidate))

  const measured = await call("corvus_review_payload", { op: "measure", candidatePath })
  check(measured.ok === true, `${host}: measure ok (${JSON.stringify(measured.measurements)})`)
  check(!("canonical" in measured), `${host}: measure result carries no review text`)

  const frozen = await call("corvus_review_payload", { op: "freeze", candidatePath, artifactPath })
  check(frozen.ok === true && typeof frozen.sha256 === "string", `${host}: freeze ok, sha256=${String(frozen.sha256)}`)
  const bytes = readFileSync(join(workspace, artifactPath))
  check(sha256(bytes) === frozen.sha256, `${host}: independent SHA-256 of artifact bytes equals freeze digest`)
  check(bytes[bytes.length - 1] === 0x0a && !bytes.includes(0x0d), `${host}: artifact ends with LF and has no CR`)
  check(bytes.toString("utf8") === JSON.stringify(candidate, null, 2) + "\n", `${host}: artifact is canonical 2-space JSON`)

  const verified = await call("corvus_review_verify", { op: "verify", artifactPath, expectedSha256: frozen.sha256 as string })
  check(verified.ok === true && verified.sha256Match === true && verified.canonical === true, `${host}: verify ok (sha256 roundtrip)`)

  const tampered = await call("corvus_review_verify", { op: "verify", artifactPath, expectedSha256: "0".repeat(64) })
  check(tampered.ok === false && tampered.reason === "sha256-mismatch", `${host}: wrong digest → sha256-mismatch`)

  const overPath = `${relative}/over-limit.json`
  writeFileSync(join(workspace, overPath), JSON.stringify({ ...candidate, body: "x".repeat(LIMIT_BODY + 1) }))
  const over = await call("corvus_review_payload", { op: "measure", candidatePath: overPath })
  const violations = over.violations as Array<{ field: string; unit: string; limit: number; actual: number; reason: string }>
  check(over.ok === false && Array.isArray(violations) && violations.length === 2
    && violations.every(v => v.field === "body" && v.reason === "limit-exceeded" && v.limit === LIMIT_BODY && v.actual === LIMIT_BODY + 1)
    && violations.map(v => v.unit).sort().join(",") === "codePoints,utf8Bytes",
  `${host}: over-limit body → violation on body (${violations?.map(v => v.unit).join(", ")})`)

  const escaped = await call("corvus_review_payload", { op: "measure", candidatePath: `${relative}/../../../escape.json` })
  check(escaped.ok === false && escaped.reason === "path-outside-root", `${host}: traversal outside .corvus/reviews → path-outside-root`)
}

export async function probeTools(installRoot: string): Promise<string[]> {
  messages.length = 0
  const root = realpathSync(installRoot)
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "corvus-probe-tools-")))
  try {
    // v2 host: dist/server.js default { id, setup } through the host double.
    const { default: server } = await import(resolve(root, "dist/server.js"))
    check(typeof server === "object" && server?.id === "corvus" && typeof server.setup === "function",
      "dist/server.js default export is { id: 'corvus', setup }")
    const fake = createFakeContext(workspace)
    const cleanup = await server.setup(fake.ctx)
    check(fake.registrations.filter(r => r.kind === "tool.transform").length === 1, "v2: exactly one tool.transform registered")
    check([...fake.tools.keys()].sort().join(",") === TOOLS.join(","), `v2: tools registered: ${[...fake.tools.keys()].join(", ")}`)
    for (const name of TOOLS) {
      const tool = fake.tools.get(name)!
      check(JSON.stringify(tool.options) === JSON.stringify({ codemode: false }), `v2: ${name} options codemode:false`)
      check(typeof tool.execute === "function", `v2: ${name} has execute`)
      checkToolSchema("v2", name, tool.input)
    }
    fake.replay()
    check(fake.tools.size === 2, "v2: reload replay leaves exactly two tools (upsert, no duplicates)")
    await functionalProbe("v2", workspace, async (name, args) => {
      const output = await fake.tools.get(name)!.execute(args, {} as never)
      return parse((output as { content: unknown }).content)
    })
    await cleanup()
    check(fake.registrations.every(r => r.disposed), "v2: cleanup disposed every registration")

    // v1 host: dist/index.js default hook function → hooks.tool
    const { default: legacy } = await import(resolve(root, "dist/index.js"))
    check(typeof legacy === "function", "dist/index.js default export is a function")
    const hooks = await legacy({ directory: workspace, worktree: workspace })
    check(Object.keys(hooks.tool ?? {}).sort().join(",") === TOOLS.join(","), `v1: hooks.tool: ${Object.keys(hooks.tool ?? {}).join(", ")}`)
    for (const name of TOOLS) {
      const tool = hooks.tool[name]
      check(typeof tool.execute === "function" && tool.args && typeof tool.args.op === "object", `v1: ${name} has execute and zod args`)
      checkToolSchema("v1", name, z.toJSONSchema(z.object(tool.args)))
    }
    rmSync(join(workspace, ".corvus"), { recursive: true, force: true })
    await functionalProbe("v1", workspace, async (name, args) => parse(await hooks.tool[name].execute(args, {})))
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
  return [...messages]
}

if (import.meta.main) {
  const installRoot = process.argv[2] ?? resolve(import.meta.dirname, "..")
  for (const message of await probeTools(installRoot)) console.log(message)
  console.log(`PASS: review tools registered on both hosts (v2 setup + v1 hooks; ${TOOLS.join(", ")}) from ${installRoot}`)
}

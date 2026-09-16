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
 * asserts the complete seven-tool inventory on both hosts. Every assertion throws;
 * no flag bypasses inventory, schema, caller or functional checks.
 *
 * FUNCTIONAL LEG: in a throwaway workspace the probe writes a valid candidate
 * under `.corvus/reviews/probe/`, then drives measure → freeze → preview through
 * registered executors for both in-budget and over-budget candidates. The latter
 * must fit, then a wrong-digest post must reject with zero tool API calls. A PATH
 * gh sentinel is installed before either host is probed: any exec is recorded and
 * blocked without forwarding. Its empty audit independently attests to no gh exec,
 * even if a broken post tool reports zero. The sentinel is not a general network sandbox.
 */

const TOOLS = ["corvus_review_lock", "corvus_review_payload", "corvus_review_persist", "corvus_review_post", "corvus_review_pr", "corvus_review_sync", "corvus_review_verdict"] as const
type ToolName = (typeof TOOLS)[number]
const CONTRACTS = {
  corvus_review_lock: { ops: ["acquire", "release", "status"], required: ["op", "reviewRoot"], caller: "corvus-review-auto" },
  corvus_review_payload: { ops: ["measure", "freeze", "preview"], required: ["op"], caller: "corvus-review-auto" },
  corvus_review_persist: { ops: ["write_document", "write_input", "write_meta", "write_candidate", "read_document", "write_facts", "read_facts", "begin", "append", "finalize", "abort", "status"], required: ["op", "reviewRoot"], caller: "corvus-review-auto" },
  corvus_review_post: { ops: [], required: ["artifactPath", "expectedSha256", "repo", "prNumber", "headSha", "event"], caller: "pr-comment-writer" },
  corvus_review_pr: { ops: ["metadata", "head", "files", "diff", "reviews", "checks", "identity", "config", "repo", "find", "local"], required: ["op"], caller: "corvus-review-auto" },
  corvus_review_sync: { ops: ["resolve", "pull", "push"], required: ["op"], caller: "corvus-review-auto" },
  corvus_review_verdict: { ops: ["compute"], required: ["op", "reviewRoot", "priorReviews", "config"], caller: "corvus-review-auto" },
} as const
const LIMIT_BODY = 24000
const LIMIT_TOTAL = 48000

const messages: string[] = []
const check = (ok: boolean, message: string): void => {
  if (!ok) throw new Error(message)
  messages.push(`OK: ${message}`)
}
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const sameStrings = (value: unknown, expected: readonly string[]): boolean => Array.isArray(value)
  && value.every(item => typeof item === "string") && [...value].sort().join(",") === [...expected].sort().join(",")
const parse = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string") throw new Error(`tool returned ${typeof value}, expected JSON string`)
  return JSON.parse(value) as Record<string, unknown>
}

type Call = (name: ToolName, args: Record<string, unknown>, caller?: string) => Promise<Record<string, unknown>>

/**
 * The built tools' registered JSON schemas (v1 after Zod conversion) are the
 * oracle, checked before each host's functional probe writes candidate files.
 * A missing object schema, root combinator or mismatched operation contract aborts
 * the gate for either host. Post is a closed descriptor with no op; payload carries
 * measure/freeze/preview fields. Other nested schemas are not restricted here.
 * No flag disables this check.
 */
function checkToolSchema(host: string, name: ToolName, schema: unknown): void {
  check(schema !== null && typeof schema === "object" && !Array.isArray(schema)
    && "type" in schema && schema.type === "object", `${host}: ${name} input schema is an object`)
  for (const combinator of ["oneOf", "anyOf", "allOf"]) {
    check(!Object.hasOwn(schema as object, combinator), `${host}: ${name} input schema has no top-level ${combinator}`)
  }
  const input = record(schema), properties = record(input.properties), contract = CONTRACTS[name]
  check(sameStrings(input.required, contract.required) && contract.required.every(key => Object.hasOwn(properties, key)),
    `${host}: ${name} required fields match its operation contract`)
  if (name === "corvus_review_post") {
    check(!Object.hasOwn(properties, "op") && sameStrings(Object.keys(properties), contract.required)
      && input.additionalProperties === false, `${host}: post has exactly six descriptor fields and no op`)
    for (const [field, type] of [["artifactPath", "string"], ["expectedSha256", "string"], ["repo", "object"], ["prNumber", "integer"], ["headSha", "string"], ["event", "string"]]) {
      check(record(properties[field]).type === type, `${host}: post ${field} is ${type}`)
    }
    const repo = record(properties.repo)
    check(sameStrings(repo.required, ["owner", "name"]) && repo.additionalProperties === false,
      `${host}: post repo requires owner/name and rejects extra fields`)
  } else {
    const op = record(properties.op)
    check(op.type === "string" && sameStrings(op.enum, contract.ops), `${host}: ${name} op enum = ${contract.ops.join(", ")}`)
  }
  if (name === "corvus_review_payload") {
    check(sameStrings(Object.keys(properties), ["op", "candidatePath", "artifactPath", "expectedSha256"])
      && ["candidatePath", "artifactPath", "expectedSha256"].every(key => record(properties[key]).type === "string")
      && input.additionalProperties === false, `${host}: payload exposes measure/freeze/preview fields without extra arguments`)
  }
}

/** Malformed inputs reach argument validation, never I/O, after the per-call host
 * agent check. Unknown callers must reject first; unexpected results abort before
 * candidate writes. Reuses the registration tests' no-I/O caller probes, no bypass. */
async function checkCallers(host: string, call: Call): Promise<void> {
  const inputs: Record<ToolName, Record<string, unknown>> = {
    corvus_review_payload: { op: "measure", candidatePath: "" },
    corvus_review_post: {},
    corvus_review_persist: { op: "write_candidate", reviewRoot: "" },
    corvus_review_lock: { op: "acquire", reviewRoot: "" },
    corvus_review_pr: { op: "identity", cwd: "relative" },
    corvus_review_verdict: { op: "compute" },
    corvus_review_sync: { op: "pull", cwd: "relative" },
  }
  for (const name of TOOLS) {
    const result = await call(name, inputs[name])
    check(typeof result.reason === "string" && result.reason.startsWith("invalid-"),
      `${host}: ${name} caller ${CONTRACTS[name].caller} reaches argument validation`)
    const rejected = await call(name, inputs[name], "unknown")
    check(rejected.reason === "caller-not-allowed", `${host}: ${name} unknown caller rejects before argument validation`)
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

  const preview = await call("corvus_review_payload", { op: "preview", artifactPath, expectedSha256: frozen.sha256 })
  check(frozen.fitted === false && preview.ok === true && preview.sha256 === frozen.sha256 && preview.body === candidate.body
    && preview.commit_id === candidate.commit_id && preview.event === candidate.event
    && JSON.stringify(preview.comments) === JSON.stringify(candidate.comments), `${host}: in-budget preview returns the unchanged frozen request and digest`)

  const overPath = `${relative}/over-limit.json`
  writeFileSync(join(workspace, overPath), JSON.stringify({ ...candidate, body: "x".repeat(LIMIT_BODY + 1) }))
  const over = await call("corvus_review_payload", { op: "measure", candidatePath: overPath })
  const violations = over.violations as Array<{ field: string; unit: string; limit: number; actual: number; reason: string }>
  check(over.ok === false && Array.isArray(violations) && violations.length === 2
    && violations.every(v => v.field === "body" && v.reason === "limit-exceeded" && v.limit === LIMIT_BODY && v.actual === LIMIT_BODY + 1)
    && violations.map(v => v.unit).sort().join(",") === "codePoints,utf8Bytes",
  `${host}: over-limit body → violation on body (${violations?.map(v => v.unit).join(", ")})`)

  const fittedPath = `${relative}/fitted-request.json`
  const fitted = await call("corvus_review_payload", { op: "freeze", candidatePath: overPath, artifactPath: fittedPath })
  check(fitted.ok === true && fitted.fitted === true && typeof fitted.sha256 === "string", `${host}: over-budget measure → fitted freeze`)
  const fittedBytes = readFileSync(join(workspace, fittedPath))
  check(sha256(fittedBytes) === fitted.sha256 && fitted.sha256 !== over.sha256, `${host}: fitted artifact has its own independently checked digest`)
  const fittedPreview = await call("corvus_review_payload", { op: "preview", artifactPath: fittedPath, expectedSha256: fitted.sha256 })
  check(fittedPreview.ok === true && fittedPreview.sha256 === fitted.sha256
    && fittedPreview.commit_id === candidate.commit_id && fittedPreview.event === candidate.event
    && Array.isArray(fittedPreview.comments) && fittedPreview.comments.length === 0,
    `${host}: fitted preview keeps identity/event and drops inline comments`)
  const body = fittedPreview.body
  const omitted = record(fitted.omitted)
  check(omitted.comments === 1 && omitted.findings === 0 && typeof body === "string" && body.startsWith("x")
    && body.split("\n").filter(line => line.startsWith("Review limits:")).length === 1
    && body.endsWith("Review limits: 1 findings omitted for size"), `${host}: fitted preview retains leading prose and the exact omission footer`)
  check(typeof body === "string" && [...body].length <= LIMIT_BODY && Buffer.byteLength(body) <= LIMIT_BODY
    && [...fittedBytes.toString("utf8")].length <= LIMIT_TOTAL && fittedBytes.length <= LIMIT_TOTAL,
    `${host}: fitted artifact meets body/total ceilings in code points and UTF-8 bytes`)
  check(fittedBytes.toString("utf8") === JSON.stringify({ ...candidate, body, comments: [] }, null, 2) + "\n",
    `${host}: fitted preview matches the canonical artifact bytes`)
  for (const result of [measured, frozen, over, fitted]) {
    check(!["canonical", "body", "comments"].some(key => key in result), `${host}: measure/freeze result contains no review text`)
  }

  // The digest is deliberately different, not merely assumed to differ from a constant.
  const wrongDigest = (String(fitted.sha256).startsWith("0") ? "1" : "0") + String(fitted.sha256).slice(1)
  const rejected = await call("corvus_review_post", { artifactPath: fittedPath, expectedSha256: wrongDigest,
    repo: { owner: "probe-owner", name: "probe-repo" }, prNumber: 1, headSha: candidate.commit_id, event: candidate.event })
  check(rejected.outcome === "rejected" && rejected.reason === "artifact-verify-failed:sha256-mismatch"
    && rejected.tool_api_calls === 0, `${host}: wrong digest → artifact-verify-failed:sha256-mismatch; tool_api_calls=0`)
  check(readFileSync(join(workspace, "gh-exec.log"), "utf8") === "", `${host}: wrong-digest post rejected before any gh exec (zero network calls)`)

  const escaped = await call("corvus_review_payload", { op: "measure", candidatePath: `${relative}/../../../escape.json` })
  check(escaped.ok === false && escaped.reason === "path-outside-root", `${host}: traversal outside .corvus/reviews → path-outside-root`)
}

export async function probeTools(installRoot: string): Promise<string[]> {
  messages.length = 0
  const root = realpathSync(installRoot)
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "corvus-probe-tools-")))
  const previousPath = process.env.PATH, previousAudit = process.env.CORVUS_PROBE_GH_AUDIT
  try {
    const bin = join(workspace, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CORVUS_PROBE_GH_AUDIT"\nexit 1\n', { mode: 0o700 })
    process.env.CORVUS_PROBE_GH_AUDIT = join(workspace, "gh-exec.log")
    writeFileSync(process.env.CORVUS_PROBE_GH_AUDIT, "")
    process.env.PATH = `${bin}:${previousPath ?? ""}`
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
    check(fake.tools.size === 7 && sameStrings([...fake.tools.keys()], TOOLS), "v2: reload replay leaves exactly seven tools (upsert, no duplicates)")
    const callV2: Call = async (name, args, agent = CONTRACTS[name].caller) => {
      const tool = fake.tools.get(name)!
      const output = await tool.execute(args, { agent } as Parameters<typeof tool.execute>[1])
      return parse((output as { content: unknown }).content)
    }
    await checkCallers("v2", callV2)
    await functionalProbe("v2", workspace, callV2)
    await cleanup()
    check(fake.registrations.every(r => r.disposed), "v2: cleanup disposed every registration")

    // v1 host: dist/index.js default hook function → hooks.tool
    const { default: legacy } = await import(resolve(root, "dist/index.js"))
    check(typeof legacy === "function", "dist/index.js default export is a function")
    const hooks = await legacy({ directory: workspace, worktree: workspace })
    check(Object.keys(hooks.tool ?? {}).sort().join(",") === TOOLS.join(","), `v1: hooks.tool: ${Object.keys(hooks.tool ?? {}).join(", ")}`)
    for (const name of TOOLS) {
      const tool = hooks.tool[name]
      check(typeof tool.execute === "function" && tool.args && typeof tool.args === "object", `v1: ${name} has execute and zod args`)
      checkToolSchema("v1", name, z.toJSONSchema(z.object(tool.args)))
    }
    rmSync(join(workspace, ".corvus"), { recursive: true, force: true })
    const callV1: Call = async (name, args, agent = CONTRACTS[name].caller) => parse(await hooks.tool[name].execute(args, { agent }))
    await checkCallers("v1", callV1)
    await functionalProbe("v1", workspace, callV1)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousAudit === undefined) delete process.env.CORVUS_PROBE_GH_AUDIT
    else process.env.CORVUS_PROBE_GH_AUDIT = previousAudit
    rmSync(workspace, { recursive: true, force: true })
  }
  return [...messages]
}

if (import.meta.main) {
  const installRoot = process.argv[2] ?? resolve(import.meta.dirname, "..")
  for (const message of await probeTools(installRoot)) console.log(message)
  console.log(`PASS: review tools registered on both hosts (v2 setup + v1 hooks; ${TOOLS.join(", ")}) from ${installRoot}`)
}

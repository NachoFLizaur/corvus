import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { load } from "js-yaml"
import type { verify } from "../src/review-payload"

type RecordValue = Record<string, unknown>
type Row = { check: string; ok: boolean; code: number; detail: string }
type Tool = { index: number; name: string; callID: string; parentID: string; input: RecordValue; output: RecordValue; state: RecordValue }
export type Inputs = {
  fixture: string; owner: string; repo: string; pr: string; head: string
  jsonl: string; hostlog: string; audit: string
  host?: "v1" | "v2"; agents?: string; install?: string
}
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as RecordValue : {}
/** Host read tools truncate lines above 2,000 characters; the schema chunks values at 1,500, leaving JSON framing headroom. */
export const REVIEW_INPUT_LINE_LIMIT = 1900
/** The prompt's preferred per-call serialized-argument size (state.md Persist at R3 step 1). Advisory: reported, never a gate failure. */
export const CHECKPOINT_WRITE_ARGUMENT_BUDGET = 20000
const text = (value: unknown): string => typeof value === "string" ? value : ""
const json = (value: string): RecordValue => record(JSON.parse(value))
const read = (path: string): string => readFileSync(path, "utf8")
const safeRead = (path: string): string => existsSync(path) ? read(path) : ""
const lines = (value: string): string[] => value.split(/\r?\n/).filter(line => line.trim())
const denied = (value: string): boolean => /permission denied|subagent denied|permission.*reject|not allowed|denied.*permission|rule which prevents you from using this specific tool call/i.test(value)
const writer = (tool: Tool): boolean => ["task", "subagent"].includes(tool.name)
  && (tool.input.subagent_type ?? tool.input.agent) === "pr-comment-writer"
// Host-resolved v1 barrier: the last task:pr-comment-writer rule in debug-agent JSON must deny.
const writerDenyRule = (agent: RecordValue): boolean => (Array.isArray(agent.permission) ? agent.permission.map(record) : [])
  .filter(rule => rule.permission === "task" && rule.pattern === "pr-comment-writer").at(-1)?.action === "deny"

function toolOutput(value: unknown): RecordValue {
  if (typeof value !== "string") return record(value)
  try { return json(value) } catch { return {} }
}

function yaml(path: string): RecordValue {
  return record(load(read(path)))
}

function childResult(tool: Tool) {
  const metadata = record(tool.state.metadata)
  const sources = [tool.output, record(metadata.metadata), metadata]
  const status = sources.map(source => text(source.status)).find(Boolean) || text(tool.state.status)
  const sessionID = sources.map(source => text(source.sessionID) || text(source.sessionId)).find(Boolean)
    || text(tool.input.sessionID) || text(tool.input.task_id)
  return { tool, status, sessionID }
}

/**
 * Plugin evidence oracle: host-captured debug-agent JSON and logs, read before
 * model dispatch by preflight and after shutdown by the artifact gate. Missing
 * or malformed required evidence, or an explicit load failure, fails closed for
 * both consumers. V1 requires the installed agent identity, tools and permissions;
 * its load marker is diagnostic only. V2 requires the marker. No flag disables
 * evidence validation; --host selects the host's oracle, not a bypass.
 */
export function checkPluginLoaded(input: Pick<Inputs, "host" | "hostlog" | "agents" | "install">): Row {
  const log = safeRead(input.hostlog)
  const loading = lines(log).filter(line => /loading plugin/i.test(line) && /corvus-ai\/(?:dist\/)?server\.js/.test(line))
  let ok = loading.length > 0
  let detail = loading[0] || "no positive installed server.js load evidence"
  if (input.host === "v1") {
    try {
      if (!input.agents || !input.install) throw new Error("v1 requires agents.json and the sandbox install path")
      const agent = json(read(input.agents))
      const tools = record(agent.tools)
      const rules = Array.isArray(agent.permission) ? agent.permission.map(record) : []
      const install = resolve(input.install)
      const checks: Array<[string, boolean]> = [
        ["name", agent.name === "corvus-review-auto"],
        ["native=false", agent.native === false],
        ["Corvus prompt", text(agent.prompt).startsWith("# Corvus Review Auto")],
        ["review tools", tools.corvus_review_payload === true && tools.corvus_review_verify === true],
        ["writer deny", writerDenyRule(agent)],
        ["sandbox install permission", rules.some(rule => rule.pattern === install || text(rule.pattern).startsWith(install + "/"))],
      ]
      const missing = checks.filter(([, passed]) => !passed).map(([name]) => name)
      ok = missing.length === 0
      detail = `agents.json: ${ok ? "installed corvus-review-auto evidence verified" : "missing/invalid " + missing.join(", ")}`
    } catch (error) {
      ok = false
      detail = `agents.json: ${String(error)}`
    }
    detail += `; loading plugin markers: ${loading.length} (diagnostic only)`
  }
  if (/failed to load plugin/i.test(log)) {
    ok = false
    detail += "; explicit plugin load failure in host.log"
  }
  return { check: "plugin loaded", ok, code: 3, detail }
}

/**
 * The stopped host's tool events, logs, and persisted bytes are the gate oracles,
 * read after service shutdown and before any PASS. Missing/malformed evidence
 * fails closed for release consumers. Nothing disables a check; blocked gh calls
 * are informational, but forwarded mutations and successful writer calls fail.
 * This attests to observed gh traffic, not traffic bypassing the PATH shim.
 */
export async function checkReviewArtifacts(input: Inputs) {
  const rows: Row[] = []
  const add = (check: string, ok: boolean, code: number, detail: string) => rows.push({ check, ok, code, detail })
  const log = safeRead(input.hostlog)
  const raw = safeRead(input.jsonl)
  const events: RecordValue[] = []
  let malformed = 0
  for (const line of lines(raw)) {
    try { events.push(json(line)) } catch { malformed++ }
  }
  add("JSONL", events.length > 0 && malformed === 0, 3, `${events.length} events; ${malformed} malformed lines`)
  const tools: Tool[] = events.flatMap((event, index) => {
    if (event.type !== "tool_use") return []
    const part = record(event.part)
    const state = record(part.state)
    return [{ index, name: text(part.tool), callID: text(part.callID) || text(part.id),
      parentID: text(event.sessionID) || text(part.sessionID), input: record(state.input), output: toolOutput(state.output), state }]
  })
  /**
   * Dispatch oracle: stopped-host JSONL inputs and structured child results, read
   * before PASS without mutating evidence. Any explicit background call or running
   * result without a later same-parent, same-call/child terminal result fails closed
   * for release consumers. Outer tool completion alone cannot settle a running child;
   * prose acknowledgements cannot prove completion. No flag disables this check.
   */
  const children = tools.filter(tool => ["subagent", "task"].includes(tool.name)).map(childResult)
  const background = children.filter(child => child.tool.input.background === true)
  const pending = children.filter(child => child.status === "running" && !children.some(later =>
    later.tool.index > child.tool.index && later.tool.parentID === child.tool.parentID
    && later.tool.name === child.tool.name && ["completed", "error", "cancelled"].includes(later.status)
    && (child.sessionID ? later.sessionID === child.sessionID
      : Boolean(child.tool.callID) && later.tool.callID === child.tool.callID)))
  add("background-dispatch", background.length === 0 && pending.length === 0, 5,
    `${background.length} background:true calls; ${pending.length} running child results without later corresponding completion`
    + (pending.length ? ` (${pending.map(child => child.sessionID || child.tool.callID || `event ${child.tool.index}`).join(", ")})` : ""))
  rows.push(checkPluginLoaded(input))
  // CLI JSON mode omits agent identity; the harness records a host session/export
  // read separately, not a model-authored claim or the requested command argv.
  const identities = lines(log).filter(line => line.startsWith("CORVUS_SMOKE_SESSION ")).flatMap(line => {
    try { return [json(line.slice("CORVUS_SMOKE_SESSION ".length))] } catch { return [] }
  })
  const sessionIDs = new Set(events.map(event => text(event.sessionID) || text(record(event.part).sessionID)).filter(Boolean))
  const identity = identities.find(item => sessionIDs.has(text(item.id)) && item.agent === "corvus-review-auto")
  const fallback = /(?:agent[^\n]*(?:not found|unknown)|falling back to default agent)/i.test(log)
  add("invoked agent", Boolean(identity) && !fallback, 3, fallback ? "agent fallback warning" : identity ? "host session: corvus-review-auto" : "missing host session identity")
  const errors = events.filter(event => event.type === "error").map(event => JSON.stringify(event.error))
  const runtimeErrors = errors.filter(error => !denied(error))
  add("host/provider", runtimeErrors.length === 0, 3, runtimeErrors.join("\n") || "no terminal host/provider error")
  const authError = [...lines(log), ...errors].find(line => /(?:ExpiredToken|InvalidClientTokenId|UnrecognizedClient|credentials.*(?:missing|not found|resolve)|AccessDeniedException|401 Unauthorized|invalid.*api.key|unable to locate credentials)/i.test(line))
  add("host/auth", !authError, 3, authError ?? "no observed authentication failure")

  const validIdentity = /^[A-Za-z0-9_-]+$/.test(input.owner) && /^[A-Za-z0-9_.-]+$/.test(input.repo)
    && input.repo !== "." && input.repo !== ".." && /^[1-9]\d*$/.test(input.pr) && /^[a-f0-9]{40}$/.test(input.head)
  add("fixture identity", validIdentity, 4, `${input.owner}/${input.repo}#${input.pr} @ ${input.head}`)
  const root = join(resolve(input.fixture), ".corvus/reviews", `${input.owner}__${input.repo}__pr${input.pr}`)
  const artifact = join(root, "post-request.json")
  const candidate = join(root, "candidate.json")
  const required = [`${input.head}/REVIEW_DOCUMENT.md`, `${input.head}/meta.yaml`, "verified_facts.yaml", "candidate.json", "post-request.json"]
  const missing = validIdentity ? required.filter(path => !existsSync(join(root, path)) || !statSync(join(root, path)).isFile()) : required
  add("artifacts", missing.length === 0, 5, missing.length ? `missing: ${missing.join(", ")}` : "all five artifacts present")
  /**
   * Checkpoint oracle: stopped-host write/edit/apply_patch results and document bytes,
   * read after shutdown without mutating evidence. Serialized argument size is advisory
   * (the prompt's engineering budget against truncation, not a provider limit): the gate
   * reports the maximum and the over-budget count as information and never fails on size,
   * because a write that succeeded and read back complete is a success regardless of
   * size. It fails closed for an absent/empty/unreadable document, or for a write-family
   * error with no later successful same-target retry. No flag or host selection
   * disables this check.
   */
  const writes = tools.filter(tool => ["write", "edit", "apply_patch"].includes(tool.name))
    .map(tool => ({ tool, chars: JSON.stringify(tool.state.input)?.length ?? 0 }))
  const overBudget = writes.filter(write => write.chars > CHECKPOINT_WRITE_ARGUMENT_BUDGET)
  const maxWriteChars = writes.reduce((max, write) => Math.max(max, write.chars), 0)
  const target = (tool: Tool) => text(tool.input.filePath) || text(tool.input.path)
  const failedWrites = writes.filter(write => write.tool.state.status === "error")
  const unrecovered = failedWrites.filter(failed => !writes.some(later => later.tool.index > failed.tool.index
    && later.tool.parentID === failed.tool.parentID && later.tool.state.status === "completed"
    && (!target(failed.tool) || !target(later.tool) || target(later.tool) === target(failed.tool))))
  let checkpointOK = false
  let checkpointDetail = "missing/empty REVIEW_DOCUMENT.md"
  try {
    const path = join(root, input.head, "REVIEW_DOCUMENT.md")
    checkpointOK = validIdentity && existsSync(path) && statSync(path).isFile() && read(path).trim().length > 0
    if (checkpointOK) checkpointDetail = "non-empty REVIEW_DOCUMENT.md"
  } catch { checkpointDetail = "unreadable REVIEW_DOCUMENT.md" }
  add("checkpoint writes", checkpointOK && unrecovered.length === 0, 5,
    `${writes.length} write/edit/apply_patch calls; max serialized args ${maxWriteChars} chars (advisory budget ${CHECKPOINT_WRITE_ARGUMENT_BUDGET}; ${overBudget.length} over, informational); ${checkpointDetail}`
    + (failedWrites.length ? `; ${failedWrites.length - unrecovered.length} write error(s) recovered by a later successful write` : "")
    + (unrecovered.length ? `; ${unrecovered.length} write error(s) without a successful retry: ${unrecovered.map(({ tool, chars }) => `${tool.name} event ${tool.index} (${chars} chars)`).join(", ")}` : ""))
  let metadata: RecordValue = {}
  let metaError = ""
  try { if (validIdentity) metadata = yaml(join(root, input.head, "meta.yaml")) } catch { metaError = "missing/invalid meta.yaml" }
  add("metadata", metadata.autonomous === true && metadata.posted === false, metadata.posted === true ? 6 : 5,
    metaError || `autonomous=${String(metadata.autonomous)}, posted=${String(metadata.posted)}`)
  let lockOK = validIdentity
  let lockDetail = "absent"
  if (validIdentity && existsSync(join(root, "lock.yaml"))) {
    try { lockDetail = String(yaml(join(root, "lock.yaml")).status); lockOK = lockDetail === "completed" }
    catch { lockOK = false; lockDetail = "invalid lock.yaml" }
  }
  add("lock released", lockOK, 5, lockDetail)
  /**
   * Line-length oracle: the persisted review-input.json bytes, read after shutdown.
   * Host read/grep tools truncate lines above 2,000 characters, so any line over
   * REVIEW_INPUT_LINE_LIMIT means child evidence was unreachable; a missing or
   * unreadable file fails closed. No flag or host selection disables this check.
   */
  const reviewInput = join(root, "review-input.json")
  let inputDetail = "missing review-input.json"
  let inputOK = false
  if (validIdentity && existsSync(reviewInput) && statSync(reviewInput).isFile()) {
    const lengths = read(reviewInput).split(/\r?\n/).map(line => line.length)
    const over = lengths.map((length, index) => ({ line: index + 1, length })).filter(entry => entry.length > REVIEW_INPUT_LINE_LIMIT)
    inputOK = over.length === 0
    inputDetail = inputOK ? `${lengths.length} lines; longest ${Math.max(0, ...lengths)} ≤ ${REVIEW_INPUT_LINE_LIMIT} chars`
      : `${over.length} line(s) over ${REVIEW_INPUT_LINE_LIMIT} chars: ${over.slice(0, 5).map(entry => `line ${entry.line} (${entry.length})`).join(", ")}`
  }
  add("review-input lines", inputOK, 5, inputDetail)

  const samePath = (value: unknown, expected: string) => typeof value === "string" && resolve(input.fixture, value) === expected
  const succeeded = (tool: Tool) => tool.state.status === "completed" && tool.output.ok === true
  const measured = tools.find(tool => tool.name === "corvus_review_payload" && tool.input.op === "measure"
    && samePath(tool.input.candidatePath, candidate) && succeeded(tool))
  const frozen = tools.find(tool => measured && tool.index > measured.index && tool.name === "corvus_review_payload"
    && tool.input.op === "freeze" && samePath(tool.input.candidatePath, candidate) && samePath(tool.input.artifactPath, artifact) && succeeded(tool))
  const verified = tools.find(tool => frozen && tool.index > frozen.index && tool.name === "corvus_review_verify"
    && tool.input.op === "verify" && samePath(tool.input.artifactPath, artifact) && succeeded(tool))
  add("tool chain", Boolean(measured && frozen && verified), 5,
    `measure=${measured?.index ?? "missing"} → freeze=${frozen?.index ?? "missing"} → verify=${verified?.index ?? "missing"}`)
  const digest = validIdentity && existsSync(artifact) ? createHash("sha256").update(readFileSync(artifact)).digest("hex") : ""
  const digestOK = /^[a-f0-9]{64}$/.test(digest) && frozen?.output.sha256 === digest && verified?.input.expectedSha256 === digest
  add("SHA-256", digestOK, 5, digestOK ? digest : "freeze/verify/independent bytes digest missing or unequal")
  let verification = "artifact or digest unavailable"
  let verificationOK = false
  if (digest && frozen) {
    try {
      const modulePath = join(dirname(resolve(input.fixture)), "dist/review-payload.js")
      const built: { verify: typeof verify } = await import(pathToFileURL(modulePath).href)
      const result = built.verify(artifact, text(frozen.output.sha256), { reviewStateRoot: join(input.fixture, ".corvus/reviews") })
      verificationOK = result.ok && json(read(artifact)).commit_id === input.head
      verification = JSON.stringify(result)
    } catch (error) { verification = String(error) }
  }
  add("built verify()", verificationOK, 5, verification)

  const auditLines = lines(safeRead(input.audit))
  let blocked = 0
  let forwarded = 0
  let unsafe = 0
  for (const line of auditLines) {
    try {
      const entry = json(line)
      const argv = entry.argv
      if (!Array.isArray(argv) || !argv.every(arg => typeof arg === "string")) { unsafe++; continue }
      if (entry.marker === "CORVUS_SMOKE_MUTATION_BLOCKED" && entry.forwarded !== true) { blocked++; continue }
      if (entry.marker !== "CORVUS_SMOKE_GH_FORWARD") { unsafe++; continue }
      forwarded++
      const [command, subcommand] = argv as string[]
      const readCommand = command === "repo" && ["view", "clone"].includes(subcommand)
        || command === "pr" && ["view", "diff", "checks", "list"].includes(subcommand)
        || command === "pr" && subcommand === "checkout" && argv.includes("--detach")
        || command === "auth" && subcommand === "status"
      // Independent audit: even one forwarded write-shaped API call is a breach.
      const readAPI = command === "api" && !argv.some((arg, index) => /^(?:-f|-F|--field|--raw-field|--input|.*graphql)/.test(arg)
        || (/^(?:--header|-H)/.test(arg) && !(["--header", "-H"].includes(arg) && argv[index + 1] === "Accept: application/vnd.github.raw+json"))
        || ((arg === "-X" || arg === "--method") && argv[index + 1] !== "GET")
        || (arg.startsWith("--method=") && arg !== "--method=GET") || (/^-X.+/.test(arg) && arg !== "-XGET"))
      if (!readCommand && !readAPI) unsafe++
    } catch { unsafe++ }
  }

  const attempts = tools.filter(writer)
  const successfulWriter = attempts.some(tool => tool.state.status === "completed")
  const rejectedWriter = attempts.find(tool => verified && tool.index > verified.index && tool.state.status === "error"
    && denied(text(tool.state.error)))
  /**
   * V1 not-exposed path: when the host's task inventory omits pr-comment-writer,
   * no dispatch can be denied, so the barrier is attested instead by zero writer
   * dispatch attempts, the persisted local-only outcome (completion/decision/meta:
   * posted=false, remote_state=not_posted, api_calls=0, capability diagnostic
   * classified not-exposed), the host-resolved writer-deny rule (agents.json), and
   * zero forwarded gh mutations. Read after shutdown without mutating evidence;
   * missing fields everywhere, malformed YAML or conflicting values fail closed for
   * release consumers. Only terminal status/reason diagnoses substitute for an absent
   * structured classification. No flag disables the barrier; a v2 run or any dispatch
   * attempt still requires ordered denial evidence.
   */
  let notExposed = ""
  if (input.host === "v1" && attempts.length === 0 && validIdentity && verified) {
    try {
      const states = [metadata, ...["completion.yaml", "decision.yaml"]
        .map(name => join(root, input.head, name)).filter(path => existsSync(path)).map(yaml)]
      const sources = states.flatMap(state => [state, record(state.completion)])
        .flatMap(state => [state, record(state.POST_RESULT), record(state.post_result), record(state.capability_diagnostic)])
      const values = (key: string) => sources.filter(source => Object.hasOwn(source, key)).map(source => source[key])
      const agrees = (key: string, expected: unknown) => {
        const found = values(key)
        return found.length > 0 && found.every(value => value === expected)
      }
      const classifications = values("classification")
      const classification = classifications.length > 0
        ? classifications.every(value => /^not-exposed(?:$|[,;: ])/.test(text(value))) ? text(classifications[0]) : ""
        : sources.filter(source => ["posting-validation-failed", "local_only"].includes(text(source.status)))
          .map(source => /^(?:R5 writer capability|pr-comment-writer) (not-exposed(?:, cause unknown)?)(?=[:;.]|$)/.exec(text(source.reason))?.[1])
          .find(Boolean) || ""
      const checks: Array<[string, boolean]> = [
        ["meta.yaml posted=false", metadata.posted === false],
        ["terminal remote_state=not_posted", agrees("remote_state", "not_posted")],
        ["terminal api_calls=0", agrees("api_calls", 0)],
        ["terminal capability classification not-exposed", Boolean(classification)],
        ["agents.json writer deny rule", Boolean(input.agents) && writerDenyRule(json(read(input.agents!)))],
        ["gh audit forwarded mutations=0", existsSync(input.audit) && unsafe === 0],
      ]
      const failing = checks.filter(([, passed]) => !passed).map(([name]) => name)
      if (failing.length === 0) notExposed = `v1 not-exposed: 0 writer dispatch attempts; ${classification}; posted=false, remote_state=not_posted, api_calls=0; writer-deny rule held; 0 forwarded gh mutations`
    } catch { notExposed = "" }
  }
  add("writer denied", (Boolean(rejectedWriter) || Boolean(notExposed)) && !successfulWriter, successfulWriter ? 6 : 5,
    successfulWriter ? "posting barrier breach: writer executed" : rejectedWriter ? text(rejectedWriter.state.error)
      : notExposed || (attempts.length ? "writer dispatch lacks ordered denial evidence" : "stopped before writer dispatch"))

  add("GitHub barrier", existsSync(input.audit) && unsafe === 0, 6, `${forwarded} forwarded reads; ${blocked} blocked (informational); ${unsafe} unsafe/malformed`)
  const denialLines = lines(log).filter(line => {
    if (denied(line)) return !/pr-comment-writer/.test(line)
    return /action\.action=["']?deny|effect["':= ]+deny/.test(line)
      && /\b(edit|write|read|external_directory|bash)\b/.test(line)
      && /\.corvus\/reviews|node_modules\/corvus-ai\/skill\//.test(line)
  })
  const toolDenials = tools.filter(tool => denied(text(tool.state.error)) && !writer(tool)).map(tool => `${tool.name}: ${text(tool.state.error)}`)
  add("unexpected denials", denialLines.length + toolDenials.length === 0, 5,
    [...denialLines, ...toolDenials].join("\n") || "none")
  const steps = events.filter(event => event.type === "step_finish").map(event => record(event.part))
  const tokens: Record<string, number> = {}
  const accumulate = (value: RecordValue, prefix = "") => {
    for (const [key, amount] of Object.entries(value)) {
      if (typeof amount === "number") tokens[prefix + key] = (tokens[prefix + key] ?? 0) + amount
      else if (amount && typeof amount === "object") accumulate(record(amount), `${prefix}${key}.`)
    }
  }
  for (const step of steps) accumulate(record(step.tokens))
  const cost = steps.reduce((sum, step) => sum + (typeof step.cost === "number" ? step.cost : 0), 0)
  const timestamps = events.map(event => event.timestamp).filter((time): time is number => typeof time === "number")
  const durationSeconds = timestamps.length ? (Math.max(...timestamps) - Math.min(...timestamps)) / 1000 : null
  const exitCode = [6, 3, 4, 5].find(code => rows.some(row => !row.ok && row.code === code)) ?? 0
  return { rows, exitCode, usage: { steps: steps.length, cost, tokens, durationSeconds }, audit: { forwarded, blocked, unsafe } }
}

export function artifactTree(directory: string, prefix = ""): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = `${prefix}${entry.name}`
    return entry.isDirectory() ? artifactTree(join(directory, entry.name), `${name}/`) : [name]
  })
}

function printSmokeResult(rows: Row[], exitCode: number) {
  console.log(`SMOKE_RESULT ${JSON.stringify({
    checks: rows.map(row => ({ ...row, status: row.ok ? "PASS" : "FAIL" })),
    passed: rows.filter(row => row.ok).length, total: rows.length, exitCode,
  })}`)
}

if (import.meta.main) {
  const [fixture, owner, repo, pr, head, jsonl, hostlog, audit] = process.argv.slice(2)
  if (!audit) {
    console.error("Usage: check-review-artifacts.ts <fixture> <owner> <repo> <pr> <head_sha> <jsonl> <hostlog> <gh-audit> [--host v1|v2] [--agents PATH] [--install PATH]")
    printSmokeResult([{ check: "arguments", ok: false, code: 3, detail: "missing required arguments" }], 3)
    process.exit(3)
  }
  try {
    const { values } = parseArgs({ args: process.argv.slice(10), options: {
      host: { type: "string", default: "v2" }, agents: { type: "string" }, install: { type: "string" },
    } })
    if (values.host !== "v1" && values.host !== "v2") throw new Error("--host must be v1 or v2")
    const result = await checkReviewArtifacts({ fixture, owner, repo, pr, head, jsonl, hostlog, audit,
      host: values.host, agents: values.agents, install: values.install })
    console.log("| Check | Result | Evidence |\n|---|---|---|")
    for (const row of result.rows) console.log(`| ${row.check} | ${row.ok ? "PASS" : "FAIL"} | ${row.detail.replaceAll("|", "\\|").replaceAll("\n", " <br> ")} |`)
    console.log(`Usage (top-level step_finish events only; not child-session billing): ${JSON.stringify(result.usage)}`)
    console.log("Artifact tree (.corvus/reviews):")
    console.log(artifactTree(join(fixture, ".corvus/reviews")).join("\n") || "(absent)")
    console.log(`Exit code: ${result.exitCode}`)
    printSmokeResult(result.rows, result.exitCode)
    process.exitCode = result.exitCode
  } catch (error) {
    console.error(`FAIL: checker could not read evidence: ${String(error)}`)
    printSmokeResult([{ check: "checker", ok: false, code: 5, detail: String(error) }], 5)
    process.exitCode = 5
  }
}

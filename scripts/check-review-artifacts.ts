import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { Database } from "bun:sqlite"
import { load } from "js-yaml"
import type { verify } from "../src/review-payload"

type RecordValue = Record<string, unknown>
type Row = { check: string; ok: boolean; code: number; detail: string }
type Tool = { index: number; name: string; callID: string; parentID: string; input: RecordValue; output: RecordValue; state: RecordValue }
export type { Row, Tool }
export type Inputs = {
  fixture: string; owner: string; repo: string; pr: string; head: string
  jsonl: string; hostlog: string; audit: string
  host?: "v1" | "v2"; agents?: string; install?: string
  /** Writer-execution mode: the harness removed the task deny; the shim's POST admission is the barrier. */
  writer?: boolean; db?: string
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
// Host-resolved v1 barrier: the last task:pr-comment-writer rule in debug-agent JSON must deny
// (barrier mode) or allow (writer-execution mode, where the shim's POST admission is the barrier).
const writerRule = (agent: RecordValue): string => text((Array.isArray(agent.permission) ? agent.permission.map(record) : [])
  .filter(rule => rule.permission === "task" && rule.pattern === "pr-comment-writer").at(-1)?.action)
const writerDenyRule = (agent: RecordValue): boolean => writerRule(agent) === "deny"
/** Read-only Accept headers the shim admits; any other forwarded header is scored unsafe. */
export const READ_ACCEPT_HEADERS = Object.freeze(["Accept: application/vnd.github.raw+json", "Accept:application/vnd.github+json",
  "Accept: application/vnd.github+json", "Accept:application/vnd.github.v3.diff", "Accept: application/vnd.github.v3.diff"])

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

/** Tool calls from CLI JSON-mode events (parent session only; children live in the host DB). */
export function toolsFromEvents(events: RecordValue[]): Tool[] {
  return events.flatMap((event, index) => {
    if (event.type !== "tool_use") return []
    const part = record(event.part)
    const state = record(part.state)
    return [{ index, name: text(part.tool), callID: text(part.callID) || text(part.id),
      parentID: text(event.sessionID) || text(part.sessionID), input: record(state.input), output: toolOutput(state.output), state }]
  })
}

/** Tool calls from persisted part rows (same part shape as JSON-mode events), in storage order. */
export function toolsFromParts(parts: RecordValue[], sessionID = ""): Tool[] {
  return parts.flatMap((part, index) => {
    if (part.type !== "tool") return []
    const state = record(part.state)
    return [{ index, name: text(part.tool), callID: text(part.callID) || text(part.id),
      parentID: text(part.sessionID) || sessionID, input: record(state.input), output: toolOutput(state.output), state }]
  })
}

export type ChildSession = { id: string; agent: string; parentID: string; parts: RecordValue[]; tools: Tool[]; texts: string[] }

/**
 * Host-DB oracle for child sessions: the stopped host's session/part rows, opened
 * read-only after shutdown. CLI JSON mode never emits child events, so the writer
 * child's tool sequence is only observable here. A missing DB, missing table, or
 * unreadable row yields no sessions and the consumer fails closed.
 */
export function readChildSessions(dbPath: string, parentID: string, agent?: string): ChildSession[] {
  if (!existsSync(dbPath)) return []
  const db = new Database(dbPath, { readonly: true })
  try {
    const sessions = db.query("select id, agent from session where parent_id = ? order by time_created").all(parentID) as Array<{ id: string; agent: string | null }>
    return sessions.filter(session => !agent || session.agent === agent).map(session => {
      const rows = db.query("select data from part where session_id = ? order by time_created, id").all(session.id) as Array<{ data: string }>
      const parts = rows.flatMap(row => { try { return [json(row.data)] } catch { return [] } })
      return { id: session.id, agent: text(session.agent), parentID, parts, tools: toolsFromParts(parts, session.id),
        texts: parts.filter(part => part.type === "text").map(part => text(part.text)) }
    })
  } finally { db.close() }
}

/** The first JSON object carrying a POST_RESULT `status` inside model text, or {} when none parses. */
export function extractPostResult(texts: string[]): RecordValue {
  for (const value of [...texts].reverse()) {
    for (const match of value.matchAll(/\{[^{}]*"status"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)) {
      try { const parsed = json(match[0]); if (typeof parsed.status === "string") return parsed } catch {}
    }
  }
  return {}
}

export type WriterEvidence = {
  owner: string; repo: string; pr: string; fixture: string; digest: string
  tools: Tool[]; texts: string[]; auditLines: string[]; resultOutput?: RecordValue
}

/**
 * Writer-execution oracle: the writer's own tool sequence (its session's parts or,
 * for a direct run, the JSONL), the shim audit, and its returned POST_RESULT, read
 * after shutdown. Required in order: one completed corvus_review_verify on the exact
 * artifact/digest with ok:true, then the exact POST form reaching the shim and being
 * blocked; no shell measurement/diagnostic command (only fixed gh api forms); a
 * POST_RESULT that is not `posted`. Missing evidence fails closed; a forwarded POST
 * or a `posted` result is a breach (code 6). No flag disables any row.
 */
export function checkWriterExecution(input: WriterEvidence): Row[] {
  const rows: Row[] = []
  const add = (check: string, ok: boolean, code: number, detail: string) => rows.push({ check, ok, code, detail })
  const artifactRel = `.corvus/reviews/${input.owner}__${input.repo}__pr${input.pr}/post-request.json`
  const artifact = join(resolve(input.fixture), artifactRel)
  const samePath = (value: unknown) => typeof value === "string" && resolve(input.fixture, value) === artifact
  const verify = input.tools.find(tool => tool.name === "corvus_review_verify" && tool.input.op === "verify" && samePath(tool.input.artifactPath)
    && tool.input.expectedSha256 === input.digest && tool.state.status === "completed" && tool.output.ok === true)
  const verifyAttempts = input.tools.filter(tool => tool.name === "corvus_review_verify")
  add("writer verify", Boolean(verify), 5, verify ? `corvus_review_verify ok:true at event ${verify.index} (sha256Match=${String(verify.output.sha256Match)}, canonical=${String(verify.output.canonical)})`
    : verifyAttempts.length ? `${verifyAttempts.length} corvus_review_verify call(s) without a completed ok:true on ${artifactRel} @ ${input.digest.slice(0, 12)}…: ${verifyAttempts.map(tool => `event ${tool.index} status=${text(tool.state.status)} ok=${String(tool.output.ok)}${tool.state.error ? " error=" + text(tool.state.error) : ""}`).join("; ")}`
    : "no corvus_review_verify call by the writer")
  const postForm = `gh api --method POST repos/${input.owner}/${input.repo}/pulls/${input.pr}/reviews --input ${artifactRel}`
  const bash = input.tools.filter(tool => tool.name === "bash").map(tool => ({ tool, command: text(tool.input.command).trim() }))
  const post = bash.find(({ tool, command }) => command === postForm && verify && tool.index > verify.index)
  const postArgv = ["api", "--method", "POST", `repos/${input.owner}/${input.repo}/pulls/${input.pr}/reviews`, "--input", artifactRel]
  const audit = input.auditLines.flatMap(line => { try { return [json(line)] } catch { return [] } })
  const blockedPost = audit.find(entry => entry.marker === "CORVUS_SMOKE_MUTATION_BLOCKED" && JSON.stringify(entry.argv) === JSON.stringify(postArgv))
  const forwardedPost = audit.find(entry => entry.marker !== "CORVUS_SMOKE_MUTATION_BLOCKED" && Array.isArray(entry.argv)
    && (entry.argv as unknown[]).some((arg, index) => (arg === "--method" || arg === "-X") && (entry.argv as unknown[])[index + 1] === "POST" || arg === "--method=POST" || arg === "-XPOST"))
  add("writer POST attempted", Boolean(post && blockedPost) && !forwardedPost, forwardedPost ? 6 : 5,
    forwardedPost ? `posting barrier breach: POST forwarded ${JSON.stringify(forwardedPost.argv)}`
      : post && blockedPost ? `exact POST form at event ${post.tool.index} (after verify ${verify!.index}); shim audit: CORVUS_SMOKE_MUTATION_BLOCKED ${JSON.stringify(postArgv)}`
      : !post ? (bash.some(({ command }) => /^gh api --method POST /.test(command)) ? `POST attempted with a non-exact form or before verify: ${bash.filter(({ command }) => /^gh api --method POST /.test(command)).map(({ tool, command }) => `event ${tool.index}: ${command}`).join("; ")}` : "no POST attempted by the writer")
      : "POST tool call present but no blocked shim audit record for it")
  const fixedForms = [
    new RegExp(`^gh api --method GET repos/${input.owner}/${input.repo}/pulls/${input.pr} -H Accept:application/vnd\\.github(?:\\+json|\\.v3\\.diff)(?: --jq \\.head\\.sha)?$`),
    new RegExp(`^gh api --method GET --paginate repos/${input.owner}/${input.repo}/pulls/${input.pr}/files -H Accept:application/vnd\\.github\\+json$`),
  ]
  // The frontmatter's JSON validators on the exact artifact path are permitted read fallbacks
  // (informational); any digest/size measurement or other off-form command fails the writer.
  const validatorForms = [`jq . ${artifactRel}`, `python3 -m json.tool ${artifactRel}`]
  const validators = bash.filter(({ command }) => validatorForms.includes(command))
  const offForm = bash.filter(({ command }) => command !== postForm && !fixedForms.some(form => form.test(command)) && !validatorForms.includes(command))
  const measurement = offForm.filter(({ command }) => /^(?:shasum|sha256sum|sha\d*sum|openssl|md5|md5sum|cksum|wc|stat|du|jq|python3?)\b/.test(command))
  add("writer shell discipline", offForm.length === 0, 5, offForm.length === 0
    ? `${bash.length} bash call(s): ${bash.filter(({ command }) => /^gh api --method GET /.test(command)).length} fixed GET, ${bash.filter(({ command }) => command === postForm).length} POST, ${validators.length} granted JSON validator(s) (informational); no shell measurement`
    : `${measurement.length} shell measurement/diagnostic command(s), ${offForm.length - measurement.length} other off-form command(s): ${offForm.map(({ tool, command }) => `event ${tool.index}: ${command}`).join("; ")}`)
  const result = input.resultOutput && typeof input.resultOutput.status === "string" ? input.resultOutput : extractPostResult(input.texts)
  const status = text(result.status)
  const remote = text(result.remote_state)
  const resultOK = ["local_only", "not_posted"].includes(status) && ["not_posted", "unknown"].includes(remote) && result.review_url === null
  add("writer result", resultOK, status === "posted" || remote === "posted" ? 6 : 5, status
    ? `status=${status}, remote_state=${remote || "missing"}, review_url=${JSON.stringify(result.review_url ?? null)}, api_calls=${String(result.api_calls)}, reason=${JSON.stringify(result.reason ?? null)}`
    : "no POST_RESULT with a status field in the writer's returned text")
  return rows
}

export type WriterDispatchEvidence = Omit<WriterEvidence, "tools" | "texts" | "resultOutput">
  & { parentTools: Tool[]; afterIndex?: number; parentID: string; db?: string }

/**
 * Writer-execution mode: the parent must dispatch pr-comment-writer once after its
 * own verify and receive a completed result; the writer child (host DB) must then show
 * the tool path scored by checkWriterExecution. A missing DB path, DB, or child fails
 * closed; the child's returned task output is the POST_RESULT of record when present.
 */
export function checkWriterDispatch(input: WriterDispatchEvidence): Row[] {
  const attempts = input.parentTools.filter(writer)
  const dispatch = attempts.find(tool => input.afterIndex !== undefined && tool.index > input.afterIndex && tool.state.status === "completed")
  let children: ChildSession[] = []
  let childError = ""
  try { children = input.db ? readChildSessions(input.db, input.parentID, "pr-comment-writer") : [] } catch (error) { childError = String(error) }
  const child = children.find(candidate => candidate.tools.some(tool => tool.name === "corvus_review_verify")) ?? children.at(-1)
  const row: Row = { check: "writer dispatched", ok: Boolean(dispatch) && Boolean(child), code: 5,
    detail: dispatch && child ? `task pr-comment-writer completed at event ${dispatch.index} (after verify ${input.afterIndex}); child session ${child.id} (${child.tools.length} tool calls)`
      : !dispatch ? (attempts.length ? `${attempts.length} writer dispatch(es) without a completed result after verify: ${attempts.map(tool => `event ${tool.index} status=${text(tool.state.status)}${tool.state.error ? " error=" + text(tool.state.error) : ""}`).join("; ")}` : "no writer dispatch by the parent")
      : childError || (input.db ? `no pr-comment-writer child session under ${input.parentID || "(unknown parent)"} in ${input.db}` : "host DB path not supplied (--db)") }
  return [row, ...checkWriterExecution({ owner: input.owner, repo: input.repo, pr: input.pr, fixture: input.fixture, digest: input.digest,
    tools: child?.tools ?? [], texts: child?.texts ?? [], auditLines: input.auditLines,
    resultOutput: dispatch ? extractPostResult([text(dispatch.state.output)]) : undefined })]
}

/**
 * Plugin evidence oracle: host-captured debug-agent JSON and logs, read before
 * model dispatch by preflight and after shutdown by the artifact gate. Missing
 * or malformed required evidence, or an explicit load failure, fails closed for
 * both consumers. V1 requires the installed agent identity, tools and permissions;
 * its load marker is diagnostic only. V2 requires the marker. No flag disables
 * evidence validation; --host selects the host's oracle, not a bypass.
 */
export function checkPluginLoaded(input: Pick<Inputs, "host" | "hostlog" | "agents" | "install" | "writer">): Row {
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
        [input.writer ? "writer allow" : "writer deny", input.writer ? writerRule(agent) === "allow" : writerDenyRule(agent)],
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
  const tools = toolsFromEvents(events)
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
  let canned = 0
  let unsafe = 0
  for (const line of auditLines) {
    try {
      const entry = json(line)
      const argv = entry.argv
      if (!Array.isArray(argv) || !argv.every(arg => typeof arg === "string")) { unsafe++; continue }
      if (entry.marker === "CORVUS_SMOKE_MUTATION_BLOCKED" && entry.forwarded !== true) { blocked++; continue }
      if (entry.marker === "CORVUS_SMOKE_GH_CANNED") canned++
      else if (entry.marker === "CORVUS_SMOKE_GH_FORWARD") forwarded++
      else { unsafe++; continue }
      const [command, subcommand] = argv as string[]
      const readCommand = command === "repo" && ["view", "clone"].includes(subcommand)
        || command === "pr" && ["view", "diff", "checks", "list"].includes(subcommand)
        || command === "pr" && subcommand === "checkout" && argv.includes("--detach")
        || command === "auth" && subcommand === "status"
      // Independent audit: even one forwarded write-shaped API call is a breach.
      const readAPI = command === "api" && !argv.some((arg, index) => /^(?:-f|-F|--field|--raw-field|--input|.*graphql)/.test(arg)
        || (/^(?:--header|-H)/.test(arg) && !(["--header", "-H"].includes(arg) && READ_ACCEPT_HEADERS.includes(text(argv[index + 1]))))
        || ((arg === "-X" || arg === "--method") && argv[index + 1] !== "GET")
        || (arg.startsWith("--method=") && arg !== "--method=GET") || (/^-X.+/.test(arg) && arg !== "-XGET"))
      if (!readCommand && !readAPI) unsafe++
    } catch { unsafe++ }
  }

  const attempts = tools.filter(writer)
  const successfulWriter = attempts.some(tool => tool.state.status === "completed")
  if (input.writer) {
    rows.push(...checkWriterDispatch({ owner: input.owner, repo: input.repo, pr: input.pr, fixture: input.fixture, digest, auditLines,
      parentTools: tools, afterIndex: verified?.index, parentID: [...sessionIDs][0] ?? "", db: input.db }))
  } else {
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
  }

  add("GitHub barrier", existsSync(input.audit) && unsafe === 0, 6, `${forwarded} forwarded reads; ${canned} canned reads; ${blocked} blocked (informational); ${unsafe} unsafe/malformed`)
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
  return { rows, exitCode, usage: { steps: steps.length, cost, tokens, durationSeconds }, audit: { forwarded, canned, blocked, unsafe } }
}

export function artifactTree(directory: string, prefix = ""): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = `${prefix}${entry.name}`
    return entry.isDirectory() ? artifactTree(join(directory, entry.name), `${name}/`) : [name]
  })
}

export function printSmokeResult(rows: Row[], exitCode: number) {
  console.log(`SMOKE_RESULT ${JSON.stringify({
    checks: rows.map(row => ({ ...row, status: row.ok ? "PASS" : "FAIL" })),
    passed: rows.filter(row => row.ok).length, total: rows.length, exitCode,
  })}`)
}

if (import.meta.main) {
  const [fixture, owner, repo, pr, head, jsonl, hostlog, audit] = process.argv.slice(2)
  if (!audit) {
    console.error("Usage: check-review-artifacts.ts <fixture> <owner> <repo> <pr> <head_sha> <jsonl> <hostlog> <gh-audit> [--host v1|v2] [--agents PATH] [--install PATH] [--writer --db PATH]")
    printSmokeResult([{ check: "arguments", ok: false, code: 3, detail: "missing required arguments" }], 3)
    process.exit(3)
  }
  try {
    const { values } = parseArgs({ args: process.argv.slice(10), options: {
      host: { type: "string", default: "v2" }, agents: { type: "string" }, install: { type: "string" },
      writer: { type: "boolean", default: false }, db: { type: "string" },
    } })
    if (values.host !== "v1" && values.host !== "v2") throw new Error("--host must be v1 or v2")
    const result = await checkReviewArtifacts({ fixture, owner, repo, pr, head, jsonl, hostlog, audit,
      host: values.host, agents: values.agents, install: values.install, writer: values.writer, db: values.db })
    console.log("| Check | Result | Evidence |\n|---|---|---|")
    for (const row of result.rows) console.log(`| ${row.check} | ${row.ok ? "PASS" : "FAIL"} | ${row.detail.replaceAll("|", "\\|").replaceAll("\n", " <br> ")} |`)
    if (values.writer && values.db) {
      const parentID = lines(safeRead(jsonl)).flatMap(line => { try { const event = json(line); return [text(event.sessionID) || text(record(event.part).sessionID)] } catch { return [] } }).find(Boolean) ?? ""
      for (const child of readChildSessions(values.db, parentID, "pr-comment-writer")) {
        console.log(`Writer child ${child.id} tool sequence:`)
        for (const tool of child.tools) console.log(`${tool.index}:${tool.name}${tool.name === "bash" ? "(" + text(tool.input.command) + ")" : tool.name === "corvus_review_verify" ? "(" + text(tool.input.op) + ")" : ""} → ${text(tool.state.status)}`)
      }
    }
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

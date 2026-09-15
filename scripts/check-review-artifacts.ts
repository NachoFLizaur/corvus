import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual, parseArgs } from "node:util"
import { Database } from "bun:sqlite"
import { load } from "js-yaml"
import type { verify } from "../src/review-payload"
import { localReviewNamespace, read_document } from "../src/review-persist"
import { parseReviewMarker } from "../src/review-pr"

type RecordValue = Record<string, unknown>
type Row = { check: string; ok: boolean; code: number; detail: string }
type Tool = { index: number; name: string; callID: string; parentID: string; input: RecordValue; output: RecordValue; state: RecordValue }
export type { Row, Tool }
export type Inputs = {
  fixture: string; owner: string; repo: string; pr: string; head: string
  jsonl: string; hostlog: string; audit: string
  host?: "v1" | "v2"; agents?: string; install?: string
  intake?: "url" | "branch" | "local"; branch?: string | null; bare?: string; crossRepo?: boolean
  /** Writer-execution mode: the harness removed the task deny; the shim's POST admission is the barrier. */
  writer?: boolean; db?: string
}
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as RecordValue : {}
/** Host read tools truncate lines above 2,000 characters; the schema chunks values at 1,500, leaving JSON framing headroom. */
export const REVIEW_INPUT_LINE_LIMIT = 1900
const text = (value: unknown): string => typeof value === "string" ? value : ""
const json = (value: string): RecordValue => record(JSON.parse(value))
const read = (path: string): string => readFileSync(path, "utf8")
const safeRead = (path: string): string => existsSync(path) ? read(path) : ""
const lines = (value: string): string[] => value.split(/\r?\n/).filter(line => line.trim())
const denied = (value: string): boolean => /permission denied|subagent denied|permission.*reject|not allowed|denied.*permission|rule which prevents you from using this specific tool call/i.test(value)
const writer = (tool: Tool): boolean => ["task", "subagent"].includes(tool.name)
  && (tool.input.subagent_type ?? tool.input.agent) === "pr-comment-writer"
/**
 * Host-resolved v1 barrier: debug-agent JSON is read before model dispatch and
 * after shutdown. Use the last rule in the first populated tier: exact writer,
 * task wildcard, then global wildcard. Both consumers require deny in barrier
 * mode or allow in writer-execution mode, where the shim blocks POST. Missing
 * or invalid actions fail closed; no flag disables this evidence check.
 */
const writerRule = (agent: RecordValue): string => {
  const rules = Array.isArray(agent.permission) ? agent.permission.map(record) : []
  const writer = rules.findLast(rule => rule.permission === "task" && rule.pattern === "pr-comment-writer")
    ?? rules.findLast(rule => rule.permission === "task" && rule.pattern === "*")
    ?? rules.findLast(rule => rule.permission === "*")
  return text(writer?.action)
}
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
 * child's tool sequence is only observable here. Missing DB returns no sessions;
 * malformed tables/rows throw so consumers fail closed rather than omit evidence.
 */
export function readChildSessions(dbPath: string, parentID: string, agent?: string): ChildSession[] {
  if (!existsSync(dbPath)) return []
  const db = new Database(dbPath, { readonly: true })
  try {
    const sessions = db.query("select id, agent from session where parent_id = ? order by time_created").all(parentID) as Array<{ id: string; agent: string | null }>
    return sessions.filter(session => !agent || session.agent === agent).map(session => {
      const rows = db.query("select data from part where session_id = ? order by time_created, id").all(session.id) as Array<{ data: string }>
      const parts = rows.map(row => {
        const part = json(row.data)
        if (typeof part.type !== "string") throw new Error("invalid child part")
        return part
      })
      return { id: session.id, agent: text(session.agent), parentID, parts, tools: toolsFromParts(parts, session.id),
        texts: parts.filter(part => part.type === "text").map(part => text(part.text)) }
    })
  } finally { db.close() }
}

/** Parent results come from the stopped host DB, read-only; absent/malformed rows throw, with no JSONL fallback. */
function readParentTools(dbPath: string | undefined, parentID: string): Tool[] {
  if (!dbPath || !existsSync(dbPath) || !parentID) throw new Error("host DB required for orchestrator verdict results")
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db.query("select data from part where session_id = ? order by time_created, id").all(parentID) as Array<{ data: string }>
    return toolsFromParts(rows.map(row => {
      const part = json(row.data)
      if (typeof part.type !== "string" || part.sessionID && part.sessionID !== parentID) throw new Error("invalid parent part")
      return part
    }), parentID)
  } finally { db.close() }
}

function matchedStoredTool(tool: Tool | undefined, stored: Tool[], parentID: string): Tool | undefined {
  if (!tool?.callID || tool.parentID !== parentID || tool.state.status !== "completed") return undefined
  const matches = stored.filter(item => item.parentID === parentID && item.callID === tool.callID)
  const result = matches.length === 1 ? matches[0] : undefined
  return result?.name === tool.name && result.state.status === "completed" && isDeepStrictEqual(result.input, tool.input)
    && isDeepStrictEqual(result.output, tool.output) ? result : undefined
}

function fixtureInventory(input: Inputs): string[] {
  const value: unknown = JSON.parse(read(join(dirname(input.fixture), "changed-files.json")))
  if (!Array.isArray(value) || !value.every(name => typeof name === "string" && name.length > 0
    && !name.startsWith("/") && !/[\0\r\n\\]/.test(name) && !name.split("/").includes(".."))) throw new Error("invalid fixture changed-file inventory")
  return value
}

function inventoryRoot(input: Inputs, files: string[]): string {
  const tasks = new Set(files.flatMap(name => /^\.corvus\/tasks\/([A-Za-z0-9._-]+)\//.exec(name)?.[1] ?? []))
  const suffix = input.intake === "local" ? `local-${text(input.branch).replace(/[^A-Za-z0-9._-]/g, "-")}` : `pr${input.pr}`
  return `.corvus/${tasks.size === 1 ? `tasks/${[...tasks][0]}/` : ""}reviews/${suffix}`
}

/**
 * Sync oracle: the harness's pre-model unfiltered fixture inventory, stopped-host
 * JSONL plus matching parent DB results, Git trace2 argv and the local bare's
 * committed diff are read after shutdown without mutation. Ordering must hold in
 * both stores as final write_meta → release → push; missing/ambiguous evidence
 * fails closed. Only that validated push may follow release. Only a DB-matched config
 * with state_sync:false skips pull/push, with an explicit terminal note and zero
 * pushes/commits. LOCAL without an upstream requires the tool's refusal and zero
 * pushes/commits instead. Neither exception disables layout, meta or push auditing.
 * Cross-repository PRs require the DB-matched fork refusal, a terminal note and
 * no pushes or bare-tip movement from the harness's pre-model bare-tip-before.
 * Pull may be attempted or skipped for forks; positive receipt/scope rows do not
 * apply. Missing baseline evidence fails closed; no fork flag bypasses auditing.
 * Positive terminal summaries must pair a sync token with the DB receipt's full
 * SHA or a 7–40-character hex prefix in one sentence after release.
 * Trace attests to inherited Git traffic, not a process that unsets tracing.
 */
function checkSync(input: Inputs, events: RecordValue[], tools: Tool[], allTools: Tool[], parentID: string,
  root: string, acquired: Tool | undefined, released: Tool | undefined, metadata: RecordValue, candidateOptional = false): { rows: Row[]; validatedPush?: Tool } {
  const rows: Row[] = []
  const add = (check: string, ok: boolean, detail: string, code = 5) => rows.push({ check, ok, code, detail })
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  let stored: Tool[] = [], files: string[] = [], evidenceError = ""
  try { stored = readParentTools(input.db, parentID); files = fixtureInventory(input) } catch (error) { evidenceError = String(error) }
  const matched = (tool: Tool | undefined) => matchedStoredTool(tool, stored, parentID)
  const sync = tools.filter(tool => tool.parentID === parentID && tool.name === "corvus_review_sync")
  const resolved = sync.find(tool => tool.input.op === "resolve"), resolvedDB = matched(resolved)
  const source = tools.find(tool => tool.parentID === parentID && tool.name === "corvus_review_pr" && tool.input.op === (input.intake === "local" ? "local" : "metadata"))
  const sourceDB = matched(source)
  const inventory = input.intake === "local" ? source : tools.find(tool => tool.name === "corvus_review_pr" && tool.input.op === "files"
    && tool.input.include_corvus === true && tool.input.names_only === true)
  const inventoryDB = matched(inventory), lockDB = matched(acquired)
  const expectedRoot = inventoryRoot(input, files)
  const sameFiles = (value: unknown) => Array.isArray(value) && isDeepStrictEqual([...value].sort(), [...files].sort())
  const before = (first: Tool | undefined, second: Tool | undefined) => Boolean(first && second && first.index < second.index)
  const bothBefore = (first: Tool | undefined, second: Tool | undefined) => before(first, second) && before(matched(first), matched(second))
  const crossRepo = input.intake !== "local" && input.crossRepo === true
  const expectedPr = input.intake === "local" ? { name: input.repo, number: null, branch: input.branch }
    : { owner: input.owner, name: input.repo, number: Number(input.pr), isCrossRepository: crossRepo }
  add("sync.resolve", Boolean(!evidenceError && resolvedDB?.output.ok === true && sourceDB?.output.ok === true && inventoryDB?.output.ok === true
    && sourceDB.output.code_head === input.head
    && (input.intake === "local" ? input.crossRepo !== true : sourceDB.output.isCrossRepository === crossRepo)
    && resolvedDB.output.root === expectedRoot && resolvedDB.output.remote === "origin"
    && resolvedDB.output.task === (expectedRoot.startsWith(".corvus/tasks/") ? expectedRoot.split("/")[2] : null)
    && isDeepStrictEqual(resolved?.input.pr, expectedPr) && sameFiles(resolved?.input.changed_files)
    && sameFiles(inventoryDB.output[input.intake === "local" ? "changed_files" : "files"])
    && (input.intake === "local" || inventoryDB.output.complete_pagination === true && bothBefore(source, inventory))
    && bothBefore(inventory, resolved) && bothBefore(resolved, acquired) && lockDB),
  evidenceError || `root=${expectedRoot}; remote=${text(resolvedDB?.output.remote)}; metadata/local → unfiltered inventory → resolve → acquire (DB matched)`)
  let disabled = false
  for (const tool of tools.filter(tool => tool.name === "corvus_review_pr" && tool.input.op === "config")) {
    const result = matched(tool)
    if (result?.output.ok === true && result.output.present === true && before(tool, resolved)) {
      try { disabled ||= record(load(text(result.output.yaml))).state_sync === false } catch {}
    }
  }
  const terminal = finalAssistantMessage(events, parentID), summary = terminal.text.replace(/[`*]/g, "")
  const refusalNote = (reason: RegExp) => reason.test(summary) && (/\bsynced\s*[:=]\s*false\b/i.test(summary)
    || summary.split(/[.!?\n]+/).some(sentence => reason.test(sentence)
      && /\bskip(?:ped)?\b|\brefus\w*\b|\bnot synchronized\b|\bsynchronization was\b/i.test(sentence)))
  const skipNote = refusalNote(/\bstate_sync\b/i)
  const pulls = sync.filter(tool => tool.input.op === "pull"), pulled = pulls[0]
  const pushes = sync.filter(tool => tool.input.op === "push"), pushed = pushes[0], pushedDB = matched(pushed)
  const finalMeta = tools.findLast(tool => tool.name === "corvus_review_persist" && tool.input.op === "write_meta")
  const metaWrite = tools.findLast(tool => tool.name === "corvus_review_persist" && tool.input.op === "write_meta"
    && (tool.input.name ?? "meta.yaml") === "meta.yaml" && tool.input.headSha === input.head
    && typeof tool.input.reviewRoot === "string" && resolve(input.fixture, tool.input.reviewRoot) === root)
  const metaDB = matched(metaWrite)
  const syncTarget = (tool: Tool | undefined) => tool?.input.remote === "origin" && tool.input.branch === input.branch
    && (tool.input.cwd === undefined || tool.input.cwd === input.fixture)
  const pullSkipped = pulls.length === 0 && !stored.some(tool => tool.name === "corvus_review_sync" && tool.input.op === "pull")
  add("sync.pull", disabled ? pullSkipped && skipNote : Boolean(crossRepo && pullSkipped || pulls.length === 1 && syncTarget(pulled)
    && bothBefore(resolved, pulled) && bothBefore(pulled, acquired) && typeof matched(pulled)?.output.synced === "boolean"),
  disabled ? "state_sync:false: pull skipped with note" : crossRepo && pullSkipped ? "fork: pull skipped" : `pull=${pulled?.index ?? "missing"}; resolve → pull → acquire (DB matched)`)
  add("sync metadata", Boolean(metaDB?.output.ok === true && [metadata, record(metaWrite?.input.meta)].every(meta => meta.code_head === input.head
    && meta.head_sha === (sourceDB?.output.head_sha ?? sourceDB?.output.headRefOid) && /^[a-f0-9]{40}$/.test(text(meta.head_sha))
    && !Object.hasOwn(meta, "state_commit"))
    && tools.filter(tool => tool.name === "corvus_review_persist" && tool.input.op === "write_meta").every(tool => !Object.hasOwn(record(tool.input.meta), "state_commit"))),
  "meta.yaml and write_meta carry code_head + observed head_sha, never state_commit")
  let noUpstream = false, tip = "", tipBefore = "", subjects: string[] = [], paths: string[] = [], stat = "", gitError = "", trace: RecordValue[] = []
  try {
    if (!input.bare || !input.branch || input.branch.startsWith("-")) throw new Error("--bare and --branch are required")
    git(input.fixture, "check-ref-format", "--branch", input.branch)
    if (git(input.bare, "rev-parse", "--is-bare-repository").trim() !== "true") throw new Error("push target is not bare")
    tip = git(input.bare, "rev-parse", `refs/heads/${input.branch}`).trim()
    if (crossRepo) {
      tipBefore = read(join(dirname(input.fixture), "bare-tip-before")).trim()
      if (!/^[a-f0-9]{40}$/.test(tipBefore)) throw new Error("invalid pre-run bare tip")
    }
    subjects = lines(git(input.bare, "log", "--format=%s", `${crossRepo ? tipBefore + ".." : ""}refs/heads/${input.branch}`, "--"))
    stat = git(input.bare, "show", "--stat", "--format=%s", tip, "--").trim()
    paths = git(input.bare, "diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", tip, "--").split("\0").filter(Boolean)
    if (input.intake === "local") {
      try { git(input.fixture, "rev-parse", "--abbrev-ref", "--symbolic-full-name", `${input.branch}@{upstream}`) }
      catch { noUpstream = true }
    }
    trace = lines(read(join(dirname(input.fixture), "git-trace.jsonl"))).map(json)
    const remotes = lines(git(input.fixture, "remote")).sort()
    if (!isDeepStrictEqual(remotes, ["github", "origin"]) || git(input.fixture, "remote", "get-url", "github").trim() !== `https://github.com/${input.owner}/${input.repo}`
      || git(input.fixture, "remote", "get-url", "--push", "--all", "github").trim() !== "DISABLED_PUSH_SENTINEL"
      || git(input.fixture, "remote", "get-url", "--push", "--all", "origin").trim() !== input.bare) throw new Error("unsafe fixture remotes")
  } catch (error) { gitError = String(error) }
  const skipped = disabled || noUpstream || crossRepo
  const refusalReason = crossRepo ? "fork" : noUpstream ? "LOCAL-no-upstream" : undefined
  const pushOK = disabled ? pushes.length === 0 && skipNote : Boolean(pushes.length === 1 && syncTarget(pushed)
    && pushed?.input.root === expectedRoot && pushed.input.head_sha === input.head && isDeepStrictEqual(pushed.input.pr, expectedPr)
    && bothBefore(finalMeta, released) && bothBefore(released, pushed) && (refusalReason
      ? pushedDB?.output.synced === false && pushedDB.output.reason === refusalReason && !Object.hasOwn(pushedDB.output, "state_commit") : pushedDB?.output.synced === true))
  add("sync.push", pushOK,
  disabled ? "state_sync:false: push skipped with note" : `final write_meta=${finalMeta?.index ?? "missing"} → release=${released?.index ?? "missing"} → push=${pushed?.index ?? "missing"}; ${JSON.stringify(pushedDB?.output ?? {})}`)
  const stateCommit = text(pushedDB?.output.state_commit)
  if (crossRepo) {
    add("fork bare unchanged", !gitError && tip === tipBefore && subjects.length === 0 && !stateCommit,
      gitError || `bare tip before=${tipBefore}; after=${tip}; ${subjects.length} new commits; state_commit=${stateCommit || "none"}`)
  } else {
    add("sync receipt", !gitError && (skipped ? tip === input.head && !stateCommit : stateCommit === tip && tip !== input.head), gitError || `code_head=${input.head}; state_commit=${stateCommit || "none"}; bare tip=${tip}`)
    const subject = `corvus(review-state): ${expectedRoot.split("/").at(-1)} @ ${input.head.slice(0, 7)} [skip ci]`
    add("state commit scope", !gitError && (skipped || subjects[0] === subject && paths.length > 0 && paths.every(path => path.startsWith(expectedRoot + "/") && !path.split("/").includes(".staging"))),
      gitError || (skipped ? "no state commit expected" : stat))
  }
  const stateSubjects = subjects.filter(subject => subject.startsWith("corvus(review-state):"))
  add("state commit count", !gitError && stateSubjects.length === (skipped ? 0 : 1), gitError || `${stateSubjects.length} state commits in bare branch history${crossRepo ? " since pre-run tip" : ""}`)
  const pushArgvs = trace.filter(event => event.event === "start" && Array.isArray(event.argv) && event.argv.includes("push")).map(event => event.argv as string[])
  const shellPushes = allTools.filter(tool => tool.name === "bash" && /\bgit\b[\s\S]*\bpush\b/i.test(text(tool.input.command)))
  const expectedPush = ["git", "push", "origin", `HEAD:${input.branch}`]
  add("Git push isolation", !gitError && shellPushes.length === 0 && (skipped ? pushArgvs.length === 0
    : pushArgvs.length > 0 && pushArgvs.every(argv => isDeepStrictEqual([basename(argv[0]), ...argv.slice(1)], expectedPush))),
  gitError || `${pushArgvs.length} traced pushes: ${JSON.stringify(pushArgvs)}; ${shellPushes.length} bash push attempts; github pushes must be zero`, 6)
  add("sync terminal summary", Boolean(released && terminal.index > released.index && (disabled ? skipNote
    : refusalReason ? refusalNote(crossRepo ? /\bfork\b/i : /\bno[- ]upstream\b/i)
    : /^[a-f0-9]{40}$/.test(stateCommit) && summary.split(/[.!?\n]+/).some(sentence =>
      /\b(?:state_commit|synchroni[sz]ed|synced|committed|pushed)\b/i.test(sentence)
      && [...sentence.matchAll(/\b[a-f0-9]{7,40}\b/g)].some(([sha]) => stateCommit.startsWith(sha))))), "final summary carries state_commit or the explicit sync skip/refusal")
  const legacy = join(input.fixture, ".corvus/reviews", reviewNamespace(input))
  add("new review root", !evidenceError && root === resolve(input.fixture, expectedRoot) && !existsSync(legacy), `${expectedRoot}; legacy root must not be created: ${legacy}`)
  if (input.intake !== "local") {
    const candidateAbsent = candidateOptional && !existsSync(join(root, "candidate.json"))
    let markerOK = candidateAbsent
    try {
      const body = text(json(read(join(root, "candidate.json"))).body)
      markerOK = [...body.matchAll(/<!-- corvus-review v2 path=(\S+) head=([a-f0-9]{40}) round=([1-9][0-9]*) -->/g)]
        .some(match => match[1] === expectedRoot && match[2] === input.head)
    } catch {}
    add("marker v2", markerOK, candidateAbsent ? "R4 writer not-exposed: no retained candidate to mark" : "candidate body contains the v2 marker with resolved root and code_head")
  }
  return { rows, validatedPush: pushOK && !disabled ? pushed : undefined }
}

/** JSON-mode text parts belong to the assistant; select its last parent message, never earlier progress or child prose. */
function finalAssistantMessage(events: RecordValue[], parentID: string): { index: number; text: string } {
  const messages = events.flatMap((event, index) => {
    const part = record(event.part)
    return event.type === "text" && (text(event.sessionID) || text(part.sessionID)) === parentID
      && event.role !== "user" && part.role !== "user"
      ? [{ index, text: text(part.text), id: text(part.messageID) || text(event.messageID) }] : []
  })
  const last = messages.at(-1)
  return last ? { index: last.index, text: last.id ? messages.filter(message => message.id === last.id).map(message => message.text).join("\n") : last.text }
    : { index: -1, text: "" }
}

export function reviewNamespace(input: Pick<Inputs, "owner" | "repo" | "pr" | "head" | "intake" | "branch">): string {
  return input.intake === "local" ? localReviewNamespace(input.repo, input.branch ?? input.head)
    : `${input.owner}__${input.repo}__pr${input.pr}`
}

/** Existing new-layout namespaces are read before checker artifact access; one match wins, ambiguity rejects, and absent new state permits the one-release legacy read. No candidate is created or selected from model prose. */
export function reviewRoot(input: Pick<Inputs, "fixture" | "owner" | "repo" | "pr" | "intake" | "branch"> & { head?: string }): string {
  const namespace = input.intake === "local" ? `local-${(input.branch ?? input.head ?? "").replace(/[^A-Za-z0-9._-]/g, "-")}` : `pr${input.pr}`
  const plain = `.corvus/reviews/${namespace}`
  const tasks = join(input.fixture, ".corvus/tasks")
  const candidates = [plain, ...(existsSync(tasks) ? readdirSync(tasks).filter(task => /^[A-Za-z0-9._-]+$/.test(task))
    .map(task => `.corvus/tasks/${task}/reviews/${namespace}`) : [])].filter(path => existsSync(join(input.fixture, path)))
  if (candidates.length > 1) throw new Error("ambiguous review root")
  if (candidates.length === 1) return candidates[0]
  const legacy = `.corvus/reviews/${reviewNamespace({ ...input, head: input.head ?? "" })}`
  return existsSync(join(input.fixture, legacy)) ? legacy : plain
}

function checkpoint(input: Inputs): RecordValue {
  const result = read_document({ reviewRoot: reviewRoot(input), headSha: input.head },
    { reviewStateRoot: join(resolve(input.fixture), ".corvus") })
  if (!result.ok) throw new Error(result.reason)
  const documents: RecordValue[] = []
  const accept = (source: string, direct: boolean) => {
    const parsed = record(load(source))
    if (Object.hasOwn(parsed, "REVIEW_DOCUMENT")) documents.push(record(parsed.REVIEW_DOCUMENT))
    else if (direct && Object.hasOwn(parsed, "source_findings")) documents.push(parsed)
  }
  if (result.frontmatterYaml !== null) accept(result.frontmatterYaml, true)
  for (const section of result.sections) {
    let fence: { marker: string; length: number; yaml: boolean; lines: string[] } | undefined
    for (const line of section.body.split("\n")) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (!fence && marker) fence = { marker: marker[1][0], length: marker[1].length, yaml: /^(yaml|yml)$/i.test(marker[2].trim()), lines: [] }
      else if (fence && marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) {
        if (fence.yaml) accept(fence.lines.join("\n"), section.heading === "REVIEW_DOCUMENT")
        fence = undefined
      } else if (fence) fence.lines.push(line)
    }
  }
  if (documents.length !== 1) throw new Error("missing/ambiguous REVIEW_DOCUMENT")
  return documents[0]
}

const labels = ["blocker", "critical", "major", "minor", "nitpick", "praise", "thought", "note"] as const
const axes = ["standards", "spec"] as const
const nonnegative = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
const labelCounts = (value: unknown) => labels.every(label => nonnegative(record(value)[label]))
const historyResult = (value: RecordValue) => value.ok === true && nonnegative(value.round) && Number(value.round) > 0
  && typeof value.refuse_delta === "boolean" && typeof value.missing_history === "boolean"
const documentResult = (value: RecordValue) => historyResult(value) && typeof value.converged === "boolean"
  && [...axes, "total"].every(axis => labelCounts(record(value.counts)[axis])) && nonnegative(record(value.counts).actionable_total)
  && ["pr-code", "review-fix"].every(origin => [...axes, "total"].every(axis => labelCounts(record(record(record(value.counts).by_origin)[origin])[axis])))
  && nonnegative(record(value.caps_applied).max_nits) && nonnegative(record(value.caps_applied).max_minors)
  && nonnegative(record(record(value.caps_applied).totals).minor) && nonnegative(record(record(value.caps_applied).totals).nitpick)

/**
 * Verdict oracle: matching orchestrator tool_use inputs and the same call's host-DB
 * result, plus final checkpoint/meta/verdict bytes, read after shutdown without mutations.
 * History omits both code_head and headSha; current identity is code_head ?? headSha.
 * History must precede R1/R2 dispatch in both event and storage order; current-head
 * computation must follow the final document write and precede its R4 decision
 * (question, persisted decision, R4 completion, or freeze). Missing/ambiguous results,
 * stale ordering or disagreeing counts fail closed for both hosts. No flag bypasses
 * these rows. Summary totals are projections of tool counts, not model authority;
 * suppressed/source counts have different populations and are not equated to them.
 * A history refusal permits one requested review, but its true flag must survive
 * in final metadata and write_meta inputs, with a note in the final assistant
 * message after release. Missing either disclosure fails; no intake bypasses it.
 * The fixed head verdict file must match the DB result, ignoring only persisted
 * and computed_at. Missing, redirected or unequal files fail closed; metadata
 * supplies only the fixed verdict_file pointer, never authoritative copied counts.
 */
function checkVerdict(input: Inputs, events: RecordValue[], tools: Tool[], parentID: string, root: string,
  documentWrite: Tool | undefined, released: Tool | undefined, metadata: RecordValue, persistedVerdict: RecordValue, verdictError: string): Row[] {
  const rows: Row[] = []
  const add = (check: string, ok: boolean, detail: string) => rows.push({ check, ok, code: 5, detail })
  let stored: Tool[] = [], dbError = ""
  try { stored = readParentTools(input.db, parentID) } catch (error) { dbError = String(error) }
  const sameRoot = (tool: Tool) => typeof tool.input.reviewRoot === "string" && resolve(input.fixture, tool.input.reviewRoot) === root
  const verdictCalls = tools.filter(tool => tool.parentID === parentID && tool.name === "corvus_review_verdict" && sameRoot(tool) && tool.input.op === "compute")
  const matched = (tool: Tool | undefined) => matchedStoredTool(tool, stored, parentID)
  const reviewChild = (tool: Tool) => ["task", "subagent"].includes(tool.name)
    && ["pr-context-gatherer", "researcher", "pr-code-reviewer", "security-reviewer"].includes(text(tool.input.subagent_type ?? tool.input.agent))
  const firstChild = tools.find(reviewChild), storedChild = stored.find(reviewChild)
  const history = verdictCalls.filter(tool => !Object.hasOwn(tool.input, "code_head") && !Object.hasOwn(tool.input, "headSha"))
    .findLast(tool => !firstChild || tool.index < firstChild.index)
  const historyDB = matched(history)
  add("R0 verdict", Boolean(historyDB && historyResult(historyDB.output) && !Object.hasOwn(historyDB.output, "counts")
    && (!storedChild || historyDB.index < storedChild.index) && (!firstChild || Boolean(storedChild))),
  dbError || `history=${history?.index ?? "missing"}, R1/R2=${firstChild?.index ?? "not dispatched"}; DB result=${historyDB ? JSON.stringify(historyDB.output) : "missing/mismatched"}`)

  const decisionIndexes = tools.filter(tool => tool.parentID === parentID && (tool.name === "question"
    || tool.name === "corvus_review_payload" && tool.input.op === "freeze"
    || tool.name === "corvus_review_persist" && sameRoot(tool) && tool.input.op === "write_meta" && tool.input.headSha === input.head
      && (["decision.yaml", "authorization.yaml", "review-action.yaml"].includes(text(tool.input.name))
        || [record(tool.input.meta), record(record(tool.input.meta).REVIEW_ACTION), record(record(tool.input.meta).review_action)].some(meta => typeof meta.decision === "string"))))
    .map(tool => tool.index)
  for (const [index, event] of events.entries()) if (event.type === "text" && (text(event.sessionID) || text(record(event.part).sessionID)) === parentID
    && /\[R4 COMPLETE\]/.test(text(record(event.part).text))) decisionIndexes.push(index)
  const decision = Math.min(...decisionIndexes.filter(index => documentWrite && index > documentWrite.index))
  const head = verdictCalls.findLast(tool => (tool.input.code_head ?? tool.input.headSha) === input.head)
  const headDB = matched(head)
  const documentDB = matched(documentWrite)
  const headOK = Boolean(head && headDB && documentResult(headDB.output) && documentWrite && documentDB
    && head.index > documentWrite.index && headDB.index > documentDB.index
    && history && head.index > history.index && Number.isFinite(decision) && head.index < decision)
  add("R4 verdict", headOK, dbError || `head=${head?.index ?? "missing"}, document=${documentWrite?.index ?? "missing"}, decision=${Number.isFinite(decision) ? decision : "missing"}; DB result=${headDB ? "matched" : "missing/mismatched"}`)

  const value = headDB?.output ?? {}, counts = record(value.counts)
  let document: RecordValue = {}, documentError = ""
  try { document = checkpoint(input) } catch (error) { documentError = String(error) }
  const metaWrite = tools.findLast(tool => tool.parentID === parentID && tool.name === "corvus_review_persist" && sameRoot(tool)
    && tool.input.op === "write_meta" && tool.input.headSha === input.head && (tool.input.name ?? "meta.yaml") === "meta.yaml")
  const refusedHistory = historyDB?.output.refuse_delta === true
  const refusal = refusedHistory ? historyDB.output : value
  const terminal = finalAssistantMessage(events, parentID)
  const note = terminal.text.replace(/[`*]/g, "")
  const refusalNote = /\brefuse_delta\s*[:=]\s*true\b/i.test(note)
    || Boolean(text(refusal.refuse_reason).trim() && note.includes(text(refusal.refuse_reason)))
  add("continuation note", !refusedHistory || Boolean(metadata.refuse_delta === true && metaWrite && matched(metaWrite)?.output.ok === true
    && record(metaWrite.input.meta).refuse_delta === true && released && terminal.index > released.index && refusalNote),
  refusedHistory ? "history refuse_delta:true requires persisted/write_meta flag and final-summary note after release" : "history did not request a continuation note")
  const verdictFields = (result: RecordValue) => Object.fromEntries(Object.entries(result).filter(([key]) => !["persisted", "computed_at"].includes(key)))
  add("verdict persisted", Boolean(headOK && !verdictError && metaWrite && head && released && metaWrite.index > head.index && metaWrite.index < released.index
    && metaWrite.state.status === "completed" && metaWrite.output.ok === true
    && typeof metaWrite.output.path === "string" && resolve(input.fixture, metaWrite.output.path) === join(root, input.head, "meta.yaml")
    && typeof value.persisted === "string" && resolve(input.fixture, value.persisted) === join(root, input.head, "verdict.yaml")
    && typeof persistedVerdict.computed_at === "string" && Number.isFinite(Date.parse(persistedVerdict.computed_at))
    && isDeepStrictEqual(verdictFields(persistedVerdict), verdictFields(value))
    && metadata.verdict_file === "verdict.yaml" && record(metaWrite.input.meta).verdict_file === "verdict.yaml"),
  verdictError || `write_meta=${metaWrite?.index ?? "missing"}; require verdict_file: verdict.yaml and persisted verdict equal to DB tool_result`)
  if (!documentError) {
    const summary = record(document.summary)
    const statLabels = { blockers: "blocker", criticals: "critical", majors: "major", minors: "minor", nits_shown: "nitpick", praises: "praise", thoughts: "thought", notes: "note" }
    const statsAgree = (stats: RecordValue, group: RecordValue) => Object.entries(statLabels).every(([stat, label]) => stats[stat] === group[label])
      && stats.total_findings === labels.reduce((sum, label) => sum + Number(group[label]), 0)
      && stats.actionable === ["blocker", "critical", "major", "minor"].reduce((sum, label) => sum + Number(group[label]), 0)
    const agrees = headOK && document.verdict === (value.converged ? "converged" : "not_converged")
      && (!Object.hasOwn(document, "counts") || isDeepStrictEqual(document.counts, counts))
      && (!Object.hasOwn(record(document.synthesis_controls), "series_round") || record(document.synthesis_controls).series_round === value.round)
      && statsAgree(record(summary.stats), record(counts.total))
      && axes.every(axis => statsAgree(record(record(record(summary.by_axis)[axis]).stats), record(counts[axis])))
    add("verdict document counts", Boolean(agrees), "REVIEW_DOCUMENT summary totals and both axes must agree with DB tool_result")
  } else { add("verdict document counts", false, documentError) }
  return rows
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
  requireReviews?: boolean
  /**
   * Expected transport: `blocked` (default) is the shim-blocked POST → `unknown`;
   * `head-moved` is the canned head moving after the writer's own GET so the post
   * tool's independent recheck returns `rejected`/`head-moved` and no POST is issued.
   */
  expect?: "blocked" | "head-moved"
}

/**
 * Model-write oracle: recorded tool inputs, inspected after shutdown without writes.
 * Any review-state target (including patch moves) fails, even for denied attempts;
 * unparseable write-family targets fail closed. No size or success flag bypasses it.
 */
export function checkModelStateWrites(tools: Tool[], fixture: string): Row {
  const violations = tools.filter(tool => {
    if (!["write", "edit", "apply_patch"].includes(tool.name)) return false
    const paths = tool.name === "apply_patch"
      ? [...text(tool.input.patchText ?? tool.input.patch).matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => match[1])
      : [text(tool.input.filePath ?? tool.input.file_path ?? tool.input.path)].filter(Boolean)
    return paths.length === 0 || paths.some(path => /(?:^|\/)\.corvus\/(?:tasks\/[^/]+\/)?reviews(?:\/|$)/.test(path.replaceAll("\\", "/"))
      || /(?:^|\/)\.corvus\/(?:tasks\/[^/]+\/)?reviews(?:\/|$)/.test(resolve(fixture, text(tool.input.workdir) || ".", path)))
  })
  return { check: "model state writes", ok: violations.length === 0, code: 5,
    detail: violations.length ? violations.map(tool => `${tool.parentID}:${tool.index} ${tool.name}`).join("; ") : "no model edit/write/patch targets in review state" }
}

/** Descendant sessions are read from the stopped host DB; unreadable trees throw, never count as empty evidence. */
export function readDescendants(db: string, parentID: string): ChildSession[] {
  if (!parentID || !existsSync(db)) throw new Error("missing child session evidence")
  const seen = new Set([parentID])
  const result: ChildSession[] = []
  const visit = (parent: string) => {
    for (const child of readChildSessions(db, parent)) {
      if (seen.has(child.id)) throw new Error("cyclic child session tree")
      seen.add(child.id)
      result.push(child)
      visit(child.id)
    }
  }
  visit(parentID)
  return result
}

function sumApiCalls(values: unknown[]): number | undefined {
  let total = 0
  for (const value of values) {
    if (!nonnegative(value) || !Number.isSafeInteger(total + Number(value))) return undefined
    total += Number(value)
  }
  return total
}

function writerApiCalls(tools: Tool[]) {
  const pr = sumApiCalls(tools.filter(tool => tool.name === "corvus_review_pr").map(tool => tool.output.api_calls))
  const post = sumApiCalls(tools.filter(tool => tool.name === "corvus_review_post").map(tool => tool.output.tool_api_calls))
  return { pr, post, total: sumApiCalls([pr, post]) }
}

/**
 * Writer-execution oracle: the writer's own tool sequence (its session's parts or,
 * for a direct run, the JSONL), the shim audit, and its returned POST_RESULT, read
 * after shutdown. Required in order: one completed corvus_review_verify on the exact
 * artifact/digest with ok:true, then corvus_review_post with the same descriptor and
 * an unknown transport result, plus the plugin's exact spawn argv blocked by the shim.
 * Writer bash GitHub calls fail even when blocked. Head/diff/files/reviews tool results must
 * precede verify/post; each session may make one reviews call, required on repost.
 * Body-only artifacts skip diff/anchor reads, not head or the repost marker check.
 * POST_RESULT uses all reported PR api_calls plus post tool_api_calls; invalid or
 * overflowing counts fail closed rather than entering arithmetic as NaN.
 * Missing/malformed evidence fails closed; a forwarded POST or a `posted` result is
 * a breach (code 6). `expect: "head-moved"` swaps the transport expectation for the
 * tool's own head recheck: `rejected`/`head-moved` with tool_api_calls 1, the shim
 * audit showing pull.moved.json served to a head GET, no POST of any kind, and a
 * POST_RESULT of local_only/not_posted carrying the tool reason. No flag disables
 * any row. The audit attests to argv, not process identity.
 */
export function checkWriterExecution(input: WriterEvidence): Row[] {
  const rows: Row[] = []
  const add = (check: string, ok: boolean, code: number, detail: string) => rows.push({ check, ok, code, detail })
  const artifactRel = `${reviewRoot(input)}/post-request.json`
  const artifact = join(resolve(input.fixture), artifactRel)
  const samePath = (value: unknown) => typeof value === "string" && resolve(input.fixture, value) === artifact
  const verify = input.tools.find(tool => tool.name === "corvus_review_verify" && tool.input.op === "verify" && samePath(tool.input.artifactPath)
    && tool.input.expectedSha256 === input.digest && tool.state.status === "completed" && tool.output.ok === true)
  const verifyAttempts = input.tools.filter(tool => tool.name === "corvus_review_verify")
  add("writer verify", Boolean(verify), 5, verify ? `corvus_review_verify ok:true at event ${verify.index} (sha256Match=${String(verify.output.sha256Match)}, canonical=${String(verify.output.canonical)})`
    : verifyAttempts.length ? `${verifyAttempts.length} corvus_review_verify call(s) without a completed ok:true on ${artifactRel} @ ${input.digest.slice(0, 12)}…: ${verifyAttempts.map(tool => `event ${tool.index} status=${text(tool.state.status)} ok=${String(tool.output.ok)}${tool.state.error ? " error=" + text(tool.state.error) : ""}`).join("; ")}`
    : "no corvus_review_verify call by the writer")
  let payload: RecordValue = {}, artifactPath = ""
  try { payload = json(read(artifact)); artifactPath = realpathSync(artifact) } catch {}
  const postAttempts = input.tools.filter(tool => tool.name === "corvus_review_post")
  const post = postAttempts.find(tool => verify && tool.index > verify.index && tool.state.status === "completed"
    && samePath(tool.input.artifactPath) && tool.input.expectedSha256 === input.digest
    && record(tool.input.repo).owner === input.owner && record(tool.input.repo).name === input.repo
    && tool.input.prNumber === Number(input.pr) && tool.input.headSha === payload.commit_id && tool.input.event === payload.event
    && Object.keys(tool.input).length === 6 && Object.keys(record(tool.input.repo)).length === 2)
  const bash = input.tools.filter(tool => tool.name === "bash").map(tool => ({ tool, command: text(tool.input.command).trim() }))
  const postArgv = ["api", "--method", "POST", `repos/${input.owner}/${input.repo}/pulls/${input.pr}/reviews`, "--input", artifactPath, "-H", "Accept: application/vnd.github+json"]
  const audit = input.auditLines.flatMap(line => { try { return [json(line)] } catch { return [] } })
  const blockedPost = audit.find(entry => entry.marker === "CORVUS_SMOKE_MUTATION_BLOCKED" && entry.forwarded !== true && JSON.stringify(entry.argv) === JSON.stringify(postArgv))
  const forwardedPost = audit.find(entry => (entry.marker !== "CORVUS_SMOKE_MUTATION_BLOCKED" || entry.forwarded === true) && Array.isArray(entry.argv)
    && (entry.argv as unknown[]).some((arg, index) => (arg === "--method" || arg === "-X") && (entry.argv as unknown[])[index + 1] === "POST" || arg === "--method=POST" || arg === "-XPOST"))
  const transport = post?.output ?? {}
  const headMoved = input.expect === "head-moved"
  const transportKeys = Object.keys(transport).every(key => ["outcome", "reason", "tool_api_calls"].includes(key))
  const transportOK = headMoved
    ? transport.outcome === "rejected" && transport.reason === "head-moved" && transport.tool_api_calls === 1 && transportKeys
    : transport.outcome === "unknown" && text(transport.reason).trim().length > 0
      && Number.isSafeInteger(transport.tool_api_calls) && Number(transport.tool_api_calls) >= 2 && transportKeys
  // Head-moved mode: the shim served pull.moved.json to a head GET after the writer's own check, and no POST of any kind was issued.
  const movedHeadServed = audit.find(entry => entry.marker === "CORVUS_SMOKE_GH_CANNED" && entry.fixture === "pull.moved.json"
    && Array.isArray(entry.argv) && (entry.argv as unknown[]).includes(".head.sha"))
  const anyPost = audit.find(entry => Array.isArray(entry.argv) && (entry.argv as unknown[]).some((arg, index) => (arg === "--method" || arg === "-X") && (entry.argv as unknown[])[index + 1] === "POST" || arg === "--method=POST" || arg === "-XPOST"))
  const postDetail = forwardedPost ? `posting barrier breach: POST forwarded ${JSON.stringify(forwardedPost.argv)}`
    : !post || postAttempts.length !== 1 ? `${postAttempts.length} corvus_review_post call(s); require exactly one completed call after verify with the artifact descriptor`
    : !transportOK ? `invalid ${headMoved ? "head-moved" : "blocked"} TransportResult: ${JSON.stringify(transport)}`
    : headMoved
      ? !movedHeadServed ? "corvus_review_post rejected head-moved but the shim audit shows no pull.moved.json served to a head GET"
        : anyPost ? `head-moved rejection must issue no POST; audit shows ${JSON.stringify(anyPost.argv)}`
        : `corvus_review_post at event ${post.index} (after verify ${verify!.index}); outcome=rejected head-moved (tool_api_calls=1); shim served pull.moved.json to the tool's head GET; no POST in audit`
      : !blockedPost ? "corvus_review_post call present but no blocked shim audit record for plugin argv"
      : `corvus_review_post at event ${post.index} (after verify ${verify!.index}); outcome=unknown; shim audit: CORVUS_SMOKE_MUTATION_BLOCKED ${JSON.stringify(postArgv)}`
  add("writer POST attempted", postAttempts.length === 1 && Boolean(post) && transportOK && !forwardedPost
    && (headMoved ? Boolean(movedHeadServed) && !anyPost : Boolean(blockedPost)), forwardedPost ? 6 : 5, postDetail)
  const prCalls = input.tools.filter(tool => tool.name === "corvus_review_pr")
  const validRead = (tool: Tool) => tool.state.status === "completed" && tool.input.owner === input.owner
    && tool.input.name === input.repo && String(tool.input.pr) === input.pr
    && ["head", "diff", "files", "reviews"].includes(text(tool.input.op))
    && Object.keys(tool.input).every(key => ["op", "owner", "name", "pr", ...(tool.input.op === "files" ? ["paginate"] : [])].includes(key))
    && Number.isSafeInteger(tool.output.api_calls) && Number(tool.output.api_calls) >= 0
  const head = prCalls.find(tool => validRead(tool) && tool.input.op === "head" && tool.output.ok === true
    && tool.output.code_head === payload.commit_id && verify && tool.index < verify.index)
  const diff = prCalls.find(tool => validRead(tool) && tool.input.op === "diff" && tool.output.ok === true
    && head && tool.index > head.index && verify && tool.index < verify.index)
  const files = prCalls.find(tool => validRead(tool) && tool.input.op === "files" && tool.input.paginate === true
    && tool.output.ok === true && tool.output.complete_pagination === true && Array.isArray(tool.output.files)
    && diff && tool.index > diff.index && verify && tool.index < verify.index)
  const inline = Array.isArray(payload.comments) && payload.comments.length > 0
  const diffOK = diff && (diff.output.oversized === false && typeof diff.output.text === "string" || files)
  const reviews = prCalls.filter(tool => tool.input.op === "reviews")
  const reviewsOK = reviews.length <= 1 && (!input.requireReviews || reviews.length === 1)
    && reviews.every(tool => validRead(tool) && typeof tool.output.ok === "boolean" && head && tool.index > head.index
      && (!inline || diff && tool.index > diff.index) && verify && tool.index < verify.index)
  add("writer PR reads", Boolean(head) && (!inline || Boolean(diffOK)) && prCalls.every(validRead) && reviewsOK, 5,
    `head=${head?.index ?? "missing"}, diff=${diff?.index ?? "skipped/missing"}, files=${files?.index ?? "unused/missing"}, reviews=${reviews.length}${input.requireReviews ? " (required)" : " (optional)"}; ${prCalls.length} structured PR calls`)
  // The frontmatter's JSON validators on the exact artifact path are permitted read fallbacks
  // (informational); any digest/size measurement or other off-form command fails the writer.
  const validatorForms = [`jq . ${artifactRel}`, `python3 -m json.tool ${artifactRel}`]
  const validators = bash.filter(({ command }) => validatorForms.includes(command))
  const offForm = bash.filter(({ command }) => !validatorForms.includes(command))
  const measurement = offForm.filter(({ command }) => /^(?:shasum|sha256sum|sha\d*sum|openssl|md5|md5sum|cksum|wc|stat|du|jq|python3?)\b/.test(command))
  add("writer shell discipline", offForm.length === 0, 5, offForm.length === 0
    ? `${bash.length} bash call(s): no GitHub shell calls, ${validators.length} granted JSON validator(s) (informational); no shell measurement`
    : `${measurement.length} shell measurement/diagnostic command(s), ${offForm.length - measurement.length} other off-form command(s): ${offForm.map(({ tool, command }) => `event ${tool.index}: ${command}`).join("; ")}`)
  const result = input.resultOutput && typeof input.resultOutput.status === "string" ? input.resultOutput : extractPostResult(input.texts)
  const status = text(result.status)
  const remote = text(result.remote_state)
  const calls = writerApiCalls(input.tools)
  const resultKeys = ["status", "remote_state", "review_url", "reason", "inline_comments_posted", "comments_moved_to_body", "api_calls"]
  // Mapping table (writer step 7): unknown → local_only/unknown; rejected without http_status → local_only/not_posted with the tool reason verbatim.
  const expectedRemote = headMoved ? "not_posted" : "unknown"
  const resultOK = status === "local_only" && remote === expectedRemote && result.review_url === null
    && transportOK && result.reason === transport.reason && result.inline_comments_posted === 0 && result.comments_moved_to_body === 0
    && calls.total !== undefined && nonnegative(result.api_calls) && result.api_calls === calls.total
    && Object.keys(result).length === resultKeys.length && Object.keys(result).every(key => resultKeys.includes(key))
  add("writer result", resultOK, status === "posted" || remote === "posted" ? 6 : 5, status
    ? `status=${status}, remote_state=${remote || "missing"}, review_url=${JSON.stringify(result.review_url ?? null)}, api_calls=${String(result.api_calls)}, reason=${JSON.stringify(result.reason ?? null)}; expected remote_state=${expectedRemote}, api_calls=${calls.pr ?? "invalid"}+${calls.post ?? "invalid"}=${calls.total ?? "invalid"}`
    : "no POST_RESULT with a status field in the writer's returned text")
  return rows
}

export type WriterDispatchEvidence = Omit<WriterEvidence, "tools" | "texts" | "resultOutput" | "requireReviews">
  & { parentTools: Tool[]; afterIndex?: number; parentID: string; db?: string; maxDispatches?: 1 | 2 }

/**
 * Writer-execution oracle: parent dispatches and their session-ID-matched child DB
 * parts are read after shutdown without mutation. Every dispatch must complete after
 * parent verification and own a distinct child; every child's tool path is scored.
 * Missing/ambiguous evidence fails closed. Returned task output is the POST_RESULT
 * of record when present, otherwise use that child's text. API totals sum all matched
 * sessions, while terminal status comes from the final dispatch. The direct harness
 * permits one dispatch; R5 permits two and separately enforces unknown → reconciled
 * absence → repost → reconciliation. Neither limit disables per-child verification,
 * the second child's reviews check, or the independent mutation barrier.
 */
export function checkWriterDispatch(input: WriterDispatchEvidence): Row[] {
  const attempts = input.parentTools.filter(writer)
  const completed = (tool: Tool) => tool.parentID === input.parentID && input.afterIndex !== undefined
    && tool.index > input.afterIndex && tool.state.status === "completed"
  const dispatch = attempts.find(completed)
  let children: ChildSession[] = []
  let childError = ""
  try { children = input.db ? readChildSessions(input.db, input.parentID, "pr-comment-writer") : [] } catch (error) { childError = String(error) }
  const executions = (attempts.length ? attempts : [undefined]).map((tool, index) => {
    const sessionID = tool && (childResult(tool).sessionID || /^<task id="([^"]+)" state="[^"]+">/.exec(text(tool.state.output))?.[1])
    const child = children.find(candidate => candidate.id === sessionID)
    const returned = tool ? extractPostResult([text(tool.state.output)]) : {}
    const result = typeof returned.status === "string" ? returned : extractPostResult(child?.texts ?? [])
    const rows = checkWriterExecution({ ...input, tools: child?.tools ?? [], texts: child?.texts ?? [], resultOutput: result,
      requireReviews: index > 0 })
    return { tool, child, result, rows }
  })
  const matchedChildren = executions.flatMap(execution => execution.child ? [execution.child] : [])
  const sessionsOK = matchedChildren.length === attempts.length && children.length === attempts.length
    && new Set(matchedChildren.map(child => child.id)).size === attempts.length
  const row: Row = { check: "writer dispatched", ok: Boolean(dispatch) && attempts.every(completed) && sessionsOK
    && attempts.length <= (input.maxDispatches ?? 1), code: 5,
    detail: dispatch && sessionsOK ? `${attempts.length} writer dispatch(es) (limit ${input.maxDispatches ?? 1}, after verify ${input.afterIndex}); ${executions.map(({ tool, child }) => `event ${tool!.index} ${text(tool!.state.status)} → child session ${child!.id} (${child!.tools.length} tool calls)`).join("; ")}`
      : !dispatch ? (attempts.length ? `${attempts.length} writer dispatch(es) without a completed result after verify: ${attempts.map(tool => `event ${tool.index} status=${text(tool.state.status)}${tool.state.error ? " error=" + text(tool.state.error) : ""}`).join("; ")}` : "no writer dispatch by the parent")
      : childError || (input.db ? `no pr-comment-writer child session under ${input.parentID || "(unknown parent)"} uniquely matching every dispatch in ${input.db}` : "host DB path not supplied (--db)") }
  const calls = writerApiCalls(matchedChildren.flatMap(child => child.tools))
  const reportedCalls = sumApiCalls(executions.map(execution => execution.result.api_calls))
  const combined = executions[0].rows.map((first, index) => {
    const rows = executions.map(execution => execution.rows[index])
    const resultRow = first.check === "writer result"
    return { ...first, ok: rows.every(row => row.ok) && (!resultRow || calls.total !== undefined && reportedCalls === calls.total),
      code: Math.max(...rows.map(row => row.code)),
      detail: executions.length === 1 ? first.detail : resultRow
        ? `final dispatch: ${rows.at(-1)!.detail}; aggregate api_calls=${reportedCalls ?? "invalid"}; expected Σ(PR+POST)=${calls.pr ?? "invalid"}+${calls.post ?? "invalid"}=${calls.total ?? "invalid"}`
        : executions.map((execution, index) => `${execution.child?.id ?? "missing session"}: ${rows[index].detail}`).join("; ") }
  })
  return [row, ...combined]
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
        ["review tools", ["corvus_review_payload", "corvus_review_verify", "corvus_review_persist", "corvus_review_lock", "corvus_review_pr", "corvus_review_verdict", "corvus_review_sync"].every(name => tools[name] === true)],
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
 * Intake selects evidence, not a bypass: branch adds a DB-matched find result
 * before metadata; LOCAL replaces posting checks with tool-owned local state,
 * a final path/count summary and zero writer/post/candidate/payload attempts.
 * LOCAL also fails on blocked mutation attempts; PR runs report those as expected
 * barrier evidence. All modes retain write auditing and owned-lock cleanup.
 */
export async function checkReviewArtifacts(input: Inputs) {
  const local = input.intake === "local"
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
  let expectedRoot = inventoryRoot(input, [])
  try { expectedRoot = inventoryRoot(input, fixtureInventory(input)) } catch {}
  const root = join(resolve(input.fixture), expectedRoot)
  const artifact = join(root, "post-request.json")
  const candidate = join(root, "candidate.json")
  /**
   * R4 route oracle: current-head review-action.yaml selects the non-writer
   * local-only path after shutdown, without mutating evidence. Its matching parent
   * DB write, measured candidate, terminal disclosure and absence of freeze,
   * verify, POST and writer work are required below; missing or conflicting evidence
   * fails closed. Only this route makes retained candidate/post artifacts optional;
   * an absent candidate also has no marker to inspect. LOCAL and --writer disable
   * this exception, never their own checks or the independent GitHub barrier.
   */
  const actionPath = join(root, input.head, "review-action.yaml")
  let reviewAction: RecordValue = {}
  if (!local && !input.writer && validIdentity) {
    try { reviewAction = yaml(actionPath) } catch {}
  }
  const notExposed = reviewAction.decision === "local_only" && /not-exposed/.test(text(reviewAction.decision_reason))
    && Array.isArray(reviewAction.rails_applied) && reviewAction.rails_applied.includes("writer_capability_not_exposed")
  const required = [`${input.head}/REVIEW_DOCUMENT.md`, `${input.head}/meta.yaml`, "verified_facts.yaml", "review-input.json",
    ...(local || notExposed ? [] : ["candidate.json", "post-request.json"])]
  const missing = validIdentity ? required.filter(path => !existsSync(join(root, path)) || !statSync(join(root, path)).isFile()) : required
  add("artifacts", missing.length === 0, 5, missing.length ? `missing: ${missing.join(", ")}` : `all ${required.length} artifacts present`)
  /**
   * State oracle: parent tool results, descendant DB parts and final bytes, read
   * after shutdown. Lock ownership brackets the required input/document/candidate
   * writes (no candidate or measurement for LOCAL); latest results must succeed. Facts require a
   * successful write_facts under the same lock. Missing evidence
   * or any model state write fails closed; parent shell calls must match fixed
   * diagnostic/checkout templates. No host/mode flag disables these checks.
   */
  const samePath = (value: unknown, expected: string) => typeof value === "string" && resolve(input.fixture, value) === expected
  const succeeded = (tool: Tool) => tool.state.status === "completed" && tool.output.ok === true
  const parentID = text(identity?.id)
  if (input.intake === "branch") {
    let stored: Tool[] = [], error = ""
    try { stored = readParentTools(input.db, parentID) } catch (cause) { error = String(cause) }
    const metadata = tools.find(tool => tool.name === "corvus_review_pr" && tool.input.op === "metadata")
    const metadataDB = matchedStoredTool(metadata, stored, parentID)
    const firstStoredMetadata = stored.find(tool => tool.name === "corvus_review_pr" && tool.input.op === "metadata")
    const found = tools.find(tool => tool.parentID === parentID && tool.name === "corvus_review_pr" && tool.input.op === "find"
      && succeeded(tool) && tool.output.found === true && tool.output.number === Number(input.pr)
      && tool.output.url === `https://github.com/${input.owner}/${input.repo}/pull/${input.pr}`
      && metadata && tool.index < metadata.index)
    const foundDB = matchedStoredTool(found, stored, parentID)
    add("find resolved", Boolean(foundDB && metadataDB && firstStoredMetadata && foundDB.index < firstStoredMetadata.index
      && metadata?.input.owner === input.owner && metadata.input.name === input.repo && String(metadata.input.pr) === input.pr), 5,
    error || `find=${found?.index ?? "missing"}; first metadata=${metadata?.index ?? "missing"}; fixture PR=${input.pr}; DB result must match`)
  }
  const stateCalls = tools.filter(tool => tool.parentID === parentID && samePath(tool.input.reviewRoot, root))
  const acquired = stateCalls.find(tool => tool.name === "corvus_review_lock" && tool.input.op === "acquire"
    && text(tool.input.runId).trim() && tool.output.state === "acquired" && succeeded(tool))
  const released = stateCalls.findLast(tool => tool.name === "corvus_review_lock" && tool.input.op === "release"
    && acquired && tool.index > acquired.index && tool.input.runId === acquired.input.runId
    && ["released", "completed", "absent"].includes(text(tool.output.state)) && succeeded(tool))
  const persisted = (op: string, path: string) => {
    const last = stateCalls.findLast(tool => tool.name === "corvus_review_persist" && (tool.input.op === op
      || ["write_document", "write_input"].includes(op) && tool.input.op === "finalize" && samePath(tool.output.path, path)))
    return last && acquired && released && last.index > acquired.index && last.index < released.index
      && (op !== "write_document" || last.input.op === "finalize" || last.input.headSha === input.head)
      && samePath(last.output.path, path) && succeeded(last) ? last : undefined
  }
  const documentWrite = persisted("write_document", join(root, input.head, "REVIEW_DOCUMENT.md"))
  const inputWrite = persisted("write_input", join(root, "review-input.json"))
  const candidateWrite = persisted("write_candidate", candidate)
  const factsWrite = persisted("write_facts", join(root, "verified_facts.yaml"))
  add("review-state tools", Boolean(acquired && released && documentWrite && inputWrite)
    && inputWrite!.index < documentWrite!.index && (local || Boolean(candidateWrite && documentWrite!.index < candidateWrite.index)), 5,
    `acquire=${acquired?.index ?? "missing"}, write_input=${inputWrite?.index ?? "missing"}, write_document=${documentWrite?.index ?? "missing"}, write_candidate=${local ? "not applicable" : candidateWrite?.index ?? "missing"}, release=${released?.index ?? "missing"}`)
  add("verified facts tool", Boolean(factsWrite), 5,
    `write_facts=${factsWrite?.index ?? "missing"}; successful tool-owned verified_facts.yaml write required under the lock`)
  let descendants: ChildSession[] = []
  let childError = ""
  try {
    if (!input.db || !existsSync(input.db)) throw new Error("host DB required for all-agent write audit")
    descendants = readDescendants(input.db, [...sessionIDs][0] ?? "")
  } catch (error) { childError = String(error) }
  const gathererReads = descendants.filter(child => child.agent === "pr-context-gatherer").flatMap(child => child.tools)
    .filter(tool => tool.name === "corvus_review_pr" && ["files", "diff"].includes(text(tool.input.op)) && succeeded(tool))
  add("child tool evidence", !childError && (local || ["files", "diff"].every(op => gathererReads.some(tool => tool.input.op === op))), 5,
    childError || `${descendants.length} descendant sessions; ${local ? "LOCAL: PR reads not required" : `${gathererReads.length} gatherer files/diff calls`}`)
  const allTools = [...tools, ...descendants.flatMap(child => child.tools)]
  let stored: Tool[] = [], stagingError = ""
  try { stored = readParentTools(input.db, parentID) } catch (error) { stagingError = String(error) }
  const matched = (tool: Tool | undefined) => matchedStoredTool(tool, stored, parentID)
  /**
   * Parent JSONL and matching stopped-host DB calls are read before scoring, with
   * final disk bytes as the digest oracle. Missing, reordered or mismatched calls
   * fail closed. No intake disables staging; checkpoint-failed uses its separate
   * cleanup row instead of requiring a successful checkpoint.
   */
  const staged = (target: "document" | "input", final: Tool | undefined): boolean => {
    if (!final || final.input.op !== "finalize" || !matched(final)) return false
    const begin = stateCalls.findLast(tool => tool.name === "corvus_review_persist" && tool.input.op === "begin"
      && tool.input.target === target && (target !== "document" || tool.input.headSha === input.head)
      && tool.output.staging_id === final.input.staging_id && succeeded(tool))
    const appends = stateCalls.filter(tool => tool.name === "corvus_review_persist" && tool.input.op === "append"
      && tool.input.staging_id === final.input.staging_id)
    return Boolean(begin && acquired && begin.index > acquired.index && matched(begin) && appends.length
      && appends.every(tool => succeeded(tool) && matched(tool) && tool.index > begin.index && tool.index < final.index
        && matched(tool)!.index > matched(begin)!.index && matched(tool)!.index < matched(final)!.index))
  }
  const measurements = tools.filter(tool => tool.name === "corvus_review_payload" && tool.input.op === "measure")
  let documentDigest = ""
  try { documentDigest = createHash("sha256").update(readFileSync(join(root, input.head, "REVIEW_DOCUMENT.md"))).digest("hex") } catch {}
  add("document staged", !stagingError && staged("document", documentWrite) && !!documentDigest && documentWrite?.output.sha256 === documentDigest
    && [...allTools, ...stored].every(tool => !(tool.name === "corvus_review_persist" && tool.input.op === "write_document"))
    && measurements.every(tool => documentWrite && tool.index > documentWrite.index && matched(tool)
      && matched(tool)!.index > matched(documentWrite)!.index), 5, stagingError || "DB-matched begin → append → finalize before measure; final SHA equals checkpoint bytes; no write_document")
  const appends = [...stored, ...descendants.flatMap(child => child.tools)].filter(tool => tool.name === "corvus_review_persist" && tool.input.op === "append")
  const lengths = appends.map(tool => typeof tool.input.body === "string" ? tool.input.body.length
    : JSON.stringify(tool.input.value ?? tool.input.chunk)?.length ?? Infinity)
  const oversized = new Map<string, number>()
  for (const tool of appends.filter(tool => tool.output.reason === "chunk-too-large")) {
    const key = JSON.stringify([tool.parentID, tool.input.staging_id, tool.input.index ?? tool.input.key, tool.input.path, tool.input.part ?? 0])
    oversized.set(key, (oversized.get(key) ?? 0) + 1)
  }
  add("append ceiling", !stagingError && lengths.every(length => length <= 6_000) && [...oversized.values()].every(count => count < 2)
    && allTools.filter(tool => tool.parentID === parentID && tool.name === "corvus_review_persist" && tool.input.op === "append").every(tool => !!matched(tool)),
  5, stagingError || `${appends.length} appends; maximum ${Math.max(0, ...lengths)} chars; no repeated chunk-too-large for one part`)
  add("input route", !stagingError && Boolean(inputWrite && (inputWrite.input.op === "write_input" ? matched(inputWrite)
    && !stateCalls.some(tool => tool.name === "corvus_review_persist" && tool.input.op === "begin" && tool.input.target === "input") : staged("input", inputWrite))),
  5, stagingError || "DB-matched write_input or staged input finalize")
  rows.push(checkModelStateWrites(allTools, input.fixture))
  /** Inventories are read from persisted input and child DB results after shutdown;
   * any .corvus file/patch or unfiltered child call fails closed. Missing input
   * also fails; LOCAL skips PR reads, not scope filtering. No flag disables it. */
  const hasStateFiles = (value: unknown, key = ""): boolean => {
    if (typeof value === "string") return (["filename", "path", "changed_files", "files"].includes(key) && /^(?:\.\/)?\.corvus\//.test(value))
      || /(?:^|\n)diff --git (?:"?a\/\.corvus\/|\S+ "?b\/\.corvus\/)/.test(value)
    if (Array.isArray(value)) return value.some(item => hasStateFiles(item, key))
    return Object.entries(record(value)).some(([name, item]) => key === "file_map" && name.startsWith(".corvus/") || hasStateFiles(item, name))
  }
  const reviewers = descendants.filter(child => ["pr-context-gatherer", "pr-code-reviewer", "security-reviewer"].includes(child.agent))
  let inventoryOK = false
  try { inventoryOK = !hasStateFiles(json(read(join(root, "review-input.json")))) && reviewers.every(child => child.tools.every(tool =>
    tool.input.include_corvus !== true && !hasStateFiles(tool.output))) } catch {}
  add("review inventories", !childError && inventoryOK, 5, "gatherer/detector inventories and diffs exclude .corvus/**; only R0 uses the unfiltered layout inventory")
  const parentShell = tools.filter(tool => tool.name === "bash")
  const allowedShell = new Set(["gh auth status", `gh pr checkout ${input.pr} --repo ${input.owner}/${input.repo} --detach`,
    "git rev-parse HEAD", "date -u +%Y-%m-%dT%H:%M:%SZ", `shasum -a 256 ${reviewRoot(input)}/post-request.json`])
  const forbiddenGh = parentShell.filter(tool => !allowedShell.has(text(tool.input.command)))
  add("orchestrator GitHub reads", forbiddenGh.length === 0, 5,
    forbiddenGh.length ? forbiddenGh.map(tool => text(tool.input.command)).join("; ") : "zero orchestrator gh reads; only checkout/auth diagnostics permitted")
  let checkpointOK = false
  let checkpointDetail = "missing/empty REVIEW_DOCUMENT.md"
  try {
    const path = join(root, input.head, "REVIEW_DOCUMENT.md")
    checkpointOK = validIdentity && existsSync(path) && statSync(path).isFile() && read(path).trim().length > 0
    if (checkpointOK) checkpointDetail = "non-empty REVIEW_DOCUMENT.md"
  } catch { checkpointDetail = "unreadable REVIEW_DOCUMENT.md" }
  add("checkpoint writes", checkpointOK && Boolean(documentWrite), 5, checkpointDetail)
  let metadata: RecordValue = {}
  let metaError = ""
  try { if (validIdentity) metadata = yaml(join(root, input.head, "meta.yaml")) } catch { metaError = "missing/invalid meta.yaml" }
  const checkpointFailed = metadata.status === "checkpoint-failed"
  const terminalFailure = finalAssistantMessage(events, parentID)
  const failureMeta = stateCalls.findLast(tool => tool.name === "corvus_review_persist" && tool.input.op === "write_meta"
    && tool.input.headSha === input.head && (tool.input.name ?? "meta.yaml") === "meta.yaml")
  const forbiddenFailure = [...allTools, ...stored].filter(tool => writer(tool) || tool.name === "corvus_review_post"
    || tool.name === "corvus_review_payload" && tool.input.op === "freeze"
    || tool.name === "corvus_review_verdict" && (Object.hasOwn(tool.input, "headSha") || Object.hasOwn(tool.input, "code_head")))
  add("checkpoint-failed route", !checkpointFailed || Boolean(!stagingError && !childError && forbiddenFailure.length === 0
    && !descendants.some(child => child.agent === "pr-comment-writer") && released && matched(released) && failureMeta && matched(failureMeta)?.output.ok === true
    && isDeepStrictEqual(failureMeta.input.meta, metadata) && failureMeta.index < released.index && matched(failureMeta)!.index < matched(released)!.index
    && metadata.posted === false && metadata.recoverable === true && ["document", "review-input"].includes(text(metadata.stage))
    && text(metadata.failed_op) && text(metadata.reason) && nonnegative(metadata.part)
    && terminalFailure.index > released.index && terminalFailure.text.includes(text(metadata.failed_op))
    && terminalFailure.text.includes(text(metadata.reason)) && new RegExp(`\\bpart\\s*[:=#]?\\s*${metadata.part}\\b`, "i").test(terminalFailure.text)),
  5, checkpointFailed ? `${forbiddenFailure.length} forbidden calls; require DB-matched failure metadata, release and part diagnostic` : "not applicable")
  const sync = checkSync(input, events, tools, allTools, parentID, root, acquired, released, metadata, notExposed)
  rows.push(...sync.rows)
  add("metadata", metadata.autonomous === true && metadata.posted === false && metadata.mode === (local ? "local" : "pr"), metadata.posted === true ? 6 : 5,
    metaError || `autonomous=${String(metadata.autonomous)}, posted=${String(metadata.posted)}, mode=${String(metadata.mode)}`)
  let persistedVerdict: RecordValue = {}, verdictError = ""
  try {
    const path = join(root, input.head, "verdict.yaml")
    if (!validIdentity || realpathSync(path) !== join(realpathSync(root), input.head, "verdict.yaml") || !statSync(path).isFile()) throw new Error("invalid verdict path")
    persistedVerdict = yaml(path)
  } catch { verdictError = "missing/invalid verdict.yaml" }
  rows.push(...checkVerdict(input, events, tools, parentID, root, documentWrite, released, metadata, persistedVerdict, verdictError))
  let lockOK = validIdentity
  let lockDetail = "absent"
  for (const name of ["lock.yaml", ".lock"]) if (validIdentity && existsSync(join(root, name))) {
    try { const status = String(yaml(join(root, name)).status); lockDetail = `${name}: ${status}`; lockOK &&= status === "completed" }
    catch { lockOK = false; lockDetail = `invalid ${name}` }
  }
  /**
   * Terminal cleanup oracle: the owned release result and subsequent parent tool
   * events, read after shutdown alongside both lock files. Posted, non-post and
   * rail exits all require successful release after state/transport/dispatch work;
   * absent files alone do not prove cleanup. Only the exact push validated by
   * sync.push may follow release; other review tools/dispatches or failed cleanup
   * fail closed. No branch or host flag disables the release requirement.
   */
  const afterRelease = tools.filter(tool => released && tool.index > released.index
    && (tool.name.startsWith("corvus_review_") || ["task", "subagent"].includes(tool.name))
    && tool !== sync.validatedPush)
  add("lock released", lockOK && Boolean(released) && afterRelease.length === 0, 5,
    `${lockDetail}; release=${released?.index ?? "missing"}; later review work=${afterRelease.map(tool => `${tool.index}:${tool.name}`).join(", ") || "none"}`)
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

  const measured = tools.find(tool => tool.name === "corvus_review_payload" && tool.input.op === "measure"
    && candidateWrite && tool.index > candidateWrite.index && samePath(tool.input.candidatePath, candidate) && succeeded(tool))
  const frozen = tools.find(tool => measured && tool.index > measured.index && tool.name === "corvus_review_payload"
    && tool.input.op === "freeze" && samePath(tool.input.candidatePath, candidate) && samePath(tool.input.artifactPath, artifact) && succeeded(tool))
  const verified = tools.find(tool => frozen && tool.index > frozen.index && tool.name === "corvus_review_verify"
    && tool.input.op === "verify" && samePath(tool.input.artifactPath, artifact) && succeeded(tool))
  const digest = !local && !notExposed && validIdentity && existsSync(artifact) ? createHash("sha256").update(readFileSync(artifact)).digest("hex") : ""
  let notExposedOK = false, notExposedDetail = ""
  if (notExposed) {
    try {
      const stored = readParentTools(input.db, parentID)
      const action = stateCalls.findLast(tool => tool.name === "corvus_review_persist" && tool.input.op === "write_meta"
        && tool.input.name === "review-action.yaml" && tool.input.headSha === input.head)
      const actionDB = matchedStoredTool(action, stored, parentID)
      const measuredDB = matchedStoredTool(measured, stored, parentID), releasedDB = matchedStoredTool(released, stored, parentID)
      const forbidden = [...allTools, ...stored].filter(tool => writer(tool) || tool.name === "corvus_review_verify"
        || tool.name === "corvus_review_post" || tool.name === "corvus_review_payload" && tool.input.op === "freeze")
      const terminal = finalAssistantMessage(events, parentID), summary = terminal.text.replace(/[`*]/g, "")
      const writerNote = summary.split(/[.!?\n]+/).some(sentence => /\b(?:pr-comment-writer|writer)\b/i.test(sentence) && /\bnot[- ]exposed\b/i.test(sentence))
      const checks: Array<[string, boolean]> = [
        ["DB-matched R4 decision", Boolean(actionDB?.output.ok === true && samePath(actionDB.output.path, actionPath)
          && isDeepStrictEqual(actionDB.input.meta, reviewAction))],
        ["measure before R4 decision before release", Boolean(measured && action && released && measuredDB && actionDB && releasedDB
          && measured.index < action.index && action.index < released.index && measuredDB.index < actionDB.index && actionDB.index < releasedDB.index)],
        ["no freeze/verify/POST/writer work or post-request.json", !childError && forbidden.length === 0
          && !descendants.some(child => child.agent === "pr-comment-writer") && !existsSync(artifact)],
        ["final no-post and writer-not-exposed disclosure", Boolean(released && terminal.index > released.index && writerNote
          && /\b(?:nothing (?:was )?posted|no (?:GitHub )?review (?:was )?posted|not posted)\b/i.test(summary))],
      ]
      const failures = checks.filter(([, ok]) => !ok).map(([check]) => check)
      notExposedOK = failures.length === 0
      notExposedDetail = notExposedOK ? `R4 writer not-exposed: measure=${measured!.index} → local_only=${action!.index}; no freeze, verify, post-request or writer dispatch; final summary confirms nothing posted`
        : `R4 writer not-exposed evidence failed: ${failures.join("; ")}`
    } catch (error) { notExposedDetail = `R4 writer not-exposed evidence unreadable: ${String(error)}` }
  }
  if (!local) {
    add("tool chain", notExposed ? notExposedOK : Boolean(measured && frozen && verified), 5,
      notExposed ? notExposedDetail : `measure=${measured?.index ?? "missing"} → freeze=${frozen?.index ?? "missing"} → verify=${verified?.index ?? "missing"}`)
    const digestOK = /^[a-f0-9]{64}$/.test(digest) && frozen?.output.sha256 === digest && verified?.input.expectedSha256 === digest
    add("SHA-256", notExposed ? notExposedOK : digestOK, 5, notExposed ? notExposedDetail : digestOK ? digest : "freeze/verify/independent bytes digest missing or unequal")
    let verification = "artifact or digest unavailable"
    let verificationOK = false
    if (!notExposed && digest && frozen) {
      try {
        const modulePath = join(dirname(resolve(input.fixture)), "dist/review-payload.js")
        const built: { verify: typeof verify } = await import(pathToFileURL(modulePath).href)
        const result = built.verify(artifact, text(frozen.output.sha256), { reviewStateRoot: join(input.fixture, ".corvus") })
        verificationOK = result.ok && json(read(artifact)).commit_id === input.head
        verification = JSON.stringify(result)
      } catch (error) { verification = String(error) }
    }
    add("built verify()", notExposed ? notExposedOK : verificationOK, 5, notExposed ? notExposedDetail : verification)
  }

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
      const mutationFlag = argv.some(arg => /^(?:--method(?:=|$)|-X|--input(?:=|$)|-f|-F|--field(?:=|$)|--raw-field(?:=|$))/.test(arg))
      const readCommand = !mutationFlag && (command === "repo" && ["view", "clone"].includes(subcommand)
        || command === "pr" && ["view", "diff", "checks", "list"].includes(subcommand)
        || command === "pr" && subcommand === "checkout" && argv.includes("--detach")
        || command === "auth" && subcommand === "status")
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
  if (local) {
    const writerCalls = allTools.filter(writer)
    const writerChildren = descendants.filter(child => child.agent === "pr-comment-writer")
    add("LOCAL no writer", writerCalls.length === 0 && writerChildren.length === 0, 6,
      `${writerCalls.length} writer dispatch attempts; ${writerChildren.length} writer child sessions`)
    const forbidden = allTools.filter(tool => tool.name === "corvus_review_post"
      || tool.name === "corvus_review_persist" && tool.input.op === "write_candidate"
      || tool.name === "corvus_review_payload" && ["measure", "freeze"].includes(text(tool.input.op)))
    add("LOCAL no posting tools", forbidden.length === 0, 6,
      forbidden.length ? forbidden.map(tool => `${tool.parentID}:${tool.index} ${tool.name}:${text(tool.input.op)}`).join("; ") : "zero post, write_candidate, measure or freeze attempts")
    const terminal = finalAssistantMessage(events, parentID)
    const summary = terminal.text.replace(/[`*]/g, "")
    const counts = record(persistedVerdict.counts)
    const axisCounts = axes.every(axis => {
      const group = record(counts[axis])
      const total = labels.reduce((sum, label) => sum + Number(group[label]), 0)
      return labelCounts(group) && new RegExp(`\\b${axis}\\b[^\\d\\n]{0,40}${total}\\b`, "i").test(summary)
    })
    const documentPath = `${reviewRoot(input)}/${input.head}/REVIEW_DOCUMENT.md`
    add("LOCAL terminal summary", Boolean(released && terminal.index > released.index && summary.includes(documentPath) && axisCounts), 5,
      "final assistant message after release must contain document path and Standards/Spec totals from verdict.yaml")
  } else if (input.writer) {
    rows.push(...checkWriterDispatch({ owner: input.owner, repo: input.repo, pr: input.pr, fixture: input.fixture, digest, auditLines,
      parentTools: tools, afterIndex: verified?.index, parentID: [...sessionIDs][0] ?? "", db: input.db, maxDispatches: 2 }))
    /**
     * R5 transport oracle: ordered parent PR results and the writer's terminal
     * results and frozen marker, read after shutdown without writes. Permit one
     * dispatch, or two only when the first returned unknown and a complete reviews
     * listing between them proves no matching submitted review. Every unknown
     * requires reconciliation before another dispatch or completion; failed/partial
     * listings cannot authorize repost. Missing evidence fails closed. No terminal
     * result or host option bypasses metadata revalidation or the two-dispatch cap.
     */
    const dispatch = attempts[0]
    const results = attempts.map(tool => extractPostResult([text(tool.state.output)]))
    const prCalls = tools.filter(tool => tool.name === "corvus_review_pr" && tool.input.owner === input.owner
      && tool.input.name === input.repo && String(tool.input.pr) === input.pr)
    const revalidated = prCalls.find(tool => dispatch && frozen && tool.index > frozen.index && tool.index < dispatch.index && tool.input.op === "metadata"
      && succeeded(tool) && tool.output.code_head === input.head)
    const baseline = prCalls.find(tool => dispatch && frozen && tool.index > frozen.index && tool.index < dispatch.index && tool.input.op === "reviews"
      && succeeded(tool) && tool.output.complete_pagination === true && Array.isArray(tool.output.reviews))
    let payload: RecordValue = {}
    try { payload = json(read(artifact)) } catch {}
    const marker = text(payload.body).split(/\r?\n/).map(line => parseReviewMarker(line)).find(Boolean)?.marker
    const states: Record<string, string> = { COMMENT: "COMMENTED", APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED" }
    const provesAbsence = (tool: Tool) => succeeded(tool) && tool.output.complete_pagination === true
      && Array.isArray(tool.output.reviews) && Boolean(marker && states[text(payload.event)])
      && tool.output.reviews.every(value => {
        const review = record(value)
        return !(review.body_marker === marker && review.commit_id === input.head && review.state === states[text(payload.event)])
      })
    const reconciled = attempts.map((attempt, index) => prCalls.find(tool => tool.index > attempt.index
      && (!attempts[index + 1] || tool.index < attempts[index + 1].index) && tool.input.op === "reviews"
      && tool.state.status === "completed" && typeof tool.output.ok === "boolean"
      && (index === attempts.length - 1 || provesAbsence(tool))))
    const retryOK = attempts.length === 1 || attempts.length === 2 && results[0].remote_state === "unknown" && Boolean(reconciled[0])
    add("R5 PR transport", Boolean(revalidated) && [1, 2].includes(attempts.length) && retryOK
      && results.every((result, index) => typeof result.remote_state === "string"
        && (result.remote_state !== "unknown" || Boolean(baseline && reconciled[index]))), 5,
      `metadata=${revalidated?.index ?? "missing"}, baseline=${baseline?.index ?? "missing"}, reconciliation=${reconciled.map(tool => tool?.index ?? "unused/missing").join(",")}, writer dispatches=${attempts.length}`)
  } else {
  const rejectedWriter = attempts.find(tool => verified && tool.index > verified.index && tool.state.status === "error"
    && denied(text(tool.state.error)))
  add("writer denied", (notExposed ? notExposedOK : Boolean(rejectedWriter)) && !successfulWriter, successfulWriter ? 6 : 5,
    successfulWriter ? "posting barrier breach: writer executed" : notExposed ? notExposedDetail : rejectedWriter ? text(rejectedWriter.state.error)
      : attempts.length ? "writer dispatch lacks ordered denial evidence" : "stopped before writer dispatch")
  }

  add("GitHub barrier", existsSync(input.audit) && unsafe === 0 && (!local || blocked === 0), 6,
    `${forwarded} forwarded reads; ${canned} canned reads; ${blocked} blocked (${local ? "LOCAL requires zero" : "informational"}); ${unsafe} unsafe/malformed`)
  const denialLines = lines(log).filter(line => {
    if (denied(line)) return !/pr-comment-writer/.test(line)
    return /action\.action=["']?deny|effect["':= ]+deny/.test(line)
      && /\b(edit|write|read|external_directory|bash)\b/.test(line)
      && /\.corvus\/(?:tasks\/[^/]+\/)?reviews|node_modules\/corvus-ai\/skill\//.test(line)
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
  /**
   * Final meta.status is read after shutdown before scoring success-only rows.
   * checkpoint-failed makes those rows N/A, not proof of successful persistence.
   * The independent failure-route row still requires DB-matched metadata and
   * release; lock, append, sync and mutation barriers remain enforced. No host or
   * mode bypasses those checks; any other status disables this N/A route.
   */
  if (checkpointFailed) {
    const successOnly = new Set(["artifacts", "review-state tools", "verified facts tool", "document staged",
      "input route", "review inventories", "checkpoint writes", "metadata", "review-input lines",
      "R4 verdict", "verdict persisted", "verdict document counts", "continuation note", "marker v2",
      "tool chain", "SHA-256", "built verify()", "writer denied", "writer dispatched", "writer verify",
      "writer POST attempted", "writer PR reads", "writer shell discipline", "writer result", "R5 PR transport",
      "LOCAL terminal summary"])
    for (const row of rows) if (successOnly.has(row.check)) {
      row.ok = true
      row.detail = "N/A-PASS: checkpoint-failed; cleanup, lock, sync and no-post checks remain required"
    }
  }
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
    console.error("Usage: check-review-artifacts.ts <fixture> <owner> <repo> <pr> <code_head> <jsonl> <hostlog> <gh-audit> --db PATH --bare PATH --branch NAME [--host v1|v2] [--agents PATH] [--install PATH] [--writer] [--intake url|branch|local] [--cross-repo true|false]")
    printSmokeResult([{ check: "arguments", ok: false, code: 3, detail: "missing required arguments" }], 3)
    process.exit(3)
  }
  try {
    const { values } = parseArgs({ args: process.argv.slice(10), options: {
      host: { type: "string", default: "v2" }, agents: { type: "string" }, install: { type: "string" },
      writer: { type: "boolean", default: false }, db: { type: "string" },
      intake: { type: "string", default: "url" }, branch: { type: "string" }, bare: { type: "string" },
      "cross-repo": { type: "string", default: "false" },
    } })
    if (values.host !== "v1" && values.host !== "v2") throw new Error("--host must be v1 or v2")
    if (!["url", "branch", "local"].includes(values.intake)) throw new Error("--intake must be url, branch or local")
    if (values.intake === "local" && values.writer) throw new Error("LOCAL intake cannot execute the writer")
    if (!["true", "false"].includes(values["cross-repo"])) throw new Error("--cross-repo must be true or false")
    if (values.intake === "local" && values["cross-repo"] === "true") throw new Error("LOCAL intake cannot be cross-repository")
    const result = await checkReviewArtifacts({ fixture, owner, repo, pr, head, jsonl, hostlog, audit,
      host: values.host, agents: values.agents, install: values.install, writer: values.writer, db: values.db,
      intake: values.intake as Inputs["intake"], branch: values.branch, bare: values.bare, crossRepo: values["cross-repo"] === "true" })
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
    const root = reviewRoot({ fixture, owner, repo, pr, head, intake: values.intake as Inputs["intake"], branch: values.branch })
    console.log(`Artifact tree (${root}):`)
    console.log(artifactTree(join(fixture, root)).join("\n") || "(absent)")
    console.log(`Exit code: ${result.exitCode}`)
    printSmokeResult(result.rows, result.exitCode)
    process.exitCode = result.exitCode
  } catch (error) {
    console.error(`FAIL: checker could not read evidence: ${String(error)}`)
    printSmokeResult([{ check: "checker", ok: false, code: 5, detail: String(error) }], 5)
    process.exitCode = 5
  }
}

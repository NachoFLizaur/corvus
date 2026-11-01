import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual, parseArgs } from "node:util"
import { load } from "js-yaml"
import { measure, type verify } from "../src/review-payload"
import type { CandidateRequest } from "../src/review-payload"
import { fitReview } from "../src/review-fit"
import { createPersistExecutor, localReviewNamespace, read_document, type ReviewPersistFs } from "../src/review-persist"
import { parseReviewMarker } from "../src/review-pr"
import { readSessionStore, type StoredSession } from "./session-store"
import { isLightClassPath, LIGHT_REVIEW_DIRECTORY } from "../src/review-storage-class"

type RecordValue = Record<string, unknown>
type Row = { check: string; ok: boolean; code: number; detail: string }
type Tool = { index: number; name: string; callID: string; parentID: string; input: RecordValue; output: RecordValue; state: RecordValue; turn?: string }
export type { Row, Tool }
export type Inputs = {
  agent?: "auto" | "light"
  /** head is the full-review identity; light PR runs treat it only as a pre-run hint and derive each head/base from correlated live metadata. */
  fixture: string; owner: string; repo: string; pr: string; head: string
  jsonl: string; hostlog: string; audit: string
  host?: "v1" | "v2"; agents?: string; install?: string; pluginState?: string
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
export const denied = (value: string): boolean => /permission denied|subagent denied|permission.*reject|not allowed|denied.*permission|rule which prevents you from using this specific tool call/i.test(value)
const shell = (tool: Tool): boolean => ["bash", "shell"].includes(tool.name)
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

export function childResult(tool: Tool) {
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
      parentID: text(event.sessionID) || text(part.sessionID), input: record(state.input), output: toolOutput(state.output), state,
      turn: text(part.messageID) || text(event.messageID) || undefined }]
  })
}

/** Tool calls from persisted part rows (same part shape as JSON-mode events), in storage order. */
export function toolsFromParts(parts: RecordValue[], sessionID = ""): Tool[] {
  return parts.flatMap((part, index) => {
    if (part.type !== "tool") return []
    const state = record(part.state)
    return [{ index, name: text(part.tool), callID: text(part.callID) || text(part.id),
      parentID: text(part.sessionID) || sessionID, input: record(state.input), output: toolOutput(state.output), state,
      turn: text(part.messageID) || undefined }]
  })
}

export type ChildSession = { id: string; agent: string; parentID: string; parts: RecordValue[]; tools: Tool[]; texts: string[] }

const childSession = (session: StoredSession): ChildSession => ({ ...session,
  tools: toolsFromParts(session.parts, session.id), texts: session.parts.filter(part => part.type === "text").map(part => text(part.text)) })

/** The schema-detecting stopped-host reader owns availability. Throw unavailable
 * evidence to existing callers; a readable tree alone may report zero children. */
export function readChildSessions(dbPath: string, parentID: string, agent?: string): ChildSession[] {
  return readDescendants(dbPath, parentID).filter(child => child.parentID === parentID && (!agent || child.agent === agent))
}

/** Parent results come from the stopped host DB, read-only; absent/malformed rows throw, with no JSONL fallback. */
export function readParentTools(dbPath: string | undefined, parentID: string): Tool[] {
  const result = readSessionStore(dbPath, parentID, false)
  if (!result.available) throw new Error(result.reason)
  return toolsFromParts(result.parent.parts, parentID)
}

// Compare JSON output structurally, but never collapse unequal textual output to {}.
const comparisonOutput = (tool: Tool): unknown => {
  if (typeof tool.state.output !== "string") return tool.state.output
  try { return JSON.parse(tool.state.output) } catch { return tool.state.output }
}
const errorMessage = (value: unknown): unknown => typeof value === "string" ? value : record(value).message ?? value

/** Stopped-host JSONL/DB correlation, before scoring and without mutation. Missing
 * records are unavailable; existing unequal records contradict the trace. Failed
 * calls compare the CLI diagnostic to stored error.message (raw error stays in
 * state); matched failures are not terminal disclosure. No bypass. */
export function storedToolEvidence(tool: Tool | undefined, stored: Tool[], parentID: string): {
  kind: "absent" | "matched" | "contradicted"; tool?: Tool
} {
  if (!tool) return { kind: "absent" }
  if (!tool.callID || tool.parentID !== parentID) return { kind: "contradicted" }
  const matches = stored.filter(item => item.parentID === parentID && item.callID === tool.callID)
  if (!matches.length) return { kind: "absent" }
  const result = matches[0]
  return matches.length === 1 && result.name === tool.name && result.state.status === tool.state.status
    && isDeepStrictEqual(result.input, tool.input) && isDeepStrictEqual(result.output, tool.output)
    && isDeepStrictEqual(comparisonOutput(result), comparisonOutput(tool))
    && isDeepStrictEqual(errorMessage(result.state.error), errorMessage(tool.state.error))
    ? { kind: "matched", tool: result } : { kind: "contradicted" }
}

function matchedStoredTool(tool: Tool | undefined, stored: Tool[], parentID: string): Tool | undefined {
  const evidence = storedToolEvidence(tool, stored, parentID)
  return evidence.kind === "matched" && evidence.tool?.state.status === "completed" ? evidence.tool : undefined
}

export const diagnostic = (tool: Tool | undefined): string | undefined => text(tool?.output.reason) || text(errorMessage(tool?.state.error)) || undefined
const completedOK = (tool: Tool | undefined): boolean => tool?.state.status === "completed" && tool.output.ok === true
const normalizeNote = (value: string): string => value.replace(/[`*]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
const noteClauses = (value: string): string[] => value.split(/(?:[.!?]\s+|[;\r\n]+)/)
const successClaim = (summary: string, op: string, names: string[]): boolean => noteClauses(summary).some(clause => {
  const note = normalizeNote(clause)
  if (op === "head verdict" && /\bhistory\b|\br0\b/.test(note) || op === "history verdict" && /\bhead\b|\br4\b/.test(note)) return false
  return names.some(name => name.trim() && note.includes(normalizeNote(name)))
    && /\b(?:successfully (?:written|persisted|staged|computed|synced|pushed)|(?:written|persisted|staged|computed|synced|pushed) successfully|(?:write|persistence|staging|compute|push|sync) succeeded)\b/.test(note)
})

/** Terminal assistant text only (never progress/child prose or a failed trace).
 * The terminal message must name the op/artifact, say it is unavailable, and
 * quote its diagnostic (literal substring after Markdown/whitespace normalization)
 * or explicitly say no diagnostic exists. Consumers fail undisclosed on absence;
 * this predicate never overrides a contradiction. No host/mode disables it. */
export function disclosure(summary: string, op: string, diagnostic?: string): boolean {
  if (!op.trim()) return false
  const note = normalizeNote(summary)
  return note.includes(normalizeNote(op)) && /\b(?:unavailable|failed|failure|missing|absent|not[- ]found|could not|couldn't|unable|not written|not persisted|not computed|skipped)\b/.test(note)
    && (diagnostic ? note.includes(normalizeNote(diagnostic)) : /\bno (?:tool )?diagnostic(?: (?:exists|available|was (?:returned|provided)))?\b|\bdiagnostic\s*[:=]\s*none\b/.test(note))
}

type BookkeepingEvidence = {
  op: string; summary: string; consistent: boolean; detail: string
  diagnostic?: string; aliases?: string[]; contradiction?: string
  byContract?: boolean; contractDisclosed?: boolean
}
/** ADR-0006 precedence, evaluated from stopped-host evidence before PASS. A
 * contradiction always fails forged, even with a note. Only unavailable evidence
 * may be excused by terminal disclosure; no conversion touches hard barrier rows. */
export function bookkeepingRow(check: string, evidence: BookkeepingEvidence): Row {
  const { op, summary, consistent, detail, contradiction } = evidence
  if (contradiction) return { check, ok: false, code: 5, detail: `forged: ${contradiction}` }
  const names = [op, ...(evidence.aliases ?? [])].filter(name => name.trim())
  if ((!consistent || evidence.byContract) && successClaim(summary, op, names)) {
    return { check, ok: false, code: 5, detail: `forged: ${op} success claimed without matching evidence` }
  }
  if (evidence.byContract) return { check, ok: evidence.contractDisclosed === true, code: 5,
    detail: evidence.contractDisclosed ? `N/A-PASS: ${op} omitted by light contract, disclosed`
      : `undisclosed: ${op} omitted by light contract without terminal note` }
  if (consistent) return { check, ok: true, code: 5, detail }
  const disclosed = names.some(name => disclosure(summary, name, evidence.diagnostic))
  return { check, ok: disclosed, code: 5, detail: disclosed ? `N/A-PASS: ${op} unavailable, disclosed`
    : `undisclosed: ${op} failed without terminal note` }
}

/** Aggregates propagate the actual unavailable operation, not a fresh prerequisite.
 * Forgery wins over undisclosed failure, which wins over disclosed absence. */
function aggregateRow(check: string, dependencies: Row[], detail: string): Row {
  const decisive = dependencies.find(row => row.detail.startsWith("forged:")) ?? dependencies.find(row => !row.ok)
    ?? dependencies.find(row => row.detail.startsWith("N/A-PASS:"))
  return decisive ? { ...decisive, check } : { check, ok: true, code: 5, detail }
}

/** Terminal parent disclosure is read after shutdown, never injected into evidence.
 * Only the explicit light-contract omission note excuses absent full-pipeline rows;
 * observed forbidden calls/files and contradictory success claims still fail forged.
 * Auto and hard integrity/mutation rows never use this exception. */
export function lightContractRow(check: string, summary: string, contradiction?: string): Row {
  return bookkeepingRow(check, { op: check, summary, consistent: false, detail: "light contract",
    byContract: true, contractDisclosed: /full[- ]pipeline bookkeeping[^.!?\n]*(?:omitted|skipped)[^.!?\n]*light contract/i.test(normalizeNote(summary)),
    contradiction })
}

const fixtureGit = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
export type LightSnapshot = {
  branch: string; head: string; index: string; indexFlags: string; cachedDiffSha256: string
  sentinels: Record<string, string>; ignores: Record<string, string | null>; localLog: string; remoteRefs: string
  worktrees: string; siblingWorktrees: string[]
}
/** Disposable-fixture oracle: capture after setup and immediately after host shutdown,
 * before the harness's ignore opt-in/full push probe. Exact bytes (base64), complete
 * index entries/cached diff, branch/head and commit/ref inventories must agree.
 * New sibling leaks fail independently of Git registration; pre-existing siblings
 * remain byte-for-byte in the inventory. Missing evidence throws; no bypass. */
export function snapshotLightFixture(fixture: string, bare: string): LightSnapshot {
  const bytes = (path: string) => readFileSync(join(fixture, path)).toString("base64")
  return { branch: fixtureGit(fixture, "branch", "--show-current").trim(), head: fixtureGit(fixture, "rev-parse", "HEAD").trim(),
    index: fixtureGit(fixture, "ls-files", "-s", "-z"),
    indexFlags: fixtureGit(fixture, "ls-files", "-v", "-z"),
    cachedDiffSha256: createHash("sha256").update(execFileSync("git", ["-C", fixture, "diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"])).digest("hex"),
    sentinels: Object.fromEntries([".smoke-light-staged", ".smoke-light-unstaged"].map(path => [path, bytes(path)])),
    ignores: Object.fromEntries([".gitignore", ".git/info/exclude"].map(path => [path, existsSync(join(fixture, path)) ? bytes(path) : null])),
     localLog: fixtureGit(fixture, "log", "--all", "--format=%H %s"), remoteRefs: fixtureGit(bare, "show-ref"),
     worktrees: fixtureGit(fixture, "worktree", "list", "--porcelain"),
     siblingWorktrees: readdirSync(dirname(realpathSync(fixture))).filter(name => name.startsWith(`${basename(realpathSync(fixture))}.corvus-review-pr`)).sort() }
}

export function checkLightSnapshots(before: LightSnapshot, after: LightSnapshot): Row[] {
  const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b)
  return [
    ["sentinel bytes/index unchanged", same(before.sentinels, after.sentinels) && before.index === after.index && before.indexFlags === after.indexFlags && before.cachedDiffSha256 === after.cachedDiffSha256],
     ["branch/HEAD unchanged", before.branch === after.branch && before.head === after.head],
     ["worktree list unchanged", typeof before.worktrees === "string" && before.worktrees === after.worktrees],
     ["sibling worktree directories absent", Array.isArray(before.siblingWorktrees) && Array.isArray(after.siblingWorktrees)
       && same(before.siblingWorktrees, after.siblingWorktrees)],
    ["ignore files unchanged", same(before.ignores, after.ignores)],
    ["zero local state commits", before.localLog === after.localLog],
    ["remote refs unchanged", before.remoteRefs === after.remoteRefs],
  ].map(([check, ok]) => ({ check: String(check), ok: Boolean(ok), code: 5, detail: ok ? "pre-run and post-run snapshots agree (before probe)" : "forged: light fixture changed during agent interval" }))
}

/** Complete stopped-host tree counts; unavailable storage throws rather than
 * reporting zero. V2 assistant content has messageID; v1 step-start parts count
 * assistant turns, avoiding user/text part inflation. Tool counts include every
 * descendant (including grandchildren), not JSONL's parent-only projection. */
export function countReviewMetrics(db: string | undefined, parentID: string) {
  const store = readSessionStore(db, parentID)
  if (!store.available) throw new Error(store.reason)
  const toolCallsByTool: Record<string, number> = {}
  for (const session of [store.parent, ...store.descendants]) for (const part of session.parts) {
    if (part.type === "tool") toolCallsByTool[text(part.tool)] = (toolCallsByTool[text(part.tool)] ?? 0) + 1
  }
  const orchestratorTurns = store.schema === "v2" ? new Set(store.parent.parts.map(part => text(part.messageID)).filter(Boolean)).size
    : store.parent.parts.filter(part => part.type === "step-start").length
  return { childSessions: store.descendants.length, orchestratorTurns, toolCallsByTool }
}

/** Negative trace check after shutdown: the retired corvus_review_verify name is
 * forbidden, never a callable prerequisite. Missing DB evidence fails closed;
 * no host/mode or terminal disclosure bypasses this hard row. */
export function checkRetiredTools(tools: Tool[], evidenceError = ""): Row {
  const retired = tools.filter(tool => tool.name === ["corvus", "review", "verify"].join("_"))
  return { check: "retired tool absent", ok: !evidenceError && retired.length === 0, code: 5,
    detail: retired.length ? `forged: retired tool in trace (${retired.map(tool => `${tool.parentID}:${tool.index}`).join(", ")})` : evidenceError || "no retired tool calls" }
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
 * both stores as available final write_meta → release → push. Missing/failed
 * bookkeeping needs terminal disclosure; contradictions fail forged. A disclosed
 * failed push is a validated attempt after release. Only a DB-matched config
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
  root: string, acquired: Tool | undefined, released: Tool | undefined, metadata: RecordValue, metaRow: Row, candidateOptional = false, auditError = ""): { rows: Row[]; validatedPush?: Tool } {
  if (input.agent === "light") return { rows: checkLightSync(input, events, tools, parentID, root, acquired, auditError) }
  const rows: Row[] = []
  const add = (check: string, ok: boolean, detail: string, code = 5) => rows.push({ check, ok, code, detail })
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  let stored: Tool[] = [], files: string[] = [], evidenceError = ""
  try { stored = readParentTools(input.db, parentID); files = fixtureInventory(input) } catch (error) { evidenceError = String(error) }
  const matched = (tool: Tool | undefined) => {
    const evidence = storedToolEvidence(tool, stored, parentID)
    return evidence.kind === "matched" ? evidence.tool : undefined
  }
  const terminal = finalAssistantMessage(events, parentID), summary = terminal.text.replace(/[`*]/g, "")
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
  const orderWhenObserved = (first: Tool | undefined, second: Tool | undefined) => before(first, second)
    && (!matched(first) || !matched(second) || before(matched(first), matched(second)))
  const crossRepo = input.intake !== "local" && input.crossRepo === true
  const expectedPr = input.intake === "local" ? { name: input.repo, number: null, branch: input.branch }
    : { owner: input.owner, name: input.repo, number: Number(input.pr), isCrossRepository: crossRepo }
  const resolveOK = Boolean(!evidenceError && resolvedDB?.output.ok === true && sourceDB?.output.ok === true && inventoryDB?.output.ok === true
    && sourceDB.output.code_head === input.head
    && (input.intake === "local" ? input.crossRepo !== true : sourceDB.output.isCrossRepository === crossRepo)
    && resolvedDB.output.root === expectedRoot && resolvedDB.output.remote === "origin"
    && resolvedDB.output.task === (expectedRoot.startsWith(".corvus/tasks/") ? expectedRoot.split("/")[2] : null)
    && isDeepStrictEqual(resolved?.input.pr, expectedPr) && sameFiles(resolved?.input.changed_files)
    && sameFiles(inventoryDB.output[input.intake === "local" ? "changed_files" : "files"])
    && (input.intake === "local" || inventoryDB.output.complete_pagination === true && bothBefore(source, inventory))
    && bothBefore(inventory, resolved) && bothBefore(resolved, acquired) && lockDB)
  rows.push(bookkeepingRow("sync.resolve", { op: "sync.resolve", aliases: ["corvus_review_sync resolve", "sync"], summary,
    consistent: resolveOK, diagnostic: diagnostic(resolved), contradiction: storedToolEvidence(resolved, stored, parentID).kind === "contradicted"
      || completedOK(resolved) && !resolveOK ? "sync.resolve contradicts DB/layout/identity/inventory" : undefined,
    detail: evidenceError || `root=${expectedRoot}; metadata/local → unfiltered inventory → resolve → acquire (DB matched)` }))
  let disabled = false
  for (const tool of tools.filter(tool => tool.name === "corvus_review_pr" && tool.input.op === "config")) {
    const result = matched(tool)
    if (result?.output.ok === true && result.output.present === true && before(tool, resolved)) {
      try { disabled ||= record(load(text(result.output.yaml))).state_sync === false } catch {}
    }
  }
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
  const pullDB = matched(pulled)
  const pullOrder = Boolean(pulled && syncTarget(pulled) && (!resolved || orderWhenObserved(resolved, pulled)) && orderWhenObserved(pulled, acquired))
  const pullRefusal = pullDB?.output.synced === false && ["fork", "LOCAL-no-upstream"].includes(text(pullDB.output.reason))
  rows.push(bookkeepingRow("sync.pull", { op: "sync.pull", aliases: ["corvus_review_sync pull", "sync"], summary,
    consistent: disabled ? pullSkipped && skipNote : Boolean(crossRepo && pullSkipped || pulls.length === 1 && pullOrder
      && (pullDB?.output.synced === true || pullRefusal)), diagnostic: diagnostic(pulled),
    contradiction: pulls.some(tool => storedToolEvidence(tool, stored, parentID).kind === "contradicted") || pulls.length > 1
      || pulled && !pullOrder ? "sync.pull trace/target/order contradicts DB" : undefined,
    detail: disabled ? "state_sync:false: pull skipped with note" : crossRepo && pullSkipped ? "fork: pull skipped" : `pull=${pulled?.index ?? "missing"}; resolve → pull → acquire (DB matched)` }))
  const syncMetaOK = Boolean(metaDB?.output.ok === true && [metadata, record(metaWrite?.input.meta)].every(meta => meta.code_head === input.head
    && meta.head_sha === (sourceDB?.output.head_sha ?? sourceDB?.output.headRefOid) && /^[a-f0-9]{40}$/.test(text(meta.head_sha))
    && !Object.hasOwn(meta, "state_commit"))
    && tools.filter(tool => tool.name === "corvus_review_persist" && tool.input.op === "write_meta").every(tool => !Object.hasOwn(record(tool.input.meta), "state_commit")))
  rows.push(aggregateRow("sync metadata", [metaRow, bookkeepingRow("sync metadata", { op: "meta.yaml", aliases: ["write_meta", "metadata"], summary,
    consistent: syncMetaOK || !completedOK(metaWrite), contradiction: completedOK(metaWrite) && !syncMetaOK ? "sync metadata contradicts code_head/observed head_sha or contains state_commit" : undefined,
    detail: "meta.yaml and write_meta carry code_head + observed head_sha, never state_commit" })], "sync metadata consistent"))
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
  const pushOrder = Boolean(pushed && syncTarget(pushed)
    && pushed?.input.root === expectedRoot && pushed.input.head_sha === input.head && isDeepStrictEqual(pushed.input.pr, expectedPr)
    && (!finalMeta || orderWhenObserved(finalMeta, released)) && orderWhenObserved(released, pushed))
  const pushOK = disabled ? pushes.length === 0 && skipNote : Boolean(pushes.length === 1 && pushOrder && (refusalReason
    ? pushedDB?.output.synced === false && pushedDB.output.reason === refusalReason && !Object.hasOwn(pushedDB.output, "state_commit") : pushedDB?.output.synced === true))
  const pushRow = bookkeepingRow("sync.push", { op: "sync.push", aliases: ["corvus_review_sync push", "sync push", "sync"], summary,
    consistent: pushOK, diagnostic: diagnostic(pushed), contradiction: pushes.some(tool => storedToolEvidence(tool, stored, parentID).kind === "contradicted")
      || pushes.length > 1 || pushed && !pushOrder || pushedDB?.output.synced === true && !pushOK ? "sync.push trace/target/order contradicts DB"
      : !pushOK && /\bsynced\s*[:=]\s*true\b/i.test(summary) ? "terminal claims successful sync without a matching push receipt" : undefined,
    detail: disabled ? "state_sync:false: push skipped with note" : `final write_meta=${finalMeta?.index ?? "unavailable"} → release=${released?.index ?? "missing"} → push=${pushed?.index ?? "missing"}; ${JSON.stringify(pushedDB?.output ?? {})}` })
  rows.push(aggregateRow("sync.push", [pushRow, metaRow], pushRow.detail))
  const pushUnavailable = !disabled && !pushOK && !pushRow.detail.startsWith("forged:")
  const stateCommit = text(pushedDB?.output.state_commit)
  if (crossRepo) {
    add("fork bare unchanged", !gitError && tip === tipBefore && subjects.length === 0 && !stateCommit,
      gitError || `bare tip before=${tipBefore}; after=${tip}; ${subjects.length} new commits; state_commit=${stateCommit || "none"}`)
  } else {
    // A refused push can return a real LOCAL state commit. It is not a remote
    // receipt; audit its object/scope before inheriting the disclosed failure.
    let localReceiptOK = !stateCommit, localReceiptDetail = "no local state commit"
    if (pushUnavailable && stateCommit) {
      try {
        if (!/^[a-f0-9]{40}$/.test(stateCommit)) throw new Error("invalid local state_commit")
        const commit = git(input.fixture, "rev-parse", `${stateCommit}^{commit}`).trim()
        const localPaths = git(input.fixture, "diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", stateCommit, "--").split("\0").filter(Boolean)
        const subject = git(input.fixture, "show", "-s", "--format=%s", stateCommit, "--").trim()
        localReceiptOK = commit === stateCommit && localPaths.length > 0 && localPaths.every(path => path.startsWith(expectedRoot + "/") && !path.split("/").includes(".staging"))
          && subject === `corvus(review-state): ${expectedRoot.split("/").at(-1)} @ ${input.head.slice(0, 7)} [skip ci]`
        localReceiptDetail = `local state_commit=${stateCommit}; ${localPaths.length} scoped paths; not a remote receipt`
      } catch (error) { localReceiptOK = false; localReceiptDetail = String(error) }
    }
    const receiptOK = !gitError && (skipped ? tip === input.head && !stateCommit : stateCommit === tip && tip !== input.head)
    rows.push(pushUnavailable && !gitError && tip === input.head && localReceiptOK ? { ...pushRow, check: "sync receipt" }
      : { check: "sync receipt", ok: receiptOK, code: 5, detail: receiptOK ? `code_head=${input.head}; state_commit=${stateCommit || "none"}; bare tip=${tip}`
        : `forged: ${gitError || "sync receipt contradicts bare tip"}` })
    const subject = `corvus(review-state): ${expectedRoot.split("/").at(-1)} @ ${input.head.slice(0, 7)} [skip ci]`
    add("state commit scope", !gitError && (skipped || pushUnavailable && tip === input.head && localReceiptOK || subjects[0] === subject && paths.length > 0 && paths.every(path => path.startsWith(expectedRoot + "/") && !path.split("/").includes(".staging"))),
      gitError || (skipped ? "no state commit expected" : pushUnavailable ? localReceiptDetail : stat))
  }
  const stateSubjects = subjects.filter(subject => subject.startsWith("corvus(review-state):"))
  add("state commit count", !gitError && stateSubjects.length === (skipped || pushUnavailable && tip === input.head ? 0 : 1), gitError || `${stateSubjects.length} state commits in bare branch history${crossRepo ? " since pre-run tip" : ""}`)
  const pushArgvs = trace.filter(event => event.event === "start" && Array.isArray(event.argv) && event.argv.includes("push")).map(event => event.argv as string[])
  const shellPushes = checkModelShellPushes(allTools, auditError)
  const expectedPush = ["git", "push", "origin", `HEAD:${input.branch}`]
  /** Read stopped-host DB success and the bare-tip receipt before scoring, without
   * mutation. Only their agreement requires a trace; forged receipts fail code 5
   * in sync receipt. Skip routes require zero pushes, and shell/off-target pushes
   * always fail code 6. No mode disables those isolation checks. */
  const pushedToBare = pushOK && stateCommit === tip && tip !== input.head
  add("Git push isolation", !gitError && shellPushes.ok && (skipped ? pushArgvs.length === 0
    : (!pushedToBare || pushArgvs.length > 0) && pushArgvs.every(argv => isDeepStrictEqual([basename(argv[0]), ...argv.slice(1)], expectedPush))),
  gitError || `${pushArgvs.length} traced pushes: ${JSON.stringify(pushArgvs)}; ${shellPushes.detail}; github pushes must be zero`, 6)
  const syncSummaryOK = Boolean(released && terminal.index > released.index && (disabled ? skipNote
    : refusalReason ? refusalNote(crossRepo ? /\bfork\b/i : /\bno[- ]upstream\b/i)
    : /^[a-f0-9]{40}$/.test(stateCommit) && summary.split(/[.!?\n]+/).some(sentence =>
      /\b(?:state_commit|synchroni[sz]ed|synced|committed|pushed)\b/i.test(sentence)
      && [...sentence.matchAll(/\b[a-f0-9]{7,40}\b/g)].some(([sha]) => stateCommit.startsWith(sha)))))
  rows.push(pushUnavailable && released && terminal.index > released.index ? { ...pushRow, check: "sync terminal summary" }
    : { check: "sync terminal summary", ok: syncSummaryOK, code: 5, detail: "final summary carries state_commit or the explicit sync skip/refusal" })
  const legacy = join(input.fixture, ".corvus/reviews", reviewNamespace(input))
  add("new review root", !evidenceError && root === resolve(input.fixture, expectedRoot) && !existsSync(legacy), `${expectedRoot}; legacy root must not be created: ${legacy}`)
  if (input.intake !== "local") {
    const candidateAbsent = candidateOptional && !existsSync(join(root, "candidate.json"))
    const verdicts = tools.filter(tool => tool.name === "corvus_review_verdict" && tool.input.op === "compute"
      && typeof tool.input.reviewRoot === "string" && resolve(input.fixture, tool.input.reviewRoot) === root)
    const roundTool = verdicts.findLast(tool => matched(tool) && historyResult(tool.output))
    const failedVerdict = verdicts.findLast(tool => !completedOK(tool))
    let markerOK = candidateAbsent, v1 = false, contradiction: string | undefined
    try {
      const body = text(json(read(join(root, "candidate.json"))).body)
      const marker = body.split(/\r?\n/).map(line => parseReviewMarker(line)).find(Boolean)
      v1 = Boolean(marker && !marker.path && marker.head === input.head)
      markerOK = Boolean(marker?.path === expectedRoot && marker.head === input.head && roundTool && marker.round === roundTool.output.round)
      if (marker && (marker.head !== input.head || marker.path && (marker.path !== expectedRoot || !roundTool || marker.round !== roundTool.output.round)
        || v1 && roundTool)) contradiction = "candidate marker contradicts identity or available verdict round"
    } catch {}
    rows.push(bookkeepingRow("marker", { op: "verdict round", aliases: ["round", "verdict", "corvus_review_verdict", "history verdict"], summary,
      consistent: markerOK, diagnostic: diagnostic(failedVerdict), contradiction: contradiction ?? (!markerOK && !v1 && !candidateAbsent ? "candidate lacks an identity marker" : undefined),
      detail: candidateAbsent ? "R4 writer not-exposed: no retained candidate to mark" : "v2 marker agrees with resolved root, code_head and verdict round" }))
  }
  return { rows, validatedPush: pushRow.ok && pushOrder && !disabled ? pushed : undefined }
}

/** Trace2 is read after host shutdown, before scoring light mutation rows. Parse
 * global Git options (not arbitrary argv words), correlating def_repo/def_param
 * by sid. An explicit Git directory owns index/ref commands: the host's separate
 * XDG snapshot Git directory is outside the fixture even when its worktree is the
 * fixture. Worktree byte changes are independently caught by saved snapshots.
 * Only a proven outside target is excluded; missing target evidence counts as
 * fixture traffic and fails on mutation. Canonicalize existing path ancestors so
 * symlink spellings cannot excuse fixture traffic. No light flag disables this;
 * auto uses its unchanged oracle. Tracing cannot attest to a process that unsets it.
 */
export function lightFixtureMutations(trace: RecordValue[], fixture: string): RecordValue[] {
  const canonical = (path: string): string => {
    const absolute = resolve(path)
    if (existsSync(absolute)) return realpathSync(absolute)
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute))
  }
  const fixtureRoot = canonical(fixture)
  const inside = (path: string) => { const rel = relative(fixtureRoot, canonical(path)); return rel === "" || rel !== ".." && !rel.startsWith("../") }
  const contexts = new Map<string, { gitDir?: string; worktree?: string }>()
  for (const event of trace) {
    if (!text(event.sid)) continue
    const context = contexts.get(text(event.sid)) ?? {}
    if (event.event === "def_repo" && event.repo === 1 && text(event.worktree)) context.worktree = text(event.worktree)
    if (event.event === "def_param" && event.param === "GIT_DIR") context.gitDir = text(event.value)
    if (event.event === "def_param" && event.param === "GIT_WORK_TREE") context.worktree = text(event.value)
    contexts.set(text(event.sid), context)
  }
  return trace.filter(event => {
    if (event.event !== "start" || !Array.isArray(event.argv)) return false
    const argv = event.argv.map(text), context = contexts.get(text(event.sid))
    let cwd = fixtureRoot, gitDir = "", worktree = "", index = 1, changedCwd = false
    for (; index < argv.length; index++) {
      const arg = argv[index]
      if (!arg.startsWith("-")) break
      if (["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace"].includes(arg)) {
        const value = argv[++index] ?? ""
        if (arg === "-C") { cwd = resolve(cwd, value); changedCwd = true }
        if (arg === "--git-dir") gitDir = value
        if (arg === "--work-tree") worktree = value
      } else if (arg.startsWith("--git-dir=")) gitDir = arg.slice("--git-dir=".length)
      else if (arg.startsWith("--work-tree=")) worktree = arg.slice("--work-tree=".length)
      else if (arg.startsWith("-C")) { cwd = resolve(cwd, arg.slice(2)); changedCwd = true }
    }
    const command = argv[index], args = argv.slice(index + 1)
    const mutation = ["push", "commit", "checkout", "switch", "add", "update-index", "reset", "update-ref"].includes(command)
      || command === "stash" && !["list", "show"].includes(args[0])
      || command === "branch" && (args.some(arg => ["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--edit-description", "--set-upstream-to", "--unset-upstream"].includes(arg) || arg.startsWith("--set-upstream-to="))
        || args.length > 0 && !args.some(arg => ["--show-current", "--list", "-l", "-a", "--all", "-r", "--remotes", "--contains", "--no-contains", "--merged", "--no-merged"].includes(arg) || arg.startsWith("--format") || arg.startsWith("--sort")) && args.some(arg => !arg.startsWith("-")))
      || ["rm", "apply"].includes(command) && args.includes("--cached")
    if (!mutation) return false
    // Explicit global options win over environment/repository metadata. With a
    // separate Git dir, def_repo.worktree alone would misclassify host snapshots.
    const targetGitDir = gitDir || context?.gitDir
    if (targetGitDir) return inside(resolve(cwd, targetGitDir))
    const targetWorktree = worktree || context?.worktree
    if (targetWorktree) return inside(resolve(cwd, targetWorktree))
    return !changedCwd || inside(cwd)
  })
}

/** Light sync audit reads saved agent-interval snapshots/trace, not the fixture's
 * later probe-mutated HEAD. The model-free full push receipt is independently
 * checked against the bare commit; missing/malformed evidence fails hard. No
 * disclosure excuses mutation, unsafe targets or a light path in that commit. */
export function checkLightSync(input: Inputs, events: RecordValue[], tools: Tool[], parentID: string, root: string,
  acquired: Tool | undefined, auditError: string): Row[] {
  const summary = finalAssistantMessage(events, parentID).text, rows: Row[] = []
  const add = (check: string, ok: boolean, detail: string, code = 5) => rows.push({ check, ok, detail, code })
  const sync = tools.filter(tool => tool.name === "corvus_review_sync")
  const forbidden = sync.filter(tool => tool.input.op !== "resolve")
  for (const check of ["sync.pull", "sync metadata", "sync.push", "sync receipt", "sync terminal summary", "new review root"]) {
    rows.push(lightContractRow(check, summary, forbidden.length ? "light made forbidden sync pull/push calls" : undefined))
  }
  // Attempt-aware light controls score resolution, including pre-admission stops.
  try {
    const work = dirname(input.fixture)
    const before = JSON.parse(read(join(work, "light-before.json"))) as LightSnapshot
    const after = JSON.parse(read(join(work, "light-after.json"))) as LightSnapshot
    for (const snapshot of [before, after]) {
      if (!snapshot.branch || !/^[a-f0-9]{40}$/.test(snapshot.head) || !/^[a-f0-9]{64}$/.test(snapshot.cachedDiffSha256)
         || typeof snapshot.index !== "string" || typeof snapshot.indexFlags !== "string" || typeof snapshot.localLog !== "string" || typeof snapshot.remoteRefs !== "string"
         || typeof snapshot.worktrees !== "string" || !Array.isArray(snapshot.siblingWorktrees) || !snapshot.siblingWorktrees.every(name => typeof name === "string")
        || ![".smoke-light-staged", ".smoke-light-unstaged"].every(path => typeof snapshot.sentinels?.[path] === "string")
        || ![".gitignore", ".git/info/exclude"].every(path => Object.hasOwn(snapshot.ignores, path))) throw new Error("invalid light snapshots")
    }
    rows.push(...checkLightSnapshots(before, after))
    if (!input.bare || fixtureGit(input.fixture, "remote", "get-url", "--push", "--all", "origin").trim() !== input.bare
      || fixtureGit(input.fixture, "remote", "get-url", "--push", "--all", "github").trim() !== "DISABLED_PUSH_SENTINEL"
      || fixtureGit(input.fixture, "remote", "get-url", "github").trim() !== `https://github.com/${input.owner}/${input.repo}`) throw new Error("unsafe light fixture remotes")
    const trace = lines(read(join(work, "git-trace.jsonl"))).map(json)
    const mutations = lightFixtureMutations(trace, input.fixture)
    add("state commit scope", before.localLog === after.localLog && mutations.length === 0, "zero agent state commits/staging/checkout")
    add("state commit count", before.localLog === after.localLog, "0 new local commits during agent interval")
    add("Git push isolation", !auditError && mutations.length === 0 && before.remoteRefs === after.remoteRefs,
      `${mutations.length} traced fixture mutation commands; bare refs unchanged before probe`, 6)
    if (input.crossRepo) add("fork bare unchanged", before.remoteRefs === after.remoteRefs, "fork bare refs unchanged before probe")
    const probe = json(read(join(work, "light-push-probe.json")))
    const sha = text(probe.state_commit)
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("missing full push probe commit")
    const paths = fixtureGit(input.bare, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sha, "--").split("\0").filter(Boolean)
    add("mixed full push excludes light", probe.ok === true && probe.root === expectedRootForLight(input)
      && isDeepStrictEqual(paths, probe.paths) && paths.length > 0 && paths.every(path => path.startsWith(text(probe.root) + "/")
        && !isLightClassPath(path.replace(/^\.corvus\//, "")))
      && fixtureGit(input.bare, "rev-parse", `refs/heads/${input.branch}`).trim() === sha,
      `model-free state_commit=${sha}; paths=${JSON.stringify(paths)}`)
  } catch (error) {
     for (const check of ["sentinel bytes/index unchanged", "branch/HEAD unchanged", "worktree list unchanged", "sibling worktree directories absent", "ignore files unchanged", "zero local state commits",
      "remote refs unchanged", "state commit scope", "state commit count", "Git push isolation", "mixed full push excludes light",
      ...(input.crossRepo ? ["fork bare unchanged"] : [])]) if (!rows.some(row => row.check === check)) add(check, false, String(error), check === "Git push isolation" ? 6 : 5)
    // A late malformed receipt/unsafe-remote failure cannot leave the probe row green.
    if (rows.some(row => row.check === "mixed full push excludes light")) add("light sync evidence", false, String(error))
  }
  return rows
}
const expectedRootForLight = (input: Inputs) => inventoryRoot(input, fixtureInventory(input))

/** JSON-mode text parts belong to the assistant; select its last parent message,
 * never earlier progress or child prose. No step_finish prerequisite: stable v2
 * reconciles terminal text without emitting that event. Missing text stays absent,
 * so bookkeeping fails undisclosed unless the actual terminal text discloses it.
 * This selector neither reads DB text as a substitute nor manufactures CLI events. */
export function finalAssistantMessage(events: RecordValue[], parentID: string): { index: number; text: string } {
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

/** Terminal claims are checked against matched verdict output, not model arithmetic.
 * Explicit synthesis counts are permitted only as synthesis, never tool authority.
 * Structured counts/round/converged fields and tool-attributed prose are inspected
 * after shutdown; absent authority or unequal claimed values fail forged. A
 * severity-labelled number is a per-label claim, not an axis total; inspect every
 * claimed label up to the next axis. Bare numbers remain totals. No bypass. */
export function verdictClaimContradiction(summary: string, value?: RecordValue, historyRound?: number): string | undefined {
  let synthesis = false
  for (const line of noteClauses(summary)) {
    const note = normalizeNote(line).replace(/"/g, "")
    const attributed = /\b(?:tool[- ](?:produced|computed|derived)|(?:verdict|corvus_review_verdict) (?:tool )?(?:reports?|returned|computed|produced|counts|round|converged))\b/.test(note)
    if (!note || /^#/.test(note)) synthesis = false
    if (/\bsynthesis(?:[- ](?:derived|only))? counts?\b|\bcounts?\s*\(synthesis\)/.test(note)) synthesis = true
    const round = /\b(?:series_round|round)\s*(?:[:=]|is)?\s*(\d+)/.exec(note)
    const converged = /\bconverged\s*[:=]\s*(true|false)/.exec(note)
    if (round && !value && historyRound === undefined || converged && !value) return "terminal claims tool-produced round/convergence without a matched verdict"
    if (round && Number(round[1]) !== (value?.round ?? historyRound) || converged && (converged[1] === "true") !== value?.converged) return "terminal round/convergence contradicts verdict"
    if (synthesis && !attributed) continue
    const counts = /\b(?:counts|standards|spec|actionable_total)\s*[:=]\s*[\d{]/.test(note)
    const unavailableOnly = /\b(?:unavailable|failed|missing|no counts|no verdict)\b/.test(note) && !/\d|\btrue\b|\bfalse\b/.test(note)
    if (!unavailableOnly && (attributed && /\b(counts?|converg\w*)\b/.test(note) || counts) && !value) return "terminal claims tool-produced counts/round/convergence without a matched verdict"
    const claimedCounts = /\bcounts\s*[:=]\s*(\{.*\})/.exec(line.replace(/[`*]/g, ""))
    if (claimedCounts && value) {
      try { if (!isDeepStrictEqual(JSON.parse(claimedCounts[1]), value.counts)) return "terminal counts contradict verdict" }
      catch { return "terminal tool-count claim has no matching structured verdict counts" }
    }
    const axisClaims = [...note.matchAll(/\b(standards|spec)\s*[:=]\s*(\d+)/g)]
    for (const [index, claimed] of axisClaims.entries()) {
      if (!value) continue
      const axis = claimed[1], expected = record(record(value.counts)[axis])
      const rest = note.slice(claimed.index! + claimed[0].length, axisClaims[index + 1]?.index)
      if (new RegExp(`^\\s+(?:${labels.join("|")})\\b`).test(rest)) {
        for (const count of (claimed[2] + rest).matchAll(new RegExp(`(\\d+)\\s+(${labels.join("|")})\\b`, "g"))) {
          if (Number(count[1]) !== expected[count[2]]) return `terminal ${axis} ${count[2]} counts contradict verdict`
        }
      } else if (Number(claimed[2]) !== labels.reduce((sum, label) => sum + Number(expected[label]), 0)) return `terminal ${axis} counts contradict verdict`
    }
    const total = /\b(?:counts|total_findings)\s*[:=]\s*(\d+)/.exec(note)
    const actionable = /\bactionable_total\s*[:=]\s*(\d+)/.exec(note)
    if (value && (total && Number(total[1]) !== labels.reduce((sum, label) => sum + Number(record(record(value.counts).total)[label]), 0)
      || actionable && Number(actionable[1]) !== record(value.counts).actionable_total)) return "terminal total/actionable counts contradict verdict"
  }
}

/** File provenance is read after shutdown. Successful writes must match both DB
 * and final bytes; failed/missing writes require terminal disclosure. A disk or DB
 * contradiction cannot be excused. Lock/order validation is supplied by the owner
 * separately, so a disclosure never grants lock ownership or manual-write rights.
 * Calls are filtered to the expected reviewRoot by the owner. Resolve that root,
 * then append the expected file suffix without following symlinks below it: parent
 * aliases are valid, but an escaping file/directory link fails forged, with no bypass. */
function persistenceEvidence(check: string, op: string, aliases: string[], summary: string, calls: Tool[], stored: Tool[],
  parentID: string, fixture: string, path: string, orderOK: (tool: Tool) => boolean, content?: (tool: Tool, bytes: string) => boolean): Row {
  const last = calls.at(-1)
  const evidence = storedToolEvidence(last, stored, parentID)
  let consistent = false, contradiction: string | undefined
  if (calls.some(tool => storedToolEvidence(tool, stored, parentID).kind === "contradicted")) contradiction = `${op} trace contradicts DB`
  if (completedOK(last)) {
    try {
      const bytes = readFileSync(path)
      const root = resolve(fixture, text(last!.input.reviewRoot))
      const samePath = reportedPathMatches(fixture, last!.output.path, root, relative(root, path))
      const sha = createHash("sha256").update(bytes).digest("hex")
      const agrees = samePath && realpathSync(path) === join(realpathSync(root), relative(root, path)) && last!.output.sha256 === sha
        && orderOK(last!) && (!content || content(last!, bytes.toString("utf8")))
      if (!agrees) contradiction = `${op} successful result contradicts file, provenance or lock order`
      consistent = agrees && evidence.kind === "matched"
    } catch { contradiction = `${op} claimed successful write but artifact is missing/unreadable` }
  }
  if (!consistent && successClaim(summary, op, aliases.concat(op))) contradiction ??= `${op} success claimed without matching evidence`
  return bookkeepingRow(check, { op, aliases: [...aliases, ...(last ? [text(last.input.op)] : [])], summary, consistent,
    detail: `${op}=${last?.index ?? "missing"}; DB, canonical path, digest and owned-lock order agree`, diagnostic: diagnostic(last), contradiction })
}

/** Result-path oracle: the caller's expected suffix under the resolved review root,
 * read after shutdown without mutation. Resolve reported paths against the fixture
 * and follow parent aliases, but never resolve the expected suffix through a link.
 * A missing leaf may match a historical receipt; consumers still enforce their own
 * file-presence/content rules. Unresolvable parents, wrong paths and leaf symlinks
 * return false so consumers reject the receipt/producer match. No host or mode
 * disables this comparison. */
export function reportedPathMatches(fixture: string, reported: unknown, root: string, suffix: string): boolean {
  try {
    if (typeof reported !== "string") return false
    const path = resolve(fixture, reported)
    return join(realpathSync(dirname(path)), basename(path)) === join(realpathSync(root), suffix)
      && !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()
  } catch { return false }
}

/** Candidate finalize reports a digest, not a second comment list. Reconstruct
 * its ordered strings/anchors from DB-matched append inputs, then bind canonical
 * bytes to that digest and the file. Missing parts, duplicate identities, changed
 * counts, misplaced anchors and extra fields fail closed; no checkpoint is needed.
 * This pure, read-only reconstruction is also available to the writer-run gate. */
export function stagedCandidate(begin: Tool, appends: Tool[], final: Tool): RecordValue {
  const count = final.input.expected_comments
  if (begin.input.target !== "candidate" || !nonnegative(count)) throw new Error("invalid candidate staging header")
  const groups = new Map<string, Tool[]>()
  for (const tool of appends.filter(completedOK)) {
    const part = tool.input
    if (part.staging_id !== final.input.staging_id || typeof part.text !== "string"
      || !nonnegative(part.part) || !nonnegative(part.parts) || Number(part.parts) < 1 || Number(part.part) >= Number(part.parts)
      || !["body", "path"].includes(text(part.field))
      || (part.comment === undefined ? part.field !== "body" : !nonnegative(part.comment) || Number(part.comment) >= Number(count))
      || Object.keys(part).some(key => !["op", "reviewRoot", "staging_id", "field", "text", "part", "parts", "comment", "anchor"].includes(key))) throw new Error("invalid candidate append")
    const needsAnchor = part.comment !== undefined && part.field === "path" && part.part === 0
    if (Object.hasOwn(part, "anchor") !== needsAnchor || needsAnchor && Object.keys(record(part.anchor))
      .some(key => !["line", "side", "start_line", "start_side"].includes(key))) throw new Error("invalid candidate anchor")
    const key = `${part.comment ?? "root"}:${part.field}`
    groups.set(key, [...(groups.get(key) ?? []), tool])
  }
  const string = (key: string) => {
    const parts = (groups.get(key) ?? []).sort((a, b) => Number(a.input.part) - Number(b.input.part))
    if (!parts.length || parts.length !== parts[0].input.parts || parts.some((part, index) => part.input.part !== index
      || part.input.parts !== parts.length)) throw new Error(`incomplete candidate staging: ${key}`)
    return parts.map(part => text(part.input.text)).join("")
  }
  // The number of groups bounds allocation even for a forged enormous expected_comments.
  if (groups.size !== 1 + Number(count) * 2) throw new Error("incomplete candidate staging: comment order/count")
  return { commit_id: begin.input.commit_id, event: begin.input.event, body: string("root:body"),
    comments: Array.from({ length: Number(count) }, (_, comment) => ({
      ...record(groups.get(`${comment}:path`)?.find(tool => tool.input.part === 0)?.input.anchor),
      path: string(`${comment}:path`), body: string(`${comment}:body`),
    })) }
}

/** Replay DB-matched successful appends in DB order after shutdown, using native
 * staging semantics: document/input replace a part; candidate duplicates reject,
 * even if identical. Native merging, count/heading checks and serialization own
 * reconstruction. Every filesystem operation below is memory-only: neither reads
 * nor writes can reach retained evidence. Only the already-correlated root/staging
 * ID are relocated. The caller still checks real containment, DB/lock order and
 * final file digest. Rejected attempts supply no bytes; impossible success or a
 * mismatching final digest fails forged. No mode bypasses provenance or the
 * separate append-ceiling audit of all attempts. */
function stagedDigest(begin: Tool, appends: Tool[], final: Tool): string | undefined {
  const memory = new Map<string, Buffer | null>([["/audit", null]])
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }) }
  const entry = (path: string): Buffer | null => memory.has(path) ? memory.get(path)! : fail("ENOENT")
  const directory = (path: string) => { if (entry(path) !== null) fail("ENOTDIR") }
  const fs: ReviewPersistFs = {
    lstatSync: path => { entry(path); return { isSymbolicLink: () => false } },
    statSync: path => { const value = entry(path); return { isFile: () => value !== null, isDirectory: () => value === null } },
    realpathSync: path => { entry(path); return path },
    readFileSync: path => entry(path) ?? fail("EISDIR"),
    writeFileSync: (path, bytes) => {
      directory(dirname(path))
      if (memory.has(path)) fail("EEXIST")
      memory.set(path, Buffer.from(bytes))
    },
    renameSync: (from, to) => {
      entry(from); directory(dirname(to))
      for (const [path, value] of [...memory]) if (path === from || path.startsWith(from + "/")) {
        memory.delete(path); memory.set(to + path.slice(from.length), value)
      }
    },
    unlinkSync: path => { if (entry(path) === null) fail("EISDIR"); memory.delete(path) },
    mkdirSync: path => {
      directory(dirname(path))
      if (memory.has(path)) fail("EEXIST")
      memory.set(path, null)
    },
    linkSync: (from, to) => {
      directory(dirname(to))
      if (memory.has(to)) fail("EEXIST")
      memory.set(to, entry(from) ?? fail("EISDIR"))
    },
    rmSync: path => { for (const name of memory.keys()) if (name === path || name.startsWith(path + "/")) memory.delete(name) },
  }
  const reviewRoot = "/audit/.corvus/reviews/replay"
  const persist = createPersistExecutor("/audit/.corvus", { fs })
  const started = json(persist({ ...begin.input, reviewRoot }))
  if (started.ok !== true || typeof started.staging_id !== "string") return
  const location = { reviewRoot, staging_id: started.staging_id }
  for (const tool of appends.filter(completedOK).sort((a, b) => a.index - b.index)) {
    if (json(persist({ ...tool.input, ...location })).ok !== true) return
  }
  const result = json(persist({ ...final.input, ...location }))
  return result.ok === true ? text(result.sha256) : undefined
}

/**
 * Verdict oracle: matching orchestrator tool_use inputs and the same call's host-DB
 * result, plus final checkpoint/meta/verdict bytes, read after shutdown without mutations.
 * History omits both code_head and headSha; current identity is code_head ?? headSha.
 * Computation follows the document it summarizes; dispatch/decision timing is not
 * a prerequisite. DB/file/count contradictions fail forged; unavailable evidence
 * requires a terminal diagnostic. Synthesis-labelled counts are not tool claims.
 * Refusal still needs a terminal note; failed metadata cannot reinstate durability
 * as a prerequisite. Fixed verdict bytes ignore only persisted/computed_at, and
 * metadata supplies a pointer, never authoritative counts. No mode bypasses truth.
 */
function checkVerdict(input: Inputs, events: RecordValue[], tools: Tool[], parentID: string, root: string,
  documentWrite: Tool | undefined, released: Tool | undefined, metadata: RecordValue, persistedVerdict: RecordValue, verdictError: string,
  documentRow: Row, metaRow: Row): Row[] {
  if (input.agent === "light") {
    const summary = finalAssistantMessage(events, parentID).text
    const history = tools.findLast(tool => tool.name === "corvus_review_verdict" && !Object.hasOwn(tool.input, "code_head") && !Object.hasOwn(tool.input, "headSha"))
    let matched: Tool | undefined
    try { matched = matchedStoredTool(history, readParentTools(input.db, parentID), parentID) } catch {}
    const forbidden = tools.some(tool => tool.name === "corvus_review_verdict" && (Object.hasOwn(tool.input, "code_head") || Object.hasOwn(tool.input, "headSha")))
    const claim = verdictClaimContradiction(summary, undefined, historyResult(matched?.output ?? {}) ? Number(matched!.output.round) : undefined)
    return ["R0 verdict", "R4 verdict", "continuation note", "verdict persisted", "verdict document counts"].map(check =>
      lightContractRow(check, summary, claim ?? (forbidden ? "light computed a forbidden head verdict" : undefined)))
  }
  const rows: Row[] = []
  let stored: Tool[] = [], dbError = ""
  try { stored = readParentTools(input.db, parentID) } catch (error) { dbError = String(error) }
  const sameRoot = (tool: Tool) => typeof tool.input.reviewRoot === "string" && resolve(input.fixture, tool.input.reviewRoot) === root
  const verdictCalls = tools.filter(tool => tool.parentID === parentID && tool.name === "corvus_review_verdict" && sameRoot(tool) && tool.input.op === "compute")
  const matched = (tool: Tool | undefined) => matchedStoredTool(tool, stored, parentID)
  const terminal = finalAssistantMessage(events, parentID), note = terminal.text
  const history = verdictCalls.findLast(tool => !Object.hasOwn(tool.input, "code_head") && !Object.hasOwn(tool.input, "headSha"))
  const historyDB = matched(history)
  const historyShape = (value: RecordValue) => historyResult(value) && !Object.hasOwn(value, "counts")
  const historyRow = bookkeepingRow("R0 verdict", { op: "history verdict", aliases: ["R0 verdict", "corvus_review_verdict", "verdict"], summary: note,
    consistent: Boolean(historyDB && historyShape(historyDB.output)), diagnostic: diagnostic(history),
    contradiction: storedToolEvidence(history, stored, parentID).kind === "contradicted" ? "history verdict trace contradicts DB"
      : completedOK(history) && !historyShape(history!.output) ? "history verdict claimed success with invalid result" : undefined,
    detail: dbError || `history=${history?.index ?? "missing"}; matching DB history result (dispatch order is not a prerequisite)` })
  rows.push(historyRow)
  const head = verdictCalls.findLast(tool => (tool.input.code_head ?? tool.input.headSha) === input.head)
  const headDB = matched(head)
  const documentDB = matched(documentWrite)
  const headOK = Boolean(headDB && documentResult(headDB.output))
  const value = headOK ? headDB!.output : undefined, counts = record(value?.counts)
  const claim = verdictClaimContradiction(note, value, historyDB && historyShape(historyDB.output) ? Number(historyDB.output.round) : undefined)
  const headRow = bookkeepingRow("R4 verdict", { op: "head verdict", aliases: ["R4 verdict", "corvus_review_verdict", "verdict"], summary: note,
    consistent: headOK, diagnostic: diagnostic(head), contradiction: claim
      ?? (storedToolEvidence(head, stored, parentID).kind === "contradicted" ? "head verdict trace contradicts DB"
        : completedOK(head) && !documentResult(head!.output) ? "head verdict claimed success with invalid result"
        : headOK && documentWrite && (head!.index < documentWrite.index || documentDB && headDB!.index < documentDB.index) ? "head verdict precedes the document it summarizes" : undefined),
    detail: dbError || `head=${head?.index ?? "missing"}; document=${documentWrite?.index ?? "unavailable"}; DB result matched; no decision prerequisite` })
  rows.push(headRow)
  let document: RecordValue = {}, documentError = ""
  try { document = checkpoint(input) } catch (error) { documentError = String(error) }
  const metaWrite = tools.findLast(tool => tool.parentID === parentID && tool.name === "corvus_review_persist" && sameRoot(tool)
    && tool.input.op === "write_meta" && tool.input.headSha === input.head && (tool.input.name ?? "meta.yaml") === "meta.yaml")
  const refusedHistory = historyDB?.output.refuse_delta === true
  const refusalNote = /\brefuse_delta\s*[:=]\s*true\b/i.test(normalizeNote(note))
    || Boolean(text(historyDB?.output.refuse_reason).trim() && note.includes(text(historyDB?.output.refuse_reason)))
  const continuation = bookkeepingRow("continuation note", { op: "history continuation", summary: note,
    consistent: !refusedHistory || Boolean(released && terminal.index > released.index && refusalNote),
    contradiction: refusedHistory && completedOK(metaWrite) && (metadata.refuse_delta !== true || record(metaWrite?.input.meta).refuse_delta !== true)
      ? "persisted metadata contradicts history refuse_delta:true" : undefined,
    detail: refusedHistory ? "history refusal disclosed after release; metadata checked when available" : "history did not request a continuation note" })
  rows.push(aggregateRow("continuation note", [continuation, historyRow, ...(refusedHistory ? [metaRow] : [])], continuation.detail))
  const verdictFields = (result: RecordValue) => Object.fromEntries(Object.entries(result).filter(([key]) => !["persisted", "computed_at"].includes(key)))
  const verdictAgrees = Boolean(value && !verdictError
    && reportedPathMatches(input.fixture, value.persisted, root, join(input.head, "verdict.yaml"))
    && typeof persistedVerdict.computed_at === "string" && Number.isFinite(Date.parse(persistedVerdict.computed_at))
    && isDeepStrictEqual(verdictFields(persistedVerdict), verdictFields(value)))
  const persistedRow = bookkeepingRow("verdict persisted", { op: "verdict.yaml", summary: note, aliases: ["verdict persistence", "verdict"],
    consistent: verdictAgrees, diagnostic: diagnostic(head), contradiction: value && !verdictAgrees ? "successful verdict contradicts verdict.yaml"
      : value && completedOK(metaWrite) && (metadata.verdict_file !== "verdict.yaml" || record(metaWrite?.input.meta).verdict_file !== "verdict.yaml")
        ? "successful metadata contradicts verdict_file pointer" : undefined,
    detail: "fixed verdict.yaml matches DB result, ignoring only persisted/computed_at" })
  rows.push(aggregateRow("verdict persisted", [value ? persistedRow : headRow, metaRow], persistedRow.detail))
  if (!documentError) {
    const summary = record(document.summary)
    const statLabels = { blockers: "blocker", criticals: "critical", majors: "major", minors: "minor", nits_shown: "nitpick", praises: "praise", thoughts: "thought", notes: "note" }
    const statsAgree = (stats: RecordValue, group: RecordValue) => Object.entries(statLabels).every(([stat, label]) => stats[stat] === group[label])
      && stats.total_findings === labels.reduce((sum, label) => sum + Number(group[label]), 0)
      && stats.actionable === ["blocker", "critical", "major", "minor"].reduce((sum, label) => sum + Number(group[label]), 0)
    const agrees = value && document.verdict === (value.converged ? "converged" : "not_converged")
      && (!Object.hasOwn(document, "counts") || isDeepStrictEqual(document.counts, counts))
      && (!Object.hasOwn(record(document.synthesis_controls), "series_round") || record(document.synthesis_controls).series_round === value.round)
      && statsAgree(record(summary.stats), record(counts.total))
      && axes.every(axis => statsAgree(record(record(record(summary.by_axis)[axis]).stats), record(counts[axis])))
    const countRow = bookkeepingRow("verdict document counts", { op: "verdict document counts", summary: note, consistent: Boolean(agrees),
      contradiction: value && !agrees ? "REVIEW_DOCUMENT counts/round/convergence contradict DB verdict"
        : !value && /tool|verdict/.test(text(record(document.synthesis_controls).counts_source ?? document.counts_source))
          ? "REVIEW_DOCUMENT claims tool-produced counts without matched verdict" : undefined,
      detail: "REVIEW_DOCUMENT totals and both axes agree with DB verdict" })
    rows.push(aggregateRow("verdict document counts", [value || countRow.detail.startsWith("forged:") ? countRow : headRow, documentRow], countRow.detail))
  } else {
    const unreadable = documentWrite ? bookkeepingRow("verdict document counts", { op: "REVIEW_DOCUMENT.md", summary: note, consistent: false,
      contradiction: "successful checkpoint lacks a readable REVIEW_DOCUMENT", detail: documentError }) : documentRow
    rows.push(aggregateRow("verdict document counts", [unreadable, headRow], documentError))
  }
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
  /** Compatibility field: marker reviews are now required for every writer, even false. */
  requireReviews?: boolean
  /**
   * Expected transport: `blocked` (default) is the shim-blocked POST → `unknown`;
   * `head-moved` is the canned head moving after the writer's own GET so the post
   * tool's independent recheck returns `rejected`/`head-moved` and no POST is issued.
   */
  expect?: "blocked" | "head-moved"
  evidenceError?: string
}

/** Target-only parser for native patch and v1 apply_patch. The upstream 84c9be9
 * util/patch.ts envelope, optional heredoc/environment header, file headers and
 * update chunks are inspected before scoring; no patch is applied. Every source
 * and move destination is returned, or malformed/unsupported syntax rejects the
 * entire attempt. This deliberately does not prove a hunk applies to disk. */
function patchTargets(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("missing patch text")
  const source = value.trim().match(/^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/)?.[3] ?? value.trim()
  const lines = source.split(/\r?\n/)
  if (lines[0]?.trim() !== "*** Begin Patch" || lines.at(-1)?.trim() !== "*** End Patch") throw new Error("invalid patch envelope")
  const paths: string[] = []
  let i = 1
  if (/^\*\*\* Environment ID: \S/.test(lines[i]?.trim() ?? "")) i++
  const path = (value: string) => {
    if (!value.trim() || /[\0\r\n]/.test(value)) throw new Error("invalid patch path")
    paths.push(value.trim())
  }
  const boundary = (line: string) => /^\*\*\* (?:Add File|Update File|Delete File): /.test(line.trim()) || line.trim() === "*** End Patch"
  while (i < lines.length - 1) {
    const header = /^\*\*\* (Add File|Update File|Delete File): (.+)$/.exec(lines[i++].trim())
    if (!header) throw new Error("invalid patch header")
    path(header[2])
    const kind = header[1]
    if (kind === "Update File") {
      while (lines[i]?.trimEnd() === "*** End of File") i++
      if (lines[i]?.startsWith("*** Move to:")) path(lines[i++].slice("*** Move to:".length))
    }
    let body = 0, chunk = 0, marker = false, ended = false
    while (i < lines.length - 1 && !boundary(lines[i])) {
      const line = lines[i++], trimmed = line.trimEnd()
      if (kind === "Delete File" || kind === "Add File" && !line.startsWith("+")) throw new Error("invalid patch body")
      if (kind === "Update File") {
        if (trimmed === "@@" || trimmed.startsWith("@@ ")) {
          if (marker && !chunk) throw new Error("empty update chunk")
          marker = true; chunk = 0; ended = false
          continue
        }
        if (trimmed === "*** End of File") {
          if (!chunk) throw new Error("empty update chunk")
          ended = true
          continue
        }
        if (ended && !trimmed) continue
        if (ended || line !== "" && !/^[ +\-]/.test(line)) throw new Error("invalid update chunk")
      }
      body++; chunk++
    }
    if (kind === "Update File" && (!body || !chunk)) throw new Error("empty update")
  }
  if (!paths.length) throw new Error("empty patch")
  return paths
}

/**
 * Model-write oracle: parent CLI + DB and descendant inputs, inspected after shutdown without writes.
 * Any review-state target (including patch moves) fails, even for denied attempts;
 * unparseable write-family targets or unavailable DB evidence fail closed. No size,
 * disclosure or success flag bypasses it; callers supply reader errors explicitly.
 */
export function checkModelStateWrites(tools: Tool[], fixture: string, evidenceError = ""): Row {
  const violations = tools.filter(tool => {
    if (!["write", "edit", "apply_patch", "patch"].includes(tool.name)) return false
    let paths: string[]
    try { paths = ["apply_patch", "patch"].includes(tool.name) ? patchTargets(tool.input.patchText ?? tool.input.patch)
      : [text(tool.input.filePath ?? tool.input.file_path ?? tool.input.path)].filter(path => path.trim() && !path.includes("\0")) }
    catch { return true }
    return paths.length === 0 || paths.some(path => /(?:^|\/)\.corvus\/(?:tasks\/[^/]+\/)?reviews(?:\/|$)/.test(path.replaceAll("\\", "/"))
      || /(?:^|\/)\.corvus\/(?:tasks\/[^/]+\/)?reviews(?:\/|$)/.test(resolve(fixture, text(tool.input.workdir) || ".", path)))
  })
  return { check: "model state writes", ok: !evidenceError && violations.length === 0, code: 5,
    detail: violations.length ? `forged: model-written review state or unparseable write targets (${violations.map(tool => `${tool.parentID}:${tool.index} ${tool.name}`).join("; ")})` : evidenceError || "no model edit/write/patch targets in review state" }
}

/** Descendant sessions are read from the stopped host DB; unreadable trees throw, never count as empty evidence. */
export function readDescendants(db: string, parentID: string): ChildSession[] {
  const result = readSessionStore(db, parentID)
  if (!result.available) throw new Error(result.reason)
  return result.descendants.map(childSession)
}

/** Shell oracles: stopped-host parent/descendant inputs, read before scoring.
 * Native shell and legacy bash have identical command semantics. Missing DB
 * evidence fails closed, even with disclosure. Callers apply the orchestrator's
 * exact forms only to orchestrator sessions; writers use their own forms below.
 * No host/mode flag permits a model shell push, including a denied attempt. */
export function checkModelShellPushes(tools: Tool[], evidenceError = ""): Row {
  const pushes = tools.filter(tool => shell(tool) && (typeof tool.input.command !== "string"
    || !tool.input.command.trim() || /\bgit\b[\s\S]*\bpush\b/i.test(tool.input.command)))
  return { check: "model shell pushes", ok: !evidenceError && pushes.length === 0, code: 6,
    detail: pushes.length ? `${pushes.length} shell push or unparseable command attempts: ${pushes.map(tool => `${tool.parentID}:${tool.index} ${text(tool.input.command)}`).join("; ")}`
      : evidenceError || "zero model shell pushes" }
}

export function checkOrchestratorShell(tools: Tool[], input: Pick<Inputs, "fixture" | "owner" | "repo" | "pr" | "head" | "intake" | "branch" | "agent">, evidenceError = "", validatedHeads: string[] = []): Row {
  const allowed = new Set(["gh auth status", `gh pr checkout ${input.pr} --repo ${input.owner}/${input.repo} --detach`,
    "git rev-parse HEAD", "date -u +%Y-%m-%dT%H:%M:%SZ", `shasum -a 256 ${reviewRoot(input)}/post-request.json`])
  if (input.agent === "light") {
    allowed.delete(`gh pr checkout ${input.pr} --repo ${input.owner}/${input.repo} --detach`)
    const root = reviewRoot(input)
    allowed.delete(`shasum -a 256 ${root}/post-request.json`)
     for (const command of [`git ls-files -- ${root}/lock.yaml`, `git ls-files -- '${root}/lock.yaml'`, `git ls-files -- "${root}/lock.yaml"`, "git remote",
      `shasum -a 256 ${root}/${LIGHT_REVIEW_DIRECTORY}/post-request.json`]) allowed.add(command)
    for (const head of validatedHeads.filter(head => /^[a-f0-9]{40}$/.test(head))) {
      for (const expression of [`'${head}^{commit}'`, `"${head}^{commit}"`, `${head}^{commit}`]) allowed.add(`git cat-file -e ${expression}`)
    }
    for (const remote of ["origin", "github"]) for (const literal of [remote, `'${remote}'`, `"${remote}"`]) allowed.add(`git remote get-url ${literal}`)
     const remotes = new Set(["origin", "github", `https://github.com/${input.owner}/${input.repo}.git`])
     for (const tool of tools.filter(tool => shell(tool) && tool.state.status === "completed" && text(tool.input.command) === "git remote")) {
       for (const remote of lines(text(tool.state.output)).filter(remote => /^(?!-)[A-Za-z0-9._-]+$/.test(remote))) remotes.add(remote)
     }
     for (const remote of remotes) for (const literal of [remote, `'${remote}'`, `"${remote}"`]) {
       allowed.add(`git remote get-url ${literal}`)
       for (const ref of [`pull/${input.pr}/head`, `'pull/${input.pr}/head'`, `"pull/${input.pr}/head"`]) {
         allowed.add(`git fetch --no-tags ${literal} ${ref}`)
       }
    }
  }
  const forbidden = tools.filter(tool => shell(tool) && !allowed.has(text(tool.input.command)))
  return { check: "orchestrator GitHub reads", ok: !evidenceError && forbidden.length === 0, code: 5,
    detail: forbidden.length ? forbidden.map(tool => `${tool.parentID}:${tool.index} ${text(tool.input.command) || "unparseable shell command"}`).join("; ")
      : evidenceError || "zero orchestrator gh reads; only checkout/auth diagnostics permitted" }
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
 * after shutdown. Required in order: head, applicable anchor reads, marker reviews,
 * then corvus_review_post with the artifact descriptor and an unknown transport
 * result, plus the plugin's exact spawn argv blocked by the shim. An artifact
 * rejection instead requires no POST and the writer's verify-prefixed diagnostic.
 * Writer bash GitHub calls fail even when blocked. PR reads must precede post;
 * every session requires its own marker lookup, including body-only artifacts.
 * Body-only artifacts skip diff/anchor reads, not head or the repost marker check.
 * POST_RESULT uses all reported PR api_calls plus post tool_api_calls; invalid or
 * overflowing counts fail closed rather than entering arithmetic as NaN.
 * Missing/malformed evidence fails closed (dispatch supplies evidenceError for
 * unavailable child tools, including the shell row); a forwarded POST or a `posted` result is
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
  let payload: RecordValue = {}, artifactPath = ""
  try { payload = json(read(artifact)); artifactPath = realpathSync(artifact) } catch {}
  const postAttempts = input.tools.filter(tool => tool.name === "corvus_review_post")
  const post = postAttempts.find(tool => tool.state.status === "completed"
    && samePath(tool.input.artifactPath) && tool.input.expectedSha256 === input.digest
    && record(tool.input.repo).owner === input.owner && record(tool.input.repo).name === input.repo
    && tool.input.prNumber === Number(input.pr) && tool.input.headSha === payload.commit_id && tool.input.event === payload.event
    && Object.keys(tool.input).length === 6 && Object.keys(record(tool.input.repo)).length === 2)
  const bash = input.tools.filter(shell).map(tool => ({ tool, command: text(tool.input.command).trim() }))
  const postArgv = ["api", "--method", "POST", `repos/${input.owner}/${input.repo}/pulls/${input.pr}/reviews`, "--input", artifactPath, "-H", "Accept: application/vnd.github+json"]
  const audit = input.auditLines.flatMap(line => { try { return [json(line)] } catch { return [] } })
  const blockedPost = audit.find(entry => entry.marker === "CORVUS_SMOKE_MUTATION_BLOCKED" && entry.forwarded !== true && JSON.stringify(entry.argv) === JSON.stringify(postArgv))
  const forwardedPost = audit.find(entry => (entry.marker !== "CORVUS_SMOKE_MUTATION_BLOCKED" || entry.forwarded === true) && Array.isArray(entry.argv)
    && (entry.argv as unknown[]).some((arg, index) => (arg === "--method" || arg === "-X") && (entry.argv as unknown[])[index + 1] === "POST" || arg === "--method=POST" || arg === "-XPOST"))
  const transport = post?.output ?? {}
  const headMoved = input.expect === "head-moved"
  const artifactRejected = !headMoved && transport.outcome === "rejected" && /^artifact-verify-failed:.+/.test(text(transport.reason))
  const transportKeys = Object.keys(transport).every(key => ["outcome", "reason", "tool_api_calls"].includes(key))
  const transportOK = headMoved
    ? transport.outcome === "rejected" && transport.reason === "head-moved" && transport.tool_api_calls === 1 && transportKeys
    : artifactRejected ? transport.tool_api_calls === 0 && transportKeys
    : transport.outcome === "unknown" && text(transport.reason).trim().length > 0
      && Number.isSafeInteger(transport.tool_api_calls) && Number(transport.tool_api_calls) >= 2 && transportKeys
  // Head-moved mode: the shim served pull.moved.json to a head GET after the writer's own check, and no POST of any kind was issued.
  const movedHeadServed = audit.find(entry => entry.marker === "CORVUS_SMOKE_GH_CANNED" && entry.fixture === "pull.moved.json"
    && Array.isArray(entry.argv) && (entry.argv as unknown[]).includes(".head.sha"))
  const anyPost = audit.find(entry => Array.isArray(entry.argv) && (entry.argv as unknown[]).some((arg, index) => (arg === "--method" || arg === "-X") && (entry.argv as unknown[])[index + 1] === "POST" || arg === "--method=POST" || arg === "-XPOST"))
  const postDetail = forwardedPost ? `posting barrier breach: POST forwarded ${JSON.stringify(forwardedPost.argv)}`
    : !post || postAttempts.length !== 1 ? `${postAttempts.length} corvus_review_post call(s); require exactly one completed call after PR reads with the artifact descriptor`
    : !transportOK ? `invalid ${headMoved ? "head-moved" : "blocked"} TransportResult: ${JSON.stringify(transport)}`
    : artifactRejected ? `local artifact rejection: ${text(transport.reason)}; no POST permitted`
    : headMoved
      ? !movedHeadServed ? "corvus_review_post rejected head-moved but the shim audit shows no pull.moved.json served to a head GET"
        : anyPost ? `head-moved rejection must issue no POST; audit shows ${JSON.stringify(anyPost.argv)}`
        : `corvus_review_post at event ${post.index}; outcome=rejected head-moved (tool_api_calls=1); shim served pull.moved.json to the tool's head GET; no POST in audit`
      : !blockedPost ? "corvus_review_post call present but no blocked shim audit record for plugin argv"
      : `corvus_review_post at event ${post.index}; outcome=unknown; shim audit: CORVUS_SMOKE_MUTATION_BLOCKED ${JSON.stringify(postArgv)}`
  add("writer POST attempted", postAttempts.length === 1 && Boolean(post) && transportOK && !forwardedPost
    && (artifactRejected ? !anyPost : headMoved ? Boolean(movedHeadServed) && !anyPost : Boolean(blockedPost)), forwardedPost ? 6 : 5, postDetail)
  const prCalls = input.tools.filter(tool => tool.name === "corvus_review_pr")
  const validRead = (tool: Tool) => tool.state.status === "completed" && tool.input.owner === input.owner
    && tool.input.name === input.repo && String(tool.input.pr) === input.pr
    && ["head", "diff", "files", "reviews"].includes(text(tool.input.op))
    && Object.keys(tool.input).every(key => ["op", "owner", "name", "pr", ...(tool.input.op === "files" ? ["paginate"] : [])].includes(key))
    && Number.isSafeInteger(tool.output.api_calls) && Number(tool.output.api_calls) >= 0
  const head = prCalls.find(tool => validRead(tool) && tool.input.op === "head" && tool.output.ok === true
    && tool.output.code_head === payload.commit_id && post && tool.index < post.index)
  const diff = prCalls.find(tool => validRead(tool) && tool.input.op === "diff" && tool.output.ok === true
    && head && tool.index > head.index && post && tool.index < post.index)
  const files = prCalls.find(tool => validRead(tool) && tool.input.op === "files" && tool.input.paginate === true
    && tool.output.ok === true && tool.output.complete_pagination === true && Array.isArray(tool.output.files)
    && diff && tool.index > diff.index && post && tool.index < post.index)
  const inline = Array.isArray(payload.comments) && payload.comments.length > 0
  const diffOK = diff && (diff.output.oversized === false && typeof diff.output.text === "string" || files)
  const reviews = prCalls.filter(tool => tool.input.op === "reviews")
  const reviewsOK = reviews.length === 1
    && reviews.every(tool => validRead(tool) && typeof tool.output.ok === "boolean" && head && tool.index > head.index
      && (!inline || diff && tool.index > diff.index) && post && tool.index < post.index)
  const retired = checkRetiredTools(input.tools)
  const readsOK = Boolean(head) && (!inline || Boolean(diffOK)) && prCalls.every(validRead) && reviewsOK && retired.ok
  // Bind the POST row itself to head → marker lookup → post.
  if (!readsOK && rows[0].ok) { rows[0].ok = false; rows[0].detail = "post lacks ordered writer head/anchor/marker reads" }
  add("writer PR reads", readsOK, 5,
    !retired.ok ? retired.detail : `head=${head?.index ?? "missing"}, diff=${diff?.index ?? "skipped/missing"}, files=${files?.index ?? "unused/missing"}, reviews=${reviews.length} (required); post=${post?.index ?? "missing"}; ${prCalls.length} structured PR calls`)
  // The frontmatter's JSON validators on the exact artifact path are permitted read fallbacks
  // (informational); any digest/size measurement or other off-form command fails the writer.
  const validatorForms = [`jq . ${artifactRel}`, `python3 -m json.tool ${artifactRel}`]
  const validators = bash.filter(({ command }) => validatorForms.includes(command))
  const offForm = bash.filter(({ command }) => !validatorForms.includes(command))
  const measurement = offForm.filter(({ command }) => /^(?:shasum|sha256sum|sha\d*sum|openssl|md5|md5sum|cksum|wc|stat|du|jq|python3?)\b/.test(command))
  add("writer shell discipline", !input.evidenceError && offForm.length === 0, 5, input.evidenceError || (offForm.length === 0
    ? `${bash.length} shell call(s): no GitHub shell calls, ${validators.length} granted JSON validator(s) (informational); no shell measurement`
    : `${measurement.length} shell measurement/diagnostic command(s), ${offForm.length - measurement.length} other off-form command(s): ${offForm.map(({ tool, command }) => `event ${tool.index}: ${command}`).join("; ")}`))
  const result = input.resultOutput && typeof input.resultOutput.status === "string" ? input.resultOutput : extractPostResult(input.texts)
  const status = text(result.status)
  const remote = text(result.remote_state)
  const calls = writerApiCalls(input.tools)
  const resultKeys = ["status", "remote_state", "review_url", "reason", "inline_comments_posted", "comments_moved_to_body", "api_calls"]
  // Mapping table (writer step 7): unknown → local_only/unknown; rejected without http_status → local_only/not_posted with the tool reason verbatim.
  const expectedRemote = headMoved || artifactRejected ? "not_posted" : "unknown"
  const resultOK = status === (artifactRejected ? "not_posted" : "local_only") && remote === expectedRemote && result.review_url === null
    && transportOK && result.reason === (artifactRejected ? `verify: ${text(transport.reason)}` : transport.reason)
    && result.inline_comments_posted === 0 && result.comments_moved_to_body === 0
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
 * freeze and own a distinct child; every child's tool path is scored.
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
      requireReviews: index > 0, evidenceError: childError || (!child ? "unavailable writer session evidence" : "") })
    return { tool, child, result, rows }
  })
  const matchedChildren = executions.flatMap(execution => execution.child ? [execution.child] : [])
  const sessionsOK = matchedChildren.length === attempts.length && children.length === attempts.length
    && new Set(matchedChildren.map(child => child.id)).size === attempts.length
  const row: Row = { check: "writer dispatched", ok: Boolean(dispatch) && attempts.every(completed) && sessionsOK
    && attempts.length <= (input.maxDispatches ?? 1), code: 5,
    detail: !input.db ? "host DB path not supplied (--db)"
      : dispatch && sessionsOK ? `${attempts.length} writer dispatch(es) (limit ${input.maxDispatches ?? 1}, after freeze ${input.afterIndex}); ${executions.map(({ tool, child }) => `event ${tool!.index} ${text(tool!.state.status)} → child session ${child!.id} (${child!.tools.length} tool calls)`).join("; ")}`
      : !dispatch ? (attempts.length ? `${attempts.length} writer dispatch(es) without a completed result after freeze: ${attempts.map(tool => `event ${tool.index} status=${text(tool.state.status)}${tool.state.error ? " error=" + diagnostic(tool) : ""}`).join("; ")}` : "no writer dispatch by the parent")
      : childError || `no pr-comment-writer child session under ${input.parentID || "(unknown parent)"} uniquely matching every dispatch in ${input.db}` }
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

/** Scoped GET /api/plugin oracle shared by the two v2 smoke preflights and the
 * stopped-host artifact gate. Capture after location initialization, refresh after
 * model execution, and read before declaring success. Only absence may be polled;
 * malformed, wrong-location, duplicate, failed or non-server entries fail closed.
 * No v2 mode disables this check. Logs separately veto a formerly active snapshot. */
export function checkPluginState(path: string | undefined, location: string | undefined): { ok: boolean; absent: boolean; detail: string } {
  try {
    if (!path || !location) throw new Error("scoped plugin-state path and location are required")
    const body = json(read(path))
    if (record(body.location).directory !== location || !Array.isArray(body.data)) {
      return { ok: false, absent: false, detail: "wrong location or malformed plugin response: " + JSON.stringify(body) }
    }
    const entries = body.data.map(record).filter(plugin => plugin.id === "corvus")
    if (!entries.length) return { ok: false, absent: true, detail: "corvus absent" }
    return { ok: entries.length === 1 && record(entries[0].state).status === "active" && record(entries[0].features).server === true,
      absent: false, detail: JSON.stringify({ location: body.location, plugins: entries }) }
  } catch (error) {
    return { ok: false, absent: false, detail: String(error) }
  }
}

/**
 * Plugin evidence oracle: host-captured debug-agent JSON, scoped state and logs, read before
 * model dispatch by preflight and after shutdown by the artifact gate. Missing
 * or malformed required evidence, or an explicit load failure, fails closed for
 * both consumers. V1 requires the installed agent identity, tools and permissions;
 * its load marker is diagnostic only. V2 requires the marker AND active server state
 * at the fixture location; any transform-disable log overrides that snapshot. No flag disables
 * evidence validation; --host selects the host's oracle, not a bypass.
 */
export function checkPluginLoaded(input: Pick<Inputs, "host" | "hostlog" | "agents" | "install" | "writer" | "agent"> & Partial<Pick<Inputs, "fixture" | "pluginState">>): Row {
  const agentName = input.agent === "light" ? "corvus-review-light" : "corvus-review-auto"
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
        ["name", agent.name === agentName],
        ["native=false", agent.native === false],
        ["Corvus prompt", text(agent.prompt).startsWith(input.agent === "light" ? "# Corvus Review Light" : "# Corvus Review Auto")],
        ["review tools", ["corvus_review_payload", "corvus_review_post", "corvus_review_persist", "corvus_review_lock", "corvus_review_pr", "corvus_review_verdict", "corvus_review_sync", ...(input.agent === "light" ? ["corvus_review_worktree"] : [])].every(name => tools[name] === true)
          && tools[["corvus", "review", "verify"].join("_")] !== true],
        [input.writer ? "writer allow" : "writer deny", input.writer ? writerRule(agent) === "allow" : writerDenyRule(agent)],
        ["sandbox install permission", rules.some(rule => rule.pattern === install || text(rule.pattern).startsWith(install + "/"))],
      ]
      const missing = checks.filter(([, passed]) => !passed).map(([name]) => name)
      ok = missing.length === 0
      detail = `agents.json: ${ok ? `installed ${agentName} evidence verified` : "missing/invalid " + missing.join(", ")}`
    } catch (error) {
      ok = false
      detail = `agents.json: ${String(error)}`
    }
    detail += `; loading plugin markers: ${loading.length} (diagnostic only)`
  } else {
    const state = checkPluginState(input.pluginState, input.fixture)
    ok = ok && state.ok
    detail += `; plugin-state: ${state.detail}`
    if (/disabled plugin after transform failure/i.test(log)) {
      ok = false
      detail += "; explicit plugin transform-disable in host.log"
    }
  }
  if (/failed to load plugin/i.test(log)) {
    ok = false
    detail += "; explicit plugin load failure in host.log"
  }
  return { check: "plugin loaded", ok, code: 3, detail }
}

/**
 * The stopped host's tool events, logs, and persisted bytes are the gate oracles,
 * read after service shutdown and before any PASS. Bookkeeping uses ADR-0006
 * disclosure/contradiction precedence; integrity evidence fails closed. Blocked gh calls
 * are informational, but forwarded mutations and successful writer calls fail.
 * This attests to observed gh traffic, not traffic bypassing the PATH shim.
 * Intake selects evidence, not a bypass: branch adds a DB-matched find result
 * before metadata; LOCAL replaces posting checks with tool-owned local state,
 * a final path/count summary and zero writer/post/candidate/payload attempts.
 * LOCAL also fails on blocked mutation attempts; PR runs report those as expected
 * barrier evidence. All modes retain write auditing and owned-lock cleanup.
 */
/**
 * Full-review row inventory (names, not execution-order pins; unchanged for auto):
 * Base (all intakes): JSONL; background-dispatch; plugin loaded; invoked agent;
 * host/provider; host/auth; fixture identity; child tool evidence; retired tool absent;
 * document staged; verified facts tool; append ceiling; input route; model state writes;
 * review inventories; orchestrator GitHub reads; checkpoint writes; checkpoint-failed route;
 * sync.resolve; sync.pull; sync metadata; sync.push; state commit count; Git push isolation;
 * sync terminal summary; new review root; metadata; R0 verdict; R4 verdict;
 * continuation note; verdict persisted; verdict document counts; lock released;
 * review-input lines; review-state tools; artifacts; GitHub barrier; unexpected denials.
 * Non-fork: sync receipt; state commit scope. Fork instead: fork bare unchanged.
 * Branch intake: find resolved.
 * PR: marker; candidate producer; tool chain; SHA-256; built verify().
 * PR denied/not-exposed writer route: writer denied.
 * PR writer-execution route: writer dispatched; writer POST attempted; writer PR reads;
 * writer shell discipline; writer result; R5 PR transport.
 * LOCAL instead of PR/writer rows: LOCAL no writer; LOCAL no posting tools; LOCAL terminal summary.
 * On-fit (PR, any freeze reports fitted:true): size fit (once per run).
 * checkWriterExecution emits the four writer rows after writer dispatched above;
 * checkWriterDispatch adds writer dispatched and combines repeated sessions by row name.
 * Exit precedence remains 6 (posting barrier), 3 (host), 4 (fixture), 5 (evidence), else 0.
 * N/A-PASS does not remove a row. There is no blanket checkpoint-failed row waiver.
 * Light adds: light detector roster; light attempt controls; light presentation
  * integrity; light staging cleanup; posting artifacts; owned state writes; light
  * worktree route; light render structure; light coverage/action; light metrics;
  * light class isolation and the snapshot/probe rows (including worktree leaks).
 * Light terminal routes omit unproduced presentations through bookkeepingRow;
 * aggregates propagate contradictions before N/A. Its writer harness stays denied.
 */
type LightAttempt = { number: number; head: string; base: string; firstDispatch: Tool; dispatch: Tool; dispatches: Tool[]; metadata: Tool; end: number }
type LightPresentation = { attempt: LightAttempt; producer: Tool; value: RecordValue; frozen?: Tool; preview?: Tool; digest?: string }

/** The frozen/posted body is read before scoring, never reconstructed to bless it.
 * These expressions mirror the skill's sole literal template; its extracted,
 * instantiated template is a regression oracle. Missing structure fails closed.
 * LOCAL changes only the title identity. Auto never consumes this predicate. */
export function lightRenderErrors(body: string, local = false, comments?: CandidateRequest["comments"], locator?: { owner: string; repo: string; pr: string }): string[] {
  const errors: string[] = []
  const content = body.split(/\r?\n/).slice(1).join("\n")
  const title = local ? /^## Corvus Light Review — .+$/m : /^## Corvus Light Review — #\d+ .+$/m
  if (!title.test(content) || !content.startsWith("## Corvus Light Review — ")) errors.push("missing literal opening heading")
  if (!/^\*\*(COMMENT|REQUEST_CHANGES) · `[a-f0-9]{7}` · (\d+|null) files, \+(\d+|null)\/−(\d+|null) · Standards \d+ · Spec \d+ · inline \d+\*\*$/m.test(content)) errors.push("missing literal action/count line")
  const axes = [...content.matchAll(/^## (Standards|Spec)\n\*\*[^\n]+\*\* · [^\n]+$/gm)]
  if (axes.length !== 2 || axes[0]?.[1] !== "Standards" || axes[1]?.[1] !== "Spec"
    || [...content.matchAll(/^## (Standards|Spec)$/gm)].length !== 2) errors.push("missing ordered axis headlines/counts")
  if (/reduced[ -]coverage\s+(?:light )?review|generic reduced.coverage|\[!WARNING\]/i.test(content)) errors.push("generic light banner retained")
  if (/^(?:[-*] )?(?:reviewed|inspected|selected|omitted|unavailable)[ _-]*(?:paths|files|scope inventory)\s*[:=]|^(?:assessment|strategy|evidence_reads|reviewed_scope|trigger|impact|introduced_by_pr|narrow_fix|evidence)\s*:/im.test(content)) errors.push("local inventory/evidence fields rendered")
  if ([...content.matchAll(/^(#{1,6}) Review limits\s*$/gm)].some(match => match[1] !== "##")) errors.push("Review limits must be review-wide")
  const limits = content.split(/^## Review limits\s*$/m)
  if (limits.length > 2 || limits.length === 2 && (lines(limits[1]).length > 3 || lines(limits[1]).some(line => !/^- \S/.test(line)))) errors.push("Review limits exceeds three factual bullets")
  const findingLines = [...content.matchAll(/^\*\*.*\*\* \((?:standards|spec)\/[^\n]*$/gm)]
  for (const [index, finding] of findingLines.entries()) {
    const line = finding[0]
    if (!/^\*\*(?:blocker|critical|major|minor|praise|thought|note)\*\* \((standards|spec)\/(architecture|correctness|conventions|security), (?:ls|lsp)[1-9]\d*-(?:arch|logic|conv|sec)-(?:standards|spec)-\d{3}\): \S.{0,79}$/.test(line)) errors.push("invalid compact finding identity")
    const axis = /\((standards|spec)\//.exec(line)?.[1]
    const position = finding.index, standards = axes[0]?.index ?? Infinity, spec = axes[1]?.index ?? Infinity
    if (axis === "standards" ? position < standards || position > spec : position < spec) errors.push("finding in wrong axis section")
    if (index > 0 && findingLines[index - 1][0].includes(`(${axis}/`) && !/\n[\t ]*\n$/.test(content.slice(0, position))) errors.push("consecutive body findings lack blank-line separation")
  }
  const indexes = [...content.matchAll(/^- \*\*([^\n]+?)\*\* · \[`([^`\n]+)`\]\(([^\n]+?)\) — ([^\n]+)$/gm)]
  if (local && indexes.length) errors.push("LOCAL has inline index links")
  // Candidate comments are the oracle before freeze; fitted artifacts have no
  // comments and are checked structurally only (the mechanical fitter owns bytes).
  // Every surviving inline must have exactly one matching index in its axis;
  // absent/malformed anchors fail regardless of omissions or detector errors.
  if (comments) {
    const matched = new Set<number>()
    for (const comment of comments) {
      const identity = /^\*\*(blocker|critical|major|minor|praise|thought|note)\*\* \((standards|spec)\/(?:architecture|correctness|conventions|security), ((?:ls|lsp)[1-9]\d*-(?:arch|logic|conv|sec)-(?:standards|spec)-\d{3})\): (\S.{0,79})$/m.exec(comment.body)
      if (!identity || comment.side !== "RIGHT") { errors.push("invalid inline finding identity/side"); continue }
      const start = comment.start_line ?? comment.line
      const location = `${comment.path}:${start === comment.line ? start : `${start}–${comment.line}`}`
      const anchor = `diff-${createHash("sha256").update(comment.path).digest("hex")}R${start}${start === comment.line ? "" : `-R${comment.line}`}`
      const expectedURL = locator ? `https://github.com/${locator.owner}/${locator.repo}/pull/${locator.pr}/files#${anchor}` : null
      const matches = indexes.flatMap((index, i) => index[1] === identity[1] && index[2] === location && index[4] === identity[4]
        && (expectedURL ? index[3] === expectedURL : /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/files#/.test(index[3]) && index[3].endsWith(`#${anchor}`)) ? [i] : [])
      if (matches.length !== 1 || matched.has(matches[0])) { errors.push("inline finding lacks unique exact index link"); continue }
      matched.add(matches[0])
      const position = indexes[matches[0]].index
      if (identity[2] === "standards" ? position < (axes[0]?.index ?? Infinity) || position > (axes[1]?.index ?? Infinity) : position < (axes[1]?.index ?? Infinity)) errors.push("inline index in wrong axis section")
      if (findingLines.some(finding => finding[0].includes(`, ${identity[3]}):`))) errors.push("inline finding detail duplicated in body")
    }
    if (matched.size !== indexes.length) errors.push("unmatched inline index link")
  }
  return errors
}

/** Trusted prompt keys and terminal-ledger fields are read before route scoring.
 * Decode quoted JSON or bare colon/equal forms, stripping presentation wrappers
 * and terminal prose punctuation without normalizing owned paths;
 * duplicate/missing/mismatched values fail closed at consumers. Presence is
 * checked separately on fallback routes, including malformed/empty values.
 * The skill owns the literals; these light-only parsers have no override. */
const lightFieldPresent = (value: string, key: string) => new RegExp(`\\b${key}"?\\s*[:=]`, "i").test(value)
function lightFieldValues(value: string, key: string): string[] {
  const pattern = new RegExp(`\\b${key}"?\\s*[:=]\\s*("(?:\\\\.|[^"\\\\])*"|[^;,\\r\\n]*?)(?=\\s+\\b[a-z_]+"?\\s*[:=]|[;,\\r\\n]|\\s*}|$)`, "gi")
  return [...value.matchAll(pattern)].map(match => {
    const raw = match[1].trim().replace(/[.,)]+$/, "")
    try { return raw.startsWith('"') ? text(JSON.parse(raw)) : raw.replace(/^[`']+|[`'".,)]+$/g, "") } catch { return "" }
  })
}

/** Trusted JSON path arrays are decoded before roster validation, never executed.
 * Missing, duplicate or non-string paths fail the roster; no size setting disables
 * disjointness or coverage. The complete intake listing is the coverage oracle. */
function lightFocusPaths(prompt: string): string[] | null {
  const arrays = [...prompt.matchAll(/\bfocus_paths"?\s*[:=]\s*(\[(?:[^\]"\\]|"(?:\\.|[^"\\])*")*\])/g)]
  if (arrays.length !== 1) return null
  try {
    const paths: unknown = JSON.parse(arrays[0][1])
    return Array.isArray(paths) && paths.every(path => typeof path === "string" && path && !path.startsWith("/")
      && !path.split("/").some(part => ["", ".", ".."].includes(part))) && new Set(paths).size === paths.length ? paths : null
  } catch { return null }
}

/** Decode in-session authorization objects, not child prose or summary claims. */
function lightObjects(value: string): RecordValue[] {
  const result: RecordValue[] = []
  for (let start = 0; start < value.length; start++) {
    if (value[start] !== "{") continue
    let depth = 0, quoted = false, escaped = false
    for (let end = start; end < value.length; end++) {
      const char = value[end]
      if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false }
      else if (char === '"') quoted = true
      else if (char === "{") depth++
      else if (char === "}" && --depth === 0) {
        try { result.push(json(value.slice(start, end + 1))) } catch {}
        start = end
        break
      }
    }
  }
  return result
}

/** Light-only replay oracle: correlated stopped-host controls establish attempt
 * heads/bases and terminal routes before summary accounting or retained bytes are
 * scored. Each revision is reconstructed from its own producer and freeze; only
 * the last producers are compared to disk. Missing/unequal DB controls, stale
 * authorization and work after a terminal decision fail closed. Summary prose
 * cannot select a route or excuse an integrity failure. Auto never calls this. */
export async function checkLightAttempts(input: Inputs, events: RecordValue[], tools: Tool[], stored: Tool[],
  descendants: ChildSession[], parentID: string, root: string, evidenceError = "") {
  const rows: Row[] = [], errors: string[] = [], presentationErrors: string[] = []
  const add = (check: string, ok: boolean, detail: string, code = 5) => rows.push({ check, ok, detail, code })
  const terminal = finalAssistantMessage(events, parentID), summary = terminal.text
  const local = input.intake === "local", relativeRoot = relative(resolve(input.fixture), root)
  const candidate = join(root, ".light/candidate.json"), artifact = join(root, ".light/post-request.json")
  const samePath = (value: unknown, path: string) => typeof value === "string" && resolve(input.fixture, value) === path
  const ok = (tool: Tool | undefined) => completedOK(tool)
  const correlated = (tool: Tool | undefined) => !!tool && storedToolEvidence(tool, stored, parentID).kind === "matched"
  const control = (tool: Tool) => tool.name.startsWith("corvus_review_") || ["task", "subagent", "bash", "shell"].includes(tool.name)
  const controls = tools.filter(control), dbControls = stored.filter(control)
  if (evidenceError) errors.push(evidenceError)
  if (controls.some(tool => !correlated(tool)) || dbControls.length !== controls.length
    || controls.some((tool, index) => dbControls[index]?.callID !== tool.callID)) errors.push("missing, unequal, extra or reordered DB control evidence")
  const prCall = (tool: Tool, op: string) => tool.name === "corvus_review_pr" && tool.input.op === op
    && tool.input.owner === input.owner && tool.input.name === input.repo && String(tool.input.pr) === input.pr
  const oid = (value: unknown) => /^[a-f0-9]{40}$/.test(text(value))
  const metadata = tools.filter(tool => prCall(tool, "metadata") && correlated(tool) && ok(tool)
    && tool.output.number === Number(input.pr) && text(tool.output.url).toLowerCase() === `https://github.com/${input.owner}/${input.repo}/pull/${input.pr}`.toLowerCase())
  const isTerminal = (tool: Tool) => ["CLOSED", "MERGED"].includes(text(tool.output.state).toUpperCase())
  const validOpen = (tool: Tool) => tool.output.state === "OPEN" && oid(tool.output.code_head) && oid(tool.output.baseRefOid) && oid(tool.output.head_sha)
  const intake = local ? tools.find(tool => tool.name === "corvus_review_pr" && tool.input.op === "local" && correlated(tool) && ok(tool)) : metadata[0]
  if (!intake || !local && !isTerminal(intake) && !validOpen(intake)) errors.push("missing validated intake metadata/local identity")
  const lockCalls = tools.filter(tool => tool.name === "corvus_review_lock")
  const acquisitions = lockCalls.filter(tool => tool.input.op === "acquire")
  const acquired = acquisitions.find(tool => ok(tool) && tool.output.state === "acquired" && samePath(tool.input.reviewRoot, root) && text(tool.input.runId))
  const releases = lockCalls.filter(tool => tool.input.op === "release")
  const released = releases[0]
  const statuses = lockCalls.filter(tool => tool.input.op === "status" && correlated(tool) && samePath(tool.input.reviewRoot, root))
  const fresh = (tool: Tool | undefined, ceiling = 7200) => {
    if (!tool || tool.state.status !== "completed" || !acquired || !Array.isArray(tool.output.holders)) return false
    const holders = tool.output.holders.map(record)
    return holders.length > 0 && holders.every(holder => holder.run_id === acquired.input.runId && holder.started_at === acquired.output.started_at
      && typeof holder.age_s === "number" && Number.isFinite(holder.age_s) && holder.age_s >= 0 && (ceiling === 5400 ? holder.age_s <= ceiling : holder.age_s < ceiling))
      && holders.some(holder => samePath(holder.path, join(root, "lock.yaml")))
  }
  const statusBefore = (index: number, after = -1) => statuses.findLast(tool => tool.index > after && tool.index < index)
  const underLock = (tool: Tool) => !!acquired && !!released && correlated(acquired) && correlated(released)
    && tool.index > acquired.index && tool.index < released.index && correlated(tool)
  const detectorCalls = tools.filter(tool => ["task", "subagent"].includes(tool.name) && (tool.input.agent ?? tool.input.subagent_type) === "pr-light-reviewer")
  const writerCalls = tools.filter(writer), detectorChildren = descendants.filter(child => child.agent === "pr-light-reviewer")
  const rosterErrors: string[] = []
  const rosterError = (message: string) => { rosterErrors.push(message); errors.push(message) }
  const groups = new Map<number, Tool[]>()
  for (const dispatch of detectorCalls) {
    const number = Number(/\battempt[\s"_:=-]+(\d+)\b/i.exec(text(dispatch.input.prompt))?.[1])
    if (!Number.isSafeInteger(number) || number < 1 || number > 3) { rosterError("invalid detector attempt control"); continue }
    groups.set(number, [...(groups.get(number) ?? []), dispatch])
  }
  const attempts: LightAttempt[] = []
  for (const [index, [number, dispatches]] of [...groups].entries()) {
    const firstDispatch = dispatches[0], dispatch = dispatches.at(-1)!
    const axes = dispatches.map(tool => /\baxis[\s"_:=-]+(standards|spec_security)\b/i.exec(text(tool.input.prompt))?.[1])
    const between = controls.filter(tool => tool.index >= firstDispatch.index && tool.index <= dispatch.index)
    if (number !== index + 1 || new Set(axes).size !== 2 || axes.some(axis => !axis)
      || between.length !== dispatches.length || dispatches.some(tool => tool.input.background === true)
      || new Set(dispatches.map(tool => tool.turn ?? stored.find(item => item.callID === tool.callID)?.turn).filter(Boolean)).size > 1) rosterError(`attempt ${number}: require foreground shards of both axes in one batch`)
    const source = local ? intake : metadata.findLast(tool => tool.index < firstDispatch.index && validOpen(tool))
    if (!source) { rosterError(`attempt ${number}: no validated OPEN head/base`); continue }
    const head = text(source.output.code_head), base = text(local ? source.output.merge_base : source.output.baseRefOid)
    const attempt = { number, head, base, firstDispatch, dispatch, dispatches, metadata: source, end: [...groups.values()][index + 1]?.[0].index ?? Infinity }
    attempts.push(attempt)
    const inventoryCall = local ? intake : tools.findLast(tool => prCall(tool, "files") && tool.index < firstDispatch.index
      && ok(tool) && tool.input.names_only === true && tool.output.complete_pagination === true)
    const rawInventory = local ? inventoryCall?.output.changed_files : inventoryCall?.output.files
    const inventory = Array.isArray(rawInventory) && rawInventory.every(path => typeof path === "string")
      ? rawInventory.filter(path => !/^\.corvus(?:\/|$)/.test(path)) as string[] : null
    if (!inventory) rosterError(`attempt ${number}: missing complete shard inventory`)
    for (const axis of ["standards", "spec_security"]) {
      const shards = dispatches.filter((_, i) => axes[i] === axis)
      const paths: string[] = [], ordinals: number[] = []
      for (const shard of shards) {
        const prompt = text(shard.input.prompt), parts = /^([1-9]\d*)\/([1-9]\d*)$/.exec(lightFieldValues(prompt, "shard")[0] ?? "")
        const focus = lightFocusPaths(prompt)
        if (lightFieldValues(prompt, "shard").length !== 1 || !parts || Number(parts[2]) !== shards.length
          || Number(parts[1]) > shards.length || !focus || inventory?.length && !focus.length) rosterError(`attempt ${number}: invalid ${axis} shard/focus_paths`)
        if (parts) ordinals.push(Number(parts[1]))
        if (focus) paths.push(...focus)
      }
      if (new Set(ordinals).size !== shards.length || new Set(paths).size !== paths.length) rosterError(`attempt ${number}: duplicate ${axis} shard or overlapping focus_paths`)
      // Omitted inventory paths need a path-specific terminal disclosure and a
      // non-reviewable reason. Evidence-unavailable assigned files remain shards.
      const omitted = inventory?.filter(path => !paths.includes(path)) ?? []
      const disclosed = omitted.every(path => summary.split(/\r?\n/).some(line => line.includes(path)
        && /omitt|exclud/i.test(line) && /generated|vendor|lockfile|binar|snapshot|minified/i.test(line)))
      if (inventory && (paths.some(path => !inventory.includes(path)) || !disclosed)) rosterError(`attempt ${number}: ${axis} focus_paths do not cover inventory minus disclosed non-reviewable omissions`)
    }
    for (const dispatch of dispatches) {
      const child = detectorChildren.find(child => child.id === childResult(dispatch).sessionID && child.parentID === parentID)
      const prompt = text(dispatch.input.prompt)
      if (/\bmax_targeted_reads\b/.test(prompt) || lightFieldPresent(prompt, "read_budget")) rosterError(`attempt ${number}: retired read ceiling in detector control`)
      if (!underLock(dispatch) || !["completed", "error", "cancelled"].includes(childResult(dispatch).status) || !child || !oid(head) || !oid(base)
        || !prompt.includes(head) || !prompt.includes(base)) rosterError(`attempt ${number}: dispatch/child/head/base accounting invalid`)
      const failed = ["error", "cancelled"].includes(childResult(dispatch).status)
      if (failed && !(lightFocusPaths(prompt) ?? []).every(path => summary.split(/\r?\n/).some(line => line.includes(path) && /shard|uncovered/i.test(line)))) rosterError(`attempt ${number}: failed shard lacks uncovered-path disclosure`)
      if (!failed && !local && child && !["metadata", "files", "diff"].every(op => child.tools.some(tool => prCall(tool, op) && ok(tool)
        && (op !== "metadata" || tool.output.code_head === head && tool.output.baseRefOid === base)))) rosterError(`attempt ${number}: detector lacks fresh metadata/files/diff`)
    }
    const previous = attempts[index - 1]
    const start = previous?.dispatch.index ?? -1
     if (previous && (source.index <= previous.dispatch.index || head === previous.head && base === previous.base
       || !fresh(statusBefore(firstDispatch.index, previous.dispatch.index), 5400))) errors.push(`attempt ${index + 1}: restart lacks movement or fresh age-bounded ownership`)
    if (!local) {
       const files = tools.findLast(tool => prCall(tool, "files") && tool.index > start && tool.index < firstDispatch.index
        && ok(tool) && tool.input.paginate === true && tool.input.include_corvus === true && tool.input.names_only === true && tool.output.complete_pagination === true)
      const reviews = tools.findLast(tool => prCall(tool, "reviews") && tool.index > start && tool.index < dispatch.index && ok(tool))
      const resolution = tools.findLast(tool => tool.name === "corvus_review_sync" && tool.input.op === "resolve" && tool.index > start && tool.index < dispatch.index && ok(tool))
      const expectedPr = { owner: input.owner, name: input.repo, number: Number(input.pr), isCrossRepository: source.output.isCrossRepository }
      if (!files || !reviews || !resolution || resolution.output.root !== relativeRoot || !isDeepStrictEqual(resolution.input.changed_files, files.output.files)
        || !isDeepStrictEqual(resolution.input.pr, expectedPr) || resolution.index < files.index
        || !previous && acquired && resolution.index > acquired.index) errors.push(`attempt ${index + 1}: namespace/inventory/history refresh invalid`)
      if ((!previous || base !== previous.base) && !tools.some(tool => tool.name === "corvus_review_pr" && tool.input.op === "config"
        && tool.input.owner === input.owner && tool.input.name === input.repo && tool.input.ref === base && tool.index > start && tool.index < dispatch.index)) errors.push(`attempt ${index + 1}: base config was not reloaded`)
      const preparation = tools.filter(tool => shell(tool) && tool.index > start && tool.index < dispatch.index)
      const fetch = preparation.findLast(tool => /^git fetch --no-tags /.test(text(tool.input.command)))
      const verifyHead = preparation.findLast(tool => text(tool.input.command).startsWith("git cat-file -e ") && text(tool.input.command).includes(`${head}^{commit}`))
      if (!fetch || !verifyHead || fetch.index > verifyHead.index || verifyHead.index < source.index) errors.push(`attempt ${index + 1}: missing per-head preparation evidence`)
    }
    const history = tools.findLast(tool => tool.name === "corvus_review_verdict" && tool.index > start && tool.index < dispatch.index
      && !Object.hasOwn(tool.input, "code_head") && !Object.hasOwn(tool.input, "headSha"))
    if (!history && !disclosure(summary, "round")) errors.push(`attempt ${index + 1}: no refreshed marker history or round gap`)
    const postCheck = local ? undefined : metadata.find(tool => tool.index > dispatch.index && tool.index < attempt.end)
    const returnedStatus = statuses.find(tool => tool.index > dispatch.index && tool.index < (postCheck?.index ?? attempt.end))
    if (!returnedStatus) errors.push(`attempt ${index + 1}: no ownership evidence after detector return`)
    if (!local && !postCheck && fresh(returnedStatus)) errors.push(`attempt ${index + 1}: missing metadata-first post-detection check`)
  }
  const assigned = detectorCalls.map(tool => childResult(tool).sessionID)
  const writerChildren = descendants.filter(child => child.agent === "pr-comment-writer")
  const assignedWriters = writerCalls.filter(tool => tool.state.status === "completed").map(tool => childResult(tool).sessionID)
   const rosterOK = !rosterErrors.length && attempts.length <= 3 && detectorCalls.length === detectorChildren.length && new Set(assigned).size === assigned.length
    && detectorChildren.every(child => assigned.includes(child.id))
    && writerChildren.length === assignedWriters.length && new Set(assignedWriters).size === assignedWriters.length && writerChildren.every(child => assignedWriters.includes(child.id))
     && descendants.every(child => child.parentID === parentID && (child.agent === "pr-light-reviewer" || input.writer && child.agent === "pr-comment-writer"))
  const countClaim = /\bdetection attempts\s*[:=]\s*(\d+)\b/i.exec(summary)
   const ledgerOK = countClaim && Number(countClaim[1]) === attempts.length && attempts.every(attempt => summary.split(/\r?\n/).some(line =>
    new RegExp(`\\battempt[\\s\"_:=-]+${attempt.number}\\b`, "i").test(line) && line.includes(attempt.head) && line.includes(attempt.base)))
   const rosterRow: Row = { check: "light detector roster", ok: !evidenceError && rosterOK && Boolean(ledgerOK), code: 5,
      detail: !evidenceError && rosterOK && ledgerOK ? `${detectorChildren.length} detector sessions; ${detectorCalls.length} accounted axis/shard dispatches (≤3 attempts); ledger matches every head/base`
       : `forged: ${evidenceError || rosterErrors.join("; ") || "detector/child/ledger cardinality mismatch"}` }
  rows.push(rosterRow)

  /** DB-matched create receipts establish ownership before dispatch. Remove uses
   * that original tuple even after lock loss; a failed outcome must name its exact
   * path/diagnostic and manual remedy in terminal text. Ordering/tuple/ledger
   * contradictions fail forged; disclosed tool unavailability uses ADR-0006.
   * No PR terminal/restart bypasses removal. LOCAL/pre-admission creates none. */
  const treeCalls = tools.filter(tool => tool.name === "corvus_review_worktree")
  const treeErrors: string[] = [], treeRows: Row[] = []
  const creates = treeCalls.filter(tool => tool.input.op === "create")
  const removals = treeCalls.filter(tool => tool.input.op === "remove")
  const sameTuple = (a: Tool, b: Tool) => ["cwd", "pr", "code_head", "runId"].every(key => a.input[key] === b.input[key])
  const worktreeLedgerMatches = (attempt: LightAttempt | undefined, path: string, cleanup: string) => !!attempt && summary.split(/\r?\n/).some(line =>
    new RegExp(`\\battempt[\\s\"_:=-]+${attempt.number}\\b`, "i").test(line)
      && isDeepStrictEqual(lightFieldValues(line, "worktree"), [path]) && isDeepStrictEqual(lightFieldValues(line, "cleanup"), [cleanup]))
  for (const call of treeCalls) {
    if (!correlated(call) || !["create", "remove"].includes(text(call.input.op))) treeErrors.push("uncorrelated/unknown worktree call")
  }
  if ((local || !acquired) && treeCalls.length) treeErrors.push("worktree activity on LOCAL/pre-admission route")
  for (const [index, create] of creates.entries()) {
    const attempt = attempts.find(attempt => create.index > attempt.metadata.index && create.index < attempt.firstDispatch.index
      && create.input.code_head === attempt.head)
    const prepared = tools.findLast(tool => shell(tool) && tool.index < create.index
      && text(tool.input.command).startsWith("git cat-file -e ") && text(tool.input.command).includes(`${text(create.input.code_head)}^{commit}`))
    const previous = creates[index - 1]
    const previousRemoval = previous && removals.find(tool => tool.index > previous.index && tool.index < create.index && sameTuple(previous, tool) && ok(tool))
    if (!acquired || !released || create.index <= acquired.index || create.index >= released.index || !prepared || prepared.index <= acquired.index
      || !samePath(create.input.cwd, input.fixture) || create.input.pr !== Number(input.pr) || create.input.runId !== acquired.input.runId
      || !attempt || creates.filter(tool => tool.index > attempt.metadata.index && tool.index < attempt.firstDispatch.index).length !== 1
      || previous && ok(previous) && !previousRemoval) treeErrors.push("create lacks acquired/prepared attempt or previous cleanup")
    if (index > 0 && (!fresh(statusBefore(create.index, previous?.index), 5400)
      || previousRemoval && !fresh(statusBefore(previousRemoval.index, attempts[index - 1]?.dispatch.index), 5400))) treeErrors.push("restart removal/re-creation lacks fresh age-bounded admission")
    const path = text(create.output.path)
    if (ok(create)) {
      if (!path || dirname(path) !== dirname(realpathSync(input.fixture))
        || !basename(path).startsWith(`${basename(realpathSync(input.fixture))}.corvus-review-pr${input.pr}-${text(create.input.code_head).slice(0, 7)}-`)
        || create.output.head !== create.input.code_head) treeErrors.push("successful create path/head contradicts sibling identity")
      const remove = removals.find(tool => tool.index > create.index && sameTuple(create, tool))
      const next = creates[index + 1]
      if (!remove || !released || remove.index <= (attempt?.dispatch.index ?? create.index) || remove.index >= released.index || next && remove.index >= next.index) treeErrors.push("owned worktree not removed after dispatch and before release/re-creation")
      if (remove && (remove.output.path !== path && ok(remove) || ok(remove) && !["removed", "absent"].includes(text(remove.output.state)))) treeErrors.push("remove contradicts owned path/absence outcome")
      if (!worktreeLedgerMatches(attempt, path, remove && ok(remove) ? text(remove.output.state) : "failed")) treeErrors.push("worktree path/cleanup ledger mismatch")
      for (const dispatch of attempt?.dispatches ?? []) if (!isDeepStrictEqual(lightFieldValues(text(dispatch.input.prompt), "head_worktree"), [path])) treeErrors.push("detector lacks verified worktree control")
      if (remove && !ok(remove)) {
        const disclosed = summary.split(/\r?\n/).some(line => /worktree remove/i.test(line) && line.includes(path) && /git worktree remove --force /.test(line))
        treeRows.push(bookkeepingRow("light worktree cleanup", { op: "worktree remove", summary, consistent: false,
          diagnostic: diagnostic(remove), contradiction: disclosed ? undefined : "cleanup failure lacks exact path/manual remedy", detail: "cleanup failed" }))
        if (next) treeErrors.push("restart continued after failed removal")
        if (tools.some(tool => tool.index > remove.index && (detectorCalls.includes(tool) || writer(tool) || tool.name === "corvus_review_payload" || tool.name === "corvus_review_persist" && !["abort", "status"].includes(text(tool.input.op))))) treeErrors.push("review continued after failed cleanup")
      }
    } else {
      treeRows.push(bookkeepingRow("light worktree create", { op: "worktree create", summary, consistent: false,
        diagnostic: diagnostic(create), detail: "object-read fallback" }))
      if (!worktreeLedgerMatches(attempt, "none", "not-created")) treeErrors.push("uncreated worktree ledger mismatch")
      if (attempt?.dispatches.some(tool => lightFieldPresent(text(tool.input.prompt), "head_worktree"))) treeErrors.push("failed create supplied head_worktree")
      if (record(create.output.cleanup).ok === false && (!summary.includes(path) || !/manual|inspect/i.test(summary))) treeErrors.push("failed-create rollback path/manual inspection undisclosed")
    }
  }
  if (local && attempts.some(attempt => !worktreeLedgerMatches(attempt, "none", "not-created")
    || attempt.dispatches.some(tool => lightFieldPresent(text(tool.input.prompt), "head_worktree")))) treeErrors.push("LOCAL supplied worktree control or mismatched uncreated ledger")
  if (!local && attempts.some(attempt => !creates.some(tool => tool.index > attempt.metadata.index && tool.index < attempt.firstDispatch.index))) treeErrors.push("PR attempt lacks worktree create outcome")
  if (removals.some(remove => !creates.some(create => ok(create) && create.index < remove.index && sameTuple(create, remove)))) treeErrors.push("remove without successful owned create")
  if (creates.some((create, index) => removals.filter(remove => remove.index > create.index && remove.index < (creates[index + 1]?.index ?? Infinity) && sameTuple(create, remove)).length > 1)) treeErrors.push("duplicate worktree removal")
  const treeBase = bookkeepingRow("light worktree route", { op: "worktree lifecycle", summary,
    consistent: !treeErrors.length && !evidenceError, contradiction: treeErrors.length ? treeErrors.join("; ") : evidenceError || undefined,
    byContract: treeCalls.length === 0 && (local || !acquired), contractDisclosed: /terminal reason\s*[:=]/i.test(summary) && /LOCAL|local_mode|CLOSED|MERGED|held|denied/i.test(summary),
    detail: `${creates.length} create outcomes; ${removals.length} owned removals before release/re-creation${local || !acquired ? "; no worktree on unadmitted/LOCAL route" : ""}` })
  const treeRow = aggregateRow("light worktree route", [treeBase, ...treeRows], treeBase.detail)
  rows.push(treeRow)

  const presentationCalls = tools.filter(tool => tool.name === "corvus_review_persist" && (tool.input.op === "write_candidate" || tool.input.op === "finalize"))
  const presentations: LightPresentation[] = []
  for (const producer of presentationCalls.filter(ok)) {
    const attempt = attempts.findLast(attempt => attempt.dispatch.index < producer.index)
    try {
      if (!attempt || !underLock(producer) || !fresh(statusBefore(producer.index, attempt.dispatch.index))) throw new Error("candidate without fresh attempt ownership")
      const live = metadata.findLast(tool => tool.index < producer.index)
      if (!local && (!live || !validOpen(live) || live.output.code_head !== attempt.head || live.output.baseRefOid !== attempt.base)) throw new Error("candidate after attempt invalidation")
      let value = record(producer.input.candidate)
      if (producer.input.op === "finalize") {
        const begin = tools.findLast(tool => tool.name === "corvus_review_persist" && tool.input.op === "begin" && tool.input.target === "candidate"
          && tool.output.staging_id === producer.input.staging_id && tool.index < producer.index && ok(tool))
        if (!begin || !underLock(begin)) throw new Error("missing candidate begin")
        const appends = tools.filter(tool => tool.name === "corvus_review_persist" && tool.input.op === "append" && tool.index > begin.index && tool.index < producer.index)
        if (appends.some(tool => tool.input.staging_id !== producer.input.staging_id || !underLock(tool))) throw new Error("mixed/unowned candidate appends")
        value = stagedCandidate(begin, appends.filter(ok), producer)
      }
      const measured = measure(value)
      if ("reason" in measured || value.commit_id !== attempt.head || !["COMMENT", "REQUEST_CHANGES"].includes(text(value.event))) throw new Error("candidate schema/head/action mismatch")
      if (producer.output.sha256 !== measured.sha256 || producer.output.bytes !== Buffer.byteLength(measured.canonical)
        || producer.output.lines !== measured.canonical.split("\n").length - 1 || !reportedPathMatches(input.fixture, producer.output.path, join(root, ".light"), "candidate.json")) throw new Error("candidate receipt mismatch")
      const marker = parseReviewMarker(text(value.body).split(/\r?\n/)[0])
      const history = tools.findLast(tool => tool.name === "corvus_review_verdict" && tool.index < producer.index && tool.index > (attempts[attempt.number - 2]?.dispatch.index ?? -1))
      if (!marker || marker.head !== attempt.head || (marker.path ? marker.path !== relativeRoot || !ok(history) || marker.round !== history?.output.round : ok(history) || !disclosure(summary, "round", diagnostic(history)))) throw new Error("attempt marker/history mismatch")
       const renderErrors = lightRenderErrors(text(value.body), local, value.comments as CandidateRequest["comments"], input)
        if (renderErrors.length) throw new Error(renderErrors.join("; "))
      for (const path of new Set((value.comments as CandidateRequest["comments"]).map(comment => comment.path))) {
        const anchor = `diff-${createHash("sha256").update(path).digest("hex")}`
        const receipt = tools.findLast(tool => prCall(tool, "files") && correlated(tool) && ok(tool)
          && tool.index > attempt.dispatch.index && tool.index < producer.index && tool.input.paginate === true
          && Array.isArray(tool.input.paths) && tool.input.paths.includes(path) && tool.output.complete_pagination === true
          && Array.isArray(tool.output.files) && tool.output.files.some(item => record(item).filename === path && record(item).diff_anchor === anchor))
        if (!receipt) throw new Error(`inline index lacks tool-produced diff_anchor: ${path}`)
      }
      presentations.push({ attempt, producer, value })
    } catch (error) { presentationErrors.push(`${producer.index}: ${String(error)}`) }
  }
  const payloadCalls = tools.filter(tool => tool.name === "corvus_review_payload")
  const previewRevisions: { presentation: LightPresentation; preview: Tool; frozen: Tool; digest: string }[] = []
  for (const presentation of presentations) {
    const { producer, value } = presentation
    const end = presentationCalls.find(tool => tool.index > producer.index)?.index ?? Infinity
    const revisions = payloadCalls.filter(tool => tool.index > producer.index && tool.index < end)
    const measured = measure(value)
    if ("reason" in measured) continue
    const { canonical, ...measurement } = measured
    let measuredAt = -1
    for (const call of revisions) {
      try {
        if (!underLock(call)) throw new Error("payload outside owned lock")
        if (attempts.findLast(attempt => attempt.dispatch.index < call.index) !== presentation.attempt) throw new Error("payload carried over into a new attempt")
        if (call.input.op === "measure") {
          if (!samePath(call.input.candidatePath, candidate) || !isDeepStrictEqual(call.output, measurement) && !isDeepStrictEqual(call.output, { ...measurement, canonical })) throw new Error("revision measurement mismatch")
          measuredAt = call.index
        } else if (call.input.op === "freeze") {
          if (measuredAt < producer.index || !fresh(statusBefore(call.index, presentation.attempt.dispatch.index))
            || !samePath(call.input.candidatePath, candidate) || !samePath(call.input.artifactPath, artifact)) throw new Error("freeze without measurement/fresh ownership/paths")
          if (!ok(call)) continue
          const fitted = !measured.ok, fit = fitReview(value as CandidateRequest), expected = measure(fitted ? fit.request : value)
           if ("reason" in expected || call.output.sha256 !== expected.sha256 || !reportedPathMatches(input.fixture, call.output.artifactPath, join(root, ".light"), "post-request.json")
            || call.output.fitted !== fitted || !isDeepStrictEqual(call.output.measurements, expected.measurements)
             || !isDeepStrictEqual(call.output.omitted, fitted ? fit.omitted : { comments: 0, findings: 0 })) throw new Error("freeze digest/fit/revision mismatch")
           const renderErrors = lightRenderErrors(text(record(fitted ? fit.request : value).body), local, fitted ? undefined : value.comments as CandidateRequest["comments"], input)
           if (renderErrors.length) throw new Error(`frozen render: ${renderErrors.join("; ")}`)
          presentation.frozen = call; presentation.preview = undefined; presentation.digest = expected.sha256
        } else if (call.input.op === "preview") {
          const frozen = presentation.frozen
          if (!frozen || call.index < frozen.index || !samePath(call.input.artifactPath, artifact) || call.input.expectedSha256 !== presentation.digest
            || Object.keys(call.input).some(key => !["op", "artifactPath", "expectedSha256"].includes(key))) throw new Error("preview uses stale freeze/digest")
          if (!ok(call)) continue
          const expected = frozen.output.fitted ? fitReview(value as CandidateRequest).request : value
          if (call.output.sha256 !== presentation.digest || !["commit_id", "event", "body", "comments"].every(key => isDeepStrictEqual(call.output[key], record(expected)[key]))) throw new Error("decoded preview differs from its freeze")
          presentation.preview = call
          previewRevisions.push({ presentation, preview: call, frozen, digest: presentation.digest! })
        } else throw new Error("unknown payload operation")
      } catch (error) { presentationErrors.push(`${call.index}: ${String(error)}`) }
    }
    if (!presentation.frozen || !presentation.preview) presentationErrors.push(`${producer.index}: presentation lacks successful freeze/preview`)
  }
  if (payloadCalls.some(tool => !presentations.some(presentation => presentation.producer.index < tool.index))) presentationErrors.push("payload without candidate production")
  const lastCandidate = presentations.at(-1), lastArtifact = presentations.findLast(presentation => presentation.frozen)
  let retainedOK = true, builtOK = true
  try {
    if (lastCandidate) {
      const measured = measure(lastCandidate.value)
      if ("reason" in measured || realpathSync(candidate) !== join(realpathSync(root), ".light/candidate.json") || read(candidate) !== measured.canonical) throw new Error("retained candidate contradicts last producing attempt")
    } else if (existsSync(candidate)) throw new Error("unaccounted retained candidate")
    if (lastArtifact) {
      const expected = lastArtifact.frozen!.output.fitted ? fitReview(lastArtifact.value as CandidateRequest).request : lastArtifact.value
      const measured = measure(expected)
      if ("reason" in measured || realpathSync(artifact) !== join(realpathSync(root), ".light/post-request.json") || read(artifact) !== measured.canonical) throw new Error("retained artifact contradicts last artifact-producing attempt")
      const modulePath = join(dirname(resolve(input.fixture)), "dist/review-payload.js")
      const built: { verify: typeof verify } = await import(pathToFileURL(modulePath).href)
      builtOK = built.verify(artifact, lastArtifact.digest!, { reviewStateRoot: join(input.fixture, ".corvus") }).ok
    } else if (existsSync(artifact)) throw new Error("unaccounted retained artifact")
  } catch (error) { retainedOK = false; presentationErrors.push(String(error)) }

  const terminalMetadata = metadata.find(isTerminal)
  const lastAttempt = attempts.at(-1)
  const drift = lastAttempt && metadata.find(tool => tool.index > lastAttempt.dispatch.index && validOpen(tool)
    && (tool.output.code_head !== lastAttempt.head || tool.output.baseRefOid !== lastAttempt.base))
  const lost = statuses.find(tool => acquired && tool.index > acquired.index && !fresh(tool))
  const refusedAge = drift && statuses.find(tool => tool.index > drift.index && fresh(tool) && !fresh(tool, 5400))
  const rootChange = drift && tools.find(tool => tool.name === "corvus_review_sync" && tool.input.op === "resolve" && tool.index > drift.index && ok(tool) && tool.output.root !== relativeRoot)
  const held = acquisitions.find(tool => tool.output.state === "held" || denied(diagnostic(tool) ?? ""))
  const cleanupFailure = removals.find(tool => !ok(tool))
  const reason = terminalMetadata ? text(terminalMetadata.output.state).toLowerCase() : lost ? "ownership" : drift && attempts.length === 3 ? "exhaustion"
    : refusedAge ? "lock-age" : rootChange ? "namespace" : held ? "held/denied" : local ? "local_mode" : writerCalls.length ? "writer" : cleanupFailure ? "cleanup" : "unverified"
  const stop = terminalMetadata ?? lost ?? (reason === "exhaustion" ? drift : undefined) ?? refusedAge ?? rootChange ?? held
  if (stop && tools.some(tool => tool.index > stop.index && (writer(tool) || detectorCalls.includes(tool) || tool.name === "corvus_review_payload"
    || tool.name === "corvus_review_persist" && !["abort", "status"].includes(text(tool.input.op))))) errors.push("detection/presentation/posting after DB terminal decision")
  if (reason === "unverified") errors.push("no DB-evidenced terminal route")
  if (!/terminal reason\s*[:=]/i.test(summary) || reason !== "writer" && !new RegExp(reason === "exhaustion" ? "exhaust|budget" : reason === "namespace" ? "root|namespace" : reason === "ownership" ? "ownership|expired|not.owner" : reason === "local_mode" ? "LOCAL|local_mode" : reason === "lock-age" ? "lock.age" : reason, "i").test(summary)) errors.push("terminal reason not disclosed")
  if (reason === "exhaustion" && !summary.includes(text(drift?.output.code_head))) errors.push("latest exhausted head not disclosed")
  const intakeStop = !!intake && !local && isTerminal(intake)
  if (intakeStop && (acquisitions.length || releases.length || detectorCalls.length || presentationCalls.length || payloadCalls.length || writerCalls.length)) errors.push("intake CLOSED/MERGED performed admitted work")
  if (!intakeStop && !held && acquisitions.length !== 1 || acquired && releases.length !== 1) errors.push("lock reacquired or cleanup count invalid")
  /** Foreign-lock oracle: namespace-direct regular-file run_id bytes and
   * DB-matched acquisition controls, read after shutdown before cleanup/isolation
   * scoring, with no filesystem mutation. An acquired run's different owner is
   * foreign; a never-acquired held/denied route also requires a different owner
   * from its attempted runId (held receipts must match the file's path/owner).
   * Missing/unreadable/same-run or uncorrelated evidence gets no exemption and
   * fails both consumers when retained. Only these two direct lock names qualify;
   * summary wording, ownership-loss alone and extra files never disable isolation. */
  const foreignLockEvidence = (name: string): boolean => {
    const path = join(root, name)
    try {
      if (!lstatSync(path).isFile()) return false
      const owner = text(yaml(path).run_id)
      if (!owner.trim()) return false
      if (acquired) return correlated(acquired) && owner !== acquired.input.runId
      if (!held || !correlated(held) || !samePath(held.input.reviewRoot, root)
        || !text(held.input.runId).trim() || owner === held.input.runId) return false
      const holder = record(held.output.holder)
      return held.state.status === "completed" && held.output.state === "held" && held.output.ok === false
        && samePath(holder.path, path) && holder.run_id === owner
        || held.state.status === "error" && denied(diagnostic(held) ?? "")
    } catch { return false }
  }
  const foreignLocks = ["lock.yaml", ".lock"].filter(foreignLockEvidence)
  const cleanupOK = (acquired ? !!released && correlated(released) && samePath(released.input.reviewRoot, root) && released.input.runId === acquired.input.runId && released.input.mode === "delete"
    && (ok(released) && ["released", "absent"].includes(text(released.output.state)) || reason === "ownership" && released.output.reason === "not-owner")
    && terminal.index > released.index && !tools.some(tool => tool.index > released.index && (tool.name.startsWith("corvus_review_") || ["task", "subagent"].includes(tool.name)))
    : (intakeStop || !!held) && releases.length === 0)
    && ["lock.yaml", ".lock"].every(path => !existsSync(join(root, path)) || foreignLocks.includes(path))
  if (!cleanupOK) errors.push("missing owned cleanup or subsequent review work")
  const authorizations = events.flatMap((event, index) => event.type === "text" && event.sessionID === parentID
    ? lightObjects(text(record(event.part).text)).filter(value => value.decision === "auto_post").map(value => ({ index, value, source: text(record(event.part).text) })) : [])
  let parentTexts: string[] = []
  try { const store = readSessionStore(input.db, parentID, false); if (store.available) parentTexts = store.parent.parts.filter(part => part.type === "text").map(part => text(part.text)) } catch {}
  const previewBefore = (index: number) => previewRevisions.findLast(item => item.preview.index < index)
  const latestFreezeBefore = (index: number) => payloadCalls.findLast(tool => tool.input.op === "freeze" && ok(tool) && tool.index < index)
  for (const authorization of authorizations) {
    const revision = previewBefore(authorization.index), presentation = revision?.presentation
    const currentAttempt = attempts.findLast(item => item.dispatch.index < authorization.index)
    if (!presentation || revision?.frozen !== latestFreezeBefore(authorization.index) || presentation.attempt !== currentAttempt || !parentTexts.includes(authorization.source)
      || authorization.value.digest !== revision?.digest || authorization.value.code_head !== presentation.attempt.head || authorization.value.event !== presentation.value.event) errors.push("authorization contradicts current attempt preview")
  }
  for (const dispatch of writerCalls) {
    const revision = previewBefore(dispatch.index), presentation = revision?.presentation
    const authorization = authorizations.findLast(item => item.index < dispatch.index)
    const revalidated = metadata.findLast(tool => tool.index < dispatch.index)
    const descriptor = lightObjects(text(dispatch.input.prompt)).map(value => record(value.POST_ARTIFACT ?? value)).find(value => value.artifact_path)
    if (!descriptor || !samePath(descriptor.artifact_path, artifact) || descriptor.expected_sha256 !== revision?.digest
      || descriptor.head_sha !== presentation?.attempt.head || descriptor.event !== presentation?.value.event || descriptor.pr_number !== Number(input.pr)
      || !isDeepStrictEqual(descriptor.repository, { owner: input.owner, name: input.repo })
      || !isDeepStrictEqual(Object.keys(descriptor).sort(), ["artifact_path", "expected_sha256", "repository", "pr_number", "head_sha", "event"].sort())) errors.push("writer descriptor differs from authorized presentation")
    if (!revision || !presentation || revision.frozen !== latestFreezeBefore(dispatch.index) || !authorization || authorization.index < revision.preview.index || !parentTexts.includes(authorization.source)
      || authorization.value.digest !== revision.digest || authorization.value.code_head !== presentation.attempt.head || authorization.value.event !== presentation.value.event
      || !Array.isArray(authorization.value.edits) || authorization.value.edits.length || !Array.isArray(authorization.value.rerun_scope) || authorization.value.rerun_scope.length
      || !revalidated || revalidated.index < authorization.index || !validOpen(revalidated) || revalidated.output.code_head !== presentation.attempt.head || revalidated.output.baseRefOid !== presentation.attempt.base
      || !fresh(statusBefore(dispatch.index, authorization.index)) || !underLock(dispatch)) errors.push("writer uses stale/missing authorization, metadata or ownership")
    if (!input.writer && (dispatch.state.status !== "error" || !denied(diagnostic(dispatch) ?? ""))) errors.push("writer crossed denied-dispatch barrier")
    if (input.writer) {
      const child = descendants.find(child => child.agent === "pr-comment-writer" && child.id === childResult(dispatch).sessionID)
      const result = extractPostResult([text(dispatch.state.output), ...(child?.texts ?? [])])
      const posts = child?.tools.filter(tool => tool.name === "corvus_review_post") ?? []
      if (!child || dispatch.state.status !== "completed" || !presentation || !["posted", "not_posted", "local_only"].includes(text(result.status))
        || posts.some(post => post.input.expectedSha256 !== presentation.digest || post.input.headSha !== presentation.attempt.head
          || post.input.event !== presentation.value.event || !samePath(post.input.artifactPath, artifact))) errors.push("writer child/result differs from attempt descriptor")
      if (result.status === "posted" || result.remote_state === "posted" || posts.some(post => post.output.outcome === "posted")) {
        add("light posting barrier", false, "synthetic/live posted writer receipt crossed the smoke posting barrier", 6)
      }
      if (result.reason === "head-moved" && (posts.length !== 1 || posts[0].output.outcome !== "rejected" || posts[0].output.reason !== "head-moved"
        || posts[0].output.tool_api_calls !== 1 || !metadata.some(tool => tool.index > dispatch.index && tool.index < (detectorCalls.find(tool => tool.index > dispatch.index)?.index ?? Infinity)))) errors.push("writer head-moved lacks mechanical rejection and metadata-first renewal")
    }
  }
  const superseded = !!lastArtifact && (lastArtifact.attempt !== lastAttempt || !!drift || !!terminalMetadata || !!lost)
  if (superseded && (!/superseded|inert/i.test(summary) || !summary.includes(lastArtifact!.attempt.head)
    || !new RegExp(`\\battempt[\\s_:=-]+${lastArtifact!.attempt.number}\\b`, "i").test(summary))) errors.push("retained superseded artifact not identified as inert by producing attempt")
  if (!/no (?:further )?posting|nothing (?:was )?posted|not posted/i.test(summary) && !input.writer) errors.push("no-post outcome not disclosed")
  const proof = errors.length ? `forged: ${errors.join("; ")}` : `${attempts.length} DB-validated attempts; terminal=${reason}; presentations=${presentations.length}${superseded ? "; retained artifact inert" : ""}`
   const stateRow = aggregateRow("light attempt controls", [{ check: "light attempt controls", ok: errors.length === 0, code: 5, detail: proof }, rosterRow, treeRow], proof)
   rows.push(stateRow)
   rows.push(aggregateRow("child tool evidence", [stateRow, rosterRow], proof))
   rows.push(aggregateRow("sync.resolve", [stateRow], proof))
   rows.push(aggregateRow("lock released", [stateRow, treeRow], proof))
  const presentationRow: Row = { check: "light presentation integrity", ok: !presentationErrors.length && retainedOK && builtOK, code: 5,
    detail: presentationErrors.length ? `forged: ${presentationErrors.join("; ")}` : `${presentations.length} revisions: independent candidate → measure → freeze → preview; last producing bytes retained` }
   rows.push(presentationRow)
  const omitted = (check: string) => bookkeepingRow(check, { op: check, summary, consistent: false, detail: proof, byContract: true,
    contractDisclosed: /terminal reason\s*[:=]/i.test(summary) && /no (?:further )?posting|nothing (?:was )?posted|not posted/i.test(summary),
    contradiction: stateRow.ok && presentationRow.ok ? undefined : [stateRow, presentationRow].find(row => !row.ok)?.detail.replace(/^forged: /, "") })
   for (const check of ["candidate producer", "posting artifacts", "tool chain", "SHA-256", "built verify()", "marker"]) rows.push(presentations.length
     ? aggregateRow(check, [stateRow, presentationRow], presentationRow.detail) : omitted(check))
   rows.push(presentationCalls.length ? aggregateRow("light render structure", [presentationRow], "candidate and frozen bodies match the literal light template") : omitted("light render structure"))
  for (const check of ["owned state writes", "review-state tools", "artifacts"]) rows.push(aggregateRow(check, [stateRow, presentationRow], proof))
  const persistCalls = tools.filter(tool => tool.name === "corvus_review_persist")
  if (persistCalls.some(tool => !underLock(tool) || !samePath(tool.input.reviewRoot, root) || !["write_candidate", "begin", "append", "finalize", "abort", "status"].includes(text(tool.input.op))
    || tool.input.op !== "status" && !fresh(statusBefore(tool.index, attempts.findLast(attempt => attempt.dispatch.index < tool.index)?.dispatch.index ?? -1)))) {
    rows.push({ check: "owned candidate operations", ok: false, code: 5, detail: "forged: candidate operations outside owned light scope" })
  }
  const openStages = new Set<string>()
  let stagesOK = true
  for (const tool of tools) {
    if (detectorCalls.includes(tool) && openStages.size) stagesOK = false
    if (tool.name !== "corvus_review_persist" || !ok(tool)) continue
    if (tool.input.op === "begin") openStages.add(text(tool.output.staging_id))
    if (["finalize", "abort"].includes(text(tool.input.op))) openStages.delete(text(tool.input.staging_id))
  }
  if (openStages.size && (reason !== "ownership" || [...openStages].some(id => !summary.includes(id)))) stagesOK = false
  add("light staging cleanup", stagesOK, "issued open candidate stages close before restart/terminal cleanup; ownership loss discloses outstanding IDs")
  const fitted = presentations.filter(item => item.frozen?.output.fitted === true)
  if (fitted.length) add("size fit", presentationRow.ok && fitted.every(item => {
    const omitted = record(item.frozen!.output.omitted), count = Number(omitted.comments) + Number(omitted.findings)
    return new RegExp(`\\b${count}\\s+findings?\\s+omitted\\s+for\\s+size\\b`, "i").test(summary)
      || /size[_ ]fit|fitted|for size/i.test(summary) && new RegExp(`\\bcomments\\s*[:=]\\s*${omitted.comments}\\b`, "i").test(summary)
        && new RegExp(`\\bfindings\\s*[:=]\\s*${omitted.findings}\\b`, "i").test(summary)
  }), "each fitted revision reproduces identity/event/omissions/digest; terminal size-fit counts disclosed")
   if (!local) rows.push(writerCalls.length ? aggregateRow(input.writer ? "writer dispatched" : "writer denied", [stateRow], proof) : omitted("writer denied"))
  add("light coverage/action", presentationRow.ok && (intakeStop || /synthesis.*counts/i.test(summary))
    && /actual (?:coverage|reviewed(?: scope| bounds)?)|reviewed (?:scope|bounds|files|changed lines)|\b(?:files|changed lines) reviewed\b/i.test(summary) && /untracked/i.test(summary), "no generic light banner or APPROVE; terminal actual-coverage/untracked disclosure")
  if (local) {
    add("LOCAL no writer", writerCalls.length === 0 && !descendants.some(child => child.agent === "pr-comment-writer"), proof, 6)
    add("LOCAL no posting tools", ![...tools, ...descendants.flatMap(child => child.tools)].some(tool => tool.name === "corvus_review_post")
      && presentations.every(item => item.value.event === "COMMENT" && Array.isArray(item.value.comments) && !item.value.comments.length), proof, 6)
    add("LOCAL terminal summary", stateRow.ok && presentationRow.ok && summary.includes(`${relativeRoot}/.light/post-request.json`), proof)
  }
  return { rows, validatedHeads: attempts.map(attempt => attempt.head), foreignLocks }
}

export async function checkReviewArtifacts(input: Inputs) {
  const local = input.intake === "local"
  const light = input.agent === "light", agentName = light ? "corvus-review-light" : "corvus-review-auto"
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
  const identity = identities.find(item => sessionIDs.has(text(item.id)) && item.agent === agentName)
  const fallback = /(?:agent[^\n]*(?:not found|unknown)|falling back to default agent)/i.test(log)
  add("invoked agent", Boolean(identity) && !fallback, 3, fallback ? "agent fallback warning" : identity ? `host session: ${agentName}` : "missing host session identity")
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
  const postingRoot = light ? join(root, LIGHT_REVIEW_DIRECTORY) : root
  const artifact = join(postingRoot, "post-request.json")
  const candidate = join(postingRoot, "candidate.json")
  /**
   * R4 route oracle: current-head review-action.yaml selects the non-writer
   * local-only path after shutdown, without mutating evidence. Its matching parent
   * DB write, measured candidate, terminal disclosure and absence of POST and
   * writer work are required below; a retained frozen artifact must validate.
   * Missing or conflicting evidence
   * fails closed. Only this route makes retained candidate/post artifacts optional;
   * an absent candidate also has no marker to inspect. LOCAL and --writer disable
   * this exception, never their own checks or the independent GitHub barrier.
   */
  const actionPath = join(root, input.head, "review-action.yaml")
  let reviewAction: RecordValue = {}
  if (!local && !input.writer && validIdentity) {
    try { reviewAction = yaml(actionPath) } catch {}
  }
  const notExposed = reviewAction.decision === "local_only" && /not[-_]exposed/.test(text(reviewAction.decision_reason))
    && Array.isArray(reviewAction.rails_applied) && reviewAction.rails_applied.includes("writer_capability_not_exposed")
  /**
   * State oracle: parent tool results, descendant DB parts and final bytes, read
   * after shutdown. Lock ownership brackets the required input/document/candidate
   * writes (no candidate or measurement for LOCAL). Successful writes must match
   * their files; unavailable bookkeeping requires terminal disclosure. Any model
   * state write fails closed; parent shell calls must match fixed diagnostic/checkout
   * templates. No host/mode flag grants mutation rights or disables ownership.
   */
  const samePath = (value: unknown, expected: string) => typeof value === "string" && resolve(input.fixture, value) === expected
  const succeeded = (tool: Tool) => tool.state.status === "completed" && tool.output.ok === true
  const parentID = text(identity?.id)
  const terminal = finalAssistantMessage(events, parentID), summary = terminal.text
  const pipeline = (check: string, original: Row): Row => !light ? original : lightContractRow(check, summary,
    tools.some(tool => tool.name === "corvus_review_persist" && (["write_document", "write_input", "write_meta", "write_facts"].includes(text(tool.input.op))
      || ["document", "input"].includes(text(tool.input.target))))
      || [join(root, input.head), join(root, "review-input.json"), join(root, "verified_facts.yaml")].some(existsSync)
      ? "light wrote/attempted forbidden full-pipeline bookkeeping" : undefined)
  let stored: Tool[] = [], stagingError = ""
  try { stored = readParentTools(input.db, parentID) } catch (error) { stagingError = String(error) }
  const matched = (tool: Tool | undefined) => matchedStoredTool(tool, stored, parentID)
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
  const targetOf = (tool: Tool): unknown => tool.input.target ?? stateCalls.findLast(begin => begin.name === "corvus_review_persist"
    && begin.input.op === "begin" && begin.index < tool.index && begin.output.staging_id === tool.input.staging_id)?.input.target
  const writesFor = (op: string, path: string) => stateCalls.filter(tool => tool.name === "corvus_review_persist" && (tool.input.op === op
    && (op !== "write_document" || tool.input.headSha === input.head)
    || ["write_document", "write_input", "write_candidate"].includes(op)
      && targetOf(tool) === op.slice(6) && (tool.input.op === "finalize" || !succeeded(tool) && ["begin", "append"].includes(text(tool.input.op)))
    || tool.input.op === "finalize" && reportedPathMatches(input.fixture, tool.output.path, root, relative(root, path))))
  const underLock = (tool: Tool) => Boolean(acquired && released && matched(acquired) && matched(released)
    && tool.index > acquired.index && tool.index < released.index
    && matched(tool) && matched(tool)!.index > matched(acquired)!.index && matched(tool)!.index < matched(released)!.index)
  // Missing bookkeeping DB records are unavailable, not contrary ordering. Lock
  // ownership still comes from matched acquire/release; observed orders must agree.
  const bookkeepingOrder = (tool: Tool) => Boolean(acquired && released && matched(acquired) && matched(released)
    && tool.index > acquired.index && tool.index < released.index
    && (!matched(tool) || matched(tool)!.index > matched(acquired)!.index && matched(tool)!.index < matched(released)!.index))
  const persisted = (op: string, path: string) => {
    const last = writesFor(op, path).at(-1)
    return last && acquired && released && last.index > acquired.index && last.index < released.index
      && (op !== "write_document" || last.input.op === "finalize" || last.input.headSha === input.head)
      && reportedPathMatches(input.fixture, last.output.path, root, relative(root, path)) && succeeded(last) ? last : undefined
  }
  const documentWrite = persisted("write_document", join(root, input.head, "REVIEW_DOCUMENT.md"))
  const inputWrite = persisted("write_input", join(root, "review-input.json"))
  let candidateWrite = persisted("write_candidate", candidate)
  let descendants: ChildSession[] = []
  let childError = ""
  try {
    if (!input.db || !existsSync(input.db)) throw new Error("host DB required for all-agent write audit")
    descendants = readDescendants(input.db, parentID)
  } catch (error) { childError = String(error) }
  const gathererReads = descendants.filter(child => child.agent === (light ? "pr-light-reviewer" : "pr-context-gatherer")).flatMap(child => child.tools)
    .filter(tool => tool.name === "corvus_review_pr" && ["files", "diff"].includes(text(tool.input.op)) && succeeded(tool))
  if (!light) add("child tool evidence", !childError && (local || ["files", "diff"].every(op => gathererReads.some(tool => tool.input.op === op))), 5,
    childError || `${descendants.length} descendant sessions; ${local ? "LOCAL: PR reads not required" : `${gathererReads.length} gatherer files/diff calls`}`)
  const allTools = [...tools, ...stored, ...descendants.flatMap(child => child.tools)]
  const auditError = stagingError || childError
  const lightAudit = light ? await checkLightAttempts(input, events, tools, stored, descendants, parentID, root, auditError) : undefined
  rows.push(checkRetiredTools(allTools, auditError))
  if (light) {
    rows.push(checkModelShellPushes(allTools, auditError))
    /** Denied model attempts are still attempts: inspect the complete stopped-host
     * tree before scoring, independently of executed Git trace. Match command verbs,
     * not the commit object expression in permitted cat-file reads. Missing evidence
     * fails closed; no terminal disclosure permits staging/commit/worktree mutation. */
    const mutations = allTools.filter(tool => shell(tool) && /\bgit\s+(?:(?:-C|-c)\s+(?:'[^']*'|"[^"]*"|\S+)\s+)*(?:add|commit|push|checkout|switch|branch|update-ref|update-index|reset|restore|stash|rm|worktree|read-tree)\b/i.test(text(tool.input.command)))
    add("light model Git mutations", !auditError && mutations.length === 0, 6,
      auditError || `${mutations.length} model staging/commit/push/worktree mutation attempts`)
    const writes = allTools.filter(tool => ["write", "edit", "patch", "apply_patch"].includes(tool.name))
    add("light model writes", !auditError && writes.length === 0, 5, auditError || `${writes.length} model edit/write/patch attempts; only tool-owned state writes permitted`)
  }
  /**
   * Parent JSONL and matching stopped-host DB calls are read before scoring, with
   * final disk bytes as the digest oracle. Missing, reordered or mismatched calls
   * contradict success and fail forged. Missing checkpoint provenance may only
   * pass with disclosure; candidate and append integrity always fail closed.
   * Rejected attempts are DB/lock-order checked but contribute no reconstructed
   * bytes. Native replay must still produce the final digest from successes alone;
   * the independent ceiling row never excludes rejected attempts.
   */
  const staged = (target: "document" | "input" | "candidate", final: Tool | undefined): boolean => {
    if (!final || final.input.op !== "finalize" || !matched(final)) return false
    const begin = stateCalls.findLast(tool => tool.name === "corvus_review_persist" && tool.input.op === "begin"
      && tool.input.target === target && (target !== "document" || tool.input.headSha === input.head)
      && tool.output.staging_id === final.input.staging_id && succeeded(tool))
    const appends = stateCalls.filter(tool => tool.name === "corvus_review_persist" && tool.input.op === "append"
      && tool.input.staging_id === final.input.staging_id)
    const appendDB = appends.map(tool => storedToolEvidence(tool, stored, parentID))
    const ordered = Boolean(begin && underLock(begin) && underLock(final) && matched(begin) && appends.some(succeeded)
      && (target !== "candidate" || stateCalls.filter(tool => tool.name === "corvus_review_persist" && tool.input.op === "append"
        && tool.index > begin.index && tool.index < final.index).every(tool => tool.input.staging_id === final.input.staging_id))
      && appends.every((tool, index) => appendDB[index].kind === "matched" && tool.index > begin.index && tool.index < final.index
        && appendDB[index].tool!.index > matched(begin)!.index && appendDB[index].tool!.index < matched(final)!.index))
    if (!ordered || !begin) return false
    try {
      // Use DB indexes, not CLI completion-event order, for replacement precedence.
      return stagedDigest(matched(begin)!, appendDB.map(evidence => evidence.tool!), matched(final)!) === final.output.sha256
    } catch { return false }
  }
  let documentDigest = ""
  try { documentDigest = createHash("sha256").update(readFileSync(join(root, input.head, "REVIEW_DOCUMENT.md"))).digest("hex") } catch {}
  const documentPath = join(root, input.head, "REVIEW_DOCUMENT.md")
  const documentCalls = writesFor("write_document", documentPath)
  const documentRow = pipeline("checkpoint writes", persistenceEvidence("checkpoint writes", "document checkpoint", ["REVIEW_DOCUMENT.md", "checkpoint", "document"], summary,
    documentCalls, stored, parentID, input.fixture, documentPath, bookkeepingOrder))
  const stagedOK = staged("document", documentWrite) && !!documentDigest && documentWrite?.output.sha256 === documentDigest
  const claimedStaging = summary.split(/\r?\n/).some(line => /\b(?:staged|staging|begin.*append.*finalize)\b/i.test(line)
    && /\b(?:checkpoint|document|REVIEW_DOCUMENT)\b/i.test(line) && !/\b(?:failed|unavailable|missing|not staged)\b/i.test(line))
  const stagedRow = bookkeepingRow("document staged", { op: "document staging", aliases: ["document checkpoint", "REVIEW_DOCUMENT.md", "checkpoint", "document", diagnostic(documentCalls.at(-1)) ? text(documentCalls.at(-1)?.input.op) : "finalize"],
    summary, consistent: stagedOK, diagnostic: diagnostic(documentCalls.at(-1)),
    contradiction: documentRow.detail.startsWith("forged:") ? documentRow.detail.slice(8)
      : documentWrite?.input.op === "finalize" && matched(documentWrite) && !stagedOK ? "document finalize contradicts staging provenance"
      : claimedStaging && !stagedOK ? "document staging claimed without staged production (including single-call write_document)" : undefined,
    detail: "DB-matched begin → append → finalize; SHA equals checkpoint bytes; dispatch/measure timing is not a prerequisite" })
  const applicableStagedRow = pipeline("document staged", stagedRow)
  rows.push(applicableStagedRow)
  const inputRow = pipeline("input route", persistenceEvidence("input route", "review-input.json", ["write_input", "review-input", "input"], summary,
    writesFor("write_input", join(root, "review-input.json")), stored, parentID, input.fixture, join(root, "review-input.json"),
    tool => bookkeepingOrder(tool) && (tool.input.op === "write_input" || !matched(tool) || staged("input", tool))))
  const factsRow = pipeline("verified facts tool", persistenceEvidence("verified facts tool", "verified_facts.yaml", ["write_facts", "verified facts"], summary,
    writesFor("write_facts", join(root, "verified_facts.yaml")), stored, parentID, input.fixture, join(root, "verified_facts.yaml"), bookkeepingOrder))
  rows.push(factsRow)
  const appends = [...stored, ...descendants.flatMap(child => child.tools)].filter(tool => tool.name === "corvus_review_persist" && tool.input.op === "append")
  const lengths = appends.map(tool => typeof tool.input.text === "string" ? JSON.stringify(tool.input).length
    : typeof tool.input.body === "string" ? tool.input.body.length
    : JSON.stringify(tool.input.value ?? tool.input.chunk)?.length ?? Infinity)
  const oversized = new Map<string, number>()
  for (const tool of appends.filter(tool => tool.output.reason === "chunk-too-large")) {
    const key = JSON.stringify([tool.parentID, tool.input.staging_id, tool.input.index ?? tool.input.key ?? tool.input.comment, tool.input.field ?? tool.input.path, tool.input.part ?? 0])
    oversized.set(key, (oversized.get(key) ?? 0) + 1)
  }
  add("append ceiling", !auditError && lengths.every(length => length <= 6_000) && [...oversized.values()].every(count => count < 2)
    && allTools.filter(tool => tool.parentID === parentID && tool.name === "corvus_review_persist" && tool.input.op === "append")
      .every(tool => storedToolEvidence(tool, stored, parentID).kind === "matched"),
  5, auditError || `${appends.length} appends; maximum ${Math.max(0, ...lengths)} chars; no repeated chunk-too-large for one part`)
  if (light && appends.length === 0 && !auditError) rows[rows.length - 1] = pipeline("append ceiling", rows[rows.length - 1])
  rows.push(inputRow)
  rows.push(checkModelStateWrites(allTools, input.fixture, auditError))
  /** Inventories are read from persisted input and child DB results after shutdown;
   * any .corvus file/patch or unfiltered child call fails closed. Missing input
   * inherits its disclosure row; LOCAL skips PR reads, not scope filtering. */
  const hasStateFiles = (value: unknown, key = ""): boolean => {
    if (typeof value === "string") return (["filename", "path", "changed_files", "files"].includes(key) && /^(?:\.\/)?\.corvus\//.test(value))
      || /(?:^|\n)diff --git (?:"?a\/\.corvus\/|\S+ "?b\/\.corvus\/)/.test(value)
    if (Array.isArray(value)) return value.some(item => hasStateFiles(item, key))
    return Object.entries(record(value)).some(([name, item]) => key === "file_map" && name.startsWith(".corvus/") || hasStateFiles(item, name))
  }
  const reviewers = descendants.filter(child => (light ? ["pr-light-reviewer"] : ["pr-context-gatherer", "pr-code-reviewer", "security-reviewer"]).includes(child.agent))
  let inventoryOK = false
  try { inventoryOK = !hasStateFiles(json(read(join(root, "review-input.json")))) && reviewers.every(child => child.tools.every(tool =>
    tool.input.include_corvus !== true && !hasStateFiles(tool.output))) } catch {}
  const childInventoryOK = reviewers.every(child => child.tools.every(tool => tool.input.include_corvus !== true && !hasStateFiles(tool.output)))
  rows.push(!childError && childInventoryOK && !inputWrite ? { ...inputRow, check: "review inventories" }
    : { check: "review inventories", ok: !childError && inventoryOK, code: 5,
      detail: "gatherer/detector inventories and diffs exclude .corvus/**; only R0 uses the unfiltered layout inventory" })
  if (light) rows[rows.length - 1] = !childError && childInventoryOK ? pipeline("review inventories", rows[rows.length - 1])
    : { check: "review inventories", ok: false, code: 5, detail: childError || "forged: light detector consumed .corvus inventory" }
  rows.push(checkOrchestratorShell([...tools, ...stored, ...descendants.filter(child => ["corvus-review", "corvus-review-auto", "corvus-review-light"].includes(child.agent)).flatMap(child => child.tools)], input, auditError, lightAudit?.validatedHeads))
  rows.push(documentRow)
  let metadata: RecordValue = {}
  try { if (validIdentity) metadata = yaml(join(root, input.head, "meta.yaml")) } catch { /* Scored by metadata provenance below. */ }
  const metaCalls = stateCalls.filter(tool => tool.name === "corvus_review_persist" && tool.input.op === "write_meta"
    && tool.input.headSha === input.head && (tool.input.name ?? "meta.yaml") === "meta.yaml")
  const failureMeta = metaCalls.at(-1)
  const metaRow = pipeline("metadata", persistenceEvidence("metadata", "meta.yaml", ["write_meta", "metadata"], summary, metaCalls, stored, parentID,
    input.fixture, join(root, input.head, "meta.yaml"), bookkeepingOrder, (tool, bytes) => isDeepStrictEqual(record(load(bytes)), tool.input.meta)
      && metadata.autonomous === true && metadata.mode === (local ? "local" : "pr") && metadata.posted === false))
  if (metadata.posted === true) { metaRow.ok = false; metaRow.code = 6; metaRow.detail = "posting barrier breach: metadata claims posted" }
  const failedCheckpointCalls = [...documentCalls, ...writesFor("write_input", join(root, "review-input.json"))]
    .filter(tool => !succeeded(tool)).sort((a, b) => a.index - b.index)
  const failureState = Object.keys(metadata).length ? metadata : record(failureMeta?.input.meta)
  const checkpointFailed = failureState.status === "checkpoint-failed" || (!documentWrite || !inputWrite) && failedCheckpointCalls.length > 0
    || /checkpoint[-_]failed/.test(summary)
  const failureAttempt = failedCheckpointCalls.findLast(tool => tool.input.op === failureState.failed_op)
  const failureContradiction = failureState.status === "checkpoint-failed" && failedCheckpointCalls.length > 0
    && (!failureAttempt || failureState.reason !== diagnostic(failureAttempt)
      || Object.hasOwn(failureState, "part") && failureState.part !== (failureAttempt.input.part ?? 0)
      || Object.hasOwn(failureState, "stage") && failureState.stage !== (targetOf(failureAttempt) === "input" ? "review-input" : "document"))
      ? "checkpoint failure metadata contradicts recorded failed operation/diagnostic/part/stage" : undefined
  const failureRoute = bookkeepingRow("checkpoint-failed route", { op: "checkpoint", aliases: ["document", "REVIEW_DOCUMENT.md", text(failureAttempt?.input.op)], summary,
    consistent: !checkpointFailed, diagnostic: diagnostic(failureAttempt ?? failedCheckpointCalls.at(-1)), contradiction: failureContradiction,
    detail: "not applicable; checkpoint failure never forbids delivery" })
  rows.push(checkpointFailed ? aggregateRow("checkpoint-failed route", [failureRoute, documentRow, inputRow, metaRow], "checkpoint failure disclosed; posting permitted") : failureRoute)
  if (light) rows[rows.length - 1] = pipeline("checkpoint-failed route", rows[rows.length - 1])
  const sync = checkSync(input, events, tools, allTools, parentID, root, acquired, released, metadata, metaRow, notExposed, auditError)
  rows.push(...sync.rows)
  rows.push(metaRow)
  let persistedVerdict: RecordValue = {}, verdictError = ""
  try {
    const path = join(root, input.head, "verdict.yaml")
    if (!validIdentity || realpathSync(path) !== join(realpathSync(root), input.head, "verdict.yaml") || !statSync(path).isFile()) throw new Error("invalid verdict path")
    persistedVerdict = yaml(path)
  } catch { verdictError = "missing/invalid verdict.yaml" }
  rows.push(...checkVerdict(input, events, tools, parentID, root, documentWrite, released, metadata, persistedVerdict, verdictError, documentRow, metaRow))
  let lockOK = validIdentity
  let lockDetail = "absent"
  for (const name of ["lock.yaml", ".lock"]) if (validIdentity && existsSync(join(root, name))) {
    try { const status = String(yaml(join(root, name)).status); lockDetail = `${name}: ${status}`; lockOK &&= status === "completed" }
    catch { lockOK = false; lockDetail = `invalid ${name}` }
  }
  if (light) lockOK &&= !["lock.yaml", ".lock"].some(name => existsSync(join(root, name))) && released?.input.mode === "delete"
  /**
   * Terminal cleanup oracle: the owned release result and subsequent parent tool
   * events, read after shutdown alongside both lock files. Posted, non-post and
   * rail exits all require successful release after state/transport/dispatch work;
   * acquire/release must also match the DB; absent files alone do not prove cleanup. Only the exact push validated by
   * sync.push may follow release; other review tools/dispatches or failed cleanup
   * fail closed. No branch or host flag disables the release requirement.
   */
  const afterRelease = tools.filter(tool => released && tool.index > released.index
    && (tool.name.startsWith("corvus_review_") || ["task", "subagent"].includes(tool.name))
    && tool !== sync.validatedPush)
  if (!light) add("lock released", lockOK && Boolean(matched(acquired) && matched(released)) && afterRelease.length === 0, 5,
    `${lockDetail}; release=${released?.index ?? "missing"}; later review work=${afterRelease.map(tool => `${tool.index}:${tool.name}`).join(", ") || "none"}`)
  /**
   * Line-length oracle: the persisted review-input.json bytes, read after shutdown.
   * Host read/grep tools truncate lines above 2,000 characters, so any line over
   * REVIEW_INPUT_LINE_LIMIT means child evidence was unreachable. Unavailable
   * input inherits its disclosure row; present bytes never bypass the ceiling.
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
  rows.push(!inputWrite ? { ...inputRow, check: "review-input lines" } : { check: "review-input lines", ok: inputOK, code: 5, detail: inputDetail })
  if (light) rows[rows.length - 1] = pipeline("review-input lines", rows[rows.length - 1])

  /** Candidate oracle: successful single-call write_candidate input OR candidate
   * begin → same-id appends → finalize, all DB matched under the owned lock.
   * Reconstructed canonical bytes preserve comment-index order and anchors; the
   * returned canonical path/digest/byte+line counts must match the file. Read after
   * shutdown, never reconstructed from model prose. Missing parts/mismatches fail
   * closed. The canonical path is anchored to the resolved review root, allowing
   * parent aliases but rejecting a candidate symlink escape. Only the not-exposed
   * route may have removed its retained candidate. */
  let candidateValue: RecordValue = {}, candidateError = "", candidateOK = false
  let candidateMeasurement: ReturnType<typeof measure> | undefined
  if (!light && !local) {
    try {
      if (!candidateWrite || !matched(candidateWrite) || !underLock(candidateWrite)) throw new Error("missing DB-matched candidate producer under lock")
      if (candidateWrite.input.op === "write_candidate") candidateValue = record(candidateWrite.input.candidate)
      else {
        if (!staged("candidate", candidateWrite)) throw new Error("incomplete/mismatched candidate staging provenance")
        const begin = stateCalls.findLast(tool => tool.input.op === "begin" && tool.input.target === "candidate"
          && tool.output.staging_id === candidateWrite!.input.staging_id && tool.index < candidateWrite!.index)!
        candidateValue = stagedCandidate(begin, stateCalls.filter(tool => tool.input.op === "append"
          && tool.input.staging_id === candidateWrite!.input.staging_id && tool.index > begin.index && tool.index < candidateWrite!.index)
          .filter(succeeded).map(tool => matched(tool)!).sort((a, b) => a.index - b.index), candidateWrite)
      }
      candidateMeasurement = measure(candidateValue)
      if ("reason" in candidateMeasurement || candidateValue.commit_id !== input.head) throw new Error("invalid candidate schema/identity")
      const bytes = candidateMeasurement.canonical
      if (candidateWrite.output.sha256 !== candidateMeasurement.sha256 || candidateWrite.output.bytes !== Buffer.byteLength(bytes)
        || candidateWrite.output.lines !== bytes.split("\n").length - 1
        || !reportedPathMatches(input.fixture, candidateWrite.output.path, postingRoot, "candidate.json")) throw new Error("candidate producer report contradicts canonical bytes/path")
      if (existsSync(candidate) ? realpathSync(candidate) !== join(realpathSync(postingRoot), "candidate.json") || read(candidate) !== bytes : !notExposed) throw new Error("candidate file contradicts producer digest/comment order")
      candidateOK = true
    } catch (error) { candidateError = String(error) }
    add("candidate producer", candidateOK, 5, candidateOK ? `${candidateWrite!.input.op}=${candidateWrite!.index}; DB, staging, canonical bytes, comment order and digest agree` : `forged: ${candidateError}`)
  }
  if (!candidateOK) candidateWrite = undefined
  const measurements = tools.filter(tool => tool.name === "corvus_review_payload" && tool.input.op === "measure" && samePath(tool.input.candidatePath, candidate))
  const validMeasurement = (tool: Tool) => {
    if (!candidateMeasurement || "reason" in candidateMeasurement || tool.state.status !== "completed" || !matched(tool)) return false
    const { canonical, ...expected } = candidateMeasurement
    // The host measureFile result omits canonical; direct-library evidence may include it.
    return isDeepStrictEqual(tool.output, expected) || isDeepStrictEqual(tool.output, { ...expected, canonical })
  }
  const measured = measurements.findLast(tool => candidateWrite && tool.index > candidateWrite.index
    && validMeasurement(tool) && matched(tool)!.index > matched(candidateWrite)!.index)
  const freezeAttempts = tools.filter(tool => tool.name === "corvus_review_payload" && tool.input.op === "freeze")
  /** Freeze returns a real path. Read it after shutdown against the expected file
   * under the resolved review root, not the fixture's possibly aliased prefix.
   * Missing/unresolvable/escaping paths fail the producer chain; no bypass. */
  const frozen = freezeAttempts.findLast(tool => {
    try {
      return measured && tool.index > measured.index && matched(tool)
        && matched(tool)!.index > matched(measured)!.index && underLock(tool)
        && samePath(tool.input.candidatePath, candidate) && samePath(tool.input.artifactPath, artifact)
        && typeof tool.output.artifactPath === "string"
        && realpathSync(resolve(input.fixture, tool.output.artifactPath)) === join(realpathSync(postingRoot), "post-request.json") && succeeded(tool)
        && typeof tool.output.fitted === "boolean" && tool.output.fitted === (measured.output.ok === false)
    } catch { return false }
  })
  const digest = (!local || light) && validIdentity && existsSync(artifact) ? createHash("sha256").update(readFileSync(artifact)).digest("hex") : ""
  const candidateRow: Row = { check: "candidate producer", ok: local || candidateOK, code: 5, detail: candidateError || "candidate provenance valid" }
  const lockRow: Row = { check: "owned state writes", ok: Boolean(acquired && released && matched(acquired) && matched(released)), code: 5,
    detail: "successful state writes require a DB-matched owned lock and release" }
  if (!light) rows.push(aggregateRow("review-state tools", [lockRow, documentRow, stagedRow, inputRow, candidateRow], "tool-owned writes under matching acquire/release; no checkpoint-to-candidate prerequisite"))
  const postingArtifacts: Row = { check: "posting artifacts", ok: local || notExposed || existsSync(candidate) && existsSync(artifact), code: 5,
    detail: "candidate.json and post-request.json required for PR writer delivery" }
  if (!light) rows.push(aggregateRow("artifacts", [documentRow, metaRow, factsRow, inputRow, postingArtifacts], "all applicable artifacts present and consistent"))
  if (light) {
    rows.push(...lightAudit!.rows)
    const outsideClass = artifactTree(root).filter(path => !isLightClassPath(`${expectedRoot.replace(/^\.corvus\//, "")}/${path}`)
      && path !== "probe-meta.yaml" && !lightAudit!.foreignLocks.includes(path))
    add("light class isolation", outsideClass.length === 0, 5, `sync-eligible namespace files (excluding harness probe): ${JSON.stringify(outsideClass)}`)
  }
  let notExposedOK = false, notExposedDetail = ""
  if (notExposed) {
    try {
      const stored = readParentTools(input.db, parentID)
      const action = stateCalls.findLast(tool => tool.name === "corvus_review_persist" && tool.input.op === "write_meta"
        && tool.input.name === "review-action.yaml" && tool.input.headSha === input.head)
      const actionDB = matchedStoredTool(action, stored, parentID)
      const measuredDB = matchedStoredTool(measured, stored, parentID), releasedDB = matchedStoredTool(released, stored, parentID)
      const forbidden = [...allTools, ...stored].filter(tool => writer(tool) || tool.name === "corvus_review_post")
      const terminal = finalAssistantMessage(events, parentID), summary = terminal.text.replace(/[`*]/g, "")
      // R4/R5 mandate the classification, not passive-voice prose. Keep absence
      // distinct from denial; an active-voice claim must name the writer object.
      const writerNote = summary.split(/[.!?\n]+/).some(sentence => /\b(?:pr-comment-writer|writer)\b/i.test(sentence)
        && (/\bnot[- ]exposed\b/i.test(sentence) || /\bdoes not expose (?:the (?:required |authorized )?)?(?:pr-comment-writer|writer)\b/i.test(sentence)))
      const checks: Array<[string, boolean]> = [
        ["DB-matched R4 decision", Boolean(actionDB?.output.ok === true && reportedPathMatches(input.fixture, actionDB.output.path, root, join(input.head, "review-action.yaml"))
          && isDeepStrictEqual(actionDB.input.meta, reviewAction))],
        ["measure before R4 decision before release", Boolean(measured && action && released && measuredDB && actionDB && releasedDB
          && measured.index < action.index && action.index < released.index && measuredDB.index < actionDB.index && actionDB.index < releasedDB.index)],
        ["no POST/writer work; retained artifact has a freeze producer", !childError && forbidden.length === 0
          && !descendants.some(child => child.agent === "pr-comment-writer") && (!existsSync(artifact) || Boolean(frozen))],
        ["final no-post and writer-not-exposed disclosure", Boolean(released && terminal.index > released.index && writerNote
          && /\b(?:nothing (?:was )?posted|no (?:GitHub )?review (?:was )?posted|not posted)\b/i.test(summary))],
      ]
      const failures = checks.filter(([, ok]) => !ok).map(([check]) => check)
      notExposedOK = failures.length === 0
      notExposedDetail = notExposedOK ? `R4 writer not-exposed: measure=${measured!.index} → local_only=${action!.index}; inert artifact permitted, no writer/POST; final summary confirms nothing posted`
        : `R4 writer not-exposed evidence failed: ${failures.join("; ")}`
    } catch (error) { notExposedDetail = `R4 writer not-exposed evidence unreadable: ${String(error)}` }
  }
  if (!light && !local) {
    const inertAbsent = notExposed && !existsSync(artifact) && freezeAttempts.length === 0
    const previews = tools.filter(tool => tool.name === "corvus_review_payload" && tool.input.op === "preview")
    const previewsOK = previews.every(tool => {
      try {
        return Boolean(frozen && tool.index > frozen.index && matched(tool) && underLock(tool)
          && samePath(tool.input.artifactPath, artifact) && tool.input.expectedSha256 === digest
          && Object.keys(tool.input).every(key => ["op", "artifactPath", "expectedSha256"].includes(key))
          && (!succeeded(tool) || ["commit_id", "event", "body", "comments"].every(key => isDeepStrictEqual(tool.output[key], json(read(artifact))[key]))
            && tool.output.sha256 === digest))
      } catch { return false }
    })
    add("tool chain", Boolean(measured && (inertAbsent || frozen) && previewsOK && (!light || previews.some(succeeded)) && (!notExposed || notExposedOK)), 5,
      notExposed ? notExposedDetail : `producer=${candidateWrite?.index ?? "missing"} → measure=${measured?.index ?? "missing"} → freeze=${frozen?.index ?? "missing"}; ${previews.length} read-only preview(s)`)
    const digestOK = /^[a-f0-9]{64}$/.test(digest) && frozen?.output.sha256 === digest
    add("SHA-256", inertAbsent ? notExposedOK : digestOK, 5, inertAbsent ? notExposedDetail : digestOK ? digest : "forged: freeze digest contradicts independent artifact bytes")
    let verification = "artifact or digest unavailable"
    let verificationOK = false
    if (digest && frozen) {
      try {
        const modulePath = join(dirname(resolve(input.fixture)), "dist/review-payload.js")
        const built: { verify: typeof verify } = await import(pathToFileURL(modulePath).href)
        const result = built.verify(artifact, text(frozen.output.sha256), { reviewStateRoot: join(input.fixture, ".corvus") })
        const bytes = read(artifact), payload = json(bytes)
        verificationOK = result.ok && payload.commit_id === input.head && payload.event === candidateValue.event
          && isDeepStrictEqual(result.measurements, frozen.output.measurements)
          && (frozen.output.fitted === true || candidateMeasurement !== undefined && "canonical" in candidateMeasurement
            && bytes === candidateMeasurement.canonical && isDeepStrictEqual(frozen.output.omitted, { comments: 0, findings: 0 }))
        verification = JSON.stringify(result)
      } catch (error) { verification = String(error) }
    }
    add("built verify()", inertAbsent ? notExposedOK : verificationOK, 5, inertAbsent ? notExposedDetail : verification)
    const fitClaim = freezeAttempts.findLast(tool => tool.output.fitted === true)
    if (fitClaim) {
      let fitOK = false, omissionDisclosed = false
      try {
        const bytes = read(artifact), payload = json(bytes), size = measure(payload), omitted = record(fitClaim.output.omitted)
        const count = Number(omitted.comments) + Number(omitted.findings)
        const footer = `Review limits: ${count} findings omitted for size`
        const footerLines = text(payload.body).split("\n").filter(line => line.startsWith("Review limits:"))
        const omissionNote = normalizeNote(summary).replace(/"/g, "")
        omissionDisclosed = new RegExp(`\\b${count}\\s+findings?\\s+omitted\\s+for\\s+size\\b`, "i").test(omissionNote)
          || /\b(?:size[_ ]fit|fitted|for size)\b/.test(omissionNote) && /\bomitted\b/.test(omissionNote)
            && new RegExp(`\\bcomments\\s*[:=]\\s*${omitted.comments}\\b`).test(omissionNote)
            && new RegExp(`\\bfindings\\s*[:=]\\s*${omitted.findings}\\b`).test(omissionNote)
        fitOK = fitClaim === frozen && candidateOK && measured?.output.ok === false && size.ok && "canonical" in size
          && size.canonical === bytes && isDeepStrictEqual(size.measurements, fitClaim.output.measurements)
          && Array.isArray(payload.comments) && payload.comments.length === 0 && payload.commit_id === candidateValue.commit_id
          && payload.event === candidateValue.event && payload.commit_id === input.head
          && nonnegative(omitted.comments) && nonnegative(omitted.findings) && Number.isSafeInteger(count)
          && omitted.comments === (candidateValue.comments as unknown[]).length
          && footerLines.length === 1 && footerLines[0] === footer && text(payload.body).endsWith(footer)
          && digestOK
      } catch {}
      add("size fit", fitOK && omissionDisclosed, 5, !fitOK ? "forged: fitted result contradicts artifact limits/identity/omissions/digest"
        : !omissionDisclosed ? "undisclosed: size fit omissions failed without terminal note"
          : "fitted artifact within limits; empty comments, identity/event, omission footer/terminal count and digest agree")
    }
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
  if (local && !light) {
    const writerCalls = allTools.filter(writer)
    const writerChildren = descendants.filter(child => child.agent === "pr-comment-writer")
    add("LOCAL no writer", !auditError && writerCalls.length === 0 && writerChildren.length === 0, 6,
      auditError || `${writerCalls.length} writer dispatch attempts; ${writerChildren.length} writer child sessions`)
    const forbidden = allTools.filter(tool => tool.name === "corvus_review_post"
      || tool.name === "corvus_review_persist" && tool.input.op === "write_candidate"
      || tool.name === "corvus_review_persist" && (tool.input.target === "candidate" || /^candidate:/.test(text(tool.input.staging_id)))
      || tool.name === "corvus_review_payload" && ["measure", "freeze", "preview"].includes(text(tool.input.op)))
    add("LOCAL no posting tools", !auditError && forbidden.length === 0, 6,
      forbidden.length ? forbidden.map(tool => `${tool.parentID}:${tool.index} ${tool.name}:${text(tool.input.op)}`).join("; ")
        : auditError || "zero post, write_candidate, measure or freeze attempts")
    const terminal = finalAssistantMessage(events, parentID)
    const summary = terminal.text.replace(/[`*]/g, "")
    const counts = record(persistedVerdict.counts)
    const axisCounts = axes.every(axis => {
      const group = record(counts[axis])
      const total = labels.reduce((sum, label) => sum + Number(group[label]), 0)
      return labelCounts(group) && new RegExp(`\\b${axis}\\b[^\\d\\n]{0,40}${total}\\b`, "i").test(summary)
    })
    const documentPath = `${reviewRoot(input)}/${input.head}/REVIEW_DOCUMENT.md`
    const summaryRow = bookkeepingRow("LOCAL terminal summary", { op: "LOCAL summary", summary,
      consistent: Boolean(released && terminal.index > released.index && (documentWrite ? summary.includes(documentPath) : documentRow.ok)
        && (labelCounts(record(counts.standards)) ? axisCounts : /\bsynthesis(?:[- ](?:derived|only))? counts?\b/i.test(summary))),
      contradiction: verdictClaimContradiction(summary, documentResult(persistedVerdict) ? persistedVerdict : undefined),
      detail: "final path (when persisted) and verdict or explicitly labelled synthesis axis counts after release" })
    rows.push(aggregateRow("LOCAL terminal summary", [summaryRow, documentRow, metaRow], summaryRow.detail))
  } else if (input.writer && !light) {
    rows.push(...checkWriterDispatch({ owner: input.owner, repo: input.repo, pr: input.pr, fixture: input.fixture, digest, auditLines,
      parentTools: tools, afterIndex: frozen?.index, parentID: [...sessionIDs][0] ?? "", db: input.db, maxDispatches: 2 }))
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
      && succeeded(tool) && tool.output.code_head === input.head && !["CLOSED", "MERGED"].includes(text(tool.output.state).toUpperCase()) && tool.output.isMerged !== true)
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
  } else if (!light) {
  const rejectedWriter = attempts.find(tool => frozen && tool.index > frozen.index && tool.state.status === "error"
    && denied(diagnostic(tool) ?? ""))
  add("writer denied", (notExposed ? notExposedOK : Boolean(rejectedWriter)) && !successfulWriter, successfulWriter ? 6 : 5,
    successfulWriter ? "posting barrier breach: writer executed" : notExposed ? notExposedDetail : rejectedWriter ? diagnostic(rejectedWriter) ?? ""
      : attempts.length ? "writer dispatch lacks ordered denial evidence" : "stopped before writer dispatch")
  }

  add("GitHub barrier", existsSync(input.audit) && unsafe === 0 && (!local || blocked === 0), 6,
    `${forwarded} forwarded reads; ${canned} canned reads; ${blocked} blocked (${local ? "LOCAL requires zero" : "informational"}); ${unsafe} unsafe/malformed`)
  /** Denials remain hard except for the exact bookkeeping failure whose diagnostic
   * the terminal assistant discloses. Read trace+log after shutdown; no trace-only
   * exemption, and candidate/lock/mutation denials never gain a bypass. */
  const disclosedDenials = allTools.filter(tool => denied(diagnostic(tool) ?? "") && tool.parentID === parentID
    && (tool.name === "corvus_review_verdict" || tool.name === "corvus_review_sync"
      || tool.name === "corvus_review_persist" && (tool.input.op === "write_meta"
        || ["document", "input"].includes(text(targetOf(tool))) || ["write_document", "write_input", "write_facts"].includes(text(tool.input.op))))
    && [tool.name, text(tool.input.op), tool.input.op === "write_meta" ? text(tool.input.name) || "meta.yaml"
      : tool.name === "corvus_review_verdict" ? "verdict" : text(targetOf(tool))].some(op => disclosure(summary, op, diagnostic(tool))))
  const denialLines = lines(log).filter(line => {
    if (disclosedDenials.some(tool => normalizeNote(line).includes(normalizeNote(diagnostic(tool) ?? "")))) return false
    if (denied(line)) return !/pr-comment-writer/.test(line)
    return /action\.action=["']?deny|effect["':= ]+deny/.test(line)
      && /\b(edit|write|patch|apply_patch|read|external_directory|bash|shell)\b/.test(line)
      && /\.corvus\/(?:tasks\/[^/]+\/)?reviews|node_modules\/corvus-ai\/skill\//.test(line)
  })
  const toolDenials = allTools.filter(tool => denied(diagnostic(tool) ?? "") && !writer(tool) && !disclosedDenials.includes(tool)).map(tool => `${tool.name}: ${diagnostic(tool)}`)
  add("unexpected denials", !auditError && denialLines.length + toolDenials.length === 0, 5,
    [...denialLines, ...toolDenials].join("\n") || auditError || "none")
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
  let metrics: ReturnType<typeof countReviewMetrics> | undefined
  if (light) {
    try { metrics = countReviewMetrics(input.db, parentID); add("light metrics", true, 5, "complete stopped-host session tree counted") }
    catch (error) { add("light metrics", false, 5, String(error)) }
  }
  // No blanket checkpoint-failed conversion: only dependency rows above inherit
  // disclosure. Candidate/artifact, append, lock and transport rows remain hard.
  const exitCode = [6, 3, 4, 5].find(code => rows.some(row => !row.ok && row.code === code)) ?? 0
  return { rows, exitCode, usage: { steps: steps.length, cost, tokens, durationSeconds }, audit: { forwarded, canned, blocked, unsafe }, ...(light ? { metrics } : {}) }
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
    console.error("Usage: check-review-artifacts.ts <fixture> <owner> <repo> <pr> <code_head> <jsonl> <hostlog> <gh-audit> --db PATH --bare PATH --branch NAME [--agent auto|light] [--host v1|v2] [--agents PATH] [--install PATH] [--plugin-state PATH (required for v2)] [--writer] [--intake url|branch|local] [--cross-repo true|false]")
    printSmokeResult([{ check: "arguments", ok: false, code: 3, detail: "missing required arguments" }], 3)
    process.exit(3)
  }
  try {
    const { values } = parseArgs({ args: process.argv.slice(10), options: {
      host: { type: "string", default: "v2" }, agents: { type: "string" }, install: { type: "string" },
      agent: { type: "string", default: "auto" },
      "plugin-state": { type: "string" },
      writer: { type: "boolean", default: false }, db: { type: "string" },
      intake: { type: "string", default: "url" }, branch: { type: "string" }, bare: { type: "string" },
      "cross-repo": { type: "string", default: "false" },
    } })
    if (values.host !== "v1" && values.host !== "v2") throw new Error("--host must be v1 or v2")
    if (values.agent !== "auto" && values.agent !== "light") throw new Error("--agent must be auto or light")
    if (values.agent === "light" && values.writer) throw new Error("light harness requires denied writer")
    if (!["url", "branch", "local"].includes(values.intake)) throw new Error("--intake must be url, branch or local")
    if (values.intake === "local" && values.writer) throw new Error("LOCAL intake cannot execute the writer")
    if (!["true", "false"].includes(values["cross-repo"])) throw new Error("--cross-repo must be true or false")
    if (values.intake === "local" && values["cross-repo"] === "true") throw new Error("LOCAL intake cannot be cross-repository")
    const result = await checkReviewArtifacts({ fixture, owner, repo, pr, head, jsonl, hostlog, audit,
      agent: values.agent,
      host: values.host, agents: values.agents, install: values.install, pluginState: values["plugin-state"], writer: values.writer, db: values.db,
      intake: values.intake as Inputs["intake"], branch: values.branch, bare: values.bare, crossRepo: values["cross-repo"] === "true" })
    console.log("| Check | Result | Evidence |\n|---|---|---|")
    for (const row of result.rows) console.log(`| ${row.check} | ${row.ok ? "PASS" : "FAIL"} | ${row.detail.replaceAll("|", "\\|").replaceAll("\n", " <br> ")} |`)
    if (values.writer && values.db) {
      const parentID = lines(safeRead(jsonl)).flatMap(line => { try { const event = json(line); return [text(event.sessionID) || text(record(event.part).sessionID)] } catch { return [] } }).find(Boolean) ?? ""
      for (const child of readChildSessions(values.db, parentID, "pr-comment-writer")) {
        console.log(`Writer child ${child.id} tool sequence:`)
        for (const tool of child.tools) console.log(`${tool.index}:${tool.name}${tool.name === "bash" ? "(" + text(tool.input.command) + ")" : ["corvus_review_payload", "corvus_review_pr"].includes(tool.name) ? "(" + text(tool.input.op) + ")" : ""} → ${text(tool.state.status)}`)
      }
    }
    console.log(`Usage (top-level step_finish events only; not child-session billing): ${JSON.stringify(result.usage)}`)
    if (values.agent === "light") {
      const work = dirname(fixture)
      const wall = json(read(join(work, "agent-wall-clock.json")))
      if (!nonnegative(wall.seconds)) throw new Error("invalid agent wall clock")
      const metrics = { agent: "corvus-review-light", agentControlledWallClockSeconds: wall.seconds,
        ...(result.metrics ?? { childSessions: null, orchestratorTurns: null, toolCallsByTool: null }),
        measurementStatus: result.metrics ? "stopped-host tree measured" : "unavailable: see light metrics evidence row",
        localOnlyRows: result.rows.filter(row => ["sentinel bytes/index unchanged", "branch/HEAD unchanged", "ignore files unchanged", "zero local state commits",
          "remote refs unchanged", "mixed full push excludes light", "state commit scope", "state commit count", "Git push isolation", "light class isolation",
          "model shell pushes", "light model Git mutations", "lock released", "LOCAL no writer", "LOCAL no posting tools", "LOCAL terminal summary"].includes(row.check)),
        usageDisclosure: "Token/cost usage above is parent-only; session/tool counts cover the complete stopped-host tree." }
      writeFileSync(join(work, "light-metrics.json"), JSON.stringify(metrics, null, 2) + "\n")
      console.log(`Light metrics (${work}/light-metrics.json): ${JSON.stringify(metrics)}`)
    }
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

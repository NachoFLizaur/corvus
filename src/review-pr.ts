import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { resolve } from "node:path"

export type PrExecResult = { code: number; stdout: string; stderr: string; stdout_truncated?: true }
export type PrExec = (argv: string[], options?: { cwd?: string }) => Promise<PrExecResult>
export type PrOptions = { exec?: PrExec; timeoutMs?: number; cwd?: string }
export type PrRepoInput = { cwd?: string }
export type PrFindInput = PrRepoInput & { branch?: string }
export type PrLocalInput = PrRepoInput & { base?: string }
export type PrCandidate = { number: number; url: string; state: string; headRefName: string }
export type PrLocator = { owner: string; name: string; pr: number | string }
export type PrFilesInput = PrLocator & { paginate: true; include_corvus?: boolean; names_only?: boolean }
export type PrConfigInput = { owner: string; name: string; ref: string }
export type PrMetadata = {
  number: number
  url: string
  title: string
  body: string
  labels: Record<string, unknown>[]
  closingIssuesReferences: Record<string, unknown>[]
  latestReviews: Record<string, unknown>[]
  reviewDecision: string | null
  state: string
  isDraft: boolean
  mergeable: string
  author: { login: string } | null
  baseRefName: string
  baseRefOid: string
  headRefName: string
  headRefOid: string
  head_sha: string
  code_head: string
  isCrossRepository: boolean
  changedFiles: number
}
export type PrFile = {
  filename: string; status: string; additions: number; deletions: number
  has_patch: boolean; patch?: string
}
export type PrReview = {
  id: number; user: string | null; state: string; commit_id: string | null
  submitted_at: string | null; html_url: string; body: string; body_marker?: string
}
type FindingIdentity = {
  finding_id: string
  axis?: "standards" | "spec"
  dimension?: "architecture" | "correctness" | "conventions" | "security"
}
export type PrComment = FindingIdentity & {
  id: number; pull_request_review_id: number; in_reply_to_id: number | null
  html_url: string; body: string; path: string; line: number | null; original_line: number | null
  user: string | null; commit_id: string; original_commit_id: string
}
export type PrThread = { root: PrComment; replies: PrComment[] }
export type PrDisposition = FindingIdentity & {
  thread_url: string; state: "unknown"; evidence: string
}
export type PrCheck = { name: string; state: string; link: string }
export type PrData = {
  repo: { owner: string; name: string; source: "gh" | "git-remote" }
  find: { found: true; number: number; url: string; state: string } | { found: false; candidates: PrCandidate[] }
  local: {
    branch: string | null; head_sha: string; code_head: string; default_branch: string; merge_base: string; excluded_corvus: number
    ahead: number; changed_files: string[]; stat: string; diff: string; oversized: boolean; dirty: boolean
  }
  metadata: PrMetadata
  head: { head_sha: string; code_head: string; base_sha: string }
  files: { files: PrFile[] | string[]; complete_pagination: boolean; excluded_corvus: number }
  diff: { oversized: false; text: string; excluded_corvus: number } | { oversized: true; http_status?: number }
  reviews: {
    reviews: PrReview[]; threads: PrThread[]; dispositions: PrDisposition[]
    complete_pagination: boolean; complete_threads: boolean
  }
  checks: { checks: PrCheck[] }
  identity: { login: string }
  config: { present: false; http_status: 404 } | { present: true; yaml: string }
}
export type PrOperation = keyof PrData
export type PrFailure = {
  reason: string; http_status?: number; unavailable?: true; login?: null
  files?: PrFile[] | string[]; excluded_corvus?: number; reviews?: PrReview[]; threads?: PrThread[]; dispositions?: PrDisposition[]
  complete_pagination?: false; complete_threads?: boolean
}
export type PrResult<T> = ({ ok: true } & T | { ok: false } & PrFailure) & { api_calls: number }
export type PrInput =
  | ({ op: "metadata" | "head" | "diff" | "reviews" | "checks" } & PrLocator)
  | ({ op: "files" } & PrFilesInput)
  | ({ op: "config" } & PrConfigInput)
  | { op: "identity" }
  | ({ op: "repo" } & PrRepoInput)
  | ({ op: "find" } & PrFindInput)
  | ({ op: "local" } & PrLocalInput)

const DEFAULT_TIMEOUT_MS = 60_000
export const MAX_DIFF_BYTES = 512_000
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/
const SHA = /^[A-Fa-f0-9]{40}$/
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/
const ACCEPT_JSON = ["-H", "Accept: application/vnd.github+json"]
const METADATA_FIELDS = "number,url,title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,labels,reviewRequests,isDraft,mergeable,state,mergedAt,additions,deletions,changedFiles,files,closingIssuesReferences,latestReviews,reviewDecision,isCrossRepository"
const KEYS: Record<PrOperation, readonly string[]> = {
  metadata: ["owner", "name", "pr"], head: ["owner", "name", "pr"],
  files: ["owner", "name", "pr", "paginate", "include_corvus", "names_only"], diff: ["owner", "name", "pr"],
  reviews: ["owner", "name", "pr"], checks: ["owner", "name", "pr"],
  identity: [], config: ["owner", "name", "ref"], repo: ["cwd"],
  find: ["cwd", "branch"], local: ["cwd", "base"],
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value

class ReadFailure extends Error {
  constructor(readonly result: PrFailure) { super(result.reason) }
}
const fail = (reason: string): never => { throw new ReadFailure({ reason }) }

/**
 * Closed plain-data descriptors are copied and checked before exec. Invalid
 * controls reject for direct callers and the JSON executor without a request.
 * Full-string regex matches exclude trailing newlines; only immutable SHA refs
 * enter config URLs. No tool field can change options, headers, method or exec.
 */
function argumentsObject(input: unknown): Record<string, unknown> {
  if (!isRecord(input) || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    || Object.getOwnPropertySymbols(input).length) return fail("invalid-arguments")
  return Object.fromEntries(Object.getOwnPropertyNames(input).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!
    if (!("value" in descriptor)) return fail("invalid-arguments")
    return [key, descriptor.value]
  }))
}

type Target = { repo: string; endpoint: string; pr: string; cwd?: string; branch?: string; base?: string; include_corvus?: boolean; names_only?: boolean }
function target(op: PrOperation, input: unknown): Target {
  const args = argumentsObject(input)
  if (Object.keys(args).some(key => !KEYS[op].includes(key))) return fail("invalid-arguments")
  if (op === "identity") return { repo: "", endpoint: "", pr: "" }
  if (op === "repo" || op === "find" || op === "local") {
    if (args.cwd !== undefined && (typeof args.cwd !== "string" || args.cwd.length === 0 || /[\0\r\n]/.test(args.cwd))) return fail("invalid-input:cwd")
    for (const key of ["branch", "base"] as const) {
      if (args[key] !== undefined && (typeof args[key] !== "string" || !args[key].length || args[key].startsWith("-")
        || /[\u0000-\u0020\u007f]/.test(args[key]))) return fail(`invalid-input:${key}`)
    }
    return { repo: "", endpoint: "", pr: "", ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
      ...(typeof args.branch === "string" ? { branch: args.branch } : {}), ...(typeof args.base === "string" ? { base: args.base } : {}) }
  }
  if (!matches(args.owner, OWNER)) return fail("invalid-input:owner")
  if (!matches(args.name, NAME) || args.name === "." || args.name === "..") return fail("invalid-input:name")
  const repo = `${args.owner}/${args.name}`
  if (op === "config") {
    if (!matches(args.ref, SHA)) return fail("invalid-input:ref")
    return { repo, endpoint: `repos/${repo}/contents/.opencode/review-config.yaml?ref=${args.ref}`, pr: "" }
  }
  const pr = typeof args.pr === "number" ? String(args.pr) : args.pr
  if (!matches(pr, /^[1-9][0-9]*$/) || !Number.isSafeInteger(Number(pr))) return fail("invalid-input:pr")
  if (op === "files" && args.paginate !== true) return fail("invalid-input:paginate")
  for (const key of ["include_corvus", "names_only"] as const) {
    if (args[key] !== undefined && typeof args[key] !== "boolean") return fail(`invalid-input:${key}`)
  }
  return { repo, endpoint: `repos/${repo}/pulls/${pr}`, pr,
    include_corvus: args.include_corvus === true, names_only: args.names_only === true || args.include_corvus === true }
}

/**
 * A deadline starts before every injected exec or owned spawn. Expiry fails the
 * read, kills the owned process and permits no retry of that command; injected exec owns its
 * cancellation. Positive finite timer bounds are required and cannot be disabled.
 * PATH resolves fixed gh/git commands with inherited env and no shell; stdin is always closed.
 */
function execute(argv: string[], opts: PrOptions, timeoutMs: number, stdoutLimit?: number): Promise<PrExecResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams | undefined
    const timer = setTimeout(() => {
      reject(new ReadFailure({ reason: "timeout" }))
      child?.kill("SIGKILL")
    }, timeoutMs)
    const done = (value: PrExecResult) => { clearTimeout(timer); resolve(value) }
    const failed = () => { clearTimeout(timer); reject(new ReadFailure({ reason: "exec-failed" })) }
    try {
      if (opts.exec) { opts.exec(argv, { cwd: opts.cwd }).then(done, failed); return }
      child = spawn(argv[0], argv.slice(1), { stdio: "pipe", env: process.env, cwd: opts.cwd })
      let stdout = ""
      let stderr = ""
      let stdoutBytes = 0
      let truncated = false
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        if (truncated) return
        stdoutBytes += Buffer.byteLength(chunk)
        if (stdoutLimit !== undefined && stdoutBytes > stdoutLimit) { stdout = ""; truncated = true }
        else stdout += chunk
      })
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
      child.once("error", failed)
      child.once("close", code => { if (code === null) failed(); else done({ code, stdout, stderr, ...(truncated ? { stdout_truncated: true } : {}) }) })
      child.stdin.on("error", failed)
      child.stdin.end()
    } catch { failed() }
  })
}

function httpStatus(result: PrExecResult): number | undefined {
  const match = /\bHTTP\s+([45][0-9]{2})\b/.exec(result.stderr)
  return match ? Number(match[1]) : undefined
}
function failure(result: PrExecResult): PrFailure {
  const status = httpStatus(result)
  if (status !== undefined) {
    const reason = status === 403 ? "forbidden" : status === 404 ? "not-found"
      : status === 406 ? "not-acceptable" : status === 413 ? "payload-too-large"
      : status === 429 ? "rate-limited" : status >= 500 ? "server-error" : "http-error"
    return { reason, http_status: status }
  }
  return { reason: /(?:error connecting to|connection (?:refused|reset)|no such host|network is unreachable|TLS handshake|unexpected EOF|i\/o timeout|dial tcp)/i.test(result.stderr)
    ? "network-error" : "exec-failed" }
}
function requireSuccess(result: PrExecResult): void {
  if (result.code !== 0 || httpStatus(result) !== undefined) throw new ReadFailure(failure(result))
}
function json(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return fail("invalid-response") }
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : fail("invalid-response")
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : fail("invalid-response")
}
function string(value: unknown): string {
  return typeof value === "string" ? value : fail("invalid-response")
}
function count(value: unknown, minimum = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : fail("invalid-response")
}
function sha(value: unknown): string {
  return matches(value, SHA) ? value.toLowerCase() : fail("invalid-response")
}
function login(value: unknown): string | null {
  if (value === null) return null
  const name = record(value).login
  return matches(name, LOGIN) ? name : fail("invalid-response")
}
export function parseReviewMarker(body: unknown): { head: string; path?: string; round?: number; marker: string } | undefined {
  if (typeof body !== "string") return undefined
  const first = body.split(/\r?\n/, 1)[0]
  const v1 = /^<!-- corvus-review v1 head:([A-Fa-f0-9]{40}) -->$/.exec(first)
  if (v1?.[0] === first) return { head: v1[1].toLowerCase(), marker: `<!-- corvus-review v1 head:${v1[1].toLowerCase()} -->` }
  const v2 = /^<!-- corvus-review v2 path=(\.corvus\/(?:reviews|tasks\/[A-Za-z0-9._-]+\/reviews)\/(?:pr[1-9][0-9]*|local-[A-Za-z0-9._-]+)) head=([A-Fa-f0-9]{40}) round=([1-9][0-9]*) -->$/.exec(first)
  if (!v2 || v2[0] !== first || v2[1].split("/").some(part => part === "." || part === "..") || !Number.isSafeInteger(Number(v2[3]))) return undefined
  return { path: v2[1], head: v2[2].toLowerCase(), round: Number(v2[3]),
    marker: `<!-- corvus-review v2 path=${v2[1]} head=${v2[2].toLowerCase()} round=${v2[3]} -->` }
}
function marker(body: unknown): { body_marker?: string } {
  if (typeof body !== "string") return {}
  const parsed = parseReviewMarker(body)
  return parsed ? { body_marker: parsed.marker } : {}
}

type Pages = { pages: unknown[][]; complete: boolean }
/**
 * gh's concatenated JSON page arrays are scanned before projecting any records.
 * Success requires exit success, at least one page, and exhaustion of valid JSON;
 * malformed/truncated/error output retains only validated evidence with false
 * completeness for files and reviews. Neither empty records nor patches bypass it.
 */
function pages(text: string): Pages {
  const result: unknown[][] = []
  let start = 0
  while (start < text.length) {
    while (start < text.length && /[\t\r\n ]/.test(text[start])) start++
    if (start === text.length) break
    if (text[start] !== "[") return { pages: result, complete: false }
    let depth = 0
    let quoted = false
    let escaped = false
    let end = start
    for (; end < text.length; end++) {
      const character = text[end]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === '"') quoted = false
      } else if (character === '"') quoted = true
      else if (character === "[") depth++
      else if (character === "]" && --depth === 0) { end++; break }
    }
    if (depth !== 0 || quoted) return { pages: result, complete: false }
    try {
      const page: unknown = JSON.parse(text.slice(start, end))
      if (!Array.isArray(page)) return { pages: result, complete: false }
      result.push(page)
    } catch { return { pages: result, complete: false } }
    start = end
  }
  return { pages: result, complete: result.length > 0 }
}

type Context = { calls: number; run: (argv: string[], stdoutLimit?: number) => Promise<PrExecResult> }
type Listing<T> = { items: T[]; complete: boolean; error?: PrFailure }
async function listing<T>(endpoint: string, context: Context, project: (value: unknown) => T): Promise<Listing<T>> {
  const items: T[] = []
  try {
    const result = await context.run(["gh", "api", "--method", "GET", "--paginate", endpoint, ...ACCEPT_JSON])
    const parsed = pages(result.stdout)
    const unsuccessful = result.code !== 0 || httpStatus(result) !== undefined
    context.calls += Math.max(0, parsed.pages.length - 1) + ((unsuccessful || !parsed.complete) && parsed.pages.length > 0 ? 1 : 0)
    let invalidRecord = false
    for (const page of parsed.pages) {
      for (const value of page) {
        try { items.push(project(value)) } catch { invalidRecord = true }
      }
    }
    const error = unsuccessful ? failure(result)
      : !parsed.complete || invalidRecord ? { reason: "invalid-response" } : undefined
    return { items, complete: !error, ...(error ? { error } : {}) }
  } catch (error) {
    return { items, complete: false, error: error instanceof ReadFailure ? error.result : { reason: "exec-failed" } }
  }
}

function file(value: unknown): PrFile {
  const item = record(value)
  if (item.patch !== undefined && typeof item.patch !== "string") return fail("invalid-response")
  return {
    filename: string(item.filename), status: string(item.status),
    additions: count(item.additions), deletions: count(item.deletions),
    has_patch: typeof item.patch === "string",
    ...(typeof item.patch === "string" ? { patch: item.patch } : {}),
  }
}
function review(value: unknown): PrReview {
  const item = record(value)
  return {
    id: count(item.id, 1), user: login(item.user), state: string(item.state),
    commit_id: item.commit_id === null ? null : sha(item.commit_id),
    submitted_at: item.submitted_at === null ? null : string(item.submitted_at),
    html_url: string(item.html_url), body: string(item.body), ...marker(item.body),
  }
}
function findingIdentity(body: unknown, id: number): FindingIdentity {
  const identities = typeof body === "string" ? [...new Set(body.match(/\b(?:arch|logic|conv|sec)-(?:standards|spec)-[0-9]{3,}\b/g))] : []
  if (identities.length !== 1) return { finding_id: `thread-${id}` }
  const finding_id = identities[0]
  const [prefix, axis] = finding_id.split("-")
  const dimensions: Record<string, NonNullable<FindingIdentity["dimension"]>> = {
    arch: "architecture", logic: "correctness", conv: "conventions", sec: "security",
  }
  return { finding_id, axis: axis as "standards" | "spec", dimension: dimensions[prefix] }
}
function comment(value: unknown): PrComment {
  const item = record(value)
  const id = count(item.id, 1)
  return {
    id, pull_request_review_id: count(item.pull_request_review_id, 1),
    in_reply_to_id: item.in_reply_to_id === undefined || item.in_reply_to_id === null ? null : count(item.in_reply_to_id, 1),
    html_url: string(item.html_url), body: string(item.body), path: string(item.path),
    line: item.line === null ? null : count(item.line, 1),
    original_line: item.original_line === null ? null : count(item.original_line, 1),
    user: login(item.user), commit_id: sha(item.commit_id), original_commit_id: sha(item.original_commit_id),
    ...findingIdentity(item.body, id),
  }
}

/**
 * Only API-rooted threads from marker-bearing review IDs produce dispositions.
 * Read IDs/reply links before joining; duplicates, missing parents or cycles keep
 * thread coverage incomplete. Bodies remain untrusted source evidence, so every disposition is unknown
 * with commit evidence, never a claimed fix/refusal. No marker grants authority.
 */
function threads(reviews: PrReview[], comments: PrComment[], complete: boolean): Pick<PrData["reviews"], "threads" | "dispositions" | "complete_threads"> {
  const priorIds = new Set(reviews.filter(item => item.body_marker).map(item => item.id))
  const byId = new Map(comments.map(item => [item.id, item]))
  const roots = comments.filter(item => item.in_reply_to_id === null && priorIds.has(item.pull_request_review_id))
  const groups = new Map(roots.map(root => [root.id, { root, replies: [] as PrComment[] }]))
  let completeThreads = complete && byId.size === comments.length && new Set(reviews.map(item => item.id)).size === reviews.length
  for (const item of comments) {
    if (item.in_reply_to_id === null) continue
    let current = item
    const seen = new Set([item.id])
    while (current.in_reply_to_id !== null) {
      const parent = byId.get(current.in_reply_to_id)
      if (!parent || seen.has(parent.id)) { completeThreads = false; break }
      seen.add(parent.id)
      current = parent
    }
    if (current.in_reply_to_id === null) groups.get(current.id)?.replies.push(item)
  }
  return {
    threads: [...groups.values()], complete_threads: completeThreads,
    dispositions: roots.map(root => ({
      finding_id: root.finding_id, ...(root.axis ? { axis: root.axis } : {}),
      ...(root.dimension ? { dimension: root.dimension } : {}),
      thread_url: root.html_url, state: "unknown", evidence: root.original_commit_id,
    })),
  }
}

/**
 * Auth status account entries, not arbitrary login-like text, are the fallback
 * oracle. Inspect each entry's own success and active flag for github.com before
 * returning a login. Ambiguity or malformed flags fail unknown even if another
 * entry looks usable. Only user-API HTTP 403 enables this one fallback; nothing
 * permits inactive, failed, timed-out or other-host entries to establish identity.
 */
function activeLogin(result: PrExecResult): string | undefined {
  if (![0, 1].includes(result.code)) return undefined
  const candidates: string[] = []
  let activeEntries = 0
  let invalid = false
  for (const output of [result.stdout, result.stderr]) {
    const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)
    let entry: { github: boolean; login?: string; active: string[] } | undefined
    const finish = () => {
      if (entry?.github) {
        if (entry.active.length !== 1 || !["true", "false"].includes(entry.active[0])) invalid = true
        else if (entry.active[0] === "true") {
          activeEntries++
          if (entry.login) candidates.push(entry.login)
        }
      }
      entry = undefined
    }
    for (const line of lines) {
      const heading = /^\s*[✓✔Xx!]\s+(?:Logged in to|Failed to log in to|Timeout trying to log in to)\s/.test(line)
      if (heading) {
        finish()
        const success = /^\s*[✓✔]\s+Logged in to github\.com account (\S+) \([^\r\n]+\)\s*$/.exec(line)
        entry = {
          github: /(?:Logged in to|Failed to log in to|Timeout trying to log in to) github\.com (?:account|using token)\b/.test(line),
          active: [], ...(success && matches(success[1], LOGIN) ? { login: success[1] } : {}),
        }
      } else if (/^\S/.test(line)) finish()
      else {
        const active = /^\s*- Active account: (\S+)\s*$/.exec(line)
        if (entry && active) entry.active.push(active[1])
      }
    }
    finish()
  }
  return !invalid && activeEntries === 1 && candidates.length === 1 ? candidates[0] : undefined
}

type OperationResult<O extends PrOperation> = ({ ok: true } & PrData[O]) | ({ ok: false } & PrFailure)
type Handlers = { [O in PrOperation]: (target: Target, context: Context) => Promise<OperationResult<O>> }

function repository(text: string): { owner: string; name: string } | undefined {
  const parts = text.split("/")
  if (parts.length !== 2) return undefined
  const [owner, name] = parts
  return matches(owner, OWNER) && matches(name, NAME) && name !== "." && name !== ".." ? { owner, name } : undefined
}

/**
 * Repository identity comes from validated gh output, then origin's GitHub URL,
 * read before any PR request or mutation. Both failures return no-repository;
 * malformed or other-host remotes never establish a target. Only a usable gh
 * result skips the fallback; cwd selects process context, never shell arguments.
 */
async function repositoryFromContext(context: Context): Promise<OperationResult<"repo">> {
  try {
    const result = await context.run(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
    requireSuccess(result)
    const repo = repository(result.stdout.replace(/\r?\n$/, ""))
    if (repo) return { ok: true, ...repo, source: "gh" }
  } catch { /* The local origin remains available when gh fails. */ }
  try {
    const result = await context.run(["git", "remote", "get-url", "origin"])
    if (result.code !== 0) return { ok: false, reason: "no-repository" }
    const remote = result.stdout.replace(/\r?\n$/, "")
    const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com(?::[0-9]+)?\/|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remote)
    const repo = match?.[0] === remote ? repository(match[1]) : undefined
    if (repo) return { ok: true, ...repo, source: "git-remote" }
  } catch { /* Neither source established a repository. */ }
  return { ok: false, reason: "no-repository" }
}

/**
 * UTF-8 patch bytes (or the owned spawn's overflow flag) are checked before a
 * diff is returned. Both PR and local consumers get oversized, never a partial
 * patch, above MAX_DIFF_BYTES; equality is allowed. No caller option disables
 * this ceiling. Owned spawns discard overflow while draining; injected execs
 * own their buffering. These read operations perform no repository mutation.
 */
function boundedDiff(result: PrExecResult): { diff: string; oversized: boolean } {
  const oversized = result.stdout_truncated === true || Buffer.byteLength(result.stdout) > MAX_DIFF_BYTES
  return { diff: oversized ? "" : result.stdout, oversized }
}

function candidate(value: unknown): PrCandidate {
  const item = record(value)
  return { number: count(item.number, 1), url: string(item.url), state: string(item.state), headRefName: string(item.headRefName) }
}

async function gitRead(context: Context, args: string[], stdoutLimit?: number): Promise<PrExecResult> {
  const result = await context.run(["git", ...args], stdoutLimit)
  if (result.code !== 0) return fail("git-read-failed")
  return result
}

async function defaultBranch(context: Context): Promise<{ name: string; ref: string }> {
  const remote = await context.run(["git", "symbolic-ref", "refs/remotes/origin/HEAD"])
  if (remote.code === 0) {
    const ref = remote.stdout.replace(/\r?\n$/, "")
    if (!ref.startsWith("refs/remotes/origin/") || /[\u0000-\u0020\u007f]/.test(ref)) return fail("invalid-response")
    const name = ref.slice("refs/remotes/origin/".length)
    if (!name) return fail("invalid-response")
    return { name, ref }
  }
  for (const name of ["main", "master"]) {
    const ref = `refs/heads/${name}`
    const result = await context.run(["git", "show-ref", "--verify", "--quiet", ref])
    if (result.code === 0) return { name, ref }
    if (result.code !== 1) return fail("git-read-failed")
  }
  return fail("no-default-branch")
}

async function localChanges(target: Target, context: Context): Promise<OperationResult<"local">> {
  const branch = (await gitRead(context, ["branch", "--show-current"])).stdout.replace(/\r?\n$/, "") || null
  const head_sha = sha((await gitRead(context, ["rev-parse", "HEAD"])).stdout.trim())
  const log = (await gitRead(context, ["log", "--format=%H%x00%s", "-z", "HEAD", "--"])).stdout.split("\0")
  let code_head: string | undefined
  for (let index = 0; index + 1 < log.length; index += 2) {
    if (!log[index + 1].startsWith("corvus(review-state):")) { code_head = sha(log[index]); break }
  }
  if (!code_head) return fail("no-code-head")
  const base = await defaultBranch(context)
  const merge = await gitRead(context, ["merge-base", target.base ?? base.ref, "HEAD"])
  const merge_base = sha(merge.stdout.trim())
  const aheadText = (await gitRead(context, ["rev-list", "--count", `${merge_base}..HEAD`])).stdout.trim()
  if (!matches(aheadText, /^[0-9]+$/)) return fail("invalid-response")
  const ahead = count(Number(aheadText))
  const stat = (await gitRead(context, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--stat", merge_base, "--", ".", ":(top,exclude).corvus/**"])).stdout
  const names = (await gitRead(context, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--name-only", "-z", merge_base, "--"])).stdout
  const patch = await gitRead(context, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-p", merge_base, "--", ".", ":(top,exclude).corvus/**"], MAX_DIFF_BYTES)
  const status = await gitRead(context, ["--no-optional-locks", "status", "--porcelain"])
  return { ok: true, branch, head_sha, code_head, default_branch: base.name, merge_base, ahead,
    excluded_corvus: names.split("\0").filter(isCorvusFile).length,
    changed_files: names.split("\0").filter(Boolean), stat, ...boundedDiff(patch), dirty: status.stdout.length > 0 }
}

const isCorvusFile = (name: string): boolean => name.startsWith(".corvus/")

/** Complete paginated commits ending at the observed tip are read before returning identity; incomplete/moving history fails closed, without a fallback to a state SHA. */
async function codeHead(target: Target, context: Context, tip: string): Promise<string> {
  const commits = await listing(`${target.endpoint}/commits`, context, value => {
    const item = record(value)
    return { sha: sha(item.sha), message: string(record(item.commit).message) }
  })
  if (commits.error) throw new ReadFailure(commits.error)
  if (commits.items.at(-1)?.sha !== tip) return fail("head-moved")
  return commits.items.findLast(item => !item.message.startsWith("corvus(review-state):"))?.sha ?? fail("no-code-head")
}

/** Diff section headers, including quoted Git paths, are inspected before returning review text. Either side under .corvus excludes that section; no review-diff option bypasses this rule. */
function filterDiff(text: string): { text: string; excluded_corvus: number } {
  let excluded_corvus = 0
  const sections = text.split(/(?=^diff --git )/m).filter(section => {
    const header = section.split("\n", 1)[0]
    const excluded = /^diff --git (?:"?a\/\.corvus\/|.* "?b\/\.corvus\/)/.test(header)
    if (excluded) excluded_corvus++
    return !excluded
  })
  return { text: sections.join(""), excluded_corvus }
}

const handlers: Handlers = {
  async repo(_target, context) { return repositoryFromContext(context) },
  async find(target, context) {
    const result = await context.run(target.branch === undefined
      ? ["gh", "pr", "view", "--json", "number,url,headRefName,state"]
      : ["gh", "pr", "list", "--head", target.branch, "--state", "all", "--json", "number,url,state,headRefName", "--limit", "5"])
    if (result.code !== 0 && httpStatus(result) === undefined && /^no pull requests found\b[^\r\n]*\r?\n?$/i.test(result.stderr)) {
      return { ok: true, found: false, candidates: [] }
    }
    requireSuccess(result)
    const candidates = target.branch === undefined ? [candidate(json(result.stdout))] : records(json(result.stdout)).map(candidate)
    if (target.branch !== undefined && candidates.some(item => item.headRefName !== target.branch)) return fail("discovery-branch-mismatch")
    if (candidates.length !== 1) return { ok: true, found: false, candidates }
    const { number, url, state } = candidates[0]
    return { ok: true, found: true, number, url, state }
  },
  async local(target, context) { return localChanges(target, context) },
  async metadata(target, context) {
    const result = await context.run(["gh", "pr", "view", target.pr, "--repo", target.repo, "--json", METADATA_FIELDS])
    requireSuccess(result)
    const item = record(json(result.stdout))
    const number = count(item.number, 1)
    const url = string(item.url)
    if (number !== Number(target.pr) || url.toLowerCase() !== `https://github.com/${target.repo}/pull/${target.pr}`.toLowerCase()) return fail("metadata-identity-mismatch")
    if (typeof item.isDraft !== "boolean" || typeof item.isCrossRepository !== "boolean") return fail("invalid-response")
    const head_sha = sha(item.headRefOid)
    const code_head = await codeHead(target, context, head_sha)
    return {
      ok: true, number, url, title: string(item.title), state: string(item.state),
      body: string(item.body), labels: records(item.labels),
      closingIssuesReferences: records(item.closingIssuesReferences), latestReviews: records(item.latestReviews),
      reviewDecision: item.reviewDecision === null ? null : string(item.reviewDecision),
      isDraft: item.isDraft, mergeable: string(item.mergeable), head_sha, code_head, isCrossRepository: item.isCrossRepository,
      author: item.author === null ? null : { login: login(item.author)! },
      baseRefName: string(item.baseRefName), baseRefOid: sha(item.baseRefOid),
      headRefName: string(item.headRefName), headRefOid: sha(item.headRefOid), changedFiles: count(item.changedFiles),
    }
  },
  async head(target, context) {
    const result = await context.run(["gh", "api", "--method", "GET", target.endpoint, ...ACCEPT_JSON])
    requireSuccess(result)
    const item = record(json(result.stdout))
    const head_sha = sha(record(item.head).sha)
    return { ok: true, head_sha, code_head: await codeHead(target, context, head_sha), base_sha: sha(record(item.base).sha) }
  },
  async files(target, context) {
    const result = await listing(`${target.endpoint}/files`, context, value => target.names_only ? string(record(value).filename) : file(value))
    const items = result.items.filter(item => target.include_corvus || !isCorvusFile(typeof item === "string" ? item : item.filename))
    const data = { files: items as PrFile[] | string[], excluded_corvus: result.items.length - items.length }
    return result.error ? { ok: false, ...result.error, ...data, complete_pagination: false }
      : { ok: true, ...data, complete_pagination: result.complete }
  },
  async diff(target, context) {
    const result = await context.run(["gh", "api", "--method", "GET", target.endpoint, "-H", "Accept: application/vnd.github.v3.diff"], MAX_DIFF_BYTES)
    const status = httpStatus(result)
    if (status === 406 || status === 413) return { ok: true, oversized: true, http_status: status }
    requireSuccess(result)
    const bounded = boundedDiff(result)
    return bounded.oversized ? { ok: true, oversized: true } : { ok: true, oversized: false, ...filterDiff(bounded.diff) }
  },
  async reviews(target, context) {
    const reviews = await listing(`${target.endpoint}/reviews`, context, review)
    const comments: Listing<PrComment> = reviews.error ? { items: [], complete: false } : await listing(`${target.endpoint}/comments`, context, comment)
    const complete = reviews.complete && comments.complete
    const data = { reviews: reviews.items, ...threads(reviews.items, comments.items, complete), complete_pagination: complete }
    const error = reviews.error ?? comments.error
    return error ? { ok: false, ...error, ...data, complete_pagination: false } : { ok: true, ...data }
  },
  async checks(target, context) {
    const result = await context.run(["gh", "pr", "checks", target.pr, "--repo", target.repo, "--json", "name,state,link"])
    if (httpStatus(result) !== undefined) throw new ReadFailure(failure(result))
    if (result.code === 1 && result.stdout.trim() === "" && /^no checks reported on the '[^\r\n]*' branch\r?\n?$/.test(result.stderr)) {
      return { ok: true, checks: [] }
    }
    if (![0, 1, 8].includes(result.code) || (result.code !== 0 && (result.stderr.trim() !== "" || result.stdout.trim() === ""))) throw new ReadFailure(failure(result))
    const items = json(result.stdout)
    if (!Array.isArray(items)) return fail("invalid-response")
    return { ok: true, checks: items.map(value => {
      const item = record(value)
      return { name: string(item.name), state: string(item.state), link: string(item.link) }
    }) }
  },
  async identity(_target, context) {
    const result = await context.run(["gh", "api", "user", "--jq", ".login"])
    if (httpStatus(result) === 403) {
      const status = await context.run(["gh", "auth", "status"])
      const name = activeLogin(status)
      if (name) return { ok: true, login: name }
      return { ok: false, login: null, reason: "identity-unavailable", http_status: 403 }
    }
    requireSuccess(result)
    const name = result.stdout.replace(/\r?\n$/, "")
    if (!matches(name, LOGIN)) return fail("identity-unavailable")
    return { ok: true, login: name }
  },
  async config(target, context) {
    const result = await context.run(["gh", "api", "--method", "GET", target.endpoint, "-H", "Accept: application/vnd.github.raw+json"])
    if (httpStatus(result) === 404) return { ok: true, present: false, http_status: 404 }
    requireSuccess(result)
    return { ok: true, present: true, yaml: result.stdout }
  },
}

/**
 * Validation precedes every read; only fixed handlers can construct argv. Errors
 * return fixed reason codes and stderr HTTP status, never raw diagnostics/bodies.
 * Explicit diff text, file patches, config YAML and metadata/review/comment bodies
 * are untrusted source data. These rules apply to all exported entrypoints.
 * api_calls counts dispatched gh commands plus observed extra pagination arrays and
 * a failed next page. gh's hidden internal requests and pages lost on timeout are
 * not observable through exec; the count is not an HTTP wire-traffic measurement.
 */
async function perform<O extends PrOperation>(op: O, input: unknown, options: PrOptions): Promise<PrResult<PrData[O]>> {
  const context: Context = { calls: 0, run: async () => fail("invalid-options") }
  try {
    const destination = target(op, input)
    if (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.length === 0 || /[\0\r\n]/.test(options.cwd))) return fail("invalid-cwd")
    const opts = { exec: options.exec, timeoutMs: options.timeoutMs,
      cwd: destination.cwd === undefined ? options.cwd : resolve(options.cwd ?? process.cwd(), destination.cwd) }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return fail("invalid-timeout")
    if (opts.exec !== undefined && typeof opts.exec !== "function") return fail("invalid-exec")
    context.run = async (argv, stdoutLimit) => {
      if (argv[0] === "gh") context.calls++
      const result = await execute(argv, opts, timeoutMs, stdoutLimit)
      if (!isRecord(result) || !Number.isInteger(result.code) || typeof result.stdout !== "string" || typeof result.stderr !== "string") return fail("invalid-exec-result")
      return result
    }
    return { ...await handlers[op](destination, context), api_calls: context.calls }
  } catch (error) {
    return {
      ok: false, ...(error instanceof ReadFailure ? error.result : { reason: "invalid-response" }),
      ...(op === "identity" ? { login: null } : {}), ...(op === "checks" ? { unavailable: true as const } : {}),
      ...(op === "files" || op === "reviews" ? { complete_pagination: false as const } : {}),
      api_calls: context.calls,
    }
  }
}

export const metadata = (input: PrLocator, opts: PrOptions = {}) => perform("metadata", input, opts)
export const head = (input: PrLocator, opts: PrOptions = {}) => perform("head", input, opts)
export const files = (input: PrFilesInput, opts: PrOptions = {}) => perform("files", input, opts)
export const diff = (input: PrLocator, opts: PrOptions = {}) => perform("diff", input, opts)
export const reviews = (input: PrLocator, opts: PrOptions = {}) => perform("reviews", input, opts)
export const checks = (input: PrLocator, opts: PrOptions = {}) => perform("checks", input, opts)
export const identity = (opts: PrOptions = {}) => perform("identity", {}, opts)
export const repo = (input: PrRepoInput = {}, opts: PrOptions = {}) => perform("repo", input, opts)
export const find = (input: PrFindInput = {}, opts: PrOptions = {}) => perform("find", input, opts)
export const local = (input: PrLocalInput = {}, opts: PrOptions = {}) => perform("local", input, opts)
export const config = (input: PrConfigInput, opts: PrOptions = {}) => perform("config", input, opts)

/** Capture host-only exec/deadline options; tool callers receive JSON strings. */
export function createPrExecutor(options: PrOptions = {}): (input: unknown) => Promise<string> {
  const opts = { exec: options.exec, timeoutMs: options.timeoutMs, cwd: options.cwd }
  return async input => {
    try {
      const { op, ...args } = argumentsObject(input)
      if (typeof op !== "string" || !Object.hasOwn(KEYS, op)) return fail("invalid-op")
      return JSON.stringify(await perform(op as PrOperation, args, opts))
    } catch (error) {
      return JSON.stringify({ ok: false, ...(error instanceof ReadFailure ? error.result : { reason: "invalid-arguments" }), api_calls: 0 })
    }
  }
}

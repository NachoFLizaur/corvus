import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"
import { isReviewCallerAllowed } from "./review-callers"

export type WorktreeInput = { op: "create" | "remove"; cwd?: string; pr: number; code_head: string; runId: string }
export type WorktreeExecResult = { code: number; stdout: Buffer; stderr: string }
export type WorktreeExec = (argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: Buffer; timeoutMs: number; maxBytes: number }) => Promise<WorktreeExecResult>
export type WorktreeOptions = { cwd?: string; exec?: WorktreeExec; timeoutMs?: number }
type Failure = { ok: false; reason: string; path?: string; command?: string[]; message?: string; cleanup?: Failure }
type Registration = { path: string; head?: string; detached: boolean }
type Entry = { path: string; mode: string; type: string; sha: string; size: number }
export type WorktreeResult = Failure | {
  ok: true; path: string; head: string; populated_files: number;
  skipped: { path: string; reason: "submodule" }[]; symlinks_as_files: string[]; preexisting_corvus_worktrees: string[];
} | { ok: true; path: string; state: "removed" | "absent" }
const SHA = /^[a-f0-9]{40}$/
const TIMEOUT_MS = 60_000
const MAX_OUTPUT = 64 * 1024 * 1024
const MAX_TREE_BYTES = 256 * 1024 * 1024
class WorktreeFailure extends Error {
  constructor(readonly result: Failure) { super(result.reason) }
}
const fail = (reason: string, details: Omit<Failure, "ok" | "reason"> = {}): never => { throw new WorktreeFailure({ ok: false, reason, ...details }) }
const missing = (error: unknown): boolean => error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"
function exists(path: string): boolean {
  try { fs.lstatSync(path); return true } catch (error) { if (missing(error)) return false; throw error }
}

/** Plain, closed data descriptors are checked before Git/fs I/O. runId follows
 * lock's nonempty-string grammar; hashing the full UTF-8 value makes its path
 * fragment safe without trimming or conflating whitespace. No argument bypasses
 * validation or supplies host dependencies. Invalid controls fail closed. */
function argumentsObject(value: unknown): WorktreeInput {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) fail("invalid-arguments")
  const args: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!("value" in descriptor) || !["op", "cwd", "pr", "code_head", "runId"].includes(key)) fail("invalid-arguments")
    args[key] = descriptor.value
  }
  if (args.op !== "create" && args.op !== "remove") fail("invalid-op")
  if (typeof args.pr !== "number" || !Number.isSafeInteger(args.pr) || args.pr <= 0
    || typeof args.code_head !== "string" || SHA.exec(args.code_head)?.[0] !== args.code_head
    || typeof args.runId !== "string" || !args.runId.trim()
    || (args.cwd !== undefined && (typeof args.cwd !== "string" || !args.cwd.trim() || /[\0\r\n]/.test(args.cwd)))) fail("invalid-arguments")
  return args as WorktreeInput
}

/** The process has an operation deadline and bounded binary output before spawn;
 * errors/timeout kill it and reject. argv/stdin are data, never shell or filters.
 * An injected host exec owns cancellation; no tool input changes these limits. */
function execute(argv: string[], options: Parameters<WorktreeExec>[1], injected?: WorktreeExec): Promise<WorktreeExecResult> {
  return new Promise((resolveResult, reject) => {
    let child: ReturnType<typeof spawn> | undefined
    const stop = (reason: string) => { clearTimeout(timer); child?.kill("SIGKILL"); reject(new WorktreeFailure({ ok: false, reason, command: argv })) }
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs)
    const done = (result: WorktreeExecResult) => { clearTimeout(timer); resolveResult(result) }
    if (injected) { injected(argv, options).then(done, () => stop("exec-failed")); return }
    try {
      child = spawn("git", argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
      const out: Buffer[] = [], err: Buffer[] = []
      let size = 0
      const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length
        if (size > options.maxBytes) stop("output-limit")
        else chunks.push(chunk)
      }
      child.stdout!.on("data", collect(out))
      child.stderr!.on("data", collect(err))
      child.stdin!.on("error", () => stop("exec-failed"))
      child.once("error", () => stop("exec-failed"))
      child.once("close", code => code === null ? stop("exec-failed") : done({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }))
      child.stdin!.end(options.input)
    } catch { stop("exec-failed") }
  })
}

/** Host cwd resolves relative spellings; canonical Git top-level is the sibling
 * oracle before any mutation. All commands disable hooks, fsmonitor, replacement
 * objects and optional locks, scrub inherited Git control variables, and avoid
 * global/system config. Repository config is still read by Git for repository
 * discovery, but no checkout/attribute/textconv/filter command consumes PR files.
 * Index writes explicitly select ONLY the new worktree index. No bypass exists. */
function context(opts: WorktreeOptions) {
  const deadline = Date.now() + (opts.timeoutMs ?? TIMEOUT_MS)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" })
  const checkTime = () => { if (Date.now() >= deadline) fail("timeout") }
  const run = async (cwd: string, args: string[], input?: Buffer, index?: string) => {
    checkTime()
    const argv = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "core.symlinks=false", "-c", "core.splitIndex=false", "-c", "core.sparseCheckout=false", "-c", "index.sparse=false", ...args]
    const result = await execute(argv, { cwd, env: { ...env, ...(index ? { GIT_INDEX_FILE: index } : {}) }, input, timeoutMs: Math.max(1, deadline - Date.now()), maxBytes: MAX_OUTPUT }, opts.exec)
    if (!result || !Number.isInteger(result.code) || !Buffer.isBuffer(result.stdout) || typeof result.stderr !== "string") fail("invalid-exec-result")
    return { ...result, command: argv }
  }
  const read = async (cwd: string, args: string[], input?: Buffer, index?: string): Promise<Buffer> => {
    const result = await run(cwd, args, input, index)
    if (result.code !== 0) fail("git-failed", { command: result.command, message: result.stderr })
    return result.stdout
  }
  return { run, read, checkTime }
}
type Context = ReturnType<typeof context>
function registrations(bytes: Buffer): Registration[] {
  const fields = bytes.toString("utf8").split("\0")
  const found: Registration[] = []
  for (const field of fields) {
    if (field.startsWith("worktree ")) found.push({ path: field.slice(9), detached: false })
    else if (field.startsWith("HEAD ") && found.length) found.at(-1)!.head = field.slice(5)
    else if (field === "detached" && found.length) found.at(-1)!.detached = true
  }
  return found
}
const list = async (root: string, ctx: Context) => registrations(await ctx.read(root, ["worktree", "list", "--porcelain", "-z"]))

/** One classifier owns tree-path containment before worktree creation and writes.
 * Lossy UTF-8, traversal, platform separators/aliases and .git components reject
 * rather than overwriting Git metadata. Population uses exclusive regular files;
 * symlink blobs are bytes, never links, and gitlinks are reported/skipped. No
 * caller disables this guard. External concurrent directory replacement is not
 * prevented by these preflight checks (the same limit as other review tools). */
function treeEntries(bytes: Buffer): Entry[] {
  const entries: Entry[] = []
  let start = 0
  while (start < bytes.length) {
    const end = bytes.indexOf(0, start), tab = bytes.indexOf(9, start)
    if (end < 0 || tab < start || tab > end) fail("invalid-tree")
    const header = bytes.subarray(start, tab).toString("ascii").trim().split(/\s+/)
    const rawPath = bytes.subarray(tab + 1, end), path = rawPath.toString("utf8")
    if (header.length !== 4 || !SHA.test(header[2])) fail("invalid-tree")
    if (!Buffer.from(path).equals(rawPath) || isAbsolute(path) || /[\x00-\x1f\x7f\\:]/.test(path)
      || path.split("/").some(part => {
        const normalized = part.normalize("NFD").replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "").replace(/[ .]+$/, "").toLowerCase()
        return !part || part === "." || part === ".." || normalized === ".git" || normalized === "git~1"
      })) fail("unsafe-tree-path", { message: path })
    if (!(header[0] === "160000" && header[1] === "commit")
      && !(header[1] === "blob" && ["100644", "100755", "120000"].includes(header[0]))) fail("invalid-tree")
    const size = header[1] === "commit" && header[3] === "-" ? 0 : Number(header[3])
    if (!Number.isSafeInteger(size) || size < 0 || header[1] === "blob" && !/^\d+$/.test(header[3])) fail("invalid-tree")
    entries.push({ path, mode: header[0], type: header[1], sha: header[2], size })
    if (entries.length > 100_000) fail("tree-too-large")
    start = end + 1
  }
  return entries
}

/** ls-tree object sizes are read before create/population and bound each raw
 * batch including its SHA/type/size header and trailing newline. Oversized blobs
 * fail explicitly for disclosed object-read fallback; tree size remains bounded.
 * Actual batch headers must match these sizes before writes. No bypass exists. */
function blobBatches(entries: Entry[]): Entry[][] {
  const batches: Entry[][] = []
  let batch: Entry[] = [], bytes = 0, total = 0
  for (const entry of entries.filter(entry => entry.type === "blob")) {
    const outputBytes = entry.size + Buffer.byteLength(`${entry.sha} blob ${entry.size}\n`) + 1
    if (outputBytes > MAX_OUTPUT) fail("blob-too-large", { message: `${entry.path}: ${entry.size} blob bytes (${outputBytes} framed bytes) exceeds the ${MAX_OUTPUT}-byte output budget` })
    total += entry.size
    if (total > MAX_TREE_BYTES) fail("tree-too-large")
    if (bytes + outputBytes > MAX_OUTPUT) { batches.push(batch); batch = []; bytes = 0 }
    batch.push(entry); bytes += outputBytes
  }
  if (batch.length) batches.push(batch)
  return batches
}

async function populate(root: string, path: string, batches: Entry[][], ctx: Context): Promise<number> {
  let written = 0
  // Raw --batch (not --filters) amortizes process startup without trusting paths
  // as revision expressions; only validated object IDs go to its stdin.
  for (const batch of batches) {
    const bytes = await ctx.read(root, ["cat-file", "--batch"], Buffer.from(batch.map(entry => entry.sha + "\n").join("")))
    let cursor = 0
    for (const entry of batch) {
      ctx.checkTime()
      const newline = bytes.indexOf(10, cursor)
      if (newline < 0) fail("invalid-blob")
      const header = bytes.subarray(cursor, newline).toString("ascii").split(" ")
      const size = Number(header[2])
      if (header.length !== 3 || header[0] !== entry.sha || header[1] !== "blob" || size !== entry.size
        || newline + 1 + size >= bytes.length || bytes[newline + 1 + size] !== 10) fail("invalid-blob")
      const target = resolve(path, entry.path)
      let parent = path
      for (const part of entry.path.split("/").slice(0, -1)) {
        parent = resolve(parent, part)
        if (!exists(parent)) fs.mkdirSync(parent)
        if (!fs.lstatSync(parent).isDirectory()) fail("unsafe-tree-path", { path: parent })
      }
      fs.writeFileSync(target, bytes.subarray(newline + 1, newline + 1 + size), { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 })
      written++
      cursor = newline + 2 + size
    }
    if (cursor !== bytes.length) fail("invalid-blob")
  }
  return written
}

/** Derived path plus a fresh detached registration/HEAD are the removal oracle
 * immediately before Git remove; an existing directory must be a real directory
 * at that exact canonical path. Mismatch fails closed, including rollback, with
 * no prune/force-ownership override. --force only permits dirty owned contents.
 * Absence is confirmed against BOTH fs and registration after mutation. */
async function removeOwned(root: string, path: string, head: string, ctx: Context): Promise<WorktreeResult> {
  const registration = (await list(root, ctx)).find(item => item.path === path)
  const present = exists(path)
  if (!registration && !present) return { ok: true, path, state: "absent" }
  if (!registration || registration.head !== head || !registration.detached
    || (present && (!fs.lstatSync(path).isDirectory() || fs.realpathSync(path) !== path))) fail("not-owned", { path })
  if (present && (await ctx.read(path, ["rev-parse", "HEAD"])).toString("utf8").trim() !== head) fail("head-mismatch", { path })
  await ctx.read(root, ["worktree", "remove", "--force", path])
  if (exists(path) || (await list(root, ctx)).some(item => item.path === path)) fail("cleanup-verification-failed", { path })
  return { ok: true, path, state: "removed" }
}

async function worktree(args: WorktreeInput, opts: WorktreeOptions): Promise<WorktreeResult> {
  const ctx = context(opts)
  const base = opts.cwd ?? process.cwd()
  if (typeof base !== "string" || !isAbsolute(base) || /[\0\r\n]/.test(base)) fail("invalid-workspace-directory")
  const cwd = fs.realpathSync(resolve(base, args.cwd ?? "."))
  const top = await ctx.run(cwd, ["rev-parse", "--show-toplevel"])
  if (top.code !== 0 || !top.stdout.length) fail("not-a-repository", { command: top.command, message: top.stderr })
  const root = fs.realpathSync(top.stdout.toString("utf8").replace(/\r?\n$/, ""))
  const prefix = `${basename(root)}.corvus-review-pr`
  const suffix = createHash("sha256").update(args.runId).digest("hex").slice(0, 6)
  const path = resolve(dirname(root), `${prefix}${args.pr}-${args.code_head.slice(0, 7)}-${suffix}`)
  if (args.op === "remove") return removeOwned(root, path, args.code_head, ctx)
  if (exists(path)) fail("existing-path", { path })
  const before = await list(root, ctx)
  if (before.some(item => item.path === path)) fail("path-already-registered", { path })
  const preexisting = [...new Set([...before.map(item => item.path), ...fs.readdirSync(dirname(root)).map(name => resolve(dirname(root), name))])]
    .filter(item => dirname(item) === dirname(root) && basename(item).startsWith(prefix)).sort()
  const object = await ctx.run(root, ["cat-file", "-e", `${args.code_head}^{commit}`])
  if (object.code !== 0) fail("missing-object", { path, command: object.command, message: object.stderr })
  const entries = treeEntries(await ctx.read(root, ["ls-tree", "-r", "-l", "-z", args.code_head]))
  const batches = blobBatches(entries)
  const common = fs.realpathSync(resolve(root, (await ctx.read(root, ["rev-parse", "--git-common-dir"])).toString("utf8").trim()))
  let created = false
  try {
    await ctx.read(root, ["worktree", "add", "--detach", "--no-checkout", path, args.code_head])
    created = true
    if (!fs.lstatSync(path).isDirectory() || fs.realpathSync(path) !== path) fail("not-owned", { path })
    const indexPath = (await ctx.read(path, ["rev-parse", "--absolute-git-dir"])).toString("utf8").trim()
    // Git's generated admin directory and backlink are read before read-tree.
    // Never select the main index even if discovery/config points elsewhere.
    if (dirname(indexPath) !== resolve(common, "worktrees") || fs.realpathSync(indexPath) !== indexPath
      || resolve(indexPath, readFileBacklink(indexPath)) !== resolve(path, ".git")) fail("not-owned", { path })
    await ctx.read(root, ["read-tree", args.code_head], undefined, resolve(indexPath, "index"))
    const populated = await populate(root, path, batches, ctx)
    const head = (await ctx.read(path, ["rev-parse", "HEAD"])).toString("utf8").trim()
    if (head !== args.code_head) fail("head-mismatch", { path })
    return { ok: true, path, head, populated_files: populated, skipped: entries.filter(entry => entry.type === "commit").map(entry => ({ path: entry.path, reason: "submodule" })),
      symlinks_as_files: entries.filter(entry => entry.mode === "120000").map(entry => entry.path), preexisting_corvus_worktrees: preexisting }
  } catch (error) {
    const result: Failure = error instanceof WorktreeFailure ? { ...error.result, path } : { ok: false, reason: "population-failed", path, message: error instanceof Error ? error.message : String(error) }
    // A failed/timed-out add may have left partial registration, but it may also
    // have lost a race to another creator. Without success, do not claim/remove
    // that tree. Disclose its exact path for manual inspection instead.
    try {
      const cleanupContext = context(opts)
      if (created) await removeOwned(root, path, args.code_head, cleanupContext)
      else if (exists(path) || (await list(root, cleanupContext)).some(item => item.path === path))
        result.cleanup = { ok: false, reason: "creation-not-confirmed", path }
    }
    catch (cleanup) { result.cleanup = cleanup instanceof WorktreeFailure ? { ...cleanup.result, path } : { ok: false, reason: "cleanup-failed", path, message: String(cleanup) } }
    return result
  }
}

function readFileBacklink(admin: string): string {
  return fs.readFileSync(resolve(admin, "gitdir"), "utf8").replace(/\r?\n$/, "")
}

/** Host identity is checked before argument inspection or I/O, independently of
 * adapter gating. Only light owns this lifecycle; no argument/config can grant
 * another caller ownership. Failures are JSON diagnostics, never PR file bytes. */
export function createWorktreeExecutor(options: WorktreeOptions = {}): (input: unknown, caller?: string) => Promise<string> {
  const opts = { ...options }
  return async (input, caller) => {
    if (!isReviewCallerAllowed("corvus_review_worktree", caller, input)) return JSON.stringify({ ok: false, reason: "caller-not-allowed" })
    try { return JSON.stringify(await worktree(argumentsObject(input), opts)) }
    catch (error) { return JSON.stringify(error instanceof WorktreeFailure ? error.result : { ok: false, reason: "path-resolution-error", message: error instanceof Error ? error.message : String(error) }) }
  }
}

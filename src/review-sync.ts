import { spawn } from "node:child_process"
import * as fs from "node:fs"
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path"
import { localReviewNamespace } from "./review-persist"

export type SyncExecResult = { code: number; stdout: string; stderr: string }
export type SyncExec = (argv: string[], options: { cwd: string }) => Promise<SyncExecResult>
export type SyncOptions = { cwd?: string; exec?: SyncExec; timeoutMs?: number }
export type SyncPr = { owner: string; name: string; number: number; isCrossRepository: boolean }
  | { name: string; number: null; branch: string }
export type ResolveInput = { cwd?: string; pr: SyncPr; changed_files: string[] }
export type PullInput = { cwd?: string; branch: string; remote?: string }
export type PushInput = PullInput & { root: string; head_sha: string; pr: SyncPr }
export type SyncResult = { synced: boolean; state_commit?: string; reason?: string; git_calls: number }
export type ResolveResult = { ok: true; root: string; task: string | null; remote: string; legacy_root?: string; git_calls: number }
  | { ok: false; reason: string; git_calls: number }
type Op = "resolve" | "pull" | "push"
const KEYS = {
  resolve: ["cwd", "pr", "changed_files"], pull: ["cwd", "branch", "remote"],
  push: ["cwd", "root", "head_sha", "pr", "branch", "remote"],
} satisfies Record<Op, string[]>
const SHA = /^[a-f0-9]{40}$/
const COMPONENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/
const ROOT = /^\.corvus\/(?:tasks\/[A-Za-z0-9._-]+\/)?reviews\/(?:pr[1-9][0-9]*|local-[A-Za-z0-9._-]+)$/
class SyncError extends Error {}
const fail = (reason: string): never => { throw new SyncError(reason) }
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.exec(value)?.[0] === value
const missing = (error: unknown): boolean => error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"

/** Plain descriptors are copied before any exec or filesystem access; unknown/accessor controls fail closed for every entry point, without a bypass. */
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return fail("invalid-arguments")
  return Object.fromEntries(Object.getOwnPropertyNames(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!("value" in descriptor)) return fail("invalid-arguments")
    return [key, descriptor.value]
  }))
}
function identity(value: unknown): SyncPr {
  const pr = object(value)
  if (!matches(pr.name, /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/)) return fail("invalid-pr")
  if (pr.number === null) {
    if (Object.keys(pr).some(key => !["name", "number", "branch"].includes(key)) || typeof pr.branch !== "string" || !pr.branch.length || /[\0\r\n]/.test(pr.branch)) return fail("invalid-pr")
    return { name: pr.name, number: null, branch: pr.branch }
  }
  if (Object.keys(pr).some(key => !["owner", "name", "number", "isCrossRepository"].includes(key))
    || !matches(pr.owner, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)
    || typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.isCrossRepository !== "boolean") return fail("invalid-pr")
  return { owner: pr.owner, name: pr.name, number: pr.number, isCrossRepository: pr.isCrossRepository }
}
const suffix = (pr: SyncPr): string => pr.number === null ? `local-${pr.branch.replace(/[^A-Za-z0-9._-]/g, "-")}` : `pr${pr.number}`

/** The owned PATH-resolved git process has a deadline before spawn and no shell/stdin. Timeout kills it and returns a note; injected exec owns cancellation. No caller argument disables the deadline. */
function execute(argv: string[], cwd: string, opts: SyncOptions): Promise<SyncExecResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined
    const timer = setTimeout(() => { child?.kill("SIGKILL"); reject(new SyncError("timeout")) }, opts.timeoutMs ?? 60_000)
    const done = (result: SyncExecResult) => { clearTimeout(timer); resolve(result) }
    const error = () => { clearTimeout(timer); reject(new SyncError("exec-failed")) }
    try {
      if (opts.exec) { opts.exec(argv, { cwd }).then(done, error); return }
      child = spawn("git", argv.slice(1), { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = "", stderr = ""
      child.stdout!.setEncoding("utf8").on("data", chunk => { stdout += chunk })
      child.stderr!.setEncoding("utf8").on("data", chunk => { stderr += chunk })
      child.once("error", error)
      child.once("close", code => code === null ? error() : done({ code, stdout, stderr }))
    } catch { error() }
  })
}
type Context = { cwd: string; calls: number; run(args: string[]): Promise<SyncExecResult>; read(args: string[]): Promise<string> }
function context(cwd: string, opts: SyncOptions): Context {
  const ctx: Context = { cwd, calls: 0, async run(args) {
    ctx.calls++
    const result = await execute(["git", ...args], cwd, opts)
    if (!result || !Number.isInteger(result.code) || typeof result.stdout !== "string" || typeof result.stderr !== "string") return fail("invalid-exec-result")
    return result
  }, async read(args) {
    const result = await ctx.run(args)
    if (result.code !== 0) return fail("git-read-failed")
    return result.stdout
  } }
  return ctx
}

/** Root spelling and every existing directory/leaf are checked before staging or conflict writes. Symlinks and non-files reject; only the selected new-layout namespace is writable. There is no legacy-write or containment bypass; concurrent filesystem replacement remains outside this preflight guarantee. */
function rootPath(cwd: string, root: string): string {
  if (!matches(root, ROOT) || root.split("/").some(part => part === "." || part === "..")) return fail("invalid-root")
  let path = cwd
  for (const part of root.split("/")) {
    path = resolvePath(path, part)
    try { if (fs.lstatSync(path).isSymbolicLink() || !fs.statSync(path).isDirectory()) return fail("invalid-root") }
    catch (error) { if (!missing(error)) throw error }
  }
  return path
}
function snapshotRoot(path: string): Map<string, { bytes: Buffer; mode: number }> {
  const files = new Map<string, { bytes: Buffer; mode: number }>()
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".staging") continue
      const target = resolvePath(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile()) files.set(target, { bytes: fs.readFileSync(target), mode: fs.statSync(target).mode })
      else fail("invalid-root")
    }
  }
  visit(path)
  return files
}
async function chooseRemote(pr: SyncPr, ctx: Context): Promise<string> {
  if (pr.number === null) return "origin"
  const remotes = (await ctx.read(["remote"])).split(/\r?\n/).filter(Boolean)
  for (const remote of remotes) {
    if (!matches(remote, /^(?!-)[A-Za-z0-9._-]+$/)) continue
    const urls = await ctx.run(["remote", "get-url", "--push", "--all", remote])
    if (urls.code !== 0) continue
    if (urls.stdout.split(/\r?\n/).some(url => {
      const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com(?::[0-9]+)?\/|https:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url)
      return match?.[0] === url && `${match[1]}/${match[2]}`.toLowerCase() === `${pr.owner}/${pr.name}`.toLowerCase()
    })) return remote
  }
  return "origin"
}
async function resolveRoot(args: Record<string, unknown>, ctx: Context): Promise<Omit<Extract<ResolveResult, { ok: true }>, "git_calls">> {
  const pr = identity(args.pr)
  if (!Array.isArray(args.changed_files) || !args.changed_files.every(name => typeof name === "string" && !/[\0\r\n\\]/.test(name) && !name.split("/").includes(".."))) return fail("invalid-changed-files")
  const tasks = new Set<string>()
  for (const name of args.changed_files) {
    const match = /^\.corvus\/tasks\/([^/]+)\//.exec(name)
    if (match) { if (!matches(match[1], COMPONENT)) return fail("invalid-task"); tasks.add(match[1]) }
  }
  const task = tasks.size === 1 ? [...tasks][0] : null
  const root = `.corvus/${task === null ? "" : `tasks/${task}/`}reviews/${suffix(pr)}`
  rootPath(ctx.cwd, root)
  const legacy = `.corvus/reviews/${pr.number === null ? localReviewNamespace(pr.name, pr.branch) : `${pr.owner}__${pr.name}__pr${pr.number}`}`
  let legacy_root: string | undefined
  try {
    const path = resolvePath(ctx.cwd, legacy)
    if (fs.lstatSync(path).isDirectory() && fs.realpathSync(path) === path) legacy_root = legacy
  } catch (error) { if (!missing(error)) throw error }
  return { ok: true, root, task, remote: await chooseRemote(pr, ctx), ...(legacy_root ? { legacy_root } : {}) }
}
async function busy(ctx: Context): Promise<boolean> {
  for (const name of ["index.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    const path = (await ctx.read(["rev-parse", "--git-path", name])).trim()
    if (!path) return fail("git-read-failed")
    if (fs.existsSync(resolvePath(ctx.cwd, path))) return true
  }
  return false
}

/** Git status for .corvus is read before fetch and again before ff-only merge. Dirty state and errors return a no-op note; no caller disables the clean-state gate. Other local edits remain subject to Git's normal merge safety checks. */
async function pullState(branch: string, remote: string, ctx: Context): Promise<Omit<SyncResult, "git_calls">> {
  const clean = async () => (await ctx.read(["--no-optional-locks", "status", "--porcelain", "-z", "--", ".corvus/"])).length === 0
  if (!await clean()) return { synced: false, reason: "dirty-review-state" }
  if (await busy(ctx)) return { synced: false, reason: "index-busy" }
  if ((await ctx.run(["fetch", remote, branch])).code !== 0) return { synced: false, reason: "fetch-refused" }
  if (!await clean()) return { synced: false, reason: "dirty-review-state" }
  const result = await ctx.run(["merge", "--ff-only", "FETCH_HEAD"])
  return result.code === 0 ? { synced: true } : { synced: false, reason: "not-fast-forward" }
}

/** Identity, HEAD, operation-state files and namespace status are read before add/commit. Failure keeps review state local. --only isolates the commit from unrelated staged paths; no identity is fabricated and no override disables the gates. After non-ff, only this invocation's single commit is replayed, at most three times. Dirty unrelated tracked changes disable replay rather than stashing or overwriting them. PR and LOCAL compare head_sha to the newest non-corvus(review-state): subject's SHA within 50 commits from captured HEAD; a missing or mismatched code head refuses before mutation, while raw HEAD remains the replay parent. */
async function pushState(args: Record<string, unknown>, branch: string, remote: string, ctx: Context): Promise<Omit<SyncResult, "git_calls">> {
  const pr = identity(args.pr)
  if (pr.number !== null && pr.isCrossRepository) return { synced: false, reason: "fork" }
  if (typeof args.root !== "string" || !matches(args.head_sha, SHA)) return fail("invalid-arguments")
  const root = args.root, path = rootPath(ctx.cwd, root)
  if (!root.endsWith(`/reviews/${suffix(pr)}`)) return fail("invalid-root")
  if (pr.number === null) {
    if (branch !== pr.branch || (await ctx.read(["branch", "--show-current"])).trim() !== branch) return { synced: false, reason: "head-not-at-expected-tip" }
    if ((await ctx.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).code !== 0) return { synced: false, reason: "LOCAL-no-upstream" }
  }
  let parent = (await ctx.read(["rev-parse", "HEAD"])).trim()
  if (!matches(parent, SHA)) return fail("git-read-failed")
  const log = (await ctx.read(["log", "-50", "--format=%H%x00%s", "-z", parent, "--"])).split("\0")
  let codeHead: string | undefined
  for (let index = 0; index + 1 < log.length; index += 2) {
    if (!log[index + 1].startsWith("corvus(review-state):")) { codeHead = log[index]; break }
  }
  if (codeHead !== args.head_sha) return { synced: false, reason: "head-not-at-expected-tip" }
  if (await busy(ctx)) return { synced: false, reason: "index-busy" }
  for (const key of ["user.name", "user.email"]) {
    const value = await ctx.run(["config", "--get", key])
    if (value.code !== 0 || !value.stdout.trim()) return { synced: false, reason: "no-identity" }
  }
  /** Fixed pathspecs are shared by the pre-mutation status oracle and every add/commit; staging is never eligible, including replay, with no bypass. */
  const paths = [root, `:(exclude)${root}/**/.staging/**`, `:(exclude)${root}/.staging/**`]
  const changed = await ctx.read(["--no-optional-locks", "status", "--porcelain", "-z", "--", ...paths])
  if (!changed && !(await ctx.read(["log", "-1", "--format=%s", "HEAD", "--"])).startsWith(`corvus(review-state): ${suffix(pr)} @ `)) return { synced: true, reason: "unchanged" }
  const snapshot = snapshotRoot(path)
  if (changed) {
    if ((await ctx.run(["add", "--", ...paths])).code !== 0) return { synced: false, reason: "add-refused" }
    const message = `corvus(review-state): ${suffix(pr)} @ ${args.head_sha.slice(0, 7)} [skip ci]`
    if ((await ctx.run(["commit", "--only", "-m", message, "--", ...paths])).code !== 0) return { synced: false, reason: "commit-refused" }
  } else parent = (await ctx.read(["rev-parse", "HEAD^"])).trim()
  let state_commit = (await ctx.read(["rev-parse", "HEAD"])).trim()
  if (!matches(state_commit, SHA)) return fail("invalid-state-commit")
  for (let retry = 0; ; retry++) {
    const changedPaths = (await ctx.read(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", state_commit, "--"])).split("\0").filter(Boolean)
    if (!changedPaths.length || changedPaths.some(name => !name.startsWith(`${root}/`) || name.split("/").includes(".staging"))) return { synced: false, state_commit, reason: "commit-outside-root" }
    const pushed = await ctx.run(["push", remote, `HEAD:${branch}`])
    if (pushed.code === 0) return { synced: true, state_commit }
    if (!/non-fast-forward|fetch first/i.test(pushed.stderr + pushed.stdout)) return { synced: false, state_commit,
      reason: /permission|denied|403|write access/i.test(pushed.stderr + pushed.stdout) ? "no-rights" : "push-refused" }
    if (!changed) return { synced: false, state_commit, reason: "replay-not-owned" }
    if (retry === 3) return { synced: false, state_commit, reason: "retry-limit" }
    if ((await ctx.run(["fetch", remote, branch])).code !== 0) return { synced: false, state_commit, reason: "fetch-refused" }
    const tip = (await ctx.read(["rev-parse", "FETCH_HEAD"])).trim()
    if (!matches(tip, SHA)) return fail("invalid-remote-tip")
    if ((await ctx.run(["diff", "--quiet", "HEAD", "--", ".", `:(top,exclude)${root}/**`])).code !== 0
      || (await ctx.run(["diff", "--cached", "--quiet", "--", ".", `:(top,exclude)${root}/**`])).code !== 0) return { synced: false, state_commit, reason: "index-busy" }
    if ((await ctx.read(["rev-parse", "HEAD"])).trim() !== state_commit) return { synced: false, state_commit, reason: "head-not-at-expected-tip" }
    const rebased = await ctx.run(["rebase", "--no-autostash", "--no-update-refs", "--onto", tip, parent])
    if (rebased.code !== 0) {
      const conflicts = (await ctx.read(["diff", "--name-only", "--diff-filter=U", "-z", "--"])).split("\0").filter(Boolean)
      if (!conflicts.length || conflicts.some(name => !name.startsWith(`${root}/`) || name.split("/").some(part => part === ".." || part === ".staging"))) {
        await ctx.run(["rebase", "--abort"])
        return { synced: false, state_commit, reason: "replay-refused" }
      }
      rootPath(ctx.cwd, root)
      for (const name of conflicts) {
        const target = resolvePath(ctx.cwd, name), saved = snapshot.get(target)
        const rel = relative(path, dirname(target))
        let parentPath = path
        for (const part of rel.split("/").filter(Boolean)) {
          parentPath = resolvePath(parentPath, part)
          if (!fs.existsSync(parentPath)) fs.mkdirSync(parentPath)
          if (fs.lstatSync(parentPath).isSymbolicLink() || !fs.statSync(parentPath).isDirectory()) return fail("invalid-root")
        }
        if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) return fail("invalid-root")
        if (saved) fs.writeFileSync(target, saved.bytes, { mode: saved.mode })
        else if (fs.existsSync(target)) fs.unlinkSync(target)
      }
      if ((await ctx.run(["add", "--", ...paths])).code !== 0 || (await ctx.run(["-c", "core.editor=true", "rebase", "--continue"])).code !== 0) {
        await ctx.run(["rebase", "--abort"])
        return { synced: false, state_commit, reason: "replay-refused" }
      }
    }
    parent = tip
    state_commit = (await ctx.read(["rev-parse", "HEAD"])).trim()
    if (!matches(state_commit, SHA)) return fail("invalid-state-commit")
  }
}

async function perform(op: Op, input: unknown, opts: SyncOptions): Promise<SyncResult | ResolveResult> {
  let ctx: Context | undefined
  try {
    const args = object(input)
    if (Object.keys(args).some(key => !KEYS[op].includes(key))) return fail("invalid-arguments")
    const cwd = args.cwd ?? opts.cwd
    if (typeof cwd !== "string" || !isAbsolute(cwd) || /[\0\r\n]/.test(cwd)) return fail("invalid-cwd")
    if (opts.timeoutMs !== undefined && (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0 || opts.timeoutMs > 2_147_483_647)) return fail("invalid-timeout")
    ctx = context(resolvePath(cwd), opts)
    if (op === "resolve") return { ...await resolveRoot(args, ctx), git_calls: ctx.calls }
    const remote = args.remote ?? "origin", branch = args.branch
    if (!matches(remote, /^(?!-)[A-Za-z0-9._-]+$/) || typeof branch !== "string" || branch.startsWith("-") || /[\u0000-\u0020\u007f]/.test(branch)) return fail("invalid-ref")
    if ((await ctx.run(["check-ref-format", "--branch", branch])).code !== 0) return fail("invalid-branch")
    if ((await ctx.read(["rev-parse", "--show-toplevel"])).trim() !== fs.realpathSync(ctx.cwd)) return fail("cwd-not-repository-root")
    return { ...await (op === "pull" ? pullState(branch, remote, ctx) : pushState(args, branch, remote, ctx)), git_calls: ctx.calls }
  } catch (error) {
    return { ...(op === "resolve" ? { ok: false as const } : { synced: false }), reason: error instanceof SyncError ? error.message : "sync-failed", git_calls: ctx?.calls ?? 0 }
  }
}
export const resolve = (input: ResolveInput, opts: SyncOptions = {}) => perform("resolve", input, opts) as Promise<ResolveResult>
export const pull = (input: PullInput, opts: SyncOptions = {}) => perform("pull", input, opts) as Promise<SyncResult>
export const push = (input: PushInput, opts: SyncOptions = {}) => perform("push", input, opts) as Promise<SyncResult>

export function createSyncExecutor(options: SyncOptions = {}): (input: unknown) => Promise<string> {
  const opts = { ...options }
  return async input => {
    try {
      const { op, ...args } = object(input)
      if (op !== "resolve" && op !== "pull" && op !== "push") return fail("invalid-op")
      return JSON.stringify(await perform(op, args, opts))
    } catch { return JSON.stringify({ synced: false, reason: "invalid-arguments", git_calls: 0 }) }
  }
}

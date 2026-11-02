import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import plugin from "../index"
import { evaluateRules } from "../evaluate-rules"
import { toV2Permissions } from "../to-v2-permissions"
import { createWorktreeExecutor as actualExecutor, type WorktreeExec, type WorktreeInput, type WorktreeOptions } from "../review-worktree"
import { registerAgents } from "../v2/register-agents"
import { registerTools } from "../v2/register-tools"
import { createFakeContext } from "./fake-context"

const light = "corvus-review-light"
const realExec: WorktreeExec = async (argv, options) => {
  const result = spawnSync(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, input: options.input })
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr.toString() }
}
// Existing lifecycle cases stub ONLY the network fetch, retaining real Git for
// discovery, object/registration checks, population and preservation snapshots.
function createWorktreeExecutor(options: WorktreeOptions = {}) {
  const exec: WorktreeExec = async (argv, opts) => argv.includes("fetch")
    ? { code: 0, stdout: Buffer.alloc(0), stderr: "" } : (options.exec ?? realExec)(argv, opts)
  const tool = actualExecutor({ ...options, exec })
  return async (input: unknown, caller?: string) => {
    if (caller === light && input && typeof input === "object" && Object.getOwnPropertyDescriptor(input, "repo_root")?.value) {
      const args = input as WorktreeInput
      await tool({ op: "locate", owner: args.owner, name: args.name, pr: args.pr }, caller)
    }
    return tool(input, caller)
  }
}
function git(cwd: string, ...args: string[]): Buffer {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "filter.tripwire.required=false", "-c", "filter.tripwire.process=", "-c", "filter.tripwire.clean=", "-c", "filter.tripwire.smudge=", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })
  if (result.status !== 0) throw new Error(`Fixture git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout
}
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "corvus-review-worktree-")))
  const repo = join(parent, "project"), alias = join(parent, "alias")
  mkdirSync(repo)
  git(repo, "init", "-b", "main")
  git(repo, "remote", "add", "origin", "https://github.com/example/project.git")
  git(repo, "config", "user.name", "Test")
  git(repo, "config", "user.email", "test@example.invalid")
  mkdirSync(join(repo, "src"))
  writeFileSync(join(repo, "src/example.ts"), "export const value = 1\n")
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 255, 10, 0]))
  writeFileSync(join(repo, ".gitattributes"), "*.bin filter=tripwire\n")
  writeFileSync(join(repo, ".gitignore"), "ignored\n")
  writeFileSync(join(repo, "executable"), "do not execute\n", { mode: 0o755 })
  writeFileSync(join(parent, "secret"), "host secret must never be read\n")
  symlinkSync(join(parent, "secret"), join(repo, "escape-link"))
  symlinkSync("src", join(repo, "directory-link"))
  git(repo, "add", ".")
  git(repo, "commit", "-m", "PR blobs")
  const initial = git(repo, "rev-parse", "HEAD").toString().trim()
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${initial},submodule`)
  git(repo, "commit", "-m", "PR gitlink")
  const head = git(repo, "rev-parse", "HEAD").toString().trim()
  writeFileSync(join(repo, "src/example.ts"), "main checkout is not PR head\n")
  git(repo, "add", "src/example.ts")
  git(repo, "commit", "-m", "Main-only work")
  const other = join(parent, "project.corvus-review-pr9-aaaaaaa-stale")
  git(repo, "worktree", "add", "--detach", "--no-checkout", other, head)
  writeFileSync(join(other, "keep"), "another run's data\n")
  const stale = join(parent, "project.corvus-review-pr8-bbbbbbb-stale")
  git(repo, "worktree", "add", "--detach", "--no-checkout", stale, head)
  rmSync(stale, { recursive: true }) // Missing registration must never be pruned.
  const hook = join(parent, "hook-ran"), filter = join(parent, "filter-ran"), monitor = join(parent, "monitor-ran")
  writeFileSync(join(repo, ".git/hooks/post-checkout"), `#!/bin/sh\necho ran > '${hook}'\n`, { mode: 0o755 })
  const filterScript = join(parent, "filter-script")
  writeFileSync(filterScript, `#!/bin/sh\necho ran > '${filter}'\ncat\n`, { mode: 0o755 })
  git(repo, "config", "filter.tripwire.smudge", filterScript)
  git(repo, "config", "filter.tripwire.clean", filterScript)
  git(repo, "config", "filter.tripwire.process", filterScript)
  git(repo, "config", "filter.tripwire.required", "true")
  const monitorScript = join(parent, "monitor-script")
  writeFileSync(monitorScript, `#!/bin/sh\necho ran > '${monitor}'\n`, { mode: 0o755 })
  git(repo, "config", "core.fsmonitor", monitorScript)
  writeFileSync(join(repo, "src/example.ts"), "staged user work\n")
  git(repo, "add", "src/example.ts")
  writeFileSync(join(repo, "src/example.ts"), "unstaged user work\n")
  writeFileSync(join(repo, "untracked"), "untracked user work\n")
  symlinkSync(repo, alias)
  const input: WorktreeInput = { op: "create", repo_root: repo, owner: "example", name: "project", pr: 42, code_head: head, runId: "run identity / full UTF-8 ✓" }
  const path = join(parent, `project.corvus-review-pr42-${head.slice(0, 7)}-${createHash("sha256").update(input.runId).digest("hex").slice(0, 6)}`)
  const snapshot = () => ({
    branch: git(repo, "symbolic-ref", "HEAD").toString(), head: git(repo, "rev-parse", "HEAD").toString(),
    status: git(repo, "--no-optional-locks", "status", "--porcelain", "-z").toString(),
    index: readFileSync(join(repo, ".git/index")).toString("hex"),
    work: readFileSync(join(repo, "src/example.ts")).toString("hex"),
    untracked: readFileSync(join(repo, "untracked")).toString("hex"),
    ignore: readFileSync(join(repo, ".gitignore")).toString("hex"),
    exclude: readFileSync(join(repo, ".git/info/exclude")).toString("hex"),
    config: readFileSync(join(repo, ".git/config")).toString("hex"),
    otherGit: readFileSync(join(other, ".git")).toString(), otherWork: readFileSync(join(other, "keep")).toString(),
    worktrees: git(repo, "worktree", "list", "--porcelain", "-z").toString(),
  })
  return { parent, repo, alias, head, other, stale, path, input, snapshot, hook, filter, monitor, dispose: () => rmSync(parent, { recursive: true, force: true }) }
}
const run = async (exec: ReturnType<typeof createWorktreeExecutor>, input: unknown, caller: string | undefined = light) => JSON.parse(await exec(input, caller))

/** Test-owned repositories and byte snapshots are the pre-mutation oracle. These
 * tests never execute PR fixture code: hook/filter/monitor sentinels must remain
 * absent. Any main-checkout or unrelated-worktree drift fails, with no bypass. */
describe("tool-owned review worktree", () => {
  test.each(["default", "nested-session", "absolute", "symlink"] as const)("raw population/removal with %s root spelling preserves user bytes", async spelling => {
    const f = fixture()
    try {
      const before = f.snapshot()
      const exec = createWorktreeExecutor({ cwd: spelling === "nested-session" ? join(f.repo, "src") : f.repo })
      const input = { ...f.input, repo_root: spelling === "symlink" ? f.alias : f.repo }
      const created = await run(exec, input)
      expect(created).toEqual({ ok: true, path: f.path, head: f.head, populated_files: 7,
        skipped: [{ path: "submodule", reason: "submodule" }], symlinks_as_files: ["directory-link", "escape-link"],
        preexisting_corvus_worktrees: [f.stale, f.other].sort() })
      expect(dirname(created.path)).toBe(dirname(f.repo))
      expect(basename(created.path)).toMatch(/^project\.corvus-review-pr42-[a-f0-9]{7}-[a-f0-9]{6}$/)
      expect(git(f.path, "rev-parse", "HEAD").toString().trim()).toBe(f.head)
      expect(spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: f.path }).status).toBe(1)
      expect(readFileSync(join(f.path, "src/example.ts"), "utf8")).toBe("export const value = 1\n")
      expect(readFileSync(join(f.path, "binary.bin"))).toEqual(Buffer.from([0, 255, 10, 0]))
      expect(lstatSync(join(f.path, "executable")).mode & 0o111).toBe(0o111)
      for (const name of ["escape-link", "directory-link"]) {
        expect(lstatSync(join(f.path, name)).isSymbolicLink()).toBe(false)
        expect(lstatSync(join(f.path, name)).isFile()).toBe(true)
      }
      expect(readFileSync(join(f.path, "escape-link"), "utf8")).toBe(join(f.parent, "secret"))
      expect(existsSync(join(f.path, "submodule"))).toBe(false)
      for (const sentinel of [f.hook, f.filter, f.monitor]) expect(existsSync(sentinel)).toBe(false)
      const during = f.snapshot()
      expect({ ...during, worktrees: before.worktrees }).toEqual(before)
      expect(await run(exec, { ...input, op: "remove" })).toEqual({ ok: true, path: f.path, state: "removed" })
      expect(existsSync(f.path)).toBe(false)
      expect(f.snapshot()).toEqual(before)
      expect(await run(exec, { ...input, op: "remove" })).toEqual({ ok: true, path: f.path, state: "absent" })
      for (const sentinel of [f.hook, f.filter, f.monitor]) expect(existsSync(sentinel)).toBe(false)
    } finally { f.dispose() }
  })

  test("existing file, empty directory and dangling symlink all refuse without mutation", async () => {
    const f = fixture()
    try {
      const exec = createWorktreeExecutor({ cwd: f.repo }), before = f.snapshot()
      for (const kind of ["file", "directory", "symlink"]) {
        if (kind === "file") writeFileSync(f.path, "keep")
        if (kind === "directory") mkdirSync(f.path)
        if (kind === "symlink") symlinkSync(join(f.parent, "missing"), f.path)
        expect(await run(exec, f.input)).toEqual({ ok: false, reason: "existing-path", path: f.path })
        expect(await run(exec, { ...f.input, op: "remove" })).toEqual({ ok: false, reason: "not-owned", path: f.path })
        expect(f.snapshot()).toEqual(before)
        rmSync(f.path, { recursive: true })
      }
    } finally { f.dispose() }
  })

  test("missing object refuses; a missing registered path is not reused or pruned", async () => {
    const f = fixture()
    try {
      const exec = createWorktreeExecutor({ cwd: f.repo }), before = f.snapshot()
      expect(await run(exec, { ...f.input, code_head: "f".repeat(40) })).toMatchObject({ ok: false, reason: "missing-object" })
      expect(existsSync(f.path)).toBe(false)
      expect(f.snapshot()).toEqual(before)
      expect((await run(exec, f.input)).ok).toBe(true)
      rmSync(f.path, { recursive: true })
      expect(await run(exec, f.input)).toEqual({ ok: false, reason: "path-already-registered", path: f.path })
      expect(await run(exec, { ...f.input, op: "remove" })).toEqual({ ok: true, path: f.path, state: "removed" })
      expect(f.snapshot()).toEqual(before)
    } finally { f.dispose() }
  })

  test("registration HEAD mismatch preserves the worktree until the exact head is restored", async () => {
    const f = fixture()
    try {
      const exec = createWorktreeExecutor({ cwd: f.repo }), before = f.snapshot()
      expect((await run(exec, f.input)).ok).toBe(true)
      git(f.path, "update-ref", "HEAD", git(f.repo, "rev-parse", "HEAD").toString().trim())
      expect(await run(exec, { ...f.input, op: "remove" })).toEqual({ ok: false, reason: "not-owned", path: f.path })
      expect(existsSync(f.path)).toBe(true)
      git(f.path, "update-ref", "HEAD", f.head)
      expect((await run(exec, { ...f.input, op: "remove" })).ok).toBe(true)
      expect(f.snapshot()).toEqual(before)
    } finally { f.dispose() }
  })

  test("population failure rolls back only the newly created tree; cleanup failure carries its exact path", async () => {
    const f = fixture()
    try {
      const before = f.snapshot()
      let blockCleanup = false
      const exec: WorktreeExec = async (argv, options) => {
        if (argv.includes("--batch")) return { code: 0, stdout: Buffer.from("malformed\n"), stderr: "" }
        if (blockCleanup && argv.includes("remove")) return { code: 1, stdout: Buffer.alloc(0), stderr: "fixture remove failure" }
        const result = spawnSync(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, input: options.input })
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr.toString() }
      }
      const tool = createWorktreeExecutor({ cwd: f.repo, exec })
      expect(await run(tool, f.input)).toEqual({ ok: false, reason: "invalid-blob", path: f.path })
      expect(f.snapshot()).toEqual(before)
      blockCleanup = true
      const result = await run(tool, f.input)
      expect(result).toMatchObject({ ok: false, reason: "invalid-blob", path: f.path,
        cleanup: { ok: false, reason: "git-failed", message: "fixture remove failure" } })
      expect(result.cleanup.command.at(-1)).toBe(f.path)
      expect(existsSync(f.path)).toBe(true)
      expect((await run(createWorktreeExecutor({ cwd: f.repo }), { ...f.input, op: "remove" })).ok).toBe(true)
      expect(f.snapshot()).toEqual(before)
    } finally { f.dispose() }
  })

  test("closed inputs and caller admission reject before an injected exec/accessor can run", async () => {
    let calls = 0, reads = 0
    const tool = actualExecutor({ exec: async () => { calls++; throw new Error("unexpected") } })
    const input = { op: "create", owner: "example", name: "project", repo_root: "/missing", pr: 1, code_head: "a".repeat(40), runId: "run" }
    for (const caller of ["corvus-review", "corvus-review-auto", "pr-light-reviewer", "pr-comment-writer", "pr-context-gatherer", "unknown", undefined])
      expect(JSON.parse(await tool({ get op() { reads++; return "create" } }, caller))).toEqual({ ok: false, reason: "caller-not-allowed" })
    for (const invalid of [null, [], { ...input, pr: 0 }, { ...input, pr: 1.5 }, { ...input, pr: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, code_head: "A".repeat(40) }, { ...input, code_head: "a".repeat(40) + "\n" }, { ...input, runId: " " },
      { ...input, cwd: "\0" }, { ...input, path: "/someone-else" }, { ...input, caller: light },
      { ...input, get cwd() { reads++; return "/" } }])
      expect(await run(tool, invalid)).toMatchObject({ ok: false, reason: "invalid-arguments" })
    expect(await run(tool, { ...input, op: "status" })).toEqual({ ok: false, reason: "invalid-op" })
    expect(calls).toBe(0)
    expect(reads).toBe(0)
  })

  test.each(["split", "oversized", "tree-budget"] as const)("raw blob byte budget: %s", async mode => {
    const f = fixture()
    try {
      const cap = 64 * 1024 * 1024
      const sizes = mode === "split" ? [cap / 2, cap / 2] : mode === "oversized" ? [cap] : Array.from({ length: 9 }, () => cap / 2)
      const objects = sizes.map((size, index) => ({ sha: String(index + 1).repeat(40), size, path: `blob-${index}` }))
      const batches: number[] = []
      let additions = 0
      const exec: WorktreeExec = async (argv, options) => {
        if (argv.includes("ls-tree")) return { code: 0, stdout: Buffer.from(objects.map(entry =>
          `100644 blob ${entry.sha}${argv.includes("-l") ? ` ${entry.size}` : ""}\t${entry.path}\0`).join("")), stderr: "" }
        if (argv.includes("--batch")) {
          const selected = options.input!.toString().trim().split("\n").map(sha => objects.find(entry => entry.sha === sha)!)
          const bytes = selected.reduce((sum, entry) => sum + entry.size + Buffer.byteLength(`${entry.sha} blob ${entry.size}\n`) + 1, 0)
          if (bytes > options.maxBytes) throw new Error("fixture output-limit")
          batches.push(bytes)
          return { code: 0, stdout: Buffer.concat(selected.flatMap(entry => [Buffer.from(`${entry.sha} blob ${entry.size}\n`), Buffer.alloc(entry.size, 1), Buffer.from("\n")])), stderr: "" }
        }
        if (argv.includes("add")) additions++
        const result = spawnSync(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, input: options.input })
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr.toString() }
      }
      const before = f.snapshot(), tool = createWorktreeExecutor({ cwd: f.repo, exec })
      const result = await run(tool, f.input)
      if (mode === "split") {
        expect(result).toMatchObject({ ok: true, populated_files: 2 })
        expect(batches).toHaveLength(2) // Payload sum is exactly 64 MiB; framing requires two calls.
        expect(batches.every(bytes => bytes <= cap)).toBe(true)
        expect(lstatSync(join(f.path, "blob-0")).size).toBe(cap / 2)
        expect((await run(tool, { ...f.input, op: "remove" })).ok).toBe(true)
      } else {
        expect(result).toMatchObject({ ok: false, reason: mode === "oversized" ? "blob-too-large" : "tree-too-large" })
        if (mode === "oversized") expect(result.message).toContain(`blob-0: ${cap} blob bytes`)
        expect(additions).toBe(0)
        expect(batches).toEqual([])
        expect(existsSync(f.path)).toBe(false)
      }
      expect(f.snapshot()).toEqual(before)
    } finally { f.dispose() }
  })

  test("a host executor that never resolves is bounded by the operation deadline", async () => {
    const tool = createWorktreeExecutor({ timeoutMs: 10, exec: async () => new Promise(() => {}) })
    expect(await run(tool, { op: "locate", owner: "example", name: "project", pr: 1 })).toMatchObject({ ok: false, reason: "timeout" })
  })

  test.each(["../outside", "/absolute", ".git/config", "nested/.GIT/config", "nested/.gi\u200ct/config", "a\\b", "a:b", "a\nline"])("unsafe tree path %j refuses before worktree creation", async path => {
    const f = fixture()
    try {
      let additions = 0
      const exec: WorktreeExec = async (argv, options) => {
        if (argv.includes("add")) additions++
        if (argv.includes("ls-tree")) return { code: 0, stdout: Buffer.from(`100644 blob ${"a".repeat(40)} 0\t${path}\0`), stderr: "" }
        const result = spawnSync(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, input: options.input })
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr.toString() }
      }
      const before = f.snapshot()
      expect(await run(createWorktreeExecutor({ cwd: f.repo, exec }), f.input)).toEqual({ ok: false, reason: "unsafe-tree-path", message: path })
      expect(additions).toBe(0)
      expect(existsSync(f.path)).toBe(false)
      expect(f.snapshot()).toEqual(before)
    } finally { f.dispose() }
  })
})

describe("worktree both-host boundary", () => {
  test.each(["v1", "v2"] as const)("%s exposes eight tools, light-only lifecycle and ask-free protected detector reads", async host => {
    const f = fixture()
    let cleanup: (() => Promise<void> | void) | void = undefined
    try {
      const fake = createFakeContext(f.repo)
      let call: (args: unknown, agent?: string) => Promise<string>
      let permissions: ReturnType<typeof toV2Permissions>
      if (host === "v1") {
        const hooks = await plugin({ directory: f.repo } as Parameters<typeof plugin>[0])
        expect(Object.keys(hooks.tool!)).toHaveLength(8)
        const tool = hooks.tool!.corvus_review_worktree
        call = async (args, agent) => await tool.execute(args as Parameters<typeof tool.execute>[0], { agent } as Parameters<typeof tool.execute>[1]) as string
        const config = { agent: { "pr-light-reviewer": { permission: { external_directory: "ask" } } } }
        await hooks.config!(config as Parameters<NonNullable<typeof hooks.config>>[0])
        permissions = toV2Permissions(config.agent["pr-light-reviewer"].permission)
      } else {
        cleanup = await registerTools(fake.ctx)
        await registerAgents(fake.ctx)
        expect(fake.tools.size).toBe(8)
        const tool = fake.tools.get("corvus_review_worktree")!
        call = async (args, agent) => (await tool.execute(args, { agent } as Parameters<typeof tool.execute>[1])).content as string
        // The real v2 host baseline asks for external directories before Corvus
        // rules are appended. Wildcard allow must supersede that baseline.
        permissions = [{ action: "external_directory", resource: "*", effect: "ask" }, ...fake.agents.get("pr-light-reviewer")!.permissions]
      }
      for (const caller of ["corvus-review", "corvus-review-auto", "pr-light-reviewer", "pr-comment-writer", "unknown", undefined])
        expect(JSON.parse(await call(f.input, caller))).toEqual({ ok: false, reason: "caller-not-allowed" })
      const located = JSON.parse(await call({ op: "locate", owner: "example", name: "project", pr: 42 }, light))
      expect(located).toMatchObject({ ok: true, repo_root: f.repo, remote: "origin" })
      const created = await run(createWorktreeExecutor({ cwd: f.repo }), f.input)
      expect(created.ok).toBe(true)
      for (const action of ["external_directory", "read", "glob", "grep"])
        expect(evaluateRules(permissions, action, `${f.path}/src/example.ts`)).toBe("allow")
      expect(evaluateRules(permissions, "edit", `${f.path}/src/example.ts`)).toBe("deny")
      expect(JSON.parse(await call({ ...f.input, op: "remove" }, light))).toEqual({ ok: true, path: f.path, state: "removed" })
    } finally { if (cleanup) await cleanup(); f.dispose() }
  })
})

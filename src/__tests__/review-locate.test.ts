import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index"
import { canonicalize } from "../review-payload"
import { createPostExecutor } from "../review-post"
import { createWorktreeExecutor, type WorktreeExec } from "../review-worktree"
import { enforceProtected } from "../v2/enforce-protected"
import { registerTools } from "../v2/register-tools"
import { createFakeContext } from "./fake-context"

const light = "corvus-review-light", identity = { owner: "Example", name: "Project", pr: 42 }
const realExec: WorktreeExec = async (argv, options) => {
  const result = spawnSync(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, input: options.input })
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr.toString() }
}
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd })
  if (result.status !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
function fixture(depth = 1, remote = "https://github.com/example/project.git") {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "corvus-locate-"))), workspace = join(parent, "workspace")
  mkdirSync(workspace); git(workspace, "init")
  const repo = join(workspace, ...Array.from({ length: depth }, (_, i) => `level${i + 1}`))
  mkdirSync(repo, { recursive: true }); git(repo, "init"); git(repo, "remote", "add", "origin", remote)
  git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.invalid")
  writeFileSync(join(repo, "file"), "PR bytes\n"); git(repo, "add", "file"); git(repo, "commit", "-m", "fixture")
  const head = git(repo, "rev-parse", "HEAD")
  return { parent, workspace, repo, head, dispose: () => rmSync(parent, { recursive: true, force: true }) }
}
const run = async (tool: ReturnType<typeof createWorktreeExecutor>, input: unknown) => JSON.parse(await tool(input, light))

describe("tool-side GitHub repository location", () => {
  test.each([1, 2, 3])("nested repo depth %i in a no-remotes workspace", async depth => {
    const f = fixture(depth)
    try {
      const tool = createWorktreeExecutor({ cwd: f.workspace })
      expect(await run(tool, { op: "locate", ...identity })).toEqual({ ok: true, repo_root: f.repo, remote: "origin", candidates_considered: depth + 1 })
    } finally { f.dispose() }
  })
  test.each(["https://GITHUB.com/EXAMPLE/Project.git", "git@github.com:example/project.git", "ssh://git@github.com/example/project", "ssh://github.com/example/project.git"])("remote spelling %s", async remote => {
    const f = fixture(1, remote)
    try { expect(await run(createWorktreeExecutor({ cwd: f.workspace }), { op: "locate", ...identity })).toMatchObject({ ok: true, repo_root: f.repo }) }
    finally { f.dispose() }
  })
  test.each(["https://github.com/other/project.git", "https://github.com.evil/example/project.git", "ext::evil", "file:///example/project"])("no match %s", async remote => {
    const f = fixture(1, remote)
    try { expect(await run(createWorktreeExecutor({ cwd: f.workspace }), { op: "locate", ...identity })).toMatchObject({ ok: false, reason: "repository-not-found" }) }
    finally { f.dispose() }
  })
  test("depth four, symlink, hidden and node_modules repositories are not traversed", async () => {
    const f = fixture(4)
    try {
      symlinkSync(f.repo, join(f.workspace, "shortcut"))
      for (const dir of [".hidden", "node_modules"]) {
        mkdirSync(join(f.workspace, dir)); symlinkSync(f.repo, join(f.workspace, dir, "project"))
      }
      expect(await run(createWorktreeExecutor({ cwd: f.workspace }), { op: "locate", ...identity })).toMatchObject({ ok: false, reason: "repository-not-found", candidates_considered: 4 })
    } finally { f.dispose() }
  })
  test("wide scan is explicitly bounded, not reported as repository absence", async () => {
    const f = fixture()
    try {
      for (let i = 0; i < 201; i++) mkdirSync(join(f.workspace, `dir-${i}`))
      const result = await run(createWorktreeExecutor({ cwd: f.workspace }), { op: "locate", ...identity })
      expect(result).toMatchObject({ ok: false, reason: "scan-limit" }); expect(result.candidates_considered).toBeLessThanOrEqual(200)
    } finally { f.dispose() }
  })
  test("create owns restricted fetch, verifies commit and rejects stale remote/no receipt", async () => {
    const f = fixture(), calls: string[][] = []
    try {
      const exec: WorktreeExec = async (argv, options) => {
        calls.push(argv)
        expect(Object.keys(options.env).filter(key => key.startsWith("GIT_") && !["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_NO_REPLACE_OBJECTS", "GIT_NO_LAZY_FETCH", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "GIT_INDEX_FILE"].includes(key))).toEqual([])
        return argv.includes("fetch") ? { code: 0, stdout: Buffer.alloc(0), stderr: "" } : realExec(argv, options)
      }
      const tool = createWorktreeExecutor({ cwd: f.workspace, exec }), input = { op: "create", ...identity, repo_root: f.repo, code_head: f.head, runId: "probe" }
      expect(await run(tool, input)).toMatchObject({ ok: false, reason: "repo-not-located" })
      expect(calls.some(argv => argv.includes("fetch"))).toBe(false)
      expect((await run(tool, { op: "locate", ...identity })).ok).toBe(true)
      const created = await run(tool, input)
      expect(created).toMatchObject({ ok: true, head: f.head })
      const fetch = calls.find(argv => argv.includes("fetch"))!
      expect(fetch.slice(-5)).toEqual(["fetch", "--no-tags", "--refmap=", "origin", "pull/42/head"])
      for (const value of ["core.hooksPath=/dev/null", "protocol.allow=never", "protocol.https.allow=always", "protocol.ssh.allow=always", "protocol.file.allow=never"]) expect(fetch).toContain(value)
      expect(fetch.some(arg => arg.startsWith("--upload-pack"))).toBe(false)
      expect(calls.findIndex(argv => argv.includes("cat-file"))).toBeGreaterThan(calls.findIndex(argv => argv.includes("fetch")))
      expect(readFileSync(join(created.path, "file"), "utf8")).toBe("PR bytes\n")
      expect((await run(tool, { ...input, op: "remove" })).ok).toBe(true)
      expect(await run(tool, { ...input, code_head: "f".repeat(40) })).toMatchObject({ ok: false, reason: "missing-object" })
      git(f.repo, "remote", "set-url", "origin", "https://github.com/other/repo.git")
      expect(await run(tool, input)).toMatchObject({ ok: false, reason: "remote-mismatch" })
    } finally { f.dispose() }
  })
  test("fetch failure is precise and creates no worktree", async () => {
    const f = fixture()
    try {
      const exec: WorktreeExec = (argv, options) => argv.includes("fetch") ? Promise.resolve({ code: 1, stdout: Buffer.alloc(0), stderr: "network unavailable" }) : realExec(argv, options)
      const tool = createWorktreeExecutor({ cwd: f.workspace, exec })
      await run(tool, { op: "locate", ...identity })
      expect(await run(tool, { op: "create", ...identity, repo_root: f.repo, code_head: f.head, runId: "probe" })).toMatchObject({ ok: false, reason: "fetch-failed", message: "network unavailable" })
      expect(git(f.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1)
    } finally { f.dispose() }
  })
})

describe("both-host located roots and state routing", () => {
  test.each(["v1", "v2"] as const)("%s posts absolute located light artifacts only after locate; all state tools reject unlocated/redirected roots", async host => {
    const f = fixture(), beforePath = process.env.PATH
    let cleanup: (() => void | Promise<void>) | void = undefined
    try {
      const fake = createFakeContext(f.workspace)
      let call: (name: string, args: unknown, agent?: string) => Promise<Record<string, unknown>>
      if (host === "v1") {
        const hooks = await plugin({ directory: f.workspace } as Parameters<typeof plugin>[0])
        call = async (name, args, agent = light) => JSON.parse(await hooks.tool![name].execute(args as never, { agent } as never) as string)
      } else {
        cleanup = await registerTools(fake.ctx)
        call = async (name, args, agent = light) => JSON.parse((await fake.tools.get(name)!.execute(args, { agent } as never)).content as string)
      }
      // A PATH-owned transport double logs every call and never forwards to gh.
      const bin = join(f.parent, "bin"), gh = join(bin, "gh"), url = "https://github.com/example/project/pull/42#pullrequestreview-123"
      mkdirSync(bin)
      writeFileSync(gh + ".head", JSON.stringify([[{ sha: f.head, commit: { message: "Product change" } }]]))
      writeFileSync(gh + ".posted", JSON.stringify({ html_url: url }))
      writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$0.calls"\ncase "$3" in GET) exec /bin/cat "$0.head";; POST) exec /bin/cat "$0.posted";; *) exit 91;; esac\n', { mode: 0o755 })
      process.env.PATH = `${bin}:${beforePath ?? ""}`
      const calls = () => existsSync(gh + ".calls") ? readFileSync(gh + ".calls", "utf8").trim().split("\n") : []
      const request = { commit_id: f.head, event: "COMMENT" as const, body: "## Review of #42 — Fixture", comments: [] }
      const bytes = canonicalize(request), expectedSha256 = createHash("sha256").update(bytes).digest("hex")
      const descriptor = { expectedSha256, repo: { owner: identity.owner, name: identity.name }, prNumber: identity.pr, headSha: f.head, event: request.event }
      const artifact = (repo: string, namespace: string, content = bytes) => {
        const root = join(repo, ".corvus", namespace)
        mkdirSync(root, { recursive: true }); const path = join(root, "post-request.json")
        writeFileSync(path, content); return path
      }
      const outside = join(f.parent, "unlocated"), namespaces = ["reviews/pr42", "tasks/example/reviews/pr42"]
      mkdirSync(join(f.workspace, ".corvus"))
      const locatedArtifact = artifact(f.repo, namespaces[0] + "/.light")
      const rejectPost = async (artifactPath: string, extra = {}) => {
        const count = calls().length
        expect(await call("corvus_review_post", { ...descriptor, artifactPath, ...extra }, "pr-comment-writer"))
          .toMatchObject({ outcome: "rejected", tool_api_calls: 0 })
        expect(calls()).toHaveLength(count)
      }
      await rejectPost(locatedArtifact)
      expect(await call("corvus_review_worktree", { op: "locate", ...identity })).toMatchObject({ ok: true, repo_root: f.repo })
      for (const namespace of namespaces) {
        const path = artifact(f.repo, namespace + "/.light")
        const count = calls().length
        expect(await call("corvus_review_post", { ...descriptor, artifactPath: path }, "pr-comment-writer"))
          .toEqual({ outcome: "posted", review_url: url, tool_api_calls: 2 })
        expect(calls()).toHaveLength(count + 2)
        expect(calls().at(-1)).toContain(`--input ${path}`)
        expect(readFileSync(path, "utf8")).toBe(bytes)
        await rejectPost(artifact(outside, namespace + "/.light"))
        await rejectPost(artifact(f.repo, namespace + "/.light").replace("pr42", "pr43"))
        await rejectPost(`${f.repo}/.corvus/${namespace}/../pr42/.light/post-request.json`)
        await rejectPost(path, { expectedSha256: "0".repeat(64) })
        await rejectPost(artifact(f.repo, namespace)) // Located full artifacts gain no authority.
      }
      // The integrity executor itself owns receipt selection, not adapter routing.
      const executor = createPostExecutor(join(f.workspace, ".corvus"), f.workspace)
      expect(JSON.parse(await executor({ ...descriptor, artifactPath: locatedArtifact }, "pr-comment-writer")))
        .toEqual({ outcome: "posted", review_url: url, tool_api_calls: 2 })
      const otherSession = join(f.parent, "other-session")
      mkdirSync(join(otherSession, ".corvus"), { recursive: true })
      expect(JSON.parse(await createPostExecutor(join(otherSession, ".corvus"), otherSession)({ ...descriptor, artifactPath: locatedArtifact }, "pr-comment-writer")))
        .toMatchObject({ outcome: "rejected", tool_api_calls: 0 })
      // Relative light and relative/absolute full-review session paths are unchanged.
      for (const namespace of namespaces) {
        const path = artifact(f.workspace, namespace + "/.light")
        expect(await call("corvus_review_post", { ...descriptor, artifactPath: path.slice(f.workspace.length + 1) }, "pr-comment-writer"))
          .toEqual({ outcome: "posted", review_url: url, tool_api_calls: 2 })
        const fullBytes = canonicalize({ ...request, event: "APPROVE" }), fullPath = artifact(f.workspace, namespace, fullBytes)
        for (const artifactPath of [fullPath, fullPath.slice(f.workspace.length + 1)])
          expect(await call("corvus_review_post", { ...descriptor, artifactPath, event: "APPROVE", expectedSha256: createHash("sha256").update(fullBytes).digest("hex") }, "pr-comment-writer"))
            .toEqual({ outcome: "posted", review_url: url, tool_api_calls: 2 })
      }
      const rejectState = async (repo: string) => {
        const reviewRoot = join(repo, ".corvus/reviews/pr42"), candidatePath = join(reviewRoot, ".light/candidate.json"), artifactPath = join(reviewRoot, ".light/post-request.json")
        const before = readFileSync(artifactPath, "utf8")
        for (const [name, args] of [
          ["corvus_review_lock", { op: "acquire", reviewRoot, runId: "outside" }],
          ["corvus_review_persist", { op: "write_candidate", reviewRoot, candidate: request }],
          ["corvus_review_payload", { op: "measure", candidatePath }],
          ["corvus_review_payload", { op: "freeze", candidatePath, artifactPath }],
          ["corvus_review_payload", { op: "preview", artifactPath, expectedSha256 }],
        ] as const) expect(await call(name, args)).toMatchObject({ ok: false })
        expect(existsSync(candidatePath)).toBe(false)
        expect(existsSync(join(reviewRoot, "lock.yaml"))).toBe(false)
        expect(readFileSync(artifactPath, "utf8")).toBe(before)
        await rejectPost(artifactPath)
      }
      await rejectState(outside)
      // A located .corvus symlink must not turn an unlocated root into authority.
      renameSync(join(f.repo, ".corvus"), join(f.repo, "state-backup"))
      symlinkSync(join(outside, ".corvus"), join(f.repo, ".corvus"))
      await rejectState(f.repo)
    } finally {
      if (beforePath === undefined) delete process.env.PATH
      else process.env.PATH = beforePath
      await cleanup?.(); f.dispose()
    }
  })
  test.each(["v1", "v2"] as const)("%s reads verified roots, rejects mutations/outside/worktree Git, routes lock/candidate", async host => {
    const f = fixture()
    let cleanup: (() => void | Promise<void>) | void = undefined
    try {
      const fake = createFakeContext(f.workspace), hooks = await plugin({ directory: f.workspace } as Parameters<typeof plugin>[0])
      let call: (name: string, args: unknown) => Promise<string>, shell: (command: string, workdir?: string) => Promise<unknown>
      if (host === "v1") {
        await hooks["chat.params"]!({ sessionID: "ses_locate", agent: light } as Parameters<NonNullable<typeof hooks["chat.params"]>>[0], { maxOutputTokens: 1 } as Parameters<NonNullable<typeof hooks["chat.params"]>>[1])
        call = async (name, args) => hooks.tool![name].execute(args as never, { agent: light } as never) as Promise<string>
        shell = (command, workdir) => hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_locate", callID: "call" }, { args: { command, workdir } })
      } else {
        await registerTools(fake.ctx); cleanup = await enforceProtected(fake.ctx)
        call = async (name, args) => (await fake.tools.get(name)!.execute(args, { agent: light } as never)).content as string
        shell = (command, workdir) => fake.beforeTool({ tool: "shell", agent: light as Parameters<typeof fake.beforeTool>[0]["agent"], input: { command, workdir } })
      }
      await expect(shell("ls", f.repo)).rejects.toThrow("fixed-deny")
      expect(JSON.parse(await call("corvus_review_worktree", { op: "locate", ...identity }))).toMatchObject({ ok: true, repo_root: f.repo })
      const tool = createWorktreeExecutor({ cwd: f.workspace, exec: (argv, opts) => argv.includes("fetch") ? Promise.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: "" }) : realExec(argv, opts) })
      const input = { op: "create", ...identity, repo_root: f.repo, code_head: f.head, runId: "probe" }, created = await run(tool, input)
      expect(created.ok).toBe(true)
      for (const root of [f.workspace, f.repo, created.path]) for (const command of ["ls", "cat file", "rg literal .", "find . -name file", "git rev-parse HEAD"]) await shell(command, root)
      await shell("git status --porcelain", f.repo)
      for (const command of ["git status --porcelain", "git show HEAD", "git diff HEAD", "git log -1"]) await expect(shell(command, created.path)).rejects.toThrow("fixed-deny")
      await expect(shell("git status --porcelain", f.workspace)).rejects.toThrow("fixed-deny")
      for (const command of ["git fetch --no-tags origin pull/42/head", "git add .", "git -C . show HEAD", "git -c x=y log", "git --git-dir=.git show HEAD", "git remote add x y", "git show --output=file HEAD", "find . -exec sh x", "find . -execdir sh x", "find . -delete", "find . -ok sh x", "find . -fprint output", "rg --pre=evil x", "cat file > output", "ls; cat file", "ls $(evil)", "date 110212002026"]) await expect(shell(command, f.repo)).rejects.toThrow("fixed-deny")
      await expect(shell("ls", f.parent)).rejects.toThrow("fixed-deny")
      const reviewRoot = join(f.repo, ".corvus/reviews/pr42")
      expect(JSON.parse(await call("corvus_review_lock", { op: "acquire", reviewRoot, runId: "probe" }))).toMatchObject({ ok: true })
      expect(existsSync(join(reviewRoot, "lock.yaml"))).toBe(true)
      expect(existsSync(join(f.workspace, ".corvus/reviews/pr42/lock.yaml"))).toBe(false)
      expect(JSON.parse(await call("corvus_review_persist", { op: "write_candidate", reviewRoot, candidate: { commit_id: f.head, event: "COMMENT", body: "## Review of #42 — Fixture", comments: [] } }))).toMatchObject({ ok: true })
      expect(existsSync(join(reviewRoot, ".light/candidate.json"))).toBe(true)
      expect(JSON.parse(await call("corvus_review_payload", { op: "freeze", candidatePath: join(reviewRoot, ".light/candidate.json"), artifactPath: join(reviewRoot, ".light/post-request.json") }))).toMatchObject({ ok: true })
      expect((await run(tool, { ...input, op: "remove" })).ok).toBe(true)
      await expect(shell("ls", created.path)).rejects.toThrow("fixed-deny")
      expect(JSON.parse(await call("corvus_review_lock", { op: "release", reviewRoot, runId: "probe", mode: "delete" }))).toMatchObject({ ok: true })
    } finally { await cleanup?.(); f.dispose() }
  })
})

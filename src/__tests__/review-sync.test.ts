import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { files, local } from "../review-pr"
import { createSyncExecutor, pull, push, resolve, type PushInput, type SyncExec, type SyncExecResult, type SyncPr } from "../review-sync"

const PR: SyncPr = { owner: "example", name: "project", number: 42, isCrossRepository: false }
const ROOT = ".corvus/tasks/feature/reviews/pr42"
const BRANCH = "feature"
const STATE = `${ROOT}/review.md`
const STATE_BYTES = "Review state\n"
const sha = /^[a-f0-9]{40}$/
type Call = { argv: string[]; result: SyncExecResult }
type Fixture = {
  directory: string; workspace: string; origin: string; head: string; calls: Call[]; exec: SyncExec
  git(cwd: string, ...args: string[]): string
  runGit(cwd: string, args: string[]): SyncExecResult
  write(cwd: string, path: string, bytes: string): void
  peer(): string
}

function assertAllowed(argv: string[]): void {
  expect(argv[0]).toBe("git")
  expect(argv.some(arg => arg.startsWith("--force"))).toBe(false)
  expect(argv).not.toContain("reset")
  expect(argv).not.toContain("clean")
  const args = argv.slice(1), [op] = args
  const exact = (...forms: string[][]) => expect(forms).toContainEqual(args)
  const root = args.at(-1)!
  switch (op) {
    case "remote":
      if (args.length === 1) return
      expect(args.slice(0, 4)).toEqual(["remote", "get-url", "--push", "--all"])
      expect(args).toHaveLength(5)
      expect(args[4]).toMatch(/^(origin|github|publish)$/)
      return
    case "check-ref-format": exact([op, "--branch", BRANCH], [op, "--branch", "missing"]); return
    case "branch": exact([op, "--show-current"]); return
    case "rev-parse":
      exact(...["HEAD", "HEAD^", "FETCH_HEAD", "--show-toplevel"].map(ref => [op, ref]),
        [op, "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        ...["index.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].map(name => [op, "--git-path", name]))
      return
    case "config": exact([op, "--get", "user.name"], [op, "--get", "user.email"]); return
    case "--no-optional-locks":
      expect([".corvus/", ROOT, ".corvus/reviews/local-feature"]).toContain(root)
      exact([op, "status", "--porcelain", "-z", "--", root]); return
    case "log":
      if (args[1] === "-50") {
        expect(args[4]).toMatch(sha)
        exact([op, "-50", "--format=%H%x00%s", "-z", args[4], "--"])
      } else exact([op, "-1", "--format=%s", "HEAD", "--"])
      return
    case "add":
      expect([ROOT, ".corvus/reviews/local-feature"]).toContain(root)
      exact([op, "--", root]); return
    case "commit":
      expect([ROOT, ".corvus/reviews/local-feature"]).toContain(root)
      expect(args[3]).toMatch(/^corvus\(review-state\): (pr42|local-feature) @ [a-f0-9]{7} \[skip ci\]$/)
      exact([op, "--only", "-m", args[3], "--", root]); return
    case "fetch": case "push":
      expect(["origin", "publish"]).toContain(args[1])
      exact([op, args[1], op === "push" ? `HEAD:${BRANCH}` : BRANCH], ["fetch", "origin", "missing"]); return
    case "merge": exact([op, "--ff-only", "FETCH_HEAD"]); return
    case "diff-tree":
      expect(args[5]).toMatch(sha)
      exact([op, "--no-commit-id", "--name-only", "-r", "-z", args[5], "--"]); return
    case "diff":
      exact([op, "--quiet", "HEAD", "--", ".", `:(top,exclude)${ROOT}/**`],
        [op, "--cached", "--quiet", "--", ".", `:(top,exclude)${ROOT}/**`],
        [op, "--name-only", "--diff-filter=U", "-z", "--"]); return
    case "rebase":
      if (args.length === 2) { exact([op, "--abort"]); return }
      expect(args[4]).toMatch(sha)
      expect(args[5]).toMatch(sha)
      exact([op, "--no-autostash", "--no-update-refs", "--onto", args[4], args[5]]); return
    case "-c": exact([op, "core.editor=true", "rebase", "--continue"]); return
    default: throw new Error(`Unlisted sync argv: ${JSON.stringify(argv)}`)
  }
}

async function withRepo(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corvus-review-sync-")))
  const workspace = join(directory, "workspace"), origin = join(directory, "origin.git")
  const calls: Call[] = []
  const env = {
    PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory, LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "gitconfig"),
    GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true",
  }
  const runGit = (cwd: string, args: string[]): SyncExecResult => {
    expect(cwd === directory || cwd.startsWith(directory + "/")).toBe(true)
    const result = Bun.spawnSync(["git", ...args], { cwd, env })
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }
  const git = (cwd: string, ...args: string[]): string => {
    const result = runGit(cwd, args)
    expect(result.code, `${JSON.stringify(args)}\n${result.stderr}`).toBe(0)
    return result.stdout.trim()
  }
  const write = (cwd: string, path: string, bytes: string) => {
    const target = join(cwd, path)
    fs.mkdirSync(dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
  }
  const configure = (cwd: string) => {
    git(cwd, "config", "user.name", "Fixture Author")
    git(cwd, "config", "user.email", "fixture@example.invalid")
    git(cwd, "config", "commit.gpgsign", "false")
  }
  const exec: SyncExec = async (argv, options) => {
    assertAllowed(argv)
    expect(options.cwd).toBe(workspace)
    const result = runGit(options.cwd, argv.slice(1))
    calls.push({ argv: [...argv], result })
    return result
  }
  try {
    fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "")
    git(directory, "init", "--bare", "--initial-branch=main", origin)
    git(directory, "clone", origin, workspace)
    configure(workspace)
    write(workspace, "product.txt", "Base product\n")
    git(workspace, "add", "--", "product.txt")
    git(workspace, "commit", "-m", "Initial product")
    git(workspace, "push", "origin", "HEAD:main")
    git(workspace, "checkout", "-b", BRANCH)
    write(workspace, "product.txt", "Feature product\n")
    git(workspace, "add", "--", "product.txt")
    git(workspace, "commit", "-m", "Product change")
    git(workspace, "push", "--set-upstream", "origin", BRANCH)
    const head = git(workspace, "rev-parse", "HEAD")
    await run({ directory, workspace, origin, head, calls, exec, git, runGit, write, peer() {
      const peer = join(directory, "peer")
      git(directory, "clone", "--branch", BRANCH, origin, peer)
      configure(peer)
      return peer
    } })
  } finally {
    try { for (const { argv } of calls) assertAllowed(argv) }
    finally { fs.rmSync(directory, { recursive: true, force: true }) }
  }
}

const pushInput = (f: Fixture): PushInput => ({ cwd: f.workspace, root: ROOT, head_sha: f.head, pr: PR, branch: BRANCH })
const callsFor = (f: Fixture, op: string) => f.calls.filter(call => call.argv[1] === op)
function advance(f: Fixture, peer: string, path = "remote.txt", bytes = "Remote product\n"): string {
  f.write(peer, path, bytes)
  f.git(peer, "add", "--", path)
  f.git(peer, "commit", "-m", "Concurrent change")
  f.git(peer, "push", "origin", `HEAD:${BRANCH}`)
  return f.git(peer, "rev-parse", "HEAD")
}
function assertStateCommit(f: Fixture, commit: string, parent: string): void {
  expect(commit).toMatch(sha)
  expect(f.git(f.origin, "rev-parse", BRANCH)).toBe(commit)
  expect(f.git(f.workspace, "rev-parse", `${commit}^`)).toBe(parent)
  expect(f.git(f.workspace, "rev-list", "--count", `${parent}..${commit}`)).toBe("1")
  expect(f.git(f.workspace, "show", "--format=", "--name-only", commit)).toBe(STATE)
  expect(f.git(f.workspace, "show", "--stat", "--format=", commit)).toContain(STATE)
  expect(f.git(f.workspace, "log", "-1", "--format=%s", commit)).toBe(`corvus(review-state): pr42 @ ${f.head.slice(0, 7)} [skip ci]`)
  expect(f.git(f.workspace, "show", `${commit}:${STATE}`)).toBe(STATE_BYTES.trim())
}

describe("review sync layout", () => {
  test.each([
    { names: [".corvus/tasks/feature/PLAN.md", ".corvus/tasks/feature/DISCOVERY.md"], root: ROOT, task: "feature" },
    { names: ["product.txt"], root: ".corvus/reviews/pr42", task: null },
    { names: [".corvus/tasks/feature/PLAN.md", ".corvus/tasks/other/PLAN.md"], root: ".corvus/reviews/pr42", task: null },
  ])("resolves the changed-task inventory $names", row => withRepo(async f => {
    expect(await resolve({ cwd: f.workspace, pr: PR, changed_files: [...row.names] }, { exec: f.exec }))
      .toEqual({ ok: true, root: row.root, task: row.task, remote: "origin", git_calls: 2 })
    expect(fs.existsSync(join(f.workspace, ".corvus"))).toBe(false)
  }))

  test("resolves LOCAL branch slugs under both layouts and detects legacy state without writing", () => withRepo(async f => {
    const pr = { name: "project", number: null, branch: "feat/x y@z" } as const
    const legacy_root = ".corvus/reviews/local__project__feat-x-y-z"
    f.write(f.workspace, `${legacy_root}/input.md`, STATE_BYTES)
    for (const task of [null, "feature"]) {
      const root = `.corvus/${task ? `tasks/${task}/` : ""}reviews/local-feat-x-y-z`
      expect(await resolve({ cwd: f.workspace, pr, changed_files: task ? [`.corvus/tasks/${task}/PLAN.md`] : [] }, { exec: f.exec }))
        .toEqual({ ok: true, root, task, legacy_root, remote: "origin", git_calls: 0 })
      expect(fs.existsSync(join(f.workspace, root))).toBe(false)
    }
    expect(fs.readFileSync(join(f.workspace, legacy_root, "input.md"), "utf8")).toBe(STATE_BYTES)
  }))

  test("matches GitHub push URLs, not fetch URLs, and keeps PR legacy roots read-only", () => withRepo(async f => {
    f.git(f.workspace, "remote", "add", "github", "https://github.com/example/project.git")
    f.git(f.workspace, "remote", "set-url", "--push", "github", "READ_ONLY_SENTINEL")
    const legacy_root = ".corvus/reviews/example__project__pr42"
    f.write(f.workspace, `${legacy_root}/input.md`, STATE_BYTES)
    const input = { cwd: f.workspace, pr: PR, changed_files: [] }
    expect(await resolve(input, { exec: f.exec })).toMatchObject({ ok: true, remote: "origin", legacy_root })
    for (const url of ["git@github.com:Example/Project.git", "ssh://git@github.com/example/project.git", "https://github.com/example/project"]) {
      f.git(f.workspace, "remote", "set-url", "--push", "github", url)
      expect(await resolve(input, { exec: f.exec })).toMatchObject({ ok: true, remote: "github", legacy_root })
    }
    expect(fs.readdirSync(join(f.workspace, ".corvus/reviews"))).toEqual(["example__project__pr42"])
    expect(fs.readFileSync(join(f.workspace, legacy_root, "input.md"), "utf8")).toBe(STATE_BYTES)
  }))

  test("composes unfiltered names-only PR files into the task-scoped root while review files stay filtered", () => withRepo(async f => {
    const inventory = ["product.txt", ".corvus/tasks/feature/PLAN.md"].map(filename => ({ filename, status: "modified", additions: 1, deletions: 0, patch: "+source" }))
    const exec = async () => ({ code: 0, stdout: JSON.stringify(inventory), stderr: "" })
    const input = { owner: "example", name: "project", pr: 42, paginate: true } as const
    const result = await files({ ...input, include_corvus: true, names_only: true }, { exec })
    expect(result).toMatchObject({ ok: true, files: inventory.map(item => item.filename), excluded_corvus: 0 })
    if (!result.ok) throw new Error("Expected a complete inventory")
    expect(await resolve({ cwd: f.workspace, pr: PR, changed_files: result.files as string[] }, { exec: f.exec }))
      .toMatchObject({ ok: true, root: ROOT, task: "feature" })
    expect(await files(input, { exec })).toMatchObject({ ok: true, excluded_corvus: 1, files: [{ ...inventory[0], has_patch: true }] })
  }))
})

describe("review sync pull", () => {
  test("fetches and fast-forwards a clean tree using the selected remote", () => withRepo(async f => {
    const tip = advance(f, f.peer(), STATE, STATE_BYTES)
    f.git(f.workspace, "remote", "rename", "origin", "publish")
    f.git(f.workspace, "remote", "add", "github", f.origin)
    f.git(f.workspace, "remote", "set-url", "--push", "github", "READ_ONLY_SENTINEL")
    const result = await pull({ cwd: f.workspace, branch: BRANCH, remote: "publish" }, { exec: f.exec })
    expect(result).toEqual({ synced: true, git_calls: f.calls.length })
    expect(f.git(f.workspace, "rev-parse", "HEAD")).toBe(tip)
    expect(fs.readFileSync(join(f.workspace, STATE), "utf8")).toBe(STATE_BYTES)
    expect(callsFor(f, "fetch").map(call => call.argv)).toEqual([["git", "fetch", "publish", BRANCH]])
    expect(callsFor(f, "merge").map(call => call.argv)).toEqual([["git", "merge", "--ff-only", "FETCH_HEAD"]])
  }))

  test("leaves dirty review state untouched without fetching", () => withRepo(async f => {
    f.write(f.workspace, STATE, STATE_BYTES)
    expect(await pull({ cwd: f.workspace, branch: BRANCH }, { exec: f.exec }))
      .toEqual({ synced: false, reason: "dirty-review-state", git_calls: f.calls.length })
    expect(callsFor(f, "fetch")).toEqual([])
    expect(callsFor(f, "merge")).toEqual([])
    expect(f.git(f.workspace, "rev-parse", "HEAD")).toBe(f.head)
    expect(fs.readFileSync(join(f.workspace, STATE), "utf8")).toBe(STATE_BYTES)
  }))

  test("returns a structured refusal when the remote branch does not exist", () => withRepo(async f => {
    expect(await pull({ cwd: f.workspace, branch: "missing" }, { exec: f.exec }))
      .toEqual({ synced: false, reason: "fetch-refused", git_calls: f.calls.length })
    expect(callsFor(f, "merge")).toEqual([])
    expect(f.git(f.workspace, "rev-parse", "HEAD")).toBe(f.head)
  }))
})

describe("review sync push", () => {
  test("commits only the review root from detached PR HEAD, preserves unrelated staging, and resumes without a second commit", () => withRepo(async f => {
    f.git(f.workspace, "checkout", "--detach", f.head)
    f.write(f.workspace, "product.txt", "Staged unrelated product\n")
    f.git(f.workspace, "add", "--", "product.txt")
    f.write(f.workspace, ".corvus/tasks/feature/PLAN.md", "Unstaged plan\n")
    f.write(f.workspace, STATE, STATE_BYTES)
    const input = pushInput(f)
    const result = await push(input, { exec: f.exec })
    expect(result).toEqual({ synced: true, state_commit: expect.stringMatching(sha), git_calls: f.calls.length })
    assertStateCommit(f, result.state_commit!, f.head)
    expect(f.git(f.workspace, "diff", "--cached", "--name-only")).toBe("product.txt")
    expect(f.git(f.workspace, "show", ":product.txt")).toBe("Staged unrelated product")
    expect(f.git(f.workspace, "show", `${result.state_commit}:product.txt`)).toBe("Feature product")
    const resumed = await push(input, { exec: f.exec })
    expect(resumed).toMatchObject({ synced: true, state_commit: result.state_commit })
    expect(callsFor(f, "commit")).toHaveLength(1)
    expect(f.git(f.workspace, "rev-list", "--count", `${f.head}..HEAD`)).toBe("1")
    expect(f.git(f.workspace, "diff", "--cached", "--name-only")).toBe("product.txt")
  }))

  test("adds one state commit when HEAD is a prior state commit above the supplied code head", () => withRepo(async f => {
    f.write(f.workspace, STATE, "Previous review\n")
    f.git(f.workspace, "add", "--", ROOT)
    f.git(f.workspace, "commit", "-m", `corvus(review-state): pr42 @ ${f.head.slice(0, 7)} [skip ci]`)
    const prior = f.git(f.workspace, "rev-parse", "HEAD")
    expect(prior).not.toBe(f.head)
    expect(f.git(f.workspace, "rev-parse", "HEAD^")).toBe(f.head)
    f.write(f.workspace, STATE, STATE_BYTES)

    const result = await push(pushInput(f), { exec: f.exec })

    expect(result).toEqual({ synced: true, state_commit: expect.stringMatching(sha), git_calls: f.calls.length })
    assertStateCommit(f, result.state_commit!, prior)
    expect(callsFor(f, "commit")).toHaveLength(1)
    expect(callsFor(f, "push")).toHaveLength(1)
  }))

  test("refuses a different code head beneath a state tip without searching past the newer code commit", () => withRepo(async f => {
    f.write(f.workspace, "product.txt", "Newer product\n")
    f.git(f.workspace, "add", "--", "product.txt")
    f.git(f.workspace, "commit", "-m", "Product change mentioning corvus(review-state):")
    const codeHead = f.git(f.workspace, "rev-parse", "HEAD")
    expect(codeHead).not.toBe(f.head)
    f.write(f.workspace, STATE, "Previous review\n")
    f.git(f.workspace, "add", "--", ROOT)
    f.git(f.workspace, "commit", "-m", `corvus(review-state): pr42 @ ${codeHead.slice(0, 7)} [skip ci]`)
    const prior = f.git(f.workspace, "rev-parse", "HEAD")
    expect(f.git(f.workspace, "rev-parse", "HEAD^")).toBe(codeHead)
    f.write(f.workspace, STATE, STATE_BYTES)

    expect(await push(pushInput(f), { exec: f.exec }))
      .toEqual({ synced: false, reason: "head-not-at-expected-tip", git_calls: f.calls.length })
    for (const op of ["add", "commit", "push", "fetch", "rebase"]) expect(callsFor(f, op)).toEqual([])
    expect(f.git(f.workspace, "rev-parse", "HEAD")).toBe(prior)
    expect(f.git(f.origin, "rev-parse", BRANCH)).toBe(f.head)
    expect(fs.readFileSync(join(f.workspace, STATE), "utf8")).toBe(STATE_BYTES)
  }))

  test.each([false, true])("replays only its state commit after non-ff, resolving root conflicts=%s", conflict => withRepo(async f => {
    const tip = advance(f, f.peer(), conflict ? STATE : "remote.txt", conflict ? "Concurrent review\n" : "Remote product\n")
    f.write(f.workspace, STATE, STATE_BYTES)
    const result = await push(pushInput(f), { exec: f.exec })
    expect(result).toEqual({ synced: true, state_commit: expect.stringMatching(sha), git_calls: f.calls.length })
    assertStateCommit(f, result.state_commit!, tip)
    expect(callsFor(f, "push")).toHaveLength(2)
    expect(callsFor(f, "push")[0].result.code).not.toBe(0)
    expect(callsFor(f, "fetch")).toHaveLength(1)
    expect(callsFor(f, "rebase").map(call => call.argv.slice(1, 5))).toEqual([["rebase", "--no-autostash", "--no-update-refs", "--onto"]])
    expect(callsFor(f, "-c")).toHaveLength(conflict ? 1 : 0)
    expect(f.git(f.workspace, "status", "--porcelain")).toBe("")
  }))

  test("stops after three unsuccessful replay attempts without forcing the remote", () => withRepo(async f => {
    const peer = f.peer()
    f.write(f.workspace, STATE, STATE_BYTES)
    let attempts = 0
    const exec: SyncExec = async (argv, options) => {
      if (argv[1] === "push") advance(f, peer, "remote.txt", `Remote advance ${++attempts}\n`)
      return f.exec(argv, options)
    }
    const result = await push(pushInput(f), { exec })
    expect(result).toEqual({ synced: false, reason: "retry-limit", state_commit: expect.stringMatching(sha), git_calls: f.calls.length })
    expect(callsFor(f, "push")).toHaveLength(4)
    expect(callsFor(f, "fetch")).toHaveLength(3)
    expect(callsFor(f, "rebase")).toHaveLength(3)
    expect(f.git(f.origin, "rev-parse", BRANCH)).not.toBe(result.state_commit)
    expect(fs.readFileSync(join(f.workspace, STATE), "utf8")).toBe(STATE_BYTES)
  }))

  test.each(["no-identity", "index-busy", "LOCAL-no-upstream", "head-not-at-expected-tip", "fork"] as const)(
    "refuses %s before staging or committing", reason => withRepo(async f => {
      let input = pushInput(f)
      if (reason === "no-identity") f.git(f.workspace, "config", "--unset", "user.email")
      if (reason === "index-busy") f.write(f.workspace, ".git/MERGE_HEAD", f.head + "\n")
      if (reason === "LOCAL-no-upstream") {
        f.git(f.workspace, "branch", "--unset-upstream")
        input = { ...input, root: ".corvus/reviews/local-feature", pr: { name: "project", number: null, branch: BRANCH } }
      }
      if (reason === "head-not-at-expected-tip") f.git(f.workspace, "checkout", "--detach", "HEAD^")
      if (reason === "fork") input = { ...input, pr: { ...PR, isCrossRepository: true } }
      f.write(f.workspace, `${input.root}/review.md`, STATE_BYTES)
      const before = f.git(f.workspace, "rev-parse", "HEAD")
      expect(await push(input, { exec: f.exec })).toEqual({ synced: false, reason, git_calls: f.calls.length })
      for (const op of ["add", "commit", "push", "fetch", "rebase"]) expect(callsFor(f, op)).toEqual([])
      expect(f.git(f.workspace, "rev-parse", "HEAD")).toBe(before)
      expect(fs.readFileSync(join(f.workspace, input.root, "review.md"), "utf8")).toBe(STATE_BYTES)
    }),
  )

  test("reports a read-only bare remote refusal and keeps the state commit local", () => withRepo(async f => {
    const hook = join(f.origin, "hooks/pre-receive")
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    f.write(f.workspace, STATE, STATE_BYTES)
    const result = await push(pushInput(f), { exec: f.exec })
    expect(result).toEqual({ synced: false, reason: "push-refused", state_commit: expect.stringMatching(sha), git_calls: f.calls.length })
    expect(f.git(f.origin, "rev-parse", BRANCH)).toBe(f.head)
    expect(result.state_commit).toBe(f.git(f.workspace, "rev-parse", "HEAD"))
    expect(callsFor(f, "push")).toHaveLength(1)
    expect(callsFor(f, "rebase")).toEqual([])
  }))

  test("pushes only to the named remote and never the read-only github remote", () => withRepo(async f => {
    const github = join(f.directory, "github.git")
    f.git(f.directory, "clone", "--bare", f.origin, github)
    f.git(f.workspace, "remote", "rename", "origin", "publish")
    f.git(f.workspace, "remote", "add", "github", github)
    f.git(f.workspace, "remote", "set-url", "--push", "github", "READ_ONLY_SENTINEL")
    f.write(f.workspace, STATE, STATE_BYTES)
    const result = await push({ ...pushInput(f), remote: "publish" }, { exec: f.exec })
    expect(result).toMatchObject({ synced: true })
    assertStateCommit(f, result.state_commit!, f.head)
    expect(f.git(github, "rev-parse", BRANCH)).toBe(f.head)
    expect(callsFor(f, "push").map(call => call.argv)).toEqual([["git", "push", "publish", `HEAD:${BRANCH}`]])
  }))

  test("LOCAL with an upstream pushes a local-slug state commit", () => withRepo(async f => {
    const root = ".corvus/reviews/local-feature"
    f.write(f.workspace, `${root}/review.md`, STATE_BYTES)
    const result = await push({ ...pushInput(f), root, pr: { name: "project", number: null, branch: BRANCH } }, { exec: f.exec })
    expect(result).toMatchObject({ synced: true })
    expect(result.state_commit).toBe(f.git(f.origin, "rev-parse", BRANCH))
    expect(f.git(f.workspace, "show", "--format=", "--name-only", "HEAD")).toBe(`${root}/review.md`)
    expect(f.git(f.workspace, "log", "-1", "--format=%s")).toBe(`corvus(review-state): local-feature @ ${f.head.slice(0, 7)} [skip ci]`)
  }))

  test("rejects unlisted controls and legacy write roots with no mutating argv", () => withRepo(async f => {
    const calls: string[][] = []
    const exec: SyncExec = async argv => { calls.push(argv); return { code: 0, stdout: "", stderr: "" } }
    const execute = createSyncExecutor({ cwd: f.workspace, exec })
    for (const input of [{ op: "pull", branch: BRANCH, force: true }, { op: "push", ...pushInput(f), remote: "--force" }]) {
      expect(JSON.parse(await execute(input))).toMatchObject({ synced: false, git_calls: 0 })
    }
    expect(calls).toEqual([])
    expect(await push({ ...pushInput(f), root: ".corvus/reviews/example__project__pr42" }, { exec: f.exec }))
      .toMatchObject({ synced: false, reason: "invalid-root" })
    expect(callsFor(f, "add")).toEqual([])
    expect(callsFor(f, "commit")).toEqual([])
  }))

  test("local inventory keeps task records while code_head skips two real state commits and diff excludes them", () => withRepo(async f => {
    for (let round = 1; round <= 2; round++) {
      f.write(f.workspace, ".corvus/tasks/feature/PLAN.md", `Plan round ${round}\n`)
      f.git(f.workspace, "add", "--", ".corvus/tasks/feature/PLAN.md")
      f.git(f.workspace, "commit", "-m", `corvus(review-state): pr42 @ ${f.head.slice(0, 7)} [skip ci]`)
    }
    const calls: string[][] = []
    const result = await local({ cwd: f.workspace }, { exec: async (argv, options) => {
      calls.push(argv)
      expect(argv[0]).toBe("git")
      expect(options?.cwd).toBe(f.workspace)
      return f.runGit(f.workspace, argv.slice(1))
    } })
    expect(result).toMatchObject({ ok: true, head_sha: f.git(f.workspace, "rev-parse", "HEAD"), code_head: f.head,
      changed_files: [".corvus/tasks/feature/PLAN.md", "product.txt"], excluded_corvus: 1 })
    if (!result.ok) throw new Error("Expected local changes")
    expect(result.diff).toContain("Feature product")
    expect(result.diff).not.toContain(".corvus/")
    for (const argv of calls) expect(["branch", "rev-parse", "log", "symbolic-ref", "show-ref", "merge-base", "rev-list", "diff", "--no-optional-locks"]).toContain(argv[1])
  }))
})

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { files, local } from "../review-pr"
import { createLockExecutor } from "../review-lock"
import { createPersistExecutor } from "../review-persist"
import { createReviewToolExecutors } from "../review-payload"
import { createSyncExecutor, pull, push, resolve, type PushInput, type SyncExec, type SyncExecResult, type SyncPr } from "../review-sync"

const PR: SyncPr = { owner: "example", name: "project", number: 42, isCrossRepository: false }
const ROOT = ".corvus/tasks/feature/reviews/pr42"
const PR_ROOTS = [".corvus/reviews/pr42", ROOT, ".corvus/tasks/.light/reviews/pr42"]
const PULL_ROOTS = [...PR_ROOTS, ".corvus/tasks/.staging/reviews/pr42"]
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
  const paths = args.slice(args.indexOf("--") + 1), root = paths[0]
  const reviewPaths = () => {
    expect([...PR_ROOTS, ".corvus/reviews/local-feature"]).toContain(root)
    const base = [root, `:(exclude)${root}/**/.staging/**`, `:(exclude)${root}/.staging/**`]
    expect(paths).toEqual(paths.length === base.length ? base : [...base, ...lightPaths(root)])
  }
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
      if (root === ".corvus/") expect([[root], ...PULL_ROOTS.map(namespace => [root, ...lightPaths(namespace)])]).toContainEqual(paths)
      else reviewPaths()
      exact([op, "status", "--porcelain", "-z", "--", ...paths]); return
    case "log":
      if (args[1] === "-50") {
        expect(args[4]).toMatch(sha)
        exact([op, "-50", "--format=%H%x00%s", "-z", args[4], "--"])
      } else exact([op, "-1", "--format=%s", "HEAD", "--"])
      return
    case "add":
      reviewPaths()
      exact([op, "--", ...paths]); return
    case "commit":
      reviewPaths()
      expect(args[3]).toMatch(/^corvus\(review-state\): (pr42|local-feature) @ [a-f0-9]{7} \[skip ci\]$/)
      exact([op, "--only", "-m", args[3], "--", ...paths]); return
    case "fetch": case "push":
      expect(["origin", "publish"]).toContain(args[1])
      exact([op, args[1], op === "push" ? `HEAD:${BRANCH}` : BRANCH], ["fetch", "origin", "missing"]); return
    case "merge": exact([op, "--ff-only", "FETCH_HEAD"]); return
    case "diff-tree":
      expect(args[5]).toMatch(sha)
      exact([op, "--no-commit-id", "--name-only", "-r", "-z", args[5], "--"]); return
    case "diff":
      exact(...PR_ROOTS.flatMap(namespace => [[op, "--quiet", "HEAD", "--", ".", `:(top,exclude)${namespace}/**`],
        [op, "--cached", "--quiet", "--", ".", `:(top,exclude)${namespace}/**`]]),
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

const lightPaths = (root: string) => [`:(exclude)${root}/.light/**`,
  `:(exclude)${root}/lock.yaml`, `:(exclude)${root}/.lock`]

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
function assertStateCommit(f: Fixture, commit: string, parent: string, root = ROOT): void {
  const state = `${root}/review.md`
  expect(commit).toMatch(sha)
  expect(f.git(f.origin, "rev-parse", BRANCH)).toBe(commit)
  expect(f.git(f.workspace, "rev-parse", `${commit}^`)).toBe(parent)
  expect(f.git(f.workspace, "rev-list", "--count", `${parent}..${commit}`)).toBe("1")
  expect(f.git(f.workspace, "show", "--format=", "--name-only", commit)).toBe(state)
  expect(f.git(f.workspace, "show", "--stat", "--format=", commit)).toContain(state)
  expect(f.git(f.workspace, "log", "-1", "--format=%s", commit)).toBe(`corvus(review-state): pr42 @ ${f.head.slice(0, 7)} [skip ci]`)
  expect(f.git(f.workspace, "show", `${commit}:${state}`)).toBe(STATE_BYTES.trim())
}

// No-class argv oracle: git archive 24e63c973fc42ef318cf726b4f9896c34585cd70,
// sync2.ts push/retry/dirty-pull/clean-pull probes. Hashes alone are normalized.
const busyArgv = ["index.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]
  .map(name => ["git", "rev-parse", "--git-path", name])
const entryArgv = [["git", "check-ref-format", "--branch", BRANCH], ["git", "rev-parse", "--show-toplevel"]]
const pullStatus = ["git", "--no-optional-locks", "status", "--porcelain", "-z", "--", ".corvus/"]
const normalizeArgv = (calls: Call[]) => calls.map(({ argv }) => argv.map(arg => arg
  .replace(/[a-f0-9]{40}/g, "<sha>").replace(/@ [a-f0-9]{7}/g, "@ <s7>")))
function basePushArgv(root: string): string[][] {
  const paths = [root, `:(exclude)${root}/**/.staging/**`, `:(exclude)${root}/.staging/**`]
  return [...entryArgv, ["git", "rev-parse", "HEAD"], ["git", "log", "-50", "--format=%H%x00%s", "-z", "<sha>", "--"],
    ...busyArgv, ["git", "config", "--get", "user.name"], ["git", "config", "--get", "user.email"],
    ["git", "--no-optional-locks", "status", "--porcelain", "-z", "--", ...paths], ["git", "add", "--", ...paths],
    ["git", "commit", "--only", "-m", "corvus(review-state): pr42 @ <s7> [skip ci]", "--", ...paths],
    ["git", "rev-parse", "HEAD"], ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "<sha>", "--"],
    ["git", "push", "origin", `HEAD:${BRANCH}`]]
}

describe("no-class base synchronization equivalence", () => {
  test.each(PR_ROOTS.flatMap(root => ["push", "retry", "dirty-pull", "clean-pull"].map(mode => ({ root, mode }))))(
    "$mode keeps base argv/results for $root", ({ root, mode }) => withRepo(async f => {
      const state = `${root}/review.md`
      if (mode === "clean-pull") advance(f, f.peer(), state, STATE_BYTES)
      if (mode === "retry") advance(f, f.peer())
      if (mode !== "clean-pull") f.write(f.workspace, state, STATE_BYTES)
      if (mode === "push") f.write(f.workspace, `${root}/.staging/x`, "Unfinished staging\n")
      if (mode.endsWith("pull")) {
        const result = await pull({ cwd: f.workspace, branch: BRANCH }, { exec: f.exec })
        expect(result).toEqual(mode === "dirty-pull" ? { synced: false, reason: "dirty-review-state", git_calls: 3 } : { synced: true, git_calls: 12 })
        expect(normalizeArgv(f.calls)).toEqual(mode === "dirty-pull" ? [...entryArgv, pullStatus]
          : [...entryArgv, pullStatus, ...busyArgv, ["git", "fetch", "origin", BRANCH], pullStatus, ["git", "merge", "--ff-only", "FETCH_HEAD"]])
      } else {
        const result = await push({ ...pushInput(f), root }, { exec: f.exec })
        expect(result).toMatchObject({ synced: true, git_calls: mode === "retry" ? 27 : 18 })
        const expected = basePushArgv(root)
        if (mode === "retry") expected.push(["git", "fetch", "origin", BRANCH], ["git", "rev-parse", "FETCH_HEAD"],
          ["git", "diff", "--quiet", "HEAD", "--", ".", `:(top,exclude)${root}/**`],
          ["git", "diff", "--cached", "--quiet", "--", ".", `:(top,exclude)${root}/**`], ["git", "rev-parse", "HEAD"],
          ["git", "rebase", "--no-autostash", "--no-update-refs", "--onto", "<sha>", "<sha>"], ["git", "rev-parse", "HEAD"],
          ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "<sha>", "--"], ["git", "push", "origin", `HEAD:${BRANCH}`])
        expect(normalizeArgv(f.calls)).toEqual(expected)
        expect(f.git(f.origin, "rev-parse", BRANCH)).toBe(result.state_commit!)
      }
    }),
  )
})

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
  test.each(PULL_ROOTS)("clean checks find the direct light class without skipping task names: %s", root => withRepo(async f => {
    f.write(f.workspace, `${root}/.light/post-request.json`, "Local bytes\n")
    f.write(f.workspace, `${root}/lock.yaml`, "Private lock bytes\n")
    f.write(f.workspace, `${root}/.lock`, "Private legacy lock bytes\n")
    const tip = advance(f, f.peer())
    expect(await pull({ cwd: f.workspace, branch: BRANCH }, { exec: f.exec })).toEqual({ synced: true, git_calls: 12 })
    const status = ["git", "--no-optional-locks", "status", "--porcelain", "-z", "--", ".corvus/", ...lightPaths(root)]
    expect(callsFor(f, "--no-optional-locks").map(({ argv }) => argv)).toEqual([status, status])
    expect(f.git(f.workspace, "rev-parse", "HEAD")).toBe(tip)
    expect(fs.readFileSync(join(f.workspace, `${root}/.light/post-request.json`), "utf8")).toBe("Local bytes\n")
  }))
  test("ignores untracked light artifacts and a deleted tracked terminal lock in both clean checks", () => withRepo(async f => {
    const lock = createLockExecutor(join(f.workspace, ".corvus"))
    expect(JSON.parse(lock({ op: "acquire", reviewRoot: ROOT, runId: "full" }, "corvus-review"))).toMatchObject({ ok: true })
    expect(JSON.parse(lock({ op: "release", reviewRoot: ROOT, runId: "full", mode: "complete" }, "corvus-review"))).toMatchObject({ ok: true })
    f.git(f.workspace, "add", "--", `${ROOT}/lock.yaml`)
    f.git(f.workspace, "commit", "-m", "corvus(review-state): prior terminal lock")
    f.git(f.workspace, "push", "origin", `HEAD:${BRANCH}`)
    const tip = advance(f, f.peer())
    expect(JSON.parse(lock({ op: "acquire", reviewRoot: ROOT, runId: "light" }, "corvus-review-light"))).toMatchObject({ ok: true })
    expect(JSON.parse(lock({ op: "release", reviewRoot: ROOT, runId: "light", mode: "delete" }, "corvus-review-light"))).toMatchObject({ ok: true })
    f.write(f.workspace, `${ROOT}/.light/post-request.json`, "Local light bytes\n")
    expect(await pull({ cwd: f.workspace, branch: BRANCH }, { exec: f.exec })).toMatchObject({ synced: true })
    expect(f.git(f.workspace, "rev-parse", "HEAD")).toBe(tip)
    expect(callsFor(f, "--no-optional-locks")).toHaveLength(2)
    expect(fs.readFileSync(join(f.workspace, `${ROOT}/.light/post-request.json`), "utf8")).toBe("Local light bytes\n")
    expect(fs.existsSync(join(f.workspace, `${ROOT}/lock.yaml`))).toBe(false)
  }))

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
  test.each(PR_ROOTS)("nested head/class-named directories stay ordinary state during conflict replay: %s", root => withRepo(async f => {
    const nested = `${root}/${f.head}/.light/x`
    const tip = advance(f, f.peer(), nested, "Remote ordinary bytes\n")
    f.write(f.workspace, nested, "Local ordinary bytes\n")
    // A direct class exists too, so the pathspec must not exclude nested names.
    f.write(f.workspace, `${root}/.light/candidate.json`, "Private bytes\n")
    const result = await push({ ...pushInput(f), root }, { exec: f.exec })
    expect(result).toMatchObject({ synced: true })
    expect(f.git(f.origin, "rev-parse", BRANCH)).toBe(result.state_commit!)
    expect(f.git(f.workspace, "rev-parse", `${result.state_commit}^`)).toBe(tip)
    expect(f.git(f.workspace, "show", "--format=", "--name-only", result.state_commit!)).toBe(nested)
    expect(f.git(f.workspace, "show", `${result.state_commit}:${nested}`)).toBe("Local ordinary bytes")
    expect(callsFor(f, "-c")).toHaveLength(1)
  }))
  test("replay snapshots and conflict repair leave the light class untouched", () => withRepo(async f => {
    const tip = advance(f, f.peer(), STATE, "Concurrent full state\n")
    f.write(f.workspace, `${ROOT}/.light/post-request.json`, "Local light bytes\n")
    fs.symlinkSync(join(f.workspace, "product.txt"), join(f.workspace, `${ROOT}/.light/snapshot-must-not-read`))
    f.write(f.workspace, STATE, STATE_BYTES)
    const result = await push(pushInput(f), { exec: f.exec })
    expect(result).toMatchObject({ synced: true })
    assertStateCommit(f, result.state_commit!, tip)
    expect(f.git(f.workspace, "ls-tree", "-r", "--name-only", "HEAD", "--", `${ROOT}/.light`)).toBe("")
    expect(fs.readFileSync(join(f.workspace, `${ROOT}/.light/post-request.json`), "utf8")).toBe("Local light bytes\n")
    expect(fs.lstatSync(join(f.workspace, `${ROOT}/.light/snapshot-must-not-read`)).isSymbolicLink()).toBe(true)
    expect(callsFor(f, "push")).toHaveLength(2)
    expect(callsFor(f, "-c")).toHaveLength(1)
  }))

  test.each(PR_ROOTS.flatMap(root => ["active", "deleted"].map(mode => ({ root, mode }))))("mixed light→full $root excludes light artifacts and $mode shared lock changes", ({ root, mode }) => withRepo(async f => {
    const lock = createLockExecutor(join(f.workspace, ".corvus"))
    const callLock = (args: object, caller = "corvus-review") => JSON.parse(lock({ reviewRoot: root, ...args }, caller))
    expect(callLock({ op: "acquire", runId: "full" }).ok).toBe(true)
    expect(callLock({ op: "release", runId: "full", mode: "complete" }).ok).toBe(true)
    f.git(f.workspace, "add", "--", `${root}/lock.yaml`)
    f.git(f.workspace, "commit", "-m", "corvus(review-state): prior terminal lock")
    f.git(f.workspace, "push", "origin", `HEAD:${BRANCH}`)
    const parent = f.git(f.workspace, "rev-parse", "HEAD")
    const previousLock = fs.readFileSync(join(f.workspace, `${root}/lock.yaml`), "utf8")
    expect(callLock({ op: "acquire", runId: "light" }, "corvus-review-light").ok).toBe(true)
    expect(callLock({ op: "acquire", runId: "overlap" })).toMatchObject({ ok: false, state: "held" })
    const persist = createPersistExecutor(join(f.workspace, ".corvus"))
    const candidate = { commit_id: f.head, event: "COMMENT", body: "> Reduced coverage\nLight review", comments: [] }
    expect(JSON.parse(persist({ op: "write_candidate", reviewRoot: root, candidate }, "corvus-review-light")).ok).toBe(true)
    const frozen = JSON.parse(createReviewToolExecutors(f.workspace).payload({ op: "freeze", candidatePath: `${root}/.light/candidate.json`, artifactPath: `${root}/.light/post-request.json` }, "corvus-review-light"))
    expect(frozen.ok).toBe(true)
    f.write(f.workspace, `${root}/.light/.staging/candidate/manifest.json`, "Unfinished light staging\n")
    const privateFiles = ["candidate.json", "post-request.json", ".staging/candidate/manifest.json"]
    const before = privateFiles.map(name => fs.readFileSync(join(f.workspace, root, ".light", name)))
    if (mode === "deleted") expect(callLock({ op: "release", runId: "light", mode: "delete" }, "corvus-review-light").ok).toBe(true)
    expect(await pull({ cwd: f.workspace, branch: BRANCH }, { exec: f.exec })).toMatchObject({ synced: true })
    f.write(f.workspace, `${root}/review.md`, STATE_BYTES)
    const result = await push({ ...pushInput(f), root }, { exec: f.exec })
    expect(result).toMatchObject({ synced: true })
    assertStateCommit(f, result.state_commit!, parent, root)
    expect(f.git(f.workspace, "ls-tree", "-r", "--name-only", "HEAD", "--", `${root}/.light`)).toBe("")
    expect(f.git(f.workspace, "show", `HEAD:${root}/lock.yaml`)).toBe(previousLock.trim())
    expect(privateFiles.map(name => fs.readFileSync(join(f.workspace, root, ".light", name)))).toEqual(before)
    expect(f.git(f.workspace, "show", "--format=", "--name-only", result.state_commit!)).not.toMatch(/\/(?:lock\.yaml|\.lock)$/m)
    if (mode === "active") expect(callLock({ op: "release", runId: "light", mode: "delete" }, "corvus-review-light").ok).toBe(true)
  }))

  test("pushes only non-staging paths while leftover input and document staging stays local", () => withRepo(async f => {
    const leftovers = [`${ROOT}/.staging/input/manifest.json`, `${ROOT}/${f.head}/.staging/document/chunk.part`]
    for (const path of leftovers) f.write(f.workspace, path, "Unfinished staging\n")
    f.write(f.workspace, STATE, STATE_BYTES)
    const result = await push(pushInput(f), { exec: f.exec })
    expect(result).toEqual({ synced: true, state_commit: expect.stringMatching(sha), git_calls: f.calls.length })
    assertStateCommit(f, result.state_commit!, f.head)
    expect(f.git(f.workspace, "ls-tree", "-r", "--name-only", result.state_commit!, "--", ROOT)).toBe(STATE)
    expect(f.git(f.workspace, "diff", "--cached", "--name-only")).toBe("")
    for (const path of leftovers) expect(fs.readFileSync(join(f.workspace, path), "utf8")).toBe("Unfinished staging\n")
  }))

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

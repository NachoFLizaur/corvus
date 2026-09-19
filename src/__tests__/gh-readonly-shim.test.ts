import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkPluginLoaded } from "../../scripts/check-review-artifacts"
import { createPrExecutor, type PrExecResult, type PrInput } from "../review-pr"
import { push, resolve as resolveSync } from "../review-sync"

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

test.each([
  { intake: "url", crossRepo: false }, { intake: "branch", crossRepo: false }, { intake: "local", crossRepo: false },
  { intake: "url", crossRepo: true }, { intake: "branch", crossRepo: true },
] as const)("$intake harness seeds PR refs with crossRepo=$crossRepo; branch preflight uses the exact shim argv", async ({ intake, crossRepo }) => {
  const directory = mkdtempSync(join(tmpdir(), "corvus-harness-sync-"))
  directories.push(directory)
  const workspace = join(directory, "fixture"), bin = join(directory, "bin")
  mkdirSync(workspace)
  mkdirSync(bin)
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: workspace })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return result.stdout.toString().trim()
  }
  git("init", "-b", "main")
  writeFileSync(join(workspace, "README.md"), "Fixture\n")
  writeFileSync(join(workspace, ".gitignore"), ".corvus/\n")
  git("add", "README.md", ".gitignore")
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Product fixture")
  const head = git("rev-parse", "HEAD"), branch = intake === "local" ? "smoke/local-fixture" : "topic/pr8"
  if (!crossRepo) git("branch", branch)
  const source = join(directory, "source.git")
  git("clone", "--bare", workspace, source)
  git("--git-dir", source, "update-ref", "refs/pull/8/head", head)
  git("remote", "add", "origin", source)
  if (crossRepo) expect(Bun.spawnSync(["git", "--git-dir", source, "show-ref", "--verify", `refs/heads/${branch}`]).exitCode).not.toBe(0)
  const real = join(directory, "real-gh"), audit = join(directory, "gh-audit.log")
  writeFileSync(real, '#!/bin/bash\n[[ "$GH_REPO" == NachoFLizaur/corvus && "$(git config "branch.$BRANCH.remote")" == github && "$(git config "branch.$BRANCH.merge")" == refs/pull/8/head ]] || exit 2\nprintf \'{"number":%s,"headRefName":"%s","url":"https://github.com/NachoFLizaur/corvus/pull/8","state":"OPEN"}\\n\' "$FAKE_PR" "$BRANCH"\n')
  chmodSync(real, 0o700)
  writeFileSync(join(bin, "gh"), readFileSync(resolve(import.meta.dirname, "../../scripts/gh-readonly-shim.sh")))
  chmodSync(join(bin, "gh"), 0o700)
  const harness = readFileSync(resolve(import.meta.dirname, "../../scripts/smoke-review.sh"), "utf8")
  const helpers = harness.slice(harness.indexOf("die()"), harness.indexOf("usage()"))
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WORK: directory, SMOKE_WORK: directory, OWNER: "NachoFLizaur", REPO: "corvus", NUMBER: "8",
    BRANCH: branch, INTAKE: intake, GH_REPO: "NachoFLizaur/corvus", CORVUS_SMOKE_REAL_GH: real, CORVUS_SMOKE_GH_AUDIT: audit, CORVUS_SMOKE_GH_CANNED: "", FAKE_PR: "8" }
  const setup = Bun.spawnSync(["bash", "-c", `set -euo pipefail\n${helpers}\n[[ "$INTAKE" == local ]] || seed_pr_branch\nif [[ "$INTAKE" == url ]]; then git checkout --detach "$BRANCH"; else git checkout "$BRANCH"; fi\nprepare_sync_remotes\npreflight_branch_pr`], { cwd: workspace, env })
  expect(setup.exitCode, setup.stderr.toString()).toBe(0)
  expect(git("remote").split("\n")).toEqual(["github", "origin"])
  expect(git("remote", "get-url", "--push", "origin")).toBe(join(directory, "bare.git"))
  expect(git("remote", "get-url", "--push", "github")).toBe("DISABLED_PUSH_SENTINEL")
  expect(git("config", "user.email")).toBe("corvus-smoke@example.invalid")
  expect(readFileSync(join(directory, "bare-tip-before"), "utf8")).toBe(head + "\n")
  if (intake === "local") expect(git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")).toBe(`origin/${branch}`)
  if (intake === "branch") {
    expect(git("config", `branch.${branch}.remote`)).toBe("github")
    expect(git("config", `branch.${branch}.merge`)).toBe("refs/pull/8/head")
    expect(JSON.parse(readFileSync(audit, "utf8").trim()).argv).toEqual(["pr", "view", "--json", "number,url,headRefName,state"])
    const failed = Bun.spawnSync(["bash", "-c", `${helpers}\npreflight_branch_pr`], { cwd: workspace, env: { ...env, FAKE_PR: "9" } })
    expect(failed.exitCode).toBe(4)
    expect(failed.stderr.toString()).toContain("did not resolve PR #8")
  }
  const pr = intake === "local" ? { name: "corvus", number: null, branch } : { owner: "NachoFLizaur", name: "corvus", number: 8, isCrossRepository: crossRepo }
  const resolved = await resolveSync({ cwd: workspace, pr, changed_files: ["README.md"] })
  expect(resolved).toMatchObject({ ok: true, remote: "origin" })
  if (!resolved.ok) throw new Error(resolved.reason)
  if (intake === "url") git("checkout", "--detach", head)
  mkdirSync(join(workspace, resolved.root), { recursive: true })
  writeFileSync(join(workspace, resolved.root, "meta.yaml"), `code_head: ${head}\n`)
  git("config", "commit.gpgsign", "false")
  const synced = await push({ cwd: workspace, root: resolved.root, head_sha: head, branch, remote: resolved.remote, pr })
  if (crossRepo) {
    expect(synced).toEqual({ synced: false, reason: "fork", git_calls: 2 })
    expect(git("rev-parse", "HEAD")).toBe(head)
    expect(git("diff", "--cached", "--name-only")).toBe("")
  } else {
    expect(synced).toMatchObject({ synced: true })
    expect(git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe(`${resolved.root}/meta.yaml`)
  }
  expect(git("--git-dir", join(directory, "bare.git"), "rev-parse", branch)).toBe(crossRepo ? head : synced.state_commit!)
  expect(git("diff", "--name-only")).toBe(".gitignore")
})

test.each(["v1", "v2"] as const)("%s writer preflight resolves wildcard fallbacks and fails closed without the expected action", host => {
  const directory = mkdtempSync(join(tmpdir(), "corvus-harness-permissions-"))
  directories.push(directory)
  const agents = join(directory, "agents.json"), install = join(directory, "install/node_modules/corvus-ai")
  const harness = readFileSync(resolve(import.meta.dirname, "../../scripts/smoke-review.sh"), "utf8")
  const preflight = /bun -e '(\n  const data = await Bun\.file[\s\S]*?)\n' \|\| die 6 'posting barrier not installed; model was not started'/.exec(harness)?.[1]
  if (!preflight?.trim()) throw new Error("Writer preflight snippet not found")
  const env = { ...process.env, SMOKE_WORK: directory, SMOKE_HOST: host, SMOKE_ROOT: resolve(import.meta.dirname, "../..") }
  for (const script of ["smoke-writer.sh", "smoke-review.sh"]) {
    const source = readFileSync(resolve(import.meta.dirname, "../../scripts", script), "utf8")
    const exposure = /# Exposure invariant:[\s\S]*?\n\s*bun -e '([\s\S]+?)\n\s*' \|\| die 6 'writer tool exposure failed; model was not started'/.exec(source)?.[1]
    if (!exposure?.trim()) throw new Error(`${script}: writer exposure snippet not found`)
    for (const tools of [{ corvus_review_pr: true, corvus_review_post: true }, { corvus_review_pr: true }, { corvus_review_post: true }, {}]) {
      const fixture = JSON.stringify({ name: "pr-comment-writer", tools })
      writeFileSync(agents, fixture)
      writeFileSync(join(directory, "writer-agent.json"), fixture)
      const result = Bun.spawnSync([process.execPath, "-e", exposure], { env })
      expect(result.exitCode, `${script}: ${result.stderr}`).toBe(tools.corvus_review_pr && tools.corvus_review_post ? 0 : 1)
    }
  }
  type Action = "allow" | "deny" | "ask"
  const rule = (permission: string, pattern: string, action: Action) => ({ permission, pattern, action })
  const cases: Array<[string, ReturnType<typeof rule>[] | undefined, Action | undefined]> = [
    ["global wildcard fallback", [rule("*", "*", "allow"), rule("question", "*", "deny")], "allow"],
    ["last global wildcard", [rule("*", "*", "allow"), rule("*", "*", "deny")], "deny"],
    ["task wildcard fallback", [rule("*", "*", "deny"), rule("task", "*", "allow"), rule("read", "pr-comment-writer", "deny")], "allow"],
    ["last task wildcard", [rule("task", "*", "allow"), rule("task", "*", "deny"), rule("*", "*", "allow")], "deny"],
    ["explicit deny overrides wildcards", [rule("task", "pr-comment-writer", "deny"), rule("task", "*", "allow"), rule("*", "*", "allow")], "deny"],
    ["last explicit writer rule", [rule("task", "pr-comment-writer", "deny"), rule("task", "pr-comment-writer", "allow"), rule("task", "*", "deny"), rule("*", "*", "deny")], "allow"],
    ["explicit ask does not fall through", [rule("*", "*", "allow"), rule("task", "pr-comment-writer", "ask")], "ask"],
    ["unrelated rules", [rule("task", "researcher", "allow"), rule("read", "pr-comment-writer", "allow")], undefined],
    ["missing rules", undefined, undefined],
    ["empty rules", [], undefined],
  ]
  for (const [name, rules, action] of cases) {
    const permission = rules && [...rules, rule("external_directory", `${install}/*`, "allow"),
      rule("corvus_review_payload", "*", "allow"), rule("corvus_review_post", "*", "allow")]
    const agent = {
      name: "corvus-review-auto", native: false, prompt: "# Corvus Review Auto\n",
      tools: { corvus_review_payload: true, corvus_review_post: true, corvus_review_persist: true,
        corvus_review_lock: true, corvus_review_pr: true, corvus_review_verdict: true, corvus_review_sync: true },
      permission,
    }
    writeFileSync(agents, JSON.stringify(host === "v1" ? agent : [{ id: agent.name,
      permissions: permission?.map(({ permission, pattern, action }) => ({
        action: permission === "task" ? "subagent" : permission, resource: pattern, effect: action,
      })),
    }]))
    for (const writer of [false, true]) {
      const allowed = action === (writer ? "allow" : "deny")
      const result = Bun.spawnSync([process.execPath, "-e", preflight], {
        env: { ...env, SMOKE_WRITER: writer ? "1" : "0" },
      })
      expect(result.exitCode, `${name}, writer=${writer}: ${result.stderr}`).toBe(allowed ? 0 : 1)
      if (host === "v1") {
        const loaded = checkPluginLoaded({ host, agents, install, writer, hostlog: join(directory, "host.log") })
        expect(loaded.ok, `${name}, writer=${writer}: ${loaded.detail}`).toBe(allowed)
      }
    }
  }
})

test("gh decision table forwards only reads, with one unforgeable argv audit record per call", () => {
  const directory = mkdtempSync(join(tmpdir(), "corvus-gh-shim-"))
  directories.push(directory)
  const fake = join(directory, "gh")
  const forwarded = join(directory, "forwarded")
  const audit = join(directory, "audit")
  writeFileSync(fake, '#!/bin/bash\nprintf "forwarded\\n" >> "$FAKE_GH_FORWARDED"\n')
  chmodSync(fake, 0o700)
  const cases: Array<[string[], boolean]> = [
    [["repo", "view", "o/r"], true], [["repo", "clone", "o/r", "fixture"], true],
    ...["view", "diff", "checks"].map(command => [["pr", command, "8"], true] as [string[], boolean]),
    ...[
      ["pr", "view", "8", "--json", "headRefName"],
      ["pr", "view", "--json", "number,url,headRefName,state"],
      ["pr", "list", "--head", "smoke/local-fixture", "--state", "all", "--json", "number", "--limit", "5"],
    ].flatMap(argv => [[argv, true] as [string[], boolean], [[...argv, "--method", "POST"], false] as [string[], boolean]]),
    [["pr", "list", "--repo", "o/r", "--state", "open", "--json", "number,title,files"], true],
    [["pr", "view", "--json", "number,url,headRefName,state"], true],
    [["pr", "list", "--head", "topic/B", "--state", "all", "--json", "number,url,state,headRefName", "--limit", "5"], true],
    [["issue", "view", "8", "--repo", "o/r", "--json", "number,title,body"], true],
    [["issue", "view", "8", "--repo", "o/r", "--json=body"], true],
    [["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], true],
    ...[
      ["pr", "view", "8"], ["pr", "diff", "8"], ["pr", "checks", "8"], ["pr", "list"], ["pr", "status"],
      ["issue", "view", "8"], ["issue", "list"], ["repo", "view", "o/r"],
      ["api", "--method", "GET", "repos/o/r"], ["api", "user", "--jq", ".login"],
      ["search", "code", "query"], ["run", "list"], ["run", "view", "8", "--log"], ["auth", "status"],
      ["api", "repos/o/r/pulls/8/reviews", "--jq", ".[].id"],
      ["api", "--paginate", "repos/o/r/pulls/8/reviews", "--jq", ".[].id"],
      ["api", "repos/o/r/pulls/8/comments", "--jq", ".[].id"],
      ["api", "repos/o/r/compare/a...b", "--jq", ".files"],
      ["api", "repos/o/r/pulls/8"], ["api", "repos/o/r/pulls/8/files"],
      ["api", "--paginate", "repos/o/r/pulls/8/files"], ["api", "repos/o/r/commits/a"],
      ["api", "repos/o/r/compare/a...b"], ["api", "repos/o/r/contents/src/index.ts"], ["api", "repos/o/r/issues/8"],
    ].flatMap(argv => [
      [argv, true] as [string[], boolean],
      ...[["--method", "POST"], ["--method=PATCH"], ["-X", "PUT"], ["-XDELETE"],
        ["--input", "payload.json"], ["--input=payload.json"], ["-f", "body=x"], ["-Fbody=x"]]
        .map(flags => [[...argv, ...flags], false] as [string[], boolean]),
    ]),
    [["issue", "comment", "8", "--body", "no"], false],
    [["pr", "checkout", "8", "--detach"], true], [["auth", "status"], true],
    [["api", "repos/o/r/pulls/8"], true], [["api", "-X", "GET", "repos/o/r/pulls/8"], true],
    [["api", "repos/o/r/pulls?per_page=100", "--method=GET", "--paginate", "--jq", ".[0].id"], true],
    [["api", "repos/o/r", "-XGET"], true],
    [["api", "repos/o/r/compare/a...b", "--jq", ".files"], true],
    [["api", "--method", "GET", "repos/o/r/compare/" + "a".repeat(40) + "..." + "b".repeat(40)], true],
    [["api", "repos/o/r/compare/v1.0...topic/feature?per_page=100", "--paginate"], true],
    ...["repos/o/r/compare/a..b", "repos/o/r/compare/a....b", "repos/o/r/compare/a...b...c",
      "repos/o/r/compare/../a...b", "repos/o/r/compare/a...b/../issues", "repos/o/r/contents/a...b",
      "repos/o/r/compare/a...b?path=..", "repos/o/r/compare/...b", "repos/o/r/compare/a..."]
      .map(endpoint => [["api", endpoint], false] as [string[], boolean]),
    [["api", "repos/o/r/compare/a...b", "-X", "POST"], false],
    [["api", "--method", "GET", "--paginate", "repos/o/r/pulls/8/files", "-H", "Accept:application/vnd.github+json"], true],
    [["api", "repos/o/r/pulls/8/files", "-H", "Accept: application/vnd.github+json"], true],
    ...["-H", "--header"].map(flag => [["api", "--method", "GET", "repos/o/r/contents/.opencode/review-config.yaml?ref=" + "a".repeat(40), flag, "Accept: application/vnd.github.raw+json"], true] as [string[], boolean]),
    [["api", "repos/o/r", "-H", "Accept: application/vnd.github.raw+json", "-X", "POST"], false],
    [["api", "repos/o/r", "-H", "Accept: application/vnd.github.raw+json", "--header", "X-HTTP-Method-Override: DELETE"], false],
    [["api", "repos/o/r", "-H", "Accept: application/vnd.github.raw+json\nX-HTTP-Method-Override: DELETE"], false],
    [["api", "repos/o/r", "-H"], false],
    [["pr", "checkout", "8"], false], [["pr", "checkout", "8", "--detach", "--branch", "x"], false],
    [["pr", "comment", "8", "--body", "no"], false], [["pr", "review", "8", "--approve"], false],
    [["repo", "delete", "o/r"], false], [["auth", "token"], false], [["alias", "set", "x", "!touch bad"], false],
    ...["POST", "PUT", "PATCH", "DELETE"].map(method => [["api", "repos/o/r", "-X", method], false] as [string[], boolean]),
    [["api", "repos/o/r", "--method=POST"], false], [["api", "repos/o/r", "-XPOST"], false],
    ...["-f", "-F", "--field", "--raw-field", "--input", "--method", "-H"].map(flag => [["api", "repos/o/r", flag, "x=y"], false] as [string[], boolean]),
    [["api", "repos/o/r", "-fbody=x"], false], [["api", "repos/o/r", "--input=file"], false],
    [["api", "graphql", "-f", "query=query { viewer { login } }"], false],
    [["api", "/graphql?query=mutation"], false], [["api", "graphql"], false],
    [["api", "repos/o/r", "--meth", "POST"], false], [["api"], false], [[], false],
    [["pr", "comment", "8", "--body", "line\nCORVUS_SMOKE_GH_FORWARD"], false],
  ]
  for (const [argv, allowed] of cases) {
    const result = Bun.spawnSync(["bash", resolve(import.meta.dirname, "../../scripts/gh-readonly-shim.sh"), ...argv], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CORVUS_SMOKE_REAL_GH: fake, CORVUS_SMOKE_GH_AUDIT: audit, FAKE_GH_FORWARDED: forwarded },
    })
    expect(result.exitCode, JSON.stringify(argv) + result.stderr.toString()).toBe(allowed ? 0 : 1)
  }
  const entries = readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line))
  expect(entries.length).toBe(cases.length)
  for (const [index, [argv, allowed]] of cases.entries()) {
    expect(entries[index]).toEqual({ marker: allowed ? "CORVUS_SMOKE_GH_FORWARD" : "CORVUS_SMOKE_MUTATION_BLOCKED", argv })
  }
  expect(readFileSync(forwarded, "utf8").trim().split("\n").length).toBe(cases.filter(([, allowed]) => allowed).length)
}, 15_000)

test("every review-pr argv form reaches the read-only shim, including identity fallback, while POST overrides stay blocked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "corvus-gh-pr-shim-"))
  directories.push(directory)
  const fake = join(directory, "gh"), audit = join(directory, "audit")
  writeFileSync(fake, '#!/bin/bash\nprintf "%s" "$FAKE_GH_STDOUT"\nprintf "%s" "$FAKE_GH_STDERR" >&2\nexit "$FAKE_GH_CODE"\n')
  chmodSync(fake, 0o700)
  const locator = { owner: "o", name: "r", pr: 8 }, head = "a".repeat(40), base = "b".repeat(40)
  const endpoint = "repos/o/r/pulls/8", accept = ["-H", "Accept: application/vnd.github+json"]
  const metadataFields = "number,url,title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,labels,reviewRequests,isDraft,mergeable,state,mergedAt,additions,deletions,changedFiles,files,closingIssuesReferences,latestReviews,reviewDecision,isCrossRepository"
  const success = (value: unknown): PrExecResult => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" })
  const commitsArgv = ["api", "--method", "GET", "--paginate", `${endpoint}/commits`, ...accept]
  const commits = success([{ sha: head, commit: { message: "Product change" } }])
  const cases: Array<{ input: PrInput; argv: string[][]; replies: PrExecResult[] }> = [
    { input: { op: "find" }, argv: [["pr", "view", "--json", "number,url,headRefName,state"]],
      replies: [success({ number: 1, url: "https://github.com/o/r/pull/1", state: "OPEN", headRefName: "topic/A" })] },
    { input: { op: "find", branch: "topic/B" }, argv: [["pr", "list", "--head", "topic/B", "--state", "all", "--json", "number,url,state,headRefName", "--limit", "5"]],
      replies: [success([{ number: 2, url: "https://github.com/o/r/pull/2", state: "OPEN", headRefName: "topic/B" }])] },
    { input: { op: "repo" }, argv: [["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]], replies: [success("o/r\n")] },
    { input: { op: "metadata", ...locator }, argv: [["pr", "view", "8", "--repo", "o/r", "--json", metadataFields], commitsArgv], replies: [success({
      number: 8, url: "https://github.com/o/r/pull/8", title: "Fixture", body: "", author: { login: "alice" }, baseRefName: "main", baseRefOid: base,
      headRefName: "feature", headRefOid: head, labels: [], reviewRequests: [], isDraft: false, mergeable: "MERGEABLE", state: "OPEN", changedFiles: 1,
      closingIssuesReferences: [], latestReviews: [], reviewDecision: null, isCrossRepository: false,
    }), commits] },
    { input: { op: "head", ...locator }, argv: [["api", "--method", "GET", endpoint, ...accept], commitsArgv], replies: [success({ head: { sha: head }, base: { sha: base } }), commits] },
    { input: { op: "files", ...locator, paginate: true }, argv: [["api", "--method", "GET", "--paginate", `${endpoint}/files`, ...accept]], replies: [success([])] },
    { input: { op: "diff", ...locator }, argv: [["api", "--method", "GET", endpoint, "-H", "Accept: application/vnd.github.v3.diff"]], replies: [success("diff --git a/x b/x\n")] },
    { input: { op: "reviews", ...locator }, argv: ["reviews", "comments"].map(name => ["api", "--method", "GET", "--paginate", `${endpoint}/${name}`, ...accept]), replies: [success([]), success([])] },
    { input: { op: "checks", ...locator }, argv: [["pr", "checks", "8", "--repo", "o/r", "--json", "name,state,link"]], replies: [success([])] },
    { input: { op: "identity" }, argv: [["api", "user", "--jq", ".login"]], replies: [success("alice\n")] },
    { input: { op: "identity" }, argv: [["api", "user", "--jq", ".login"], ["auth", "status"]], replies: [
      { code: 1, stdout: "", stderr: "HTTP 403" }, success("github.com\n  ✓ Logged in to github.com account alice (keyring)\n  - Active account: true\n"),
    ] },
    { input: { op: "config", owner: "o", name: "r", ref: base }, argv: [["api", "--method", "GET", `repos/o/r/contents/.opencode/review-config.yaml?ref=${base}`, "-H", "Accept: application/vnd.github.raw+json"]], replies: [success("max_nits: 3\n")] },
  ]
  const run = (argv: string[], reply: PrExecResult) => {
    const result = Bun.spawnSync(["bash", resolve(import.meta.dirname, "../../scripts/gh-readonly-shim.sh"), ...argv], {
      env: { ...process.env, CORVUS_SMOKE_REAL_GH: fake, CORVUS_SMOKE_GH_AUDIT: audit, CORVUS_SMOKE_GH_CANNED: "",
        FAKE_GH_STDOUT: reply.stdout, FAKE_GH_STDERR: reply.stderr, FAKE_GH_CODE: String(reply.code) },
    })
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }
  const reads: string[][] = []
  for (const item of cases) {
    const observed: string[][] = []
    const execute = createPrExecutor({ exec: async argv => {
      expect(argv[0]).toBe("gh")
      const reply = item.replies[observed.length]
      observed.push(argv.slice(1))
      const result = run(argv.slice(1), reply)
      expect(result).toEqual(reply)
      return result
    } })
    expect(JSON.parse(await execute(item.input)), item.input.op).toMatchObject({ ok: true })
    expect(observed).toEqual(item.argv)
    reads.push(...observed)
  }
  const blocked: string[][] = []
  for (const argv of reads.filter(argv => argv[0] === "api")) for (const override of [["--method", "POST"], ["-XPOST"], ["--method=POST"], ["--input", "post-request.json"]]) {
    const args = [...argv, ...override]
    const result = run(args, success("must not forward"))
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toStartWith("CORVUS_SMOKE_MUTATION_BLOCKED")
    blocked.push(args)
  }
  expect(readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
    ...reads.map(argv => ({ marker: "CORVUS_SMOKE_GH_FORWARD", argv })),
    ...blocked.map(argv => ({ marker: "CORVUS_SMOKE_MUTATION_BLOCKED", argv })),
  ])
})

test("canned mode serves only the writer/R5 PR reads from fixtures, never forwards, and keeps mutations blocked", () => {
  const directory = mkdtempSync(join(tmpdir(), "corvus-gh-shim-canned-"))
  directories.push(directory)
  const fake = join(directory, "gh")
  const forwarded = join(directory, "forwarded")
  const audit = join(directory, "audit")
  const canned = join(directory, "canned")
  mkdirSync(canned)
  writeFileSync(fake, '#!/bin/bash\nprintf "forwarded\\n" >> "$FAKE_GH_FORWARDED"\n')
  chmodSync(fake, 0o700)
  const head = "a".repeat(40)
  writeFileSync(join(canned, "pull.json"), JSON.stringify({ number: 1, head: { sha: head, ref: "x" } }) + "\n")
  writeFileSync(join(canned, "pull.diff"), "diff --git a/README.md b/README.md\n@@ -1,3 +1,3 @@\n # Smoke\n-old\n+new\n third\n")
  writeFileSync(join(canned, "files.json"), JSON.stringify([{ filename: "README.md", patch: "@@ -1,3 +1,3 @@" }]) + "\n")
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(["bash", resolve(import.meta.dirname, "../../scripts/gh-readonly-shim.sh"), ...argv], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CORVUS_SMOKE_REAL_GH: fake, CORVUS_SMOKE_GH_AUDIT: audit, CORVUS_SMOKE_GH_CANNED: canned, FAKE_GH_FORWARDED: forwarded },
    })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }
  const cases: Array<[string[], number, string | RegExp, string]> = [
    [["api", "--method", "GET", "repos/o/r/pulls/1", "-H", "Accept:application/vnd.github+json", "--jq", ".head.sha"], 0, head + "\n", "CORVUS_SMOKE_GH_CANNED"],
    [["api", "--method", "GET", "repos/o/r/pulls/1", "-H", "Accept:application/vnd.github.v3.diff"], 0, /^diff --git a\/README\.md b\/README\.md\n/, "CORVUS_SMOKE_GH_CANNED"],
    [["api", "--method", "GET", "--paginate", "repos/o/r/pulls/1/files", "-H", "Accept:application/vnd.github+json"], 0, /^\[\{"filename":"README\.md"/, "CORVUS_SMOKE_GH_CANNED"],
    [["api", "repos/o/r/pulls/1", "--jq", ".number"], 0, "1\n", "CORVUS_SMOKE_GH_CANNED"],
    [["api", "repos/o/r/pulls/1", "--jq", ".missing.key"], 0, "null\n", "CORVUS_SMOKE_GH_CANNED"],
    // Fixture absent (reviews.json not written) or unsupported jq filter: fail closed, no forward.
    [["api", "repos/o/r/pulls/1/reviews", "--paginate"], 1, "", "CORVUS_SMOKE_GH_CANNED"],
    [["api", "repos/o/r/pulls/1", "--jq", "[.[] | {body}]"], 1, "", "CORVUS_SMOKE_GH_CANNED"],
    // Admitted reads outside the fixture table never reach the network in canned mode.
    [["pr", "view", "1"], 1, "", "CORVUS_SMOKE_GH_CANNED"],
    [["api", "repos/o/r"], 1, "", "CORVUS_SMOKE_GH_CANNED"],
    // Mutations stay blocked by admission, exactly as without canned mode.
    [["api", "--method", "POST", "repos/o/r/pulls/1/reviews", "--input", ".corvus/reviews/o__r__pr1/post-request.json"], 1, "", "CORVUS_SMOKE_MUTATION_BLOCKED"],
    [["pr", "review", "1", "--approve"], 1, "", "CORVUS_SMOKE_MUTATION_BLOCKED"],
  ]
  for (const [argv, code, stdout, marker] of cases) {
    const result = run(argv)
    expect(result.code, JSON.stringify(argv) + result.err).toBe(code)
    if (typeof stdout === "string") expect(result.out).toBe(stdout)
    else expect(result.out).toMatch(stdout)
    if (code === 1) expect(result.err).toMatch(marker === "CORVUS_SMOKE_MUTATION_BLOCKED" ? /^CORVUS_SMOKE_MUTATION_BLOCKED / : /^CORVUS_SMOKE_CANNED_(?:MISSING|UNSUPPORTED_JQ) /)
  }
  const entries = readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line))
  expect(entries.map(entry => entry.marker)).toEqual(cases.map(([, , , marker]) => marker))
  expect(entries.slice(0, 3).map(entry => entry.fixture)).toEqual(["pull.json", "pull.diff", "files.json"])
  expect(entries[5].fixture).toBe("missing")
  expect(existsSync(forwarded)).toBe(false)
})

test("head-moved canned mode serves pull.json once, then pull.moved.json to every later metadata read, without touching the diff or admission", () => {
  const directory = mkdtempSync(join(tmpdir(), "corvus-gh-shim-moved-"))
  directories.push(directory)
  const fake = join(directory, "gh")
  const forwarded = join(directory, "forwarded")
  const audit = join(directory, "audit")
  const canned = join(directory, "canned")
  mkdirSync(canned)
  writeFileSync(fake, '#!/bin/bash\nprintf "forwarded\\n" >> "$FAKE_GH_FORWARDED"\n')
  chmodSync(fake, 0o700)
  const head = "a".repeat(40), moved = "c".repeat(40)
  writeFileSync(join(canned, "pull.json"), JSON.stringify({ number: 1, head: { sha: head, ref: "x" } }) + "\n")
  writeFileSync(join(canned, "pull.moved.json"), JSON.stringify({ number: 1, head: { sha: moved, ref: "x" } }) + "\n")
  writeFileSync(join(canned, "pull.diff"), "diff --git a/README.md b/README.md\n@@ -1,3 +1,3 @@\n # Smoke\n-old\n+new\n third\n")
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(["bash", resolve(import.meta.dirname, "../../scripts/gh-readonly-shim.sh"), ...argv], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CORVUS_SMOKE_REAL_GH: fake, CORVUS_SMOKE_GH_AUDIT: audit, CORVUS_SMOKE_GH_CANNED: canned, FAKE_GH_FORWARDED: forwarded },
    })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }
  const writerHead = ["api", "--method", "GET", "repos/o/r/pulls/1", "-H", "Accept:application/vnd.github+json", "--jq", ".head.sha"]
  const toolHead = ["api", "--method", "GET", "repos/o/r/pulls/1", "-H", "Accept: application/vnd.github+json", "--jq", ".head.sha"]
  const diff = ["api", "--method", "GET", "repos/o/r/pulls/1", "-H", "Accept:application/vnd.github.v3.diff"]
  // Writer head check passes on the original sha; the diff read does not consume a metadata read; the tool's recheck sees the moved head, as does anything after it.
  expect(run(writerHead)).toMatchObject({ code: 0, out: head + "\n" })
  expect(run(diff).out).toMatch(/^diff --git/)
  expect(run(toolHead)).toMatchObject({ code: 0, out: moved + "\n" })
  expect(run(writerHead)).toMatchObject({ code: 0, out: moved + "\n" })
  expect(readFileSync(join(canned, ".pull-reads"), "utf8")).toBe("3\n")
  // Mutations stay blocked and are never counted as reads.
  const post = run(["api", "--method", "POST", "repos/o/r/pulls/1/reviews", "--input", "x.json"])
  expect(post.code).toBe(1)
  expect(post.err).toMatch(/^CORVUS_SMOKE_MUTATION_BLOCKED /)
  expect(readFileSync(join(canned, ".pull-reads"), "utf8")).toBe("3\n")
  const entries = readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line))
  expect(entries.map(entry => [entry.marker, entry.fixture])).toEqual([
    ["CORVUS_SMOKE_GH_CANNED", "pull.json"], ["CORVUS_SMOKE_GH_CANNED", "pull.diff"], ["CORVUS_SMOKE_GH_CANNED", "pull.moved.json"],
    ["CORVUS_SMOKE_GH_CANNED", "pull.moved.json"], ["CORVUS_SMOKE_MUTATION_BLOCKED", undefined],
  ])
  expect(existsSync(forwarded)).toBe(false)
  // Without pull.moved.json the counter never engages: repeated reads keep serving pull.json (default canned mode is unchanged).
  rmSync(join(canned, "pull.moved.json"))
  rmSync(join(canned, ".pull-reads"))
  expect(run(writerHead).out).toBe(head + "\n")
  expect(run(toolHead).out).toBe(head + "\n")
  expect(existsSync(join(canned, ".pull-reads"))).toBe(false)
})

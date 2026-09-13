import { describe, expect, test } from "bun:test"
import {
  checks, config, createPrExecutor, diff, files, find, head, identity, local, metadata, repo, reviews,
  type PrExec, type PrExecResult,
} from "../review-pr"

const HEAD_SHA = "a".repeat(40)
const BASE_SHA = "b".repeat(40)
const BODY = "PR_BODY_MUST_NOT_APPEAR_IN_DIAGNOSTICS"
const locator = { owner: "example", name: "project", pr: 42 }
const endpoint = "repos/example/project/pulls/42"
const REVIEW_URL = "https://github.com/example/project/pull/42#pullrequestreview-123"
const THREAD_URL = "https://github.com/example/project/pull/42#discussion_r456"
const MARKER = `<!-- corvus-review v1 head:${HEAD_SHA} -->`
const success = (stdout: string): PrExecResult => ({ code: 0, stdout, stderr: "" })
const forbidden: PrExecResult = { code: 1, stdout: BODY, stderr: `gh: Forbidden (HTTP 403)\n${BODY}` }
const commits = success(JSON.stringify([{ sha: HEAD_SHA, commit: { message: "Product change" } }]))
const commitsArgv = ["gh", "api", "--method", "GET", "--paginate", `${endpoint}/commits`, "-H", "Accept: application/vnd.github+json"]

function recordingExec(...responses: Array<PrExecResult | Promise<PrExecResult>>) {
  const calls: string[][] = []
  const exec: PrExec = async argv => {
    const response = responses[calls.length]
    calls.push([...argv])
    if (!response) throw new Error("Unexpected exec call")
    return response
  }
  return { calls, exec }
}

describe("review PR metadata, head and files", () => {
  test("uses the exact metadata argv and preserves untrusted PR source evidence", async () => {
    const data = {
      number: 42, url: "https://github.com/example/project/pull/42", title: "A change", state: "OPEN",
      isDraft: false, isCrossRepository: false, mergeable: "MERGEABLE", author: { login: "contributor" },
      baseRefName: "main", baseRefOid: BASE_SHA, headRefName: "feature", headRefOid: HEAD_SHA, changedFiles: 2,
      body: `${BODY}\n\n## Description\nKeep this text as-is.`,
      labels: [{ id: "L_1", name: "breaking-change", description: BODY, color: "ff0000" }],
      closingIssuesReferences: [{ number: 7, url: "https://github.com/example/project/issues/7", title: BODY }],
      latestReviews: [{ author: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: BODY, submittedAt: "2020-01-02T12:00:00Z" }],
      reviewDecision: "CHANGES_REQUESTED",
    }
    const { exec, calls } = recordingExec(success(JSON.stringify({ ...data, files: [{ body: BODY }] })), commits)
    const result = await metadata(locator, { exec })
    expect(result).toEqual({ ok: true, ...data, head_sha: HEAD_SHA, code_head: HEAD_SHA, api_calls: 2 })
    expect(calls).toEqual([[
      "gh", "pr", "view", "42", "--repo", "example/project", "--json",
      "number,url,title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,labels,reviewRequests,isDraft,mergeable,state,mergedAt,additions,deletions,changedFiles,files,closingIssuesReferences,latestReviews,reviewDecision,isCrossRepository",
    ], commitsArgv])
    expect(result).not.toHaveProperty("files")
  })

  test("reads head and base SHAs with the exact GET argv", async () => {
    const { exec, calls } = recordingExec(success(JSON.stringify({ head: { sha: HEAD_SHA.toUpperCase() }, base: { sha: BASE_SHA }, body: BODY })), commits)
    expect(await head(locator, { exec })).toEqual({ ok: true, head_sha: HEAD_SHA, code_head: HEAD_SHA, base_sha: BASE_SHA, api_calls: 2 })
    expect(calls).toEqual([["gh", "api", "--method", "GET", endpoint, "-H", "Accept: application/vnd.github+json"], commitsArgv])
  })

  test("reads concatenated file pages with explicit patch availability and counts observed pages", async () => {
    const patched = { filename: "src/example.ts", status: "modified", additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-[old]\n+"new"' }
    const binary = { filename: "image.png", status: "added", additions: 0, deletions: 0 }
    const { exec, calls } = recordingExec(success(`${JSON.stringify([patched])}\n${JSON.stringify([binary])}\n`))
    expect(await files({ ...locator, paginate: true }, { exec })).toEqual({
      ok: true, files: [{ ...patched, has_patch: true }, { ...binary, has_patch: false }], complete_pagination: true, excluded_corvus: 0, api_calls: 2,
    })
    expect(calls).toEqual([["gh", "api", "--method", "GET", "--paginate", `${endpoint}/files`, "-H", "Accept: application/vnd.github+json"]])
  })

  test("retains a validated file page but marks a failed next page incomplete and counts the failure", async () => {
    const file = { filename: "src/example.ts", status: "modified", additions: 1, deletions: 0 }
    const { exec, calls } = recordingExec({ ...forbidden, stdout: JSON.stringify([file]) })
    expect(await files({ ...locator, paginate: true }, { exec })).toEqual({
      ok: false, reason: "forbidden", http_status: 403, files: [{ ...file, has_patch: false }], complete_pagination: false, excluded_corvus: 0, api_calls: 2,
    })
    expect(calls).toHaveLength(1)
  })
})

describe("review repository resolution", () => {
  const ghArgv = ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]
  const gitArgv = ["git", "remote", "get-url", "origin"]

  test("resolves gh owner/name without reading origin and uses the host cwd", async () => {
    const calls: Array<{ argv: string[]; cwd?: string }> = []
    const execute = createPrExecutor({ cwd: "/session", exec: async (argv, options) => {
      calls.push({ argv, cwd: options?.cwd })
      return success("example/project\n")
    } })
    expect(JSON.parse(await execute({ op: "repo" }))).toEqual({ ok: true, owner: "example", name: "project", source: "gh", api_calls: 1 })
    expect(calls).toEqual([{ argv: ghArgv, cwd: "/session" }])
  })

  test.each(["git@github.com:example/project.git", "ssh://git@github.com/example/project.git", "https://github.com/example/project.git"])(
    "falls back from gh to origin %s", async remote => {
      const { exec, calls } = recordingExec(forbidden, success(remote + "\n"))
      expect(await repo({}, { exec })).toEqual({ ok: true, owner: "example", name: "project", source: "git-remote", api_calls: 1 })
      expect(calls).toEqual([ghArgv, gitArgv])
    },
  )

  test("reports no-repository when neither source resolves", async () => {
    const { exec, calls } = recordingExec(forbidden, { code: 2, stdout: "", stderr: "No such remote 'origin'" })
    expect(await repo({}, { exec })).toEqual({ ok: false, reason: "no-repository", api_calls: 1 })
    expect(calls).toEqual([ghArgv, gitArgv])
  })

  test("uses the same explicit cwd for both commands after a spawn failure", async () => {
    const calls: Array<{ argv: string[]; cwd?: string }> = []
    const exec: PrExec = async (argv, options) => {
      calls.push({ argv, cwd: options?.cwd })
      if (argv[0] === "gh") throw new Error("ENOENT")
      return success("https://github.com/example/project")
    }
    expect(await repo({ cwd: "other worktree" }, { exec, cwd: "/session" })).toMatchObject({ ok: true, source: "git-remote" })
    expect(calls).toEqual([ghArgv, gitArgv].map(argv => ({ argv, cwd: "/session/other worktree" })))
  })

  test("rejects invalid controls before exec and never accepts malformed or other-host identities", async () => {
    const unused = recordingExec()
    for (const input of [{ op: "repo", cwd: "" }, { op: "repo", cwd: "bad\0path" }, { op: "repo", owner: "example" }]) {
      expect(JSON.parse(await createPrExecutor({ exec: unused.exec })(input))).toMatchObject({ ok: false, api_calls: 0 })
    }
    expect(unused.calls).toEqual([])
    for (const remote of ["https://gitlab.com/example/project.git", "git@github.com:example/../project", "https://github.com/example/project.git\nextra", "https://github.com/example/..", "https://github.com/example/project?x=1"]) {
      const { exec } = recordingExec(success("bad/owner/name"), success(remote))
      expect(await repo({}, { exec })).toEqual({ ok: false, reason: "no-repository", api_calls: 1 })
    }
  })
})

describe("review PR diff", () => {
  test("returns a successful diff as text with the exact diff media type argv", async () => {
    const text = "diff --git a/file b/file\n-old\n+new\n"
    const { exec, calls } = recordingExec(success(text))
    expect(await diff(locator, { exec })).toEqual({ ok: true, oversized: false, text, excluded_corvus: 0, api_calls: 1 })
    expect(calls).toEqual([["gh", "api", "--method", "GET", endpoint, "-H", "Accept: application/vnd.github.v3.diff"]])
  })

  for (const http_status of [406, 413]) {
    test(`returns HTTP ${http_status} as oversized without text or raw diagnostics`, async () => {
      const { exec, calls } = recordingExec({ code: 1, stdout: BODY, stderr: `gh: diff unavailable (HTTP ${http_status})\n${BODY}` })
      const result = await diff(locator, { exec })
      expect(result).toEqual({ ok: true, oversized: true, http_status, api_calls: 1 })
      expect(JSON.stringify(result)).not.toContain(BODY)
      expect(calls).toEqual([["gh", "api", "--method", "GET", endpoint, "-H", "Accept: application/vnd.github.v3.diff"]])
    })
  }
})

describe("review PR reviews and threads", () => {
  test("joins paginated review and comment bodies unchanged with locations, reply links and unknown dispositions", async () => {
    const review = {
      id: 123, user: { login: "reviewer" }, state: "COMMENTED", commit_id: HEAD_SHA,
      submitted_at: "2020-01-02T12:00:00Z", html_url: REVIEW_URL, body: `${MARKER}\n${BODY}`,
    }
    const root = {
      id: 456, pull_request_review_id: 123, html_url: THREAD_URL, path: "src/example.ts",
      line: 10, original_line: 8, user: { login: "reviewer" }, commit_id: HEAD_SHA, original_commit_id: BASE_SHA,
      body: `logic-spec-001 ${BODY}\n\n\`\`\`suggestion\nreturn value\n\`\`\``,
    }
    const reply = { ...root, id: 457, in_reply_to_id: 456, user: { login: "contributor" }, body: BODY, html_url: `${THREAD_URL}-reply`, line: null }
    const { exec, calls } = recordingExec(
      success(`${JSON.stringify([review])}\n[]\n`),
      success(`${JSON.stringify([reply])}\n${JSON.stringify([root])}\n`),
    )
    const result = await reviews(locator, { exec })
    const projectedRoot = {
      id: 456, pull_request_review_id: 123, in_reply_to_id: null, html_url: THREAD_URL, path: "src/example.ts",
      line: 10, original_line: 8, user: "reviewer", commit_id: HEAD_SHA, original_commit_id: BASE_SHA,
      finding_id: "logic-spec-001", axis: "spec", dimension: "correctness",
      body: root.body,
    } as const
    expect(result).toEqual({
      ok: true,
      reviews: [{ id: 123, user: "reviewer", state: "COMMENTED", commit_id: HEAD_SHA, submitted_at: review.submitted_at, html_url: REVIEW_URL, body: review.body, body_marker: MARKER }],
      threads: [{ root: projectedRoot, replies: [{
        id: 457, pull_request_review_id: 123, in_reply_to_id: 456, html_url: reply.html_url, path: "src/example.ts",
        line: null, original_line: 8, user: "contributor", commit_id: HEAD_SHA, original_commit_id: BASE_SHA, finding_id: "thread-457",
        body: reply.body,
      }] }],
      dispositions: [{ finding_id: "logic-spec-001", axis: "spec", dimension: "correctness", thread_url: THREAD_URL, state: "unknown", evidence: BASE_SHA }],
      complete_pagination: true, complete_threads: true, api_calls: 4,
    })
    expect(calls).toEqual([
      ["gh", "api", "--method", "GET", "--paginate", `${endpoint}/reviews`, "-H", "Accept: application/vnd.github+json"],
      ["gh", "api", "--method", "GET", "--paginate", `${endpoint}/comments`, "-H", "Accept: application/vnd.github+json"],
    ])
  })

  test("does not claim complete pagination or thread coverage when comments are forbidden", async () => {
    const { exec, calls } = recordingExec(success("[]"), forbidden)
    expect(await reviews(locator, { exec })).toEqual({
      ok: false, reason: "forbidden", http_status: 403, reviews: [], threads: [], dispositions: [],
      complete_pagination: false, complete_threads: false, api_calls: 2,
    })
    expect(calls).toHaveLength(2)
  })
})

describe("review PR checks", () => {
  for (const response of [success("[]"), { code: 1, stdout: "", stderr: "no checks reported on the 'feature' branch\n" }]) {
    test(`returns empty checks for ${response.code === 0 ? "an empty JSON array" : "the no-checks CLI response"}`, async () => {
      const { exec, calls } = recordingExec(response)
      expect(await checks(locator, { exec })).toEqual({ ok: true, checks: [], api_calls: 1 })
      expect(calls).toEqual([["gh", "pr", "checks", "42", "--repo", "example/project", "--json", "name,state,link"]])
    })
  }

  test("marks forbidden checks unavailable without echoing diagnostic text", async () => {
    const { exec, calls } = recordingExec(forbidden)
    expect(await checks(locator, { exec })).toEqual({ ok: false, reason: "forbidden", http_status: 403, unavailable: true, api_calls: 1 })
    expect(calls).toHaveLength(1)
  })
})

describe("review PR identity and config", () => {
  test("reads a successful login using the exact user API argv", async () => {
    const { exec, calls } = recordingExec(success("reviewer\n"))
    expect(await identity({ exec })).toEqual({ ok: true, login: "reviewer", api_calls: 1 })
    expect(calls).toEqual([["gh", "api", "user", "--jq", ".login"]])
  })

  test("falls back after HTTP 403 to an active successful gh auth status entry", async () => {
    const { exec, calls } = recordingExec(forbidden, {
      code: 0, stdout: "", stderr: "github.com\n  ✓ Logged in to github.com account reviewer (keyring)\n  - Active account: true\n  - Git operations protocol: https\n",
    })
    expect(await identity({ exec })).toEqual({ ok: true, login: "reviewer", api_calls: 2 })
    expect(calls).toEqual([["gh", "api", "user", "--jq", ".login"], ["gh", "auth", "status"]])
  })

  test("returns unknown identity with a reason when the fallback account failed authentication", async () => {
    const { exec, calls } = recordingExec(forbidden, {
      code: 1, stdout: "", stderr: `github.com\n  X Failed to log in to github.com account reviewer (keyring)\n  - Active account: true\n  - ${BODY}\n`,
    })
    expect(await identity({ exec })).toEqual({ ok: false, login: null, reason: "identity-unavailable", http_status: 403, api_calls: 2 })
    expect(calls).toEqual([["gh", "api", "user", "--jq", ".login"], ["gh", "auth", "status"]])
  })

  test("reads raw YAML config at an immutable ref with the exact argv", async () => {
    const text = "review:\n  enabled: true\n"
    const { exec, calls } = recordingExec(success(text))
    expect(await config({ owner: locator.owner, name: locator.name, ref: HEAD_SHA }, { exec })).toEqual({ ok: true, present: true, yaml: text, api_calls: 1 })
    expect(calls).toEqual([["gh", "api", "--method", "GET", `repos/example/project/contents/.opencode/review-config.yaml?ref=${HEAD_SHA}`, "-H", "Accept: application/vnd.github.raw+json"]])
  })

  test("treats config HTTP 404 as absent rather than returning its body", async () => {
    const { exec, calls } = recordingExec({ code: 1, stdout: BODY, stderr: `gh: Not Found (HTTP 404)\n${BODY}` })
    expect(await config({ owner: locator.owner, name: locator.name, ref: HEAD_SHA }, { exec })).toEqual({ ok: true, present: false, http_status: 404, api_calls: 1 })
    expect(calls).toHaveLength(1)
  })
})

describe("review PR input validation and timeout", () => {
  for (const op of ["metadata", "head", "files", "diff", "reviews", "checks"] as const) {
    test(`${op} rejects invalid owners and nonpositive PR numbers before exec`, async () => {
      const { exec, calls } = recordingExec()
      const run = createPrExecutor({ exec })
      const args = { ...locator, ...(op === "files" ? { paginate: true } : {}) }
      for (const invalid of [{ owner: "bad/owner" }, { owner: "example\n" }, { pr: 0 }, { pr: -1 }]) {
        const result = JSON.parse(await run({ op, ...args, ...invalid }))
        expect(result).toEqual({
          ok: false, reason: "owner" in invalid ? "invalid-input:owner" : "invalid-input:pr",
          ...(op === "checks" ? { unavailable: true } : {}),
          ...(op === "files" || op === "reviews" ? { complete_pagination: false } : {}), api_calls: 0,
        })
      }
      expect(calls).toEqual([])
    })
  }

  test("config rejects invalid owners and refs other than a full 40-hex SHA before exec", async () => {
    const { exec, calls } = recordingExec()
    for (const invalid of [{ owner: "-example" }, { ref: "main" }, { ref: "a".repeat(39) }, { ref: "g".repeat(40) }, { ref: HEAD_SHA + "\n" }]) {
      expect(await config({ owner: locator.owner, name: locator.name, ref: HEAD_SHA, ...invalid }, { exec })).toEqual({
        ok: false, reason: "owner" in invalid ? "invalid-input:owner" : "invalid-input:ref", api_calls: 0,
      })
    }
    expect(calls).toEqual([])
  })

  test("a timed-out exec returns a failure-shaped unknown identity without retrying", async () => {
    const { exec, calls } = recordingExec(new Promise<PrExecResult>(() => {}))
    expect(await identity({ exec, timeoutMs: 25 })).toEqual({ ok: false, reason: "timeout", login: null, api_calls: 1 })
    expect(calls).toEqual([["gh", "api", "user", "--jq", ".login"]])
  })
})

describe("review PR discovery", () => {
  const viewArgv = ["gh", "pr", "view", "--json", "number,url,headRefName,state"]
  const listArgv = ["gh", "pr", "list", "--head", "B", "--state", "all", "--json", "number,url,state,headRefName", "--limit", "5"]
  const current = { number: 1, url: "https://github.com/example/project/pull/1", state: "OPEN", headRefName: "A" }
  const named = { number: 2, url: "https://github.com/example/project/pull/2", state: "OPEN", headRefName: "B" }

  test("finds the current branch PR using the exact view argv when no branch is supplied", async () => {
    const { exec, calls } = recordingExec(success(JSON.stringify(current)))
    expect(await find({}, { exec })).toEqual({ ok: true, found: true, number: 1, url: current.url, state: "OPEN", api_calls: 1 })
    expect(calls).toEqual([viewArgv])
  })

  test("treats the no-pull-requests stderr response as successful discovery with no match", async () => {
    const { exec, calls } = recordingExec({ code: 1, stdout: "", stderr: 'no pull requests found for branch "A"\n' })
    expect(await find({}, { exec })).toEqual({ ok: true, found: false, candidates: [], api_calls: 1 })
    expect(calls).toEqual([viewArgv])
  })

  test("finds branch B PR 2 without viewing current branch A PR 1", async () => {
    const calls: string[][] = []
    const exec: PrExec = async argv => {
      calls.push([...argv])
      return success(JSON.stringify(argv[2] === "view" ? current : [named]))
    }
    expect(await find({ branch: "B" }, { exec })).toEqual({ ok: true, found: true, number: 2, url: named.url, state: "OPEN", api_calls: 1 })
    expect(calls).toEqual([listArgv])
    expect(calls.some(argv => argv[1] === "pr" && argv[2] === "view")).toBe(false)
  })

  test.each([0, 2])("does not select a PR when the named branch list has %i candidates", async count => {
    const candidates = count === 0 ? [] : [named, { ...named, number: 3, url: "https://github.com/example/project/pull/3", state: "CLOSED" }]
    const { exec, calls } = recordingExec(success(JSON.stringify(candidates)))
    expect(await find({ branch: "B" }, { exec })).toEqual({ ok: true, found: false, candidates, api_calls: 1 })
    expect(calls).toEqual([listArgv])
  })

  test("rejects a named-branch response belonging to the current branch instead", async () => {
    const { exec, calls } = recordingExec(success(JSON.stringify([current])))
    expect(await find({ branch: "B" }, { exec })).toEqual({ ok: false, reason: "discovery-branch-mismatch", api_calls: 1 })
    expect(calls).toEqual([listArgv])
  })

  test("does not turn a forbidden discovery request into a successful no-match result", async () => {
    const { exec, calls } = recordingExec(forbidden)
    expect(await find({}, { exec })).toEqual({ ok: false, reason: "forbidden", http_status: 403, api_calls: 1 })
    expect(calls).toEqual([viewArgv])
  })
})

describe("review local changes", () => {
  const stat = " src/example.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n"
  const patch = "diff --git a/src/example.ts b/src/example.ts\n-old\n+new\n"
  const changedFiles = ["src/example.ts", "path with spaces.txt", "path\nwith\nnewlines.txt"]
  const diffArgv = ["git", "diff", "--no-ext-diff", "--no-textconv", "--no-color"]
  const commands = {
    branch: ["git", "branch", "--show-current"],
    head: ["git", "rev-parse", "HEAD"],
    log: ["git", "log", "--format=%H%x00%s", "-z", "HEAD", "--"],
    originHead: ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
    main: ["git", "show-ref", "--verify", "--quiet", "refs/heads/main"],
    master: ["git", "show-ref", "--verify", "--quiet", "refs/heads/master"],
    merge: ["git", "merge-base", "refs/remotes/origin/main", "HEAD"],
    mainMerge: ["git", "merge-base", "refs/heads/main", "HEAD"],
    masterMerge: ["git", "merge-base", "refs/heads/master", "HEAD"],
    ahead: ["git", "rev-list", "--count", `${BASE_SHA}..HEAD`],
    stat: [...diffArgv, "--stat", BASE_SHA, "--", ".", ":(top,exclude).corvus/**"],
    names: [...diffArgv, "--name-only", "-z", BASE_SHA, "--"],
    patch: [...diffArgv, "-p", BASE_SHA, "--", ".", ":(top,exclude).corvus/**"],
    status: ["git", "--no-optional-locks", "status", "--porcelain"],
  }
  const responses: Record<keyof typeof commands, PrExecResult> = {
    branch: success("feature\n"), head: success(`${HEAD_SHA}\n`), originHead: success("refs/remotes/origin/main\n"),
    log: success(`${HEAD_SHA}\0Product change\0`),
    main: success(""), master: success(""), merge: success(`${BASE_SHA}\n`),
    mainMerge: success(`${BASE_SHA}\n`), masterMerge: success(`${BASE_SHA}\n`), ahead: success("3\n"),
    stat: success(stat), names: success(changedFiles.join("\0") + "\0"), patch: success(patch), status: success(""),
  }
  const absent: PrExecResult = { code: 1, stdout: "", stderr: "" }
  const changeCommands = [commands.ahead, commands.stat, commands.names, commands.patch, commands.status]

  async function runLocal(overrides: Partial<typeof responses> = {}) {
    const calls: string[][] = []
    const exec: PrExec = async argv => {
      calls.push([...argv])
      const key = (Object.keys(commands) as Array<keyof typeof commands>)
        .find(key => JSON.stringify(commands[key]) === JSON.stringify(argv))
      if (!key) throw new Error("Unexpected exec call")
      return overrides[key] ?? responses[key]
    }
    const result = await local({}, { exec })
    for (const argv of calls) expect(Object.values(commands)).toContainEqual(argv)
    expect(result.api_calls).toBe(0)
    return { result, calls }
  }

  test("reads a clean tree, branch, ahead count and NUL-delimited paths using only exact read-only git forms", async () => {
    const { result, calls } = await runLocal()
    expect(result).toEqual({
      ok: true, branch: "feature", head_sha: HEAD_SHA, code_head: HEAD_SHA, excluded_corvus: 0, default_branch: "main", merge_base: BASE_SHA,
      ahead: 3, changed_files: changedFiles, stat, diff: patch, oversized: false, dirty: false, api_calls: 0,
    })
    expect(calls).toEqual([commands.branch, commands.head, commands.log, commands.originHead, commands.merge, ...changeCommands])
  })

  test("marks nonempty porcelain output dirty", async () => {
    const { result } = await runLocal({ status: success(" M src/example.ts\n?? note.txt\n") })
    expect(result).toMatchObject({ ok: true, dirty: true })
  })

  test.each(["main", "master"] as const)("falls back to local %s in main-then-master order when origin HEAD is unavailable", async branch => {
    const { result, calls } = await runLocal({ originHead: absent, ...(branch === "master" ? { main: absent } : {}) })
    expect(result).toMatchObject({ ok: true, default_branch: branch, merge_base: BASE_SHA })
    expect(calls).toEqual([
      commands.branch, commands.head, commands.log, commands.originHead, commands.main,
      ...(branch === "master" ? [commands.master, commands.masterMerge] : [commands.mainMerge]), ...changeCommands,
    ])
  })

  test("represents a detached HEAD with a null branch and the resolved head SHA", async () => {
    const { result } = await runLocal({ branch: success("") })
    expect(result).toMatchObject({ ok: true, branch: null, head_sha: HEAD_SHA })
  })

  test.each([512_000, 512_002])("bounds a %i-byte UTF-8 local diff without returning a partial patch", async bytes => {
    const text = "é".repeat(bytes / 2)
    expect(Buffer.byteLength(text)).toBe(bytes)
    const oversized = bytes > 512_000
    const { result } = await runLocal({ patch: success(text) })
    expect(result).toMatchObject({ ok: true, oversized, diff: oversized ? "" : text })
  })

  test("discards a diff marked truncated by the executor even when its remaining text is small", async () => {
    const { result } = await runLocal({ patch: { ...success(patch), stdout_truncated: true } })
    expect(result).toMatchObject({ ok: true, oversized: true, diff: "" })
  })

  test("returns a structured failure without reading changes when no merge base exists", async () => {
    const { result, calls } = await runLocal({ merge: absent })
    expect(result).toEqual({ ok: false, reason: "git-read-failed", api_calls: 0 })
    expect(calls).toEqual([commands.branch, commands.head, commands.log, commands.originHead, commands.merge])
  })

  test("reports no default branch after exhausting the local fallback refs without fetching", async () => {
    const { result, calls } = await runLocal({ originHead: absent, main: absent, master: absent })
    expect(result).toEqual({ ok: false, reason: "no-default-branch", api_calls: 0 })
    expect(calls).toEqual([commands.branch, commands.head, commands.log, commands.originHead, commands.main, commands.master])
  })
})

describe("committed review state PR reads", () => {
  test.each([1, 2])("metadata and head skip %i state commits across commit pages", async count => {
    const states = Array.from({ length: count }, (_, index) => ({
      sha: String(index + 1).repeat(40), commit: { message: `corvus(review-state): pr42 @ ${HEAD_SHA.slice(0, 7)} [skip ci]` },
    }))
    const tip = states.at(-1)!.sha
    const pages = success(`${JSON.stringify([{ sha: HEAD_SHA, commit: { message: "Product change" } }])}\n${JSON.stringify(states)}`)
    const data = {
      number: 42, url: "https://github.com/example/project/pull/42", title: "A change", state: "OPEN",
      isDraft: false, isCrossRepository: false, mergeable: "MERGEABLE", author: { login: "contributor" },
      baseRefName: "main", baseRefOid: BASE_SHA, headRefName: "feature", headRefOid: tip, changedFiles: 2,
      body: BODY, labels: [], closingIssuesReferences: [], latestReviews: [], reviewDecision: null,
    }
    const metadataExec = recordingExec(success(JSON.stringify(data)), pages)
    expect(await metadata(locator, { exec: metadataExec.exec })).toEqual({ ok: true, ...data, head_sha: tip, code_head: HEAD_SHA, api_calls: 3 })
    const headExec = recordingExec(success(JSON.stringify({ head: { sha: tip }, base: { sha: BASE_SHA } })), pages)
    expect(await head(locator, { exec: headExec.exec })).toEqual({ ok: true, head_sha: tip, code_head: HEAD_SHA, base_sha: BASE_SHA, api_calls: 3 })
    expect(metadataExec.calls[1]).toEqual(commitsArgv)
    expect(headExec.calls[1]).toEqual(commitsArgv)
  })

  test("returns only unfiltered names for include_corvus and excludes state records by default", async () => {
    const inventory = ["src/example.ts", ".corvus/tasks/feature/PLAN.md", ".corvus/reviews/pr42/input.md"].map(filename => ({
      filename, status: "modified", additions: 1, deletions: 0, patch: `+${BODY}`,
    }))
    for (const names_only of [true, false]) {
      const { exec, calls } = recordingExec(success(JSON.stringify(inventory)))
      const result = await files({ ...locator, paginate: true, include_corvus: true, names_only }, { exec })
      expect(result).toEqual({ ok: true, files: inventory.map(item => item.filename), complete_pagination: true, excluded_corvus: 0, api_calls: 1 })
      expect(JSON.stringify(result)).not.toContain(BODY)
      expect(calls).toEqual([["gh", "api", "--method", "GET", "--paginate", `${endpoint}/files`, "-H", "Accept: application/vnd.github+json"]])
    }
    const { exec } = recordingExec(success(JSON.stringify(inventory)))
    expect(await files({ ...locator, paginate: true }, { exec })).toEqual({
      ok: true, files: [{ ...inventory[0], has_patch: true }], complete_pagination: true, excluded_corvus: 2, api_calls: 1,
    })
  })

  test("excludes state diff sections, including quoted paths and renames into state", async () => {
    const product = "diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n"
    const state = [
      "diff --git a/.corvus/tasks/feature/PLAN.md b/.corvus/tasks/feature/PLAN.md\n+plan\n",
      'diff --git "a/.corvus/reviews/pr42/a b.md" "b/.corvus/reviews/pr42/a b.md"\n+review\n',
      "diff --git a/notes.md b/.corvus/reviews/pr42/notes.md\nrename from notes.md\nrename to .corvus/reviews/pr42/notes.md\n",
    ]
    const { exec } = recordingExec(success(state[0] + product + state.slice(1).join("")))
    expect(await diff(locator, { exec })).toEqual({ ok: true, text: product, oversized: false, excluded_corvus: 3, api_calls: 1 })
  })

  test("fails closed on incomplete commit pages or a tip that moved between reads", async () => {
    for (const response of [{ ...forbidden, stdout: commits.stdout }, success(JSON.stringify([{ sha: BASE_SHA, commit: { message: "Earlier product" } }]))]) {
      const { exec, calls } = recordingExec(success(JSON.stringify({ head: { sha: HEAD_SHA }, base: { sha: BASE_SHA } })), response)
      const result = await head(locator, { exec })
      expect(result).toMatchObject({ ok: false, reason: response.code === 0 ? "head-moved" : "forbidden" })
      expect(result).not.toHaveProperty("code_head")
      expect(calls[1]).toEqual(commitsArgv)
    }
  })

  test("projects both v1 and v2 review markers from the API", async () => {
    const v2 = `<!-- corvus-review v2 path=.corvus/tasks/feature/reviews/pr42 head=${HEAD_SHA} round=2 -->`
    const inventory = [MARKER, v2].map((marker, index) => ({
      id: index + 1, user: { login: "reviewer" }, state: "COMMENTED", commit_id: HEAD_SHA,
      submitted_at: "2026-01-01T12:00:00Z", html_url: REVIEW_URL, body: `${marker}\n${BODY}`,
    }))
    const { exec } = recordingExec(success(JSON.stringify(inventory)), success("[]"))
    const result = await reviews(locator, { exec })
    expect(result).toMatchObject({ ok: true, complete_pagination: true, complete_threads: true })
    if (!result.ok) throw new Error("Expected review markers")
    expect(result.reviews.map(item => item.body_marker)).toEqual([MARKER, v2])
  })
})

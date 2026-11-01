import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { join, relative } from "node:path"
import { canonicalize, freeze, type CandidateRequest } from "../review-payload"
import { createPostExecutor, post, type PostExec, type PostExecResult, type PostInput, type PostOptions } from "../review-post"

const HEAD_SHA = "a".repeat(40)
const OTHER_SHA = "b".repeat(40)
const BODY = "REVIEW_BODY_MUST_NOT_APPEAR_IN_RESULTS"
const INLINE_BODY = "INLINE_BODY_MUST_NOT_APPEAR_IN_RESULTS"
const REVIEW_URL = "https://github.com/example/project/pull/42#pullrequestreview-123"
const request: CandidateRequest = {
  commit_id: HEAD_SHA,
  event: "COMMENT",
  body: BODY,
  comments: [{ path: "src/example.ts", line: 10, side: "RIGHT", body: INLINE_BODY }],
}
const headResponse: PostExecResult = { code: 0, stdout: JSON.stringify([[{ sha: HEAD_SHA, commit: { message: "Product change" } }]]), stderr: "" }
const postedResponse: PostExecResult = {
  code: 0,
  stdout: JSON.stringify({ html_url: REVIEW_URL, body: BODY, comments: request.comments }),
  stderr: "",
}

type Fixture = {
  directory: string
  opts: PostOptions
  input: PostInput
  outsidePath: string
}

async function withFixture(run: (fixture: Fixture) => Promise<void>, symlinked = false): Promise<void> {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corvus-review-post-")))
  const alias = `${tempRoot}-link`
  try {
    if (symlinked) fs.symlinkSync(tempRoot, alias)
    const directory = symlinked ? join(alias, "ws") : tempRoot
    fs.mkdirSync(directory, { recursive: true })
    const root = join(directory, "review-state")
    fs.mkdirSync(root)
    const opts: PostOptions = { reviewStateRoot: symlinked ? root : fs.realpathSync(root) }
    const candidatePath = join(root, "candidate.json")
    fs.writeFileSync(candidatePath, JSON.stringify(request))
    const frozen = freeze(candidatePath, join(root, "artifact.json"), opts)
    if (!frozen.ok) throw new Error(`Expected a frozen artifact, got ${JSON.stringify(frozen)}`)
    await run({
      directory,
      opts,
      input: {
        artifactPath: frozen.artifactPath,
        expectedSha256: frozen.sha256,
        repo: { owner: "example", name: "project" },
        prNumber: 42,
        headSha: HEAD_SHA,
        event: "COMMENT",
      },
      outsidePath: join(directory, "outside.json"),
    })
  } finally {
    if (symlinked) fs.rmSync(alias, { force: true })
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

function recordingExec(...responses: Array<PostExecResult | Promise<PostExecResult>>) {
  const calls: string[][] = []
  const exec: PostExec = async argv => {
    const response = responses[calls.length]
    calls.push([...argv])
    if (!response) throw new Error("Unexpected exec call")
    return response
  }
  return { calls, exec }
}

function mismatchedDigest(input: PostInput): PostInput {
  const first = input.expectedSha256[0] === "0" ? "1" : "0"
  return { ...input, expectedSha256: first + input.expectedSha256.slice(1) }
}

describe("review post transport", () => {
  test.each(["reviews/pr42", "tasks/example/reviews/pr42"])("light APPROVE in %s rejects verified pre-upgrade artifacts before any API call; full APPROVE still posts", namespace => withFixture(async ({ directory, input }) => {
    const opts = { reviewStateRoot: join(directory, ".corvus"), directory }
    const root = join(opts.reviewStateRoot, namespace)
    fs.mkdirSync(join(root, ".light"), { recursive: true })
    const bytes = canonicalize({ ...request, event: "APPROVE" })
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex")
    const lightArtifact = join(root, ".light/post-request.json"), fullArtifact = join(root, "post-request.json")
    fs.writeFileSync(lightArtifact, bytes)
    const unused = recordingExec()
    for (const artifactPath of [lightArtifact, relative(directory, lightArtifact)]) {
      expect(await post({ ...input, artifactPath, expectedSha256, event: "APPROVE" }, { ...opts, exec: unused.exec }))
        .toEqual({ outcome: "rejected", reason: "artifact-event-not-allowed", tool_api_calls: 0 })
    }
    expect(unused.calls).toEqual([])
    expect(fs.readFileSync(lightArtifact, "utf8")).toBe(bytes)
    fs.writeFileSync(fullArtifact, bytes)
    const allowed = recordingExec(headResponse, postedResponse)
    expect(await post({ ...input, artifactPath: fullArtifact, expectedSha256, event: "APPROVE" }, { ...opts, exec: allowed.exec }))
      .toEqual({ outcome: "posted", review_url: REVIEW_URL, tool_api_calls: 2 })
    expect(allowed.calls).toHaveLength(2)
  }))
  test.each(["reviews/pr42", "tasks/example/reviews/pr42"].flatMap(namespace => [false, true].map(symlinked => ({ namespace, symlinked }))))("writer accepts only the light PR post-request leaf in $namespace (symlinked=$symlinked) for every path spelling", ({ namespace, symlinked }) => withFixture(async ({ directory, input }) => {
    const root = join(directory, ".corvus", namespace)
    const classPath = join(root, ".light")
    fs.mkdirSync(classPath, { recursive: true })
    const candidatePath = join(classPath, "candidate.json"), artifactPath = join(classPath, "post-request.json")
    fs.writeFileSync(candidatePath, JSON.stringify(request))
    const opts = { reviewStateRoot: join(directory, ".corvus"), directory }
    const frozen = freeze(candidatePath, artifactPath, opts)
    if (!frozen.ok) throw new Error("Expected light artifact")
    const descriptor = { ...input, artifactPath: relative(directory, artifactPath), expectedSha256: frozen.sha256 }
    const spellings = (target: string) => [relative(directory, target), target,
      join(fs.realpathSync(directory), relative(directory, target))]
    for (const target of spellings(artifactPath)) {
      const { exec, calls } = recordingExec(headResponse, postedResponse)
      expect(await post({ ...descriptor, artifactPath: target }, { ...opts, exec }))
        .toEqual({ outcome: "posted", review_url: REVIEW_URL, tool_api_calls: 2 })
      expect(calls[1]).toContain(fs.realpathSync(artifactPath))
    }
    const execute = createPostExecutor(opts.reviewStateRoot, directory)
    for (const caller of ["corvus-review-light", "pr-light-reviewer"]) expect(JSON.parse(await execute(descriptor, caller)))
      .toEqual({ outcome: "rejected", reason: "caller-not-allowed", tool_api_calls: 0 })
    const rejected = recordingExec()
    const rejectEverySpelling = async (target: string) => {
      for (const spelling of spellings(target)) expect(await post({ ...descriptor, artifactPath: spelling }, { ...opts, exec: rejected.exec }))
        .toEqual({ outcome: "rejected", reason: "artifact-verify-failed:path-outside-root", tool_api_calls: 0 })
      expect(rejected.calls).toEqual([])
    }
    for (const target of [candidatePath, join(classPath, "other.json"), join(classPath, "nested/post-request.json"), `${artifactPath}\n`,
      artifactPath.replace("pr42", "pr43"), artifactPath.replace("pr42", "local-feature")]) {
      fs.mkdirSync(join(target, ".."), { recursive: true })
      fs.writeFileSync(target, fs.readFileSync(artifactPath))
      await rejectEverySpelling(target)
    }
    const fullAlias = join(root, "alias.json")
    fs.symlinkSync(fs.realpathSync(artifactPath), fullAlias)
    await rejectEverySpelling(fullAlias)
    const full = join(root, "post-request.json")
    fs.writeFileSync(full, fs.readFileSync(artifactPath))
    for (const target of spellings(full)) {
      const { exec, calls } = recordingExec(headResponse, postedResponse)
      expect(await post({ ...descriptor, artifactPath: target }, { ...opts, exec }))
        .toEqual({ outcome: "posted", review_url: REVIEW_URL, tool_api_calls: 2 })
      expect(calls[1]).toContain(fs.realpathSync(full))
    }
    fs.unlinkSync(artifactPath)
    fs.symlinkSync(full, artifactPath)
    await rejectEverySpelling(artifactPath)
    expect(rejected.calls).toEqual([])
  }, symlinked))

  test.each(["absolute", "workspace-relative"] as const)("posts %s artifacts using GET then POST with the artifact realpath when process cwd differs from the host directory", kind => withFixture(async ({ directory, opts, input }) => {
    expect(process.cwd()).not.toBe(directory)
    const alias = join(opts.reviewStateRoot, "artifact-link.json")
    fs.symlinkSync(input.artifactPath, alias)
    const artifactPath = kind === "absolute" ? alias : relative(directory, alias)
    const { exec, calls } = recordingExec(headResponse, postedResponse)

    const result = await post({ ...input, artifactPath }, { ...opts, directory, exec })

    expect(result).toEqual({ outcome: "posted", review_url: REVIEW_URL, tool_api_calls: 2 })
    expect(calls.map(argv => argv.slice(1))).toEqual([
      ["api", "--method", "GET", "--paginate", "--slurp", "repos/example/project/pulls/42/commits", "-H", "Accept: application/vnd.github+json"],
      ["api", "--method", "POST", "repos/example/project/pulls/42/reviews", "--input", fs.realpathSync(alias), "-H", "Accept: application/vnd.github+json"],
    ])
    expect(JSON.stringify(result)).not.toContain(BODY)
    expect(JSON.stringify(result)).not.toContain(INLINE_BODY)
  }))

  test("retains cwd-based verification for relative artifacts without a directory option", () => withFixture(async ({ directory, opts, input }) => {
    expect(process.cwd()).not.toBe(directory)
    expect(opts.directory).toBeUndefined()
    const { exec, calls } = recordingExec()

    expect(await post({ ...input, artifactPath: relative(directory, input.artifactPath) }, { ...opts, exec })).toEqual({
      outcome: "rejected", reason: "artifact-verify-failed:path-outside-root", tool_api_calls: 0,
    })
    expect(calls).toEqual([])
  }))

  test.each(["../x.json", ".corvus/../../x.json", "review-state/../review-state/artifact.json"])("rejects workspace-relative traversal %s before exec without normalizing it", artifactPath => withFixture(async ({ directory, opts, input }) => {
    const { exec, calls } = recordingExec()

    expect(await post({ ...input, artifactPath }, { ...opts, directory, exec })).toEqual({
      outcome: "rejected", reason: "artifact-verify-failed:path-outside-root", tool_api_calls: 0,
    })
    expect(calls).toEqual([])
  }))

  test("rejects a workspace-relative symlink outside the review root before exec", () => withFixture(async ({ directory, opts, input, outsidePath }) => {
    fs.copyFileSync(input.artifactPath, outsidePath)
    const alias = join(opts.reviewStateRoot, "outside-link.json")
    fs.symlinkSync(outsidePath, alias)
    const { exec, calls } = recordingExec()

    expect(await post({ ...input, artifactPath: relative(directory, alias) }, { ...opts, directory, exec })).toEqual({
      outcome: "rejected", reason: "artifact-verify-failed:path-outside-root", tool_api_calls: 0,
    })
    expect(calls).toEqual([])
  }))

  test("rejects HTTP 422 with the diagnostic message but no body text", () => withFixture(async ({ opts, input }) => {
    const { exec, calls } = recordingExec(headResponse, {
      code: 1,
      stdout: JSON.stringify({ body: BODY, errors: [{ message: INLINE_BODY }] }),
      stderr: `gh: Validation Failed (HTTP 422)\n${BODY}\n${INLINE_BODY}`,
    })

    const result = await post(input, { ...opts, exec })

    expect(result).toEqual({
      outcome: "rejected", http_status: 422, reason: expect.stringContaining("Validation Failed"), tool_api_calls: 2,
    })
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain(BODY)
    expect(JSON.stringify(result)).not.toContain(INLINE_BODY)
  }))

  test("rejects a moved head after GET without issuing POST", () => withFixture(async ({ opts, input }) => {
    const { exec, calls } = recordingExec({ ...headResponse, stdout: JSON.stringify([[{ sha: OTHER_SHA, commit: { message: "New product change" } }]]) })

    expect(await post(input, { ...opts, exec })).toEqual({ outcome: "rejected", reason: "head-moved", tool_api_calls: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0][3]).toBe("GET")
    expect(calls.some(argv => argv.includes("POST"))).toBe(false)
  }))

  test("retries HTTP 429 once and posts successfully with three API calls", () => withFixture(async ({ opts, input }) => {
    const { exec, calls } = recordingExec(headResponse, {
      code: 1, stdout: "", stderr: "gh: Too Many Requests (HTTP 429)",
    }, postedResponse)

    expect(await post(input, { ...opts, exec })).toEqual({ outcome: "posted", review_url: REVIEW_URL, tool_api_calls: 3 })
    expect(calls.map(argv => argv[3])).toEqual(["GET", "POST", "POST"])
    expect(calls[2]).toEqual(calls[1])
  }))

  test("returns unknown when POST never resolves within a 50 ms timeout", () => withFixture(async ({ opts, input }) => {
    const { exec, calls } = recordingExec(headResponse, new Promise<PostExecResult>(() => {}))

    const result = await post(input, { ...opts, exec, timeoutMs: 50 })

    expect(result).toEqual({ outcome: "unknown", reason: "timeout", tool_api_calls: 2 })
    expect(calls.map(argv => argv[3])).toEqual(["GET", "POST"])
  }))

  test("returns unknown for HTTP 503 without retrying", () => withFixture(async ({ opts, input }) => {
    const { exec, calls } = recordingExec(headResponse, {
      code: 1, stdout: "", stderr: "gh: Service Unavailable (HTTP 503)",
    })

    expect(await post(input, { ...opts, exec })).toEqual({
      outcome: "unknown", http_status: 503, reason: expect.stringContaining("Service Unavailable"), tool_api_calls: 2,
    })
    expect(calls.map(argv => argv[3])).toEqual(["GET", "POST"])
  }))

  test("rejects a digest mismatch before exec", () => withFixture(async ({ opts, input }) => {
    const { exec, calls } = recordingExec()

    expect(await post(mismatchedDigest(input), { ...opts, exec })).toEqual({
      outcome: "rejected", reason: "artifact-verify-failed:sha256-mismatch", tool_api_calls: 0,
    })
    expect(calls).toEqual([])
  }))

  test("rejects an artifact commit_id different from headSha before exec", () => withFixture(async ({ opts, input }) => {
    const { exec, calls } = recordingExec()

    expect(await post({ ...input, headSha: OTHER_SHA }, { ...opts, exec })).toEqual({
      outcome: "rejected", reason: "artifact-head-mismatch", tool_api_calls: 0,
    })
    expect(calls).toEqual([])
  }))

  for (const kind of ["parent traversal", "absolute outside root"] as const) {
    test(`rejects ${kind} before exec`, () => withFixture(async ({ opts, input, outsidePath }) => {
      fs.copyFileSync(input.artifactPath, outsidePath)
      const artifactPath = kind === "parent traversal" ? "../x.json" : outsidePath
      const { exec, calls } = recordingExec()

      expect(await post({ ...input, artifactPath }, { ...opts, exec })).toEqual({
        outcome: "rejected", reason: "artifact-verify-failed:path-outside-root", tool_api_calls: 0,
      })
      expect(calls).toEqual([])
    }))
  }

  test("rejects an artifact event different from the descriptor before exec", () => withFixture(async ({ opts, input }) => {
    const { exec, calls } = recordingExec()

    expect(await post({ ...input, event: "APPROVE" }, { ...opts, exec })).toEqual({
      outcome: "rejected", reason: "artifact-event-mismatch", tool_api_calls: 0,
    })
    expect(calls).toEqual([])
  }))

  test("omits review and inline body text echoed in remote error messages", () => withFixture(async ({ opts, input }) => {
    for (const body of [BODY, INLINE_BODY]) {
      const { exec, calls } = recordingExec(headResponse, {
        code: 1,
        stdout: JSON.stringify({ message: `Validation Failed: ${body}` }),
        stderr: "gh: Validation Failed (HTTP 422)",
      })

      const result = await post(input, { ...opts, exec })

      expect(result).toMatchObject({ outcome: "rejected", http_status: 422, tool_api_calls: 2 })
      expect(calls).toHaveLength(2)
      expect(JSON.stringify(result)).not.toContain(BODY)
      expect(JSON.stringify(result)).not.toContain(INLINE_BODY)
    }
  }))
})

describe("review post executor", () => {
  test("returns JSON that parses to the direct transport result shape", () => withFixture(async ({ opts, input }) => {
    const invalid = mismatchedDigest(input)
    const { exec, calls } = recordingExec()
    const expected = await post(invalid, { ...opts, exec })

    const output = await createPostExecutor(opts.reviewStateRoot)(invalid, "pr-comment-writer")

    expect(typeof output).toBe("string")
    expect(JSON.parse(output)).toEqual(expected)
    expect(expected).toEqual({ outcome: "rejected", reason: "artifact-verify-failed:sha256-mismatch", tool_api_calls: 0 })
    expect(calls).toEqual([])
  }))

  test("rejects a non-absolute review-state root", () => withFixture(async ({ input }) => {
    const output = await createPostExecutor("relative/review-state")(input, "pr-comment-writer")

    expect(JSON.parse(output)).toEqual({ outcome: "rejected", reason: "invalid-review-state-root", tool_api_calls: 0 })
  }))

  test("rejects non-writers before inspecting input and cannot be authorized by tool arguments", () => withFixture(async ({ opts, input }) => {
    let inspected = 0
    const descriptor = new Proxy({ ...mismatchedDigest(input), agent: "pr-comment-writer", caller: "pr-comment-writer" }, {
      ownKeys(target) { inspected++; return Reflect.ownKeys(target) },
    })
    const expected = { outcome: "rejected", reason: "caller-not-allowed", tool_api_calls: 0 }
    for (const root of [opts.reviewStateRoot, "relative/review-state"]) {
      const execute = createPostExecutor(root)
      for (const caller of ["corvus-review", "corvus-review-auto", "corvus-review-light", "pr-context-gatherer", "pr-code-reviewer", "security-reviewer", "pr-light-reviewer", "researcher", "unknown", "", null, undefined, { agent: "pr-comment-writer" }]) {
        expect(JSON.parse(await execute(descriptor, caller))).toEqual(expected)
      }
      expect(JSON.parse(await execute(descriptor))).toEqual(expected)
    }
    expect(inspected).toBe(0)
  }))
})

test("post selects the last code_head across slurped pages when the last page contains only state commits", () => withFixture(async ({ opts, input }) => {
  const pages = [
    [{ sha: OTHER_SHA, commit: { message: "Earlier product change" } }],
    [{ sha: HEAD_SHA.toUpperCase(), commit: { message: "Product change" } }],
    [{ sha: OTHER_SHA, commit: { message: `corvus(review-state): pr42 @ ${HEAD_SHA.slice(0, 7)} [skip ci]` } }],
  ]
  const calls: string[][] = []
  const exec: PostExec = async argv => {
    calls.push([...argv])
    if (argv.includes("POST")) return postedResponse
    expect(argv).toEqual(["gh", "api", "--method", "GET", "--paginate", "--slurp", "repos/example/project/pulls/42/commits",
      "-H", "Accept: application/vnd.github+json"])
    return { code: 0, stdout: JSON.stringify(pages), stderr: "" }
  }
  expect(await post(input, { ...opts, exec })).toEqual({ outcome: "posted", review_url: REVIEW_URL, tool_api_calls: 2 })
  expect(calls).toHaveLength(2)
  expect(calls[1]).toContain("POST")
}))

test("post fails closed on malformed or empty commit pages without issuing POST", () => withFixture(async ({ opts, input }) => {
  const commit = { sha: HEAD_SHA, commit: { message: "Product change" } }
  for (const stdout of ["", "[[", "null", "[]", "[[]]", JSON.stringify([commit]),
    JSON.stringify([[commit], { error: "invalid page" }]),
    JSON.stringify([[commit], [{ sha: OTHER_SHA, commit: {} }]]),
    JSON.stringify([[commit], [{ sha: "invalid", commit: { message: "New product change" } }]]),
    JSON.stringify([[{ sha: OTHER_SHA, commit: { message: "corvus(review-state): state only" } }]])]) {
    const { exec, calls } = recordingExec({ code: 0, stdout, stderr: "" })
    expect(await post(input, { ...opts, exec }), stdout).toEqual({ outcome: "unknown", reason: "transport-error", tool_api_calls: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0][3]).toBe("GET")
  }
}))

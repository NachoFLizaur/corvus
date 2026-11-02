import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLockExecutor } from "../review-lock"
import { createReviewToolExecutors } from "../review-payload"
import { createPersistExecutor } from "../review-persist"
import { post, type PostExec, type PostInput } from "../review-post"

const head = "a".repeat(40), light = "corvus-review-light"

async function withWorkspace(run: (directory: string) => Promise<void>) {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corvus-light-protocol-")))
  try { await run(directory) } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

describe("light protocol composition", () => {
  test.each(["reviews/local-feature", "tasks/example/reviews/local-feature"])("AC7/AC10: inert LOCAL artifact in %s cannot reach post transport", namespace => withWorkspace(async directory => {
    const reviewRoot = `.corvus/${namespace}`, path = join(directory, reviewRoot)
    const lock = createLockExecutor(join(directory, ".corvus"))
    const persist = createPersistExecutor(join(directory, ".corvus"))
    const { payload } = createReviewToolExecutors(directory)
    const callLock = (args: object) => JSON.parse(lock({ reviewRoot, ...args }, light))
    const callPersist = (args: object) => JSON.parse(persist({ reviewRoot, ...args }, light))
    const callPayload = (args: object) => JSON.parse(payload(args, light))
    expect(callLock({ op: "acquire", runId: "local-run" })).toMatchObject({ ok: true, state: "acquired" })
    const candidate = { commit_id: head, event: "COMMENT", body: `<!-- corvus-review v1 head:${head} -->\nLOCAL scope against trusted merge base`, comments: [] }
    expect(callPersist({ op: "write_candidate", candidate })).toMatchObject({ ok: true, path: join(path, ".light/candidate.json") })
    const frozen = callPayload({ op: "freeze", candidatePath: `${reviewRoot}/.light/candidate.json`, artifactPath: `${reviewRoot}/.light/post-request.json` })
    expect(frozen.ok).toBe(true)
    expect(callPayload({ op: "preview", artifactPath: frozen.artifactPath, expectedSha256: frozen.sha256 }))
      .toMatchObject({ ok: true, event: "COMMENT", commit_id: head, body: candidate.body, comments: [] })
    // Deliberately attempt the forbidden handoff as an adversarial TOOL probe,
    // not an orchestrator trace. The prompt test separately pins zero dispatches.
    const calls: string[][] = []
    const exec: PostExec = async argv => { calls.push([...argv]); throw new Error("LOCAL reached transport") }
    const input: PostInput = { artifactPath: frozen.artifactPath, expectedSha256: frozen.sha256,
      repo: { owner: "example", name: "project" }, prNumber: 42, headSha: head, event: "COMMENT" }
    expect(await post(input, { directory, reviewStateRoot: join(directory, ".corvus"), exec }))
      .toEqual({ outcome: "rejected", reason: "artifact-verify-failed:path-outside-root", tool_api_calls: 0 })
    expect(calls).toEqual([])
    const open = callPersist({ op: "begin", target: "candidate", commit_id: head, event: "COMMENT" })
    expect(open.ok).toBe(true)
    expect(callPersist({ op: "abort", staging_id: open.staging_id })).toMatchObject({ ok: true })
    expect(callLock({ op: "release", runId: "local-run", mode: "delete" })).toMatchObject({ ok: true })
    expect(fs.readdirSync(path)).toEqual([".light"])
    expect(fs.existsSync(join(path, ".light/.staging/candidate"))).toBe(false)
    expect(fs.existsSync(join(path, head))).toBe(false)
  }))

  test("AC1/AC8: fitting preserves the marker first without a notice; revision needs a fresh digest", () => withWorkspace(async directory => {
    const reviewRoot = ".corvus/reviews/pr42", path = join(directory, reviewRoot)
    const lock = createLockExecutor(join(directory, ".corvus"))
    expect(JSON.parse(lock({ op: "acquire", reviewRoot, runId: "fit-run" }, light))).toMatchObject({ ok: true })
    const persist = createPersistExecutor(join(directory, ".corvus")), { payload } = createReviewToolExecutors(directory)
    const call = (args: object) => JSON.parse(persist({ reviewRoot, ...args }, light))
    const marker = `<!-- corvus-review v2 path=${reviewRoot} head=${head} round=1 -->`
    const body = `${marker}\n# Standards\nValidate the request.\n${"Details ".repeat(6000)}`
    const started = call({ op: "begin", target: "candidate", commit_id: head, event: "COMMENT" })
    expect(started.ok).toBe(true)
    const parts = Math.ceil(body.length / 1800)
    for (let part = 0; part < parts; part++) {
      const args = { op: "append", staging_id: started.staging_id, field: "body", text: body.slice(part * 1800, (part + 1) * 1800), part, parts }
      expect(JSON.stringify({ reviewRoot, ...args }).length).toBeLessThanOrEqual(6000)
      expect(call(args)).toMatchObject({ ok: true })
    }
    expect(call({ op: "finalize", staging_id: started.staging_id, expected_comments: 0 })).toMatchObject({ ok: true })
    const freeze = () => JSON.parse(payload({ op: "freeze", candidatePath: `${reviewRoot}/.light/candidate.json`, artifactPath: `${reviewRoot}/.light/post-request.json` }, light))
    const frozen = freeze()
    expect(frozen).toMatchObject({ ok: true, fitted: true })
    const preview = (digest: string) => JSON.parse(payload({ op: "preview", artifactPath: frozen.artifactPath, expectedSha256: digest }, light))
    const actual = preview(frozen.sha256)
    expect(actual).toMatchObject({ ok: true, commit_id: head, event: "COMMENT", sha256: frozen.sha256, comments: [] })
    expect(actual.body.split("\n")[0]).toBe(marker)
    expect(actual.body).not.toMatch(/\[!WARNING\]|Reduced-coverage/)
    expect(call({ op: "write_candidate", candidate: { commit_id: head, event: "REQUEST_CHANGES", body: `${marker}\nRevised placement`, comments: [] } })).toMatchObject({ ok: true })
    const revised = freeze()
    expect(revised).toMatchObject({ ok: true, fitted: false })
    expect(revised.sha256).not.toBe(frozen.sha256)
    expect(preview(frozen.sha256)).toMatchObject({ ok: false })
    expect(preview(revised.sha256)).toMatchObject({ ok: true, event: "REQUEST_CHANGES", commit_id: head, sha256: revised.sha256 })
    expect(JSON.parse(lock({ op: "release", reviewRoot, runId: "fit-run", mode: "delete" }, light))).toMatchObject({ ok: true })
    expect(fs.readdirSync(path)).toEqual([".light"])
  }))

  test("AC8: restarted head creates its own marker/freeze/preview digest under one held lock", () => withWorkspace(async directory => {
    const reviewRoot = ".corvus/reviews/pr42"
    const lock = createLockExecutor(join(directory, ".corvus"))
    const persist = createPersistExecutor(join(directory, ".corvus")), { payload } = createReviewToolExecutors(directory)
    expect(JSON.parse(lock({ op: "acquire", reviewRoot, runId: "restart-run" }, light)).ok).toBe(true)
    let priorDigest: string | undefined
    for (const [attempt, codeHead] of [head, "b".repeat(40), "c".repeat(40)].entries()) {
      const marker = `<!-- corvus-review v2 path=${reviewRoot} head=${codeHead} round=${attempt + 1} -->`
      const candidate = { commit_id: codeHead, event: "COMMENT", body: `${marker}\nNo actionable findings in the reviewed scope.`, comments: [] }
      expect(JSON.parse(persist({ op: "write_candidate", reviewRoot, candidate }, light)).ok).toBe(true)
      const frozen = JSON.parse(payload({ op: "freeze", candidatePath: `${reviewRoot}/.light/candidate.json`, artifactPath: `${reviewRoot}/.light/post-request.json` }, light))
      expect(frozen.ok).toBe(true)
      expect(typeof frozen.sha256).toBe("string")
      const shown = JSON.parse(payload({ op: "preview", artifactPath: frozen.artifactPath, expectedSha256: frozen.sha256 }, light))
      expect(shown).toMatchObject({ ok: true, commit_id: codeHead, event: "COMMENT", sha256: frozen.sha256, body: candidate.body })
      if (priorDigest) {
        expect(frozen.sha256).not.toBe(priorDigest)
        expect(JSON.parse(payload({ op: "preview", artifactPath: frozen.artifactPath, expectedSha256: priorDigest }, light)).ok).toBe(false)
      }
      priorDigest = frozen.sha256
    }
    expect(JSON.parse(lock({ op: "release", reviewRoot, runId: "restart-run", mode: "delete" }, light)).ok).toBe(true)
  }))

  test.each(["reviews/pr42", "tasks/example/reviews/pr42"])("AC10: expired detector return exposes no fresh owner; takeover cleanup preserves %s", namespace => withWorkspace(async directory => {
    const reviewRoot = `.corvus/${namespace}`, path = join(directory, reviewRoot, "lock.yaml")
    let elapsed = 0
    const started = Date.parse("2026-10-31T00:00:00Z")
    const lock = createLockExecutor(join(directory, ".corvus"), { now: () => new Date(started + elapsed * 1000) })
    const call = (args: object) => JSON.parse(lock({ reviewRoot, ...args }, light))
    expect(call({ op: "acquire", runId: "slow-detector" })).toMatchObject({ ok: true, state: "acquired" })
    const original = fs.readFileSync(path)
    elapsed = 7199
    expect(call({ op: "status" }).holders).toEqual([{ path, run_id: "slow-detector", started_at: new Date(started).toISOString(), age_s: elapsed }])
    elapsed = 7200 // The detector returns at the tool's fixed freshness boundary.
    expect(call({ op: "status" })).toEqual({ held: false, holders: [], legacy_present: false })
    expect(fs.readFileSync(path)).toEqual(original)
    // No force: an ordinary overlapping run may now acquire. The prompt owns
    // the no-further-mutation guard; this tool probe proves its cleanup oracle.
    expect(call({ op: "acquire", runId: "overlapping-run" })).toMatchObject({ ok: true, state: "acquired" })
    const replacement = fs.readFileSync(path)
    expect(replacement.equals(original)).toBe(false)
    expect(call({ op: "status" }).holders).toEqual([{ path, run_id: "overlapping-run", started_at: new Date(started + elapsed * 1000).toISOString(), age_s: 0 }])
    expect(call({ op: "release", runId: "slow-detector", mode: "delete" })).toEqual({ ok: false, reason: "not-owner", path })
    expect(fs.readFileSync(path)).toEqual(replacement)
    expect(call({ op: "release", runId: "overlapping-run", mode: "delete" }).ok).toBe(true)
    expect(fs.existsSync(path)).toBe(false)
  }))
})

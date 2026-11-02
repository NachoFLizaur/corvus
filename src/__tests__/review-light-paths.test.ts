import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createReviewToolExecutors } from "../review-payload"
import { createPersistExecutor } from "../review-persist"
import { createLockExecutor } from "../review-lock"
import { hostRelativePath, isLightClassPath } from "../review-storage-class"
import { post, type PostExec, type PostInput } from "../review-post"

const head = "a".repeat(40), body = "> Reduced-coverage light review\nPath regression fixture"
const candidate = { commit_id: head, event: "COMMENT", body, comments: [] }
const url = "https://github.com/example/project/pull/42#pullrequestreview-123"
const prRoots = [".corvus/reviews/pr42", ".corvus/tasks/example/reviews/pr42", ".corvus/tasks/.light/reviews/pr42"]
const ancestors = [".light", "reviews/pr7/.light", "x/reviews/local-a/.light", ".corvus/tasks/t/reviews/pr7/.light"]
const cases = (roots: string[]) => roots.flatMap(reviewRoot => ancestors.flatMap(ancestor =>
  [false, true].flatMap(symlinked => ["relative", "configured-absolute", "real-absolute"].map(spelling =>
    ({ reviewRoot, ancestor, symlinked, spelling })))))

async function withAncestor(ancestor: string, symlinked: boolean, run: (directory: string) => Promise<void>) {
  const temp = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corvus-light-ancestor-")))
  const aliasRoot = `${temp}-link`, alias = join(aliasRoot, ancestor)
  try {
    if (symlinked) {
      fs.mkdirSync(dirname(alias), { recursive: true })
      fs.symlinkSync(temp, alias)
    }
    const directory = join(symlinked ? alias : join(temp, ancestor), "ws")
    fs.mkdirSync(directory, { recursive: true })
    await run(directory)
  } finally {
    if (symlinked) fs.rmSync(aliasRoot, { recursive: true, force: true })
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

const spellPath = (directory: string, spelling: string, path: string) => spelling === "relative" ? path
  : join(spelling === "real-absolute" ? fs.realpathSync(directory) : directory, path)

function transport() {
  const calls: string[][] = []
  const exec: PostExec = async argv => {
    calls.push([...argv])
    if (argv.includes("GET")) return { code: 0, stdout: JSON.stringify([[{ sha: head, commit: { message: "Product change" } }]]), stderr: "" }
    if (argv.includes("POST")) return { code: 0, stdout: JSON.stringify({ html_url: url }), stderr: "" }
    throw new Error("Unexpected transport command")
  }
  return { exec, calls }
}
const descriptor = (artifactPath: string, expectedSha256: string): PostInput => ({ artifactPath, expectedSha256,
  repo: { owner: "example", name: "project" }, prNumber: 42, headSha: head, event: "COMMENT" })

/** Oracle: namespace-relative class location, not a workspace/task name, checked
 * before fixture writes. A wrong classification fails every consumer's case; no
 * flag disables these regressions. All writes are temporary test-owned fixtures;
 * post transport is injected and never contacts GitHub. */
describe("light-class namespace anchoring (AC5, AC7, AC10)", () => {
  test.each(cases(prRoots))("full $reviewRoot below $ancestor ($spelling, symlinked=$symlinked) stays full in every consumer", ({ reviewRoot, ancestor, spelling, symlinked }) => withAncestor(ancestor, symlinked, async directory => {
    const absoluteRoot = join(fs.realpathSync(directory), reviewRoot), root = join(directory, ".corvus")
    const persist = createPersistExecutor(root), { payload } = createReviewToolExecutors(directory)
    const arg = (path: string) => spellPath(directory, spelling, path)
    expect(isLightClassPath(hostRelativePath(root, join(directory, reviewRoot))!)).toBe(false)
    expect(JSON.parse(persist({ op: "write_candidate", reviewRoot: arg(reviewRoot), candidate }, "corvus-review")))
      .toMatchObject({ ok: true, path: join(absoluteRoot, "candidate.json") })
    const artifactPath = arg(`${reviewRoot}/post-request.json`)
    const frozen = JSON.parse(payload({ op: "freeze", candidatePath: arg(`${reviewRoot}/candidate.json`), artifactPath }, "corvus-review"))
    expect(frozen).toMatchObject({ ok: true, artifactPath: join(absoluteRoot, "post-request.json") })
    expect(JSON.parse(payload({ op: "preview", artifactPath, expectedSha256: frozen.sha256 }, "corvus-review")))
      .toMatchObject({ ok: true, body, commit_id: head, event: "COMMENT" })
    const { exec, calls } = transport()
    expect(await post(descriptor(artifactPath, frozen.sha256), { directory, reviewStateRoot: root, exec }))
      .toEqual({ outcome: "posted", review_url: url, tool_api_calls: 2 })
    expect(calls.map(argv => argv[3])).toEqual(["GET", "POST"])
    expect(fs.existsSync(join(absoluteRoot, ".light"))).toBe(false)
    const lock = createLockExecutor(root)
    expect(JSON.parse(lock({ op: "acquire", reviewRoot: arg(reviewRoot), runId: "full" }, "corvus-review"))).toMatchObject({ ok: true })
    expect(JSON.parse(lock({ op: "release", reviewRoot: arg(reviewRoot), runId: "full", mode: "delete" }, "corvus-review"))).toMatchObject({ ok: true })
  }))

  test.each(cases(prRoots))("light $reviewRoot below $ancestor ($spelling, symlinked=$symlinked) routes every consumer to its class", ({ reviewRoot, ancestor, spelling, symlinked }) => withAncestor(ancestor, symlinked, async directory => {
    const absoluteRoot = join(fs.realpathSync(directory), reviewRoot), root = join(directory, ".corvus")
    const persist = createPersistExecutor(root), { payload } = createReviewToolExecutors(directory)
    const arg = (path: string) => spellPath(directory, spelling, path)
    const lock = createLockExecutor(root)
    expect(JSON.parse(lock({ op: "acquire", reviewRoot: arg(reviewRoot), runId: "light" }, "corvus-review-light"))).toMatchObject({ ok: true })
    const call = (args: object) => JSON.parse(persist({ reviewRoot: arg(reviewRoot), ...args }, "corvus-review-light"))
    const candidatePath = arg(`${reviewRoot}/.light/candidate.json`), artifactPath = arg(`${reviewRoot}/.light/post-request.json`)
    expect(call({ op: "write_candidate", candidate })).toMatchObject({ ok: true, path: join(absoluteRoot, ".light/candidate.json") })
    const started = call({ op: "begin", target: "candidate", commit_id: head, event: "COMMENT" })
    expect(started.ok).toBe(true)
    expect(call({ op: "append", staging_id: started.staging_id, field: "body", part: 0, parts: 1, text: body })).toMatchObject({ ok: true })
    expect(call({ op: "finalize", staging_id: started.staging_id, expected_comments: 0 })).toMatchObject({ ok: true, path: join(absoluteRoot, ".light/candidate.json") })
    const frozen = JSON.parse(payload({ op: "freeze", candidatePath, artifactPath }, "corvus-review-light"))
    expect(frozen).toMatchObject({ ok: true, artifactPath: join(absoluteRoot, ".light/post-request.json") })
    expect(JSON.parse(payload({ op: "preview", artifactPath, expectedSha256: frozen.sha256 }, "corvus-review-light")))
      .toMatchObject({ ok: true, body, commit_id: head, event: "COMMENT" })
    const { exec, calls } = transport()
    expect(await post(descriptor(artifactPath, frozen.sha256), { directory, reviewStateRoot: root, exec }))
      .toEqual({ outcome: "posted", review_url: url, tool_api_calls: 2 })
    expect(calls.map(argv => argv[3])).toEqual(["GET", "POST"])
    for (const args of [{ op: "measure", candidatePath }, { op: "freeze", candidatePath, artifactPath },
      { op: "preview", artifactPath, expectedSha256: frozen.sha256 }])
      expect(JSON.parse(payload(args, "corvus-review"))).toMatchObject({ ok: false, reason: "path-outside-root" })
    const never = transport()
    const actualArtifact = join(absoluteRoot, ".light/post-request.json")
    const wrongPR = actualArtifact.replace("pr42/", "pr43/")
    fs.mkdirSync(join(wrongPR, ".."), { recursive: true })
    fs.copyFileSync(actualArtifact, wrongPR)
    expect(await post(descriptor(wrongPR, frozen.sha256), { directory, reviewStateRoot: root, exec: never.exec }))
      .toEqual({ outcome: "rejected", reason: "artifact-verify-failed:path-outside-root", tool_api_calls: 0 })
    const fullArtifact = join(absoluteRoot, "post-request.json")
    fs.copyFileSync(actualArtifact, fullArtifact)
    fs.unlinkSync(actualArtifact)
    fs.symlinkSync(fullArtifact, actualArtifact)
    expect(await post(descriptor(artifactPath, frozen.sha256), { directory, reviewStateRoot: root, exec: never.exec }))
      .toEqual({ outcome: "rejected", reason: "artifact-verify-failed:path-outside-root", tool_api_calls: 0 })
    expect(never.calls).toEqual([])
    expect(JSON.parse(lock({ op: "release", reviewRoot: arg(reviewRoot), runId: "light", mode: "delete" }, "corvus-review-light"))).toMatchObject({ ok: true })
  }))

  test.each(cases([".corvus/reviews/local-feature", ".corvus/tasks/.light/reviews/local-feature"]))("LOCAL $reviewRoot below $ancestor ($spelling, symlinked=$symlinked) stays local in both classes", ({ reviewRoot, ancestor, spelling, symlinked }) => withAncestor(ancestor, symlinked, async directory => {
    const root = join(directory, ".corvus"), absoluteRoot = join(fs.realpathSync(directory), reviewRoot)
    const persist = createPersistExecutor(root), { payload } = createReviewToolExecutors(directory)
    const never = transport()
    const arg = (path: string) => spellPath(directory, spelling, path)
    const lock = createLockExecutor(root)
    for (const caller of ["corvus-review", "corvus-review-light"]) {
      expect(JSON.parse(lock({ op: "acquire", reviewRoot: arg(reviewRoot), runId: caller }, caller))).toMatchObject({ ok: true })
      const classPath = caller === "corvus-review-light" ? ".light/" : ""
      const candidatePath = arg(`${reviewRoot}/${classPath}candidate.json`), artifactPath = arg(`${reviewRoot}/${classPath}post-request.json`)
      expect(JSON.parse(persist({ op: "write_candidate", reviewRoot: arg(reviewRoot), candidate }, caller)))
        .toMatchObject({ ok: true, path: join(absoluteRoot, `${classPath}candidate.json`) })
      const frozen = JSON.parse(payload({ op: "freeze", candidatePath, artifactPath }, caller))
      expect(frozen.ok).toBe(true)
      expect(JSON.parse(payload({ op: "preview", artifactPath, expectedSha256: frozen.sha256 }, caller))).toMatchObject({ ok: true, body })
      if (caller === "corvus-review-light") expect(await post(descriptor(artifactPath, frozen.sha256), { directory, reviewStateRoot: root, exec: never.exec }))
        .toEqual({ outcome: "rejected", reason: "artifact-verify-failed:path-outside-root", tool_api_calls: 0 })
      expect(JSON.parse(lock({ op: "release", reviewRoot: arg(reviewRoot), runId: caller, mode: "delete" }, caller))).toMatchObject({ ok: true })
    }
    expect(never.calls).toEqual([])
  }))
})

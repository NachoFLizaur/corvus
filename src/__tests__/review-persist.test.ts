import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import yaml from "js-yaml"
import { createReviewToolExecutors, type CandidateRequest } from "../review-payload"
import {
  abort, append, begin, finalize, status, type StagingResult,
  createPersistExecutor, read_document, read_facts, write_candidate, write_document, write_facts, write_input, write_meta,
  type PersistOptions, type ReviewPersistFs, type WriteResult,
} from "../review-persist"

const HEAD_SHA = "a".repeat(40)
const BODY = "PERSIST_BODY_MUST_NOT_APPEAR_IN_RESULTS"
const candidate: CandidateRequest = {
  commit_id: HEAD_SHA, event: "COMMENT", body: BODY,
  comments: [{ path: "src/example.ts", line: 10, side: "RIGHT", body: BODY }],
}
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

type Fixture = { workspace: string; opts: PersistOptions; reviewRoot: string; reviewPath: string; outsidePath: string }

function withFixture(run: (fixture: Fixture) => void, fresh = false): void {
  const workspace = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corvus-review-persist-")))
  try {
    const root = join(workspace, ".corvus")
    if (!fresh) fs.mkdirSync(root, { recursive: true })
    const reviewRoot = "tasks/example/reviews/pr42"
    run({ workspace, opts: { reviewStateRoot: root }, reviewRoot, reviewPath: join(root, reviewRoot), outsidePath: join(workspace, "outside") })
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

function written(result: WriteResult) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`Expected write success, got ${JSON.stringify(result)}`)
  expect(JSON.stringify(result)).not.toContain(BODY)
  const bytes = fs.readFileSync(result.path)
  const text = bytes.toString("utf8")
  expect(result).toEqual({
    ok: true, path: result.path, sha256: sha256(bytes), bytes: bytes.length,
    lines: text.split("\n").length - Number(text.endsWith("\n")),
  })
  return { ...result, text }
}

function expectLineLimit(text: string): void {
  expect(Math.max(...text.split("\n").map(line => line.length))).toBeLessThanOrEqual(1_900)
}

describe("review persist documents", () => {
  test("writes sections and roundtrips the input with frontmatter and a fenced YAML block preserved", () => withFixture(({ opts, reviewRoot, reviewPath }) => {
    const frontmatterYaml = 'title: "Review"\nlabels:\n  - correctness'
    const yamlBlock = '```yaml\nsummary: |\n  First line\n  ## Not a section\nitems:\n  - "quoted: value"\n```'
    const sections = [
      { heading: "", body: "# Review" },
      { heading: "Summary", body: BODY },
      { heading: "Findings", body: yamlBlock },
    ]
    const result = written(write_document({ reviewRoot, headSha: HEAD_SHA, sections, frontmatterYaml }, opts))

    expect(result.path).toBe(join(reviewPath, HEAD_SHA, "REVIEW_DOCUMENT.md"))
    expect(result.text).toBe(`---\n${frontmatterYaml}\n---\n\n# Review\n\n## Summary\n\n${BODY}\n\n## Findings\n\n${yamlBlock}\n`)
    expectLineLimit(result.text)
    expect(read_document({ reviewRoot, headSha: HEAD_SHA }, opts)).toEqual({
      ok: true, sections, frontmatterYaml, sha256: result.sha256, lines: result.lines,
    })
  }))

  test("wraps a 5,000-character section body without losing its words or delimiters", () => withFixture(({ opts, reviewRoot }) => {
    const body = "word ".repeat(1_000)
    expect(body).toHaveLength(5_000)
    const result = written(write_document({ reviewRoot, headSha: HEAD_SHA, sections: [{ heading: "Summary", body }] }, opts))
    expectLineLimit(result.text)
    const read = read_document({ reviewRoot, headSha: HEAD_SHA }, opts)
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error("Expected document read success")
    expect(read.sections).toHaveLength(1)
    expect(read.sections[0].heading).toBe("Summary")
    expect(read.sections[0].body).toContain("\n")
    expect(read.sections[0].body.replaceAll("\n", "")).toBe(body)
  }))

  test("rejects a 2,500-character unbreakable token without creating the review directory", () => withFixture(({ opts, reviewRoot, reviewPath }) => {
    expect(write_document({ reviewRoot, headSha: HEAD_SHA, sections: [{ heading: "Summary", body: "x".repeat(2_500) }] }, opts))
      .toEqual({ ok: false, reason: "unbreakable-line" })
    expect(fs.existsSync(reviewPath)).toBe(false)
  }))

  test("writes an exclusive sibling temp, atomically replaces the document, then hashes final readback", () => withFixture(({ opts, reviewRoot, reviewPath }) => {
    const input = { reviewRoot, headSha: HEAD_SHA, sections: [{ heading: "Summary", body: "Original" }] }
    const previous = written(write_document(input, opts))
    const path = join(reviewPath, HEAD_SHA, "REVIEW_DOCUMENT.md")
    const events: string[] = []
    let tempPath = ""
    const io: ReviewPersistFs = {
      ...fs,
      writeFileSync(temp, bytes, options) {
        events.push("write")
        tempPath = temp
        expect(dirname(temp)).toBe(dirname(path))
        expect(basename(temp)).toMatch(/^\.REVIEW_DOCUMENT\.md\.[0-9a-f-]+\.tmp$/)
        expect(options).toEqual({ flag: "wx", mode: 0o600 })
        expect(fs.readFileSync(path, "utf8")).toBe(previous.text)
        fs.writeFileSync(temp, bytes, options)
      },
      renameSync(from, to) {
        events.push("rename")
        expect(from).toBe(tempPath)
        expect(to).toBe(path)
        expect(fs.readFileSync(path, "utf8")).toBe(previous.text)
        fs.renameSync(from, to)
      },
      readFileSync(target) {
        events.push("readback")
        expect(target).toBe(path)
        return fs.readFileSync(target)
      },
    }
    const result = written(write_document({ ...input, sections: [{ heading: "Summary", body: BODY }] }, { ...opts, fs: io }))
    expect(result.text).toBe(`## Summary\n\n${BODY}\n`)
    expect(events).toEqual(["write", "rename", "readback"])
    expect(fs.readdirSync(dirname(path))).toEqual(["REVIEW_DOCUMENT.md"])
  }))

  test("rejects same-length readback corruption without returning body text or a digest", () => withFixture(({ opts, reviewRoot }) => {
    let expectedBytes = 0
    const io: ReviewPersistFs = {
      ...fs,
      readFileSync(path) {
        const bytes = Buffer.from(fs.readFileSync(path))
        expectedBytes = bytes.length
        bytes[0] ^= 1
        return bytes
      },
    }
    const result = write_document({ reviewRoot, headSha: HEAD_SHA, sections: [{ heading: "Summary", body: BODY }] }, { ...opts, fs: io })
    expect(result).toEqual({ ok: false, reason: "readback-mismatch", expectedBytes, actualBytes: expectedBytes })
    expect(JSON.stringify(result)).not.toContain(BODY)
  }))
})

function stagingId(result: StagingResult): string {
  expect(result.ok).toBe(true)
  if (!result.ok || !("staging_id" in result)) throw new Error(`Expected staging session, got ${JSON.stringify(result)}`)
  expect(typeof result.staging_id).toBe("string")
  return result.staging_id
}

describe("review persist staging", () => {
  test("finalizes byte-identically to a single document write and roundtrips sections", () => withFixture(({ opts, reviewRoot }) => {
    const frontmatterYaml = 'title: "Staged review"'
    const sections = [{ heading: "", body: "# Review 👍" }, { heading: "Findings", body: "```yaml\nitems:\n  - verified\n```" }]
    const direct = written(write_document({ reviewRoot, headSha: HEAD_SHA, sections, frontmatterYaml }, opts))
    const bytes = fs.readFileSync(direct.path)
    const session = { reviewRoot, staging_id: stagingId(begin({ reviewRoot, target: "document", headSha: HEAD_SHA, expected_sections: 2, frontmatterYaml }, opts)) }
    for (const index of [1, 0]) expect(append({ ...session, index, ...sections[index] }, opts)).toMatchObject({ ok: true })
    expect(finalize(session, opts)).toMatchObject({ ok: true, path: direct.path, sha256: direct.sha256, bytes: bytes.length, sections: 2, parts: 2 })
    expect(fs.readFileSync(direct.path)).toEqual(bytes)
    expect(read_document({ reviewRoot, headSha: HEAD_SHA }, opts)).toEqual({ ok: true, sections, frontmatterYaml, sha256: direct.sha256, lines: direct.lines })
  }))

  test("concatenates section parts in numeric order without inserting delimiters", () => withFixture(({ opts, reviewRoot }) => {
    const bodies = ["Before\n```ya", "ml\nvalue: 👍\n", "```\nAfter"]
    const session = { reviewRoot, staging_id: stagingId(begin({ reviewRoot, target: "document", headSha: HEAD_SHA, expected_sections: 1 }, opts)) }
    for (const part of [2, 0, 1]) expect(append({ ...session, index: 0, heading: "Summary", part, parts: 3, body: bodies[part] }, opts)).toMatchObject({ ok: true })
    expect(finalize(session, opts)).toMatchObject({ ok: true, sections: 1, parts: 3 })
    expect(read_document({ reviewRoot, headSha: HEAD_SHA }, opts)).toMatchObject({ ok: true, sections: [{ heading: "Summary", body: bodies.join("") }] })
  }))

  test.each(["document", "input"] as const)("rejects an oversized %s chunk without changing staging", target => withFixture(({ opts, reviewRoot }) => {
    const session = { reviewRoot, staging_id: stagingId(begin({ reviewRoot, target, ...(target === "document" ? { headSha: HEAD_SHA, expected_sections: 1 } : {}) }, opts)) }
    const chunk = (length: number) => target === "document" ? { index: 0, body: "x".repeat(length) } : { key: "body", value: "x".repeat(length - 2) }
    expect(append({ ...session, ...chunk(6_000) }, opts)).toMatchObject({ ok: true })
    const before = status(session, opts)
    expect(append({ ...session, ...chunk(6_001) }, opts)).toEqual({ ok: false, reason: "chunk-too-large", length: 6_001 })
    expect(status(session, opts)).toEqual(before)
  }))

  test("reports a missing part on finalize and preserves the existing document bytes", () => withFixture(({ opts, reviewRoot }) => {
    const previous = written(write_document({ reviewRoot, headSha: HEAD_SHA, sections: [{ heading: "Summary", body: "Existing review 👍" }] }, opts))
    const bytes = fs.readFileSync(previous.path)
    const session = { reviewRoot, staging_id: stagingId(begin({ reviewRoot, target: "document", headSha: HEAD_SHA, expected_sections: 1 }, opts)) }
    expect(append({ ...session, index: 0, heading: "Summary", part: 0, parts: 2, body: "Replacement" }, opts)).toMatchObject({ ok: true })
    expect(finalize(session, opts)).toEqual({ ok: false, reason: "incomplete-staging", missing: [{ index: 0, parts: [1] }], unexpected: [] })
    expect(fs.readFileSync(previous.path)).toEqual(bytes)
  }))

  test("re-appending the same part replaces rather than duplicates it", () => withFixture(({ opts, reviewRoot }) => {
    const session = { reviewRoot, staging_id: stagingId(begin({ reviewRoot, target: "document", headSha: HEAD_SHA, expected_sections: 1 }, opts)) }
    for (const body of ["Old", "Replacement", "Replacement"]) expect(append({ ...session, index: 0, heading: "Summary", body }, opts)).toMatchObject({ ok: true })
    expect(status(session, opts)).toMatchObject({ ok: true, received: [expect.objectContaining({ index: 0, part: 0, parts: 1 })], missing: [] })
    expect(finalize(session, opts)).toMatchObject({ ok: true, parts: 1 })
    expect(read_document({ reviewRoot, headSha: HEAD_SHA }, opts)).toMatchObject({ ok: true, sections: [{ heading: "Summary", body: "Replacement" }] })
  }))

  test("abort removes the staging session and its parts without creating a document", () => withFixture(({ opts, reviewRoot, reviewPath }) => {
    const session = { reviewRoot, staging_id: stagingId(begin({ reviewRoot, target: "document", headSha: HEAD_SHA, expected_sections: 1 }, opts)) }
    expect(append({ ...session, index: 0, heading: "Summary", body: "Unfinished" }, opts)).toMatchObject({ ok: true })
    const directory = join(reviewPath, HEAD_SHA, ".staging", "document")
    expect(fs.existsSync(directory)).toBe(true)
    expect(abort(session, opts)).toEqual({ ok: true, staging_id: session.staging_id })
    expect(fs.existsSync(directory)).toBe(false)
    expect(status(session, opts)).toEqual({ ok: false, reason: "unknown-staging" })
    expect(fs.existsSync(join(reviewPath, HEAD_SHA, "REVIEW_DOCUMENT.md"))).toBe(false)
  }))

  test("merges string, array and object input parts identically to a single write", () => withFixture(({ opts, reviewRoot }) => {
    const input = { description: "word ".repeat(400) + "end 👍", files: [{ path: "a.ts" }, { path: "b.ts" }], metadata: { first: true, second: 2 } }
    const direct = written(write_input({ reviewRoot, input }, opts))
    const bytes = fs.readFileSync(direct.path)
    const session = { reviewRoot, staging_id: stagingId(begin({ reviewRoot, target: "input" }, opts)) }
    const chunks = [
      { key: "description", values: ["word ".repeat(400), "end 👍"] },
      { key: "files", values: [[{ path: "a.ts" }], [{ path: "b.ts" }]] },
      { key: "metadata", values: [{ first: true }, { second: 2 }] },
    ]
    for (const { key, values } of chunks) for (const part of [1, 0]) {
      expect(append({ ...session, key, part, parts: 2, value: values[part] }, opts)).toMatchObject({ ok: true })
    }
    expect(finalize({ ...session, expected_keys: Object.keys(input) }, opts)).toMatchObject({ ok: true, path: direct.path, sha256: direct.sha256, keys: Object.keys(input), parts: 6 })
    expect(fs.readFileSync(direct.path)).toEqual(bytes)
  }))

  test("roundtrips a nested path split and repeated object string keys in part order", () => withFixture(({ opts, reviewRoot }) => {
    const patch = "line 👍\n".repeat(900)
    const input = { file_map: { "src/a.ts": { patch, labels: ["a", "b"], note: "firstlast" } } }
    const direct = written(write_input({ reviewRoot, input }, opts))
    const session = { reviewRoot, staging_id: stagingId(begin({ reviewRoot, target: "input" }, opts)) }
    const parts = [
      { value: { "src/a.ts": { labels: ["a"], note: "first" } } },
      { path: ["src/a.ts", "patch"], chunk: patch.slice(0, 3500) },
      { path: ["src/a.ts", "patch"], chunk: patch.slice(3500) },
      { value: { "src/a.ts": { labels: ["b"], note: "last" } } },
    ]
    for (const part of [3, 2, 1, 0]) expect(append({ ...session, key: "file_map", part, parts: parts.length, ...parts[part] }, opts)).toMatchObject({ ok: true })
    const result = finalize({ ...session, expected_keys: ["file_map"] }, opts)
    expect(result).toMatchObject({ ok: true })
    expect(JSON.parse(fs.readFileSync(direct.path, "utf8"))).toEqual(JSON.parse(direct.text))
  }))

  test("rejects conflicting non-string scalars without replacing an input checkpoint", () => withFixture(({ opts, reviewRoot }) => {
    const direct = written(write_input({ reviewRoot, input: { metadata: { count: 1 } } }, opts))
    const session = { reviewRoot, staging_id: stagingId(begin({ reviewRoot, target: "input" }, opts)) }
    expect(append({ ...session, key: "metadata", part: 0, parts: 2, value: { count: 1 } }, opts)).toMatchObject({ ok: true })
    expect(append({ ...session, key: "metadata", part: 1, parts: 2, value: { count: 2 } }, opts)).toEqual({ ok: false, reason: "merge-conflict" })
    expect(fs.readFileSync(direct.path, "utf8")).toBe(direct.text)
  }))

  test("status lists received parts, missing parts and missing sections", () => withFixture(({ opts, reviewRoot }) => {
    const session = { reviewRoot, staging_id: stagingId(begin({ reviewRoot, target: "document", headSha: HEAD_SHA, expected_sections: 3 }, opts)) }
    expect(append({ ...session, index: 1, part: 1, parts: 3, body: "Middle" }, opts)).toMatchObject({ ok: true })
    expect(append({ ...session, index: 0, heading: "Summary", body: "Complete" }, opts)).toMatchObject({ ok: true })
    expect(status(session, opts)).toMatchObject({ ok: true, staging_id: session.staging_id,
      received: [{ index: 1, part: 1, parts: 3, bytes: 6, sha256: sha256(Buffer.from("Middle")) }, { index: 0, part: 0, parts: 1 }],
      missing: [{ index: 1, parts: [0, 2] }, { index: 2 }],
    })
  }))
})

describe("review persist structured data", () => {
  test("roundtrips facts through deterministic YAML at the namespace root with bounded lines", () => withFixture(({ opts, reviewRoot, reviewPath }) => {
    const fact = { source: "src/example.ts:10", fact: "verified evidence ".repeat(300), confidence: 0.9, verified_in_round: 2 }
    const facts = { open_questions: [BODY], facts: [fact], config_absent_at_base: false }
    const first = written(write_facts({ reviewRoot, facts }, opts))
    expect(first.path).toBe(join(reviewPath, "verified_facts.yaml"))
    expectLineLimit(first.text)
    expect(yaml.load(first.text)).toEqual(facts)
    expect(read_facts({ reviewRoot }, opts)).toEqual({ ok: true, facts, sha256: first.sha256, lines: first.lines })
    const second = written(write_facts({ reviewRoot, facts: {
      config_absent_at_base: false, facts: [{ verified_in_round: 2, confidence: 0.9, fact: fact.fact, source: fact.source }], open_questions: [BODY],
    } }, opts))
    expect(second.text).toBe(first.text)
    expect(second.sha256).toBe(first.sha256)
  }))

  test("reads missing facts without bootstrapping and rejects malformed mappings", () => withFixture(({ opts, reviewRoot, reviewPath, workspace }) => {
    expect(read_facts({ reviewRoot }, opts)).toEqual({ ok: false, reason: "not-found" })
    expect(read_document({ reviewRoot, headSha: HEAD_SHA }, opts)).toEqual({ ok: false, reason: "not-found" })
    expect(fs.existsSync(join(workspace, ".corvus"))).toBe(false)
    fs.mkdirSync(reviewPath, { recursive: true })
    const path = join(reviewPath, "verified_facts.yaml")
    for (const text of ["facts: [", "[]\n", "null\n", "facts: &facts\n  self: *facts\n"]) {
      fs.writeFileSync(path, text)
      expect(read_facts({ reviewRoot }, opts)).toEqual({ ok: false, reason: "invalid-yaml" })
      expect(fs.readFileSync(path, "utf8")).toBe(text)
    }
  }, true))

  test("writes only allowlisted head-scoped YAML records without replacing default metadata", () => withFixture(({ opts, reviewRoot, reviewPath }) => {
    const original = written(write_meta({ reviewRoot, headSha: HEAD_SHA, meta: { posted: false } }, opts))
    for (const name of ["decision.yaml", "completion.yaml", "authorization.yaml", "review-action.yaml"]) {
      const meta = { body: BODY, decision: "local_only" }
      const result = written(write_meta({ reviewRoot, headSha: HEAD_SHA, name, meta }, opts))
      expect(result.path).toBe(join(reviewPath, HEAD_SHA, name))
      expect(yaml.load(result.text)).toEqual(meta)
      expect(fs.readFileSync(original.path, "utf8")).toBe(original.text)
    }
    expect(written(write_meta({ reviewRoot, headSha: HEAD_SHA, name: "meta.yaml", meta: { posted: false } }, opts)).text).toBe(original.text)
  }))

  test("rejects unknown record names before creating any storage", () => withFixture(({ opts, reviewRoot, workspace }) => {
    const persist = createPersistExecutor(opts.reviewStateRoot)
    for (const name of ["unknown.yaml", "../meta.yaml", "/tmp/meta.yaml", "verified_facts.yaml", "lock.yaml", "meta.yaml\n", "", null, 1]) {
      expect(JSON.parse(persist({ op: "write_meta", reviewRoot, headSha: HEAD_SHA, name, meta: {} })))
        .toEqual({ ok: false, reason: "unknown-record" })
    }
    expect(fs.existsSync(join(workspace, ".corvus"))).toBe(false)
  }, true))

  test("chunks long strings and hunk arrays losslessly into pretty JSON within the line ceiling", () => withFixture(({ opts, reviewRoot, reviewPath }) => {
    const description = `${BODY}\n${'"\\\t👍 word '.repeat(300)}`
    const hunks = ["@@ -1 +1 @@\n-old\n+new\n", `@@ -3 +3 @@\n+${"x".repeat(2_500)}\n`]
    const input = { description, files: [{ path: "src/example.ts", diff_hunks: hunks }], exact: "a".repeat(1_500) }
    const result = written(write_input({ reviewRoot, input }, opts))
    const parsed = JSON.parse(result.text)
    expect(result.path).toBe(join(reviewPath, "review-input.json"))
    expect(result.text).toBe(JSON.stringify(parsed, null, 2) + "\n")
    expect(result.text).toContain('\n  "description_chunks": [\n    "')
    expect(parsed.description).toBeUndefined()
    expect(parsed.description_chunks.length).toBeGreaterThan(1)
    expect(parsed.description_chunks.join("")).toBe(description)
    expect(parsed.description_chunks.every((part: string) => part.length <= 1_500)).toBe(true)
    expect(parsed.exact).toBe(input.exact)
    expect(parsed.files[0].diff_hunks).toBeUndefined()
    expect(parsed.files[0].hunk_lines.slice(0, 3)).toEqual(["@@ -1 +1 @@\n", "-old\n", "+new\n"])
    expect(parsed.files[0].hunk_lines.join("")).toBe(hunks.join(""))
    expectLineLimit(result.text)
  }))

  test("roundtrips metadata through js-yaml with deterministic nested key order", () => withFixture(({ opts, reviewRoot, reviewPath }) => {
    const meta = { zeta: BODY, nested: { zebra: true, alpha: ["one", "two"] }, alpha: 1 }
    const first = written(write_meta({ reviewRoot, headSha: HEAD_SHA, meta }, opts))
    expect(first.path).toBe(join(reviewPath, HEAD_SHA, "meta.yaml"))
    expect(yaml.load(first.text)).toEqual(meta)
    expect(Object.keys(yaml.load(first.text) as object)).toEqual(["alpha", "nested", "zeta"])
    expect(first.text.indexOf("  alpha:")).toBeLessThan(first.text.indexOf("  zebra:"))
    const second = written(write_meta({ reviewRoot, headSha: HEAD_SHA, meta: { alpha: 1, nested: { alpha: ["one", "two"], zebra: true }, zeta: BODY } }, opts))
    expect(second.text).toBe(first.text)
    expect(second.sha256).toBe(first.sha256)
  }))

  test("chains write_candidate, measure, freeze and verify without direct candidate or artifact writes", () => withFixture(({ workspace, opts, reviewRoot, reviewPath }) => {
    const persist = createPersistExecutor(opts.reviewStateRoot)
    const payload = createReviewToolExecutors(workspace)
    const write = JSON.parse(persist({ op: "write_candidate", reviewRoot, candidate }))
    expect(write.ok).toBe(true)
    expect(write.path).toBe(join(reviewPath, "candidate.json"))
    const measured = JSON.parse(payload.payload({ op: "measure", candidatePath: write.path }))
    expect(measured).toMatchObject({ ok: true, sha256: write.sha256, violations: [] })
    const frozen = JSON.parse(payload.payload({ op: "freeze", candidatePath: write.path, artifactPath: join(reviewPath, "artifact.json") }))
    expect(frozen).toEqual({ ok: true, artifactPath: join(reviewPath, "artifact.json"), sha256: write.sha256, measurements: measured.measurements })
    const verified = JSON.parse(payload.verify({ op: "verify", artifactPath: frozen.artifactPath, expectedSha256: frozen.sha256 }))
    expect(verified).toEqual({ ok: true, sha256Match: true, canonical: true, violations: [], measurements: measured.measurements })
    expect(JSON.parse(fs.readFileSync(frozen.artifactPath, "utf8"))).toEqual(candidate)
    for (const result of [write, measured, frozen, verified]) expect(JSON.stringify(result)).not.toContain(BODY)
  }))

  test("rejects invalid candidates without persisting or echoing their body or unknown keys", () => withFixture(({ opts, reviewRoot, reviewPath }) => {
    const unknownFieldCandidate = { ...candidate, [BODY]: true }
    for (const [invalid, reason] of [
      [{ ...candidate, commit_id: "not-a-sha" }, "invalid-field"],
      [unknownFieldCandidate, "unknown-field"],
    ] as const) {
      const result = write_candidate({ reviewRoot, candidate: invalid }, opts)
      expect(result).toEqual({ ok: false, reason })
      expect(JSON.stringify(result)).not.toContain(BODY)
    }
    expect(fs.existsSync(reviewPath)).toBe(false)
  }))
})

const operations = [
  { op: "write_document", args: { headSha: HEAD_SHA, sections: [{ heading: "Summary", body: BODY }] }, leaf: `${HEAD_SHA}/REVIEW_DOCUMENT.md` },
  { op: "read_document", args: { headSha: HEAD_SHA }, leaf: `${HEAD_SHA}/REVIEW_DOCUMENT.md` },
  { op: "write_input", args: { input: { body: BODY } }, leaf: "review-input.json" },
  { op: "write_meta", args: { headSha: HEAD_SHA, meta: { body: BODY } }, leaf: `${HEAD_SHA}/meta.yaml` },
  { op: "write_candidate", args: { candidate }, leaf: "candidate.json" },
  { op: "write_facts", args: { facts: { facts: [], open_questions: [], config_absent_at_base: false } }, leaf: "verified_facts.yaml" },
  { op: "read_facts", args: {}, leaf: "verified_facts.yaml" },
] as const

describe("review persist containment", () => {
  for (const { op, args, leaf } of operations.filter(({ op }) => op.startsWith("write_"))) {
    test(`${op} bootstraps a fresh workspace using the prompt's workspace-relative namespace`, () => withFixture(({ opts, workspace }) => {
      const reviewRoot = ".corvus/reviews/pr42"
      expect(fs.existsSync(join(workspace, ".corvus"))).toBe(false)
      const result = JSON.parse(createPersistExecutor(opts.reviewStateRoot)({ op, ...args, reviewRoot }))
      expect(written(result).path).toBe(join(workspace, reviewRoot, leaf))
    }, true))
  }

  test("checks containment before bootstrap and rejects redirected host roots and namespace ancestors", () => withFixture(({ opts, workspace, outsidePath }) => {
    const persist = createPersistExecutor(opts.reviewStateRoot)
    for (const reviewRoot of ["../outside", outsidePath]) {
      expect(JSON.parse(persist({ op: "write_facts", reviewRoot, facts: {} }))).toEqual({ ok: false, reason: "path-outside-root" })
      expect(fs.existsSync(join(workspace, ".corvus"))).toBe(false)
    }
    fs.mkdirSync(outsidePath)
    fs.symlinkSync(outsidePath, join(workspace, ".corvus"))
    expect(write_facts({ reviewRoot: "pr", facts: {} }, opts)).toEqual({ ok: false, reason: "path-outside-root" })
    expect(fs.readdirSync(outsidePath)).toEqual([])
    fs.unlinkSync(join(workspace, ".corvus"))
    fs.mkdirSync(opts.reviewStateRoot, { recursive: true })
    fs.symlinkSync(outsidePath, join(opts.reviewStateRoot, "pr"))
    expect(write_facts({ reviewRoot: "pr/head", facts: {} }, opts)).toEqual({ ok: false, reason: "path-outside-root" })
    expect(fs.readdirSync(outsidePath)).toEqual([])
  }, true))

  for (const { op, args, leaf } of operations) {
    for (const kind of ["parent traversal", "absolute outside root", "symlink leaf"] as const) {
      test(`${op} rejects ${kind} without modifying the outside target or exposing body text`, () => withFixture(({ opts, reviewRoot, reviewPath, outsidePath }) => {
        fs.mkdirSync(outsidePath)
        const outsideFile = join(outsidePath, "sentinel")
        fs.writeFileSync(outsideFile, BODY)
        let root = kind === "parent traversal" ? "../outside" : outsidePath
        const path = join(reviewPath, leaf)
        if (kind === "symlink leaf") {
          root = reviewRoot
          fs.mkdirSync(dirname(path), { recursive: true })
          fs.symlinkSync(outsideFile, path)
        }
        const result = JSON.parse(createPersistExecutor(opts.reviewStateRoot)({ op, ...args, reviewRoot: root }))
        expect(result).toEqual({ ok: false, reason: kind === "symlink leaf" ? "symlink-target" : "path-outside-root" })
        expect(JSON.stringify(result)).not.toContain(BODY)
        expect(fs.readFileSync(outsideFile, "utf8")).toBe(BODY)
        expect(fs.readdirSync(outsidePath)).toEqual(["sentinel"])
        if (kind === "symlink leaf") expect(fs.lstatSync(path).isSymbolicLink()).toBe(true)
        else expect(fs.existsSync(reviewPath)).toBe(false)
      }))
    }
  }
})

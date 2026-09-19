import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LIMITS, canonicalize, freeze, measure, measureFile, preview, verify } from "../review-payload"
import type { CandidateRequest, ReviewPayloadFs, ReviewPayloadOptions } from "../review-payload"
import { post } from "../review-post"

type Comment = CandidateRequest["comments"][number]

const comment = (body = "Inline body"): Comment => ({ path: "src/example.ts", line: 10, side: "RIGHT", body })
const candidate = (body = "Review body", comments: Comment[] = []): CandidateRequest => ({
  commit_id: "a".repeat(40), event: "COMMENT", body, comments,
})
const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

function measured(req: unknown) {
  const result = measure(req)
  if (!("measurements" in result)) throw new Error(`Expected measurements, got ${JSON.stringify(result)}`)
  return result
}

type Fixture = {
  opts: ReviewPayloadOptions
  candidatePath: string
  artifactPath: string
  outsidePath: string
}

function withFixture(run: (fixture: Fixture) => void): void {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corvus-review-payload-")))
  try {
    const root = join(tempRoot, "review-state")
    fs.mkdirSync(root)
    run({
      opts: { reviewStateRoot: fs.realpathSync(root) },
      candidatePath: join(root, "candidate.json"),
      artifactPath: join(root, "artifact.json"),
      outsidePath: join(tempRoot, "outside.json"),
    })
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

function readbackFs(artifactPath: string, change: (bytes: Buffer) => Buffer): ReviewPayloadFs {
  let written = false
  return {
    realpathSync: fs.realpathSync,
    statSync: fs.statSync,
    lstatSync: fs.lstatSync,
    writeFileSync(path, bytes) {
      fs.writeFileSync(path, bytes)
      if (path === artifactPath) written = true
    },
    readFileSync(path) {
      const bytes = fs.readFileSync(path)
      return written && path === artifactPath ? change(bytes) : bytes
    },
  }
}

function totalBoundary(): CandidateRequest {
  const req = candidate("x", Array.from({ length: 6 }, () => comment("c".repeat(4000))))
  const filler = 48000 - [...canonicalize(req)].length
  expect(filler).toBeGreaterThan(0)
  req.body += "x".repeat(filler)
  expect(req.body.length).toBeLessThanOrEqual(24000)
  return req
}

const escapeCases = ["parent traversal", "absolute outside root", "symlink outside root"] as const

function escapedPath(kind: typeof escapeCases[number], fixture: Fixture): string {
  if (kind === "parent traversal") return "../x.json"
  if (kind === "absolute outside root") return fixture.outsidePath
  const link = join(fixture.opts.reviewStateRoot, "escape.json")
  fs.symlinkSync(fixture.outsidePath, link)
  return link
}

describe("review payload measure and canonicalize", () => {
  test("measures ASCII bodies and the complete canonical serialization", () => {
    const req = candidate("ASCII", [comment("inline")])
    const expected = JSON.stringify(req, null, 2) + "\n"
    const result = measured(req)

    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
    expect(canonicalize(req)).toBe(expected)
    expect(result.canonical).toBe(expected)
    expect(result.measurements).toEqual({
      body: { codePoints: 5, utf8Bytes: 5 },
      comments: [{ index: 0, codePoints: 6, utf8Bytes: 6 }],
      total: { codePoints: expected.length, utf8Bytes: Buffer.byteLength(expected, "utf8") },
    })
  })

  test("counts non-ASCII é ü ñ as code points rather than UTF-8 bytes", () => {
    const result = measured(candidate("éüñ", [comment("éüñ")]))
    expect(result.ok).toBe(true)
    expect(result.measurements.body).toEqual({ codePoints: 3, utf8Bytes: 6 })
    expect(result.measurements.comments).toEqual([{ index: 0, codePoints: 3, utf8Bytes: 6 }])
    expect(result.measurements.total.utf8Bytes).toBe(result.measurements.total.codePoints + 6)
    expect(result.canonical).toContain("éüñ")
  })

  test("distinguishes code points, UTF-16 length and UTF-8 bytes for surrogate pairs and ZWJ emoji", () => {
    const body = "👍👩‍💻"
    const result = measured(candidate(body, [comment(body)]))
    expect(result.ok).toBe(true)
    expect(result.measurements.body).toEqual({ codePoints: 4, utf8Bytes: 15 })
    expect(result.measurements.comments).toEqual([{ index: 0, codePoints: 4, utf8Bytes: 15 }])
    expect(body.length).toBe(7)
    expect(result.measurements.body.codePoints).not.toBe(body.length)
    expect(body.length).not.toBe(result.measurements.body.utf8Bytes)
    expect(result.measurements.body.codePoints).not.toBe(result.measurements.body.utf8Bytes)
    expect(result.measurements.total).toEqual({
      codePoints: [...result.canonical].length,
      utf8Bytes: Buffer.byteLength(result.canonical, "utf8"),
    })
    expect(result.canonical.length).not.toBe(result.measurements.total.codePoints)
    expect(result.canonical.length).not.toBe(result.measurements.total.utf8Bytes)
  })

  test("measures JSON escapes as decoded data and counts their canonical spelling in the total", () => {
    const body = '"\\\n\t\u0000'
    const result = measured(candidate(body, [comment(body)]))
    const baseline = measured(candidate("x", [comment("x")]))
    const encoded = '"\\\"\\\\\\n\\t\\u0000"'

    expect(result.ok).toBe(true)
    expect(result.measurements.body).toEqual({ codePoints: 5, utf8Bytes: 5 })
    expect(result.measurements.comments).toEqual([{ index: 0, codePoints: 5, utf8Bytes: 5 }])
    expect(result.canonical).toContain(`"body": ${encoded}`)
    expect(JSON.parse(result.canonical).body).toBe(body)
    expect(result.measurements.total).toEqual({
      codePoints: baseline.measurements.total.codePoints + 2 * (14 - 1),
      utf8Bytes: baseline.measurements.total.utf8Bytes + 2 * (14 - 1),
    })
  })

  test("preserves CRLF body data, uses only LF formatting and counts the final LF", () => {
    const req = candidate("a\r\nb")
    const result = measured(req)
    const withoutFinalLf = JSON.stringify(req, null, 2)

    expect(result.measurements.body).toEqual({ codePoints: 4, utf8Bytes: 4 })
    expect(JSON.parse(result.canonical).body).toBe("a\r\nb")
    expect(result.canonical).toContain('"body": "a\\r\\nb"')
    expect(result.canonical).not.toContain("\r")
    expect(result.canonical).toBe(withoutFinalLf + "\n")
    expect(result.measurements.total).toEqual({
      codePoints: [...withoutFinalLf].length + 1,
      utf8Bytes: Buffer.byteLength(withoutFinalLf, "utf8") + 1,
    })
  })

  test("orders request and comment keys and omits absent optional comment keys", () => {
    const req: CandidateRequest = {
      comments: [
        { body: "Range", start_side: "RIGHT", side: "RIGHT", start_line: 8, line: 10, path: "src/example.ts" },
        { body: "Single", side: "LEFT", line: 3, path: "src/other.ts" },
      ],
      body: "Review body", event: "COMMENT", commit_id: "a".repeat(40),
    }
    const canonical = canonicalize(req)
    const parsed = JSON.parse(canonical)
    expect(Object.keys(parsed)).toEqual(["commit_id", "event", "body", "comments"])
    expect(Object.keys(parsed.comments[0])).toEqual(["path", "line", "side", "start_line", "start_side", "body"])
    expect(Object.keys(parsed.comments[1])).toEqual(["path", "line", "side", "body"])
    expect(canonical).toBe(JSON.stringify(candidate("Review body", [
      { path: "src/example.ts", line: 10, side: "RIGHT", start_line: 8, start_side: "RIGHT", body: "Range" },
      { path: "src/other.ts", line: 3, side: "LEFT", body: "Single" },
    ]), null, 2) + "\n")
    expect(measured(req).canonical).toBe(canonical)
  })

  test("rejects an unknown top-level key", () => {
    const req = { ...candidate(), extra: true }
    expect(measure(req)).toEqual({ ok: false, reason: "unknown-field", field: "extra" })
    expect(() => canonicalize(req)).toThrow(TypeError)
  })

  test("rejects an unknown comment key", () => {
    const req = { ...candidate(), comments: [{ ...comment(), extra: true }] }
    expect(measure(req)).toEqual({ ok: false, reason: "unknown-field", field: "comments[0].extra" })
    expect(() => canonicalize(req)).toThrow(TypeError)
  })

  test("rejects an invalid review event", () => {
    const req = { ...candidate(), event: "DISMISS" }
    expect(measure(req)).toEqual({ ok: false, reason: "invalid-field", field: "event" })
    expect(() => canonicalize(req as CandidateRequest)).toThrow(TypeError)
  })

  test("hashes the exact canonical UTF-8 including its final LF with SHA-256", () => {
    const req = candidate("é 👍 👩‍💻\n", [comment('Quote: "')])
    const expected = Buffer.from(JSON.stringify(req, null, 2) + "\n", "utf8")
    const result = measured(req)
    expect(Buffer.from(result.canonical, "utf8").equals(expected)).toBe(true)
    expect(result.sha256).toBe(createHash("sha256").update(expected).digest("hex"))
    expect(result.sha256).not.toBe(sha256(expected.subarray(0, -1)))
  })
})

describe("review payload limits", () => {
  test("accepts a body of exactly 24,000 code points", () => {
    expect(LIMITS).toEqual({ body: 24000, comment: 4000, total: 48000 })
    const result = measured(candidate("a".repeat(24000)))
    expect(result.ok).toBe(true)
    expect(result.measurements.body).toEqual({ codePoints: 24000, utf8Bytes: 24000 })
    expect(result.violations).toEqual([])
  })

  test("rejects a body of 24,001 code points with a codePoints violation", () => {
    const result = measured(candidate("a".repeat(24001)))
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual((["codePoints", "utf8Bytes"] as const).map(unit => ({
      field: "body", unit, limit: 24000, actual: 24001, reason: "limit-exceeded",
    })))
  })

  test("rejects 24,000 three-byte code points only in the utf8Bytes unit", () => {
    const result = measured(candidate("€".repeat(24000)))
    expect(result.ok).toBe(false)
    expect(result.measurements.body).toEqual({ codePoints: 24000, utf8Bytes: 72000 })
    expect(result.violations).toEqual([
      { field: "body", unit: "utf8Bytes", limit: 24000, actual: 72000, reason: "limit-exceeded" },
      { field: "total", unit: "utf8Bytes", limit: 48000, actual: result.measurements.total.utf8Bytes, reason: "limit-exceeded" },
    ])
    expect(result.violations.some(violation => violation.unit === "codePoints")).toBe(false)
  })

  test("accepts a comment of exactly 4,000 code points", () => {
    const result = measured(candidate("Review body", [comment("c".repeat(4000))]))
    expect(result.ok).toBe(true)
    expect(result.measurements.comments).toEqual([{ index: 0, codePoints: 4000, utf8Bytes: 4000 }])
    expect(result.violations).toEqual([])
  })

  test("rejects a comment of 4,001 code points with its indexed field", () => {
    const result = measured(candidate("Review body", [comment(), comment("c".repeat(4001))]))
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual((["codePoints", "utf8Bytes"] as const).map(unit => ({
      field: "comments[1].body", unit, limit: 4000, actual: 4001, reason: "limit-exceeded",
    })))
  })

  test("accepts a computed canonical total of exactly 48,000 code points", () => {
    const result = measured(totalBoundary())
    expect(result.measurements.total.codePoints).toBe(48000)
    expect(result.measurements.total.utf8Bytes).toBe(48000)
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  test("rejects one extra code point beyond a computed canonical total of 48,000", () => {
    const req = totalBoundary()
    expect(measured(req).measurements.total.codePoints).toBe(48000)
    const result = measured({ ...req, body: req.body + "x" })
    expect(result.ok).toBe(false)
    expect(result.measurements.total.codePoints).toBe(48001)
    expect(result.violations).toEqual((["codePoints", "utf8Bytes"] as const).map(unit => ({
      field: "total", unit, limit: 48000, actual: 48001, reason: "limit-exceeded",
    })))
  })
})

describe("review payload freeze", () => {
  test("keeps in-budget canonical bytes identical and returns fitted:false after successful read-back", () => withFixture(fixture => {
    const { opts, candidatePath, artifactPath } = fixture
    const req = candidate("é 👍\r\nReview", [comment("Inline")])
    fs.writeFileSync(candidatePath, JSON.stringify(req, null, 4))
    const reads: string[] = []
    const io: ReviewPayloadFs = {
      ...fs,
      readFileSync(path) {
        reads.push(path)
        return fs.readFileSync(path)
      },
    }
    const result = freeze(candidatePath, artifactPath, { ...opts, fs: io })
    const bytes = fs.readFileSync(artifactPath)

    expect(bytes.equals(Buffer.from(canonicalize(req), "utf8"))).toBe(true)
    expect(result).toEqual({
      ok: true, artifactPath, sha256: sha256(bytes), measurements: measured(req).measurements,
      fitted: false, omitted: { comments: 0, findings: 0 },
    })
    expect(reads).toEqual([candidatePath, artifactPath])
    expect(fs.readFileSync(candidatePath, "utf8")).toBe(JSON.stringify(req, null, 4))
  }))

  test("fits an oversized body instead of returning budget-violation and verify accepts the written digest", () => withFixture(({ opts, candidatePath, artifactPath }) => {
    const req = candidate("Recognizable original summary: " + "a".repeat(24001), [comment("Inline")])
    const original = canonicalize(req)
    fs.writeFileSync(candidatePath, original)
    const result = freeze(candidatePath, artifactPath, opts)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("Expected fitted artifact")
    const bytes = fs.readFileSync(artifactPath)
    const fitted = JSON.parse(bytes.toString("utf8")) as CandidateRequest
    expect(result).toEqual({
      ok: true, artifactPath, sha256: sha256(bytes), measurements: measured(fitted).measurements,
      fitted: true, omitted: { comments: 1, findings: 0 },
    })
    expect(fitted.body.startsWith("Recognizable original summary: ")).toBe(true)
    expect(fitted.body.endsWith("Review limits: 1 findings omitted for size")).toBe(true)
    expect(fitted.comments).toEqual([])
    expect(result.sha256).not.toBe(sha256(original))
    expect(measured(fitted).violations).toEqual([])
    expect(verify(artifactPath, result.sha256, opts)).toEqual({
      ok: true, sha256Match: true, canonical: true, violations: [], measurements: result.measurements,
    })
    expect(fs.readFileSync(candidatePath, "utf8")).toBe(original)
  }))

  const oversizedCases: Array<[string, CandidateRequest]> = [
    ["inline comment", candidate("Summary", [comment("a".repeat(4001))])],
    ["multibyte body", candidate("界😀".repeat(24000))],
    ["canonical escapes", candidate('"\\\n'.repeat(8000))],
    ["notice", candidate("> " + "a".repeat(24001))],
    ["headlines", candidate("## Standards\n" + "a".repeat(24001) + "\n## Spec\n" + "b".repeat(24001))],
    ["unbounded marker prefix", candidate("<!-- corvus-review " + "a".repeat(24001))],
    ["comment path", candidate("Summary", [{ ...comment(), path: '"'.repeat(48001) }])],
  ]
  for (const [name, req] of oversizedCases) {
    test(`freezes oversized ${name} without a size rejection`, () => withFixture(({ opts, candidatePath, artifactPath }) => {
      expect(measured(req).ok).toBe(false)
      fs.writeFileSync(candidatePath, canonicalize(req))
      const result = freeze(candidatePath, artifactPath, opts)
      expect(result).toMatchObject({ ok: true, fitted: true })
      expect(JSON.stringify(result)).not.toContain("budget-violation")
      if (!result.ok) throw new Error("Expected fitted artifact")
      expect(verify(artifactPath, result.sha256, opts)).toMatchObject({ ok: true, sha256Match: true, violations: [] })
      expect(JSON.parse(fs.readFileSync(artifactPath, "utf8")).comments).toEqual([])
    }))
  }

  test("rejects a candidate BOM", () => withFixture(({ opts, candidatePath, artifactPath }) => {
    fs.writeFileSync(candidatePath, "\ufeff" + JSON.stringify(candidate()))
    expect(freeze(candidatePath, artifactPath, opts)).toEqual({ ok: false, reason: "candidate-bom" })
    expect(fs.existsSync(artifactPath)).toBe(false)
  }))

  test("rejects a candidate JSON parse error", () => withFixture(({ opts, candidatePath, artifactPath }) => {
    fs.writeFileSync(candidatePath, '{"commit_id":')
    expect(freeze(candidatePath, artifactPath, opts)).toEqual({ ok: false, reason: "candidate-parse-error" })
    expect(fs.existsSync(artifactPath)).toBe(false)
  }))

  test("rejects truncated read-back with expected and actual byte counts", () => withFixture(({ opts, candidatePath, artifactPath }) => {
    const req = candidate("é 👍")
    fs.writeFileSync(candidatePath, JSON.stringify(req))
    const expectedBytes = Buffer.byteLength(canonicalize(req), "utf8")
    const io = readbackFs(artifactPath, bytes => bytes.subarray(0, bytes.length - 1))
    expect(freeze(candidatePath, artifactPath, { ...opts, fs: io })).toEqual({
      ok: false, reason: "readback-mismatch", expectedBytes, actualBytes: expectedBytes - 1,
    })
  }))

  test("rejects unequal read-back even when the byte count is unchanged", () => withFixture(({ opts, candidatePath, artifactPath }) => {
    const req = candidate()
    fs.writeFileSync(candidatePath, JSON.stringify(req))
    const expectedBytes = Buffer.byteLength(canonicalize(req), "utf8")
    const io = readbackFs(artifactPath, bytes => {
      const changed = Buffer.from(bytes)
      changed[0] ^= 1
      return changed
    })
    expect(freeze(candidatePath, artifactPath, { ...opts, fs: io })).toEqual({
      ok: false, reason: "readback-mismatch", expectedBytes, actualBytes: expectedBytes,
    })
  }))

  for (const kind of escapeCases) {
    for (const position of ["candidate", "artifact"] as const) {
      test(`rejects ${kind} in the ${position} position`, () => withFixture(fixture => {
        const { opts, candidatePath, artifactPath, outsidePath } = fixture
        const bytes = canonicalize(candidate())
        fs.writeFileSync(candidatePath, bytes)
        fs.writeFileSync(outsidePath, bytes)
        const escape = escapedPath(kind, fixture)
        const result = position === "candidate"
          ? freeze(escape, artifactPath, opts)
          : freeze(candidatePath, escape, opts)
        expect(result).toEqual({ ok: false, reason: "path-outside-root", path: escape })
        expect(fs.existsSync(artifactPath)).toBe(false)
        expect(fs.readFileSync(outsidePath, "utf8")).toBe(bytes)
      }))
    }
  }
})

describe("review payload verify", () => {
  test("accepts a canonical artifact with the expected hash", () => withFixture(({ opts, artifactPath }) => {
    const req = candidate("é 👍\r\nReview", [comment()])
    const bytes = Buffer.from(JSON.stringify(req, null, 2) + "\n", "utf8")
    fs.writeFileSync(artifactPath, bytes)
    expect(verify(artifactPath, sha256(bytes), opts)).toEqual({
      ok: true, sha256Match: true, canonical: true, violations: [], measurements: measured(req).measurements,
    })
  }))

  test("rejects a hash mismatch while recognizing canonical bytes", () => withFixture(({ opts, artifactPath }) => {
    const canonical = canonicalize(candidate())
    fs.writeFileSync(artifactPath, canonical)
    expect(verify(artifactPath, sha256(canonical + "x"), opts)).toMatchObject({
      ok: false, sha256Match: false, canonical: true, reason: "sha256-mismatch", violations: [],
    })
  }))

  const formattingCases: Array<{ name: string; content: (req: CandidateRequest) => string; reason: string }> = [
    { name: "four-space indentation", content: req => JSON.stringify(req, null, 4) + "\n", reason: "non-canonical" },
    { name: "CRLF formatting", content: req => canonicalize(req).replaceAll("\n", "\r\n"), reason: "artifact-crlf" },
    { name: "a BOM", content: req => "\ufeff" + canonicalize(req), reason: "artifact-bom" },
    { name: "a missing final LF", content: req => canonicalize(req).slice(0, -1), reason: "missing-final-lf" },
    {
      name: "wrong key order",
      content: req => JSON.stringify({ body: req.body, event: req.event, comments: req.comments, commit_id: req.commit_id }, null, 2) + "\n",
      reason: "non-canonical",
    },
  ]
  for (const { name, content, reason } of formattingCases) {
    test(`rejects ${name} as non-canonical even with a matching hash`, () => withFixture(({ opts, artifactPath }) => {
      const bytes = Buffer.from(content(candidate()), "utf8")
      fs.writeFileSync(artifactPath, bytes)
      expect(verify(artifactPath, sha256(bytes), opts)).toMatchObject({
        ok: false, sha256Match: true, canonical: false, reason,
      })
      expect(fs.readFileSync(artifactPath).equals(bytes)).toBe(true)
    }))
  }

  test("rejects an over-limit canonical artifact and reports its violations", () => withFixture(({ opts, artifactPath }) => {
    const bytes = canonicalize(candidate("a".repeat(24001)))
    fs.writeFileSync(artifactPath, bytes)
    expect(verify(artifactPath, sha256(bytes), opts)).toMatchObject({
      ok: false, sha256Match: true, canonical: true, reason: "budget-violation",
      violations: [
        { field: "body", unit: "codePoints", limit: 24000, actual: 24001, reason: "limit-exceeded" },
        { field: "body", unit: "utf8Bytes", limit: 24000, actual: 24001, reason: "limit-exceeded" },
      ],
    })
  }))

  test("rejects an artifact with an unknown key", () => withFixture(({ opts, artifactPath }) => {
    const bytes = JSON.stringify({ ...candidate(), extra: true }, null, 2) + "\n"
    fs.writeFileSync(artifactPath, bytes)
    expect(verify(artifactPath, sha256(bytes), opts)).toMatchObject({
      ok: false, sha256Match: true, canonical: false, reason: "unknown-field", field: "extra",
    })
  }))

  for (const kind of escapeCases) {
    test(`rejects ${kind} when verifying an artifact`, () => withFixture(fixture => {
      const bytes = canonicalize(candidate())
      fs.writeFileSync(fixture.outsidePath, bytes)
      const escape = escapedPath(kind, fixture)
      expect(verify(escape, sha256(bytes), fixture.opts)).toEqual({
        ok: false, sha256Match: false, canonical: false, violations: [], measurements: null,
        reason: "path-outside-root", path: escape,
      })
    }))
  }
})

describe("review payload preview", () => {
  test("previews the fitted artifact body and empty comments rather than the over-budget candidate", () => withFixture(({ opts, candidatePath, artifactPath }) => {
    const req = candidate([
      `<!-- corvus-review v1 head:${"a".repeat(40)} -->`,
      "> Draft review notice",
      "## Standards", "Standards headline",
      "## Spec", "Spec headline",
      "Unbounded prose: " + "x".repeat(24001),
    ].join("\n"), [comment("Omitted inline body")])
    const source = canonicalize(req)
    fs.writeFileSync(candidatePath, source)
    const frozen = freeze(candidatePath, artifactPath, opts)
    expect(frozen).toMatchObject({ ok: true, fitted: true })
    if (!frozen.ok) throw new Error("Expected fitted artifact")
    const bytes = fs.readFileSync(artifactPath)
    const result = preview(artifactPath, frozen.sha256, opts)

    expect(result).toEqual({ ok: true, ...JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes), measurements: frozen.measurements })
    if (!result.ok) throw new Error("Expected preview")
    expect(result.body).not.toBe(req.body)
    expect(result.body).toStartWith(req.body.split("\n")[0])
    expect(result.body).toContain("> Draft review notice")
    expect(result.body).toContain("Standards headline")
    expect(result.body).toContain("Spec headline")
    expect(result.body).toEndWith("Review limits: 1 findings omitted for size")
    expect(result.comments).toEqual([])
    expect(fs.readFileSync(candidatePath, "utf8")).toBe(source)
    expect(fs.readFileSync(artifactPath)).toEqual(bytes)
  }))

  test("previews an unfitted artifact with decoded body, all comment anchors and bodies in order", () => withFixture(({ opts, candidatePath, artifactPath }) => {
    const req: CandidateRequest = { ...candidate('Résumé 🚀\r\n"Review"\\', [
      { ...comment('Range\n"body"'), start_line: 8, start_side: "RIGHT" },
      { path: 'src/quoted"name.ts', line: 3, side: "LEFT", body: "Other\t👍" },
    ]), event: "REQUEST_CHANGES" }
    fs.writeFileSync(candidatePath, JSON.stringify(req))
    const frozen = freeze(candidatePath, artifactPath, opts)
    expect(frozen).toMatchObject({ ok: true, fitted: false })
    if (!frozen.ok) throw new Error("Expected unfitted artifact")
    const before = fs.readFileSync(artifactPath)

    expect(preview(artifactPath, frozen.sha256, opts)).toEqual({
      ok: true, ...req, sha256: sha256(before), measurements: frozen.measurements,
    })
    expect(fs.readFileSync(artifactPath)).toEqual(before)
  }))

  test("decodes only the captured verified read and never writes", () => withFixture(({ opts, artifactPath }) => {
    const req = candidate("VERIFIED_BODY", [comment("VERIFIED_COMMENT")])
    const bytes = Buffer.from(canonicalize(req))
    fs.writeFileSync(artifactPath, bytes)
    const reads: string[] = []
    let writes = 0
    const io: ReviewPayloadFs = {
      ...fs,
      readFileSync(path) {
        reads.push(path)
        return reads.length === 1 ? bytes : Buffer.from(canonicalize(candidate("UNCHECKED_REPLACEMENT")))
      },
      writeFileSync() { writes++ },
    }

    expect(preview(artifactPath, sha256(bytes), { ...opts, fs: io })).toEqual({
      ok: true, ...req, sha256: sha256(bytes), measurements: measured(req).measurements,
    })
    expect(reads).toEqual([artifactPath])
    expect(writes).toBe(0)
    expect(fs.readFileSync(artifactPath)).toEqual(bytes)
  }))

  test("rejects a wrong digest with verify's failure shape and no review text", () => withFixture(({ opts, artifactPath }) => {
    const sentinel = "PREVIEW_BODY_MUST_NOT_LEAK"
    const bytes = canonicalize(candidate(sentinel, [comment(sentinel)]))
    fs.writeFileSync(artifactPath, bytes)
    const wrongDigest = sha256(bytes + "x")
    const result = preview(artifactPath, wrongDigest, opts)

    const failed = verify(artifactPath, wrongDigest, opts)
    expect(failed.ok).toBe(false)
    expect(result).toEqual({ ...failed, ok: false })
    expect(result).toMatchObject({ ok: false, reason: "sha256-mismatch" })
    expect(result).not.toHaveProperty("body")
    expect(result).not.toHaveProperty("comments")
    expect(JSON.stringify(result)).not.toContain(sentinel)
    expect(fs.readFileSync(artifactPath, "utf8")).toBe(bytes)
  }))

  for (const kind of escapeCases) {
    test(`rejects ${kind} before reading or writing and without review text`, () => withFixture(fixture => {
      const sentinel = "PREVIEW_ESCAPED_BODY_MUST_NOT_LEAK"
      const bytes = canonicalize(candidate(sentinel, [comment(sentinel)]))
      fs.writeFileSync(fixture.outsidePath, bytes)
      const escape = escapedPath(kind, fixture)
      let reads = 0, writes = 0
      const io: ReviewPayloadFs = {
        ...fs,
        readFileSync() { reads++; return Buffer.from(bytes) },
        writeFileSync() { writes++ },
      }
      const result = preview(escape, sha256(bytes), { ...fixture.opts, fs: io })

      expect(result).toEqual({
        ok: false, sha256Match: false, canonical: false, violations: [], measurements: null,
        reason: "path-outside-root", path: escape,
      })
      expect(JSON.stringify(result)).not.toContain(sentinel)
      expect(reads).toBe(0)
      expect(writes).toBe(0)
      expect(fs.readFileSync(fixture.outsidePath, "utf8")).toBe(bytes)
    }))
  }
})

describe("review payload result hygiene", () => {
  test("does not expose body text in measurement diagnostics, freeze or verify results", () => withFixture(({ opts, candidatePath, artifactPath }) => {
    const sentinel = "BODY_TEXT_MUST_NOT_APPEAR_IN_RESULTS"
    for (const overLimit of [false, true]) {
      const req = candidate(sentinel + (overLimit ? "x".repeat(24001) : ""), [comment(sentinel)])
      const { canonical, ...diagnostics } = measured(req)
      expect(canonical).toContain(sentinel)
      expect(JSON.stringify(diagnostics)).not.toContain(sentinel)
      expect(JSON.stringify(diagnostics.violations)).not.toContain(sentinel)

      fs.writeFileSync(candidatePath, JSON.stringify(req))
      const fileMeasurement = measureFile(candidatePath, opts)
      expect(fileMeasurement.ok).toBe(!overLimit)
      expect(JSON.stringify(fileMeasurement)).not.toContain(sentinel)
      const frozen = freeze(candidatePath, artifactPath, opts)
      expect(frozen).toMatchObject({ ok: true, fitted: overLimit })
      expect(JSON.stringify(frozen)).not.toContain(sentinel)

      fs.writeFileSync(artifactPath, canonical)
      const verified = verify(artifactPath, sha256(canonical), opts)
      expect(verified.ok).toBe(!overLimit)
      expect(JSON.stringify(verified)).not.toContain(sentinel)
    }
  }))

  test("does not expose body text in measure or freeze parsing, schema and I/O failures", () => withFixture(({ opts, candidatePath, artifactPath }) => {
    const sentinel = "FAILED_BODY_TEXT_MUST_NOT_APPEAR_IN_RESULTS"
    const req = candidate(sentinel, [comment(sentinel)])
    const cases = [
      [JSON.stringify(req).slice(0, -1), "candidate-parse-error"],
      [JSON.stringify({ ...req, event: "INVALID" }), "invalid-field"],
      ["\ufeff" + canonicalize(req), "candidate-bom"],
    ] as const
    for (const [bytes, reason] of cases) {
      fs.writeFileSync(candidatePath, bytes)
      for (const result of [measureFile(candidatePath, opts), freeze(candidatePath, artifactPath, opts)]) {
        expect(result).toMatchObject({ ok: false, reason })
        expect(JSON.stringify(result)).not.toContain(sentinel)
      }
      expect(fs.existsSync(artifactPath)).toBe(false)
    }
    fs.writeFileSync(candidatePath, canonicalize(req))
    const readFailure: ReviewPayloadFs = { ...fs, readFileSync() { throw new Error(sentinel) } }
    const writeFailure: ReviewPayloadFs = { ...fs, writeFileSync() { throw new Error(sentinel) } }
    for (const [result, reason] of [
      [measureFile(candidatePath, { ...opts, fs: readFailure }), "candidate-read-error"],
      [freeze(candidatePath, artifactPath, { ...opts, fs: readFailure }), "candidate-read-error"],
      [freeze(candidatePath, artifactPath, { ...opts, fs: writeFailure }), "artifact-write-error"],
      [freeze(candidatePath, artifactPath, { ...opts, fs: readbackFs(artifactPath, bytes => bytes.subarray(0, -1)) }), "readback-mismatch"],
    ] as const) {
      expect(result).toMatchObject({ ok: false, reason })
      expect(JSON.stringify(result)).not.toContain(sentinel)
    }
  }))

  test("does not expose body text in post verification or transport failures", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corvus-payload-post-hygiene-")))
    try {
      const sentinel = "POST_BODY_TEXT_MUST_NOT_APPEAR_IN_RESULTS"
      const inline = "POST_INLINE_TEXT_MUST_NOT_APPEAR_IN_RESULTS"
      const req = candidate(sentinel, [comment(inline)])
      const bytes = canonicalize(req)
      const artifactPath = join(root, "artifact.json")
      fs.writeFileSync(artifactPath, bytes)
      const input = { artifactPath, expectedSha256: sha256(bytes), repo: { owner: "o", name: "r" }, prNumber: 1, headSha: req.commit_id, event: req.event }
      const calls: string[][] = []
      const opts = { reviewStateRoot: root, exec: async (argv: string[]) => {
        calls.push(argv)
        return argv[3] === "GET"
          ? { code: 0, stdout: JSON.stringify([[{ sha: req.commit_id, commit: { message: "Change" } }]]), stderr: "" }
          : { code: 1, stdout: JSON.stringify({ status: 422, message: sentinel + inline, body: sentinel, comments: req.comments }), stderr: "" }
      } }
      const verificationFailure = await post({ ...input, expectedSha256: sha256(bytes + "x") }, opts)
      expect(verificationFailure).toEqual({ outcome: "rejected", reason: "artifact-verify-failed:sha256-mismatch", tool_api_calls: 0 })
      expect(calls).toEqual([])
      const transportFailure = await post(input, opts)
      expect(transportFailure).toEqual({ outcome: "rejected", http_status: 422, reason: "HTTP 422: remote message redacted", tool_api_calls: 2 })
      expect(calls.map(argv => argv[3])).toEqual(["GET", "POST"])
      for (const result of [verificationFailure, transportFailure]) {
        expect(JSON.stringify(result)).not.toContain(sentinel)
        expect(JSON.stringify(result)).not.toContain(inline)
      }
      expect(fs.readFileSync(artifactPath, "utf8")).toBe(bytes)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

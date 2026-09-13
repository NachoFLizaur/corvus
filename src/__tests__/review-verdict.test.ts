import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import yaml from "js-yaml"
import { acquire } from "../review-lock"
import { localReviewNamespace, read_document, write_document, write_meta } from "../review-persist"
import type { PrData, PrResult } from "../review-pr"
import { parseReviewMarker } from "../review-pr"
import { compute, createVerdictExecutor, type DocumentVerdict, type LabelCounts, type VerdictInput, type VerdictOptions } from "../review-verdict"

const BODY = "VERDICT_BODY_MUST_NOT_APPEAR_IN_RESULTS"
const REVIEW_ROOT = ".corvus/tasks/example/reviews/pr42"
const IDENTITY = { owner: "example", repo: "project", pr_number: 42 }
const SEVERITY = { blocker: 5, critical: 4, major: 3, minor: 2, nitpick: 1, praise: 0, thought: 0, note: 0 } as const
type Label = keyof LabelCounts
type Axis = "standards" | "spec"
type Fixture = { workspace: string; reviewRoot: string; opts: VerdictOptions }
const headSha = (round: number): string => round.toString(16).padStart(40, "0")
const marker = (round: number): string => `<!-- corvus-review v1 head:${headSha(round)} -->`
const labelCounts = (count = 0): LabelCounts => ({
  blocker: count, critical: count, major: count, minor: count, nitpick: count, praise: count, thought: count, note: count,
})

function withFixture(run: (fixture: Fixture) => void): void {
  const workspace = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corvus-review-verdict-")))
  try {
    run({ workspace, reviewRoot: REVIEW_ROOT, opts: { reviewStateRoot: join(workspace, ".corvus") } })
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

function priorReviews(count: number): PrResult<PrData["reviews"]> {
  return {
    ok: true, api_calls: 2, complete_pagination: true, complete_threads: true,
    threads: [], dispositions: [],
    reviews: Array.from({ length: count }, (_, index) => {
      const round = index + 1
      return {
        id: round, user: "corvus-bot", state: "COMMENTED", commit_id: headSha(round),
        submitted_at: `2026-01-${String(round).padStart(2, "0")}T12:00:00Z`,
        html_url: `https://github.com/example/project/pull/42#pullrequestreview-${round}`,
        body: `${marker(round)}\n${BODY}`, body_marker: marker(round),
      }
    }),
  }
}

function finding(id: number, axis: Axis, label: Label, options: { suppressed?: boolean; origin?: "pr-code" | "review-fix" } = {}) {
  return {
    id: `logic-${axis}-${String(id).padStart(3, "0")}`, axis, label, severity: SEVERITY[label],
    origin: options.origin ?? "pr-code", dimension: "correctness", pass: "correctness",
    suppressed: options.suppressed ?? false, file: "src/example.ts", line_start: id, line_end: null,
    title: "Validate the input", body: BODY, suggestion: null, confidence: 0.9, related_to: [],
  }
}
type Finding = ReturnType<typeof finding>
type CheckpointOptions = {
  findings?: Finding[]; omitCoverageComplete?: boolean; local?: { repo: string; branch: string | null }
  bodyMarker?: string; rawHead?: string
}

function persistDocument(fixture: Fixture, round: number, options: CheckpointOptions = {}): void {
  const findings = options.findings ?? []
  const source = findings.map(item => ({ ...item, suppressed: false }))
  const result = (items: Finding[]) => ({ status: "completed", reason: "Reviewed fixture scope", summary: BODY, findings: items })
  const dimensions = (items: Finding[]) => ({
    architecture: result([]), correctness: result(items), conventions: result([]), security: result([]),
  })
  const standards = source.filter(item => item.axis === "standards")
  const spec = source.filter(item => item.axis === "spec")
  const totals = labelCounts()
  for (const item of source) totals[item.label]++
  const document = {
    synthesis_controls: {
      ...(options.local ? { mode: "local", ...options.local, pr_number: null } : IDENTITY),
      head_sha: options.rawHead ?? headSha(round), ...(options.rawHead ? { code_head: headSha(round) } : {}), base_sha: "b".repeat(40), series_round: round,
      ...(options.omitCoverageComplete ? {} : { coverage_complete: true }),
    },
    source_findings: {
      axis_results: { standards: dimensions(standards), spec: dimensions(spec) },
      pass_results: dimensions([...standards, ...spec]), totals,
    },
    review_context: { coverage_gaps: [], prior_review: { findings: [], dispositions: [] } },
    reviewability: "complete", verdict: "not_converged", coverage_warning: null, state_notices: [],
    summary: { title: "Fixture review", body: BODY },
    action: "COMMENT_ONLY", action_reasoning: "Keep the fixture review local",
    findings, inline_comments: [], review_body: `${options.bodyMarker ?? marker(round)}\n${BODY}`,
    overflow: false, overflow_log: [], dedup_log: [], filtered_log: [], edit_history: [],
  }
  expect(write_document({
    reviewRoot: fixture.reviewRoot, headSha: headSha(round),
    sections: [{ heading: "REVIEW_DOCUMENT", body: `\`\`\`yaml\n${yaml.dump({ REVIEW_DOCUMENT: document }, { noRefs: true })}\`\`\`` }],
  }, fixture.opts)).toMatchObject({ ok: true })
}

function persistRound(fixture: Fixture, round: number, options: CheckpointOptions = {}): void {
  persistDocument(fixture, round, options)
  expect(write_meta({
    reviewRoot: fixture.reviewRoot, headSha: headSha(round),
    meta: { ...IDENTITY, schema_version: 1, head_sha: headSha(round), series_round: round },
  }, fixture.opts)).toMatchObject({ ok: true })
}

function verdict(fixture: Fixture, input: Omit<VerdictInput, "reviewRoot" | "config"> & { reviewRoot?: string; config?: VerdictInput["config"] }) {
  const root = input.reviewRoot ?? fixture.reviewRoot
  const local = root.split("/").at(-1)?.startsWith("local-")
  const result = compute({ reviewRoot: fixture.reviewRoot, config: {}, owner: "example", name: "project",
    pr: local ? null : 42, ...(local ? { branch: root.split("/").at(-1)!.slice(6) } : {}), ...input }, fixture.opts)
  expect(JSON.stringify(result)).not.toContain(BODY)
  return result
}

function documentVerdict(fixture: Fixture, round: number, count = round - 1): DocumentVerdict & { persisted: string } {
  const result = verdict(fixture, { headSha: headSha(round), priorReviews: priorReviews(count) })
  expect(result).toMatchObject({ ok: true })
  if (!result.ok || !("counts" in result)) throw new Error("Expected a document verdict")
  return result
}

function polishFindings(minors: number, nits: number): Finding[] {
  return Array.from({ length: minors + nits }, (_, index) =>
    finding(index + 1, index % 2 === 0 ? "standards" : "spec", index < minors ? "minor" : "nitpick"))
}

describe("review verdict history", () => {
  test("starts round 1 without refusing delta or claiming missing history when no prior reviews exist", () => withFixture(fixture => {
    expect(verdict(fixture, { priorReviews: priorReviews(0) })).toEqual({
      ok: true, round: 1, refuse_delta: false, missing_history: false,
    })
    expect(fs.existsSync(join(fixture.workspace, ".corvus"))).toBe(false)
  }))

  test("admits round 5 when one of the last two persisted rounds has a major", () => withFixture(fixture => {
    persistRound(fixture, 3, { findings: [finding(1, "spec", "major")] })
    persistRound(fixture, 4)
    expect(verdict(fixture, { priorReviews: priorReviews(4) })).toEqual({
      ok: true, round: 5, refuse_delta: false, missing_history: false,
    })
  }))

  test("refuses round 5 with a reason after two persisted zero-major rounds", () => withFixture(fixture => {
    persistRound(fixture, 3)
    persistRound(fixture, 4)
    expect(verdict(fixture, { priorReviews: priorReviews(4) })).toEqual({
      ok: true, round: 5, refuse_delta: true, missing_history: false,
      refuse_reason: expect.stringContaining("recommend human review"),
    })
    for (const round of [3, 4]) expect(fs.readdirSync(join(fixture.workspace, fixture.reviewRoot, headSha(round))).sort())
      .toEqual(["REVIEW_DOCUMENT.md", "meta.yaml"])
  }))

  test("forceDelta permits round 5 after two persisted zero-major rounds", () => withFixture(fixture => {
    persistRound(fixture, 3)
    persistRound(fixture, 4)
    expect(verdict(fixture, { priorReviews: priorReviews(4), forceDelta: true })).toEqual({
      ok: true, round: 5, refuse_delta: false, missing_history: false,
    })
  }))

  test("does not treat a previous API review without local evidence as zero-major history", () => withFixture(fixture => {
    persistDocument(fixture, 2)
    expect(documentVerdict(fixture, 2)).toMatchObject({
      round: 2, converged: false, missing_history: true, refuse_delta: true,
      convergence_reason: "missing-history", refuse_reason: expect.any(String),
    })
  }))

  test("resumes an exact head at its persisted metadata round instead of incrementing", () => withFixture(fixture => {
    persistRound(fixture, 1)
    persistRound(fixture, 2)
    expect(documentVerdict(fixture, 2, 1)).toMatchObject({
      round: 2, missing_history: false, refuse_delta: false, converged: true,
    })
  }))
})

describe("review verdict document counts and convergence", () => {
  test("the executor persists its complete result with deterministic YAML keys and a computation timestamp", () => withFixture(fixture => {
    persistDocument(fixture, 1, { findings: [finding(1, "spec", "major", { origin: "review-fix" })] })
    const execute = createVerdictExecutor(fixture.opts.reviewStateRoot)
    const result = JSON.parse(execute({ op: "compute", reviewRoot: fixture.reviewRoot, owner: "example", name: "project", pr: 42, headSha: headSha(1),
      priorReviews: { ...priorReviews(0), complete_threads: false }, config: {} }))
    const path = join(fixture.workspace, fixture.reviewRoot, headSha(1), "verdict.yaml")
    expect(result.persisted).toBe(path)
    const { persisted, ...expected } = result
    const bytes = fs.readFileSync(path, "utf8")
    const stored = yaml.load(bytes, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>
    const { computed_at, ...actual } = stored
    expect(actual).toEqual(expected)
    expect(actual).toMatchObject({ ok: true, refuse_delta: true, refuse_reason: expect.any(String), missing_history: true,
      counts: { by_origin: { "review-fix": { spec: { major: 1 }, total: { major: 1 } } } } })
    expect(typeof computed_at).toBe("string")
    expect(Number.isFinite(Date.parse(computed_at as string))).toBe(true)
    expect(bytes).toBe(yaml.dump(stored, { indent: 2, sortKeys: true, noRefs: true, lineWidth: 1_800 }))
    expect(write_meta({ reviewRoot: fixture.reviewRoot, headSha: headSha(1), name: "verdict.yaml", meta: expected }, fixture.opts))
      .toEqual({ ok: false, reason: "unknown-record" })
    expect(write_meta({ reviewRoot: fixture.reviewRoot, headSha: headSha(1), meta: expected }, fixture.opts)).toMatchObject({ ok: true })
  }))

  test.each([false, true])("pointer-only metadata preserves history and exact-head rounds (local=%s)", local => withFixture(fixture => {
    if (local) fixture.reviewRoot = ".corvus/reviews/local-topic"
    const options = local ? { local: { repo: "project", branch: "topic" } } : {}
    for (const round of [1, 2]) {
      persistDocument(fixture, round, options)
      const result = documentVerdict(fixture, round, 0)
      expect(result).toMatchObject({ round, missing_history: false, converged: round === 2 })
      const { computed_at, ...stored } = yaml.load(fs.readFileSync(result.persisted, "utf8")) as Record<string, unknown>
      const { persisted, ...expected } = result
      expect(stored).toEqual(expected)
      expect(write_meta({ reviewRoot: fixture.reviewRoot, headSha: headSha(round), meta: {
        ...(local ? { mode: "local", repo: "project", branch: "topic", pr_number: null } : IDENTITY),
        schema_version: 1, head_sha: headSha(round), verdict_file: "verdict.yaml",
      } }, fixture.opts)).toMatchObject({ ok: true })
    }
    expect(documentVerdict(fixture, 2, 0)).toMatchObject({ round: 2, missing_history: false, converged: true })
    const path = join(fixture.workspace, fixture.reviewRoot, headSha(2), "verdict.yaml"), bytes = fs.readFileSync(path)
    expect(verdict(fixture, { priorReviews: priorReviews(0) })).toMatchObject({ round: 3, missing_history: false })
    expect(fs.readFileSync(path)).toEqual(bytes)
    fs.rmSync(path)
    expect(verdict(fixture, { priorReviews: priorReviews(0) })).toMatchObject({ missing_history: true, refuse_delta: true })
  }))

  test("counts retained unsuppressed findings by axis, severity and origin without projection copies", () => withFixture(fixture => {
    const findings = (Object.keys(SEVERITY) as Label[]).flatMap((label, index) => [
      finding(index + 1, "standards", label),
      finding(index * 2 + 1, "spec", label, { origin: "review-fix" }),
      finding(index * 2 + 2, "spec", label, { origin: "review-fix" }),
    ])
    for (const axis of ["standards", "spec"] as const) {
      findings.push(finding(100, axis, "major", { suppressed: true }), finding(101, axis, "nitpick", { suppressed: true }))
    }
    persistDocument(fixture, 1, { findings })
    expect(documentVerdict(fixture, 1).counts).toEqual({
      standards: labelCounts(1), spec: labelCounts(2), total: labelCounts(3), actionable_total: 12,
      by_origin: {
        "pr-code": { standards: labelCounts(1), spec: labelCounts(), total: labelCounts(1) },
        "review-fix": { standards: labelCounts(), spec: labelCounts(2), total: labelCounts(2) },
      },
    })
  }))

  for (const { label, minors, nits } of [{ label: "minor", minors: 7, nits: 0 }, { label: "nitpick", minors: 0, nits: 4 }]) {
    test(`rejects the aggregate ${label} cap across axes with a structured error`, () => withFixture(fixture => {
      persistDocument(fixture, 1, { findings: polishFindings(minors, nits) })
      expect(verdict(fixture, {
        headSha: headSha(1), priorReviews: priorReviews(0), config: { max_nits: 3, max_minors: 6 },
      })).toEqual({ ok: false, reason: "presentation-caps-exceeded" })
      expect(fs.existsSync(join(fixture.workspace, fixture.reviewRoot, headSha(1), "verdict.yaml"))).toBe(false)
    }))
  }

  test("converges with full coverage and two zero-blocker/critical/major rounds, allowing totals at both caps", () => withFixture(fixture => {
    persistRound(fixture, 1, { findings: [finding(1, "spec", "minor")] })
    persistDocument(fixture, 2, { findings: polishFindings(6, 3) })
    expect(documentVerdict(fixture, 2)).toMatchObject({
      round: 2, converged: true, missing_history: false, refuse_delta: false,
      counts: { total: { blocker: 0, critical: 0, major: 0, minor: 6, nitpick: 3 } },
      caps_applied: { max_nits: 3, max_minors: 6, totals: { minor: 6, nitpick: 3 } },
    })
  }))

  test("does not infer full coverage when the current coverage_complete field is absent", () => withFixture(fixture => {
    persistRound(fixture, 1)
    persistDocument(fixture, 2, { omitCoverageComplete: true })
    expect(documentVerdict(fixture, 2)).toMatchObject({
      round: 2, converged: false, missing_history: false, convergence_reason: "incomplete-coverage",
    })
  }))
})

describe("review verdict containment", () => {
  test("verdict writes reject symlinks, write errors and readback mismatch without returning success", () => withFixture(fixture => {
    persistDocument(fixture, 1)
    const path = join(fixture.workspace, fixture.reviewRoot, headSha(1), "verdict.yaml")
    const outside = join(fixture.workspace, "outside.yaml")
    fs.writeFileSync(outside, "untouched")
    fs.symlinkSync(outside, path)
    const input = { headSha: headSha(1), priorReviews: priorReviews(0) }
    expect(verdict(fixture, input)).toEqual({ ok: false, reason: "symlink-target" })
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched")
    fs.unlinkSync(path)
    for (const mode of ["write-error", "readback-mismatch"]) {
      fixture.opts.fs = { ...fs,
        writeFileSync: (file, bytes, options) => {
          if (mode === "write-error") throw new Error("injected write failure")
          fs.writeFileSync(file, bytes, options)
        },
        readFileSync: file => file === path ? Buffer.from("corrupt readback") : fs.readFileSync(file),
      }
      expect(verdict(fixture, input)).toEqual({ ok: false, reason: mode })
      expect(fs.readdirSync(join(fixture.workspace, fixture.reviewRoot, headSha(1))).some(name => name.endsWith(".tmp"))).toBe(false)
    }
  }))

  test("rejects reviewRoot escapes with a valid identity before creating storage", () => withFixture(fixture => {
    for (const reviewRoot of ["../example__project__pr42", join(fixture.workspace, "outside", "example__project__pr42")]) {
      expect(verdict(fixture, { reviewRoot, priorReviews: priorReviews(0) })).toEqual({ ok: false, reason: "path-outside-root" })
    }
    expect(fs.readdirSync(fixture.workspace)).toEqual([])
  }))
})

describe("local review namespaces and verdicts", () => {
  const branch = "feat/x y@z"
  const reviewRoot = ".corvus/reviews/local-feat-x-y-z"
  const emptyPrior = (): PrResult<PrData["reviews"]> => ({ ...priorReviews(0), api_calls: 0 })

  test("derives the local repo namespace with one hyphen per non-slug branch character", () => {
    expect(localReviewNamespace("project", branch)).toBe("local__project__feat-x-y-z")
  })

  test("accepts a local root with empty prior reviews and no persisted history as round 1", () => withFixture(fixture => {
    expect(verdict(fixture, { reviewRoot, priorReviews: emptyPrior() })).toEqual({
      ok: true, round: 1, refuse_delta: false, missing_history: false,
    })
    expect(fs.readdirSync(fixture.workspace)).toEqual([])
  }))

  test.each([branch, null])("accepts current local document identity for branch %s", localBranch => withFixture(fixture => {
    const localFixture = {
      ...fixture, reviewRoot: `.corvus/reviews/local-${(localBranch ?? headSha(1)).replace(/[^A-Za-z0-9._-]/g, "-")}`,
    }
    persistDocument(localFixture, 1, { local: { repo: "project", branch: localBranch } })
    expect(verdict(localFixture, { headSha: headSha(1), priorReviews: emptyPrior() })).toMatchObject({
      ok: true, round: 1, missing_history: false, refuse_delta: false,
      converged: false, convergence_reason: "no-previous-round", counts: { total: labelCounts() },
    })
  }))

  test("rejects a local checkpoint belonging to another branch namespace", () => withFixture(fixture => {
    const localFixture = { ...fixture, reviewRoot }
    persistDocument(localFixture, 1, { local: { repo: "project", branch: "other" } })
    expect(verdict(localFixture, { headSha: headSha(1), priorReviews: emptyPrior() })).toEqual({
      ok: false, reason: "document-identity-mismatch",
    })
  }))

  test("does not treat incomplete or remote prior reviews as complete empty local history", () => withFixture(fixture => {
    for (const prior of [{ ...emptyPrior(), complete_threads: false }, priorReviews(1)]) {
      expect(verdict(fixture, { reviewRoot, priorReviews: prior })).toMatchObject({
        ok: true, round: 1, missing_history: true, refuse_delta: true, refuse_reason: expect.any(String),
      })
    }
    expect(fs.readdirSync(fixture.workspace)).toEqual([])
  }))

  test("acquires a lock and persists a document under a local root in temporary review storage", () => withFixture(fixture => {
    const now = "2026-01-01T12:00:00.000Z"
    const lock = acquire({ reviewRoot, runId: "local-run" }, { ...fixture.opts, now: () => new Date(now) })
    expect(lock).toEqual({ ok: true, state: "acquired", path: join(fixture.workspace, reviewRoot, "lock.yaml"), started_at: now })
    const sections = [{ heading: "Local Review", body: "Review the local changes without posting." }]
    expect(write_document({ reviewRoot, headSha: headSha(1), sections }, fixture.opts)).toMatchObject({
      ok: true, path: join(fixture.workspace, reviewRoot, headSha(1), "REVIEW_DOCUMENT.md"),
    })
    expect(read_document({ reviewRoot, headSha: headSha(1) }, fixture.opts)).toMatchObject({ ok: true, sections })
    expect(fs.readdirSync(join(fixture.workspace, reviewRoot)).sort()).toEqual([headSha(1), "lock.yaml"])
  }))
})

describe("committed review state verdict identity", () => {
  const v2 = (round: number, root = REVIEW_ROOT) => `<!-- corvus-review v2 path=${root} head=${headSha(round)} round=${round} -->`

  test.each([1, 2])("parses v%i markers in current documents and prior reviews", version => withFixture(fixture => {
    const bodyMarker = version === 1 ? marker(2) : v2(2)
    expect(parseReviewMarker(`${bodyMarker}\n${BODY}`)).toEqual({
      head: headSha(2), marker: bodyMarker, ...(version === 2 ? { path: REVIEW_ROOT, round: 2 } : {}),
    })
    persistRound(fixture, 1)
    persistDocument(fixture, 2, { bodyMarker })
    const prior = priorReviews(1)
    if (!prior.ok) throw new Error("Expected complete prior reviews")
    if (version === 2) prior.reviews[0] = { ...prior.reviews[0], body: `${v2(1)}\n${BODY}`, body_marker: v2(1), commit_id: headSha(99) }
    expect(verdict(fixture, { code_head: headSha(2), priorReviews: prior }))
      .toMatchObject({ ok: true, round: 2, missing_history: false, converged: true })
  }))

  test("new roots require invocation identity and reject mismatching PR, owner, or marker path", () => withFixture(fixture => {
    const input = { reviewRoot: fixture.reviewRoot, config: {}, headSha: headSha(1), priorReviews: priorReviews(0) }
    persistDocument(fixture, 1, { bodyMarker: v2(1) })
    expect(compute(input, fixture.opts)).toEqual({ ok: false, reason: "invalid-review-identity" })
    expect(verdict(fixture, { ...input, pr: 43 })).toEqual({ ok: false, reason: "invalid-review-identity" })
    expect(verdict(fixture, { ...input, owner: "other" })).toEqual({ ok: false, reason: "document-identity-mismatch" })
    expect(verdict(fixture, input)).toMatchObject({ ok: true, round: 1 })
    persistDocument(fixture, 1, { bodyMarker: v2(1, ".corvus/reviews/pr42") })
    expect(verdict(fixture, input)).toEqual({ ok: false, reason: "document-identity-mismatch" })
  }))

  test("resumes by code_head when invocation, document, and metadata observe a newer state tip", () => withFixture(fixture => {
    persistRound(fixture, 1)
    persistDocument(fixture, 2, { rawHead: headSha(99), bodyMarker: v2(2) })
    expect(write_meta({ reviewRoot: fixture.reviewRoot, headSha: headSha(2), meta: {
      ...IDENTITY, schema_version: 1, head_sha: headSha(99), code_head: headSha(2), series_round: 2,
    } }, fixture.opts)).toMatchObject({ ok: true })
    expect(verdict(fixture, { headSha: headSha(99), code_head: headSha(2), priorReviews: priorReviews(1) }))
      .toMatchObject({ ok: true, round: 2, missing_history: false, converged: true,
        persisted: join(fixture.workspace, fixture.reviewRoot, headSha(2), "verdict.yaml") })
    expect(fs.existsSync(join(fixture.workspace, fixture.reviewRoot, headSha(99)))).toBe(false)
  }))

  test("parses legacy root identity, reads its history unchanged, and writes resumed verdicts only to the new root", () => withFixture(fixture => {
    persistRound(fixture, 1)
    persistRound(fixture, 2)
    const legacy_root = ".corvus/reviews/example__project__pr42"
    const legacy = join(fixture.workspace, legacy_root)
    fs.mkdirSync(join(fixture.workspace, ".corvus/reviews"), { recursive: true })
    fs.renameSync(join(fixture.workspace, fixture.reviewRoot), legacy)
    const paths = [1, 2].flatMap(round => ["meta.yaml", "REVIEW_DOCUMENT.md"].map(file => join(legacy, headSha(round), file)))
    const before = paths.map(path => fs.readFileSync(path))
    expect(compute({ reviewRoot: legacy_root, config: {}, priorReviews: priorReviews(2) }, fixture.opts))
      .toEqual({ ok: true, round: 3, missing_history: false, refuse_delta: false })
    expect(verdict(fixture, { legacy_root, code_head: headSha(2), priorReviews: priorReviews(2) }))
      .toMatchObject({ ok: true, round: 2, missing_history: false, converged: true,
        persisted: join(fixture.workspace, fixture.reviewRoot, headSha(2), "verdict.yaml") })
    expect(paths.map(path => fs.readFileSync(path))).toEqual(before)
    for (const round of [1, 2]) expect(fs.readdirSync(join(legacy, headSha(round))).sort()).toEqual(["REVIEW_DOCUMENT.md", "meta.yaml"])
    expect(fs.readdirSync(join(fixture.workspace, fixture.reviewRoot, headSha(2)))).toEqual(["verdict.yaml"])
  }))

  test("rejects malformed v2 marker paths and rounds rather than treating them as valid history", () => {
    for (const value of [v2(1, ".corvus/tasks/../reviews/pr42"), v2(1).replace("round=1", "round=0"), `prefix ${v2(1)}`, v2(1) + " trailing"]) {
      expect(parseReviewMarker(value)).toBeUndefined()
    }
  })
})

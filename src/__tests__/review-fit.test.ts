import { describe, expect, test } from "bun:test"
import { FIT_CAPS, fitReview } from "../review-fit"
import { LIMITS, canonicalize, measure, type CandidateRequest } from "../review-payload"
import { parseReviewMarker } from "../review-pr"

const HEAD = "a".repeat(40)
const MARKER = `<!-- corvus-review v1 head:${HEAD} -->`
const footer = (count: number) => `Review limits: ${count} findings omitted for size`
const comment = (body = "c".repeat(4001)): CandidateRequest["comments"][number] => ({ path: "src/example.ts", line: 1, side: "RIGHT", body })
const candidate = (body: string, comments: CandidateRequest["comments"] = []): CandidateRequest => ({ commit_id: HEAD, event: "REQUEST_CHANGES", body, comments })
const finding = (id = "logic-standards-001", title = "Fix the originating decision") => `**major** (standards/correctness, ${id}): ${title}`

function expectFits(request: CandidateRequest) {
  const result = measure(request)
  if ("reason" in result) throw new Error("Expected a schema-valid fixture")
  expect(result.ok).toBe(true)
  expect(result.violations).toEqual([])
  for (const field of ["body", "total"] as const) {
    expect(result.measurements[field].codePoints).toBeLessThanOrEqual(LIMITS[field])
    expect(result.measurements[field].utf8Bytes).toBeLessThanOrEqual(LIMITS[field])
  }
  expect(request.comments).toEqual([])
  return result.measurements
}

function expectFooter(result: ReturnType<typeof fitReview>) {
  const lines = result.request.body.split("\n")
  expect(lines.filter(line => line.startsWith("Review limits:"))).toEqual([
    footer(result.omitted.comments + result.omitted.findings),
  ])
  expect(lines.at(-1)).toBe(footer(result.omitted.comments + result.omitted.findings))
}

describe("review fitting", () => {
  test("builds a deterministic summary with marker, all notice representations, two headlines and empty comments", () => {
    const notices = Array.from({ length: FIT_CAPS.notices + 5 }, (_, index) => `> notice ${index}: ${"warning ".repeat(1000)}`)
    const request = candidate([
      MARKER, ...notices, "Leading summary", "## Standards", "Standards assessment",
      finding(), "Detail ".repeat(5000), "## Spec", "Spec assessment",
      "**critical** (spec/security, sec-spec-001): Enforce the specified boundary",
    ].join("\n"), [comment(), comment("Second inline")])
    const original = canonicalize(request)
    const result = fitReview(request)
    expect(result).toEqual(fitReview(request))
    expect(canonicalize(request)).toBe(original)
    expect(result.request.commit_id).toBe(request.commit_id)
    expect(result.request.event).toBe(request.event)
    expect(result.request.body.split("\n")[0]).toBe(MARKER)
    expect(result.request.body).toContain("## Standards\nStandards assessment")
    expect(result.request.body).toContain("## Spec\nSpec assessment")
    for (let index = 0; index < FIT_CAPS.notices; index++) expect(result.request.body).toContain(`> notice ${index}: `)
    expect(result.request.body).toContain("> 5 further notices omitted for size")
    const keptNotices = result.request.body.split("\n").filter(line => line.startsWith("> notice"))
    expect(keptNotices).toHaveLength(FIT_CAPS.notices)
    expect(keptNotices.every(line => [...line].length === FIT_CAPS.notice && line.endsWith("…"))).toBe(true)
    expect(result.omitted).toEqual({ comments: 2, findings: 2 })
    expectFooter(result)
    expectFits(result.request)
  })

  test("keeps a recognizable anchor for one heading-free 24,001-character prose line", () => {
    const prefix = "The original leading summary explains the change: "
    const request = candidate(prefix + "x".repeat(24001 - prefix.length))
    expect(request.body.length).toBe(24001)
    const result = fitReview(request)
    expect(result.request.body.startsWith(prefix)).toBe(true)
    expect(result.request.body.split("\n")).toHaveLength(2)
    expect([...result.request.body.split("\n")[0]]).toHaveLength(FIT_CAPS.summary)
    expect(result.request.body).toContain("…\n" + footer(0))
    expect(result.omitted).toEqual({ comments: 0, findings: 0 })
    expectFits(result.request)
  })

  test("retains exactly the first headline per axis across 500 repeated section pairs, in body order", () => {
    const request = candidate([MARKER, ...Array.from({ length: 500 }, (_, index) => [
      "## Spec", `Spec headline ${index}`, "## Standards", `Standards headline ${index}`,
    ]).flat()].join("\n"))
    expect(measure(request).ok).toBe(false)
    const result = fitReview(request)
    expect(result.request.body).toBe([
      MARKER, "## Spec", "Spec headline 0", "## Standards", "Standards headline 0", footer(0),
    ].join("\n"))
    expectFits(result.request)
  })

  test("selects the first non-empty non-heading non-notice headline and does not backfill an empty first section", () => {
    const request = candidate([
      "Leading summary", "### Assessment — Standards", "", "> Coverage note", "Selected assessment",
      "## Spec", "## Other", "Not a Spec headline", "## Spec", "Repeated Spec assessment", "x".repeat(24001),
    ].join("\n"))
    const result = fitReview(request)
    expect(result.request.body).toContain("## Standards\n> Coverage note\nSelected assessment")
    expect(result.request.body).not.toContain("## Spec")
    expect(result.request.body).not.toContain("Repeated Spec assessment")
    expectFits(result.request)
  })

  test("selects both axes from a shared first heading without letting repeated sections replace either", () => {
    const result = fitReview(candidate([
      "## Spec and Standards", "Shared assessment", "## Standards", "Repeated Standards assessment",
      "## Spec", "Repeated Spec assessment", "x".repeat(24001),
    ].join("\n")))
    expect(result.request.body).toBe([
      "## Spec", "Shared assessment", "## Standards", "Shared assessment", footer(0),
    ].join("\n"))
    expectFits(result.request)
  })

  for (const [name, character] of [["CJK", "界"], ["emoji", "😀"], ["lone surrogates", "\ud800"]] as const) {
    test(`fits ${name} on decoded and canonical code-point and byte ceilings`, () => {
      const request = candidate([
        MARKER, `> Oversized notice: ${character.repeat(24001)}`,
        "## Standards", `Standards headline ${character.repeat(24001)}`,
        "## Spec", `Spec headline ${character.repeat(24001)}`,
      ].join("\n"))
      const result = fitReview(request)
      expect(result.request.body).toContain("> Oversized notice: ")
      expect(result.request.body).toContain("Standards headline ")
      expect(result.request.body).toContain("Spec headline ")
      expect(result.request.body.match(/…/g)).toHaveLength(3)
      expect(result.omitted).toEqual({ comments: 0, findings: 0 })
      expectFits(result.request)
    })
  }

  test("fits canonical-total-only overflow from quotes, backslashes and newlines", () => {
    const request = candidate('"\\\n'.repeat(8000))
    const before = measure(request)
    if ("reason" in before) throw new Error("Invalid fixture")
    expect(before.measurements.body).toEqual({ codePoints: LIMITS.body, utf8Bytes: LIMITS.body })
    expect(before.violations.every(violation => violation.field === "total")).toBe(true)
    expect(before.violations.length).toBeGreaterThan(0)
    const result = fitReview(request)
    expect(result.request.body.startsWith('"\\')).toBe(true)
    expect(result.omitted).toEqual({ comments: 0, findings: 0 })
    expectFits(result.request)
  })

  test("treats invalid or over-contract first-line marker prefixes as ordinary prose", () => {
    const overContract = `<!-- corvus-review v2 path=.corvus/tasks/${"x".repeat(24001)}/reviews/pr1 head=${HEAD} round=1 -->`
    expect(parseReviewMarker(overContract)).toBeDefined()
    for (const first of [overContract, MARKER + "x".repeat(24001), "<!-- unrelated " + "x".repeat(24001)]) {
      const result = fitReview(candidate(first))
      expect(result.request.body.startsWith(first.slice(0, 32))).toBe(true)
      expect(result.request.body.split("\n")[0].endsWith("…")).toBe(true)
      expect(parseReviewMarker(result.request.body)).toBeUndefined()
      expectFits(result.request)
    }
  })

  test("bounds even arbitrarily decorated selected headings without erasing their axes", () => {
    const result = fitReview(candidate([
      "#" + " ".repeat(24001) + "Standards", "Standards assessment",
      "## " + "Decoration ".repeat(24001) + "Spec", "Spec assessment",
    ].join("\n")))
    expect(result.request.body).toBe(["## Standards", "Standards assessment", "## Spec", "Spec assessment", footer(0)].join("\n"))
    expectFits(result.request)
  })

  test("worst-case protected set plus footer fits the proved production bounds", () => {
    const skeleton = `<!-- corvus-review v2 path=.corvus/tasks//reviews/pr1 head=${HEAD.toUpperCase()} round=${Number.MAX_SAFE_INTEGER} -->`
    const marker = skeleton.replace("tasks//", `tasks/${"x".repeat(FIT_CAPS.marker - skeleton.length)}/`)
    expect(marker.length).toBe(FIT_CAPS.marker)
    expect(parseReviewMarker(marker)).toBeDefined()
    for (const character of ["😀", "\u0000", "\ud800"]) {
      const notices = Array.from({ length: FIT_CAPS.notices + 1 }, () => "> " + character.repeat(FIT_CAPS.notice - 2))
      const request = candidate([
        marker, ...notices, "## Standards", character.repeat(FIT_CAPS.headline),
        "## Spec", character.repeat(FIT_CAPS.headline), "unselected ".repeat(24001),
      ].join("\n"), [comment()])
      const result = fitReview(request)
      expect(result.request.body.startsWith(marker + "\n")).toBe(true)
      expect(result.request.body).toContain(character.repeat(FIT_CAPS.headline))
      expect(result.request.body).toContain("> 1 further notices omitted for size")
      const sizes = expectFits(result.request)
      // Loose derivation in FIT_CAPS includes an additional (mutually exclusive)
      // anchor, 16-digit counters and the longest schema event's JSON envelope.
      expect(sizes.body.utf8Bytes).toBeLessThanOrEqual(15015)
      expect(sizes.total.utf8Bytes).toBeLessThanOrEqual(22326)
      expectFooter(result)
    }
  })

  test("drops capped leading context from the end before shortening protected lines", () => {
    const notices = Array.from({ length: FIT_CAPS.notices }, () => "> " + "😀".repeat(FIT_CAPS.notice - 2))
    const contexts = Array.from({ length: FIT_CAPS.leadingContext }, (_, index) => `Context ${index}: ` + "😀".repeat(FIT_CAPS.context))
    const result = fitReview(candidate([
      MARKER, ...notices, ...contexts, "## Standards", "😀".repeat(FIT_CAPS.headline),
      "## Spec", "😀".repeat(FIT_CAPS.headline),
    ].join("\n")))
    expect(result.request.body).toContain("Context 0:")
    expect(result.request.body).toContain("Context 1:")
    expect(result.request.body).not.toContain("Context 2:")
    expect(result.request.body).toContain("😀".repeat(FIT_CAPS.headline))
    expectFits(result.request)
  })
})

describe("review fitting omission oracle", () => {
  test("counts removed inline records, not identities inside comments", () => {
    const result = fitReview(candidate("Summary", [comment(finding()), comment(finding()), comment()]))
    expect(result.omitted).toEqual({ comments: 3, findings: 0 })
    expectFooter(result)
    expectFits(result.request)
  })

  test("counts distinct body identities removed during classification and leaves retained duplicates uncounted", () => {
    const retained = finding("logic-standards-001")
    const removed = finding("logic-standards-002")
    const result = fitReview(candidate([
      MARKER, "## Standards", retained, retained, removed, removed,
      "## Spec", "Spec headline", "x".repeat(24001),
    ].join("\n")))
    expect(result.request.body).toContain(retained)
    expect(result.request.body).not.toContain(removed)
    expect(result.omitted).toEqual({ comments: 0, findings: 1 })
    expectFooter(result)
  })

  test("does not recognize prose mentions, decorated lines, unknown labels or mismatched identity tags", () => {
    const result = fitReview(candidate([
      "## Standards", "Assessment", `Mention: ${finding()}`, `- ${finding()}`,
      finding().replace("**major**", "**issue**"), finding("sec-standards-001"), finding("logic-spec-001"),
      "x".repeat(24001),
    ].join("\n")))
    expect(result.omitted).toEqual({ comments: 0, findings: 0 })
    expectFooter(result)
  })

  test("counts an identity whose prefix is removed by the initial line cap", () => {
    const request = candidate(finding(`logic-standards-${"1".repeat(600)}`, "x".repeat(24001)))
    const result = fitReview(request)
    expect(result.request.body.startsWith("**major** (standards/correctness, logic-standards-")).toBe(true)
    expect(result.omitted).toEqual({ comments: 0, findings: 1 })
    expectFooter(result)
  })

  test("counts an identity removed by a later context drop using the original identity set", () => {
    const identity = finding("logic-standards-002")
    const request = candidate(["Leading summary", identity, "## Standards", "Assessment"].join("\n"), [comment()])
    const result = fitReview(request, { ...LIMITS, body: 90 })
    expect(result.request.body).toContain("Leading summary")
    expect(result.request.body).not.toContain(identity)
    expect(result.omitted).toEqual({ comments: 1, findings: 1 })
    expectFooter(result)
  })

  test("counts a protected identity lost only at the final minimal-shortening stage", () => {
    const identity = finding()
    const request = candidate(["## Standards", identity].join("\n"), [comment()])
    const normallyFitted = fitReview(request)
    expect(normallyFitted.request.body).toContain(identity)
    expect(normallyFitted.omitted).toEqual({ comments: 1, findings: 0 })
    // Production caps already prove a protected-only body fits. A tighter pure
    // fixture reaches the final stage: no droppable context, prefix >32 points.
    const result = fitReview(request, { ...LIMITS, body: 90 })
    expect(result.request.body.split("\n")[0]).toBe("## Standards")
    expect(result.request.body.split("\n")[1]).toBe(identity.slice(0, FIT_CAPS.minimal - 1) + "…")
    expect(result.omitted).toEqual({ comments: 1, findings: 1 })
    expectFooter(result)
  })

  test("replaces every existing size footer exactly once instead of accumulating prior counts", () => {
    const result = fitReview(candidate([
      "Leading summary " + "x".repeat(24001), footer(800), "Review limits: stale detail", footer(900),
    ].join("\n"), [comment(), comment()]))
    expect(result.omitted).toEqual({ comments: 2, findings: 0 })
    expectFooter(result)
    expect(result.request.body).not.toContain("800")
    expect(result.request.body).not.toContain("900")
  })

  test("fits schema-valid bodies with no prose anchor rather than inventing prose", () => {
    for (const body of ["\n".repeat(24001), "#".repeat(24001), footer(9)]) {
      const result = fitReview(candidate(body, [comment()]))
      expect(result.request.body).toBe(footer(1))
      expectFits(result.request)
    }
  })
})

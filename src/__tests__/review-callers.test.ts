import { describe, expect, test } from "bun:test"
import { isReviewCallerAllowed, type ReviewToolName } from "../review-callers"

const full = ["corvus-review", "corvus-review-auto"]
const light = "corvus-review-light"
const detectors = ["pr-code-reviewer", "security-reviewer", "pr-light-reviewer"]
const writer = "pr-comment-writer"
const gatherer = "pr-context-gatherer"
const unknown = ["unknown", "", "toString", "__proto__", undefined, null, { agent: light }]
const identities = [...full, light, ...detectors, writer, gatherer, ...unknown]

describe("shared review caller roster", () => {
  test("PR matrix pins all operations independently of the policy table", () => {
    for (const caller of identities) {
      for (const op of ["metadata", "head", "files", "diff", "reviews", "checks", "identity", "config", "repo", "find", "local", "post", "toString", undefined]) {
        const knownOp = typeof op === "string" && !["post", "toString"].includes(op)
        const allowed = knownOp && (full.includes(caller as string) || caller === light || caller === gatherer
          || (detectors.includes(caller as string) && ["metadata", "head", "files", "diff", "reviews", "checks"].includes(op!))
          || (caller === writer && ["head", "diff", "files", "reviews"].includes(op!)))
        expect(isReviewCallerAllowed("corvus_review_pr", caller, { op })).toBe(allowed)
      }
    }
  })

  test("orchestrator, resolve-only sync and writer-only post matrices", () => {
    const policies: { tool: ReviewToolName; ops: (string | undefined)[] }[] = [
      { tool: "corvus_review_payload", ops: ["measure", "freeze", "preview"] },
      { tool: "corvus_review_lock", ops: ["acquire", "release", "status"] },
      { tool: "corvus_review_verdict", ops: ["compute"] },
      { tool: "corvus_review_sync", ops: ["resolve", "pull", "push"] },
      { tool: "corvus_review_post", ops: [undefined] },
    ]
    for (const { tool, ops } of policies) for (const op of ops) for (const caller of identities) {
      const allowed = tool === "corvus_review_post" ? caller === writer
        : full.includes(caller as string) || (caller === light && (tool !== "corvus_review_sync" || op === "resolve"))
      expect(isReviewCallerAllowed(tool, caller, { op, agent: writer, caller: light })).toBe(allowed)
    }
  })

  test("light persist permits only candidate writes and candidate staging IDs", () => {
    const cases = [
      { op: "write_candidate" }, { op: "begin", target: "candidate" },
      ...["append", "finalize", "abort", "status"].map(op => ({ op, staging_id: "candidate:invalid-id" })),
    ]
    const forbidden = [
      ...["write_document", "write_input", "write_meta", "write_facts", "read_document", "read_facts"].map(op => ({ op })),
      { op: "begin" }, { op: "begin", target: "document" }, { op: "begin", target: "input" },
      ...["append", "finalize", "abort", "status"].flatMap(op => [
        { op }, { op, staging_id: "input:id" }, { op, staging_id: `document:${"a".repeat(40)}:id` },
      ]),
    ]
    for (const input of [...cases, ...forbidden]) for (const caller of identities) {
      expect(isReviewCallerAllowed("corvus_review_persist", caller, input))
        .toBe(full.includes(caller as string) || (caller === light && cases.includes(input)))
    }
  })

  test("worktree lifecycle belongs only to the light orchestrator, never argument identities", () => {
    for (const caller of identities) for (const op of ["create", "remove", "invalid", undefined])
      expect(isReviewCallerAllowed("corvus_review_worktree", caller, { op, caller: light, agent: light })).toBe(caller === light)
  })

  test("restricted gates do not read argument accessors; non-writer post does not inspect arguments", () => {
    let reads = 0
    const input = { get op() { reads++; return "resolve" }, get target() { reads++; return "candidate" } }
    expect(isReviewCallerAllowed("corvus_review_sync", light, input)).toBe(false)
    expect(isReviewCallerAllowed("corvus_review_persist", light, { op: "begin", get target() { reads++; return "candidate" } })).toBe(false)
    const opaque = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("inspected") } })
    expect(isReviewCallerAllowed("corvus_review_post", light, opaque)).toBe(false)
    expect(isReviewCallerAllowed("corvus_review_post", "pr-light-reviewer", opaque)).toBe(false)
    expect(reads).toBe(0)
  })
})

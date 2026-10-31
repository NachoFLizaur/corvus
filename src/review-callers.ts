/** Host identities, not user-configurable roles; shared by both review adapters. */
export const REVIEW_CALLERS = {
  fullOrchestrators: ["corvus-review", "corvus-review-auto"],
  lightOrchestrator: "corvus-review-light",
  writer: "pr-comment-writer",
  detectors: ["pr-code-reviewer", "security-reviewer", "pr-light-reviewer"],
  gatherer: "pr-context-gatherer",
} as const

type Operations = "*" | readonly string[]
const callers = (names: readonly string[], ops: Operations): Record<string, Operations> =>
  Object.fromEntries(names.map(name => [name, ops]))
const full = callers(REVIEW_CALLERS.fullOrchestrators, "*")
const orchestrators = { ...full, [REVIEW_CALLERS.lightOrchestrator]: "*" as const }
const prOps = ["metadata", "head", "files", "diff", "reviews", "checks", "identity", "config", "repo", "find", "local"]

/** Per-tool subsets. A wildcard delegates operation validation to the executor. */
export const REVIEW_CALLER_POLICY = {
  corvus_review_pr: {
    ...callers([...REVIEW_CALLERS.fullOrchestrators, REVIEW_CALLERS.lightOrchestrator, REVIEW_CALLERS.gatherer], prOps),
    ...callers(REVIEW_CALLERS.detectors, ["metadata", "head", "files", "diff", "reviews", "checks"]),
    [REVIEW_CALLERS.writer]: ["head", "diff", "files", "reviews"],
  },
  corvus_review_payload: orchestrators,
  corvus_review_lock: orchestrators,
  corvus_review_verdict: orchestrators,
  corvus_review_persist: {
    ...full,
    [REVIEW_CALLERS.lightOrchestrator]: ["write_candidate", "begin", "append", "finalize", "abort", "status"],
  },
  corvus_review_sync: { ...full, [REVIEW_CALLERS.lightOrchestrator]: ["resolve"] },
  corvus_review_post: { [REVIEW_CALLERS.writer]: "*" },
} satisfies Record<string, Record<string, Operations>>

export type ReviewToolName = keyof typeof REVIEW_CALLER_POLICY

const field = (input: unknown, key: string): unknown =>
  input !== null && typeof input === "object" ? Object.getOwnPropertyDescriptor(input, key)?.value : undefined

/**
 * Both adapters read host ctx.agent before state/PR I/O and pass it separately
 * from arguments. This roster is the oracle: unknown identities fail closed;
 * no input/option disables it. Full callers retain executor-side op validation.
 * Light persist reads target/ID before mutation: begin must name candidate and
 * follow-ups must use its self-locating candidate: ID. The persist executor then
 * validates the ID grammar and manifest/target binding before I/O consumption.
 */
export function isReviewCallerAllowed(tool: ReviewToolName, caller: unknown, input?: unknown): boolean {
  if (typeof caller !== "string") return false
  const policy: Record<string, Operations> = REVIEW_CALLER_POLICY[tool]
  if (!Object.hasOwn(policy, caller)) return false
  const ops = policy[caller]
  if (ops === "*") return true
  const op = field(input, "op")
  if (typeof op !== "string" || !ops.includes(op)) return false
  if (tool !== "corvus_review_persist" || caller !== REVIEW_CALLERS.lightOrchestrator) return true
  if (op === "begin") return field(input, "target") === "candidate"
  if (op === "write_candidate") return true
  const id = field(input, "staging_id")
  return typeof id === "string" && id.startsWith("candidate:")
}

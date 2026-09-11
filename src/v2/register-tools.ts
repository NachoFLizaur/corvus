import { createReviewToolExecutors } from "../review-payload"
import type { Registrar, SetupContext } from "./types"

type ToolDraft = Parameters<Parameters<SetupContext["tool"]["transform"]>[0]>[0]

/**
 * One transform contributes two name-keyed tools. The host's draft.add upserts
 * by name, so replay replaces rather than duplicates them. codemode:false keeps
 * both directly callable under their own permission keys, even when execute is
 * denied. Host location is captured before registration; the shared executors
 * reject invalid context/args before I/O. Cleanup alone removes this transform.
 */
export const registerTools: Registrar = async (ctx) => {
  const review = createReviewToolExecutors(ctx.location.directory)
  const registration = await ctx.tool.transform((draft: ToolDraft) => {
    draft.add({
      name: "corvus_review_payload",
      description: "Measure or freeze a review candidate under .corvus/reviews. Paths are relative to the session directory or absolute; freeze requires artifactPath.",
      input: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["measure", "freeze"] },
          candidatePath: { type: "string", minLength: 1 },
          artifactPath: { type: "string", minLength: 1 },
        },
        required: ["op", "candidatePath"],
        additionalProperties: false,
        oneOf: [
          { properties: { op: { const: "measure" } }, not: { required: ["artifactPath"] } },
          { properties: { op: { const: "freeze" } }, required: ["artifactPath"] },
        ],
      },
      options: { codemode: false },
      execute: async (args: unknown) => ({ content: review.payload(args) }),
    })
    draft.add({
      name: "corvus_review_verify",
      description: "Verify a frozen review artifact and its expected SHA-256 under .corvus/reviews without writing. Paths are session-relative or absolute.",
      input: {
        type: "object",
        properties: {
          op: { type: "string", const: "verify" },
          artifactPath: { type: "string", minLength: 1 },
          expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        required: ["op", "artifactPath", "expectedSha256"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (args: unknown) => ({ content: review.verify(args) }),
    })
  })
  return async () => {
    try {
      await registration.dispose()
    } catch (error) {
      console.error(`corvus: failed to remove the tool transform — ${(error as Error).message}`)
    }
  }
}

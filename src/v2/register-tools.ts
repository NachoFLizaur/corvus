import { isAbsolute, resolve } from "node:path"
import { createReviewToolExecutors } from "../review-payload"
import { createPostExecutor } from "../review-post"
import { createPersistExecutor } from "../review-persist"
import { createLockExecutor } from "../review-lock"
import { createPrExecutor } from "../review-pr"
import { createVerdictExecutor } from "../review-verdict"
import { createSyncExecutor } from "../review-sync"
import type { Registrar, SetupContext } from "./types"

type ToolDraft = Parameters<Parameters<SetupContext["tool"]["transform"]>[0]>[0]

/**
 * One transform contributes eight name-keyed tools. The host's draft.add upserts
 * by name, so replay replaces rather than duplicates them. codemode:false keeps
 * all directly callable under their own permission keys, even when execute is
 * denied. Host location is captured before registration; the shared executors
 * reject invalid context/args before I/O. Cleanup alone removes this transform.
 */
export const registerTools: Registrar = async (ctx) => {
  const directory = ctx.location.directory
  const review = createReviewToolExecutors(directory)
  const reviewStateRoot = typeof directory === "string" && isAbsolute(directory) ? resolve(directory, ".corvus") : ""
  const post = createPostExecutor(reviewStateRoot)
  const persist = createPersistExecutor(reviewStateRoot)
  const lock = createLockExecutor(reviewStateRoot)
  const pr = createPrExecutor({ cwd: directory })
  const verdict = createVerdictExecutor(reviewStateRoot)
  const sync = createSyncExecutor({ cwd: directory })
  const registration = await ctx.tool.transform((draft: ToolDraft) => {
    draft.add({
      name: "corvus_review_payload",
      description: "Measure or freeze a review candidate under .corvus/reviews or .corvus/tasks/<task>/reviews. Paths are relative to the session directory or absolute; freeze requires artifactPath.",
      input: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["measure", "freeze"] },
          candidatePath: { type: "string", minLength: 1 },
          artifactPath: { type: "string", minLength: 1 },
        },
        required: ["op", "candidatePath"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (args: unknown) => ({ content: review.payload(args) }),
    })
    draft.add({
      name: "corvus_review_verify",
      description: "Verify a frozen review artifact and its expected SHA-256 under .corvus/reviews or .corvus/tasks/<task>/reviews without writing. Paths are session-relative or absolute.",
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
    draft.add({
      name: "corvus_review_post",
      description: "Post a frozen review artifact under .corvus/reviews or .corvus/tasks/<task>/reviews after verifying its digest and current PR code_head. Use the absolute artifactPath returned by freeze.",
      input: {
        type: "object",
        properties: {
          artifactPath: { type: "string", minLength: 1 },
          expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          repo: {
            type: "object",
            properties: {
              owner: { type: "string", pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$" },
              name: { type: "string", pattern: "^(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}$" },
            },
            required: ["owner", "name"],
            additionalProperties: false,
          },
          prNumber: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          headSha: { type: "string", pattern: "^[a-f0-9]{40}$" },
          event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"] },
        },
        required: ["artifactPath", "expectedSha256", "repo", "prNumber", "headSha", "event"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (args: unknown) => ({ content: await post(args) }),
    })
    draft.add({
      name: "corvus_review_persist",
      description: "Write or read review state under the host's .corvus/reviews or .corvus/tasks/<task>/reviews roots. Supply op and reviewRoot plus only that op's fields: write_document(headSha, sections, optional frontmatterYaml), write_input(input), write_meta(headSha, meta, optional name: meta.yaml/decision.yaml/completion.yaml/authorization.yaml/review-action.yaml), write_candidate(candidate), read_document(headSha), write_facts(facts), read_facts(). The module validates operation-specific arguments.",
      input: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["write_document", "write_input", "write_meta", "write_candidate", "read_document", "write_facts", "read_facts"] },
          reviewRoot: { type: "string" },
          headSha: { type: "string" },
          sections: { type: "array", items: { type: "object", properties: { heading: { type: "string" }, body: { type: "string" } }, required: ["heading", "body"], additionalProperties: true } },
          frontmatterYaml: { type: "string" },
          input: { type: "object", additionalProperties: true },
          meta: { type: "object", additionalProperties: true },
          name: { type: "string" },
          facts: { type: "object", additionalProperties: true },
          candidate: { type: "object", additionalProperties: true },
        },
        required: ["op", "reviewRoot"],
        additionalProperties: true,
      },
      options: { codemode: false },
      execute: async (args: unknown) => ({ content: persist(args) }),
    })
    draft.add({
      name: "corvus_review_lock",
      description: "Manage review locks under the host's .corvus/reviews or .corvus/tasks/<task>/reviews roots. Supply op and reviewRoot; acquire also needs runId and optional force, release needs runId and mode (delete or complete), status needs no other fields. The module validates operation-specific arguments.",
      input: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["acquire", "release", "status"] },
          reviewRoot: { type: "string" },
          runId: { type: "string" },
          force: { type: "boolean" },
          mode: { type: "string", enum: ["delete", "complete"] },
        },
        required: ["op", "reviewRoot"],
        additionalProperties: true,
      },
      options: { codemode: false },
      execute: async (args: unknown) => ({ content: lock(args) }),
    })
    draft.add({
      name: "corvus_review_pr",
      description: "Read GitHub PR data with validated, fixed operations. metadata/head/diff/reviews/checks take owner, name, pr; files also requires paginate:true and accepts include_corvus/names_only booleans (include_corvus implies names-only). Files and diffs exclude .corvus by default and report excluded_corvus; local changed_files stays unfiltered. metadata/head/local return raw head_sha and code_head skipping state commits. config takes owner, name, ref (base SHA); identity takes no fields; repo resolves owner/name from gh or origin with optional cwd (defaults to the session directory). find takes optional cwd/branch to discover the current or named branch's PR; local takes optional cwd/base for a bounded local diff including tracked uncommitted changes, branch (null when detached), default_branch, merge_base, ahead, changed_files, stat, dirty and oversized. Caller policy uses the host agent: pr-comment-writer may call only head, diff, files; corvus-review, corvus-review-auto and pr-context-gatherer may call any op. Unknown callers return caller-not-allowed.",
      input: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["metadata", "head", "files", "diff", "reviews", "checks", "identity", "config", "repo", "find", "local"] },
          cwd: { type: "string" },
          branch: { type: "string" },
          base: { type: "string" },
          owner: { type: "string" },
          name: { type: "string" },
          pr: { type: ["number", "string"] },
          paginate: { type: "boolean", const: true },
          include_corvus: { type: "boolean" },
          names_only: { type: "boolean" },
          ref: { type: "string" },
        },
        required: ["op"],
        additionalProperties: true,
      },
      options: { codemode: false },
      /**
       * Host ctx.agent is the caller oracle, read on every invocation before PR
       * I/O. Writer ops fail closed outside head/diff/files; only the two review
       * orchestrators and gatherer get all ops. Missing/unknown identity rejects.
       * Tool arguments cannot override this check; no option disables it.
       */
      execute: async (args: unknown, ctx) => {
        const caller = ctx?.agent
        const op = args !== null && typeof args === "object" ? Object.getOwnPropertyDescriptor(args, "op")?.value : undefined
        const allowed = caller === "pr-comment-writer"
          ? ["head", "diff", "files"].includes(op)
          : ["corvus-review", "corvus-review-auto", "pr-context-gatherer"].includes(caller)
        if (!allowed) return { content: JSON.stringify({ ok: false, reason: "caller-not-allowed", api_calls: 0 }) }
        return { content: await pr(args) }
      },
    })
    draft.add({
      name: "corvus_review_verdict",
      description: "Compute review counts, round, convergence and delta refusal from persisted state. Supply code_head (or legacy headSha); omit both for history-only admission. New roots require invocation owner/name/pr, or name/pr:null/branch for LOCAL; legacy_root is an optional read-only resume source. priorReviews is the complete corvus_review_pr reviews result. Only trusted invocation forceDelta overrides refusal, never config.force_delta.",
      input: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["compute"] },
          reviewRoot: { type: "string" },
          headSha: { type: "string" },
          code_head: { type: "string" },
          owner: { type: "string" },
          name: { type: "string" },
          pr: { type: ["integer", "null"] },
          branch: { type: "string" },
          legacy_root: { type: "string" },
          priorReviews: { type: "object", additionalProperties: true },
          config: { type: "object", additionalProperties: true },
          forceDelta: { type: "boolean" },
        },
        required: ["op", "reviewRoot", "priorReviews", "config"],
        additionalProperties: false,
      },
      options: { codemode: false },
      /** Host agent identity is read before state I/O; unknown/non-review callers reject, with no argument bypass. */
      execute: async (args: unknown, ctx) => {
        if (!["corvus-review", "corvus-review-auto"].includes(ctx?.agent)) return { content: JSON.stringify({ ok: false, reason: "caller-not-allowed" }) }
        return { content: verdict(args) }
      },
    })
    draft.add({
      name: "corvus_review_sync",
      description: "Sync committed review state. resolve takes pr and unfiltered changed_files; pull takes branch and optional remote; push takes root, head_sha, pr, branch and optional remote. cwd defaults to the host workspace. pr is {owner,name,number,isCrossRepository} from metadata, or {name,number:null,branch} for LOCAL. resolve returns root/task/legacy_root/remote; pull/push return synced/reason/state_commit/git_calls. Legacy roots are read-only; sync failures are notes.",
      input: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["resolve", "pull", "push"] },
          cwd: { type: "string" },
          pr: { type: "object", additionalProperties: true },
          changed_files: { type: "array", items: { type: "string" } },
          branch: { type: "string" },
          remote: { type: "string" },
          root: { type: "string" },
          head_sha: { type: "string" },
        },
        required: ["op"],
        additionalProperties: false,
      },
      options: { codemode: false },
      /** Host agent identity is checked before sync I/O; only the two review orchestrators pass. Missing/unknown callers fail closed, without an argument bypass. */
      execute: async (args: unknown, ctx) => {
        if (!["corvus-review", "corvus-review-auto"].includes(ctx?.agent)) return { content: JSON.stringify({ synced: false, reason: "caller-not-allowed", git_calls: 0 }) }
        return { content: await sync(args) }
      },
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

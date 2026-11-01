import { isAbsolute, resolve } from "node:path"
import { createReviewToolExecutors } from "../review-payload"
import { createPostExecutor } from "../review-post"
import { createPersistExecutor } from "../review-persist"
import { createLockExecutor } from "../review-lock"
import { createPrExecutor, isPrCallerAllowed } from "../review-pr"
import { createVerdictExecutor } from "../review-verdict"
import { createSyncExecutor } from "../review-sync"
import { createWorktreeExecutor } from "../review-worktree"
import { isReviewCallerAllowed } from "../review-callers"
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
  const post = createPostExecutor(reviewStateRoot, directory)
  const persist = createPersistExecutor(reviewStateRoot)
  const lock = createLockExecutor(reviewStateRoot)
  const pr = createPrExecutor({ cwd: directory })
  const verdict = createVerdictExecutor(reviewStateRoot)
  const sync = createSyncExecutor({ cwd: directory })
  const worktree = createWorktreeExecutor({ cwd: directory })
  const registration = await ctx.tool.transform((draft: ToolDraft) => {
    draft.add({
      name: "corvus_review_payload",
      description: "Measure, freeze or preview under .corvus/reviews or .corvus/tasks/<task>/reviews. Paths are relative to the session directory or absolute. Supply only the op's fields: measure(candidatePath), freeze(candidatePath, artifactPath), preview(artifactPath, expectedSha256). Freeze fits over-budget candidates mechanically. Read-only preview verifies the digest and returns the JSON-decoded frozen artifact (commit_id, event, body, comments), sha256 and measurements. Only preview returns review text; failures never do. The module validates operation-specific arguments.",
      input: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["measure", "freeze", "preview"] },
          candidatePath: { type: "string", minLength: 1 },
          artifactPath: { type: "string", minLength: 1 },
          expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        required: ["op"],
        additionalProperties: false,
      },
      options: { codemode: false },
      /** Host ctx.agent is read before payload I/O; the shared review-callers roster admits orchestrators and fails closed for missing/unknown callers, without an argument bypass. */
      execute: async (args: unknown, ctx) => {
        if (!isReviewCallerAllowed("corvus_review_payload", ctx?.agent, args)) return { content: JSON.stringify({ ok: false, reason: "caller-not-allowed" }) }
        return { content: review.payload(args, ctx?.agent) }
      },
    })
    draft.add({
      name: "corvus_review_post",
      description: "Post a frozen review artifact under .corvus/reviews or .corvus/tasks/<task>/reviews after verifying its digest and current PR code_head. Paths are relative to the session directory or absolute.",
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
      execute: async (args: unknown, ctx) => ({ content: await post(args, ctx?.agent) }),
    })
    draft.add({
      name: "corvus_review_persist",
      description: "Write or read review state under the host's .corvus/reviews or .corvus/tasks/<task>/reviews roots. Supply op and reviewRoot plus only that op's fields: write_document(headSha, sections, optional frontmatterYaml), write_input(input), write_meta(headSha, meta, optional name: meta.yaml/decision.yaml/completion.yaml/authorization.yaml/review-action.yaml), write_candidate(candidate), read_document(headSha), write_facts(facts), read_facts(), begin(target: document|input|candidate), append(staging_id; document: index/heading/body; input: key/value; candidate: field/text, optional comment/anchor; part/parts), finalize(staging_id; document: expected_sections; input: ordered expected_keys; candidate: expected_comments), abort(staging_id), status(staging_id). The module validates operation-specific arguments.",
      input: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["write_document", "write_input", "write_meta", "write_candidate", "read_document", "write_facts", "read_facts", "begin", "append", "finalize", "abort", "status"] },
          reviewRoot: { type: "string" },
          headSha: { type: "string" },
          sections: { type: "array", items: { type: "object", properties: { heading: { type: "string" }, body: { type: "string" } }, required: ["heading", "body"], additionalProperties: true } },
          frontmatterYaml: { type: "string" },
          input: { type: "object", additionalProperties: true },
          meta: { type: "object", additionalProperties: true },
          name: { type: "string" },
          facts: { type: "object", additionalProperties: true },
          candidate: { type: "object", additionalProperties: true },
          target: { type: "string", enum: ["document", "input", "candidate"], description: "Begin document: headSha, optional expected_sections/frontmatterYaml. Begin candidate: commit_id/event, no document checkpoint needed. Split body and each comment's path/body into zero-based part/parts with a fixed parts count; concatenate text without separators. comment indexes define final order." },
          commit_id: { type: "string", pattern: "^[a-f0-9]{40}$" },
          event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"] },
          staging_id: { type: "string" },
          expected_sections: { type: "integer", minimum: 1 },
          expected_keys: { type: "array", items: { type: "string" } },
          expected_comments: { type: "integer", minimum: 0 },
          comment: { type: "integer", minimum: 0 },
          field: { type: "string", enum: ["path", "body"] },
          text: { type: "string", description: "Candidate string part. Keep complete JSON-serialized append arguments <=6,000 characters including escaping." },
          anchor: { type: "object", properties: { line: { type: "integer", minimum: 1 }, side: { type: "string", enum: ["LEFT", "RIGHT"] }, start_line: { type: "integer", minimum: 1 }, start_side: { type: "string", enum: ["LEFT", "RIGHT"] } }, required: ["line", "side"], additionalProperties: false, description: "Required exactly on comment path part 0; supply line/side and optional start_line/start_side once." },
          index: { type: "integer", minimum: 0 },
          part: { type: "integer", minimum: 0 },
          parts: { type: "integer", minimum: 1 },
          heading: { type: "string" },
          body: { type: "string" },
          key: { type: "string" },
          value: {},
          chunk: {},
        },
        required: ["op", "reviewRoot"],
        additionalProperties: true,
      },
      options: { codemode: false },
      /** Host ctx.agent and op/target/ID are checked against review-callers before state I/O; light is candidate-only. Missing/unknown callers fail closed, without a bypass. */
      execute: async (args: unknown, ctx) => {
        if (!isReviewCallerAllowed("corvus_review_persist", ctx?.agent, args)) return { content: JSON.stringify({ ok: false, reason: "caller-not-allowed" }) }
        return { content: persist(args, ctx?.agent) }
      },
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
      /** Host ctx.agent is read before lock I/O; the shared review-callers roster admits orchestrators and fails closed for missing/unknown callers, without an argument bypass. */
      execute: async (args: unknown, ctx) => {
        if (!isReviewCallerAllowed("corvus_review_lock", ctx?.agent, args)) return { content: JSON.stringify({ ok: false, reason: "caller-not-allowed" }) }
        return { content: lock(args, ctx?.agent) }
      },
    })
    draft.add({
      name: "corvus_review_pr",
      description: "Read PR data with fixed operations. metadata/head/diff/reviews/checks: owner/name/pr; files: paginate:true. paths selects intact patches, missing_paths and diff_anchor=diff-<SHA256(path)> (Files-tab #<diff_anchor>R<line> or R<start>-R<end>). anchors:[{path,line,start_line?}] verifies RIGHT added/context spans in one complete hunk; returns postable/reason/diff_anchor, complete_pagination, no patches or files unless paths also supplied. Each selector <=50; normalized relative paths <=1,024 chars; paths deduplicated; both reject names_only/include_corvus true. include_corvus implies names-only; files/diffs exclude .corvus by default (excluded_corvus); local changed_files unfiltered. metadata/head/local: head_sha and code_head skipping state commits. config: owner/name/ref (base SHA); identity: no fields; repo: optional cwd, gh/origin; find: optional cwd/branch; local: optional cwd/base, bounded tracked diff. Callers: pr-comment-writer head/diff/files/reviews; pr-code-reviewer, security-reviewer, pr-light-reviewer metadata/head/files/diff/reviews/checks; corvus-review, corvus-review-auto, corvus-review-light, pr-context-gatherer all ops. Unknown: caller-not-allowed.",
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
          paths: { type: "array", items: { type: "string", minLength: 1, maxLength: 1_024 }, maxItems: 50 },
          anchors: { type: "array", maxItems: 50, items: { type: "object", properties: {
            path: { type: "string", minLength: 1, maxLength: 1_024 }, line: { type: "integer", minimum: 1 }, start_line: { type: "integer", minimum: 1 },
          }, required: ["path", "line"], additionalProperties: false } },
          ref: { type: "string" },
        },
        required: ["op"],
        additionalProperties: true,
      },
      options: { codemode: false },
      /**
       * Host ctx.agent is the caller oracle, read on every invocation before PR
       * I/O. Shared isPrCallerAllowed owns writer/detector operation subsets;
       * only orchestrators/gatherer get all ops. Missing/unknown identity rejects.
       * Tool arguments cannot override this check; no option disables it.
       */
      execute: async (args: unknown, ctx) => {
        const op = args !== null && typeof args === "object" ? Object.getOwnPropertyDescriptor(args, "op")?.value : undefined
        const allowed = isPrCallerAllowed(ctx?.agent, op)
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
      /** Host ctx.agent is read against review-callers before state I/O; unknown/non-review callers reject, with no argument bypass. */
      execute: async (args: unknown, ctx) => {
        if (!isReviewCallerAllowed("corvus_review_verdict", ctx?.agent, args)) return { content: JSON.stringify({ ok: false, reason: "caller-not-allowed" }) }
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
      /** Host ctx.agent and op are checked against review-callers before sync I/O; light gets resolve only. Missing/unknown callers fail closed with zero git calls; no argument bypass. */
      execute: async (args: unknown, ctx) => {
        if (!isReviewCallerAllowed("corvus_review_sync", ctx?.agent, args)) return { content: JSON.stringify({ synced: false, reason: "caller-not-allowed", git_calls: 0 }) }
        return { content: await sync(args) }
      },
    })
    draft.add({
      name: "corvus_review_worktree",
      description: "Light-only create/remove of an exact-head sibling worktree. Supply op/pr/code_head/runId; cwd defaults to the session directory. Raw blob population avoids hooks, filters and live symlinks. Removal verifies the derived path and detached registration/HEAD; never prunes others.",
      input: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["create", "remove"] },
          cwd: { type: "string" },
          pr: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          code_head: { type: "string", pattern: "^[a-f0-9]{40}$" },
          runId: { type: "string", minLength: 1 },
        },
        required: ["op", "pr", "code_head", "runId"],
        additionalProperties: false,
      },
      options: { codemode: false },
      /** Host ctx.agent is checked before I/O by the shared executor; no input bypasses light-only admission. */
      execute: async (args: unknown, ctx) => ({ content: await worktree(args, ctx?.agent) }),
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

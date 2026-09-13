import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import { agentDir, commandDir, skillDir } from "./paths"
import { loadAgents } from "./load-agents"
import { loadCommands } from "./load-commands"
import { resolveOutputBudget } from "./output-budget"
import { createReviewToolExecutors } from "./review-payload"
import { createPostExecutor } from "./review-post"
import { createPersistExecutor } from "./review-persist"
import { createLockExecutor } from "./review-lock"
import { createPrExecutor } from "./review-pr"
import { createVerdictExecutor } from "./review-verdict"
import { createSyncExecutor } from "./review-sync"

/**
 * Extended config type that includes the `skills` field.
 *
 * The `skills` property exists at runtime and in newer SDK versions,
 * but may be absent from the installed SDK type definitions.
 * This interface bridges that gap without requiring a specific SDK version.
 */
interface ConfigWithSkills {
  skills?: {
    paths?: string[]
  }
}

type PlainObject = Record<string, unknown>

// Kept in a separate module: the opencode plugin loader rejects any
// non-function export on this entry module (see src/protected-agents.ts).
import { PROTECTED_AGENTS, PROTECTED_AGENT_KEYS } from "./protected-agents"

const isPlainObject = (value: unknown): value is PlainObject => {
  if (value === null || typeof value !== "object") return false

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const mergePlainObjects = (
  defaults: PlainObject,
  user: PlainObject,
): PlainObject =>
  Object.entries(user).reduce<PlainObject>((merged, [key, userValue]) => {
    if (userValue === undefined) return merged

    const defaultValue = defaults[key]
    const value =
      isPlainObject(defaultValue) && isPlainObject(userValue)
        ? mergePlainObjects(defaultValue, userValue)
        : userValue

    return { ...merged, [key]: value }
  }, { ...defaults })

/**
 * Deep-replace (never merge) the plugin's protected keys onto a merged agent,
 * so user config cannot inject even one widened sub-key under `permission`.
 */
const enforceProtectedKeys = (
  pluginAgent: PlainObject,
  mergedAgent: PlainObject,
): PlainObject =>
  PROTECTED_AGENT_KEYS.reduce<PlainObject>((agent, key) => {
    const { [key]: _dropped, ...rest } = agent
    return pluginAgent[key] === undefined
      ? rest
      : { ...rest, [key]: pluginAgent[key] }
  }, mergedAgent)

/**
 * After the general user-wins merge, re-assert the plugin's `permission` and
 * `prompt` for each protected agent present in the plugin's agent set.
 * Non-protected agents and non-protected keys are left untouched.
 */
const enforceProtectedAgents = (
  pluginAgents: PlainObject,
  merged: PlainObject,
): PlainObject =>
  PROTECTED_AGENTS.reduce<PlainObject>((result, name) => {
    const pluginAgent = pluginAgents[name]
    if (!isPlainObject(pluginAgent)) return result

    // A non-object user override cannot carry the guaranteed permission
    // block, so fall back to the plugin definition wholesale.
    const mergedAgent = result[name]
    const base = isPlainObject(mergedAgent) ? mergedAgent : { ...pluginAgent }

    return { ...result, [name]: enforceProtectedKeys(pluginAgent, base) }
  }, merged)

/**
 * Corvus AI plugin for OpenCode.
 *
 * Registers agents, commands, and skills from the corvus package
 * into OpenCode's configuration via the config hook.
 */
const plugin: Plugin = async (input) => {
  const directory = input.directory || input.worktree
  const review = createReviewToolExecutors(directory)
  const reviewStateRoot = typeof directory === "string" && isAbsolute(directory) ? resolve(directory, ".corvus") : ""
  const post = createPostExecutor(reviewStateRoot)
  const persist = createPersistExecutor(reviewStateRoot)
  const lock = createLockExecutor(reviewStateRoot)
  const pr = createPrExecutor({ cwd: directory })
  const verdict = createVerdictExecutor(reviewStateRoot)
  const sync = createSyncExecutor({ cwd: directory })
  const corvusAgents = new Set(existsSync(agentDir) ? Object.keys(loadAgents(agentDir)) : [])
  return {
    /**
     * Scope oracle: packaged names read at plugin initialization, never user config.
     * Read the hook-visible budget before mutation; non-Corvus agents and defined
     * values bypass this default. v1 normally seeds the value, so this is a no-op;
     * only an unset value uses resolveOutputBudget's limit/fallback rule.
     */
    "chat.params": async (input, output) => {
      if (!corvusAgents.has(input.agent) || output.maxOutputTokens !== undefined) return
      const budget = resolveOutputBudget({ current: output.maxOutputTokens, modelLimit: input.model.limit.output })
      if (budget !== undefined) output.maxOutputTokens = budget
    },
    tool: {
      corvus_review_payload: {
        description: "Measure or freeze a review candidate under .corvus/reviews or .corvus/tasks/<task>/reviews. Paths are relative to the session directory or absolute; freeze requires artifactPath.",
        args: {
          op: z.enum(["measure", "freeze"]),
          candidatePath: z.string().min(1),
          artifactPath: z.string().min(1).optional(),
        },
        /** Host ctx.agent is read before payload I/O; only the two review orchestrators pass. Missing/unknown callers fail closed, and no argument or option disables the check. */
        execute: async (args, ctx) => {
          if (!["corvus-review", "corvus-review-auto"].includes(ctx?.agent)) return JSON.stringify({ ok: false, reason: "caller-not-allowed" })
          return review.payload(args)
        },
      },
      corvus_review_verify: {
        description: "Verify a frozen review artifact and its expected SHA-256 under .corvus/reviews or .corvus/tasks/<task>/reviews without writing. Paths are session-relative or absolute.",
        args: {
          op: z.literal("verify"),
          artifactPath: z.string().min(1),
          expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
        },
        /** Host ctx.agent is read before artifact I/O; only the review orchestrators and writer pass. Missing/unknown callers fail closed, and no argument or option disables the check. */
        execute: async (args, ctx) => {
          if (!["corvus-review", "corvus-review-auto", "pr-comment-writer"].includes(ctx?.agent)) return JSON.stringify({ ok: false, reason: "caller-not-allowed" })
          return review.verify(args)
        },
      },
      corvus_review_post: {
        description: "Post a frozen review artifact under .corvus/reviews or .corvus/tasks/<task>/reviews after verifying its digest and current PR code_head. Use the absolute artifactPath returned by freeze.",
        args: {
          artifactPath: z.string().min(1),
          expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
          repo: z.object({
            owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
            name: z.string().regex(/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/),
          }).strict(),
          prNumber: z.number().int().positive(),
          headSha: z.string().regex(/^[a-f0-9]{40}$/),
          event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
        },
        execute: async (args, ctx) => post(args, ctx?.agent),
      },
      corvus_review_persist: {
        description: "Write or read review state under the host's .corvus/reviews or .corvus/tasks/<task>/reviews roots. Supply op and reviewRoot plus only that op's fields: write_document(headSha, sections, optional frontmatterYaml), write_input(input), write_meta(headSha, meta, optional name: meta.yaml/decision.yaml/completion.yaml/authorization.yaml/review-action.yaml), write_candidate(candidate), read_document(headSha), write_facts(facts), read_facts(). The module validates operation-specific arguments.",
        args: {
          op: z.enum(["write_document", "write_input", "write_meta", "write_candidate", "read_document", "write_facts", "read_facts"]),
          reviewRoot: z.string(),
          headSha: z.string().optional(),
          sections: z.array(z.object({ heading: z.string(), body: z.string() }).passthrough()).optional(),
          frontmatterYaml: z.string().optional(),
          input: z.object({}).passthrough().optional(),
          meta: z.object({}).passthrough().optional(),
          name: z.string().optional(),
          facts: z.object({}).passthrough().optional(),
          candidate: z.object({}).passthrough().optional(),
        },
        /** Host ctx.agent is read before state I/O; only the two review orchestrators pass. Missing/unknown callers fail closed, and no argument or option disables the check. */
        execute: async (args, ctx) => {
          if (!["corvus-review", "corvus-review-auto"].includes(ctx?.agent)) return JSON.stringify({ ok: false, reason: "caller-not-allowed" })
          return persist(args)
        },
      },
      corvus_review_lock: {
        description: "Manage review locks under the host's .corvus/reviews or .corvus/tasks/<task>/reviews roots. Supply op and reviewRoot; acquire also needs runId and optional force, release needs runId and mode (delete or complete), status needs no other fields. The module validates operation-specific arguments.",
        args: {
          op: z.enum(["acquire", "release", "status"]),
          reviewRoot: z.string(),
          runId: z.string().optional(),
          force: z.boolean().optional(),
          mode: z.enum(["delete", "complete"]).optional(),
        },
        /** Host ctx.agent is read before lock I/O; only the two review orchestrators pass. Missing/unknown callers fail closed, and no argument or option disables the check. */
        execute: async (args, ctx) => {
          if (!["corvus-review", "corvus-review-auto"].includes(ctx?.agent)) return JSON.stringify({ ok: false, reason: "caller-not-allowed" })
          return lock(args)
        },
      },
      corvus_review_pr: {
        description: "Read GitHub PR data with validated, fixed operations. metadata/head/diff/reviews/checks take owner, name, pr; files also requires paginate:true and accepts include_corvus/names_only booleans (include_corvus implies names-only). Files and diffs exclude .corvus by default and report excluded_corvus; local changed_files stays unfiltered. metadata/head/local return raw head_sha and code_head skipping state commits. config takes owner, name, ref (base SHA); identity takes no fields; repo resolves owner/name from gh or origin with optional cwd (defaults to the session directory). find takes optional cwd/branch to discover the current or named branch's PR; local takes optional cwd/base for a bounded local diff including tracked uncommitted changes, branch (null when detached), default_branch, merge_base, ahead, changed_files, stat, dirty and oversized. Caller policy uses the host agent: pr-comment-writer may call only head, diff, files; corvus-review, corvus-review-auto and pr-context-gatherer may call any op. Unknown callers return caller-not-allowed.",
        args: {
          op: z.enum(["metadata", "head", "files", "diff", "reviews", "checks", "identity", "config", "repo", "find", "local"]),
          cwd: z.string().optional(),
          branch: z.string().optional(),
          base: z.string().optional(),
          owner: z.string().optional(),
          name: z.string().optional(),
          pr: z.union([z.number(), z.string()]).optional(),
          paginate: z.literal(true).optional(),
          include_corvus: z.boolean().optional(),
          names_only: z.boolean().optional(),
          ref: z.string().optional(),
        },
        /**
         * Host ctx.agent is the caller oracle, read on every invocation before PR
         * I/O. Writer ops fail closed outside head/diff/files; only the two review
         * orchestrators and gatherer get all ops. Missing/unknown identity rejects.
         * Tool arguments cannot override this check; no option disables it.
         */
        execute: async (args, ctx) => {
          const caller = ctx?.agent
          const allowed = caller === "pr-comment-writer"
            ? typeof args.op === "string" && ["head", "diff", "files"].includes(args.op)
            : ["corvus-review", "corvus-review-auto", "pr-context-gatherer"].includes(caller)
          if (!allowed) return JSON.stringify({ ok: false, reason: "caller-not-allowed", api_calls: 0 })
          return pr(args)
        },
      },
      corvus_review_verdict: {
        description: "Compute review counts, round, convergence and delta refusal from persisted state. Supply code_head (or legacy headSha); omit both for history-only admission. New roots require invocation owner/name/pr, or name/pr:null/branch for LOCAL; legacy_root is an optional read-only resume source. priorReviews is the complete corvus_review_pr reviews result. Only trusted invocation forceDelta overrides refusal, never config.force_delta.",
        args: {
          op: z.enum(["compute"]),
          reviewRoot: z.string(),
          headSha: z.string().optional(),
          code_head: z.string().optional(),
          owner: z.string().optional(),
          name: z.string().optional(),
          pr: z.number().nullable().optional(),
          branch: z.string().optional(),
          legacy_root: z.string().optional(),
          priorReviews: z.object({}).passthrough(),
          config: z.object({}).passthrough(),
          forceDelta: z.boolean().optional(),
        },
        /** Host agent identity is read before state I/O; unknown/non-review callers reject, with no argument bypass. */
        execute: async (args, ctx) => {
          if (!["corvus-review", "corvus-review-auto"].includes(ctx?.agent)) return JSON.stringify({ ok: false, reason: "caller-not-allowed" })
          return verdict(args)
        },
      },
      corvus_review_sync: {
        description: "Sync committed review state. resolve takes pr and unfiltered changed_files; pull takes branch and optional remote; push takes root, head_sha, pr, branch and optional remote. cwd defaults to the host workspace. pr is {owner,name,number,isCrossRepository} from metadata, or {name,number:null,branch} for LOCAL. resolve returns root/task/legacy_root/remote; pull/push return synced/reason/state_commit/git_calls. Legacy roots are read-only; sync failures are notes.",
        args: {
          op: z.enum(["resolve", "pull", "push"]),
          cwd: z.string().optional(),
          pr: z.object({}).passthrough().optional(),
          changed_files: z.array(z.string()).optional(),
          branch: z.string().optional(),
          remote: z.string().optional(),
          root: z.string().optional(),
          head_sha: z.string().optional(),
        },
        /** Host agent identity is checked before sync I/O; only the two review orchestrators pass. Missing/unknown callers fail closed, without an argument bypass. */
        execute: async (args, ctx) => {
          if (!["corvus-review", "corvus-review-auto"].includes(ctx?.agent)) return JSON.stringify({ synced: false, reason: "caller-not-allowed", git_calls: 0 })
          return sync(args)
        },
      },
    },
    config: async (config) => {
      // Load and register agents
      if (existsSync(agentDir)) {
        const agents = loadAgents(agentDir)
        const existingAgents = config.agent
        const merged = mergePlainObjects(
          agents,
          (existingAgents ?? {}) as PlainObject,
        )
        config.agent = enforceProtectedAgents(
          agents,
          merged,
        ) as NonNullable<typeof config.agent>
      }

      // Load and register commands
      if (existsSync(commandDir)) {
        const commands = loadCommands(commandDir)
        const existingCommands = config.command
        config.command = mergePlainObjects(
          commands,
          (existingCommands ?? {}) as PlainObject,
        ) as NonNullable<typeof config.command>
      }

      // Register skill directory
      // Cast needed: `skills` exists at runtime but may be absent from older SDK types
      const cfg = config as typeof config & ConfigWithSkills
      if (existsSync(skillDir)) {
        if (!cfg.skills) {
          cfg.skills = { paths: [] }
        }
        if (!cfg.skills.paths) {
          cfg.skills.paths = []
        }
        if (!cfg.skills.paths.includes(skillDir)) {
          cfg.skills.paths.push(skillDir)
        }
      }

      // Register the default MCP only when the user has not configured it
      if (!config.mcp) {
        config.mcp = {}
      }
      if (!Object.prototype.hasOwnProperty.call(config.mcp, "web-research")) {
        config.mcp["web-research"] = {
          type: "local",
          command: ["npx", "-y", "web-research-mcp@0.1.0"],
          enabled: true,
        }
      }
    },
  }
}

export default plugin

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import plugin from "../index"
import { PROTECTED_AGENTS } from "../protected-agents"
import { canonicalize, freeze, measure, verify, type CandidateRequest } from "../review-payload"
import { registerTools } from "../v2/register-tools"
import { createFakeContext } from "./fake-context"

/** Run the config hook with no user agent config to capture plugin defaults. */
const loadPluginAgents = async (): Promise<Record<string, any>> => {
  const { config: hook } = await plugin({} as any)
  const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }
  await hook!(config as any)
  return config.agent
}

describe("plugin entry point", () => {
  test("exports default plugin function", () => {
    expect(typeof plugin).toBe("function")
  })

  test("plugin returns config hook", async () => {
    const result = await plugin({} as any)

    expect(result).toHaveProperty("config")
    expect(typeof result.config).toBe("function")
    expect(typeof result["chat.params"]).toBe("function")
    expect(Object.keys(result.tool ?? {})).toEqual(["corvus_review_payload", "corvus_review_verify", "corvus_review_post", "corvus_review_persist", "corvus_review_lock", "corvus_review_pr", "corvus_review_verdict", "corvus_review_sync"])
    expect(Object.keys(result.tool!.corvus_review_payload.args)).toEqual(["op", "candidatePath", "artifactPath"])
    expect(z.safeParse(result.tool!.corvus_review_payload.args.op, "verify").success).toBe(false)
    expect(z.safeParse(result.tool!.corvus_review_verify.args.op, "freeze").success).toBe(false)
    for (const tool of Object.values(result.tool!)) {
      const schema = z.toJSONSchema(z.object(tool.args))
      expect(schema).toMatchObject({ type: "object", additionalProperties: false })
      for (const combinator of ["oneOf", "anyOf", "allOf"]) {
        expect(schema).not.toHaveProperty(combinator)
      }
    }
    expect(z.toJSONSchema(z.object(result.tool!.corvus_review_payload.args)).required).toEqual(["op", "candidatePath"])
    for (const [name, ops, required] of [
      ["corvus_review_persist", ["write_document", "write_input", "write_meta", "write_candidate", "read_document", "write_facts", "read_facts"], ["op", "reviewRoot"]],
      ["corvus_review_lock", ["acquire", "release", "status"], ["op", "reviewRoot"]],
      ["corvus_review_pr", ["metadata", "head", "files", "diff", "reviews", "checks", "identity", "config", "repo", "find", "local"], ["op"]],
      ["corvus_review_verdict", ["compute"], ["op", "reviewRoot", "priorReviews", "config"]],
      ["corvus_review_sync", ["resolve", "pull", "push"], ["op"]],
    ] as const) {
      const tool = result.tool![name]
      expect(z.toJSONSchema(z.object(tool.args))).toMatchObject({ properties: { op: { enum: ops } }, required })
      expect(z.safeParse(tool.args.op, "post").success).toBe(false)
    }
    for (const field of ["input", "meta", "candidate", "facts"]) {
      expect(z.safeParse(result.tool!.corvus_review_persist.args[field], { content: { nested: ["preserved"] } }))
        .toMatchObject({ success: true, data: { content: { nested: ["preserved"] } } })
    }
    for (const args of [{ op: "find" }, { op: "find", cwd: "/repo", branch: "topic/B" }, { op: "local", cwd: "/repo", base: "main" }]) {
      expect(z.safeParse(z.object(result.tool!.corvus_review_pr.args), args)).toMatchObject({ success: true, data: args })
    }
    expect(result.tool!.corvus_review_pr.description).toContain("find takes optional cwd/branch")
    expect(result.tool!.corvus_review_pr.description).toContain("local takes optional cwd/base")
    const post = result.tool!.corvus_review_post
    const postFields = ["artifactPath", "expectedSha256", "repo", "prNumber", "headSha", "event"]
    expect(Object.keys(post.args)).toEqual(postFields)
    expect(z.toJSONSchema(z.object(post.args)).required).toEqual(postFields)
    const descriptor = { artifactPath: "/workspace/.corvus/reviews/pr/post-request.json", expectedSha256: "0".repeat(64), repo: { owner: "o", name: "r" }, prNumber: 1, headSha: "a".repeat(40), event: "COMMENT" }
    expect(z.safeParse(z.object(post.args), descriptor).success).toBe(true)
    for (const invalid of [{ prNumber: 0 }, { prNumber: 1.5 }, { prNumber: Number.MAX_SAFE_INTEGER + 1 },
      { headSha: "bad" }, { expectedSha256: "bad" }, { event: "PENDING" },
      { repo: { owner: "-o", name: "r" } }, { repo: { owner: "o", name: ".." } },
      { repo: { owner: "o", name: "r", extra: true } }]) {
      expect(z.safeParse(z.object(post.args), { ...descriptor, ...invalid }).success).toBe(false)
    }
    expect(JSON.parse(await post.execute(descriptor, { agent: "pr-comment-writer" } as Parameters<typeof post.execute>[1]) as string))
      .toEqual({ outcome: "rejected", reason: "invalid-review-state-root", tool_api_calls: 0 })
    const payload = result.tool!.corvus_review_payload
    expect(JSON.parse(await payload.execute({ op: "measure", candidatePath: ".corvus/reviews/candidate.json" }, { agent: "corvus-review" } as Parameters<typeof payload.execute>[1]) as string))
      .toEqual({ ok: false, reason: "invalid-workspace-directory" })
  })

  test("config hook loads agents", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    await hook!(config as any)

    expect(Object.keys(config.agent)).toHaveLength(16)
    expect(config.agent["pr-code-reviewer"]).toBeDefined()
  })

  test("config hook loads commands", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {}, skills: { paths: [] } }

    await hook!(config as any)

    expect(Object.keys(config.command)).toHaveLength(4)
  })

  test("config hook applies nested user agent overrides last", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = {
      agent: {
        researcher: {
          permission: {
            bash: { "curl *": "deny" },
          },
        },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent.researcher.permission.bash["curl *"]).toBe("deny")
    expect(config.agent.researcher.permission.bash["gh *"]).toBeUndefined()
    expect(config.agent.researcher.permission["*"]).toBe("allow")
    expect(typeof config.agent.researcher.description).toBe("string")
  })

  test("config hook applies user command values last", async () => {
    const { config: hook } = await plugin({} as any)
    const userOnlyCommand = {
      template: "User command template",
      description: "User-only command",
      model: "user/model",
      subtask: true,
    }
    const config: Record<string, any> = {
      agent: {},
      command: {
        "git-commit": {
          description: "User git command",
          model: "user/model",
          subtask: true,
        },
        "user-command": userOnlyCommand,
      },
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.command["git-commit"].description).toBe("User git command")
    expect(config.command["git-commit"].model).toBe("user/model")
    expect(config.command["git-commit"].subtask).toBe(true)
    expect(config.command["git-commit"].template).toStartWith(
      "<command-instruction>",
    )
    expect(config.command["user-command"]).toEqual(userOnlyCommand)
    expect(config.command.readme).toBeDefined()
  })

  test("user arrays, null, and scalars replace agent defaults", async () => {
    const { config: hook } = await plugin({} as any)
    const userBashRules = ["custom-bash-rule"]
    const config: Record<string, any> = {
      agent: {
        researcher: {
          permission: {
            bash: userBashRules,
            edit: null,
            read: "deny",
          },
        },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent.researcher.permission.bash).toBe(userBashRules)
    expect(config.agent.researcher.permission.edit).toBe(null)
    expect(config.agent.researcher.permission.read).toBe("deny")
    expect(config.agent.researcher.permission["*"]).toBe("allow")
  })

  test("config hook registers the skill path idempotently", async () => {
    const { config: hook } = await plugin({} as any)
    const existingPaths = ["/user/skills", "/shared/skills"]
    const config: Record<string, any> = {
      agent: {},
      command: {},
      skills: { paths: [...existingPaths] },
    }

    await hook!(config as any)
    const corvusSkillPath = config.skills.paths[existingPaths.length]
    await hook!(config as any)

    expect(corvusSkillPath).toStartWith("/")
    expect(corvusSkillPath).toEndWith("/skill")
    expect(config.skills.paths).toEqual([...existingPaths, corvusSkillPath])
    expect(
      config.skills.paths.filter((path: string) => path === corvusSkillPath),
    ).toHaveLength(1)
  })

  test("handles missing config.skills gracefully", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = { agent: {}, command: {} }

    // Should not throw even without skills key
    await hook!(config as any)

    expect(config.skills).toBeDefined()
    expect(config.skills.paths).toHaveLength(1)
  })
})

type ReviewToolName = "corvus_review_payload" | "corvus_review_verify" | "corvus_review_post" | "corvus_review_persist" | "corvus_review_lock" | "corvus_review_pr" | "corvus_review_verdict" | "corvus_review_sync"
type ToolCall = (name: ReviewToolName, args: Record<string, unknown>, agent?: unknown) => Promise<Record<string, unknown>>
async function withReviewTools(host: "v1" | "v2", run: (directory: string, call: ToolCall) => Promise<void>) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "corvus-tool-hooks-")))
  let cleanup: (() => Promise<void> | void) | void = undefined
  try {
    mkdirSync(join(directory, ".corvus/reviews/pr"), { recursive: true })
    if (host === "v1") {
      const hooks = await plugin({ directory, worktree: "/unrelated-worktree" } as Parameters<typeof plugin>[0])
      await run(directory, async (name, args, agent) => {
        const tool = hooks.tool![name]
        const output = await tool.execute(args, { agent } as Parameters<typeof tool.execute>[1])
        expect(typeof output).toBe("string")
        return JSON.parse(output as string)
      })
    } else {
      const fake = createFakeContext(directory)
      cleanup = await registerTools(fake.ctx)
      expect(fake.registrations.map(registration => registration.kind)).toEqual(["tool.transform"])
      await run(directory, async (name, args, agent) => {
        const tool = fake.tools.get(name)!
        const output = await tool.execute(args, { agent } as Parameters<typeof tool.execute>[1])
        expect(typeof output.content).toBe("string")
        return JSON.parse(output.content as string)
      })
    }
  } finally {
    await cleanup?.()
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("review tool hooks", () => {
  test.each(["v1", "v2"] as const)("%s gates payload, verify, post, persist and lock on host identity for every op", async host => {
    await withReviewTools(host, async (_directory, call) => {
      const orchestrators = ["corvus-review", "corvus-review-auto"]
      const policies = [
        { name: "corvus_review_payload", ops: ["measure", "freeze"], allowed: orchestrators },
        { name: "corvus_review_verify", ops: ["verify"], allowed: [...orchestrators, "pr-comment-writer"] },
        { name: "corvus_review_post", ops: [undefined], allowed: ["pr-comment-writer"] },
        { name: "corvus_review_persist", ops: ["write_document", "write_input", "write_meta", "write_candidate", "read_document", "write_facts", "read_facts"], allowed: orchestrators },
        { name: "corvus_review_lock", ops: ["acquire", "release", "status"], allowed: orchestrators },
      ] as const
      const agents = [...Object.keys(await loadPluginAgents()), "unknown", "", undefined, null, { agent: "corvus-review" }]
      for (const { name, ops, allowed } of policies) {
        for (const agent of agents) {
          for (const op of ops) {
            const args = op === undefined ? {} : { op }
            const result = await call(name, args, agent)
            if (typeof agent === "string" && allowed.some(name => name === agent)) {
              expect(result.reason).toMatch(/^(?:invalid-|missing-field)/)
            } else {
              const rejected = name === "corvus_review_post"
                ? { outcome: "rejected", reason: "caller-not-allowed", tool_api_calls: 0 }
                : { ok: false, reason: "caller-not-allowed" }
              expect(result).toEqual(rejected)
              expect(await call(name, { ...args, agent: allowed[0], caller: allowed[0], ctx: { agent: allowed[0] } }, agent)).toEqual(rejected)
            }
          }
        }
      }
    })
  })

  test.each(["v1", "v2"] as const)("%s rejects unauthorized valid requests without altering review state", async host => {
    await withReviewTools(host, async (directory, call) => {
      const reviewRoot = join(directory, ".corvus/reviews/pr")
      const candidatePath = join(reviewRoot, "candidate.json"), artifactPath = join(reviewRoot, "post-request.json")
      const candidate = { commit_id: "a".repeat(40), event: "COMMENT", body: "Review", comments: [] }
      const source = JSON.stringify(candidate)
      writeFileSync(candidatePath, source)
      const frozen = freeze(candidatePath, artifactPath, { reviewStateRoot: join(directory, ".corvus") })
      if (!frozen.ok) throw new Error("Expected a frozen artifact")
      const artifact = readFileSync(artifactPath)
      const rejected = { ok: false, reason: "caller-not-allowed" }
      for (const agent of ["pr-comment-writer", "pr-code-reviewer", "security-reviewer", undefined]) {
        expect(await call("corvus_review_payload", { op: "measure", candidatePath }, agent)).toEqual(rejected)
        expect(await call("corvus_review_payload", { op: "freeze", candidatePath, artifactPath: join(reviewRoot, "unauthorized.json") }, agent)).toEqual(rejected)
        expect(await call("corvus_review_persist", { op: "write_candidate", reviewRoot, candidate: { ...candidate, body: "Changed" } }, agent)).toEqual(rejected)
        expect(await call("corvus_review_lock", { op: "acquire", reviewRoot, runId: "unauthorized" }, agent)).toEqual(rejected)
      }
      for (const agent of ["pr-code-reviewer", "security-reviewer", undefined]) {
        expect(await call("corvus_review_verify", { op: "verify", artifactPath, expectedSha256: frozen.sha256 }, agent)).toEqual(rejected)
      }
      const descriptor = { artifactPath, expectedSha256: frozen.sha256, repo: { owner: "o", name: "r" }, prNumber: 1, headSha: "b".repeat(40), event: "COMMENT" }
      for (const agent of ["corvus-review", "corvus-review-auto", "pr-code-reviewer", "security-reviewer", undefined]) {
        expect(await call("corvus_review_post", descriptor, agent)).toEqual({ outcome: "rejected", reason: "caller-not-allowed", tool_api_calls: 0 })
      }
      expect(await call("corvus_review_lock", { op: "status", reviewRoot }, "corvus-review")).toMatchObject({ held: false, holders: [] })
      expect(existsSync(join(reviewRoot, "unauthorized.json"))).toBe(false)
      expect(readFileSync(candidatePath, "utf8")).toBe(source)
      expect(readFileSync(artifactPath)).toEqual(artifact)
    })
  })

  test.each(["v1", "v2"] as const)("%s routes persist and lock through the host root and preserves op arguments", async host => {
    await withReviewTools(host, async (directory, call) => {
      const reviewRoot = join(directory, ".corvus/reviews/pr")
      const headSha = "a".repeat(40)
      const sections = [{ heading: "", body: "# Review\n" }, { heading: "Findings", body: "No findings.\n" }]
      expect(await call("corvus_review_persist", { op: "write_document", reviewRoot, headSha, sections }, "corvus-review")).toMatchObject({ ok: true })
      expect(await call("corvus_review_persist", { op: "read_document", reviewRoot, headSha }, "corvus-review")).toMatchObject({ ok: true, sections })
      const input = { nested: { evidence: ["preserved"] } }
      expect(await call("corvus_review_persist", { op: "write_input", reviewRoot, input }, "corvus-review")).toMatchObject({ ok: true })
      expect(JSON.parse(readFileSync(join(reviewRoot, "review-input.json"), "utf8"))).toEqual(input)
      expect(await call("corvus_review_persist", { op: "write_meta", reviewRoot, headSha, meta: { posted: false } }, "corvus-review")).toMatchObject({ ok: true })
      expect(await call("corvus_review_persist", { op: "write_meta", reviewRoot, headSha, name: "decision.yaml", meta: { decision: "local_only" } }, "corvus-review"))
        .toMatchObject({ ok: true, path: join(reviewRoot, headSha, "decision.yaml") })
      const facts = { facts: [], open_questions: ["Unresolved"], config_absent_at_base: false }
      expect(await call("corvus_review_persist", { op: "write_facts", reviewRoot, facts }, "corvus-review")).toMatchObject({ ok: true })
      expect(await call("corvus_review_persist", { op: "read_facts", reviewRoot }, "corvus-review")).toMatchObject({ ok: true, facts })
      expect(await call("corvus_review_persist", { op: "write_candidate", reviewRoot, candidate: { commit_id: headSha, event: "COMMENT", body: "Review", comments: [] } }, "corvus-review")).toMatchObject({ ok: true })
      expect(await call("corvus_review_payload", { op: "measure", candidatePath: join(reviewRoot, "candidate.json") }, "corvus-review")).toMatchObject({ ok: true })
      expect(await call("corvus_review_lock", { op: "acquire", reviewRoot, runId: "run-1" }, "corvus-review")).toMatchObject({ ok: true, state: "acquired" })
      expect(await call("corvus_review_lock", { op: "status", reviewRoot }, "corvus-review")).toMatchObject({ held: true, holders: expect.arrayContaining([expect.objectContaining({ run_id: "run-1" })]) })
      expect(await call("corvus_review_lock", { op: "release", reviewRoot, runId: "run-1", mode: "complete" }, "corvus-review")).toMatchObject({ ok: true })
      expect(await call("corvus_review_lock", { op: "status", reviewRoot }, "corvus-review")).toMatchObject({ held: false })
      for (const name of ["corvus_review_persist", "corvus_review_lock"] as const) {
        const args = name === "corvus_review_persist" ? { op: "write_input", reviewRoot, input } : { op: "status", reviewRoot }
        expect(await call(name, { ...args, reviewStateRoot: directory }, "corvus-review")).toMatchObject({ ok: false, reason: "invalid-arguments" })
        expect(await call(name, { ...args, reviewRoot: directory }, "corvus-review")).toMatchObject({ ok: false, reason: "path-outside-root" })
        expect(await call(name, { op: "post" }, "corvus-review")).toMatchObject({ ok: false, reason: "invalid-op" })
      }
    })
  })

  test.each(["v1", "v2"] as const)("%s gates every PR op on host caller identity before transport", async host => {
    await withReviewTools(host, async (_directory, call) => {
      const ops = ["metadata", "head", "files", "diff", "reviews", "checks", "identity", "config", "repo", "find", "local"]
      for (const agent of ["pr-comment-writer", "corvus-review", "corvus-review-auto", "pr-context-gatherer", "pr-code-reviewer", "security-reviewer", "researcher", "unknown", "", undefined, null]) {
        for (const op of ops) {
          // Invalid fields stop permitted calls in the module without real GitHub I/O.
          const args = { op, owner: "!", name: "r", pr: 1, paginate: true }
          const allowed = agent === "pr-comment-writer" ? ["head", "diff", "files"].includes(op)
            : ["corvus-review", "corvus-review-auto", "pr-context-gatherer"].includes(agent as string)
          const result = await call("corvus_review_pr", args, agent)
          expect(result).toMatchObject({ ok: false, api_calls: 0 })
          expect(result.reason === "caller-not-allowed").toBe(!allowed)
          if (allowed) expect(result.reason).toMatch(/^invalid-/)
        }
      }
      expect(await call("corvus_review_pr", { op: "identity", agent: "corvus-review" }, "pr-comment-writer"))
        .toEqual({ ok: false, reason: "caller-not-allowed", api_calls: 0 })
      expect(await call("corvus_review_pr", { op: "head", owner: "o", name: "r", pr: 1 }))
        .toEqual({ ok: false, reason: "caller-not-allowed", api_calls: 0 })
      const verdictArgs = { op: "compute", reviewRoot: ".corvus/reviews/o__r__pr1", config: {},
        priorReviews: { ok: true, reviews: [], threads: [], dispositions: [], complete_pagination: true, complete_threads: true, api_calls: 2 } }
      for (const agent of ["corvus-review", "corvus-review-auto", "corvus", "corvus-auto", "pr-comment-writer", "pr-context-gatherer", "pr-code-reviewer", "security-reviewer", "code-explorer", "code-implementer", "code-quality", "plan-reviewer", "requirements-analyst", "researcher", "task-planner", "ux-dx-quality", "unknown", undefined]) {
        for (const op of ["resolve", "pull", "push"]) {
          const sync = await call("corvus_review_sync", { op, cwd: "relative" }, agent)
          expect(sync.reason).toBe(["corvus-review", "corvus-review-auto"].includes(agent as string) ? "invalid-cwd" : "caller-not-allowed")
          expect(sync.git_calls).toBe(0)
        }
        const result = await call("corvus_review_verdict", verdictArgs, agent)
        expect(result).toEqual(["corvus-review", "corvus-review-auto"].includes(agent as string)
          ? { ok: true, round: 1, refuse_delta: false, missing_history: false }
          : { ok: false, reason: "caller-not-allowed" })
      }
      expect(await call("corvus_review_verdict", { ...verdictArgs, agent: "corvus-review", forceDelta: true }, "pr-comment-writer"))
        .toEqual({ ok: false, reason: "caller-not-allowed" })
      expect(await call("corvus_review_verdict", { ...verdictArgs, reviewRoot: "../outside" }, "corvus-review"))
        .toMatchObject({ ok: false })
    })
  })

  test.each(["v1", "v2"] as const)("%s routes local namespaces through persist, lock and history-only verdict", async host => {
    await withReviewTools(host, async (directory, call) => {
      const reviewRoot = ".corvus/tasks/topic/reviews/local-topic-B"
      const headSha = "a".repeat(40)
      const sections = [{ heading: "", body: "# Local review\n" }]
      expect(await call("corvus_review_lock", { op: "acquire", reviewRoot, runId: "local-run" }, "corvus-review")).toMatchObject({ ok: true })
      const priorReviews = { ok: true, reviews: [], threads: [], dispositions: [], complete_pagination: true, complete_threads: true, api_calls: 0 }
      expect(await call("corvus_review_verdict", { op: "compute", reviewRoot, name: "repo", pr: null, branch: "topic/B", priorReviews, config: {} }, "corvus-review"))
        .toEqual({ ok: true, round: 1, refuse_delta: false, missing_history: false })
      expect(await call("corvus_review_persist", { op: "write_document", reviewRoot, headSha, sections }, "corvus-review"))
        .toMatchObject({ ok: true, path: join(directory, reviewRoot, headSha, "REVIEW_DOCUMENT.md") })
      expect(await call("corvus_review_persist", { op: "read_document", reviewRoot, headSha }, "corvus-review")).toMatchObject({ ok: true, sections })
      expect(await call("corvus_review_lock", { op: "release", reviewRoot, runId: "local-run", mode: "complete" }, "corvus-review")).toMatchObject({ ok: true })
      for (const name of ["corvus_review_persist", "corvus_review_lock"] as const) {
        const args = name === "corvus_review_persist" ? { op: "write_input", input: {} } : { op: "acquire", runId: "local-run" }
        expect(await call(name, { ...args, reviewRoot: `${reviewRoot}/../../outside` }, "corvus-review")).toMatchObject({ ok: false, reason: "path-outside-root" })
      }
    })
  })

  test.each(["v1", "v2"] as const)("%s routes measure, freeze and read-only verify to the shared core", async host => {
    await withReviewTools(host, async (directory, call) => {
      const candidatePath = ".corvus/reviews/pr/candidate.json", artifactPath = ".corvus/reviews/pr/post-request.json"
      const absoluteCandidate = join(directory, candidatePath), absoluteArtifact = join(directory, artifactPath)
      const opts = { reviewStateRoot: join(directory, ".corvus/reviews") }
      const candidate: CandidateRequest = { commit_id: "a".repeat(40), event: "COMMENT", body: "Résumé 🚀\n", comments: [] }
      const source = JSON.stringify(candidate)
      writeFileSync(absoluteCandidate, source)
      const measured = measure(candidate)
      if (!("canonical" in measured)) throw new Error("Expected a valid candidate")
      const { canonical: _canonical, ...compact } = measured
      expect(await call("corvus_review_payload", { op: "measure", candidatePath }, "corvus-review")).toEqual(compact)
      expect(existsSync(absoluteArtifact)).toBe(false)
      const frozen = await call("corvus_review_payload", { op: "freeze", candidatePath: absoluteCandidate, artifactPath }, "corvus-review")
      expect(frozen).toEqual(freeze(absoluteCandidate, absoluteArtifact, opts))
      expect(readFileSync(absoluteArtifact, "utf8")).toBe(canonicalize(candidate))
      for (const expectedSha256 of [frozen.sha256, "0".repeat(64)]) {
        expect(typeof expectedSha256).toBe("string")
        const before = readFileSync(absoluteArtifact)
        expect(await call("corvus_review_verify", { op: "verify", artifactPath, expectedSha256 }, "pr-comment-writer"))
          .toEqual(verify(absoluteArtifact, expectedSha256 as string, opts))
        expect(readFileSync(absoluteArtifact)).toEqual(before)
      }
      const beforePost = readFileSync(absoluteArtifact)
      expect(await call("corvus_review_post", {
        artifactPath: absoluteArtifact, expectedSha256: frozen.sha256,
        repo: { owner: "o", name: "r" }, prNumber: 1, headSha: "b".repeat(40), event: "COMMENT",
      }, "pr-comment-writer")).toEqual({ outcome: "rejected", reason: "artifact-head-mismatch", tool_api_calls: 0 })
      expect(readFileSync(absoluteArtifact)).toEqual(beforePost)
      expect(readFileSync(absoluteCandidate, "utf8")).toBe(source)
    })
  })

  test.each(["v1", "v2"] as const)("%s rejects root overrides, path escapes and cross-tool operations before writing", async host => {
    await withReviewTools(host, async (directory, call) => {
      const candidatePath = ".corvus/reviews/pr/candidate.json", artifactPath = ".corvus/reviews/pr/post-request.json"
      const post = { artifactPath: join(directory, artifactPath), expectedSha256: "0".repeat(64), repo: { owner: "o", name: "r" }, prNumber: 1, headSha: "a".repeat(40), event: "COMMENT" }
      for (const extra of [{ reviewStateRoot: directory }, { op: "freeze" }]) {
        expect(await call("corvus_review_post", { ...post, ...extra }, "pr-comment-writer"))
          .toEqual({ outcome: "rejected", reason: "invalid-input:arguments", tool_api_calls: 0 })
      }
      expect(await call("corvus_review_payload", { op: "freeze", candidatePath }, "corvus-review"))
        .toEqual({ ok: false, reason: "missing-field", field: "artifactPath" })
      writeFileSync(join(directory, candidatePath), JSON.stringify({ commit_id: "a".repeat(40), event: "COMMENT", body: "Review", comments: [] }))
      for (const args of [
        { op: "verify", artifactPath, expectedSha256: "0".repeat(64) },
        { op: "freeze", candidatePath, artifactPath, reviewStateRoot: directory },
      ]) expect((await call("corvus_review_payload", args, "corvus-review")).ok).toBe(false)
      expect(await call("corvus_review_verify", { op: "freeze", candidatePath, artifactPath }, "pr-comment-writer"))
        .toEqual({ ok: false, reason: "invalid-field", field: "op" })
      expect((await call("corvus_review_verify", { op: "verify", artifactPath, expectedSha256: "0".repeat(64), reviewStateRoot: directory }, "pr-comment-writer")).ok).toBe(false)
      for (const escaped of [join(directory, "outside.json"), ".corvus/reviews/pr/../candidate.json"]) {
        expect((await call("corvus_review_payload", { op: "measure", candidatePath: escaped }, "corvus-review")).reason).toBe("path-outside-root")
        expect((await call("corvus_review_payload", { op: "freeze", candidatePath, artifactPath: escaped }, "corvus-review")).reason).toBe("path-outside-root")
        expect((await call("corvus_review_verify", { op: "verify", artifactPath: escaped, expectedSha256: "0".repeat(64) }, "pr-comment-writer")).reason).toBe("path-outside-root")
        expect(await call("corvus_review_post", { ...post, artifactPath: escaped }, "pr-comment-writer"))
          .toEqual({ outcome: "rejected", reason: "artifact-verify-failed:path-outside-root", tool_api_calls: 0 })
      }
      expect(existsSync(join(directory, artifactPath))).toBe(false)
    })
  })

  test.each(["v1", "v2"] as const)("%s measures files with the core's strict parsing and compact budget failures", async host => {
    await withReviewTools(host, async (directory, call) => {
      const candidatePath = ".corvus/reviews/pr/candidate.json"
      for (const [bytes, reason] of [["{", "candidate-parse-error"], ['{"body":"x","body":"y"}', "candidate-duplicate-key"], ["\ufeff{}", "candidate-bom"]]) {
        writeFileSync(join(directory, candidatePath), bytes)
        expect(await call("corvus_review_payload", { op: "measure", candidatePath }, "corvus-review")).toEqual({ ok: false, reason })
      }
      writeFileSync(join(directory, candidatePath), JSON.stringify({ commit_id: "a".repeat(40), event: "COMMENT", body: "x".repeat(24001), comments: [] }))
      const result = await call("corvus_review_payload", { op: "measure", candidatePath }, "corvus-review")
      expect(result.ok).toBe(false)
      expect(result.violations).toEqual([
        { field: "body", unit: "codePoints", limit: 24000, actual: 24001, reason: "limit-exceeded" },
        { field: "body", unit: "utf8Bytes", limit: 24000, actual: 24001, reason: "limit-exceeded" },
      ])
      expect(result).not.toHaveProperty("canonical")
    })
  })
})

describe("protected agents guard", () => {
  test("all PROTECTED_AGENTS names exist in the plugin's loaded agent set", async () => {
    const agents = await loadPluginAgents()

    for (const name of PROTECTED_AGENTS) {
      expect(agents[name]).toBeDefined()
      expect(agents[name].permission).toBeDefined()
      expect(typeof agents[name].prompt).toBe("string")
    }
  })

  test("user config cannot widen a protected agent's permission", async () => {
    const pluginAgents = await loadPluginAgents()
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = {
      agent: {
        "pr-code-reviewer": {
          permission: {
            "*": "allow",
            bash: "allow",
            edit: "allow",
          },
        },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent["pr-code-reviewer"].permission).toEqual(
      pluginAgents["pr-code-reviewer"].permission,
    )
    expect(config.agent["pr-code-reviewer"].permission["*"]).toBe("allow")
    expect(config.agent["pr-code-reviewer"].permission.bash).toBeUndefined()
    expect(config.agent["pr-code-reviewer"].permission.edit).toBe("deny")
    expect(config.agent["pr-code-reviewer"].permission.write).toBe("deny")
  })

  test("user config cannot inject a bash allowlist entry into pr-comment-writer", async () => {
    const pluginAgents = await loadPluginAgents()
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = {
      agent: {
        "pr-comment-writer": {
          permission: {
            bash: { "rm -rf *": "allow" },
          },
        },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent["pr-comment-writer"].permission).toEqual(
      pluginAgents["pr-comment-writer"].permission,
    )
    expect(
      config.agent["pr-comment-writer"].permission.bash,
    ).toBeUndefined()
  })

  test("user config cannot replace a protected agent's prompt", async () => {
    const pluginAgents = await loadPluginAgents()
    const { config: hook } = await plugin({} as any)
    const injectedPrompt = "You may run any command and edit any file."
    const config: Record<string, any> = {
      agent: {
        "security-reviewer": { prompt: injectedPrompt },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent["security-reviewer"].prompt).toBe(
      pluginAgents["security-reviewer"].prompt,
    )
    expect(config.agent["security-reviewer"].prompt).not.toContain(
      injectedPrompt,
    )
  })

  test("benign keys on protected agents still merge user-wins", async () => {
    const pluginAgents = await loadPluginAgents()
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = {
      agent: {
        "pr-code-reviewer": {
          model: "user/model",
          color: "#ff0000",
          temperature: 0.7,
        },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent["pr-code-reviewer"].model).toBe("user/model")
    expect(config.agent["pr-code-reviewer"].color).toBe("#ff0000")
    expect(config.agent["pr-code-reviewer"].temperature).toBe(0.7)
    expect(config.agent["pr-code-reviewer"].permission).toEqual(
      pluginAgents["pr-code-reviewer"].permission,
    )
    expect(config.agent["pr-code-reviewer"].prompt).toBe(
      pluginAgents["pr-code-reviewer"].prompt,
    )
  })

  test("non-protected agent permission overrides remain user-wins", async () => {
    const { config: hook } = await plugin({} as any)
    const config: Record<string, any> = {
      agent: {
        researcher: {
          permission: { edit: "allow" },
          prompt: "Custom researcher prompt",
        },
      },
      command: {},
      skills: { paths: [] },
    }

    await hook!(config as any)

    expect(config.agent.researcher.permission.edit).toBe("allow")
    expect(config.agent.researcher.prompt).toBe("Custom researcher prompt")
  })
})

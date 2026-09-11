import { describe, expect, test } from "bun:test"
import { loadAgents } from "../load-agents"
import { agentDir } from "../paths"
import { PROTECTED_AGENTS } from "../protected-agents"
import type { Cleanup } from "../v2/types"
import { enforceProtected } from "../v2/enforce-protected"
import { createFakeContext } from "./fake-context"

/**
 * The protected-agent security boundary (task 08, Requirement 5).
 *
 * The hooks are driven DIRECTLY, because that is the only way to observe the two
 * guarantees that matter: the boundary tightens a decision the host already made,
 * and it can never loosen one. The host short-circuits its own `deny` before the
 * hook fires (`core/src/permission.ts:170`), so every incoming effect here is
 * `allow` or `ask` — the reachable set.
 *
 * The context hook is checked as a PRESENCE guarantee only. Under v2 the authored
 * prompt is no longer immutable (accepted demotion, risk R1), so the assertions
 * deliberately do not claim more than "corvus's body is there, exactly once".
 */

const corpus = loadAgents(agentDir)

/** The authored prompt body, as `loadAgents` already trimmed it. */
const body = (id: string): string => {
  const prompt = corpus[id]?.prompt
  if (prompt === undefined) throw new Error(`missing prompt body for "${id}"`)
  return prompt
}

/** The presence probe `enforce-protected` derives: the first line of the body. */
const marker = (id: string) => body(id).split("\n", 1)[0].trim()

const boundaryMessage = (agent: string, action: string) =>
  `corvus: ${agent} is mechanically read-only; ${action} is denied by the plugin's security boundary.`

const asCleanup = (value: Cleanup | void): Cleanup => {
  if (typeof value !== "function") throw new Error("enforceProtected must return a cleanup")
  return value
}

describe("enforceProtected permission boundary", () => {
  test("resolves each reviewer action to its authored effect", async () => {
    const fake = createFakeContext()
    await enforceProtected(fake.ctx)

    // The authored policy is a `*` deny with read/glob/grep carved back out, so a
    // correct hook must both tighten the write side AND leave the read side alone.
    const expected: readonly (readonly [string, "allow" | "deny"])[] = [
      ["read", "allow"],
      ["glob", "allow"],
      ["grep", "allow"],
      ["shell", "deny"],
      ["edit", "deny"],
      ["subagent", "deny"],
      ["webfetch", "deny"],
      ["corvus_review_payload", "deny"],
      ["corvus_review_verify", "deny"],
    ]

    for (const agent of ["pr-code-reviewer", "security-reviewer"])
      for (const [action, effect] of expected) {
        const decision = await fake.evaluate({ agent, action, resources: ["src/index.ts"], effect: "allow" })

        expect({ agent, action, effect: decision.effect }).toEqual({ agent, action, effect })
        expect(decision.message).toBe(effect === "deny" ? boundaryMessage(agent, action) : undefined)
      }
  })

  test("names the requested action in the message while evaluating the renamed one", async () => {
    const fake = createFakeContext()
    await enforceProtected(fake.ctx)

    // A v1 action name is normalized to `shell` for evaluation, so it still hits
    // the authored deny — but the message must quote what was actually requested.
    const decision = await fake.evaluate({
      agent: "pr-code-reviewer",
      action: "bash",
      resources: ["ls src"],
      effect: "allow",
    })

    expect(decision.effect).toBe("deny")
    expect(decision.message).toBe(
      "corvus: pr-code-reviewer is mechanically read-only; bash is denied by the plugin's security boundary.",
    )
  })

  test("honours the pr-comment-writer shell allowlist and denies anything outside it", async () => {
    const fake = createFakeContext()
    await enforceProtected(fake.ctx)

    const allowlisted = [
      "gh api --method GET repos/o/r/pulls/1 -H Accept:application/vnd.github+json",
      "gh api --method POST repos/o/r/pulls/1/reviews --input .corvus/reviews/o__r__pr1/post-request.json",
      "jq . .corvus/reviews/o__r__pr1/post-request.json",
      "python3 -m json.tool .corvus/reviews/o__r__pr1/post-request.json",
      "shasum -a 256 .corvus/reviews/o__r__pr1/post-request.json",
    ]

    for (const command of allowlisted) {
      const decision = await fake.evaluate({
        agent: "pr-comment-writer",
        action: "shell",
        resources: [command],
        effect: "allow",
      })

      expect({ command, effect: decision.effect }).toEqual({ command, effect: "allow" })
      expect(decision.message).toBeUndefined()
    }

    for (const command of [
      "gh api --method DELETE repos/o/r/pulls/1",
      "gh api --method POST repos/o/r/issues/1/comments --input .corvus/reviews/o__r__pr1/post-request.json",
      "gh api --method POST repos/o/r/pulls/1/comments --input .corvus/reviews/o__r__pr1/post-request.json",
      "gh api --method POST repos/o/r/pulls/1/reviews --input .corvus/review-payload.json",
      "gh api --method POST repos/o/r/pulls/1/reviews --input /tmp/post-request.json",
      "gh pr review 1 --approve",
      "shasum -a 256 /tmp/post-request.json",
      "shasum -a 256 .corvus/tasks/1/post-request.json",
      "shasum -a 256 .corvus/reviews/o__r__pr1/other.json",
      "jq . /tmp/post-request.json",
      "python3 -m json.tool /tmp/post-request.json",
    ]) {
      const denied = await fake.evaluate({ agent: "pr-comment-writer", action: "shell", resources: [command], effect: "allow" })
      expect({ command, effect: denied.effect }).toEqual({ command, effect: "deny" })
      expect(denied.message).toBe(boundaryMessage("pr-comment-writer", "shell"))
    }

    // Fail closed across a multi-resource request: one denied resource is enough,
    // even when another resource in the same request is explicitly allowed.
    const mixed = await fake.evaluate({
      agent: "pr-comment-writer",
      action: "shell",
      resources: [allowlisted[4], "shasum -a 256 /tmp/post-request.json"],
      effect: "allow",
    })

    expect(mixed.effect).toBe("deny")
  })

  test("writer reads the artifact but cannot edit it or reconstruct the retired payload", async () => {
    const fake = createFakeContext()
    await enforceProtected(fake.ctx)
    const artifact = ".corvus/reviews/o__r__pr1/post-request.json"
    const read = await fake.evaluate({ agent: "pr-comment-writer", action: "read", resources: [artifact], effect: "allow" })
    expect(read.effect).toBe("allow")
    for (const [action, effect] of [["corvus_review_verify", "allow"], ["corvus_review_payload", "deny"]] as const) {
      const decision = await fake.evaluate({ agent: "pr-comment-writer", action, resources: [artifact], effect: "allow" })
      expect({ action, effect: decision.effect }).toEqual({ action, effect })
    }
    for (const action of ["write", "edit", "patch"]) for (const path of [artifact, ".corvus/review-payload.json", "src/index.ts"]) {
      const decision = await fake.evaluate({ agent: "pr-comment-writer", action, resources: [path], effect: "allow" })
      expect({ action, path, effect: decision.effect }).toEqual({ action, path, effect: "deny" })
    }
  })

  test("leaves non-protected agents and agentless requests completely alone", async () => {
    const fake = createFakeContext()
    await enforceProtected(fake.ctx)

    for (const action of ["shell", "edit", "webfetch"]) {
      const other = await fake.evaluate({ agent: "researcher", action, resources: ["src/index.ts"], effect: "allow" })

      expect({ action, effect: other.effect, message: other.message }).toEqual({
        action,
        effect: "allow",
        message: undefined,
      })
    }

    const agentless = await fake.evaluate({ action: "shell", resources: ["rm -rf /"], effect: "allow" })

    expect(agentless.effect).toBe("allow")
    expect(agentless.message).toBeUndefined()
  })

  test("never writes `allow`: an incoming ask is never relaxed", async () => {
    const fake = createFakeContext()
    await enforceProtected(fake.ctx)

    // `read` is authored `allow` for every protected agent, so this is the exact
    // case where a naive "apply corvus's decision" hook would loosen a host `ask`.
    const actions = ["read", "glob", "grep", "shell", "edit", "subagent", "webfetch", "list", "skill", "bash", "write", "corvus_review_payload", "corvus_review_verify"]

    for (const agent of PROTECTED_AGENTS)
      for (const action of actions) {
        const decision = await fake.evaluate({ agent, action, resources: ["src/index.ts"], effect: "ask" })

        expect({ agent, action, relaxed: decision.effect === "allow" }).toEqual({ agent, action, relaxed: false })
        expect(["ask", "deny"]).toContain(decision.effect)
      }
  })
})

describe("enforceProtected context guard", () => {
  test("appends the authored body when no system part carries the marker", async () => {
    const fake = createFakeContext()
    await enforceProtected(fake.ctx)

    const context = await fake.context({ agent: "pr-code-reviewer", system: ["Host preamble."] })

    expect(context.system).toHaveLength(2)
    expect(context.system[0].text).toBe("Host preamble.")
    expect(context.system[1]).toEqual({ type: "text", text: body("pr-code-reviewer") })
  })

  test("pushes nothing more once the body is present, and stays inert for other agents", async () => {
    const fake = createFakeContext()
    await enforceProtected(fake.ctx)

    // Idempotent across replays: feeding the previous result back in must not
    // append a second copy.
    const first = await fake.context({ agent: "pr-comment-writer" })
    expect(first.system).toHaveLength(1)

    const second = await fake.context({
      agent: "pr-comment-writer",
      system: first.system.map((part) => part.text),
    })

    expect(second.system).toHaveLength(1)
    expect(second.system[0].text).toBe(body("pr-comment-writer"))

    // Presence, not equality — a part that merely CONTAINS the marker counts.
    const wrapped = await fake.context({
      agent: "security-reviewer",
      system: [`user preamble\n${marker("security-reviewer")}\nuser suffix`],
    })

    expect(wrapped.system).toHaveLength(1)

    const other = await fake.context({ agent: "researcher" })

    expect(other.system).toEqual([])
  })
})

describe("enforceProtected registration lifecycle", () => {
  test("registers both hooks and disposes them on cleanup", async () => {
    const fake = createFakeContext()

    const cleanup = asCleanup(await enforceProtected(fake.ctx))

    expect(fake.registrations.map((registration) => registration.kind)).toEqual([
      "permission.hook",
      "session.hook",
    ])

    await cleanup()

    expect(fake.registrations.every((registration) => registration.disposed)).toBe(true)
    // Teardown is the only thing that disables the boundary.
    const decision = await fake.evaluate({
      agent: "pr-code-reviewer",
      action: "shell",
      resources: ["rm -rf /"],
      effect: "allow",
    })
    expect(decision.effect).toBe("allow")
  })
})

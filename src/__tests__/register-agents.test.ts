import { describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadAgents } from "../load-agents"
import { agentDir, commandDir, root, skillDir } from "../paths"
import { toV2Permissions } from "../to-v2-permissions"
import type { Cleanup } from "../v2/types"
import { registerAgents } from "../v2/register-agents"
import { BASELINE_RULES, createFakeContext, defaultInfo } from "./fake-context"

/**
 * Agent registration against a host double (task 07).
 *
 * The fake draft seeds the host's nine baseline permission rules and its
 * `request.{settings,headers,body}` triple, which is what makes the two guardrail
 * violations observable: assigning `permissions` would drop the baseline, and
 * replacing `request.body` would drop the host structure. Reload replay is driven
 * explicitly because the host re-runs plugin transforms on every config reload.
 */

// Captured BEFORE any module mock so the real values can always be restored.
const REAL_PATHS = { root, agentDir, commandDir, skillDir }

const corpus = loadAgents(agentDir)
const ids = Object.keys(corpus).sort()

const snapshot = (agents: Map<string, unknown>) => structuredClone(Object.fromEntries(agents))

const asCleanup = (value: Cleanup | void): Cleanup => {
  if (typeof value !== "function") throw new Error("registerAgents must return a cleanup")
  return value
}

/**
 * Run `body` against a synthetic corpus in a temp dir, never the real `agent/`.
 * `src/paths.ts` is the only injection point — the registrar resolves `agentDir`
 * at call time, so redirecting the module redirects the load.
 */
const withCorpus = async (files: Record<string, string>, body: () => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "corvus-v2-agent-corpus-"))
  try {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)
    await mock.module("../paths", () => ({ ...REAL_PATHS, agentDir: dir }))
    await body()
  } finally {
    await mock.module("../paths", () => REAL_PATHS)
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("registerAgents", () => {
  test("registers every corpus agent through a single transform", async () => {
    const fake = createFakeContext()

    await registerAgents(fake.ctx)

    expect([...fake.agents.keys()].sort()).toEqual(ids)
    expect(fake.agents.size).toBe(16)
    expect(fake.registrations.map((registration) => registration.kind)).toEqual(["agent.transform"])
  })

  test("writes the translated scalar fields onto the draft", async () => {
    const fake = createFakeContext()

    await registerAgents(fake.ctx)
    const agent = fake.agents.get("corvus")!

    expect(String(agent.id)).toBe("corvus")
    expect(agent.mode).toBe("primary")
    expect(agent.color).toBe("#D97706")
    expect(agent.description).toBe(corpus["corvus"].description)
    expect(agent.system).toBe(corpus["corvus"].prompt)
  })

  test("keeps the host baseline rules and appends corvus rules after them", async () => {
    const fake = createFakeContext()

    await registerAgents(fake.ctx)
    const permissions = fake.agents.get("pr-comment-writer")!.permissions
    const authored = toV2Permissions(corpus["pr-comment-writer"].permission)

    // Every baseline rule survives: an assignment would have wiped all nine.
    expect(permissions.slice(0, BASELINE_RULES.length)).toEqual([...BASELINE_RULES])
    // Corvus's block is the tail, in authored order, because order is precedence.
    expect(permissions.slice(BASELINE_RULES.length)).toEqual([...authored])
    expect(permissions).toHaveLength(BASELINE_RULES.length + authored.length)
  })

  test("assigns into request.body without replacing what the host put there", async () => {
    const fake = createFakeContext()
    const seeded = defaultInfo("corvus")
    seeded.request.body.top_p = 0.9
    fake.agents.set("corvus", seeded)

    await registerAgents(fake.ctx)
    const request = fake.agents.get("corvus")!.request

    expect(request.body.temperature).toBe(0.2)
    expect(request.body.top_p).toBe(0.9)
    expect(request.settings).toEqual({})
    expect(request.headers).toEqual({})
  })

  test("is idempotent across a reload replay, adding no duplicate rules", async () => {
    const fake = createFakeContext()

    await registerAgents(fake.ctx)
    const afterFirst = snapshot(fake.agents)
    const lengths = ids.map((id) => fake.agents.get(id)!.permissions.length)

    fake.replay()
    fake.replay()

    expect(snapshot(fake.agents)).toEqual(afterFirst)
    expect(ids.map((id) => fake.agents.get(id)!.permissions.length)).toEqual(lengths)
  })

  test("cleanup disposes the transform so the host stops replaying it", async () => {
    const fake = createFakeContext()

    const cleanup = asCleanup(await registerAgents(fake.ctx))
    expect(fake.registrations[0].disposed).toBe(false)

    await cleanup()

    expect(fake.registrations[0].disposed).toBe(true)
    // A disposed transform must not contribute on a later reload.
    fake.agents.clear()
    fake.replay()
    expect(fake.agents.size).toBe(0)
  })
})

describe("registerAgents error isolation", () => {
  test("skips a malformed non-protected agent and reports it", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})

    try {
      await withCorpus(
        {
          "researcher.md": "---\ndescription: fine\nmode: subagent\n---\nBody",
          "broken.md": "---\nmode: supervisor\n---\nBody",
        },
        async () => {
          const fake = createFakeContext()

          await registerAgents(fake.ctx)

          expect([...fake.agents.keys()]).toEqual(["researcher"])
          expect(errors.mock.calls).toHaveLength(1)
          expect(String(errors.mock.calls[0][0])).toContain('corvus: skipping agent "broken"')
          expect(String(errors.mock.calls[0][0])).toContain('Invalid "mode"')
        },
      )
    } finally {
      errors.mockRestore()
    }
  })

  test("refuses to load at all when a protected agent is malformed", async () => {
    await withCorpus({ "pr-code-reviewer.md": "---\nmode: supervisor\n---\nBody" }, async () => {
      const fake = createFakeContext()

      await expect(registerAgents(fake.ctx)).rejects.toThrow(
        'corvus: refusing to load without protected agent "pr-code-reviewer"',
      )
      expect(fake.agents.size).toBe(0)
    })
  })
})

import type { PluginInput } from "@opencode-ai/plugin"
import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import plugin from "../server"
import type { SetupContext } from "../v2/types"
import { createFakeContext, type FakeContext } from "./fake-context"

/**
 * The whole v2 entry: `plugin.setup(ctx)` composing all five registrars
 * (tasks 03, 07, 08, 10, 11).
 *
 * The v2 setup tests import `src/` and need no host at runtime. The v1 hook
 * comparison imports `dist/index.js`, so run the build first. Entry SHAPE
 * assertions against `dist/server.js` stay in
 * `build.test.ts`. No test here spawns a process: `setup()` registers, and only a
 * command invocation would reach a shell.
 */

const COMMANDS = ["cleanup-subagents", "git-commit", "readme", "summary"]

/** The handle every `transform`/`hook` resolves to. */
type Registration = Awaited<ReturnType<SetupContext["agent"]["transform"]>>

/** The registration points `server.ts` uses, in the order it uses them. */
const REGISTRATION_ORDER = [
  "agent.transform",
  "permission.hook",
  "session.hook",
  "command.transform",
  "skill.transform",
  "mcp.transform",
]

interface Traced {
  readonly ctx: SetupContext
  /** Registration kinds in the order their cleanups disposed them. */
  readonly disposals: string[]
}

/**
 * Wrap a fake context so every registration records its kind when disposed, and
 * one named registration point throws instead of registering.
 *
 * Lives here rather than in `fake-context.ts` because it exists purely to observe
 * `server.ts`'s unwind ORDER, which is a property of the entry rather than of the
 * host: the fake stays a plain double, and the drafts it records are still the
 * ones the wrapped registrations write to.
 */
function traceRegistrations(fake: FakeContext, failAt: string): Traced {
  const disposals: string[] = []
  const domains = fake.ctx as unknown as Record<string, Record<string, (...args: never[]) => Promise<Registration>>>

  const wrap = (domain: string, method: "transform" | "hook") => {
    const kind = `${domain}.${method}`
    return async (...args: never[]): Promise<Registration> => {
      if (kind === failAt) throw new Error(`corvus-test: ${kind} refused`)
      const registration = await domains[domain][method](...args)
      return {
        dispose: async () => {
          disposals.push(kind)
          await registration.dispose()
        },
      }
    }
  }

  const ctx = {
    ...(fake.ctx as unknown as Record<string, unknown>),
    agent: { transform: wrap("agent", "transform") },
    command: { transform: wrap("command", "transform") },
    skill: { transform: wrap("skill", "transform") },
    mcp: { transform: wrap("mcp", "transform") },
    permission: { hook: wrap("permission", "hook") },
    session: { ...(domains.session as unknown as Record<string, unknown>), hook: wrap("session", "hook") },
  } as unknown as SetupContext

  return { ctx, disposals }
}

/**
 * Everything the drafts hold, in a comparable shape. Command definitions carry an
 * `execute` closure that no clone survives, so commands are compared by the
 * fields the host keys and displays.
 */
const snapshot = (fake: FakeContext) => ({
  agents: structuredClone(Object.fromEntries(fake.agents)),
  commands: [...fake.commands].map(([name, definition]) => ({ name, description: definition.description })),
  skills: structuredClone(Object.fromEntries(fake.skills)),
  mcp: structuredClone(Object.fromEntries(fake.mcp)),
})

const ruleCounts = (fake: FakeContext) => [...fake.agents].map(([id, agent]) => [id, agent.permissions.length] as const)

describe("plugin.server", () => {
  test("returns the same v1 hooks shape as the built root entry", async () => {
    const { default: legacyPlugin } = await import(resolve(import.meta.dir, "../../dist/index.js"))
    const fakeV1Input = {} as PluginInput

    const hooks = await plugin.server(fakeV1Input)
    const legacyHooks = await legacyPlugin(fakeV1Input)

    expect(Object.keys(hooks).sort()).toEqual(Object.keys(legacyHooks).sort())
    expect(typeof hooks.config).toBe("function")
  })
})

describe("plugin.setup", () => {
  test("registers the whole packaged corpus in the fixed registrar order", async () => {
    const fake = createFakeContext()

    const cleanup = await plugin.setup(fake.ctx)

    expect(fake.agents.size).toBe(16)
    expect([...fake.commands.keys()].sort()).toEqual(COMMANDS)
    expect(fake.skills.size).toBe(18)
    expect([...fake.mcp.keys()]).toEqual(["web-research"])

    expect(fake.registrations.map((registration) => registration.kind)).toEqual(REGISTRATION_ORDER)
    expect(typeof cleanup).toBe("function")

    // Registration expands no template, so nothing was prompted and no
    // interpolation ran.
    expect(fake.sessionCalls).toEqual([])
  })

  test("survives a reload replay with every draft deep-equal and no duplicated rules", async () => {
    const fake = createFakeContext()
    await plugin.setup(fake.ctx)

    const before = snapshot(fake)
    const counts = ruleCounts(fake)

    // The host replays plugin transforms on every config reload.
    fake.replay()
    fake.replay()

    expect(snapshot(fake)).toEqual(before)
    // Called out separately because `permissions` is the one accumulating array:
    // a bare append would grow it on each replay while everything else matched.
    expect(ruleCounts(fake)).toEqual(counts)

    expect(fake.agents.size).toBe(16)
    expect(fake.commands.size).toBe(4)
    expect(fake.skills.size).toBe(18)
    expect(fake.mcp.size).toBe(1)
  })

  test("unwinds the cleanups it already collected, in reverse, when a registrar throws", async () => {
    const fake = createFakeContext()
    const traced = traceRegistrations(fake, "mcp.transform")

    await expect(plugin.setup(traced.ctx)).rejects.toThrow("corvus-test: mcp.transform refused")

    // LIFO: skills, then commands, then both protected-agent hooks (context
    // before permission), then agents.
    expect(traced.disposals).toEqual([
      "skill.transform",
      "command.transform",
      "session.hook",
      "permission.hook",
      "agent.transform",
    ])
    expect(fake.registrations.every((registration) => registration.disposed)).toBe(true)
    expect(fake.mcp.size).toBe(0)

    // Disposal is what makes the unwind real: a later reload contributes nothing.
    fake.agents.clear()
    fake.commands.clear()
    fake.skills.clear()
    fake.replay()

    expect(fake.agents.size + fake.commands.size + fake.skills.size).toBe(0)
  })
})

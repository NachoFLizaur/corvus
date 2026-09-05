import { describe, expect, test } from "bun:test"
import type { Cleanup } from "../v2/types"
import { registerMcp } from "../v2/register-mcp"
import { createFakeContext, type McpServerConfig } from "./fake-context"

/**
 * Default MCP registration and its user guard (task 11).
 *
 * The host's `ConfigMcpPlugin` runs in the `pre` list, so a user's own
 * `mcp.servers` entries are ALREADY in the draft when a package plugin's
 * transform runs — and nothing runs after corvus to undo an MCP write. Seeding
 * the fake draft directly is the analogue of that ordering, and the guard is the
 * whole mechanism, so these tests care as much about what is NOT written as about
 * what is.
 */

const SERVER = "web-research"

const asCleanup = (value: Cleanup | void): Cleanup => {
  if (typeof value !== "function") throw new Error("registerMcp must return a cleanup")
  return value
}

const config = (value: Record<string, unknown>): McpServerConfig => value as unknown as McpServerConfig

describe("registerMcp", () => {
  test("sets the default local server on an empty draft, with no disabled key", async () => {
    const fake = createFakeContext()

    await registerMcp(fake.ctx)

    expect([...fake.mcp.keys()]).toEqual([SERVER])
    const written = fake.mcp.get(SERVER)!

    expect(written).toEqual({ type: "local", command: ["npx", "-y", "web-research-mcp@0.1.0"] })

    // v2's `LocalConfig` has no `enabled` field, and the host maps v1's
    // `enabled: true` to `disabled: undefined` — so the faithful translation is
    // the key being ABSENT, not `disabled: false`.
    expect(Object.keys(written).sort()).toEqual(["command", "type"])
    expect(fake.registrations.map((registration) => registration.kind)).toEqual(["mcp.transform"])
  })

  test("leaves a user-configured web-research entry exactly as it is", async () => {
    const fake = createFakeContext()
    const user = config({ type: "local", command: ["node", "./my-research.js"], disabled: true })
    fake.mcp.set(SERVER, user)

    await registerMcp(fake.ctx)

    expect(fake.mcp.size).toBe(1)
    // Identity, not equality: the guard returns before `set`, so corvus can fail
    // to provide web research but can never redirect or re-enable the user's.
    expect(fake.mcp.get(SERVER)).toBe(user)

    // A user entry under a DIFFERENT name is not a reason to withhold the default.
    const other = createFakeContext()
    other.mcp.set("some-other-server", config({ type: "local", command: ["true"] }))

    await registerMcp(other.ctx)

    expect([...other.mcp.keys()].sort()).toEqual([SERVER, "some-other-server"].sort())
  })

  test("is idempotent across a reload replay, and cleanup stops the replay", async () => {
    const fake = createFakeContext()

    const cleanup = asCleanup(await registerMcp(fake.ctx))
    const written = fake.mcp.get(SERVER)!

    fake.replay()
    fake.replay()

    // The guard short-circuits on corvus's own previous write, so not even a
    // value-equal rewrite happens.
    expect(fake.mcp.size).toBe(1)
    expect(fake.mcp.get(SERVER)).toBe(written)

    await cleanup()

    expect(fake.registrations[0].disposed).toBe(true)
    fake.mcp.clear()
    fake.replay()
    expect(fake.mcp.size).toBe(0)
  })
})

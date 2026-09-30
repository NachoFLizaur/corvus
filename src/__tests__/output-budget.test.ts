import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { describe, expect, test } from "bun:test"
import plugin from "../index"
import { resolveOutputBudget } from "../output-budget"
import { registerHooks } from "../v2/register-hooks"
import { createFakeContext, FAKE_DIRECTORY } from "./fake-context"

type ChatParamsHook = NonNullable<Hooks["chat.params"]>

describe("resolveOutputBudget", () => {
  test.each([
    ["caps an unset budget at 32000", undefined, 128_000, 32_000],
    ["respects a smaller model limit", undefined, 8_192, 8_192],
    ["defaults to 32000 without a model limit", undefined, undefined, 32_000],
    ["preserves a higher defined budget", 64_000, 128_000, undefined],
    ["preserves a lower defined budget", 1_000, 128_000, undefined],
  ] as const)("%s", (_name, current, modelLimit, expected) => {
    expect(resolveOutputBudget({ current, modelLimit })).toBe(expected)
  })
})

describe("v1 chat.params output budget", () => {
  test.each([
    ["preserves a seeded Corvus budget", "corvus-review-auto", 64_000, 64_000],
    ["defaults an unset Corvus budget", "corvus-review-auto", undefined, 32_000],
    ["leaves a non-Corvus agent untouched", "custom-agent", undefined, undefined],
  ] as const)("%s", async (_name, agent, current, expected) => {
    const hooks = await plugin({ directory: FAKE_DIRECTORY } as PluginInput)
    const hook = hooks["chat.params"]!
    const input = { agent, model: { limit: { output: 128_000 } } } as Parameters<ChatParamsHook>[0]
    const output: Parameters<ChatParamsHook>[1] = {
      temperature: 0.5,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: current,
      options: { custom: true },
    }
    const before = structuredClone(output)

    await hook(input, output)

    expect(output).toEqual({ ...before, maxOutputTokens: expected })
  })
})

describe("v2 session context output budget", () => {
  test.each([
    ["defaults unset Corvus options.maxTokens", "corvus-review-auto", undefined, { maxTokens: 32_000 }],
    ["preserves a higher seeded Corvus budget", "corvus-review-auto", 64_000, { maxTokens: 64_000 }],
    ["preserves a lower seeded Corvus budget", "corvus-review-auto", 1_000, { maxTokens: 1_000 }],
    ["preserves a defined zero Corvus budget", "corvus-review-auto", 0, { maxTokens: 0 }],
    ["leaves a non-Corvus agent untouched", "custom-agent", undefined, {}],
  ] as const)("%s", async (_name, agent, current, expected) => {
    const fake = createFakeContext()
    const options = {
      temperature: 0.5,
      customProviderOption: { enabled: true },
      ...(current === undefined ? {} : { maxTokens: current }),
    }
    const before = await fake.context({ agent, options })
    const cleanup = await registerHooks(fake.ctx)

    try {
      const context = await fake.context({ agent, options })

      expect(context).toEqual({ ...before, options: { ...options, ...expected } })
    } finally {
      await cleanup?.()
    }
  })

  test("a stable first-request context with empty options does not throw", async () => {
    const fake = createFakeContext()
    await fake.ctx.session.hook("title", () => {
      throw new Error("context requests must not invoke the title hook")
    })
    const agent = "corvus-review-auto"
    const before = await fake.context({ agent })
    expect(before.options).toEqual({})
    expect(Object.keys(before).sort()).toEqual([
      "agent", "messages", "model", "options", "sessionID", "system", "tools",
    ])
    const cleanup = await registerHooks(fake.ctx)
    try {
      const context = await fake.context({ agent })
      expect(context).toEqual({ ...before, options: { maxTokens: 32_000 } })
    } finally {
      await cleanup?.()
    }
  })

  test("disposal removes the context hook", async () => {
    const fake = createFakeContext()
    const cleanup = await registerHooks(fake.ctx)
    expect(fake.registrations).toEqual([{ kind: "session.hook", disposed: false }])
    expect((await fake.context({ agent: "corvus-review-auto" })).options).toEqual({ maxTokens: 32_000 })
    if (!cleanup) throw new Error("Expected an output-budget hook disposer")

    await cleanup()

    expect(fake.registrations).toEqual([{ kind: "session.hook", disposed: true }])
    expect((await fake.context({ agent: "corvus-review-auto" })).options).toEqual({})
  })
})

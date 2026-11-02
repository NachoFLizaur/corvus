import { describe, expect, test } from "bun:test"
import { evaluateRules } from "../evaluate-rules"
import { buildFixedDenyPolicies, enforceFixedDenies, FIXED_DENY_AGENTS, isFixedDenied } from "../fixed-denies"
import plugin from "../index"
import { loadAgents } from "../load-agents"
import { agentDir } from "../paths"
import { PROTECTED_AGENTS } from "../protected-agents"
import { renameAction, toV2Permissions } from "../to-v2-permissions"
import { enforceProtected } from "../v2/enforce-protected"
import { registerAgents } from "../v2/register-agents"
import { createFakeContext, type EvaluationInput } from "./fake-context"
import { LIGHT_BASH_DENIES, LIGHT_BASH_MAP, LIGHT_TASK_MAP, LIGHT_CHILDREN, LIGHT_MUTATIONS, LIGHT_READS, LIGHT_EXPANSIONS } from "./fixtures/review-light"

const light = "corvus-review-light", detector = "pr-light-reviewer", model = "test-provider/user-chosen-fast-model"
const corpus = loadAgents(agentDir)
type Config = Parameters<NonNullable<Awaited<ReturnType<typeof plugin>>["config"]>>[0]
// v1's SDK type predates native wildcard/question/task permissions. Model those
// authored keys as data and assert fidelity only at the config-hook boundary.
type TestConfig = Omit<Config, "agent"> & { agent: Record<string,
  Omit<NonNullable<NonNullable<Config["agent"]>[string]>, "permission"> & { permission?: Record<string, unknown> }> }

/** Oracle: test-owned action cases and packaged policy read before host overrides.
 * Fake host changes are test-local. Widening, model loss or extra-denial loss fails;
 * no environment flag disables these assertions. Teardown alone disables v2 hooks. */
describe("light fixed policy (AC1, AC7)", () => {
  test("derives fixed denies and closed maps from the packaged block; malformed policy fails closed", () => {
    expect(PROTECTED_AGENTS).toEqual(["pr-code-reviewer", "security-reviewer", "pr-light-reviewer", "pr-comment-writer"])
    expect(PROTECTED_AGENTS).not.toContain(light)
    const policies = buildFixedDenyPolicies(corpus), policy = policies.get(light)!
    expect(policy.rules).toHaveLength(4 + Object.keys(LIGHT_BASH_MAP).length + Object.keys(LIGHT_TASK_MAP).length)
    expect(toV2Permissions(corpus[light].permission)).toHaveLength(policy.rules.length + 1)
    expect([...policies.keys()]).toEqual([...FIXED_DENY_AGENTS])
    expect(policy.rules).toEqual([
      { action: "question", resource: "*", effect: "deny" },
      ...["edit", "write", "patch"].map(action => ({ action: renameAction(action), resource: "*", effect: "deny" as const })),
      ...toV2Permissions({ bash: LIGHT_BASH_MAP, task: LIGHT_TASK_MAP }),
    ])
    for (const command of LIGHT_MUTATIONS) expect(evaluateRules(policy.rules, "shell", command), command).toBe("deny")
    for (const command of LIGHT_READS) expect(evaluateRules(policy.rules, "shell", command), command).toBe("allow")
    for (const action of ["bash", "shell", "task", "subagent"]) expect(isFixedDenied(policy, action, [])).toBe(true)
    const missing = { ...corpus }
    delete missing[light]
    expect(() => buildFixedDenyPolicies(missing)).toThrow()
    for (const permission of [{}, { question: "allow", bash: { "git push*": "deny" } },
      { question: "deny", bash: { "*": "allow" } }, { question: "deny", bash: { "git push*": "bogus" } }])
      expect(() => buildFixedDenyPolicies({ ...corpus, [light]: { ...corpus[light], permission } })).toThrow()
    for (const action of ["edit", "write", "patch"]) {
      const permission = { ...corpus[light].permission }
      delete permission[action]
      expect(() => buildFixedDenyPolicies({ ...corpus, [light]: { ...corpus[light], permission } })).toThrow()
    }
    for (const action of ["bash", "task"]) for (const value of ["allow", { "*": "allow" }, { "*": "deny" }, { "*": "deny", x: "ask" }])
      expect(() => buildFixedDenyPolicies({ ...corpus, [light]: { ...corpus[light], permission: { ...corpus[light].permission, [action]: value } } })).toThrow()

    const bash = corpus[light].permission!.bash as Record<string, unknown>
    const extended = { ...corpus, [light]: { ...corpus[light], permission: { ...corpus[light].permission,
      bash: { ...bash, "git synthetic-mutation*": "deny" } } } }
    const derived = buildFixedDenyPolicies(extended).get(light)!
    expect(evaluateRules(derived.rules, "shell", "git synthetic-mutation probe")).toBe("deny")
    const tightened = enforceFixedDenies(extended, corpus)[light] as typeof corpus[string]
    expect(evaluateRules(toV2Permissions(tightened.permission), "shell", "git synthetic-mutation probe")).toBe("deny")
  })

  test("tightening is pure and preserves other agent references", () => {
    const merged: typeof corpus = { ...corpus, [light]: { ...corpus[light], model,
      permission: { "*": "allow", question: "allow", bash: "allow", task: { "pr-comment-writer": "deny" } } } }
    const before = JSON.stringify(merged), packaged = JSON.stringify(corpus)
    const tightened = enforceFixedDenies(corpus, merged)
    expect(JSON.stringify(merged)).toBe(before)
    expect(JSON.stringify(corpus)).toBe(packaged)
    expect(tightened[light]).not.toBe(merged[light])
    for (const name of Object.keys(corpus).filter(name => name !== light)) expect(tightened[name]).toBe(merged[name])
  })

  test.each(["map", "allow", "deny", "ask"] as const)("v1 user %s override cannot widen fixed denies; additional denies/model survive", async kind => {
    const hooks = await plugin({} as Parameters<typeof plugin>[0])
    if (!hooks.config) throw new Error("Missing config hook")
    const bash = kind === "map" ? { "*": "allow" as const,
      ...Object.fromEntries(LIGHT_BASH_DENIES.map(pattern => [pattern, "allow" as const])),
      "git push origin*": "allow" as const, "cp *": "allow" as const, "python3*": "allow" as const,
      "git remote get-url*": "deny" as const } : kind
    const config: TestConfig = { agent: {
      [light]: { model, permission: { "*": "allow", question: "allow", bash, task: { "*": "allow", "pr-comment-writer": "deny" }, edit: "allow", write: "allow", patch: "allow" } },
      [detector]: { model, prompt: "Untrusted replacement", permission: { "*": "allow", edit: "allow", write: "allow", bash: "allow" } },
      researcher: { model, permission: { question: "allow", bash: "ask", task: { "pr-comment-writer": "deny" } } },
    } }
    await hooks.config(config as unknown as Config)
    const agent = config.agent![light]!, rules = toV2Permissions(agent.permission)
    expect(agent.model).toBe(model)
    expect(evaluateRules(rules, "question", "*")).toBe("deny")
    expect(evaluateRules(rules, "subagent", "pr-comment-writer")).toBe("deny")
    expect(evaluateRules(rules, "subagent", "pr-light-reviewer")).toBe("allow")
    for (const name of ["code-implementer", "general", "corvus-review"]) expect(evaluateRules(rules, "subagent", name)).toBe("deny")
    expect(evaluateRules(rules, "edit", "src/file.ts")).toBe("deny")
    for (const action of ["edit", "write", "patch"]) expect(agent.permission![action]).toBe("deny")
    for (const command of LIGHT_MUTATIONS) expect(evaluateRules(rules, "shell", command), command).toBe("deny")
    for (const command of LIGHT_READS) expect(evaluateRules(rules, "shell", command), command)
      .toBe(kind === "deny" || kind === "map" && command.startsWith("git remote get-url") ? "deny" : kind === "ask" ? "ask" : "allow")
    expect(config.agent![detector]!.permission).toEqual(corpus[detector].permission)
    expect(config.agent![detector]!.prompt).toBe(corpus[detector].prompt)
    expect(config.agent![detector]!.model).toBe(model)
    for (const name of Object.keys(corpus).filter(name => ![light, detector].includes(name))) {
      const expected = name === "researcher" ? { ...corpus[name].permission,
        question: "allow", bash: "ask", task: { "pr-comment-writer": "deny" } } : corpus[name].permission
      expect(config.agent![name]!.permission, name).toEqual(expected)
    }
    const beforeReplay = JSON.stringify(config.agent![light]!.permission)
    await hooks.config(config as unknown as Config)
    expect(JSON.stringify(config.agent![light]!.permission)).toBe(beforeReplay)
  })

  test.each(["allow", { "*": "allow", "code-implementer": "allow", general: "allow", "corvus-review": "allow" }])("v1 user task allow cannot open the closed roster: %j", async task => {
    const hooks = await plugin({} as Parameters<typeof plugin>[0])
    const config: TestConfig = { agent: { [light]: { model, permission: { bash: "allow", task } } } }
    await hooks.config!(config as unknown as Config)
    const rules = toV2Permissions(config.agent[light].permission)
    for (const name of LIGHT_CHILDREN) expect(evaluateRules(rules, "subagent", name)).toBe("allow")
    for (const name of ["code-implementer", "general", "corvus-review"]) expect(evaluateRules(rules, "subagent", name)).toBe("deny")
  })

  test.each(["deny", { "*": "deny" }, { "pr-light-reviewer": "deny" }])("v1 additional dispatch denial survives and is replay-stable: %j", async task => {
    const hooks = await plugin({} as Parameters<typeof plugin>[0])
    const config: TestConfig = { agent: { [light]: { model, permission: { task } } } }
    await hooks.config!(config as unknown as Config)
    const before = JSON.stringify(config.agent[light])
    expect(evaluateRules(toV2Permissions(config.agent[light].permission), "subagent", "pr-light-reviewer")).toBe("deny")
    await hooks.config!(config as unknown as Config)
    expect(JSON.stringify(config.agent[light])).toBe(before)
  })

  test.each(["ask", { "git remote": "ask" }])("v1 user bash/task asks tighten authored allows without opening denied capabilities: %j", async ask => {
    const hooks = await plugin({} as Parameters<typeof plugin>[0])
    const config: TestConfig = { agent: { [light]: { permission: { bash: ask, task: typeof ask === "string" ? ask : { "pr-light-reviewer": "ask" } } } } }
    await hooks.config!(config as unknown as Config)
    const before = JSON.stringify(config.agent[light].permission), rules = toV2Permissions(config.agent[light].permission)
    for (const command of LIGHT_READS) expect(evaluateRules(rules, "shell", command)).toBe("ask")
    for (const command of LIGHT_MUTATIONS) expect(evaluateRules(rules, "shell", command)).toBe("deny")
    expect(evaluateRules(rules, "subagent", "pr-light-reviewer")).toBe("ask")
    expect(evaluateRules(rules, "subagent", "general")).toBe("deny")
    await hooks.config!(config as unknown as Config)
    expect(JSON.stringify(config.agent[light].permission)).toBe(before)
  })

  test.each(["bash", "shell"])("literal expansion guard scopes v1 %s to recorded light identity and composes with v2; exact commit suffix stays usable", async tool => {
    const hooks = await plugin({} as Parameters<typeof plugin>[0]), fake = createFakeContext()
    await registerAgents(fake.ctx)
    const cleanup = await enforceProtected(fake.ctx)
    const generation = (agent: string) => hooks["chat.params"]!({ sessionID: "ses_probe", agent } as Parameters<NonNullable<typeof hooks["chat.params"]>>[0],
      { maxOutputTokens: 1 } as Parameters<NonNullable<typeof hooks["chat.params"]>>[1])
    const shell = (command: string) => hooks["tool.execute.before"]!({ tool, sessionID: "ses_probe", callID: "call_probe" }, { args: { command } })
    try {
      // Without chat.params identity, the hook leaves host permissions in charge.
      for (const command of [...LIGHT_READS, ...LIGHT_EXPANSIONS]) await expect(shell(command)).resolves.toBeUndefined()
      await generation(light)
      for (const command of LIGHT_EXPANSIONS) {
        await expect(shell(command)).rejects.toThrow("fixed-deny boundary")
        expect((await fake.evaluate({ agent: light, action: "shell", resources: [command], effect: "allow" })).effect).toBe("deny")
      }
      for (const command of LIGHT_READS) {
        await shell(command)
        expect((await fake.evaluate({ agent: light, action: "shell", resources: [command], effect: "allow" })).effect).toBe("allow")
      }
      for (const agent of ["researcher", "other-plugin-agent"]) {
        await generation(agent)
        for (const command of LIGHT_EXPANSIONS) await expect(shell(command)).resolves.toBeUndefined()
      } // Other identified agents retain their own policy.
    } finally { await cleanup?.() }
  })

  test("v2 request hook denies later user allows without replacing permission arrays or model choices", async () => {
    const fake = createFakeContext()
    await registerAgents(fake.ctx)
    const cleanup = await enforceProtected(fake.ctx)
    if (!cleanup) throw new Error("Missing cleanup")
    try {
      const agent = fake.agents.get(light)!
      agent.model = { providerID: "test-provider", id: "user-chosen-fast-model" } as unknown as typeof agent.model
      agent.permissions.push({ action: "question", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "allow" }, { action: "shell", resource: "git push origin*", effect: "allow" },
        { action: "shell", resource: "cp *", effect: "allow" }, { action: "shell", resource: "python3*", effect: "allow" },
        { action: "subagent", resource: "*", effect: "allow" },
        { action: "subagent", resource: "pr-comment-writer", effect: "deny" }, { action: "shell", resource: "git remote get-url*", effect: "deny" })
      const beforeRules = JSON.stringify(agent.permissions), beforeModel = JSON.stringify(agent.model)
      // Mirror the host's deny short circuit: already-denied requests never reach
      // the evaluate hook. Only allow/ask decisions can be tightened there.
      const request = async (action: string, resources: string[]) => {
        const effects = resources.map(resource => evaluateRules(agent.permissions, action, resource))
        if (effects.includes("deny")) return { effect: "deny" }
        return fake.evaluate({ agent: light, action, resources, effect: effects.includes("ask") ? "ask" : "allow" })
      }
      const cases: [string, string[]][] = [["question", ["*"]], ["edit", [".corvus/reviews/pr42/post-request.json"]], ...LIGHT_MUTATIONS.map((command): [string, string[]] => ["shell", [command]]),
        ["shell", [LIGHT_READS[0], LIGHT_MUTATIONS[2]]]]
      for (const [action, resources] of cases) {
        expect(evaluateRules(agent.permissions, action, resources.at(-1)!)).toBe("allow")
        expect((await request(action, resources)).effect).toBe("deny")
      }
      expect((await request("subagent", ["pr-comment-writer"])).effect).toBe("deny")
      for (const command of LIGHT_READS) expect((await request("shell", [command])).effect).toBe(command.startsWith("git remote get-url") ? "deny" : "allow")
      expect((await request("subagent", ["pr-light-reviewer"])).effect).toBe("allow")
      for (const name of ["code-implementer", "general", "corvus-review"]) expect((await request("subagent", [name])).effect).toBe("deny")
      for (const action of ["subagent", "task"]) for (const name of LIGHT_CHILDREN)
        expect((await fake.evaluate({ agent: light, action, resources: [name], effect: "ask" })).effect).toBe("ask")
      for (const action of ["shell", "bash"]) for (const command of LIGHT_READS)
        expect((await fake.evaluate({ agent: light, action, resources: [command], effect: "allow" })).effect).toBe("allow")
      // Hosts may scan compound commands into several resources. Any denied
      // component still fails closed; whole-string input also hits meta denies.
      expect((await fake.evaluate({ agent: light, action: "shell", resources: [LIGHT_READS[0], "cp a b"], effect: "allow" })).effect).toBe("deny")
      for (const action of ["shell", "bash", "task", "subagent"])
        expect((await fake.evaluate({ agent: light, action, resources: [], effect: "allow" })).effect).toBe("deny")
      for (const effect of ["allow", "ask"] as const) for (const action of ["shell", "bash"])
        for (const command of LIGHT_MUTATIONS)
          expect((await fake.evaluate({ agent: light, action, resources: [command], effect })).effect, command).toBe("deny")
      expect((await fake.evaluate({ agent: light, action: "question", resources: [], effect: "allow" })).effect).toBe("deny")
      for (const action of ["edit", "write", "patch"]) for (const effect of ["allow", "ask"] as const)
        for (const resources of [[], [".corvus/reviews/pr42/post-request.json"]])
          expect((await fake.evaluate({ agent: light, action, resources, effect })).effect).toBe("deny")
      expect((await fake.evaluate({ agent: light, action: "read", resources: ["file"], effect: "ask" })).effect).toBe("ask")
      expect((await fake.context({ agent: light })).system).toEqual([])
      expect(JSON.stringify(agent.permissions)).toBe(beforeRules)
      expect(JSON.stringify(agent.model)).toBe(beforeModel)

      const child = fake.agents.get(detector)!
      child.permissions.push({ action: "edit", resource: "*", effect: "allow" })
      expect(evaluateRules(child.permissions, "edit", "src/file.ts")).toBe("allow")
      expect((await fake.evaluate({ agent: detector, action: "edit", resources: ["src/file.ts"], effect: "allow" })).effect).toBe("deny")
      const restored = await fake.context({ agent: detector })
      expect(restored.system.map(part => part.text)).toEqual([corpus[detector].prompt!])
      const marker = corpus[detector].prompt!.split("\n", 1)[0]
      expect(Object.values(corpus).filter(config => config.prompt!.includes(marker))).toHaveLength(1)

      for (const name of Object.keys(corpus).filter(name => name !== light))
        for (const action of ["question", "shell", "bash", "read", "edit", "subagent", "corvus_review_post"])
          for (const resource of ["*", LIGHT_MUTATIONS[2], LIGHT_READS[0], "src/file.ts", "pr-comment-writer"])
            for (const effect of ["allow", "ask"] as const) {
              const authored = PROTECTED_AGENTS.some(id => id === name) ? evaluateRules(toV2Permissions(corpus[name].permission), renameAction(action), resource) : undefined
              const expected = authored === "deny" ? "deny" : effect === "allow" && authored === "ask" ? "ask" : effect
              const input: EvaluationInput = { agent: name, action, resources: [resource], effect }
              expect((await fake.evaluate(input)).effect, JSON.stringify(input)).toBe(expected)
            }
      expect((await fake.evaluate({ action: "shell", resources: [LIGHT_MUTATIONS[2]], effect: "allow" })).effect).toBe("allow")
    } finally { await cleanup() }
    expect((await fake.evaluate({ agent: light, action: "question", resources: ["*"], effect: "allow" })).effect).toBe("allow")
  })
})

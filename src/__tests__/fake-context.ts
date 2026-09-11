import type { Rule, SetupContext } from "../v2/types"

/**
 * Hand-written host double for the OpenCode v2 `setup` context.
 *
 * WHY HAND-WRITTEN: the point of these tests is to catch the two mistakes the
 * real host punishes and a naive stub hides — assigning `permissions` instead of
 * appending to it, and replacing `request.body` instead of writing into it. Both
 * are only observable if the draft an agent starts from already carries the
 * host's OWN baseline. So `defaultInfo` reproduces the host seeding exactly:
 * `Agent.Info.default(id)`'s five rules (`@opencode-ai/schema/dist/agent.js:34-39`)
 * PLUS the four absolute-path `external_directory` allows the agent service
 * prepends on an absent id (`core/src/agent.ts:59-64`) — nine rules that an array
 * assignment would destroy.
 *
 * FIDELITY BOUNDARY: `ctx` is cast to `SetupContext` because the real
 * `Plugin.Context` carries more domains than this fake implements.
 * The cast is the ONLY place fidelity is asserted rather than checked, and it is
 * deliberately narrow: everything the registrars actually touch (`location`,
 * `agent.transform`, `command.transform`, `skill.transform`, `mcp.transform`, `tool.transform`,
 * `permission.hook`, `session.hook`, `session.switchAgent`,
 * `session.switchModel`, `session.prompt`, `shell.hook`) is implemented with
 * types DERIVED from `SetupContext`, so an upstream rename breaks compilation
 * here rather than silently passing.
 *
 * DRAFT KEYING AND CLONING mirror the host container-for-container, because the
 * reload replay below is only a meaningful idempotency oracle if a second
 * application collides with the first exactly where the host would collide:
 *   - agents: `Map` keyed by id, upserted (`core/src/agent.ts:74-85`).
 *   - commands: `Map` keyed by NAME, stored by reference
 *     (`core/src/command.ts:57-61`).
 *   - skills: `Map` keyed by id, storing a shallow COPY
 *     (`core/src/skill.ts:99-101`).
 *   - mcp: `Map` keyed by name, storing a `structuredClone`
 *     (`core/src/mcp/index.ts:144`, `:693-696`).
 * An array-backed command or skill recorder would report 8 commands and 36 skills
 * after one replay and call it a pass.
 *
 * REPLAY: the host re-runs plugin transforms whenever config reloads. `transform`
 * therefore both applies its callback immediately AND records it, and `replay()`
 * re-applies every still-registered transform against the CURRENT draft — which
 * is what makes reload idempotency testable at all.
 *
 * Reused by the Phase 4 command/skill/MCP tests; extend the recorders here rather
 * than reaching into production code.
 */

/* ------------------------------------------------------------------ *
 * Types derived from the real host contract (no SDK subpath imports)  *
 * ------------------------------------------------------------------ */

/** The `AgentEditor` the host hands to an `agent.transform` callback. */
export type AgentDraft = Parameters<Parameters<SetupContext["agent"]["transform"]>[0]>[0]

/** One draft agent as `AgentEditor.update` exposes it — a deeply mutable `Agent.Info`. */
export type DraftAgent = Parameters<Parameters<AgentDraft["update"]>[1]>[0]

type CommandDraft = Parameters<Parameters<SetupContext["command"]["transform"]>[0]>[0]
export type CommandDefinition = Parameters<CommandDraft["add"]>[0]

/** The per-invocation input the host hands to a command's `execute`. */
export type CommandInvocation = Parameters<CommandDefinition["execute"]>[0]

type SkillDraft = Parameters<Parameters<SetupContext["skill"]["transform"]>[0]>[0]
/**
 * The MUTABLE skill shape the editor reads back. `add` takes the readonly
 * `Skill.Info`, so stored entries are widened on the way in — mirroring the host,
 * which owns the draft copy.
 */
export type SkillDefinition = ReturnType<SkillDraft["list"]>[number]

type McpDraft = Parameters<Parameters<SetupContext["mcp"]["transform"]>[0]>[0]
/** Likewise the mutable server config `get`/`list` hand back. */
export type McpServerConfig = NonNullable<ReturnType<McpDraft["get"]>>

type ToolDraft = Parameters<Parameters<SetupContext["tool"]["transform"]>[0]>[0]
export type ToolDefinition = ReturnType<ToolDraft["list"]>[number]

/** The handle every `transform`/`hook` resolves to. */
type Registration = Awaited<ReturnType<SetupContext["agent"]["transform"]>>

/** The mutable decision object the host hands to `permission.hook("evaluate")`. */
export type PermissionEvaluation = Parameters<Parameters<SetupContext["permission"]["hook"]>[1]>[0]

/**
 * `session.hook` accepts six different inputs; `SessionContext` is the only one
 * carrying `system`, so it can be picked out of the union without importing an
 * SDK subpath.
 */
export type SessionContextInput = Extract<Parameters<Parameters<SetupContext["session"]["hook"]>[1]>[0], { system: unknown }>

export type SystemPart = SessionContextInput["system"][number]

/* ------------------------------------------------------------------ *
 * Session call recorders                                             *
 * ------------------------------------------------------------------ */

export type SwitchAgentInput = Parameters<SetupContext["session"]["switchAgent"]>[0]
export type SwitchModelInput = Parameters<SetupContext["session"]["switchModel"]>[0]
export type SessionPromptInput = Parameters<SetupContext["session"]["prompt"]>[0]

/**
 * One recorded `ctx.session` call.
 *
 * A single ORDERED list rather than three per-method arrays, because the contract
 * `register-commands.ts` has to honour is a sequence — any agent switch, then any
 * model switch, then exactly one prompt — and three arrays cannot express which
 * came first.
 */
export type SessionCall =
  | { readonly method: "switchAgent"; readonly input: SwitchAgentInput }
  | { readonly method: "switchModel"; readonly input: SwitchModelInput }
  | { readonly method: "prompt"; readonly input: SessionPromptInput }

/* ------------------------------------------------------------------ *
 * Host baseline mirror                                               *
 * ------------------------------------------------------------------ */

/**
 * Stand-ins for the host's global directories. Absolute and posix-shaped like the
 * real ones; the exact prefix is irrelevant because no assertion depends on it,
 * only on the rules surviving.
 */
const GLOBAL = { data: "/fake/opencode/data", tmp: "/fake/opencode/tmp", config: "/fake/opencode/config" } as const

/**
 * What the fake host reports as `ctx.location.directory` — the cwd
 * `register-commands.ts` roots its shell runner at. Absolute, because the real
 * field is a branded `AbsolutePath`, and never a real directory on disk: nothing
 * in these tests may spawn a process, so a path that cannot be entered is a
 * feature.
 */
export const FAKE_DIRECTORY = "/fake/workspace"

/** `Agent.Info.default(id).permissions` (`@opencode-ai/schema/dist/agent.js:34-39`). */
export const INFO_DEFAULT_RULES: readonly Rule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]

/**
 * The allows the agent service prepends when `update` seeds an absent id
 * (`core/src/agent.ts:59-64`): shell output, tool output, tmp, config.
 */
export const HOST_EXTERNAL_DIRECTORY_RULES: readonly Rule[] = [
  { action: "external_directory", resource: `${GLOBAL.data}/shell/*/*`, effect: "allow" },
  { action: "external_directory", resource: `${GLOBAL.data}/tool-output/*`, effect: "allow" },
  { action: "external_directory", resource: `${GLOBAL.tmp}/*`, effect: "allow" },
  { action: "external_directory", resource: `${GLOBAL.config}/*`, effect: "allow" },
]

/** The nine rules a freshly seeded draft agent starts with. */
export const BASELINE_RULES: readonly Rule[] = [...INFO_DEFAULT_RULES, ...HOST_EXTERNAL_DIRECTORY_RULES]

/**
 * A freshly seeded draft agent, mirroring `core/src/agent.ts:74-85`. Rules are
 * COPIED so no two calls (and therefore no two tests) share mutable state.
 *
 * `request` carries the host's `settings`/`headers`/`body` triple so a registrar
 * that replaces `request.body` wholesale is observable; `mode` is present because
 * the host requires it and seeds `"primary"`.
 */
export function defaultInfo(id: string): DraftAgent {
  return {
    id,
    name: id,
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: BASELINE_RULES.map((rule) => ({ ...rule })),
  } as unknown as DraftAgent
}

/* ------------------------------------------------------------------ *
 * Recorders                                                          *
 * ------------------------------------------------------------------ */

/** One handed-out registration and whether its `dispose()` has been awaited. */
export interface FakeRegistration {
  readonly kind: string
  disposed: boolean
}

/** Input for driving `permission.hook("evaluate")`. */
export interface EvaluationInput {
  readonly action: string
  readonly resources: readonly string[]
  /**
   * The host's own decision at hook time. Only `allow` and `ask` are reachable:
   * a host `deny` returns before the hook is triggered
   * (`core/src/permission.ts:170`), which is exactly why the hook can only
   * tighten.
   */
  readonly effect: "allow" | "ask"
  /** Absent models a request the host reports without an agent id. */
  readonly agent?: string
}

/** Input for driving `session.hook("context")`. Strings become text parts. */
export interface ContextInput {
  readonly agent: string
  readonly system?: readonly string[]
}

export interface FakeContext {
  /** Pass this to a registrar. */
  readonly ctx: SetupContext
  /** The agent draft, keyed by id, seeded like the host on first `update`. */
  readonly agents: Map<string, DraftAgent>
  /** The command draft, keyed by name — the host's own `Map` semantics. */
  readonly commands: Map<string, CommandDefinition>
  /** The skill draft, keyed by id, each entry a copy of what was added. */
  readonly skills: Map<string, SkillDefinition>
  /** Servers written through `mcp.transform`, each a deep clone of what was set. */
  readonly mcp: Map<string, McpServerConfig>
  readonly tools: Map<string, ToolDefinition>
  /** Every `session.switchAgent`/`switchModel`/`prompt` call, in order. */
  readonly sessionCalls: SessionCall[]
  /** Mutable host state that is not a draft. */
  readonly state: { defaultAgent: string | undefined }
  /** Every registration handed out, in order. */
  readonly registrations: FakeRegistration[]
  /** Re-apply every still-registered transform — the host's reload replay. */
  replay(): void
  /** Drive one `permission.evaluate` through every live hook; returns the mutated decision. */
  evaluate(input: EvaluationInput): Promise<PermissionEvaluation>
  /** Drive one `session.context` through every live hook; returns the mutated context. */
  context(input: ContextInput): Promise<SessionContextInput>
}

export function createFakeContext(directory = FAKE_DIRECTORY): FakeContext {
  const agents = new Map<string, DraftAgent>()
  const commands = new Map<string, CommandDefinition>()
  const skills = new Map<string, SkillDefinition>()
  const mcp = new Map<string, McpServerConfig>()
  const tools = new Map<string, ToolDefinition>()
  const sessionCalls: SessionCall[] = []
  const state: { defaultAgent: string | undefined } = { defaultAgent: undefined }
  const registrations: FakeRegistration[] = []
  const transforms: { readonly registration: FakeRegistration; readonly apply: () => void }[] = []
  const hooks: {
    readonly registration: FakeRegistration
    readonly name: string
    readonly callback: (input: unknown) => Promise<void> | void
  }[] = []

  const register = (kind: string): FakeRegistration => {
    const registration: FakeRegistration = { kind, disposed: false }
    registrations.push(registration)
    return registration
  }

  const handle = (registration: FakeRegistration): Registration => ({
    dispose: async () => {
      registration.disposed = true
    },
  })

  /** Record a transform, apply it once (as the host does), and hand back its handle. */
  const recordTransform = async <Draft>(kind: string, draft: Draft, callback: (draft: Draft) => void) => {
    const registration = register(kind)
    const apply = () => callback(draft)
    transforms.push({ registration, apply })
    apply()
    return handle(registration)
  }

  const recordHook = async (kind: string, name: unknown, callback: unknown) => {
    const registration = register(kind)
    hooks.push({
      registration,
      name: String(name),
      callback: callback as (input: unknown) => Promise<void> | void,
    })
    return handle(registration)
  }

  const drive = async (kind: string, name: string, input: unknown): Promise<void> => {
    for (const entry of hooks)
      if (entry.registration.kind === kind && entry.name === name && !entry.registration.disposed)
        await entry.callback(input)
  }

  // Mirrors `core/src/agent.ts:74-85`: `update` UPSERTS — it seeds `Info.default`
  // plus the host `external_directory` allows on an absent id, lets the caller
  // mutate that object, then reasserts the id.
  const agentDraft: AgentDraft = {
    list: () => [...agents.values()],
    get: (id) => agents.get(id),
    default: (id) => {
      state.defaultAgent = id
    },
    update: (id, update) => {
      const current = agents.get(id) ?? defaultInfo(id)
      if (!agents.has(id)) agents.set(id, current)
      update(current)
      // `Agent.ID` is a branded string; the double cast is the brand, not a shape change.
      current.id = id as unknown as DraftAgent["id"]
    },
    remove: (id) => {
      agents.delete(id)
    },
  }

  // Mirrors `core/src/command.ts:57-61`: a `Map` keyed by NAME, storing the
  // definition by reference. Re-adding the same name overwrites, which is the
  // whole reason a command replay cannot duplicate.
  const commandDraft: CommandDraft = {
    add: (definition) => {
      commands.set(definition.name, definition)
    },
  }

  // Mirrors `core/src/skill.ts:99-101`: keyed by id, storing a SHALLOW COPY, and
  // `update` reasserts the id after mutation.
  const skillDraft: SkillDraft = {
    list: () => [...skills.values()],
    get: (id) => skills.get(id),
    add: (skill) => {
      skills.set(String(skill.id), { ...skill } as SkillDefinition)
    },
    update: (id, update) => {
      const existing = skills.get(id)
      if (existing === undefined) return
      update(existing)
      existing.id = id as unknown as SkillDefinition["id"]
    },
    remove: (id) => {
      skills.delete(id)
    },
  }

  const mcpDraft: McpDraft = {
    list: () => [...mcp.entries()],
    get: (name) => mcp.get(name),
    // The host stores `cloneConfig(config)` = `structuredClone`
    // (`core/src/mcp/index.ts:144`, `:696`), so a registrar cannot keep a handle
    // on what it contributed and mutate the draft through it later.
    set: (name, config) => {
      mcp.set(name, structuredClone(config) as McpServerConfig)
    },
    update: (name, update) => {
      const existing = mcp.get(name)
      if (existing !== undefined) update(existing)
    },
    remove: (name) => {
      mcp.delete(name)
    },
  }

  const toolDraft: ToolDraft = {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    namespace: () => { throw new Error("Corvus tool fake does not support namespaces") },
    add: (tool) => {
      const id = tool.name
      tools.set(id, { ...tool, id, options: tool.options && { ...tool.options } })
    },
    update: (id, update) => {
      const current = tools.get(id)
      if (!current) return
      const tool = { ...current, options: current.options && { ...current.options } }
      update(tool)
      tools.set(id, { ...tool, id, name: current.name })
    },
    remove: (id) => { tools.delete(id) },
  }

  const ctx = {
    location: {
      directory,
      project: { id: "prj_fake", directory, canonical: directory },
    },
    agent: { transform: (callback: (draft: AgentDraft) => void) => recordTransform("agent.transform", agentDraft, callback) },
    command: {
      transform: (callback: (draft: CommandDraft) => void) => recordTransform("command.transform", commandDraft, callback),
    },
    skill: { transform: (callback: (draft: SkillDraft) => void) => recordTransform("skill.transform", skillDraft, callback) },
    mcp: { transform: (callback: (draft: McpDraft) => void) => recordTransform("mcp.transform", mcpDraft, callback) },
    tool: { transform: (callback: (draft: ToolDraft) => void) => recordTransform("tool.transform", toolDraft, callback) },
    permission: { hook: (name: unknown, callback: unknown) => recordHook("permission.hook", name, callback) },
    session: {
      hook: (name: unknown, callback: unknown) => recordHook("session.hook", name, callback),
      switchAgent: async (input: SwitchAgentInput) => {
        sessionCalls.push({ method: "switchAgent", input })
      },
      switchModel: async (input: SwitchModelInput) => {
        sessionCalls.push({ method: "switchModel", input })
      },
      prompt: async (input: SessionPromptInput) => {
        sessionCalls.push({ method: "prompt", input })
      },
    },
    shell: { hook: (name: unknown, callback: unknown) => recordHook("shell.hook", name, callback) },
  } as unknown as SetupContext

  return {
    ctx,
    agents,
    commands,
    skills,
    mcp,
    tools,
    sessionCalls,
    state,
    registrations,
    replay: () => {
      for (const entry of transforms) if (!entry.registration.disposed) entry.apply()
    },
    evaluate: async (input) => {
      const evaluation = {
        sessionID: "ses_fake",
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        action: input.action,
        resources: [...input.resources],
        effect: input.effect,
      } as unknown as PermissionEvaluation
      await drive("permission.hook", "evaluate", evaluation)
      return evaluation
    },
    context: async (input) => {
      const value = {
        sessionID: "ses_fake",
        agent: input.agent,
        model: { providerID: "fake", id: "fake-model" },
        system: (input.system ?? []).map((text) => ({ type: "text", text })),
        messages: [],
        tools: {},
        generation: {},
        providerOptions: {},
      } as unknown as SessionContextInput
      await drive("session.hook", "context", value)
      return value
    },
  }
}

import { loadAgents } from "../load-agents"
import { agentDir } from "../paths"
import { PROTECTED_AGENTS } from "../protected-agents"
import { toV2Agent, type V2AgentFields } from "../to-v2-agent"
import type { Registrar, Rule, SetupContext } from "./types"

/**
 * Registers the packaged corvus agent corpus into the host's agent draft via
 * `ctx.agent.transform`.
 *
 * INVARIANT — snapshot at setup, replay-safe mutation.
 *
 * Oracle: the packaged `agent/*.md` corpus, read ONCE per `setup()` through the
 * shared v1 loader (`load-agents.ts`) and translated by the pure `toV2Agent`.
 * Nothing in the draft is an input — corvus never reads back what it or the user
 * wrote — so the registration is a function of the packaged files alone.
 *
 * Read timing relative to mutations: every read (directory listing, file read,
 * frontmatter parse, translation) happens BEFORE `ctx.agent.transform` is called.
 * The transform closure is pure over that snapshot: synchronous, no I/O, no
 * console, no captured mutable state. That matters because the host REPLAYS
 * plugin transforms whenever config reloads, and a closure that re-read the disk
 * could contribute a different corpus on replay than the one `setup()` validated.
 *
 * Replay safety (why appending cannot duplicate): `AgentEditor.update` UPSERTS
 * onto whatever is already in the draft — on a replay against a draft that still
 * holds a previous application, `draft.agents.get(id)` returns the existing agent
 * and mutations ACCUMULATE (`core/src/agent.ts:74-85`). Scalar fields are
 * therefore idempotent by construction (assigning the same value twice is a
 * no-op), but `permissions` is an array and a bare append would double it. So
 * `appendRules` first drops every rule value-equal to one this registration is
 * about to append, then re-appends corvus's block in authored order. See
 * `appendRules` for why discarding a value-equal HOST baseline rule cannot change
 * any decision.
 *
 * Fail direction per consumer: a PROTECTED agent that fails to translate THROWS
 * and aborts `setup()` — the plugin must not load without the inputs to its own
 * security boundary (`enforce-protected.ts`), so the HOST gets no corvus at all
 * rather than a corpus missing a read-only reviewer. Any other agent degrades
 * per-file: `console.error` and skip, so one bad file costs one agent instead of
 * all sixteen. DEVIATION from the task's per-file isolation, disclosed: a
 * frontmatter PARSE failure (missing delimiters, invalid YAML) still aborts the
 * whole load, because that throw lives in the shared `loadAgents`
 * (`load-agents.ts:52-54`) which the v1 entry also calls — giving the v2 path
 * per-file parse isolation means changing v1 behavior, which Requirement 2
 * freezes. The direction is fail-CLOSED (no plugin, never a silent partial
 * corpus), so the boundary is not weakened.
 *
 * What disables this control: nothing at runtime — no flag, cache, or
 * environment switch, and an empty corpus degrades to a transform that contributes
 * nothing. It is undone only by the returned cleanup, which disposes the
 * registration so the host stops replaying this transform (plugin unload, or
 * `server.ts` unwinding a failed `setup()`).
 *
 * User-wins is NOT implemented here and must never be re-added: host user-config
 * plugins run in `post`, AFTER package plugins, and already overwrite agent fields
 * and append their own rules (`core/src/config/plugin/agent.ts:99-117`). The v1
 * merge (`src/index.ts:33-51`) exists only because the v1 `config` hook had no
 * such ordering; porting it would make corvus win over the user.
 */

/** The `AgentEditor` the host hands to a `ctx.agent.transform` callback. */
type AgentDraft = Parameters<Parameters<SetupContext["agent"]["transform"]>[0]>[0]

/** One draft agent as `AgentEditor.update` exposes it — a deeply mutable `Agent.Info`. */
type DraftAgent = Parameters<Parameters<AgentDraft["update"]>[1]>[0]

/** The handle `ctx.agent.transform` resolves to, whose `dispose` removes the transform. */
type Registration = Awaited<ReturnType<SetupContext["agent"]["transform"]>>

/** One corpus agent that translated cleanly, ready to be written to the draft. */
interface TranslatedAgent {
  /** Draft id — the `loadAgents` record key (filename without `.md`). */
  readonly id: string
  readonly fields: V2AgentFields
}

const PROTECTED: ReadonlySet<string> = new Set(PROTECTED_AGENTS)

/** Value equality for rules. `Rule` is flat, so field comparison is exhaustive. */
function sameRule(a: Rule, b: Rule): boolean {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect
}

/**
 * Translate the whole corpus, isolating per-agent failures.
 *
 * Warnings are logged here — once per `setup()`, because this runs outside the
 * replayed transform closure — rather than inside `toV2Agent`, which stays pure.
 *
 * @throws Error when a PROTECTED agent fails to translate (see the fail-direction
 * note in the module docblock).
 */
function translateCorpus(corpus: ReturnType<typeof loadAgents>): TranslatedAgent[] {
  const translated: TranslatedAgent[] = []

  for (const [name, config] of Object.entries(corpus)) {
    try {
      const { fields, warnings } = toV2Agent({ name, config })
      for (const warning of warnings) console.warn(`corvus: ${warning}`)
      translated.push({ id: name, fields })
    } catch (e) {
      const reason = (e as Error).message
      if (PROTECTED.has(name))
        throw new Error(`corvus: refusing to load without protected agent "${name}" — ${reason}`)
      console.error(`corvus: skipping agent "${name}" — ${reason}`)
    }
  }

  return translated
}

/**
 * APPEND corvus's rules, never assign the array.
 *
 * Assigning `permissions` would wipe both halves of the host baseline that
 * `update` seeds on an absent id: the five `Info.default` rules
 * (`schema/src/agent.ts:39-53`) and the four absolute-path `external_directory`
 * allows for shell/tool output, tmp, and config (`core/src/agent.ts:59-64`).
 * `splice` rewrites the contents in place, keeping the array identity the draft
 * handed us.
 *
 * Discarding a retained rule that is value-equal to one being appended is safe
 * even when the discarded rule is a HOST baseline rule. Corvus's block is always
 * appended at the END, and the host evaluates rulesets last-match-wins
 * (`core/src/permission.ts:87-97`). So an earlier duplicate B of an appended rule
 * R is already fully shadowed by R: every `(action, resource)` pair B matches, R
 * matches identically, and R is later. Removing B therefore cannot change any
 * decision — it only stops the array from growing on each replay. (In the current
 * corpus the case does not arise at all: no authored rule is value-equal to a
 * baseline rule — the closest pairs differ in effect, e.g. authored
 * `external_directory: "allow"` vs baseline `{external_directory, "*", "ask"}`.)
 */
function appendRules(agent: DraftAgent, rules: readonly Rule[]): void {
  if (rules.length === 0) return

  const retained = agent.permissions.filter((existing) => !rules.some((rule) => sameRule(existing, rule)))
  agent.permissions.splice(0, agent.permissions.length, ...retained, ...rules)
}

/**
 * Write one translated agent onto its draft entry.
 *
 * Each field is written only when the translation carries it. For `mode` that is
 * mandatory rather than stylistic: it is a REQUIRED host field that `Info.default`
 * seeds with `"primary"` (`schema/src/agent.ts:44`), so writing `undefined` would
 * both fail the type and corrupt the draft. Presence is the only guard — there is
 * deliberately no "already set" check, so every replay reasserts corvus's authored
 * value over whatever a previous application left behind.
 *
 * `temperature` is assigned INTO `request.body`. Replacing `request` or
 * `request.body` wholesale would drop the `settings`/`headers`/`body` structure the
 * host seeded (`schema/src/agent.ts:43`) along with anything already written there.
 */
function applyFields(agent: DraftAgent, fields: V2AgentFields): void {
  if (fields.description !== undefined) agent.description = fields.description
  if (fields.mode !== undefined) agent.mode = fields.mode
  if (fields.system !== undefined) agent.system = fields.system
  if (fields.color !== undefined) agent.color = fields.color
  if (fields.request !== undefined) agent.request.body.temperature = fields.request.body.temperature

  appendRules(agent, fields.permissions ?? [])
}

export const registerAgents: Registrar = async (ctx) => {
  const agents = translateCorpus(loadAgents(agentDir))

  const registration: Registration = await ctx.agent.transform((draft) => {
    for (const { id, fields } of agents) draft.update(id, (agent) => applyFields(agent, fields))
  })

  // `server.ts` unwinds cleanups LIFO and requires them not to throw, so a failed
  // disposal is reported rather than propagated — it would otherwise mask the
  // original setup error.
  return async () => {
    try {
      await registration.dispose()
    } catch (e) {
      console.error(`corvus: failed to remove the agent transform — ${(e as Error).message}`)
    }
  }
}

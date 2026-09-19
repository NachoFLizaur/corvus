import { evaluateRules } from "../evaluate-rules"
import { loadAgents } from "../load-agents"
import { agentDir } from "../paths"
import { PROTECTED_AGENTS } from "../protected-agents"
import { renameAction, toV2Permissions } from "../to-v2-permissions"
import type { Registrar, Rule, SetupContext } from "./types"

/**
 * The v2 protected-agent security boundary. THIS FILE IS THE OWNING LOCATION for
 * the rationale below; README and other code point here rather than restating it.
 *
 * Protected agents (`pr-code-reviewer`, `security-reviewer`, `pr-comment-writer`)
 * consume untrusted PR content — diffs, comments, issue text — so their
 * "mechanically read-only" capability limit is a security guarantee, not a
 * preference. Under v1 corvus enforced it by deep-replacing `permission` and
 * `prompt` in the merged config, making them unoverridable
 * (`src/index.ts:53-84`).
 *
 * INVARIANT — hook-time enforcement, tighten-only.
 *
 * Oracle: `policies`, built ONCE at setup from the PACKAGED `agent/*.md` corpus.
 * The draft is deliberately NOT the oracle. Host user-config plugins run in `post`,
 * after package plugins, and overwrite agent fields and append their own rules
 * (`core/src/config/plugin/agent.ts:99-117`), so by request time the draft may
 * carry a widened policy. Only a snapshot taken from corvus's own files is
 * authoritative, which is why this registrar re-reads the corpus instead of
 * consulting `ctx.agent` or trusting what `register-agents.ts` wrote.
 *
 * Read timing relative to mutations: the corpus is read before either hook is
 * registered, and both hook callbacks are pure over that snapshot — no I/O, no
 * captured mutable state — so config reloads cannot change what the boundary
 * enforces. The host fires `permission.evaluate` AFTER completing its own rule
 * evaluation: at `core/src/permission.ts:170` a `deny` from the host's configured
 * rules returns early, so the hook is never reached for an already-denied request;
 * `:173` computes the effect as `effects.includes("ask") ? "ask" : "allow"` and
 * `:174` triggers the hook with it. Therefore `e.effect ∈ {"allow", "ask"}` at hook
 * time and the hook can only TIGHTEN — it has no way to observe, let alone
 * reverse, a host deny. Corvus never writes `"allow"`: doing so would loosen a
 * host `ask` into an unattended allow, turning a boundary into a bypass.
 *
 * Fail direction per consumer: a PROTECTED agent fails CLOSED. Any authored `deny`
 * matching a requested resource forces `e.effect = "deny"`; otherwise an authored
 * `ask` downgrades an `allow` to `ask`. `evaluateRules` returning `undefined`
 * ("corvus has no opinion") leaves the host decision intact. A NON-PROTECTED agent
 * — and a request the host reports without an agent id — is returned untouched, so
 * this hook can never affect the other thirteen agents. At setup the same direction
 * applies: a protected agent missing from the corpus, or carrying no permission
 * rules, THROWS and aborts `setup()`, because an empty policy would silently
 * degrade into a hook that tightens nothing.
 *
 * What disables this control: only plugin teardown — the returned cleanup disposes
 * both hooks (plugin unload, or `server.ts` unwinding a failed `setup()`). There is
 * no flag, environment switch, or config key that turns it off, and no code path
 * that skips it for a protected agent.
 *
 * ACCEPTED DEMOTION (Requirement 5, risk R1) — prompt immutability is GONE. v2 has
 * no `config` hook and no draft field the user cannot overwrite afterwards, so the
 * v1 guarantee splits in two with different strengths:
 *
 * - `permission` → FULLY enforced, and in fact more strongly than in v1: the
 *   boundary now holds at request time regardless of what the draft says.
 * - `prompt` → PRESENCE-ONLY via `session.hook("context")`. The hook re-appends
 *   corvus's authored body when no system part carries the agent's marker, which
 *   restores an absent prompt but CANNOT prevent a user from also supplying their
 *   own, nor remove or override one. A protected agent can therefore run with
 *   extra or contradictory instructions; it cannot run with capabilities corvus
 *   did not authorize. The capability limit, not the prompt, is what makes
 *   "mechanically read-only" true. Per Requirement 5 this gap is accepted and
 *   documented (task 14), not raised upstream as part of this work.
 */

/** The precomputed boundary for one protected agent. Immutable after setup. */
interface ProtectedPolicy {
  /**
   * Authored rules in frontmatter order — order IS the precedence model, since
   * `evaluateRules` mirrors the host's last-match-wins `findLast`.
   */
  readonly rules: readonly Rule[]
  /** The authored prompt body, pushed by the context hook when absent. */
  readonly system: string
  /**
   * Presence probe for the context hook: the first line of the authored body,
   * e.g. `# PR Code Reviewer - Read-Only Detection Agent`.
   *
   * Derived rather than injected on purpose. Each protected agent's first body
   * line is already distinctive AND unique across all 16 corpus agents (verified),
   * so no `agent/*.md` needs a synthetic marker line — the corpus stays untouched
   * and the marker cannot drift away from the prompt it guards, because it is
   * literally cut from it. It is a PRESENCE probe, not an integrity check: it
   * answers "is corvus's body already here", never "has it been tampered with".
   */
  readonly marker: string
}

function fail(agent: string, reason: string): never {
  throw new Error(`corvus: refusing to load without the protected-agent boundary for "${agent}" — ${reason}`)
}

function buildPolicy(agent: string, config: ReturnType<typeof loadAgents>[string] | undefined): ProtectedPolicy {
  if (config === undefined) fail(agent, "it is missing from the packaged corpus")

  const system = typeof config.prompt === "string" ? config.prompt.trim() : ""
  if (system === "") fail(agent, "its prompt body is empty")

  const rules = ((): readonly Rule[] => {
    try {
      return toV2Permissions(config.permission)
    } catch (e) {
      return fail(agent, `its permission block is invalid — ${(e as Error).message}`)
    }
  })()
  if (rules.length === 0) fail(agent, "it declares no permission rules, so the boundary would tighten nothing")

  // `system` is trimmed and non-empty, so its first line is non-empty too.
  return { rules, system, marker: system.split("\n", 1)[0].trim() }
}

/** Handle returned by `hook`/`transform`, whose `dispose` unregisters it. */
type Registration = Awaited<ReturnType<SetupContext["agent"]["transform"]>>

/**
 * Dispose without throwing: `server.ts` unwinds cleanups LIFO and requires them
 * not to throw, since a failed disposal would otherwise mask the original error.
 */
async function release(registration: Registration, label: string): Promise<void> {
  try {
    await registration.dispose()
  } catch (e) {
    console.error(`corvus: failed to remove the protected-agent ${label} hook — ${(e as Error).message}`)
  }
}

export const enforceProtected: Registrar = async (ctx) => {
  const corpus = loadAgents(agentDir)
  const policies = new Map<string, ProtectedPolicy>(
    PROTECTED_AGENTS.map((agent) => [agent, buildPolicy(agent, corpus[agent])]),
  )

  const permission = await ctx.permission.hook("evaluate", (e) => {
    const agent = e.agent
    if (agent === undefined) return

    const policy = policies.get(agent)
    if (policy === undefined) return

    // Normalize onto the namespace `toV2Permissions` produced. The authored rules
    // already carry v2 action names, and `renameAction` is idempotent on them
    // (`shell`/`edit`/`subagent` are not rename keys), so this is a no-op for a v2
    // host and a correction if one ever reports a v1 name: without it a `bash`
    // request would miss `pr-comment-writer`'s authored `shell` allowlist and fall
    // through to its `*` deny.
    const action = renameAction(e.action)
    const effects = e.resources.map((resource) => evaluateRules(policy.rules, action, resource))

    if (effects.includes("deny")) {
      e.effect = "deny"
      e.message = `corvus: ${agent} is mechanically read-only; ${e.action} is denied by the plugin's security boundary.`
      return
    }

    // Tighten only. A host `ask` is never relaxed, and `"allow"` is never written.
    if (e.effect === "allow" && effects.includes("ask")) e.effect = "ask"
  })

  const context = await ctx.session.hook("context", (c) => {
    const policy = policies.get(c.agent)
    if (policy === undefined) return

    // Idempotent across replays and across the parts the host already assembled:
    // once corvus's body is present, this is a no-op.
    if (c.system.some((part) => part.text.includes(policy.marker))) return

    c.system.push({ type: "text", text: policy.system })
  })

  return async () => {
    await release(context, "context")
    await release(permission, "permission")
  }
}

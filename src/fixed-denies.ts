import { evaluateRules } from "./evaluate-rules"
import { loadAgents } from "./load-agents"
import { agentDir } from "./paths"
import { renameAction, toV2Permissions } from "./to-v2-permissions"
import type { Rule } from "./v2/types"

type PlainObject = Record<string, unknown>
type Corpus = ReturnType<typeof loadAgents>
type DenyPermission = Readonly<Record<string, "deny" | Readonly<Record<string, "deny">>>>

/** Identities with tighten-only fixed denies, not whole-object protection. */
export const FIXED_DENY_AGENTS = ["corvus-review-light"] as const

export interface FixedDenyPolicy {
  /** v1 action names and resource insertion order from the packaged block. */
  readonly permission: DenyPermission
  /** The same denies translated onto v2 action names. No allow/ask rules. */
  readonly rules: readonly Rule[]
}

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Fixed-deny boundary oracle: the packaged frontmatter, never merged user config.
 * Both hosts read it through loadAgents before mutation (v1 config merge result;
 * v2 hook registration). Only identity membership is maintained here; every deny
 * pattern is derived from the authored block, so host enforcement cannot drift.
 * Missing/invalid policy, question deny or bash denies aborts loading, fail-closed.
 * The v1 consumer appends only denies after user-wins merging; the v2 consumer
 * only changes matching requests to deny, preserving host deny/ask decisions.
 * User model choice and unrelated permissions are not policy inputs or outputs.
 * There is no config bypass: removal of the plugin disables the v1 boundary on
 * subsequent config loads and v2 teardown disposes the enforcing hook.
 */
export function buildFixedDenyPolicies(corpus: Corpus = loadAgents(agentDir)): ReadonlyMap<string, FixedDenyPolicy> {
  return new Map(FIXED_DENY_AGENTS.map((agent): [string, FixedDenyPolicy] => {
    const authored = corpus[agent]?.permission
    // Validate the complete block before extracting denies, including its allows.
    toV2Permissions(authored)
    if (!isPlainObject(authored) || authored.question !== "deny" || !isPlainObject(authored.bash))
      throw new Error(`corvus: refusing to load without the fixed-deny boundary for "${agent}" — missing question or bash policy`)

    const permission: Record<string, "deny" | Readonly<Record<string, "deny">>> = {}
    for (const [action, value] of Object.entries(authored)) {
      if (value === "deny") permission[action] = "deny"
      else if (isPlainObject(value)) {
        const denies = Object.fromEntries(Object.entries(value).filter(([, effect]) => effect === "deny")) as Record<string, "deny">
        if (Object.keys(denies).length > 0) permission[action] = Object.freeze(denies)
      }
    }
    const rules = toV2Permissions(permission)
    if (!rules.some((rule) => rule.action === "shell"))
      throw new Error(`corvus: refusing to load without the fixed-deny boundary for "${agent}" — no bash denies`)
    return [agent, { permission: Object.freeze(permission), rules: Object.freeze(rules.map((rule) => Object.freeze(rule))) }]
  }))
}

/** Deny-only request check; unmatched actions/resources leave the host untouched. */
export function isFixedDenied(policy: FixedDenyPolicy, action: string, resources: readonly string[]): boolean {
  const normalized = renameAction(action)
  // Action-wide denies (question) also hold for requests with no resources.
  return (resources.length === 0 ? ["*"] : resources)
    .some((resource) => evaluateRules(policy.rules, normalized, resource) === "deny")
}

/**
 * Re-append denies at the END of both action and resource maps. Reassigning an
 * existing key leaves its old position intact, letting later user allows win;
 * remove it first. Scalar permissions retain their wildcard effect when expanded
 * into a map, so a user bash deny remains a deny beyond the fixed subset too.
 * Read the packaged policy before constructing a new result; never mutate either
 * input. Other agents retain their original object references and effective rules.
 */
export function enforceFixedDenies(corpus: Corpus, merged: PlainObject): PlainObject {
  let result = merged
  for (const [name, policy] of buildFixedDenyPolicies(corpus)) {
    const existing = result[name]
    const agent = isPlainObject(existing) ? existing : corpus[name]
    const permission: PlainObject = isPlainObject(agent.permission) ? { ...agent.permission }
      : typeof agent.permission === "string" ? { "*": agent.permission } : { ...corpus[name].permission }
    for (const [action, denied] of Object.entries(policy.permission)) {
      const current = permission[action]
      delete permission[action]
      if (denied === "deny") permission[action] = denied
      else {
        const resources: PlainObject = isPlainObject(current) ? { ...current }
          : typeof current === "string" ? { "*": current } : {}
        for (const [pattern, effect] of Object.entries(denied)) {
          delete resources[pattern]
          resources[pattern] = effect
        }
        permission[action] = resources
      }
    }
    result = { ...result, [name]: { ...agent, permission } }
  }
  return result
}

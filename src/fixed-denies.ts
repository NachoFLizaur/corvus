import { evaluateRules } from "./evaluate-rules"
import { loadAgents } from "./load-agents"
import { agentDir } from "./paths"
import { renameAction, toV2Permissions } from "./to-v2-permissions"
import type { Rule } from "./v2/types"

type PlainObject = Record<string, unknown>
type Corpus = ReturnType<typeof loadAgents>
type FixedPermission = Readonly<Record<string, "deny" | Readonly<Record<string, "allow" | "deny">>>>

/** Identities with a fixed capability policy, not whole-object protection. */
export const FIXED_DENY_AGENTS = ["corvus-review-light"] as const

export interface FixedDenyPolicy {
  /** v1 fixed denies and closed bash/task maps in packaged insertion order. */
  readonly permission: FixedPermission
  /** The same boundary translated onto v2 action names. */
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
 * Missing/invalid question/edit/write/patch denies or closed bash/task maps aborts
 * loading, fail-closed; write/patch translate to edit on v2.
 * v1 replaces bash/task with authored maps plus additional user denies/asks, discarding
 * user allows for these two actions. v2 requires an authored allow for every
 * shell/subagent resource and never relaxes a host deny/ask. Metacharacter denies
 * follow allows on v1 and are checked independently on v2. Both hosts may scan
 * compounds into several resources: each component must satisfy this boundary;
 * it cannot reject separators already removed by the host scanner. The v1
 * pre-execution hook also checks literal expansions, which wildcard maps cannot
 * express (notably literal * and ?); v2 checks the same command predicate here.
 * User model choice and unrelated permissions are not policy inputs or outputs.
 * There is no config bypass: removal of the plugin disables the v1 boundary on
 * subsequent config loads and v2 teardown disposes the enforcing hook.
 */
export function buildFixedDenyPolicies(corpus: Corpus = loadAgents(agentDir)): ReadonlyMap<string, FixedDenyPolicy> {
  return new Map(FIXED_DENY_AGENTS.map((agent): [string, FixedDenyPolicy] => {
    const authored = corpus[agent]?.permission
    // Validate the complete block before extracting denies, including its allows.
    toV2Permissions(authored)
    if (!isPlainObject(authored) || ["question", "edit", "write", "patch"].some(action => authored[action] !== "deny")
      || ["bash", "task"].some(action => !isPlainObject(authored[action]) || authored[action]["*"] !== "deny"
        || !Object.values(authored[action]).includes("allow") || Object.values(authored[action]).includes("ask")))
      throw new Error(`corvus: refusing to load without the fixed-deny boundary for "${agent}" — missing question/edit/write/patch or closed bash/task policy`)

    const permission: Record<string, "deny" | Readonly<Record<string, "allow" | "deny">>> = {}
    for (const [action, value] of Object.entries(authored)) {
      if (value === "deny") permission[action] = "deny"
      else if (isPlainObject(value)) {
        const fixed = Object.fromEntries(Object.entries(value).filter(([, effect]) => effect === "deny" || ["bash", "task"].includes(action))) as Record<string, "allow" | "deny">
        if (Object.keys(fixed).length > 0) permission[action] = Object.freeze(fixed)
      }
    }
    const rules = toV2Permissions(permission)
    if (!rules.some((rule) => rule.action === "shell"))
      throw new Error(`corvus: refusing to load without the fixed-deny boundary for "${agent}" — no bash denies`)
    return [agent, { permission: Object.freeze(permission), rules: Object.freeze(rules.map((rule) => Object.freeze(rule))) }]
  }))
}

/** Closed actions need an authored allow; other actions retain deny-only behavior. */
export function isFixedDenied(policy: FixedDenyPolicy, action: string, resources: readonly string[]): boolean {
  const normalized = renameAction(action)
  if (["shell", "subagent"].includes(normalized)) {
    if (resources.length === 0) return true
    const rules = policy.rules.filter(rule => rule.action === normalized)
    // The wildcard is the fallback, not an unconditional deny of the exceptions.
    const explicitDenies = rules.filter(rule => rule.effect === "deny" && rule.resource !== "*")
    return resources.some(resource => normalized === "shell" && hasLightShellExpansion(resource)
      || evaluateRules(rules.filter(rule => rule.effect === "allow"), normalized, resource) !== "allow"
      || evaluateRules(explicitDenies, normalized, resource) === "deny")
  }
  // Action-wide denies also hold for requests with no resources.
  return (resources.length === 0 ? ["*"] : resources)
    .some((resource) => evaluateRules(policy.rules, normalized, resource) === "deny")
}

/** Literal command-text oracle, checked before either host executes a light shell
 * request. Only an entire exact cat-file shape with a lowercase SHA may contain
 * the ^{commit} suffix; remove that one literal before rejecting expansions.
 * Quotes do not disable rejection: shell state/globbing semantics differ across
 * hosts, so no other brace/caret/glob/substitution form is permitted. Unknown
 * command shapes still fail through the closed allowlist; no config bypass. */
export function hasLightShellExpansion(command: string): boolean {
  const exactCommit = /^git cat-file -e (?:[a-f0-9]{40}\^\{commit\}|'[a-f0-9]{40}\^\{commit\}'|"[a-f0-9]{40}\^\{commit\}")$/.test(command)
  const remaining = exactCommit ? command.replace("^{commit}", "") : command
  return /[{}()*?\[\]!^\\]/.test(remaining) || /(?:^|\s)["']?=/.test(remaining)
}

/**
 * Re-append denies at the END of both action and resource maps. Reassigning an
 * existing key leaves its old position intact, letting later user allows win;
 * remove it first. Scalar permissions retain their wildcard effect when expanded
 * into a map, so a user bash/task deny closes the whole action. For closed actions
 * the authored map is rebuilt first, then only extra user denies are appended.
 * Read raw overrides before the general merge: otherwise the authored wildcard
 * deny is indistinguishable from a user wildcard denial. On config-hook replay,
 * a map carrying every authored key already has that fallback; it is not an extra
 * wildcard denial. An extra wildcard denial is emitted last and stays last on
 * replay. User allows never expand authority. Scalar asks replace only authored
 * allows with asks. Map asks conservatively ask all authored allows for that
 * action: glob intersections cannot be represented exactly by v1's maps; this
 * may add prompts but never turns the fallback/explicit denies into asks.
 * Read the packaged policy before constructing a new result; never mutate either
 * input. Other agents retain their original object references and effective rules.
 */
export function enforceFixedDenies(corpus: Corpus, merged: PlainObject, overrides: PlainObject = merged): PlainObject {
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
        const closed = ["bash", "task"].includes(action)
        const resources: PlainObject = closed ? { ...denied } : isPlainObject(current) ? { ...current }
          : typeof current === "string" ? { "*": current } : {}
        const override = isPlainObject(overrides[name]) ? overrides[name].permission : undefined
        const user = isPlainObject(override) ? override[action] : override
        const userEntries = isPlainObject(user) ? Object.entries(user) : user === "deny" || user === "ask" ? [["*", user]] : []
        if (closed && userEntries.some(([, effect]) => effect === "ask"))
          for (const pattern of Object.keys(resources)) if (resources[pattern] === "allow") resources[pattern] = "ask"
        const hasFallback = isPlainObject(user) && Object.keys(denied).every(key => key in user)
          && Object.keys(user)[0] === "*" && user["*"] === "deny"
        const entries = closed ? userEntries.filter(([pattern, effect]) => effect === "deny"
          && !(pattern === "*" && hasFallback) && !(pattern !== "*" && denied[pattern] === "deny")) : Object.entries(denied)
        for (const [pattern, effect] of entries) {
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

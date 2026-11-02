import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { evaluateRules } from "./evaluate-rules"
import { loadAgents } from "./load-agents"
import { agentDir } from "./paths"
import { renameAction, toV2Permissions } from "./to-v2-permissions"
import type { Rule } from "./v2/types"

type PlainObject = Record<string, unknown>
type Corpus = ReturnType<typeof loadAgents>
type FixedPermission = Readonly<Record<string, "allow" | "deny" | Readonly<Record<string, "allow" | "deny">>>>

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
 * Missing/invalid default-deny, question/edit/write/patch or closed bash/task maps aborts
 * loading, fail-closed; write/patch translate to edit on v2.
 * v1 rebuilds every action from authored policy plus user denies/asks, discarding
 * user allows. v2 requires an authored allow for every action/resource and never
 * relaxes a host deny/ask. Metacharacter denies
 * follow allows on v1 and are checked independently on v2. Both hosts may scan
 * compounds into several resources: each component must satisfy this boundary;
 * it cannot reject separators already removed by the host scanner. The v1
 * pre-execution hook also checks literal expansions, which wildcard maps cannot
 * express (notably literal * and ?); v2 checks the same command predicate here.
 * User model choice is preserved; unknown tools remain denied.
 * There is no config bypass: removal of the plugin disables the v1 boundary on
 * subsequent config loads and v2 teardown disposes the enforcing hook.
 */
export function buildFixedDenyPolicies(corpus: Corpus = loadAgents(agentDir)): ReadonlyMap<string, FixedDenyPolicy> {
  return new Map(FIXED_DENY_AGENTS.map((agent): [string, FixedDenyPolicy] => {
    const authored = corpus[agent]?.permission
    // Validate the complete block before extracting denies, including its allows.
    toV2Permissions(authored)
    if (!isPlainObject(authored) || authored["*"] !== "deny" || Object.keys(authored)[0] !== "*"
      || ["question", "edit", "write", "patch"].some(action => authored[action] !== "deny")
      || ["bash", "task"].some(action => !isPlainObject(authored[action]) || authored[action]["*"] !== "deny"
        || !Object.values(authored[action]).includes("allow") || Object.values(authored[action]).includes("ask")))
      throw new Error(`corvus: refusing to load without the fixed-deny boundary for "${agent}" — missing default-deny, question/edit/write/patch or closed bash/task policy`)

    const permission: Record<string, "allow" | "deny" | Readonly<Record<string, "allow" | "deny">>> = {}
    for (const [action, value] of Object.entries(authored)) {
      if (value === "deny" || value === "allow") permission[action] = value
      else if (isPlainObject(value)) {
        const fixed = Object.fromEntries(Object.entries(value)) as Record<string, "allow" | "deny">
        if (Object.keys(fixed).length > 0) permission[action] = Object.freeze(fixed)
      }
    }
    const rules = toV2Permissions(permission)
    if (!rules.some((rule) => rule.action === "shell"))
      throw new Error(`corvus: refusing to load without the fixed-deny boundary for "${agent}" — no bash denies`)
    return [agent, { permission: Object.freeze(permission), rules: Object.freeze(rules.map((rule) => Object.freeze(rule))) }]
  }))
}

/** Every action needs an authored allow; closed maps also reject explicit denies. */
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
    .some((resource) => evaluateRules(policy.rules, normalized, resource) !== "allow")
}

/** Workdir oracle: realpath of git's top-level from the trusted session directory,
 * computed once on the first light shell request (including failure), before
 * execution. Each request re-realpaths its workdir, relative to that session;
 * omission means the session directory, not process.cwd(). Missing/invalid paths
 * or repository discovery deny closed. Nested/fake repositories and sibling trees
 * never supply the oracle. No config disables this guard; plugin unload does.
 * The realpath check does not eliminate external concurrent directory replacement. */
export function createLightShellWorkdirGuard(sessionDirectory: unknown): (workdir: unknown) => boolean {
  let initialized = false, root: string | undefined
  return workdir => {
    if (!initialized) {
      initialized = true
      try {
        if (typeof sessionDirectory !== "string" || !sessionDirectory) return false
        root = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: sessionDirectory, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
        }).trim())
      } catch { return false }
    }
    if (!root || typeof sessionDirectory !== "string" || workdir !== undefined && (typeof workdir !== "string" || !workdir)) return false
    try { return realpathSync(workdir === undefined ? sessionDirectory : resolve(sessionDirectory, workdir as string)) === root }
    catch { return false }
  }
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
 * Rebuild the default-deny action map from packaged exceptions; discard user
 * allows, retain user denies/asks on authorized capabilities. Resource denials
 * are appended LAST (delete first to move an existing key), so user wildcard
 * denials close the whole action without disturbing the authored exceptions.
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
    const permission: PlainObject = { "*": "deny" }
    const override = isPlainObject(overrides[name]) ? overrides[name].permission : undefined
    const replay = isPlainObject(override) && Object.keys(policy.permission).every(key => key in override)
      && Object.keys(override)[0] === "*" && override["*"] === "deny"
    const global = isPlainObject(override) ? replay ? undefined : override["*"] : override
    for (const [action, denied] of Object.entries(policy.permission)) {
      if (action === "*") continue
      const user = isPlainObject(override) ? override[action] : override
      const globallyClosed = global === "deny"
      const globallyAsked = global === "ask"
      if (denied === "deny") permission[action] = denied
      else if (denied === "allow") {
        const entries = isPlainObject(user) ? Object.entries(user) : []
        const asked = globallyAsked || user === "ask" || entries.some(([, effect]) => effect === "ask")
        const resources: PlainObject = { "*": globallyClosed || user === "deny" ? "deny" : asked ? "ask" : "allow" }
        if (!globallyClosed && user !== "deny") for (const [pattern, effect] of entries) if (effect === "deny") resources[pattern] = "deny"
        permission[action] = entries.length ? resources : resources["*"]
      }
      else {
        const resources: PlainObject = { ...denied }
        const userEntries = isPlainObject(user) ? Object.entries(user) : user === "deny" || user === "ask" ? [["*", user]] : []
        if (globallyAsked || userEntries.some(([, effect]) => effect === "ask"))
          for (const pattern of Object.keys(resources)) if (resources[pattern] === "allow") resources[pattern] = "ask"
        const hasFallback = isPlainObject(user) && Object.keys(denied).every(key => key in user)
          && Object.keys(user)[0] === "*" && user["*"] === "deny"
        const entries = userEntries.filter(([pattern, effect]) => effect === "deny"
          && !(pattern === "*" && hasFallback) && !(pattern !== "*" && denied[pattern] === "deny"))
        for (const [pattern, effect] of entries) {
          delete resources[pattern]
          resources[pattern] = effect
        }
        if (globallyClosed) { delete resources["*"]; resources["*"] = "deny" }
        permission[action] = resources
      }
    }
    if (isPlainObject(override)) for (const [action, effect] of Object.entries(override))
      if (!(action in permission) && effect === "deny") permission[action] = "deny"
    result = { ...result, [name]: { ...agent, permission } }
  }
  return result
}

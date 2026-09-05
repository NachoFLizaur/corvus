import type { Rule } from "./v2/types"

/**
 * Pure v1 → v2 permission translation. No I/O, no draft access, no console.
 *
 * The oracle is the host's own v1 migration, `core/src/v1/config/migrate.ts:89-115`
 * at `@opencode-ai/plugin@0.0.0-beta-19086`:
 *
 * - a scalar effect becomes one rule with resource `"*"`;
 * - a resource map becomes one rule per entry, in frontmatter (insertion) order;
 * - action keys are renamed onto their v2 tool names before the rule is emitted.
 *
 * Rule ORDER is load-bearing: the host evaluates rulesets with `findLast`
 * (last match wins, `core/src/permission.ts:87-97`), so `write`/`patch` both
 * collapsing to `edit` is safe as long as the original key order survives.
 */

/** The three effects a host rule may carry (`schema/src/agent.ts` `Rule.effect`). */
const EFFECTS: readonly Rule["effect"][] = ["allow", "deny", "ask"]

/**
 * v1 action → v2 tool action, mirroring `normalizeAction`
 * (`core/src/v1/config/migrate.ts:110-115`). Actions absent from this table pass
 * through unchanged — including the six corpus actions that have no v2 tool
 * (`list`, `todowrite`, `todoread`, `codesearch`, `lsp`, `doom_loop`), which the
 * host accepts harmlessly because `Rule.action` is a free string.
 */
const ACTION_RENAMES: Readonly<Record<string, string>> = {
  bash: "shell",
  task: "subagent",
  write: "edit",
  patch: "edit",
}

/** Rename one v1 permission action onto its v2 tool action. */
export function renameAction(action: string): string {
  return ACTION_RENAMES[action] ?? action
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isEffect(value: unknown): value is Rule["effect"] {
  return typeof value === "string" && (EFFECTS as readonly string[]).includes(value)
}

/** Render an unexpected value for an error message without leaking its contents. */
function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "string") return JSON.stringify(value)
  return typeof value
}

/**
 * Translate a v1 agent `permission` value into an ordered v2 `Rule[]`.
 *
 * Accepts the two shapes the corvus corpus uses: `action: effect` and
 * `action: { resource: effect }` (one level deep). Returns `[]` for a missing
 * permission block so callers can omit `permissions` entirely.
 *
 * Nullish entry values are skipped, mirroring the host's `if (!rule) continue`
 * guard. Every other non-conforming value THROWS instead of being skipped —
 * deliberately stricter than the host, which silently drops `false`, `0`, and
 * `""`. A malformed permission block in the corvus corpus is a packaging bug,
 * and the registrar (task 07) decides whether to isolate the agent or abort.
 *
 * @throws Error when the block, an action value, or a resource effect is not one
 * of the accepted shapes.
 */
export function toV2Permissions(permission: unknown): Rule[] {
  if (permission === undefined || permission === null) return []

  if (!isRecord(permission))
    throw new Error(
      `Invalid permission block: expected a map of action to effect or resource map, got ${describe(permission)}`,
    )

  return Object.entries(permission).flatMap(([key, value]) => {
    if (value === undefined || value === null) return []

    const action = renameAction(key)
    if (isEffect(value)) return [{ action, resource: "*", effect: value }]

    if (isRecord(value))
      return Object.entries(value).map(([resource, effect]) => {
        if (!isEffect(effect))
          throw new Error(
            `Invalid permission effect for action "${key}", resource "${resource}": expected "allow", "deny", or "ask", got ${describe(effect)}`,
          )
        return { action, resource, effect }
      })

    throw new Error(
      `Invalid permission value for action "${key}": expected "allow", "deny", "ask", or a resource map, got ${describe(value)}`,
    )
  })
}

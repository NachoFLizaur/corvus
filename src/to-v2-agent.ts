import { toV2Permissions } from "./to-v2-permissions"
import type { Rule } from "./v2/types"

/**
 * Pure v1 → v2 agent translation. No I/O, no draft access, no console: warnings
 * are RETURNED so the registrar (task 07) owns every side effect.
 *
 * The mapping oracle is the host's own v1 migration, `migrateAgent`
 * (`core/src/v1/config/migrate.ts:134-156`) at
 * `@opencode-ai/plugin@0.0.0-beta-19086`: `prompt → system`,
 * `temperature → request.body.temperature`, `permission → permissions[]`, with
 * `description`, `mode`, and `color` carried across unchanged.
 */

/** The `mode` values `Agent.Info` accepts (`schema/src/agent.ts:23-54`). */
const MODES: readonly V2AgentMode[] = ["subagent", "primary", "all"]

/**
 * Six-digit hex color, matched case-INSENSITIVELY on purpose: the corpus ships
 * uppercase hex (`agent/corvus.md:2` is `#D97706`), and a lowercase-only check
 * would throw on a perfectly valid file.
 */
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * The ONLY agent frontmatter keys corvus translates. Anything else is dropped
 * with a warning rather than forwarded, so an unreviewed key can never reach the
 * host draft. `prompt` is absent by design: it is not frontmatter but the
 * markdown body the loader attaches (`load-agents.ts:49`), and it is handled
 * separately below.
 */
const KNOWN_FRONTMATTER_KEYS: readonly string[] = ["description", "mode", "temperature", "permission", "color"]

export type V2AgentMode = "subagent" | "primary" | "all"

/**
 * The v2 `Agent.Info` subset corvus contributes. Every field is optional: the
 * registrar assigns only what is present, leaving the host's `Info.default`
 * baseline (and its `external_directory` allows) intact.
 */
export interface V2AgentFields {
  readonly description?: string
  readonly mode?: V2AgentMode
  readonly color?: string
  /** v1 `prompt` (the markdown body) under its v2 name. */
  readonly system?: string
  /**
   * Values to assign INTO `request.body` key by key. Never assign this object
   * wholesale onto the draft: that would drop whatever the host already put
   * there.
   */
  readonly request?: { readonly body: { readonly temperature: number } }
  /**
   * Ordered rules to APPEND to `permissions`, never to assign — assigning would
   * wipe the host baseline. Order is precedence (last match wins).
   */
  readonly permissions?: readonly Rule[]
}

/** One parsed v1 agent file, as `loadAgents` returns it. */
export interface V1AgentSource {
  /** Agent id — the `loadAgents` record key (filename without `.md`). */
  readonly name: string
  /** The `loadAgents` entry: frontmatter keys plus the synthesized `prompt`. */
  readonly config: Readonly<Record<string, unknown>>
  /** Label used in warnings and errors. Defaults to `<name>.md`. */
  readonly file?: string
}

export interface V2AgentTranslation {
  readonly fields: V2AgentFields
  /** Human-readable notices for the registrar to log. Empty on a clean file. */
  readonly warnings: readonly string[]
}

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`)
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "string") return JSON.stringify(value)
  return typeof value
}

function asString(value: unknown, key: string, file: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") fail(file, `Invalid "${key}": expected a string, got ${describe(value)}`)
  return value
}

function isMode(value: unknown): value is V2AgentMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
}

function asMode(value: unknown, file: string): V2AgentMode | undefined {
  if (value === undefined || value === null) return undefined
  if (!isMode(value))
    fail(file, `Invalid "mode": expected one of ${MODES.map((m) => `"${m}"`).join(", ")}, got ${describe(value)}`)
  return value
}

function asColor(value: unknown, file: string): string | undefined {
  const color = asString(value, "color", file)
  if (color === undefined) return undefined
  if (!COLOR_RE.test(color))
    fail(file, `Invalid "color": expected a six-digit hex like "#D97706", got ${describe(color)}`)
  return color
}

function asTemperature(value: unknown, file: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(file, `Invalid "temperature": expected a finite number, got ${describe(value)}`)
  return value
}

function asPermissions(value: unknown, file: string): Rule[] {
  try {
    return toV2Permissions(value)
  } catch (e) {
    return fail(file, (e as Error).message)
  }
}

/**
 * Translate one v1 agent into its v2 field set.
 *
 * Unknown frontmatter keys are dropped, each one reported as a `<file>:<key>`
 * warning. Everything else is VALIDATED FIRST: an invalid `mode`, `color`,
 * `temperature`, `description`, `system`, or `permission` shape throws before any
 * field set is produced, so the caller either gets a fully valid translation or
 * an error — never a half-translated agent. The registrar decides whether to
 * isolate the offending agent or abort the whole load.
 *
 * @throws Error prefixed with the file label, describing the offending key.
 */
export function toV2Agent({ name, config, file = `${name}.md` }: V1AgentSource): V2AgentTranslation {
  const { prompt, ...frontmatter } = config

  const warnings = Object.keys(frontmatter)
    .filter((key) => !KNOWN_FRONTMATTER_KEYS.includes(key))
    .map((key) => `${file}:${key} — unknown agent frontmatter key, dropped`)

  const description = asString(frontmatter.description, "description", file)
  const mode = asMode(frontmatter.mode, file)
  const color = asColor(frontmatter.color, file)
  const system = asString(prompt, "prompt", file)
  const temperature = asTemperature(frontmatter.temperature, file)
  const permissions = asPermissions(frontmatter.permission, file)

  const fields: V2AgentFields = {
    ...(description === undefined ? {} : { description }),
    ...(mode === undefined ? {} : { mode }),
    ...(color === undefined ? {} : { color }),
    ...(system === undefined ? {} : { system }),
    ...(temperature === undefined ? {} : { request: { body: { temperature } } }),
    ...(permissions.length === 0 ? {} : { permissions }),
  }

  return { fields, warnings }
}

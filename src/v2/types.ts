import type { Plugin } from "@opencode-ai/plugin-v2"

/**
 * Narrow local types for the OpenCode v2 entry.
 *
 * The beta SDK (`@opencode-ai/plugin-v2`, pinned exactly) is expected to churn,
 * so its type surface is confined to this module and `src/server.ts`. Every
 * registrar imports from here instead of the SDK, which keeps an upstream
 * rename from rippling through `src/v2/register-*.ts` (risk R5).
 */

/**
 * A host permission rule. Ordered and last-match-wins when evaluated.
 *
 * `action` is deliberately a free string: the corvus corpus carries actions
 * that have no v2 tool (`list`, `todowrite`, `todoread`, `codesearch`, `lsp`,
 * `doom_loop`), and the host accepts them harmlessly.
 */
export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

/**
 * Teardown for one registration step. Structural mirror of the SDK's
 * `Plugin.Cleanup`.
 */
export type Cleanup = () => Promise<void> | void

/** The context the host passes to `setup`, and through it to every registrar. */
export type SetupContext = Plugin.Context

/**
 * Performs one category of host registration and returns the cleanup that
 * undoes it, or nothing when there is nothing to undo.
 *
 * Registrars must be idempotent: the host replays plugin transforms on config
 * reload, so a second run must not duplicate what the first one registered.
 */
export type Registrar = (ctx: SetupContext) => Promise<Cleanup | void>

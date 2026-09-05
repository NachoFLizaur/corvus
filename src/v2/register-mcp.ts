import type { Registrar, SetupContext } from "./types"

/**
 * Registers the default `web-research` MCP server into the host's MCP draft via
 * `ctx.mcp.transform`, only when the user has not configured that name.
 *
 * INVARIANT — never overwrite user MCP config.
 *
 * Oracle: the draft itself. `draft.get("web-research")` is the v2 analogue of the
 * v1 `Object.prototype.hasOwnProperty.call(config.mcp, "web-research")` guard
 * (`src/index.ts`), and it is a trustworthy oracle here only because of host
 * ordering: `ConfigMcpPlugin` sits in the host's `pre` list
 * (`core/src/plugin/internal.ts:239`), so the user's own `mcp.servers` entries are
 * ALREADY in the draft by the time a package plugin's transform runs. Unlike
 * agents and skills — where user config runs `post` and wins by overwriting —
 * nothing runs after corvus to undo an MCP write, so the guard is the whole
 * mechanism and reading the draft is mandatory rather than optional.
 *
 * Read timing relative to mutations: the read is the FIRST statement of the
 * transform closure and the write is the last, with nothing in between. Both live
 * inside the closure rather than in `setup()`, which is the opposite of the
 * agent/skill registrars: those snapshot files that cannot change between setup
 * and replay, whereas the draft this one inspects is re-populated by
 * `ConfigMcpPlugin` on every reload. Hoisting the `get` out of the closure would
 * freeze a stale answer and let a replay clobber a `web-research` block the user
 * added after startup.
 *
 * Replay safety: the guard makes the transform idempotent by construction. The
 * first application sets the entry; every replay finds its own previous write (or
 * the user's) already present and returns without touching it.
 *
 * Fail direction per consumer: bias toward the USER's configuration. A present
 * entry — even one that is `disabled`, broken, or points somewhere else entirely —
 * is left exactly as it is, so corvus can silently fail to provide web research
 * but can never silently redirect or re-enable a server the user configured
 * deliberately. The one user intent the guard cannot see is a `false` override,
 * which the host models as a REMOVAL rather than an entry, so `get` reports
 * nothing; in the reference host `set` short-circuits on that set
 * (`core/src/mcp/index.ts:693-696`), which makes the write a no-op. That is
 * defense in depth, not something this registrar relies on — the reference
 * checkout is older than the pinned beta SDK (risk R3), and the guard above stands
 * on the `pre`-ordering fact alone.
 *
 * What disables this control: a user entry named `web-research` disables the
 * default registration, which is precisely its purpose. There is no flag, cache,
 * or environment switch. The registration is otherwise undone only by the returned
 * cleanup, which disposes the transform (plugin unload, or `server.ts` unwinding a
 * failed `setup()`).
 *
 * ABSENT KEY, deliberately: no `disabled` is emitted. v1 wrote `enabled: true`,
 * but v2's `Mcp.LocalConfig` has no `enabled` field at all
 * (`@opencode-ai/schema/dist/mcp.d.ts`); the host's own v1 migration maps
 * `enabled` to `disabled = enabled === undefined ? undefined : !enabled`
 * (`core/src/v1/config/migrate.ts:196`), so the faithful translation of
 * `enabled: true` is the key being absent, not `disabled: false`.
 */

/** The `MCPEditor` the host hands to a `ctx.mcp.transform` callback. */
type McpDraft = Parameters<Parameters<SetupContext["mcp"]["transform"]>[0]>[0]

/** The handle `ctx.mcp.transform` resolves to, whose `dispose` removes the transform. */
type Registration = Awaited<ReturnType<SetupContext["mcp"]["transform"]>>

const SERVER_NAME = "web-research"

/**
 * Mirrors the v1 entry's command array verbatim, INCLUDING the exact version pin.
 * `src/index.ts` owns that pin today; the two entries ship from one package and
 * must not offer different tool versions to v1 and v2 hosts, so this literal
 * tracks it. A single shared constant would remove the duplication, but the v1
 * entry's behavior is frozen (Requirement 2) and it is not in this task's file
 * manifest.
 */
const COMMAND: readonly string[] = ["npx", "-y", "web-research-mcp@0.1.0"]

export const registerMcp: Registrar = async (ctx) => {
  const registration: Registration = await ctx.mcp.transform((draft: McpDraft) => {
    if (draft.get(SERVER_NAME) !== undefined) return
    // A FRESH config per application, never a shared module-level object: the
    // host clones on `set` (`core/src/mcp/index.ts:695`) but nothing in the
    // contract promises it will, and a shared object would let one draft's
    // `update` rewrite what a later `set` contributes.
    draft.set(SERVER_NAME, { type: "local", command: [...COMMAND] })
  })

  // `server.ts` unwinds cleanups LIFO and requires them not to throw, so a failed
  // disposal is reported rather than propagated — it would otherwise mask the
  // original setup error.
  return async () => {
    try {
      await registration.dispose()
    } catch (e) {
      console.error(`corvus: failed to remove the MCP transform — ${(e as Error).message}`)
    }
  }
}

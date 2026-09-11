import type { PluginModule } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin-v2"
import { enforceProtected } from "./v2/enforce-protected"
import { registerAgents } from "./v2/register-agents"
import { registerCommands } from "./v2/register-commands"
import { registerHooks } from "./v2/register-hooks"
import { registerMcp } from "./v2/register-mcp"
import { registerSkills } from "./v2/register-skills"
import { registerTools } from "./v2/register-tools"
import type { Cleanup, Registrar } from "./v2/types"

/**
 * Registration order — FIXED by convention, not by a data dependency.
 *
 * No registrar consumes another's output. In particular `enforceProtected` does
 * NOT read the draft `registerAgents` populates: it re-reads the packaged
 * `agent/*.md` corpus itself (`v2/enforce-protected.ts:134`), deliberately, since
 * a policy oracle taken from the user-writable draft could already carry a
 * widened policy. Agents therefore need not precede it for correctness. Commands,
 * skills, tools, hooks, and MCP are likewise independent of everything else. The order below is
 * frozen anyway so registration and unwind (LIFO) sequences stay reproducible
 * across runs.
 */
const REGISTRARS: readonly Registrar[] = [
  registerAgents,
  enforceProtected,
  registerCommands,
  registerSkills,
  registerTools,
  registerHooks,
  registerMcp,
]

/**
 * Corvus AI plugin — shared OpenCode v1/v2 entry (built to `dist/server.js`).
 *
 * OpenCode 1.18.30+ resolves `exports["./server"]` before `main` and requires
 * a callable `server` on a default object with `id`. The v2 host requires
 * `{ id, setup }`; each loader ignores the other handler. `server` reuses the
 * legacy hook function through a runtime import of the sibling `index.js`;
 * v2 `setup` does not load it. `dist/index.js` remains the root function entry.
 * SDK imports here are TYPE-ONLY. A value import (for
 * example `Plugin.define`, which is an identity function) would turn the beta
 * SDK into a runtime dependency and break v1 hosts that do not ship it, so
 * `dist/server.js` must contain zero runtime `@opencode-ai` imports.
 *
 * INVARIANT — all-or-nothing registration.
 * `setup` runs `REGISTRARS` in the fixed order declared above and collects the
 * cleanup each one returns. The oracle for "this step is registered" is the
 * registrar resolving normally; a cleanup is recorded only AFTER its registrar
 * resolves, so the unwind list is read strictly after the mutations it covers
 * and never contains a registrar that failed mid-mutation. On any throw, the
 * cleanups collected so far run in reverse (LIFO) order and the original error
 * is rethrown. Fail direction per consumer: the HOST sees a failed plugin load
 * rather than a half-registered corpus, and the USER gets no corvus
 * agents/commands/skills at all rather than an arbitrary subset. If a cleanup
 * itself throws while unwinding, that error propagates in place of the original
 * and the remaining cleanups are skipped — registrars must therefore keep their
 * cleanups non-throwing. Nothing disables this control: it is unconditional in
 * `setup`, has no flag or environment switch, and an empty `REGISTRARS` list
 * degrades to a no-op cleanup. The host replays plugin transforms on config
 * reload, so every registrar must additionally be idempotent.
 */
const plugin = {
  id: "corvus",
  server: async (...args: Parameters<PluginModule["server"]>) => {
    const { default: legacyPlugin }: { default: PluginModule["server"] } =
      await import(new URL("./index.js", import.meta.url).href)
    return legacyPlugin(...args)
  },
  setup: async (ctx: Plugin.Context): Promise<Plugin.Cleanup> => {
    const cleanups: Cleanup[] = []

    // Copy before reversing: mutating `cleanups` in place would corrupt the
    // LIFO order if the returned cleanup were ever invoked twice.
    const unwind = async () => {
      for (const cleanup of [...cleanups].reverse()) await cleanup()
    }

    try {
      for (const register of REGISTRARS) {
        const cleanup = await register(ctx)
        if (cleanup) cleanups.push(cleanup)
      }
    } catch (error) {
      await unwind()
      throw error
    }

    return unwind
  },
} satisfies Plugin.Plugin & PluginModule

export default plugin

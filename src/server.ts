import type { Plugin } from "@opencode-ai/plugin-v2"
import { enforceProtected } from "./v2/enforce-protected"
import { registerAgents } from "./v2/register-agents"
import { registerCommands } from "./v2/register-commands"
import { registerMcp } from "./v2/register-mcp"
import { registerSkills } from "./v2/register-skills"
import type { Cleanup, Registrar } from "./v2/types"

/**
 * Registration order — FIXED by convention, not by a data dependency.
 *
 * No registrar consumes another's output. In particular `enforceProtected` does
 * NOT read the draft `registerAgents` populates: it re-reads the packaged
 * `agent/*.md` corpus itself (`v2/enforce-protected.ts:134`), deliberately, since
 * a policy oracle taken from the user-writable draft could already carry a
 * widened policy. Agents therefore need not precede it for correctness. Commands,
 * skills, and MCP are likewise independent of everything else. The order below is
 * frozen anyway so registration and unwind (LIFO) sequences stay reproducible
 * across runs.
 */
const REGISTRARS: readonly Registrar[] = [
  registerAgents,
  enforceProtected,
  registerCommands,
  registerSkills,
  registerMcp,
]

/**
 * Corvus AI plugin — OpenCode v2 entry (built to `dist/server.js`).
 *
 * The v2 host decodes the default export as an OBJECT `{ id, setup }`; v1's
 * default async function is rejected (`Expected object at ["default"]`), which
 * is why `dist/index.js` remains the untouched v1 entry and this module builds
 * to a separate artifact. SDK imports here are TYPE-ONLY. A value import (for
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
} satisfies Plugin.Plugin

export default plugin

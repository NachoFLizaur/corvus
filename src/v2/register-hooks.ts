import { loadAgents } from "../load-agents"
import { hostOmitsOutputLimit, resolveOutputBudget } from "../output-budget"
import { agentDir } from "../paths"
import type { Registrar } from "./types"

/**
 * Default output generation only for packaged Corvus agent IDs, snapshotted via
 * loadAgents before registration. SessionContext exposes agent, but model is only
 * Model.Ref (id/providerID/variant), not the resolved model with limit.output.
 *
 * Invariant: read options.maxTokens before mutation; a defined value or an
 * agent outside the snapshot bypasses the default. Missing model metadata uses
 * 32,000 via resolveOutputBudget, so a hidden larger route/model default can be
 * replaced and a smaller model ceiling cannot be enforced here. Corpus-read or
 * hook-registration failure aborts setup; disposal removes the hook. Repeated
 * invocation preserves the first assigned value; there is no runtime toggle.
 * Check host model IDs before mutation so host-omitted limits stay unset.
 */
export const registerHooks: Registrar = async (ctx) => {
  const corvusAgents = new Set(Object.keys(loadAgents(agentDir)))
  const registration = await ctx.session.hook("context", (context) => {
    if (!corvusAgents.has(context.agent)) return
    if (hostOmitsOutputLimit({ providerID: context.model.providerID, modelID: context.model.id })) return
    const budget = resolveOutputBudget({ current: context.options.maxTokens })
    if (budget !== undefined) context.options.maxTokens = budget
  })
  return async () => {
    try {
      await registration.dispose()
    } catch (error) {
      console.error(`corvus: failed to remove the output-budget hook — ${(error as Error).message}`)
    }
  }
}

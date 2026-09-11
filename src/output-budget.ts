/**
 * Leave a defined hook-visible output budget unchanged; otherwise use the smaller
 * of the model output limit and 32,000, falling back to 32,000 without a limit.
 *
 * Invariant: callers read the current value and available model limit before
 * mutating the request. A defined current value disables this default on either
 * host, even above 32,000; an absent limit uses the fallback, not a proven model
 * ceiling. Known limitation: v1 normally seeds the current value before its hook;
 * v2 exposes neither the resolved limit nor route/model generation defaults, so
 * the fallback can replace a larger hidden default.
 */
export function resolveOutputBudget({ current, modelLimit }: {
  current?: number
  modelLimit?: number
}): number | undefined {
  if (current !== undefined) return undefined
  return Math.min(modelLimit ?? 32_000, 32_000)
}

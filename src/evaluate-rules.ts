import type { Rule } from "./v2/types"

/**
 * Local mirror of the host's permission rule evaluation. Pure: no I/O, no draft
 * access, no console.
 *
 * INVARIANT — this module is a MIRROR, not a policy.
 *
 * Oracle: the OpenCode v2 host at `@opencode-ai/plugin@0.0.0-beta-19086` —
 * wildcard compilation `core/src/util/wildcard.ts:3-13` and rule evaluation
 * `core/src/permission.ts:87-97` (`rulesets.flat().findLast(...)`). It exists
 * because the v2 permission hook has to re-evaluate corvus's OWN protected-agent
 * policy at hook time: the host hands the hook a decision, not the ruleset that
 * produced it, so the boundary can only be enforced by re-running the same
 * matcher over corvus's rules.
 *
 * Read timing relative to mutations: none of the inputs are owned by this module.
 * `rules` is a snapshot the caller passes in, and evaluation happens strictly
 * after the caller has assembled it; nothing here mutates `rules`, compiles
 * state, or caches across calls, so two calls with equal arguments always agree.
 *
 * Fail direction per consumer: NO MATCH returns `undefined` rather than the
 * host's `{ effect: "ask" }` fallback, so "no rule spoke" stays distinguishable
 * from "a rule said ask". The caller decides. The protected-agent hook
 * (`src/v2/enforce-protected.ts`) must therefore treat `undefined` as "corvus has
 * no opinion" and leave the host's own decision untouched — it may only tighten,
 * never write `"allow"`.
 *
 * What disables this control: nothing at runtime — there is no flag, cache, or
 * environment switch, and an empty `rules` array degrades to `undefined` (the
 * caller keeps the host decision). What CAN break it is upstream drift: if the
 * host changes its matcher or its last-match-wins order, this mirror silently
 * disagrees with the real evaluation (risk R2). That divergence is pinned by the
 * dense table-driven tests owned by task `corvus-opencode-v2-09`, including the
 * `" .*"` trailing-argument case and the real `pr-comment-writer` shell
 * allowlist patterns; re-verify them against the host source on every SDK bump.
 */

/** Regex metacharacters the host escapes before expanding `*` and `?`. */
const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g

/**
 * Wildcard match, byte-faithful to `Wildcard.match(input, pattern)`
 * (`core/src/util/wildcard.ts:3-13`).
 *
 * Backslashes are normalized to `/` on both sides, regex specials are escaped,
 * then `*` becomes `.*` and `?` becomes `.`. The compiled pattern is anchored and
 * matched with the `s` flag (`si` on win32, so pattern matching is
 * case-insensitive there and case-sensitive everywhere else — dormant on darwin
 * but kept so the mirror does not diverge on Windows).
 *
 * SPECIAL CASE (`:11`): a pattern that compiles to a trailing `" .*"` becomes
 * `"( .*)?"`, which makes the trailing argument list optional. So the corpus
 * pattern `"ls *"` (`agent/code-explorer.md:13`) compiles to `ls( .*)?` and
 * matches both `ls src` and the bare `ls`; without the special case the bare
 * command would not match.
 */
export function matchWildcard(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")

  const compiled = pattern
    .replaceAll("\\", "/")
    .replace(REGEX_SPECIALS, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  const escaped = compiled.endsWith(" .*") ? compiled.slice(0, -3) + "( .*)?" : compiled

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}

/**
 * Resolve `action` + `resource` against an ordered ruleset.
 *
 * LAST matching rule wins, mirroring the host's `findLast`
 * (`core/src/permission.ts:87-97`) — rule order is the whole precedence model, so
 * callers must preserve the order `toV2Permissions` produced.
 *
 * @returns the winning effect, or `undefined` when no rule matches (see the
 * fail-direction note in the module docblock).
 */
export function evaluateRules(
  rules: readonly Rule[],
  action: string,
  resource: string,
): Rule["effect"] | undefined {
  return rules.findLast((rule) => matchWildcard(action, rule.action) && matchWildcard(resource, rule.resource))?.effect
}

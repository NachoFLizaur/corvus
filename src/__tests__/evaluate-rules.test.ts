import { describe, expect, test } from "bun:test"
import { evaluateRules, matchWildcard } from "../evaluate-rules"
import { loadAgents } from "../load-agents"
import { agentDir } from "../paths"
import { toV2Permissions } from "../to-v2-permissions"
import type { Rule } from "../v2/types"

/**
 * Matcher and rule-evaluation fidelity (task 06, risk R2).
 *
 * `evaluate-rules.ts` is a MIRROR of the host's own matcher
 * (`core/src/util/wildcard.ts:3-13`) and evaluation order
 * (`core/src/permission.ts:87-97`). Divergence would be silent — corvus would
 * think it had denied something the host allows, or vice versa — so these tables
 * pin the behaviours where a re-implementation is most likely to drift:
 * the `" .*"` trailing-argument special case, regex-special escaping, and
 * last-match-wins. Re-verify against the host source on every SDK bump.
 */

const corpus = loadAgents(agentDir)

/** `[input, pattern, expected]` */
type MatchCase = readonly [string, string, boolean]

const check = (cases: readonly MatchCase[]) => {
  for (const [input, pattern, expected] of cases)
    expect({ input, pattern, matches: matchWildcard(input, pattern) }).toEqual({ input, pattern, matches: expected })
}

describe("matchWildcard", () => {
  test("matches literal patterns, `*`, `?`, and normalizes backslashes", () => {
    check([
      ["read", "read", true],
      ["edit", "read", false],
      ["shell", "*", true],
      ["anything at all", "*", true],
      [".env", "*.env", true],
      ["src/a.env", "*.env", true],
      [".env.local", "*.env.*", true],
      // `?` is exactly one character.
      ["ab", "a?", true],
      ["abc", "a?", false],
      // Both sides are normalized to `/` before compiling.
      ["a\\b", "a/b", true],
      ["a\\b", "a\\b", true],
    ])
  })

  test("makes a trailing argument list optional only when a space precedes the `*`", () => {
    // `core/util/wildcard.ts:11` rewrites a compiled trailing `" .*"` to `"( .*)?"`,
    // so the synthetic pattern `"ls *"` also matches the
    // bare command. Without the special case `ls` alone would fall through to the
    // preceding `*` deny. A trailing `*` with no preceding space is unaffected and
    // stays greedy.
    check([
      ["ls", "ls *", true],
      ["ls src", "ls *", true],
      ["ls -la /tmp", "ls *", true],
      ["ls  src", "ls *", true],
      ["lsof", "ls *", false],
      ["git log", "git log*", true],
      ["git log --oneline", "git log*", true],
      // No word boundary is implied — this is the host behaviour, not a typo.
      ["git logs", "git log*", true],
    ])
  })

  test("escapes regex specials so `.` is a literal dot", () => {
    check([
      ["jq . .corvus/review-payload.json", "jq . .corvus/review-payload.json", true],
      ["jq X .corvus/review-payload.json", "jq . .corvus/review-payload.json", false],
      ["jq . .corvus/other.json", "jq . .corvus/review-payload.json", false],
      ["python3 -m json.tool .corvus/review-payload.json", "python3 -m json.tool .corvus/review-payload.json", true],
      ["python3 -m jsonXtool .corvus/review-payload.json", "python3 -m json.tool .corvus/review-payload.json", false],
    ])
  })

  test("honours synthetic GitHub command patterns", () => {
    check([
      [
        "gh api --method GET repos/o/r/pulls/1 -H Accept:application/vnd.github+json",
        "gh api --method GET repos/*/pulls/* -H Accept:*",
        true,
      ],
      [
        "gh api --method POST repos/o/r/pulls/1 -H Accept:application/vnd.github+json",
        "gh api --method GET repos/*/pulls/* -H Accept:*",
        false,
      ],
      ["gh api --method GET repos/o/r/issues -H Accept:x", "gh api --method GET repos/*/pulls/* -H Accept:*", false],
      [
        "gh api --method POST repos/o/r/pulls/1/reviews --input .corvus/review-payload.json",
        "gh api --method POST repos/*/pulls/*/reviews --input .corvus/review-payload.json",
        true,
      ],
    ])
  })
})

describe("evaluateRules", () => {
  const rules: readonly Rule[] = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "shell", resource: "ls *", effect: "allow" },
  ]

  test("lets the last matching rule win", () => {
    expect(evaluateRules(rules, "shell", "ls src")).toBe("allow")
    expect(evaluateRules(rules, "shell", "rm -rf /")).toBe("deny")
    expect(evaluateRules(rules, "read", "src/index.ts")).toBe("allow")
  })

  test("reverses the outcome when the authored order is reversed", () => {
    const reordered: readonly Rule[] = [rules[0], rules[2], rules[1]]

    expect(evaluateRules(reordered, "shell", "ls src")).toBe("deny")
  })

  test("returns undefined when nothing matches, so `no opinion` stays distinct from `ask`", () => {
    expect(evaluateRules([], "read", "src/index.ts")).toBeUndefined()
    expect(evaluateRules([{ action: "read", resource: "*", effect: "allow" }], "edit", "x")).toBeUndefined()
    expect(evaluateRules([{ action: "read", resource: "*.env", effect: "ask" }], "read", "src/index.ts")).toBeUndefined()
  })

  test("resolves the real code-explorer default allow", () => {
    const explorer = toV2Permissions(corpus["code-explorer"].permission)

    expect(evaluateRules(explorer, "shell", "ls")).toBe("allow")
    expect(evaluateRules(explorer, "shell", "ls src")).toBe("allow")
    expect(evaluateRules(explorer, "shell", "lsof")).toBe("allow")
  })
})

import { describe, expect, test } from "bun:test"
import { expandTemplate, type RunShell } from "../v2/expand-template"

/**
 * Template expansion (task 10) — the four host behaviors corvus had to port when
 * v2 replaced template commands with functions.
 *
 * NO TEST IN THIS FILE SPAWNS A PROCESS. `runShell` is a parameter of
 * `expandTemplate` precisely so the interpolation contract can be pinned without
 * one, and `neverRuns` turns an accidental shell reach into a failure rather than
 * a slow pass. The real-shell, real-corpus assertion is deliberately elsewhere
 * (task 15, after task 14 converts the packaged non-executable interpolations).
 */

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Fails the test if a template reaches for a shell it should not need. */
const neverRuns: RunShell = (command) => {
  throw new Error(`this template must not reach for a shell, but requested ${JSON.stringify(command)}`)
}

describe("expandTemplate placeholders", () => {
  test("substitutes $1..$N, with the highest placeholder absorbing the remaining arguments", async () => {
    // `$2` is the highest, so it collects everything from the second argument on
    // — and quoted arguments arrive as one token with the quotes stripped.
    expect(await expandTemplate("run $1 against $2", 'build "src dir" --watch extra', neverRuns)).toBe(
      "run build against src dir --watch extra",
    )

    // A position the user did not supply expands to empty — the one case where
    // empty substitution is correct — and the surrounding text is untouched.
    expect(await expandTemplate("run $1 and $2 done", "one", neverRuns)).toBe("run one and  done")
  })

  test("substitutes $ARGUMENTS with the raw argument string at every occurrence", async () => {
    expect(await expandTemplate("Commit: $ARGUMENTS\n\nAgain: $ARGUMENTS", '--amend "with quotes"', neverRuns)).toBe(
      'Commit: --amend "with quotes"\n\nAgain: --amend "with quotes"',
    )
  })

  test("never re-reads $ patterns in arguments or command output as substitutions", async () => {
    // `$&`, `$$` and `$'` are `String.replace` substitution patterns. A
    // replacement STRING would expand them; the replacer FUNCTIONS corvus uses
    // insert them literally, so arguments reach the prompt exactly as typed.
    expect(await expandTemplate("msg: $ARGUMENTS", "fix $& and $$ and $'", neverRuns)).toBe("msg: fix $& and $$ and $'")
    expect(await expandTemplate("msg: $1", "$&", neverRuns)).toBe("msg: $&")

    // The same guard covers command OUTPUT, which is why a diff full of `$` is
    // spliced in verbatim instead of being partially rewritten.
    expect(await expandTemplate("diff: !`git diff`", "", () => Promise.resolve("-$& +$$"))).toBe("diff: -$& +$$")
  })

  test("appends the input after a blank line only when the template has no placeholder", async () => {
    // `summary.md` is the packaged command in this class: without the append its
    // arguments would be silently discarded.
    expect(await expandTemplate("Summarize the session.", "since noon", neverRuns)).toBe(
      "Summarize the session.\n\nsince noon",
    )

    // Blank input is not worth a blank line.
    expect(await expandTemplate("Summarize the session.", "   ", neverRuns)).toBe("Summarize the session.")

    // A template that HAS a placeholder consumes the input instead of appending it.
    expect(await expandTemplate("Summarize $ARGUMENTS", "since noon", neverRuns)).toBe("Summarize since noon")
    expect(await expandTemplate("Summarize $1", "since noon", neverRuns)).toBe("Summarize since noon")
  })
})

describe("expandTemplate shell interpolation", () => {
  test("substitutes each output in MATCH order, not completion order", async () => {
    const issued: string[] = []
    const run: RunShell = async (command) => {
      issued.push(command)
      // The first-issued command finishes LAST, so collecting outputs in
      // completion order would swap them.
      await delay(command === "git status" ? 20 : 1)
      return `<${command}>`
    }

    expect(await expandTemplate("A !`git status` B !`git diff` C", "", run)).toBe("A <git status> B <git diff> C")
    expect(issued).toEqual(["git status", "git diff"])
  })

  test("runs at most two interpolations at a time, matching the host's concurrency cap", async () => {
    let inFlight = 0
    let peak = 0
    const run: RunShell = async (command) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await delay(5)
      inFlight -= 1
      return command
    }

    expect(await expandTemplate("!`a` !`b` !`c` !`d` !`e`", "", run)).toBe("a b c d e")
    expect(peak).toBe(2)
  })

  test("fails the whole expansion on a shell failure, reporting the lowest-indexed one", async () => {
    const attempted: string[] = []
    const run: RunShell = async (command) => {
      attempted.push(command)
      // `missing` rejects FIRST but sits later in the template, so a
      // race-to-first-rejection would report the wrong command.
      if (command === "false") {
        await delay(20)
        throw new Error("exit 1")
      }
      if (command === "missing") {
        await delay(1)
        throw new Error("not found")
      }
      return "ok"
    }

    // Rejecting is the assertion: there is no degraded return value in which the
    // failed command was replaced by empty output.
    await expect(expandTemplate("!`git log` !`false` !`missing`", "", run)).rejects.toThrow(
      'corvus: shell interpolation failed for "false" — exit 1',
    )

    // Every command is attempted, so the reported failure is a function of the
    // template and the runner rather than of scheduling.
    expect(attempted.sort()).toEqual(["false", "git log", "missing"])
  })
})

/**
 * Pure expansion of a v2 command template.
 *
 * v2 commands are FUNCTIONS, not templates: the host hands a plugin
 * `execute(input)` and expects prompt text back (`ctx.session.prompt`). So the
 * template semantics v1 got for free from the host must be ported. This module
 * is that port, kept pure — `runShell` is a PARAMETER, there is no `ctx` import
 * and no process spawning here, so the four expansion behaviors are testable
 * without a host and without touching a real shell. `register-commands.ts` owns
 * the real runner.
 *
 * Ported behaviors, applied in the host's order
 * (`core/src/config/plugin/command.ts:150-202`):
 *   1. `$1..$N` positional substitution, where the HIGHEST-numbered placeholder
 *      absorbs every remaining argument (`:161-169`).
 *   2. `$ARGUMENTS` → the full raw argument string (`:170`).
 *   3. When the template carries NO placeholder of either kind and the input is
 *      non-blank, the input is appended after a blank line (`:171-174`).
 *   4. `` !`cmd` `` interpolation, concurrency-capped at 2 (`:175-201`).
 *
 * INVARIANT — deterministic expansion, visible shell failure.
 *
 * Oracle: the `(template, args)` pair plus the outputs `runShell` returns.
 * Nothing else is read — no disk, no environment, no clock, no module state that
 * survives a call. So expansion is a pure function of its arguments and the
 * injected runner's results, which is what lets `register-commands.ts` snapshot
 * templates at setup and expand them per invocation without the two drifting.
 *
 * Read timing relative to mutations: this module mutates nothing. Every step
 * reads the string produced by the previous step and returns a new one; the
 * shell phase reads the fully substituted text ONCE (`matchAll` before any
 * `runShell` call), so no command's output can change which commands get run.
 * The shell phase is therefore a snapshot-then-execute, not a rewrite loop.
 *
 * Fail direction per consumer: FAIL CLOSED, and deliberately harder than the
 * host. Any `runShell` rejection AND any non-zero exit surfaced as a rejection
 * aborts the whole expansion by throwing, so the caller's `execute` rejects and
 * the HOST reports a failed command (`core/src/command.ts:85-88` logs and maps
 * to `Command.ExecutionError`) — the USER sees an error instead of a prompt.
 * Empty output is NEVER substituted for a failure. That matters most for
 * `/git-commit`, which reads `` !`git diff --cached` ``: substituting empty
 * output there would silently turn "commit these staged changes" into "commit
 * nothing", and the model would invent a message for a diff it never saw.
 * DIVERGENCE from the host, disclosed: the host does NOT fail on a non-zero
 * exit — `AppProcess.run` returns a `RunResult` carrying `exitCode` and the
 * interpolation path never calls `requireSuccess`
 * (`util/src/process.ts:38-63`, `:144-164`), so upstream substitutes the
 * combined stdout+stderr of a failed command into the prompt. Corvus rejects
 * instead. The strictness is a guardrail, not an accident, and it means a
 * template whose interpolation cannot exit zero is a BROKEN template rather than
 * a noisy one.
 *
 * What disables this control: nothing. There is no flag, environment variable,
 * or cache that relaxes the strict-fail path, and no code path substitutes a
 * placeholder value for a failed command. It can only be weakened by changing
 * `runAll` to swallow `failures`.
 *
 * CORPUS INTERPOLATION CLASSIFICATION (packaged `command/*.md`, verified by
 * running the host regex over the real files rather than by grepping for the
 * literal `` !` ``): the host pattern `` /!`([^`]+)`/g `` matches exactly SEVEN
 * times across 2 of the 4 commands, and every match is an EXECUTABLE git read —
 * `git-commit.md:25,28,36` and `readme.md:22,32,35,96`. These exit zero in a git
 * worktree and are the interpolations the commands are designed around, so the
 * whole packaged corpus is expandable under the strict-fail contract above.
 * Historically four further sites matched — two carrying unresolved `<...>`
 * placeholders and two prose false positives where a breaking-change `` `!` ``
 * marker abutted a closing backtick — and task 14 converted or reworded all four
 * out of the corpus; `__tests__/frontmatter-contract.test.ts` now pins the count
 * of seven and asserts each site is a real command rather than a placeholder or
 * captured prose.
 * Nothing in this module or in registration executes any of them — expansion
 * happens only per `execute` invocation.
 */

/**
 * Runs one `` !`cmd` `` interpolation and resolves with the text to substitute.
 *
 * Contract for implementors: REJECT on anything that is not a clean success —
 * spawn failure, signal death, or a non-zero exit — because a resolved value is
 * treated as trustworthy output and spliced into the prompt verbatim. Resolving
 * with an error string or an empty string on failure defeats the strict-fail
 * invariant documented above.
 */
export type RunShell = (command: string) => Promise<string>

/** Simultaneous `` !`cmd` `` executions, matching the host's `{ concurrency: 2 }`. */
const SHELL_CONCURRENCY = 2

/**
 * Expand `template` against the raw argument string `args`.
 *
 * @param template The command body, already wrapped in `<command-instruction>`
 *   by `load-commands.ts`. The wrapper survives expansion byte-identically: it
 *   contains no placeholder, and the `trim()` calls the host applies cannot bite
 *   because the wrapped string starts and ends with a tag character.
 * @param args The user's raw input for this invocation (the host's
 *   `input.prompt.text`) — a STRING, not a pre-split array; positional splitting
 *   happens here so it matches the host's quoting rules exactly.
 * @throws Error when any `` !`cmd` `` interpolation fails. See the module
 *   invariant: expansion fails as a whole rather than degrading.
 */
export async function expandTemplate(template: string, args: string, runShell: RunShell): Promise<string> {
  const positional = parseArguments(args)
  const placeholders = template.match(placeholderRegex) ?? []

  // The highest-numbered placeholder is greedy, so `$2` in "a $1 $2" collects
  // every argument from the second onward instead of just one.
  const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))

  const expanded = template.replaceAll(placeholderRegex, (_match, index: string) => {
    const position = Number(index)
    const argIndex = position - 1
    // An unsupplied position expands to empty — the host's behavior, and the one
    // case where empty substitution is correct: the user simply passed fewer
    // arguments than the template mentions.
    if (argIndex >= positional.length) return ""
    if (position === last) return positional.slice(argIndex).join(" ")
    return positional[argIndex]
  })

  // A replacer FUNCTION, not a replacement string: `String.replaceAll` would
  // interpret `$&`, `$'`, and `$$` inside user-supplied `args` as substitution
  // patterns. Upstream passes the raw string here and is subject to that; corvus
  // does not, so arguments reach the prompt exactly as typed.
  const withArguments = expanded.replaceAll("$ARGUMENTS", () => args)

  // With no placeholder anywhere, input would otherwise be silently discarded,
  // so the host appends it after a blank line. `summary.md` is the only corvus
  // command in this class today.
  const text =
    placeholders.length === 0 && !template.includes("$ARGUMENTS") && args.trim()
      ? `${withArguments}\n\n${args}`.trim()
      : withArguments.trim()

  const matches = Array.from(text.matchAll(shellRegex))
  if (matches.length === 0) return text

  const outputs = await runAll(
    matches.map((match) => match[1] ?? ""),
    runShell,
  )

  // Outputs are consumed in match order, and again through a replacer FUNCTION
  // so that a `$1` or `$&` appearing in command OUTPUT is inserted literally
  // rather than re-read as a substitution pattern. `runAll` guarantees one
  // output per match, so there is no missing-value branch to fall back on.
  let cursor = 0
  return text.replace(shellRegex, () => outputs[cursor++])
}

/**
 * Run every interpolation with at most `SHELL_CONCURRENCY` in flight, returning
 * outputs in MATCH order regardless of completion order.
 *
 * Failures are collected rather than raced: every command is attempted, and the
 * lowest-indexed failure is the one reported. Rejecting at the first failure
 * would make the reported command depend on scheduling — with two workers in
 * flight, whichever rejected first would win — and would leave the sibling
 * worker's rejection unobserved. Attempting all of them keeps the thrown error a
 * deterministic function of `(commands, runShell)`, which is the property the
 * module invariant promises and the one tests can pin.
 */
async function runAll(commands: readonly string[], runShell: RunShell): Promise<string[]> {
  const outputs = new Array<string>(commands.length)
  const failures: { readonly index: number; readonly error: unknown }[] = []
  let next = 0

  const worker = async (): Promise<void> => {
    while (next < commands.length) {
      const index = next++
      await runShell(commands[index]).then(
        (output) => {
          outputs[index] = output
        },
        (error: unknown) => {
          failures.push({ index, error })
        },
      )
    }
  }

  await Promise.all(Array.from({ length: Math.min(SHELL_CONCURRENCY, commands.length) }, worker))

  if (failures.length > 0) {
    const first = failures.reduce((earliest, failure) => (failure.index < earliest.index ? failure : earliest))
    throw new Error(
      `corvus: shell interpolation failed for ${JSON.stringify(commands[first.index])} — ${describe(first.error)}`,
    )
  }

  return outputs
}

/** Split raw input into positional arguments, honoring quotes and image refs. */
function parseArguments(input: string): string[] {
  return (input.match(argsRegex) ?? []).map((arg) => arg.replace(quoteTrimRegex, ""))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Kept byte-identical to the host's own patterns
 * (`core/src/config/plugin/command.ts:208-211`) so corvus expands a template the
 * same way the host expands a user's. Divergence here is a silent
 * incompatibility, so change these only alongside a re-read of that file.
 *
 * These are module-level and stateful (`g`), which is safe: `match`, `replace`,
 * and `replaceAll` each reset `lastIndex` before scanning, `matchAll` clones the
 * regex, and no `await` sits between a scan and its use of `lastIndex`.
 */
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g
const shellRegex = /!`([^`]+)`/g

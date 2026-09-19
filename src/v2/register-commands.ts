import { spawn } from "node:child_process"
import { basename } from "node:path"
import { loadCommands } from "../load-commands"
import { commandDir } from "../paths"
import { expandTemplate, type RunShell } from "./expand-template"
import type { Registrar, SetupContext } from "./types"

/**
 * Registers the packaged corvus commands as host command FUNCTIONS via
 * `ctx.command.transform`.
 *
 * v1 handed the host a template string and the host expanded it. v2 has no such
 * hook: `CommandEditor.add` takes `{name, description?, execute}` and the plugin
 * owns everything between the user typing `/git-commit` and prompt text reaching
 * the session. This registrar is that bridge, mirroring the host's own
 * template→function adapter (`core/src/config/plugin/command.ts:60-100`):
 * optional agent/model preamble, then expand, then `ctx.session.prompt`.
 *
 * INVARIANT — snapshot at setup, expand per invocation.
 *
 * Oracle: the packaged `command/*.md` corpus, read ONCE per `setup()` through the
 * shared v1 loader (`load-commands.ts`), plus `ctx.location.directory` captured
 * at the same moment. The draft is never an input — corvus never reads back what
 * it or the user wrote — so which commands exist is a function of the packaged
 * files alone.
 *
 * Read timing relative to mutations: all disk reads, frontmatter validation, and
 * warnings happen BEFORE `ctx.command.transform` is called. The transform closure
 * is synchronous and pure over that snapshot; it performs no I/O and logs
 * nothing. That matters because the host REPLAYS plugin transforms on config
 * reload, and a closure that re-read the disk could contribute a corpus that
 * `setup()` never validated. Template EXPANSION deliberately does not happen at
 * either point — it happens per `execute` invocation, because the arguments and
 * the shell results are per-invocation facts. A consequence worth stating: merely
 * registering commands never runs a single `` !`cmd` ``.
 *
 * Replay safety (why re-registering cannot duplicate): the host's command draft
 * is a `Map` keyed by name and `add` does `draft.set(definition.name, …)`
 * (`core/src/command.ts:57-61`), so a replay overwrites corvus's four entries
 * with themselves. Unlike agent `permissions`, there is no accumulating array
 * here and no de-duplication code is needed. (NOTE for the phase test task: the
 * `src/__tests__/fake-context.ts` command recorder is an ARRAY, so a
 * replay-idempotency assertion against the fake needs Map-by-name semantics to
 * mirror the host.)
 *
 * Fail direction per consumer: registration fails CLOSED and invocation fails
 * VISIBLY. A corpus that will not parse throws out of `loadCommands`, aborting
 * `setup()`, so the HOST gets no corvus at all rather than a silently incomplete
 * command set — the same all-or-nothing direction `server.ts` enforces. At
 * invocation, a failed shell interpolation rejects `execute`, and the host logs
 * it and reports `Command.ExecutionError` to the USER
 * (`core/src/command.ts:85-88`) rather than prompting the model with a
 * half-expanded template. See `expand-template.ts` for why empty output is never
 * substituted.
 *
 * What disables this control: nothing at runtime — no flag, cache, or environment
 * switch, and an empty corpus degrades to a transform that contributes nothing.
 * It is undone only by the returned cleanup, which disposes the registration so
 * the host stops replaying the transform (plugin unload, or `server.ts` unwinding
 * a failed `setup()`).
 *
 * PREMISE CORRECTION (installed d.ts is authoritative over the planning notes):
 * the plan specified backing `runShell` with `ctx.shell`. It cannot be done.
 * `ShellDomain` is `{ hook: Hooks<ShellHooks> }` — a `create.before` INTERCEPTOR
 * for shells the host is already spawning, with no command runner
 * (`plugin-v2/dist/promise/shell.d.ts:9-14`); the same is true in the reference
 * checkout, and no other domain on `Plugin.Context` exposes one. The host's own
 * adapter reaches for `AppProcess`/`ShellSelect`, which are core-internal
 * services a plugin cannot obtain. So corvus spawns the shell itself through
 * `node:child_process`, which also keeps `dist/server.js` free of runtime
 * `@opencode-ai` imports. Bun APIs are avoided for the same portability reason
 * `paths.ts` avoids `import.meta.dir`: the bundle targets Node.
 */

/** The `CommandEditor` the host hands to a `ctx.command.transform` callback. */
type CommandDraft = Parameters<Parameters<SetupContext["command"]["transform"]>[0]>[0]

/** One command as `CommandEditor.add` accepts it. */
type CommandDefinition = Parameters<CommandDraft["add"]>[0]

/** The per-invocation input the host passes to `execute`. */
type CommandInvocation = Parameters<CommandDefinition["execute"]>[0]

/** The handle `ctx.command.transform` resolves to, whose `dispose` removes the transform. */
type Registration = Awaited<ReturnType<SetupContext["command"]["transform"]>>

/** A model reference in the shape `ctx.session.switchModel` expects. */
type ModelRef = Parameters<SetupContext["session"]["switchModel"]>[0]["model"]

/** One corpus command, validated and frozen at setup for its `execute` closure. */
interface PreparedCommand {
  /** Draft key — the `loadCommands` record key (filename without `.md`). */
  readonly name: string
  readonly description?: string
  /** Body already wrapped in `<command-instruction>` by `load-commands.ts`. */
  readonly template: string
  readonly agent?: string
  readonly model?: ModelRef
}

/**
 * Validate the whole corpus into `execute`-ready records.
 *
 * Warnings are emitted here — once per `setup()`, outside the replayed transform
 * closure — so a config reload does not reprint them.
 */
function prepareCorpus(corpus: ReturnType<typeof loadCommands>): PreparedCommand[] {
  return Object.entries(corpus).map(([name, config]) => {
    // `subtask` asked v1 to run the command in a fresh child session. v2 has no
    // equivalent on `CommandDefinition`, and `execute` is handed the invoking
    // `sessionID`, so the field is dropped rather than silently reinterpreted as
    // "run inline" — 0/4 commands set it today, so this is a guard for future
    // corpus edits.
    if (config.subtask !== undefined)
      console.warn(
        `corvus: ignoring unsupported "subtask" on command "${name}" — v2 commands always run in the invoking session`,
      )

    return {
      name,
      description: config.description,
      template: config.template,
      agent: config.agent,
      model: parseModel(name, config.model),
    }
  })
}

/**
 * Split a v1 `provider/model` frontmatter string into the v2 `{providerID, id}`
 * reference.
 *
 * Split on the FIRST separator only: provider ids never contain `/` but model
 * ids routinely do (`openrouter` + `anthropic/claude-sonnet-4`), so splitting on
 * the last one would mangle exactly the ids most likely to be authored.
 *
 * A malformed value degrades to "no model switch" plus a warning at setup rather
 * than throwing, because the model is a preference: dropping it still runs the
 * command on the session's current model, whereas failing registration would
 * cost the user the command entirely. The warning fires once per setup, at the
 * moment the corpus is read, so a bad value is not discovered per invocation.
 */
function parseModel(command: string, model: string | undefined): ModelRef | undefined {
  if (model === undefined) return undefined

  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) {
    console.warn(
      `corvus: ignoring malformed "model" on command "${command}" — expected "providerID/modelID", got ${JSON.stringify(model)}`,
    )
    return undefined
  }

  return { providerID: model.slice(0, separator), id: model.slice(separator + 1) }
}

/**
 * Build the `execute` function for one prepared command.
 *
 * DIVERGENCES from the host adapter, both disclosed and both unobservable in the
 * current corpus (0/4 commands set `agent` or `model`):
 *   - The host reads the session first and switches only when the agent differs
 *     (`command.ts:69-74`); corvus switches whenever frontmatter names an agent.
 *     Switching to the agent already in use is idempotent, and skipping the read
 *     keeps `ctx.session.get` out of corvus's required host surface.
 *   - When `agent` is set but `model` is not, the host additionally re-asserts
 *     that agent's own default model (`command.ts:73-85`). Corvus does not, so
 *     such a command runs the target agent on the session's CURRENT model. This
 *     follows the task contract (`agent` → `switchAgent`, `model` →
 *     `switchModel`) and avoids depending on `ctx.agent.get`; add the fallback if
 *     a command ever needs its agent's model forced.
 */
function createExecute(command: PreparedCommand, ctx: SetupContext, runShell: RunShell) {
  return async (input: CommandInvocation): Promise<void> => {
    if (command.agent !== undefined) await ctx.session.switchAgent({ sessionID: input.sessionID, agent: command.agent })
    if (command.model !== undefined) await ctx.session.switchModel({ sessionID: input.sessionID, model: command.model })

    // `input.prompt.text` is the argument string the user typed after the command
    // name — the host's own second argument to `evaluateTemplate`.
    const text = await expandTemplate(command.template, input.prompt.text, runShell)

    // Spread the invocation's prompt first so attachments (files, agent and skill
    // mentions, metadata) survive, then override only the expanded text. Dropping
    // the spread would silently discard everything the user attached to the
    // command.
    await ctx.session.prompt({
      ...input.prompt,
      sessionID: input.sessionID,
      text,
      delivery: input.delivery,
    })
  }
}

/**
 * A `RunShell` that executes one interpolation in a real shell rooted at `cwd`.
 *
 * Mirrors the host's interpolation spawn (`command.ts:182-195`): stdin is
 * ignored so a command that reads input cannot hang the invocation, and stdout
 * and stderr are COMBINED in arrival order, matching `combineOutput: true` —
 * commands like `` !`ls … 2>/dev/null || echo …` `` deliberately write to both.
 *
 * Rejects on spawn failure, on signal death (`code === null`), and on any
 * non-zero exit, carrying the captured output so the user can see WHY. The
 * non-zero case is corvus's documented hardening over the host; see the
 * `expand-template.ts` invariant.
 */
function createShellRunner(cwd: string): RunShell {
  const shell = resolveShell()

  return (command) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(shell, shellArgs(shell, command), { cwd, stdio: ["ignore", "pipe", "pipe"] })
      const chunks: Buffer[] = []

      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk))
      child.on("error", reject)
      child.on("close", (code) => {
        const output = Buffer.concat(chunks).toString("utf8")
        if (code === 0) return resolve(output)
        const detail = output.trim()
        reject(new Error(`${shell} exited with code ${code}${detail ? `: ${detail}` : ""}`))
      })
    })
}

/**
 * Pick the interpolation shell, mirroring `ShellSelect` at `priority: "config"`
 * (`core/src/shell/select.ts:178-188`, `:133-138`): the user's `$SHELL` is used
 * as-is when set, with the host's platform fallbacks otherwise. The host's
 * config-priority path deliberately does NOT filter for POSIX compatibility, so
 * neither does this.
 */
function resolveShell(): string {
  if (process.platform === "win32") return process.env.ComSpec || "cmd.exe"
  if (process.env.SHELL) return process.env.SHELL
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"
}

/** Per-shell invocation flags, mirroring `ShellSelect.args` (`select.ts:163-168`). */
function shellArgs(shell: string, command: string): string[] {
  const name = basename(shell).toLowerCase().replace(/\.exe$/, "")
  if (name === "cmd") return ["/c", command]
  if (name === "powershell" || name === "pwsh")
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
  return ["-c", command]
}

export const registerCommands: Registrar = async (ctx) => {
  const commands = prepareCorpus(loadCommands(commandDir))

  // Captured once, outside the replayed closure. `location.directory` is the
  // directory the host is operating in and is what the host's own interpolation
  // uses as cwd (`command.ts:90`, `:186`) — not `location.project.directory`,
  // which would resolve to the project root and change the meaning of every
  // relative git read inside a worktree.
  const runShell = createShellRunner(ctx.location.directory)

  const registration: Registration = await ctx.command.transform((draft) => {
    for (const command of commands)
      draft.add({
        name: command.name,
        // Omitted rather than passed as `undefined` so the host sees an absent
        // optional field, matching how `loadCommands` reports a missing one.
        ...(command.description === undefined ? {} : { description: command.description }),
        execute: createExecute(command, ctx, runShell),
      })
  })

  // `server.ts` unwinds cleanups LIFO and requires them not to throw, so a failed
  // disposal is reported rather than propagated — it would otherwise mask the
  // original setup error.
  return async () => {
    try {
      await registration.dispose()
    } catch (e) {
      console.error(`corvus: failed to remove the command transform — ${(e as Error).message}`)
    }
  }
}

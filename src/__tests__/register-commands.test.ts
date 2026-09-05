import { describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadCommands } from "../load-commands"
import { agentDir, commandDir, root, skillDir } from "../paths"
import type { Cleanup } from "../v2/types"
import { registerCommands } from "../v2/register-commands"
import {
  createFakeContext,
  type CommandInvocation,
  type FakeContext,
  type SessionCall,
  type SessionPromptInput,
} from "./fake-context"

/**
 * Command registration against a host double (task 10).
 *
 * NO TEST IN THIS FILE SPAWNS A PROCESS, and the registrar builds its own shell
 * runner from `ctx.location.directory` with no injection point. So `execute` is
 * driven ONLY for templates that carry no `` !`cmd` `` interpolation —
 * `cleanup-subagents` (0) and `summary` (0) from the real corpus, plus synthetic
 * files. `git-commit` (3 matches) and `readme` (4) are asserted as REGISTERED
 * only; their expansion is covered by `expand-template.test.ts` through an
 * injected runner, and the real-shell corpus run belongs to task 15.
 */

// Captured BEFORE any module mock so the real values can always be restored.
const REAL_PATHS = { root, agentDir, commandDir, skillDir }

const corpus = loadCommands(commandDir)
const names = Object.keys(corpus).sort()

const asCleanup = (value: Cleanup | void): Cleanup => {
  if (typeof value !== "function") throw new Error("registerCommands must return a cleanup")
  return value
}

/**
 * Run `body` against a synthetic corpus in a temp dir, never the real `command/`.
 * `src/paths.ts` is the only injection point — the registrar resolves
 * `commandDir` at call time, so redirecting the module redirects the load.
 */
const withCorpus = async (files: Record<string, string>, body: () => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "corvus-v2-command-corpus-"))
  try {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)
    await mock.module("../paths", () => ({ ...REAL_PATHS, commandDir: dir }))
    await body()
  } finally {
    await mock.module("../paths", () => REAL_PATHS)
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Drive one registered command the way the host would. */
const invoke = async (fake: FakeContext, name: string, text: string, prompt: Record<string, unknown> = {}) => {
  const definition = fake.commands.get(name)
  if (definition === undefined) throw new Error(`command ${JSON.stringify(name)} was never registered`)

  await definition.execute({
    sessionID: "ses_fake",
    prompt: { text, ...prompt },
    delivery: "queue",
  } as unknown as CommandInvocation)
}

const promptOf = (call: SessionCall): SessionPromptInput => {
  if (call.method !== "prompt") throw new Error(`expected a prompt call, got ${JSON.stringify(call.method)}`)
  return call.input
}

describe("registerCommands", () => {
  test("registers the four packaged commands as functions through a single transform", async () => {
    const fake = createFakeContext()

    await registerCommands(fake.ctx)

    expect([...fake.commands.keys()].sort()).toEqual(names)
    expect(fake.commands.size).toBe(4)
    expect(fake.registrations.map((registration) => registration.kind)).toEqual(["command.transform"])

    for (const [name, definition] of fake.commands) {
      expect(typeof definition.execute).toBe("function")
      expect({ name, description: definition.description }).toEqual({ name, description: corpus[name].description })
    }

    // `summary.md`'s frontmatter is description-only since task 14 dropped its
    // non-command `mode`/`temperature` keys; the shared loader copies only the
    // fields it knows regardless, so nothing extra can reach the draft.
    expect(Object.keys(fake.commands.get("summary")!).sort()).toEqual(["description", "execute", "name"])

    // Registering never expands a template, so nothing was prompted and no
    // interpolation ran.
    expect(fake.sessionCalls).toEqual([])
  })

  test("expands $ARGUMENTS and forwards sessionID, delivery and prompt attachments", async () => {
    const fake = createFakeContext()
    await registerCommands(fake.ctx)

    const files = [{ uri: "file:///tmp/notes.md" }]
    await invoke(fake, "cleanup-subagents", "--list --global", { files })

    expect(fake.sessionCalls.map((call) => call.method)).toEqual(["prompt"])
    const sent = promptOf(fake.sessionCalls[0])

    expect(sent.sessionID).toBe("ses_fake")
    expect(sent.delivery).toBe("queue")
    // The `...input.prompt` spread is what keeps attachments alive.
    expect(sent.files).toEqual(files)

    // The `<command-instruction>` wrapper survives expansion byte-identically.
    expect(sent.text.startsWith("<command-instruction>\n")).toBe(true)
    expect(sent.text.endsWith("\n</command-instruction>")).toBe(true)
    expect(sent.text).toContain("The user provided: `--list --global`")
    expect(sent.text).not.toContain("$ARGUMENTS")
  })

  test("appends the input after a blank line for a placeholder-free command", async () => {
    const fake = createFakeContext()
    await registerCommands(fake.ctx)

    await invoke(fake, "summary", "focus on the v2 port")
    const sent = promptOf(fake.sessionCalls[0])

    expect(sent.text.startsWith("<command-instruction>\n")).toBe(true)
    expect(sent.text.endsWith("</command-instruction>\n\nfocus on the v2 port")).toBe(true)

    // 0/4 packaged commands name an agent or a model, so no preamble runs.
    expect(fake.sessionCalls.map((call) => call.method)).toEqual(["prompt"])
  })

  test("is idempotent across a reload replay, and cleanup stops the replay", async () => {
    const fake = createFakeContext()

    const cleanup = asCleanup(await registerCommands(fake.ctx))
    fake.replay()
    fake.replay()

    // The host's draft is a `Map` keyed by name, so a replay overwrites corvus's
    // four entries with themselves.
    expect([...fake.commands.keys()].sort()).toEqual(names)
    expect(fake.commands.size).toBe(4)

    await cleanup()

    expect(fake.registrations[0].disposed).toBe(true)
    fake.commands.clear()
    fake.replay()
    expect(fake.commands.size).toBe(0)
  })
})

describe("registerCommands frontmatter the packaged corpus does not exercise", () => {
  test("switches agent then model before prompting, and warns instead of failing on the rest", async () => {
    await withCorpus(
      {
        // Provider ids never contain `/` but model ids routinely do, so the split
        // must take the FIRST separator.
        "switching.md":
          "---\ndescription: switches\nagent: researcher\nmodel: openrouter/anthropic/claude-sonnet-4\n---\nBody for $ARGUMENTS\n",
        "bad-model.md": "---\ndescription: bad model\nmodel: nonsense\n---\nBody\n",
        "child.md": "---\ndescription: child session\nsubtask: true\n---\nBody\n",
      },
      async () => {
        const warnings = spyOn(console, "warn").mockImplementation(() => {})

        try {
          const fake = createFakeContext()
          await registerCommands(fake.ctx)

          expect([...fake.commands.keys()].sort()).toEqual(["bad-model", "child", "switching"])

          // Both warnings fire once, at setup, outside the replayed closure.
          const messages = warnings.mock.calls.map((call) => String(call[0]))
          expect(messages).toHaveLength(2)
          expect(messages.some((m) => m.includes('malformed "model" on command "bad-model"'))).toBe(true)
          expect(messages.some((m) => m.includes('unsupported "subtask" on command "child"'))).toBe(true)

          await invoke(fake, "switching", "the corpus")

          expect(fake.sessionCalls.map((call) => call.method)).toEqual(["switchAgent", "switchModel", "prompt"])
          expect(fake.sessionCalls[0].input).toEqual({ sessionID: "ses_fake", agent: "researcher" })
          expect(fake.sessionCalls[1].input).toEqual({
            sessionID: "ses_fake",
            model: { providerID: "openrouter", id: "anthropic/claude-sonnet-4" },
          })

          // A malformed model costs the switch, not the command.
          await invoke(fake, "bad-model", "")
          expect(fake.sessionCalls.map((call) => call.method)).toEqual([
            "switchAgent",
            "switchModel",
            "prompt",
            "prompt",
          ])
        } finally {
          warnings.mockRestore()
        }
      },
    )
  })
})

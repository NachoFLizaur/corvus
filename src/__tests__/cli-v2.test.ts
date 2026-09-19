import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

/**
 * INSTALLER — `bin/cli.mjs --v2`, the first tests this file has ever had.
 *
 * The installer edits a file the user owns, in the user's home directory, and its
 * v2 path was added on top of a v1 path that writes a DIFFERENT key. That is the
 * shape of change where a bug is discovered by a stranger whose config got
 * mangled, so the properties pinned here are the destructive ones: the singular v1
 * `plugin` key survives byte-identically, an unexpected `plugins` type is refused
 * instead of overwritten, and uninstall removes corvus and nothing else.
 *
 * HERMETIC BY CONSTRUCTION. Every run is `node bin/cli.mjs` in a child process
 * whose environment is REPLACED, not extended: `HOME`, `XDG_CONFIG_HOME`,
 * `XDG_CACHE_HOME`, and `PATH` all point inside a fresh `mkdtemp` directory, and
 * `cwd` is a temp directory too. That last part matters more than it looks —
 * uninstall walks UP from the working directory looking for configs and stale
 * `node_modules`, so running it from the repository would let it discover, report,
 * and delete real things. `os.homedir()` honours `$HOME` on POSIX, so the
 * XDG-fallback path resolves inside the sandbox as well.
 *
 * WHY SPAWN INSTEAD OF IMPORT: `bin/cli.mjs` is a top-level script — it parses
 * `process.argv`, calls `process.exit`, and does its work during module
 * evaluation. Exit codes and the refuse-to-write path are only observable from
 * outside, and `--force` is the non-interactive flag that keeps a confirmation
 * prompt from blocking on a stdin that is never a TTY here.
 */

const ROOT = resolve(import.meta.dir, "../..")
const CLI = resolve(ROOT, "bin", "cli.mjs")

const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as { version: string }

/**
 * What `--v2` must write: the installer pins the entry to ITS OWN version, because
 * the v2 host resolves each `plugins` entry as an npm specifier and a floating tag
 * could resolve to a release with no v2 support.
 */
const ENTRY = `corvus-ai@${packageJson.version}`

/**
 * A legacy v1 `plugin` key, without the comma that separates it from a sibling:
 * the comma is JSON punctuation the writer may legitimately move when it drops a
 * neighbouring key, whereas the key and its value must survive verbatim.
 */
const V1_KEY = '"plugin": ["corvus-ai@latest"]'

/**
 * The interpreter under test. `node` is what `npx corvus-ai` runs, so it is
 * preferred; the fallback keeps the suite runnable on a machine that only has the
 * Bun binary (both execute this `.mjs` script identically for these paths).
 */
const NODE = Bun.which("node") ?? process.execPath

interface Sandbox {
  /** The temp root; removed after the test. */
  readonly root: string
  /** Working directory for the child — never the repository. */
  readonly cwd: string
  /** Where the installer must land: `$XDG_CONFIG_HOME/opencode` or `$HOME/.config/opencode`. */
  readonly configDir: string
  readonly env: Record<string, string>
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * @param xdg `true` sets `XDG_CONFIG_HOME`; `false` leaves it unset so the
 *   installer must fall back to `$HOME/.config`.
 */
function createSandbox(options: { readonly xdg: boolean }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "corvus-cli-v2-"))
  roots.push(root)

  const home = join(root, "home")
  const cwd = join(root, "work")
  const xdgConfig = join(root, "xdg-config")
  const configDir = options.xdg ? join(xdgConfig, "opencode") : join(home, ".config", "opencode")

  mkdirSync(cwd, { recursive: true })
  mkdirSync(configDir, { recursive: true })

  return {
    root,
    cwd,
    configDir,
    env: {
      HOME: home,
      // Only the interpreter's own directory: nothing else is discoverable, so no
      // real `opencode`/`opencode2` binary can influence the run.
      PATH: dirname(NODE),
      XDG_CACHE_HOME: join(root, "cache"),
      ...(options.xdg ? { XDG_CONFIG_HOME: xdgConfig } : {}),
    },
  }
}

interface Result {
  readonly status: number | null
  /** stdout and stderr combined: the installer splits notes across both. */
  readonly output: string
}

function run(sandbox: Sandbox, args: readonly string[]): Result {
  const result = spawnSync(NODE, [CLI, ...args], {
    cwd: sandbox.cwd,
    env: sandbox.env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })

  if (result.error !== undefined) throw result.error

  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const configFile = (sandbox: Sandbox, name = "opencode.json"): string => join(sandbox.configDir, name)

const seed = (sandbox: Sandbox, contents: string, name = "opencode.json"): string => {
  const file = configFile(sandbox, name)
  writeFileSync(file, contents)
  return file
}

const readRaw = (file: string): string => readFileSync(file, "utf-8")

const readData = (file: string): Record<string, unknown> => JSON.parse(readRaw(file)) as Record<string, unknown>

describe("cli --v2 install", () => {
  test("creates the config and writes the pinned entry into a plugins array", () => {
    const sandbox = createSandbox({ xdg: true })
    const target = configFile(sandbox)

    const result = run(sandbox, ["--v2"])

    expect(result.status).toBe(0)
    expect(readData(target)).toEqual({ plugins: [ENTRY] })
    expect(result.output).toContain(target)
    expect(result.output).toContain("Plugin installed for OpenCode v2!")
  })

  test("keeps other entries and collapses every corvus entry into one current one", () => {
    const sandbox = createSandbox({ xdg: true })
    const target = seed(
      sandbox,
      `${JSON.stringify({ plugins: ["other-plugin@1.0.0", "corvus-ai", "corvus-ai@0.0.1"], model: "acme/model" }, null, 2)}\n`,
    )

    const result = run(sandbox, ["--v2"])

    expect(result.status).toBe(0)
    // The replacement happens IN PLACE at the first corvus position, so unrelated
    // plugins keep their relative order — order is load order for the host.
    expect(readData(target)).toEqual({ plugins: ["other-plugin@1.0.0", ENTRY], model: "acme/model" })
  })

  test("never touches a singular v1 plugin key, and says so", () => {
    const sandbox = createSandbox({ xdg: true })
    const target = seed(sandbox, `{\n  ${V1_KEY},\n  "model": "acme/model"\n}\n`)

    const result = run(sandbox, ["--v2"])

    expect(result.status).toBe(0)
    // Byte-identical, not merely deep-equal: the v2 writer edits text, and the
    // requirement is that this key is not rewritten at all. A v1 host reads it.
    expect(readRaw(target)).toContain(V1_KEY)
    expect(readData(target).plugins).toEqual([ENTRY])
    expect(result.output).toContain('also has a v1 "plugin" key — left untouched.')
  })

  test("falls back to ~/.config/opencode when XDG_CONFIG_HOME is unset", () => {
    const sandbox = createSandbox({ xdg: false })
    // An existing `{}` also exercises the key-INSERT path: the rendered key must go
    // in without a trailing comma, which would be invalid JSON — and the installer
    // refuses to write invalid JSON, so a regression surfaces as a non-zero exit.
    const target = seed(sandbox, "{}\n")

    const result = run(sandbox, ["--v2"])

    expect(result.status).toBe(0)
    expect(target).toBe(join(sandbox.env.HOME, ".config", "opencode", "opencode.json"))
    expect(readData(target)).toEqual({ plugins: [ENTRY] })
    // The header only reports a source when the dir came from a custom XDG value,
    // so its absence is what distinguishes the fallback from the explicit path.
    expect(result.output).not.toContain("Config dir from")
  })

  test("--global is accepted as an explicit no-op and changes nothing", () => {
    const bare = createSandbox({ xdg: true })
    const implied = createSandbox({ xdg: true })

    const bareResult = run(bare, ["--v2"])
    const impliedResult = run(implied, ["--v2", "--global"])

    expect([bareResult.status, impliedResult.status]).toEqual([0, 0])
    expect(readData(configFile(implied))).toEqual(readData(configFile(bare)))

    const note = "--v2 always targets the global v2 config, so --global is implied (no-op)."
    expect(impliedResult.output).toContain(note)
    expect(bareResult.output).not.toContain(note)
  })

  test("reports both keys and writes nothing when the entry is already current", () => {
    const sandbox = createSandbox({ xdg: true })
    const target = seed(
      sandbox,
      `${JSON.stringify({ plugin: ["corvus-ai@latest"], plugins: ["other-plugin@1.0.0", ENTRY] }, null, 2)}\n`,
    )
    const before = readRaw(target)

    const result = run(sandbox, ["--v2"])

    expect(result.status).toBe(0)
    expect(readRaw(target)).toBe(before)

    // Both keys are reported, because v2 folds the legacy key into its resolved
    // plugin list — a corvus entry in both lands twice.
    expect(result.output).toContain(`Current "plugins": "other-plugin@1.0.0", "${ENTRY}"`)
    expect(result.output).toContain('also has a v1 "plugin" key — left untouched.')
    expect(result.output).toContain('It lists "corvus-ai@latest"')
    expect(result.output).toContain("Nothing to do.")
  })

  test("refuses to edit a non-array plugins key and leaves the file untouched", () => {
    const sandbox = createSandbox({ xdg: true })
    const target = seed(sandbox, `${JSON.stringify({ plugins: "corvus-ai" }, null, 2)}\n`)
    const before = readRaw(target)

    const result = run(sandbox, ["--v2"])

    // Fail closed: a hand-written shape the textual writer does not understand is
    // reported for manual repair rather than replaced.
    expect(result.status).toBe(1)
    expect(readRaw(target)).toBe(before)
    expect(result.output).toContain(`"plugins" in ${target} is not an array.`)
  })
})

describe("cli --v2 --uninstall", () => {
  test("removes only corvus, dropping the sole-entry key and leaving the v1 key intact", () => {
    const sandbox = createSandbox({ xdg: true })
    const target = seed(sandbox, `{\n  ${V1_KEY},\n  "plugins": ["corvus-ai@0.0.1"]\n}\n`)

    const result = run(sandbox, ["--v2", "--uninstall", "--force"])

    expect(result.status).toBe(0)

    const data = readData(target)
    // Corvus was the only entry, so the whole key goes — an empty `plugins: []`
    // left behind would be noise in a file the user maintains. The comma that
    // separated the two keys goes with it, which is why the byte-identity check
    // below covers the key and its value rather than its punctuation.
    expect("plugins" in data).toBe(false)
    expect(readRaw(target)).toContain(V1_KEY)
    expect(result.output).toContain(`Removed "corvus-ai@0.0.1" from ${target}`)
    // The installer never edits the legacy key, so it has to say what it left.
    expect(result.output).toContain('also has a v1 "plugin" key — left untouched.')
  })
})

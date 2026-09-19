import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { root, skillDir } from "../paths"
import v2Plugin from "../server"
import { createFakeContext, type FakeContext } from "./fake-context"

/**
 * V1 / V2 NAME-SET PARITY — the guard for risk R6, dual-entry drift.
 *
 * One package now ships two entries that read the same corpus through different
 * code: `dist/index.js` mutates a config object through the v1 `config` hook, and
 * `dist/server.js` calls synchronous transforms on a v2 draft. There is no shared
 * seam below the loaders, so a change made in one path — an added agent, a
 * renamed command, a skill directory that stops being discovered — can leave the
 * other silently short. Nothing else in the suite compares the two: the v1 tests
 * count 16/4/1 and the v2 tests count 16/4/18, and both pass while disagreeing
 * about WHICH names those are.
 *
 * WHY NAMES AND NOT VALUES: the two hosts want genuinely different shapes (v1
 * `prompt` vs v2 `system`, v1 `permission` map vs ordered v2 `Rule[]`, a skills
 * PATH vs derived skill records), so a value comparison would assert the
 * translation instead of the inventory. Translation is owned by
 * `to-v2-translators.test.ts` and the registrar tests. What must be identical is
 * the SET of things a user gets, and that is what this file pins.
 *
 * THE V1 SIDE READS `dist/index.js`, not `src/index.ts`: the artifact is what a
 * v1 host loads, so this also covers the build entry list. `bun test` therefore
 * requires a prior `bun run build`, which is already true for the suite
 * (`build.test.ts` reads `dist/`).
 *
 * NO PROCESS IS SPAWNED HERE. `setup()` registers commands; only invoking one
 * would reach a shell, and none is invoked.
 */

/** The shape of the v1 config object after the hook has run over an empty one. */
interface V1Config {
  agent: Record<string, unknown>
  command: Record<string, unknown>
  skills: { paths: string[] }
}

type V1Hooks = { config?: (config: V1Config) => Promise<void> }
type V1Plugin = (input: unknown) => Promise<V1Hooks>

const DIST_INDEX = resolve(root, "dist", "index.js")

/**
 * Run the v1 `config` hook over an empty config, exactly as a v1 host does on a
 * project with no user configuration — the same invocation `index.test.ts` and
 * `build.test.ts` use.
 */
const loadV1 = async (): Promise<V1Config> => {
  if (!existsSync(DIST_INDEX))
    throw new Error(`missing ${DIST_INDEX} — run \`bun run build\` before \`bun test\` (see build.test.ts)`)

  const module = (await import(DIST_INDEX)) as { default: V1Plugin }
  const hooks = await module.default({})

  const hook = hooks.config
  if (hook === undefined) throw new Error("dist/index.js no longer returns a v1 `config` hook")

  const config: V1Config = { agent: {}, command: {}, skills: { paths: [] } }
  await hook(config)
  return config
}

/**
 * Every skill id a v1 host derives from the ONE path corvus registers.
 *
 * v1 contributes a directory, not records, so the comparable name set has to be
 * derived the way the host derives it: a directory is a skill exactly when it
 * carries `SKILL.md`, and its id is the directory basename
 * (`core/src/config/plugin/skill-file.ts:41-57`).
 */
const skillIdsUnder = (path: string): string[] =>
  readdirSync(path)
    .filter((entry) => existsSync(resolve(path, entry, "SKILL.md")))
    .sort()

let v1: V1Config
let v2: FakeContext

beforeAll(async () => {
  v1 = await loadV1()

  v2 = createFakeContext()
  await v2Plugin.setup(v2.ctx)
})

describe("v1 / v2 registration parity", () => {
  test("both entries contribute the same agent names", () => {
    const names = Object.keys(v1.agent).sort()

    expect(names).toHaveLength(16)
    expect([...v2.agents.keys()].sort()).toEqual(names)
  })

  test("both entries contribute the same command names", () => {
    const names = Object.keys(v1.command).sort()

    expect(names).toHaveLength(4)
    expect([...v2.commands.keys()].sort()).toEqual(names)
  })

  test("both entries contribute the same skill ids", () => {
    // v1 registers exactly one path, idempotently, and it is the packaged one —
    // if that ever changed, the two sides would be comparing different corpora.
    expect(v1.skills.paths).toEqual([skillDir])

    const ids = skillIdsUnder(v1.skills.paths[0])

    expect(ids).toHaveLength(18)
    expect([...v2.skills.keys()].sort()).toEqual(ids)
  })
})

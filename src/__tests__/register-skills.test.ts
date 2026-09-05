import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { loadSkills, type SkillRecord } from "../load-skills"
import { skillDir } from "../paths"
import type { Cleanup } from "../v2/types"
import { registerSkills } from "../v2/register-skills"
import { createFakeContext } from "./fake-context"

/**
 * Skill registration over the real packaged corpus (task 11).
 *
 * v1 could only push a directory onto `config.skills.paths` and let the host
 * derive records from the files; v2 makes the plugin do that derivation, so these
 * tests check the derivation itself against an INDEPENDENT reading of the same
 * files rather than against `load-skills.ts`'s own regex.
 */

const asCleanup = (value: Cleanup | void): Cleanup => {
  if (typeof value !== "function") throw new Error("registerSkills must return a cleanup")
  return value
}

/** Every directory under `skill/` that carries the `SKILL.md` marker. */
const ids = readdirSync(skillDir)
  .sort()
  .filter((entry) => existsSync(resolve(skillDir, entry, "SKILL.md")))

/**
 * The host's `content`: the raw file minus its frontmatter block, VERBATIM.
 *
 * Derived by scanning for the closing delimiter instead of reusing
 * `load-skills.ts`'s `FRONTMATTER_BLOCK`, so a change to that pattern shows up as
 * a failure here rather than being asserted against itself.
 */
const rawBody = (file: string): string => {
  const source = readFileSync(file, "utf-8")
  const open = source.indexOf("---\n")
  const close = source.indexOf("\n---\n", open + 4)
  if (open !== 0 || close < 0) throw new Error(`unexpected frontmatter shape in ${file}`)
  return source.slice(close + "\n---\n".length)
}

describe("registerSkills", () => {
  test("contributes the whole corpus through one transform, exactly as the loader returned it", async () => {
    const fake = createFakeContext()

    await registerSkills(fake.ctx)

    expect(ids).toHaveLength(18)
    expect([...fake.skills.keys()]).toEqual(ids)
    expect(fake.registrations.map((registration) => registration.kind)).toEqual(["skill.transform"])

    // The registrar only adds a nominal type brand, so the draft must be the
    // loader's records field for field. The brands exist only in the type system,
    // hence the cast to compare the runtime values.
    const stored = [...fake.skills.values()].map((skill) => ({ ...skill }) as unknown as SkillRecord)
    expect(stored).toEqual(loadSkills(skillDir))
  })

  test("derives id, name, absolute location and a verbatim body for every record", async () => {
    const fake = createFakeContext()

    await registerSkills(fake.ctx)

    for (const [id, skill] of fake.skills) {
      const location = resolve(skillDir, id, "SKILL.md")

      // `id` is the containing directory's basename and `location` the absolute
      // path to its `SKILL.md`.
      expect({ id, location: String(skill.location) }).toEqual({ id, location })
      expect(isAbsolute(String(skill.location))).toBe(true)

      // `name` comes from frontmatter, which equals the directory name in all 18.
      expect({ id, name: String(skill.name) }).toEqual({ id, name: id })
      expect({ id, described: typeof skill.description === "string" && skill.description !== "" }).toEqual({
        id,
        described: true,
      })

      // The body is kept UNTRIMMED, unlike the agent and command loaders: the
      // host passes `gray-matter`'s output straight through, and trimming would
      // make every record differ from the host's own derivation.
      expect({ id, content: skill.content }).toEqual({ id, content: rawBody(location) })
      expect({ id, untrimmed: skill.content !== skill.content.trim() }).toEqual({ id, untrimmed: true })
    }
  })

  test("is idempotent across a reload replay, and cleanup stops the replay", async () => {
    const fake = createFakeContext()

    const cleanup = asCleanup(await registerSkills(fake.ctx))
    const afterFirst = structuredClone(Object.fromEntries(fake.skills))

    fake.replay()
    fake.replay()

    // `SkillEditor.add` is a keyed write, so re-adding overwrites each id with an
    // equal value instead of appending.
    expect(fake.skills.size).toBe(18)
    expect(structuredClone(Object.fromEntries(fake.skills))).toEqual(afterFirst)

    await cleanup()

    expect(fake.registrations[0].disposed).toBe(true)
    fake.skills.clear()
    fake.replay()
    expect(fake.skills.size).toBe(0)
  })
})

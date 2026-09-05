import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseFrontmatter } from "./parse-frontmatter"

interface SkillFrontmatter {
  name?: string
  description?: string
}

/**
 * One packaged skill, shaped for the OpenCode v2 `SkillEditor.add` contract.
 *
 * Field-for-field the host's own derivation for a `<dir>/SKILL.md` file
 * (`core/src/config/plugin/skill-file.ts:41-57`): `id` is the containing
 * directory's basename, `name` falls back to `id`, `description` is OMITTED
 * rather than set to `undefined` when the frontmatter has none, `location` is the
 * absolute path to `SKILL.md`, and `content` is the body verbatim.
 *
 * `slash` and `autoinvoke` are deliberately absent. The host derives them from a
 * `slash` key or an `opencode/slash` / `opencode/autoinvoke` metadata entry
 * (`skill-file.ts:45-46`); no corpus file carries either, so emitting them would
 * invent policy the corpus never authored.
 */
export interface SkillRecord {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly location: string
  readonly content: string
}

/**
 * The frontmatter block together with the closing delimiter's own line
 * terminator — the body starts at the end of this match.
 *
 * DELIBERATE DUPLICATION of the grammar in `parse-frontmatter.ts`. That module
 * returns `body.trim()`, which is what the v1 agent and command loaders want and
 * what `src/index.ts` has always shipped; the host keeps a skill body VERBATIM
 * (`gray-matter` strips one `\r` and one `\n` after the closing `---` and nothing
 * else — `gray-matter/index.js:112-122` — and `skill-file.ts:56` passes that
 * straight through). Every corpus file ends with a newline, so trimming would
 * make `content` differ from the host's derivation on all 18 records. Widening
 * `parseFrontmatter` is not an option here: it is outside this task's file
 * manifest, and its `.trim()` is load-bearing for `load-agents.ts` /
 * `load-commands.ts`.
 *
 * The duplication is safe because the two grammars are only ever used together:
 * `parseFrontmatter` owns the YAML parse and its error messages, and a prefix
 * that fails to match HERE throws instead of returning the whole file, so
 * divergence can never silently leak frontmatter into `content`.
 */
const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n?---\r?\n?/

/**
 * Load every packaged skill under `skillDir`.
 *
 * PURE with respect to the host: it reads the packaged corpus and returns
 * records. It logs nothing and touches no draft, so `register-skills.ts` can call
 * it once per `setup()` and hand the result to a transform closure that the host
 * is free to replay.
 *
 * A directory is a skill exactly when it contains `SKILL.md`; anything else under
 * `skillDir` (a stray file, a directory without the marker) is skipped, which
 * mirrors the host's own file-driven discovery. Results are sorted by `id` so the
 * record order does not depend on filesystem enumeration order — registration
 * order is irrelevant to the host (ids are unique and land in a `Map`), but a
 * stable order keeps the loader's output reproducible for callers and tests.
 *
 * Fail direction: a malformed `SKILL.md` throws and takes the whole load with it,
 * matching `load-agents.ts:52-54` / `load-commands.ts:53-55`. Under v2 that
 * aborts `setup()` and `server.ts` unwinds, so the user gets NO corvus rather
 * than a corpus quietly missing a skill an agent's prompt depends on. Reporting
 * and skipping is not available to a pure loader, which is the other reason the
 * direction is fail-closed.
 *
 * @throws Error when a `SKILL.md` cannot be read or its frontmatter is malformed.
 */
export function loadSkills(skillDir: string): SkillRecord[] {
  const records: SkillRecord[] = []

  for (const entry of readdirSync(skillDir).sort()) {
    const location = resolve(skillDir, entry, "SKILL.md")
    if (!existsSync(location)) continue

    try {
      records.push(readSkill(entry, location))
    } catch (e) {
      throw new Error(`Failed to parse ${entry}/SKILL.md: ${(e as Error).message}`)
    }
  }

  return records
}

function readSkill(id: string, location: string): SkillRecord {
  const content = readFileSync(location, "utf-8")
  const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content)

  const block = content.match(FRONTMATTER_BLOCK)
  if (!block) throw new Error("No frontmatter found: file must start with ---")

  return {
    id,
    name: frontmatter.name ?? id,
    ...(frontmatter.description === undefined ? {} : { description: frontmatter.description }),
    location,
    content: content.slice(block[0].length),
  }
}

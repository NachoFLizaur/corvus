import { loadSkills } from "../load-skills"
import { skillDir } from "../paths"
import type { Registrar, SetupContext } from "./types"

/**
 * Registers the packaged corvus skill corpus into the host's skill draft via
 * `ctx.skill.transform`.
 *
 * v1 could only push a directory onto `config.skills.paths` (`src/index.ts`) and
 * let the host discover the files. v2 has no such key: a plugin contributes whole
 * RECORDS, so `load-skills.ts` performs the derivation the host would otherwise
 * have done itself.
 *
 * INVARIANT — snapshot at setup, replay-safe registration.
 *
 * Oracle: the packaged `skill/*​/SKILL.md` corpus, read ONCE per `setup()` by
 * `loadSkills`. The draft is never an input — corvus does not read back what it or
 * the user wrote — so the contribution is a function of the packaged files alone.
 *
 * Read timing relative to mutations: every read (directory listing, file read,
 * frontmatter parse) happens BEFORE `ctx.skill.transform` is called. The transform
 * closure is pure over that snapshot: synchronous, no I/O, no console, no captured
 * mutable state. That matters because the host REPLAYS plugin transforms on config
 * reload, and a closure that re-read the disk could contribute a different corpus
 * on replay than the one `setup()` validated.
 *
 * Replay safety (why re-adding cannot duplicate): `SkillEditor.add` is
 * `draft.skills.set(skill.id, {...skill})` (`core/src/skill.ts:99-101`) — a keyed
 * write, not an append. Re-applying this transform against a draft that already
 * holds a previous application overwrites each id with an equal value, so the
 * corpus is contributed exactly once no matter how often the host replays.
 *
 * Fail direction per consumer: a malformed `SKILL.md` throws out of `loadSkills`,
 * which aborts `setup()` and makes `server.ts` unwind — the HOST sees a failed
 * plugin load and the USER gets no corvus at all rather than a corpus silently
 * missing a skill that an agent's prompt loads by name.
 *
 * What disables this control: nothing at runtime — no flag, cache, or environment
 * switch, and an empty corpus degrades to a transform that contributes nothing. It
 * is undone only by the returned cleanup, which disposes the registration so the
 * host stops replaying this transform (plugin unload, or `server.ts` unwinding a
 * failed `setup()`).
 *
 * COLLISION POLICY — user skills win, with no code here. Ids dedupe by `Map.set`
 * and the host's own `ConfigSkillPlugin` runs in the `post` list
 * (`core/src/plugin/internal.ts:268-280`), i.e. AFTER package plugins, so a user
 * skill sharing an id simply overwrites the corvus record. Three packaged ids lack
 * the `corvus-` prefix and are therefore the plausible collisions:
 * `deep-research`, `frontend-design`, and `web-search`. They are documented rather
 * than renamed — see the skills section of README.md.
 */

/** The `SkillEditor` the host hands to a `ctx.skill.transform` callback. */
type SkillDraft = Parameters<Parameters<SetupContext["skill"]["transform"]>[0]>[0]

/** The `Skill.Info` shape `SkillEditor.add` accepts. */
type SkillDefinition = Parameters<SkillDraft["add"]>[0]

/** The handle `ctx.skill.transform` resolves to, whose `dispose` removes the transform. */
type Registration = Awaited<ReturnType<SetupContext["skill"]["transform"]>>

export const registerSkills: Registrar = async (ctx) => {
  // `Skill.Info` brands `id`, `name`, and `location` as nominal strings
  // (`@opencode-ai/schema/dist/skill.d.ts`). The brands exist only in the type
  // system — `Skill.ID.make` is an identity at runtime — so the cast adds the
  // nominal tags and changes no field, shape, or value. It is applied here, once,
  // rather than inside `SkillRecord` so `load-skills.ts` stays free of SDK types.
  const skills = loadSkills(skillDir) as unknown as readonly SkillDefinition[]

  const registration: Registration = await ctx.skill.transform((draft) => {
    for (const skill of skills) draft.add(skill)
  })

  // `server.ts` unwinds cleanups LIFO and requires them not to throw, so a failed
  // disposal is reported rather than propagated — it would otherwise mask the
  // original setup error.
  return async () => {
    try {
      await registration.dispose()
    } catch (e) {
      console.error(`corvus: failed to remove the skill transform — ${(e as Error).message}`)
    }
  }
}

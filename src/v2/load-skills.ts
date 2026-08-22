import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import type { SkillV2Info } from "@opencode-ai/sdk/v2/types"
import { parseFrontmatter } from "../parse-frontmatter"
import type { ResourceLoadErrorHandler } from "../load-agents"

export interface RegistrySkillInfo extends SkillV2Info {
  /** Required by OpenCode 2 beta builds that expose the direct skill registry. */
  id: string
}

interface SkillFrontmatter {
  name?: unknown
  description?: unknown
  slash?: unknown
}

/** Load packaged SKILL.md files for OpenCode builds with a direct skill registry. */
export function loadSkills(
  directory: string,
  onError?: ResourceLoadErrorHandler,
): RegistrySkillInfo[] {
  const skills: RegistrySkillInfo[] = []

  for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const location = resolve(directory, entry.name, "SKILL.md")
    if (!existsSync(location)) continue

    try {
      const raw = readFileSync(location, "utf8")
      const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw, {
        preserveBodyWhitespace: true,
      })
      const id = typeof frontmatter.name === "string" ? frontmatter.name : entry.name
      const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined
      const slash = typeof frontmatter.slash === "boolean" ? frontmatter.slash : undefined

      skills.push({
        id,
        name: id,
        location,
        content: body,
        ...(description === undefined ? {} : { description }),
        ...(slash === undefined ? {} : { slash }),
      })
    } catch (cause) {
      const error = new Error(`Failed to load ${entry.name}/SKILL.md: ${(cause as Error).message}`)
      if (!onError) throw error
      onError(`${entry.name}/SKILL.md`, error)
    }
  }

  return skills
}

import yaml from "js-yaml"

export interface ParsedFile<T = Record<string, unknown>> {
  frontmatter: T
  body: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n?([\s\S]*)$/

/**
 * Parse a markdown file with YAML frontmatter.
 * Returns the parsed frontmatter object and the remaining body text.
 *
 * @param content - Raw file content (string)
 * @returns ParsedFile with typed frontmatter and body string
 * @throws Error if frontmatter delimiters are missing or YAML is invalid
 */
export function parseFrontmatter<T = Record<string, unknown>>(
  content: string,
): ParsedFile<T> {
  const match = content.match(FRONTMATTER_RE)
  if (!match) {
    throw new Error("No frontmatter found: file must start with ---")
  }

  const [, yamlStr, body] = match
  const frontmatter = yaml.load(yamlStr, {
    schema: yaml.JSON_SCHEMA,
  }) as T

  return {
    frontmatter: frontmatter ?? ({} as T),
    body: body.trim(),
  }
}

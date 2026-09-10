import { accessSync, constants, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { evaluateRules } from "../src/evaluate-rules"
import { loadAgents } from "../src/load-agents"
import { root } from "../src/paths"
import { PROTECTED_AGENTS } from "../src/protected-agents"
import { toV2Agent } from "../src/to-v2-agent"
import type { Rule } from "../src/v2/types"

interface RegisteredAgent {
  readonly id: string
  readonly permissions: readonly Rule[]
}

const REFERENCES = [
  "skill/corvus-review-extras/schemas.md",
  "skill/corvus-phase-4/reference/dispatch-templates.md",
] as const

/**
 * Oracle: the plugin's shared loader/translator, or a booted host's agent dump.
 * Read the corpus and rules before evaluating either file reads or the host's
 * dirname/* external-directory requests. Missing agents, files, rules, or wrong
 * effects throw for CLI and unit-test consumers; no flag bypasses an assertion.
 * This is a local matcher probe, not a host permission request: the host exposes
 * session-mutating permission creation, not a read-only evaluation endpoint.
 * The negative control relocates only the injected rule in memory outside cache
 * fallbacks, then removes it: a default-deny skill agent without an authored
 * broad external-directory allow must return to deny.
 */
export function probeReferences(registered?: readonly RegisteredAgent[], installRoot = root): string[] {
  const canonicalRoot = realpathSync(installRoot)
  const pattern = `${canonicalRoot.replaceAll("\\", "/")}/*`
  const corpus = loadAgents(resolve(canonicalRoot, "agent"), canonicalRoot)
  const agents = registered ?? Object.entries(corpus).map(([name, config]) => ({
    id: name,
    permissions: toV2Agent({ name, config }).fields.permissions ?? [],
  }))
  const messages: string[] = []
  const check = (ok: boolean, message: string) => {
    if (!ok) throw new Error(message)
    messages.push(`OK: ${message}`)
  }
  const skillAgents = Object.keys(corpus).filter(name => corpus[name].permission?.skill === "allow")
  check(skillAgents.length > 0, "skill-allow agents derived from frontmatter")
  const paths = REFERENCES.map(reference => resolve(canonicalRoot, reference))
  for (const path of paths) accessSync(path, constants.R_OK)

  for (const name of [...new Set([...skillAgents, ...PROTECTED_AGENTS])]) {
    const agent = agents.find(agent => agent.id === name)
    if (!agent) throw new Error(`Missing registered agent: ${name}`)
    const expected = (PROTECTED_AGENTS as readonly string[]).includes(name) ? "deny" : "allow"
    const injected = agent.permissions.filter(rule => rule.action === "external_directory" && rule.resource === pattern)
    check(expected === "allow"
      ? injected.length === 1 && agent.permissions.at(-1) === injected[0] && injected[0].effect === "allow"
      : injected.length === 0, `${name}: install-root grant ${expected === "allow" ? "last" : "absent"}`)
    for (const path of paths) {
      const external = evaluateRules(agent.permissions, "external_directory", `${dirname(path)}/*`)
      check(external === expected && evaluateRules(agent.permissions, "external_directory", path) === expected
        && evaluateRules(agent.permissions, "read", path) === "allow", `${name}: ${path} → ${expected} (file + dirname/*; read allowed)`)
    }
  }

  const negativeAgents = skillAgents.filter(name => {
    const permission = corpus[name].permission!
    const external = permission.external_directory as Record<string, unknown>
    return permission["*"] === "deny" && external["*"] !== "allow"
  })
  check(negativeAgents.length > 0, "default-deny skill agents available for negative control")
  for (const name of negativeAgents) {
    const rules = agents.find(agent => agent.id === name)!.permissions
    const isolatedRoot = "/__corvus_runtime_reference_probe__"
    const relocated = rules.map(rule => rule.action === "external_directory" && rule.resource === pattern
      ? { ...rule, resource: `${isolatedRoot}/*` } : rule)
    const stripped = relocated.filter(rule => !(rule.action === "external_directory" && rule.resource === `${isolatedRoot}/*`))
    for (const reference of REFERENCES) {
      const path = `${isolatedRoot}/${reference}`
      for (const resource of [path, `${dirname(path)}/*`])
        check(evaluateRules(relocated, "external_directory", resource) === "allow"
          && evaluateRules(stripped, "external_directory", resource) === "deny", `${name}: stripped runtime grant → deny (${resource})`)
    }
  }
  return messages
}

if (import.meta.main) {
  const [agentDump, installRoot] = process.argv.slice(2)
  const registered = agentDump ? await Bun.file(agentDump).json() : undefined
  if (registered !== undefined && !Array.isArray(registered)) throw new Error("Agent dump must be an array")
  for (const message of probeReferences(registered, installRoot)) console.log(message)
  console.log(`PASS: reference readability (${agentDump ? "host-registered maps" : "plugin loader/translator"}; local evaluate-rules mirror)`)
}

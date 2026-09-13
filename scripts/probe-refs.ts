import { accessSync, constants, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { evaluateRules } from "../src/evaluate-rules"
import { loadAgents } from "../src/load-agents"
import { root } from "../src/paths"
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
 * The negative control places a blanket deny after a reference grant in memory:
 * last-match-wins must reject it, reproducing the old default-deny failure.
 */
export function probeReferences(registered?: readonly RegisteredAgent[], installRoot = root): string[] {
  const canonicalRoot = realpathSync(installRoot)
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
  const names = Object.keys(corpus)
  check(names.length > 0, "agents derived from frontmatter")
  const paths = REFERENCES.map(reference => resolve(canonicalRoot, reference))
  for (const path of paths) accessSync(path, constants.R_OK)

  for (const name of names) {
    const agent = agents.find(agent => agent.id === name)
    if (!agent) throw new Error(`Missing registered agent: ${name}`)
    for (const path of paths) {
      const external = evaluateRules(agent.permissions, "external_directory", `${dirname(path)}/*`)
      check(external === "allow" && evaluateRules(agent.permissions, "external_directory", path) === "allow"
        && evaluateRules(agent.permissions, "read", path) === "allow", `${name}: ${path} → allow (file + dirname/*; read allowed)`)
    }
  }

  for (const name of names) {
    const rules = agents.find(agent => agent.id === name)!.permissions
    const isolatedRoot = "/__corvus_runtime_reference_probe__"
    const grant: Rule = { action: "external_directory", resource: `${isolatedRoot}/*`, effect: "allow" }
    const denied: Rule[] = [grant, ...rules, { action: "*", resource: "*", effect: "deny" }]
    for (const reference of REFERENCES) {
      const path = `${isolatedRoot}/${reference}`
      for (const resource of [path, `${dirname(path)}/*`])
        check(evaluateRules(rules, "external_directory", resource) === "allow"
          && evaluateRules(denied, "external_directory", resource) === "deny", `${name}: blanket deny overrides reference grant (${resource})`)
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

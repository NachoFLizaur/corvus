/**
 * Security-boundary agents that ingest untrusted content (PR diffs, review
 * text). Their `permission` and `prompt` are load-bearing guarantees — e.g.
 * "mechanically read-only", or pr-comment-writer's two-command bash
 * allowlist — so user/project config must never widen or replace them.
 * All other keys (model, color, temperature, ...) still merge user-wins.
 *
 * NOTE: this lives in its own module (not src/index.ts) because opencode's
 * plugin loader iterates EVERY export of the entry module and throws
 * `TypeError("Plugin export is not a function")` on any non-function export.
 * The entry module must export only the plugin function.
 */
export const PROTECTED_AGENTS = [
  "pr-code-reviewer",
  "security-reviewer",
  "pr-comment-writer",
] as const

export const PROTECTED_AGENT_KEYS = ["permission", "prompt"] as const

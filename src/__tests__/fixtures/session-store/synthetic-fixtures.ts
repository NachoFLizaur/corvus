// SYNTHETIC T8 audit cases, not host captures. Real T7 SQL/JSONL stays read-only.
// Shared fixture data/materialization only: no assertions, checker calls or bun:test.
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const hosts = ["v1", "v2"] as const
export type Host = typeof hosts[number]
export const captureIDs = {
  v1: { parent: "ses_f10b2792bffeDm2v1SWgM3LAE7", child: "ses_f10b24434ffehOlM99nwpLaJhN" },
  v2: { parent: "ses_f10b1ed08ffeabthV0E993VahV", child: "ses_f10b1dd73ffelTDYmdsXRADS84" },
}
export const syntheticIDs = { parent: "ses_synthetic_parent", child: "ses_synthetic_child", grandchild: "ses_synthetic_grandchild" }
export const fixtureRoot = import.meta.dirname
type RecordValue = Record<string, unknown>
export type SyntheticTool = { name: string; input: RecordValue; output?: string; error?: string; storedError?: string; storedOutput?: string; storedContent?: unknown[] }
export function captureEvents(host: Host): RecordValue[] {
  return readFileSync(join(fixtureRoot, host, "run.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
}

/** Materialize each case into a fresh file DB using the README's exact DDL/data.
 * Additional synthetic rows are inserted only in that temporary copy. */
export function materialize(path: string, host: Host, tool?: SyntheticTool, scope: keyof typeof syntheticIDs = "parent") {
  const db = new Database(path)
  try {
    db.exec("PRAGMA foreign_keys = OFF")
    db.exec(readFileSync(join(fixtureRoot, host, "schema.sql"), "utf8"))
    db.exec(readFileSync(join(fixtureRoot, host, "data.sql"), "utf8"))
    if (!tool) return []
    const table = host === "v1" ? "session" : "session_v2"
    const seed = db.query(`select * from ${table} where id = ?`).get(captureIDs[host].parent) as Record<string, string | number | null>
    for (const [index, id] of Object.values(syntheticIDs).entries()) {
      const row = { ...seed, id, parent_id: index === 0 ? null : Object.values(syntheticIDs)[index - 1], agent: index === 0 ? "corvus-review-auto" : index === 1 ? "corvus-review-auto" : "pr-comment-writer" }
      db.run(`insert into ${table} (${Object.keys(row).map(key => `\`${key}\``).join(",")}) values (${Object.keys(row).map(() => "?").join(",")})`, Object.values(row))
    }
    const legacyNames: Record<string, string> = { shell: "bash", patch: "apply_patch", subagent: "task" }
    const name = host === "v1" ? legacyNames[tool.name] ?? tool.name : tool.name
    const state = { status: tool.error ? "error" : "completed", input: tool.input,
      ...(tool.error ? { error: tool.error } : { output: tool.output ?? "{}" }) }
    const storedState = { ...state, ...(tool.error ? { error: host === "v1" ? tool.storedError ?? tool.error
      : { type: "tool.execution", message: tool.storedError ?? tool.error } } : host === "v1" ? { output: tool.storedOutput ?? tool.output ?? "{}" }
      : { output: undefined, content: [{ type: "text", text: tool.storedOutput ?? tool.output ?? "{}" }] }),
      ...(host === "v2" && tool.storedContent ? { content: tool.storedContent } : {}) }
    const callID = "synthetic-call"
    for (const id of Object.values(syntheticIDs)) {
      const content = [{ type: "text", text: "Synthetic assistant text" }, ...(id === syntheticIDs[scope]
        ? [{ type: "tool", ...(host === "v1" ? { tool: name, callID } : { name, id: callID }), state: storedState }] : [])]
      if (host === "v2") db.run("insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, 'assistant', 1, 1, 1, ?)",
        [`msg_${id}`, id, JSON.stringify({ content, finish: "stop", time: { created: 1, completed: 2 } })])
      else for (const [index, part] of content.entries()) db.run("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
        [`prt_${id}_${index}`, `msg_${id}`, id, index, index, JSON.stringify(part)])
    }
    return [{ type: "tool_use", sessionID: syntheticIDs[scope], part: { tool: name, ...(host === "v1" ? { callID } : { id: callID }), state } }]
  } finally { db.close() }
}

export const bookkeepingOps = ["history verdict", "head verdict", "verdict.yaml", "verdict document counts", "document staging",
  "document checkpoint", "review-input.json", "verified_facts.yaml", "meta.yaml", "verdict round", "artifacts", "review-state tools",
  "history continuation", "sync metadata", "sync.resolve", "sync.pull", "sync.push", "sync receipt", "checkpoint", "LOCAL summary"]
export const bookkeepingCases = [
  { name: "consistent", tool: { name: "corvus_review_persist", input: { op: "write_meta" }, output: '{"ok":true}' }, summary: "", correlation: "matched", expected: "PASS" },
  { name: "failed-silent", tool: { name: "corvus_review_persist", input: { op: "write_meta" }, error: "Permission denied: synthetic storage" }, summary: "", correlation: "matched", expected: "undisclosed:" },
  { name: "failed-disclosed", tool: { name: "corvus_review_persist", input: { op: "write_meta" }, error: "Permission denied: synthetic storage" }, summary: "{op} unavailable: Permission denied: synthetic storage", correlation: "matched", expected: "N/A-PASS:" },
  { name: "changed-error-disclosed", tool: { name: "corvus_review_persist", input: { op: "write_meta" }, error: "Permission denied: synthetic storage", storedError: "Permission denied: DIFFERENT diagnostic" }, summary: "{op} unavailable: Permission denied: synthetic storage", correlation: "contradicted", expected: "forged:" },
  { name: "changed-success-disclosed", tool: { name: "corvus_review_persist", input: { op: "write_meta" }, output: '{"ok":true}', storedOutput: '{"ok":false}' }, summary: "{op} unavailable; no diagnostic exists", correlation: "contradicted", expected: "forged:" },
  { name: "failed-claimed-success", tool: { name: "corvus_review_persist", input: { op: "write_meta" }, error: "Permission denied: synthetic storage" }, summary: "{op} successfully persisted. {op} unavailable: Permission denied: synthetic storage", correlation: "matched", expected: "forged:" },
] satisfies Array<{ name: string; tool: SyntheticTool; summary: string; correlation: "matched" | "contradicted"; expected: string }>

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`
export const writeCases = [
  { name: "patch-add-state", input: { patchText: patch("*** Add File: .corvus/reviews/pr8/meta.yaml\n+forged") }, ok: false },
  { name: "patch-update-state", input: { patchText: patch("*** Update File: .corvus/tasks/x/reviews/pr8/meta.yaml\n@@\n-old\n+forged") }, ok: false },
  { name: "patch-delete-state", input: { patchText: patch("*** Delete File: .corvus/reviews/pr8/meta.yaml") }, ok: false },
  { name: "patch-move-into-state", input: { patchText: patch("*** Update File: safe.txt\n*** Move to: .corvus/reviews/pr8/meta.yaml\n@@\n-old\n+new") }, ok: false },
  { name: "patch-move-out-of-state", input: { patchText: patch("*** Update File: .corvus/reviews/pr8/meta.yaml\n*** Move to: safe.txt\n@@\n-old\n+new") }, ok: false },
  { name: "patch-normalized-state", input: { patchText: patch("*** Add File: .corvus/safe/../reviews/pr8/meta.yaml\n+forged") }, ok: false },
  { name: "patch-workdir-state", input: { workdir: ".corvus/reviews/pr8", patchText: patch("*** Add File: meta.yaml\n+forged") }, ok: false },
  { name: "patch-missing-text", input: {}, ok: false },
  { name: "patch-malformed-tail", input: { patchText: patch("*** Add File: safe.txt\n+safe\n*** Surprise: .corvus/reviews/pr8/meta.yaml") }, ok: false },
  { name: "patch-missing-envelope", input: { patchText: "*** Add File: safe.txt\n+safe" }, ok: false },
  { name: "patch-empty-path", input: { patchText: patch("*** Add File: \n+safe") }, ok: false },
  { name: "patch-empty-move", input: { patchText: patch("*** Update File: safe.txt\n*** Move to:\n@@\n-old\n+new") }, ok: false },
  { name: "patch-empty-update", input: { patchText: patch("*** Update File: safe.txt\n@@") }, ok: false },
  { name: "patch-empty", input: { patchText: patch("") }, ok: false },
  { name: "patch-safe", input: { patchText: patch("*** Add File: safe.txt\n+safe\n*** Update File: other.txt\n*** Move to: moved.txt\n@@\n-old\n+new\n*** Delete File: obsolete.txt") }, ok: true },
  { name: "patch-heredoc-state", input: { patchText: `<<'PATCH'\n${patch("*** Add File: .corvus/reviews/pr8/meta.yaml\n+forged")}\nPATCH` }, ok: false },
  { name: "patch-indented-state", input: { patchText: patch("  *** Add File: .corvus/reviews/pr8/meta.yaml\n+forged") }, ok: false },
] satisfies Array<{ name: string; input: RecordValue; ok: boolean }>

export const shellCases = [
  { name: "shell-gh-read", command: "gh api repos/owner/repo/pulls/8", orchestrator: false, push: true },
  { name: "shell-mutation", command: "rm -rf .corvus/reviews", orchestrator: false, push: true },
  { name: "shell-push", command: "git -C . push origin HEAD:main", orchestrator: false, push: false },
  { name: "shell-denied-push", command: "git push github HEAD:main", error: "Permission denied", orchestrator: false, push: false },
  { name: "shell-auth", command: "gh auth status", orchestrator: true, push: true },
  { name: "shell-malformed", command: undefined, orchestrator: false, push: false },
]

export const projectionCases: Array<{ name: string; tool: SyntheticTool; available: boolean }> = [
  { name: "shell-first-text-only", tool: { name: "shell", input: { command: "pwd" }, output: "actual\n", storedContent: [{ type: "text", text: "actual\n" }, { type: "text", text: "model-only status" }] }, available: true },
  { name: "read-text-page", tool: { name: "read", input: { path: "safe.txt" }, output: "page text", storedContent: [{ type: "text", text: '{"type":"text-page","content":"page text"}' }] }, available: true },
  { name: "read-directory", tool: { name: "read", input: { path: "." }, output: "a\nb", storedContent: [{ type: "text", text: '{"entries":["a",{"path":"b"}]}' }] }, available: true },
  { name: "joined-text-blocks", tool: { name: "custom", input: {}, output: "one\ntwo", storedContent: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }, available: true },
  { name: "failed-partial-content", tool: { name: "shell", input: { command: "pwd" }, error: "Permission denied", storedContent: [{ type: "text", text: "partial output omitted by CLI" }] }, available: true },
  { name: "malformed-content", tool: { name: "shell", input: { command: "pwd" }, storedContent: [{ type: "text", text: 42 }] }, available: false },
]

export const unavailableCases = ["missing-db", "invalid-db", "unknown-schema", "partial-v2", "missing-parent", "malformed-parent", "malformed-child", "empty-child", "cycle"] as const
export function corruptStore(path: string, host: Host, kind: typeof unavailableCases[number]) {
  if (kind === "missing-db" || kind === "invalid-db") return
  const db = new Database(path)
  try {
    db.exec("PRAGMA foreign_keys = OFF")
    const table = host === "v1" ? "session" : "session_v2", parts = host === "v1" ? "part" : "session_message"
    if (kind === "unknown-schema") db.exec(`drop table ${table}; drop table ${parts}`)
    if (kind === "partial-v2") host === "v1" ? db.exec("create table session_v2 (id text)") : db.exec("drop table session_message")
    if (kind === "missing-parent") db.run(`delete from ${table} where id = ?`, [captureIDs[host].parent])
    if (kind === "malformed-parent" || kind === "malformed-child") db.run(`update ${parts} set data = ? where session_id = ?`, ["not JSON", captureIDs[host][kind === "malformed-parent" ? "parent" : "child"]])
    if (kind === "empty-child") db.run(`delete from ${parts} where session_id = ?`, [captureIDs[host].child])
    if (kind === "cycle") db.run(`update ${table} set parent_id = ? where id = ?`, [captureIDs[host].child, captureIDs[host].parent])
  } finally { db.close() }
}

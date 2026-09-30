import { existsSync } from "node:fs"
import { Database } from "bun:sqlite"

type RecordValue = Record<string, unknown>
export type StoredSession = { id: string; agent: string; parentID: string; parts: RecordValue[] }
export type SessionStoreResult =
  | { available: true; schema: "v1" | "v2"; parent: StoredSession; descendants: StoredSession[] }
  | { available: false; reason: string }

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid stored object")
  return value as RecordValue
}
const text = (value: unknown) => typeof value === "string" ? value : ""

/** Stable 2.0.20 CLI projection (upstream 84c9be9, tui/mini/tool.ts): shell
 * exposes only its first text block; read unwraps page/directory envelopes.
 * Other tools join text blocks with newlines. Keep raw content in state too. */
function outputText(name: string, content: unknown): string {
  if (!Array.isArray(content)) throw new Error("missing stored tool content")
  const blocks = content.map(record)
  if (blocks.some(block => typeof block.type !== "string" || block.type === "text" && typeof block.text !== "string")) {
    throw new Error("invalid stored tool content")
  }
  const texts = blocks.filter(block => block.type === "text").map(block => text(block.text))
  if (name === "shell" || name === "bash") return texts[0] ?? ""
  const joined = texts.filter(Boolean).join("\n")
  if (name !== "read" || !joined.startsWith("{")) return joined
  let page: RecordValue
  try { page = record(JSON.parse(joined)) } catch { return joined }
  if (typeof page.content === "string" && (page.type === "text-page" || page.encoding === "utf8")) return page.content
  if (!Array.isArray(page.entries)) return joined
  return page.entries.flatMap(entry => typeof entry === "string" ? [entry]
    : entry && typeof entry === "object" && "path" in entry && typeof entry.path === "string" ? [entry.path] : []).join("\n")
}

function validatePart(part: RecordValue, sessionID: string): RecordValue {
  if (!text(part.type) || part.sessionID !== undefined && part.sessionID !== sessionID) throw new Error("invalid stored part identity")
  if (part.type === "tool") {
    const state = record(part.state)
    if (!text(part.tool) || !text(state.status)) throw new Error("invalid stored tool")
    record(state.input)
    if (state.status === "error" && typeof state.error !== "string"
      && typeof record(state.error).message !== "string") throw new Error("invalid stored tool error")
  }
  if (part.type === "text" && typeof part.text !== "string") throw new Error("invalid stored text")
  return { ...part, sessionID }
}

/** Stopped-host DB oracle, opened read-only before scoring, never a live store.
 * Prefer the complete v2 table pair. V1 also has session_message, so that table
 * alone is not a v2 signal. A lone session_v2 is ambiguous/incomplete and cannot
 * fall back to stale v1 data. V1 reads session/part, not message. Read parent and
 * (when requested) its complete descendant tree atomically;
 * missing schema/session/parts, malformed rows or cycles return unavailable, not
 * an empty success. Wrappers throw that reason into bookkeeping disclosure and
 * hard-row failure paths. No host flag or disclosure disables the reader guard.
 * This is a storage projection, not an event generator: no step_finish is invented. */
export function readSessionStore(dbPath: string | undefined, parentID: string, includeDescendants = true): SessionStoreResult {
  let db: Database | undefined
  try {
    if (!dbPath || !existsSync(dbPath) || !parentID) throw new Error("host DB and parent session required")
    db = new Database(dbPath, { readonly: true })
    const connection = db
    return connection.transaction((): SessionStoreResult => {
      const tables = new Set((connection.query("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map(row => row.name))
      const v2 = tables.has("session_v2") && tables.has("session_message")
      if (!v2 && (tables.has("session_v2") || !tables.has("session") || !tables.has("part"))) {
        throw new Error("unknown/incomplete session storage schema")
      }
      const table = v2 ? "session_v2" : "session"
      type SessionRow = { id: string; agent: string | null; parent_id: string | null }
      const readSession = (row: SessionRow): StoredSession => {
        if (!text(row.id)) throw new Error("invalid stored session")
        let parts: RecordValue[]
        if (v2) {
          const messages = connection.query("select id, type, data from session_message where session_id = ? order by seq, id").all(row.id) as { id: string; type: string; data: string }[]
          parts = messages.flatMap(message => {
            const data = record(JSON.parse(message.data))
            if (!text(message.type)) throw new Error("invalid stored message type")
            if (message.type !== "assistant") return []
            if (!Array.isArray(data.content)) throw new Error("invalid assistant content")
            return data.content.map(value => {
              const item = record(value)
              if (!["text", "reasoning", "tool"].includes(text(item.type))) throw new Error("invalid assistant content type")
              if (item.type !== "tool") return validatePart({ ...item, messageID: message.id }, row.id)
              if (!text(item.id) || !text(item.name)) throw new Error("invalid v2 tool identity")
              const state = record(item.state)
              // Failed CLI tool_use events omit output, even when storage retains
              // partial content. Keep the raw structured error and partial content.
              const projected = { ...state, ...(state.status === "completed" ? { output: outputText(text(item.name), state.content) } : {}) }
              return validatePart({ ...item, tool: item.name, callID: item.id, messageID: message.id, state: projected }, row.id)
            })
          })
        } else {
          const rows = connection.query("select data from part where session_id = ? order by time_created, id").all(row.id) as { data: string }[]
          parts = rows.map(part => validatePart(record(JSON.parse(part.data)), row.id))
        }
        if (!parts.length) throw new Error(`missing session parts: ${row.id}`)
        return { id: row.id, agent: text(row.agent), parentID: text(row.parent_id), parts }
      }
      const root = connection.query(`select id, agent, parent_id from ${table} where id = ?`).get(parentID) as SessionRow | null
      if (!root) throw new Error(`missing parent session: ${parentID}`)
      const parent = readSession(root), descendants: StoredSession[] = [], seen = new Set([parentID])
      const pending = [parentID]
      while (includeDescendants && pending.length) {
        const rows = connection.query(`select id, agent, parent_id from ${table} where parent_id = ? order by time_created, id`).all(pending.shift()!) as SessionRow[]
        for (const row of rows) {
          if (seen.has(row.id)) throw new Error("cyclic child session tree")
          seen.add(row.id)
          descendants.push(readSession(row))
          pending.push(row.id)
        }
      }
      return { available: true, schema: v2 ? "v2" : "v1", parent, descendants }
    })()
  } catch (error) {
    return { available: false, reason: `unavailable session evidence: ${String(error)}` }
  } finally { db?.close() }
}

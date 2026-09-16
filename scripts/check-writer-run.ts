import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { checkModelStateWrites, checkRetiredTools, checkWriterDispatch, printSmokeResult, readChildSessions, readDescendants, reviewRoot, toolsFromEvents, type Row } from "./check-review-artifacts"

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}
const text = (value: unknown): string => typeof value === "string" ? value : ""
const lines = (value: string): string[] => value.split(/\r?\n/).filter(line => line.trim())

export type WriterRunInputs = { fixture: string; owner: string; repo: string; pr: string; head: string; digest: string; jsonl: string; audit: string; stderr?: string; db?: string; expect?: "blocked" | "head-moved" }

/**
 * Direct writer-run gate (scripts/smoke-writer.sh): a sandbox relay primary dispatches
 * the real writer once, so the parent JSONL proves the dispatch and the host DB holds
 * the writer child's own tool sequence. The fixture artifact bytes must equal the
 * dispatched digest and the host must not have fallen back to another agent before
 * any writer row is scored; missing/malformed evidence fails closed. Rows come from
 * checkWriterDispatch (writer head/anchor reads → marker reviews → post → blocked plugin POST, local_only/unknown;
 * with --head-moved: post tool rejected head-moved, no POST, local_only/not_posted);
 * exit 6 means a forwarded mutation or a `posted` claim, 5 a
 * missing/incorrect writer path, 3 a host/JSONL failure, 4 a fixture failure.
 * Ten rows: JSONL, host/provider, fixture artifact, model state writes, retired tool
 * absent, writer dispatched, and the four checkWriterExecution rows. No R5 transport
 * row: this relay does not orchestrate a review. Unreadable DB evidence fails both
 * all-agent audits; no mode disables them.
 */
export function checkWriterRun(input: WriterRunInputs) {
  const rows: Row[] = []
  const add = (check: string, ok: boolean, code: number, detail: string) => rows.push({ check, ok, code, detail })
  const raw = existsSync(input.jsonl) ? readFileSync(input.jsonl, "utf8") : ""
  const events: RecordValue[] = []
  let malformed = 0
  for (const line of lines(raw)) {
    try { events.push(record(JSON.parse(line))) } catch { malformed++ }
  }
  add("JSONL", events.length > 0 && malformed === 0, 3, `${events.length} events; ${malformed} malformed lines`)
  const errors = events.filter(event => event.type === "error").map(event => JSON.stringify(event.error))
  const stderr = input.stderr && existsSync(input.stderr) ? readFileSync(input.stderr, "utf8") : ""
  const fallback = /falling back to default agent|not a primary agent/i.test(stderr)
  add("host/provider", errors.length === 0 && !fallback, 3, fallback ? "host fell back to the default agent (relay not used)" : errors.join("\n") || "no terminal host/provider error")
  const artifact = join(resolve(input.fixture), reviewRoot(input), "post-request.json")
  const digest = existsSync(artifact) ? createHash("sha256").update(readFileSync(artifact)).digest("hex") : ""
  let commit = ""
  try { commit = text(record(JSON.parse(readFileSync(artifact, "utf8"))).commit_id) } catch {}
  add("fixture artifact", digest === input.digest && commit === input.head, 4,
    digest === input.digest && commit === input.head ? `${digest} (commit_id = ${input.head})` : `artifact digest ${digest || "missing"} vs dispatched ${input.digest}; commit_id ${commit || "missing"}`)
  const parentTools = toolsFromEvents(events)
  const parentID = events.map(event => text(event.sessionID) || text(record(event.part).sessionID)).find(Boolean) ?? ""
  const auditLines = lines(existsSync(input.audit) ? readFileSync(input.audit, "utf8") : "")
  try {
    if (!input.db) throw new Error("host DB required for all-agent write audit")
    const descendants = readDescendants(input.db, parentID)
    const allTools = [...parentTools, ...descendants.flatMap(child => child.tools)]
    rows.push(checkModelStateWrites(allTools, input.fixture), checkRetiredTools(allTools))
  } catch (error) {
    for (const check of ["model state writes", "retired tool absent"]) add(check, false, 5, `unreadable child evidence: ${String(error)}`)
  }
  // The fixture is already frozen before the relay starts; every completed dispatch counts (afterIndex -1).
  rows.push(...checkWriterDispatch({ owner: input.owner, repo: input.repo, pr: input.pr, fixture: input.fixture, digest: input.digest,
    auditLines, parentTools, afterIndex: -1, parentID, db: input.db, expect: input.expect }))
  let sequence: string[] = []
  try {
    const child = input.db ? readChildSessions(input.db, parentID, "pr-comment-writer").at(-1) : undefined
    sequence = (child?.tools ?? []).map(tool => `${tool.index}:${tool.name}${tool.name === "bash" ? "(" + text(tool.input.command) + ")" : ["corvus_review_payload", "corvus_review_pr"].includes(tool.name) ? "(" + text(tool.input.op) + ")" : tool.name === "corvus_review_post" ? "(" + text(tool.output.outcome) + ", tool_api_calls=" + String(tool.output.tool_api_calls) + ")" : ""} → ${text(tool.state.status)}`)
  } catch {}
  const exitCode = [6, 3, 4, 5].find(code => rows.some(row => !row.ok && row.code === code)) ?? 0
  return { rows, exitCode, sequence, auditLines }
}

if (import.meta.main) {
  const [fixture, owner, repo, pr, head, digest, jsonl, audit, stderr] = process.argv.slice(2, 11)
  if (!audit) {
    console.error("Usage: check-writer-run.ts <fixture> <owner> <repo> <pr> <head_sha> <expected_sha256> <jsonl> <gh-audit> [stderr] [--db PATH] [--head-moved]")
    printSmokeResult([{ check: "arguments", ok: false, code: 3, detail: "missing required arguments" }], 3)
    process.exit(3)
  }
  try {
    const positional = stderr && !stderr.startsWith("--") ? 11 : 10
    const { values } = parseArgs({ args: process.argv.slice(positional), options: { db: { type: "string" }, "head-moved": { type: "boolean" } } })
    const result = checkWriterRun({ fixture, owner, repo, pr, head, digest, jsonl, audit, stderr: positional === 11 ? stderr : undefined, db: values.db,
      expect: values["head-moved"] ? "head-moved" : "blocked" })
    console.log("| Check | Result | Evidence |\n|---|---|---|")
    for (const row of result.rows) console.log(`| ${row.check} | ${row.ok ? "PASS" : "FAIL"} | ${row.detail.replaceAll("|", "\\|").replaceAll("\n", " <br> ")} |`)
    console.log("Writer child tool sequence:\n" + (result.sequence.join("\n") || "(none)"))
    console.log("GitHub audit:\n" + (result.auditLines.join("\n") || "(empty)"))
    console.log(`Exit code: ${result.exitCode}`)
    printSmokeResult(result.rows, result.exitCode)
    process.exitCode = result.exitCode
  } catch (error) {
    console.error(`FAIL: checker could not read evidence: ${String(error)}`)
    printSmokeResult([{ check: "checker", ok: false, code: 5, detail: String(error) }], 5)
    process.exitCode = 5
  }
}

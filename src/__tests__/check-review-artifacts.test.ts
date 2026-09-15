import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { dump } from "js-yaml"
import { REVIEW_INPUT_LINE_LIMIT, artifactTree, checkReviewArtifacts, reviewNamespace, reviewRoot, type Inputs } from "../../scripts/check-review-artifacts"
import { checkWriterRun } from "../../scripts/check-writer-run"
import { freeze } from "../review-payload"
import { post as postReview } from "../review-post"
import type { DocumentVerdict, LabelCounts } from "../review-verdict"
import { pull, push, resolve as resolveSync, type PushInput, type SyncExec } from "../review-sync"

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const labelCounts = (overrides: Partial<LabelCounts> = {}): LabelCounts => ({ blocker: 0, critical: 0, major: 0, minor: 0, nitpick: 0, praise: 0, thought: 0, note: 0, ...overrides })
const historyVerdict = { ok: true as const, round: 1, refuse_delta: false, missing_history: false }
const verdict: DocumentVerdict = {
  ...historyVerdict, converged: false, convergence_reason: "no-previous-round",
  counts: { standards: labelCounts({ minor: 1 }), spec: labelCounts({ major: 1 }), total: labelCounts({ minor: 1, major: 1 }), actionable_total: 2,
    by_origin: {
      "pr-code": { standards: labelCounts({ minor: 1 }), spec: labelCounts({ major: 1 }), total: labelCounts({ minor: 1, major: 1 }) },
      "review-fix": { standards: labelCounts(), spec: labelCounts(), total: labelCounts() },
    } },
  caps_applied: { max_nits: 3, max_minors: 6, totals: { minor: 1, nitpick: 0 } },
}
const verdictMeta = (head: string) => ({ autonomous: true, posted: false, mode: "pr", verdict_file: "verdict.yaml", code_head: head, head_sha: head })
const persistedVerdict = () => structuredClone({ ...verdict, computed_at: "2026-09-13T00:00:00.000Z" })
const stats = (counts: LabelCounts) => ({ total_findings: Object.values(counts).reduce((sum, count) => sum + count, 0),
  blockers: counts.blocker, criticals: counts.critical, majors: counts.major, minors: counts.minor, nits_shown: counts.nitpick,
  praises: counts.praise, thoughts: counts.thought, notes: counts.note, actionable: counts.blocker + counts.critical + counts.major + counts.minor,
  suppressed: 0, nits_suppressed: 0 })
const reviewDocument = () => ({ verdict: "not_converged", synthesis_controls: { series_round: 1 }, source_findings: {}, findings: [] as object[],
  summary: { stats: stats(verdict.counts.total), by_axis: { standards: { stats: stats(verdict.counts.standards) }, spec: { stats: stats(verdict.counts.spec) } } } })
const documentMarkdown = (document: object) => `# Review\n\n## REVIEW_DOCUMENT\n\n\`\`\`yaml\n${dump({ REVIEW_DOCUMENT: document })}\`\`\`\n`
let callNumber = 0
const toolEvent = (name: string, input: object, output: object, error?: string) => ({
  type: "tool_use", sessionID: "ses_smoke", part: { callID: `call_${++callNumber}`, tool: name,
    state: { status: error ? "error" : "completed", input, output: JSON.stringify(output), error } },
})
function seedParent(db: Database, events: object[]) {
  for (const [index, event] of events.entries()) {
    const item = event as { type: string; part: object }
    db.run("insert into part (id, session_id, time_created, data) values (?, ?, ?, ?)", [`parent_${index}`, "ses_smoke", index,
      JSON.stringify({ ...item.part, type: item.type === "tool_use" ? "tool" : item.type, sessionID: "ses_smoke" })])
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

async function fixture(inline = false, intake: Inputs["intake"] = "url", layout: "plain" | "task" = "plain", syncMode: "normal" | "disabled" | "no-upstream" | "fork" = "normal", barrier: "denied" | "not-exposed" = "denied") {
  const directory = mkdtempSync(join(tmpdir(), "corvus-review-check-"))
  directories.push(directory)
  const workspace = join(directory, "fixture")
  const branch = intake === "local" ? "smoke/local-fixture" : "topic/pr8"
  const local = intake === "local"
  const notExposed = !local && barrier === "not-exposed"
  const reviewAction = { decision: "local_only", decision_reason: "pr-comment-writer not-exposed, cause unknown", rails_applied: ["writer_capability_not_exposed"] }
  const crossRepo = syncMode === "fork"
  mkdirSync(workspace)
  git(workspace, "init", "-b", "main")
  git(workspace, "config", "user.name", "Smoke fixture")
  git(workspace, "config", "user.email", "smoke@example.invalid")
  git(workspace, "config", "commit.gpgsign", "false")
  writeFileSync(join(workspace, "README.md"), "Base fixture\n")
  git(workspace, "add", "README.md")
  git(workspace, "commit", "-m", "Base fixture")
  git(workspace, "checkout", "-b", branch)
  writeFileSync(join(workspace, "x"), "line\n")
  if (layout === "task") {
    mkdirSync(join(workspace, ".corvus/tasks/feature"), { recursive: true })
    writeFileSync(join(workspace, ".corvus/tasks/feature/PLAN.md"), "Task fixture\n")
  }
  git(workspace, "add", ".")
  git(workspace, "commit", "-m", "Product change")
  const head = git(workspace, "rev-parse", "HEAD"), bare = join(directory, "bare.git")
  git(directory, "clone", "--bare", workspace, bare)
  writeFileSync(join(directory, "bare-tip-before"), head + "\n")
  git(workspace, "remote", "add", "origin", bare)
  git(workspace, "remote", "add", "github", "https://github.com/owner/repo")
  git(workspace, "remote", "set-url", "--push", "github", "DISABLED_PUSH_SENTINEL")
  git(workspace, "fetch", "origin")
  if (local && syncMode !== "no-upstream") git(workspace, "branch", `--set-upstream-to=origin/${branch}`, branch)
  if (intake === "branch") {
    git(workspace, "config", `branch.${branch}.remote`, "github")
    git(workspace, "config", `branch.${branch}.merge`, "refs/pull/8/head")
  }
  if (intake === "url") git(workspace, "checkout", "--detach", head)
  if (local) writeFileSync(join(workspace, "README.md"), "Dirty LOCAL fixture\n")
  const changedFiles = [...(local ? ["README.md"] : []), ...git(workspace, "diff", "--name-only", `main...${head}`).split("\n")].sort()
  writeFileSync(join(directory, "changed-files.json"), JSON.stringify(changedFiles))
  const trace = join(directory, "git-trace.jsonl")
  writeFileSync(trace, "")
  const exec: SyncExec = async (argv, options) => {
    const result = Bun.spawnSync(argv, { cwd: options.cwd, env: { ...process.env, GIT_TRACE2_EVENT: trace } })
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }
  const pr = local ? { name: "repo", number: null, branch } : { owner: "owner", name: "repo", number: 8, isCrossRepository: crossRepo }
  const resolved = await resolveSync({ cwd: workspace, pr, changed_files: changedFiles }, { exec })
  const pulled = syncMode === "disabled" ? undefined : await pull({ cwd: workspace, branch, remote: "origin" }, { exec })
  const namespace = local ? `local-${branch.replace(/[^A-Za-z0-9._-]/g, "-")}` : "pr8"
  const relative = `.corvus/${layout === "task" ? "tasks/feature/" : ""}reviews/${namespace}`
  const root = join(workspace, relative)
  const meta = () => ({ ...verdictMeta(head), ...(local ? { mode: "local", owner: null, repo: "repo", pr_number: null, branch,
    head_sha: head, base_sha: "b".repeat(40), merge_base: "b".repeat(40), default_branch: "main", dirty: true } : {}) })
  mkdirSync(join(root, head), { recursive: true })
  if (!local) {
    const build = await Bun.build({ entrypoints: [resolve(import.meta.dirname, "../review-payload.ts")], outdir: join(directory, "dist"), target: "bun" })
    expect(build.success).toBe(true)
  }
  writeFileSync(join(root, head, "REVIEW_DOCUMENT.md"), documentMarkdown(reviewDocument()))
  writeFileSync(join(root, head, "meta.yaml"), dump(meta()))
  writeFileSync(join(root, head, "verdict.yaml"), dump(persistedVerdict()))
  if (notExposed) writeFileSync(join(root, head, "review-action.yaml"), dump(reviewAction))
  writeFileSync(join(root, "verified_facts.yaml"), "facts: []\nopen_questions: []\n")
  if (!local) writeFileSync(join(root, "candidate.json"), JSON.stringify({ commit_id: head, event: "COMMENT", body: `Smoke review — ✓\n<!-- corvus-review v2 path=${relative} head=${head} round=1 -->`, comments: inline ? [{ path: "x", line: 1, side: "RIGHT", body: "Inline review" }] : [] }))
  writeFileSync(join(root, "review-input.json"), JSON.stringify({ mode: local ? "local" : "pr", pr_number: local ? null : 8, head_sha: head, description_chunks: ["## Summary\n", "x".repeat(1500)], file_map: {} }, null, 2) + "\n")
  const frozen = local || notExposed ? undefined : freeze(join(root, "candidate.json"), join(root, "post-request.json"), { reviewStateRoot: join(workspace, ".corvus") })
  if (frozen && !frozen.ok) throw new Error(JSON.stringify(frozen))
  const pushInput: PushInput = { cwd: workspace, root: relative, head_sha: head, pr, branch, remote: "origin" }
  const pushed = syncMode === "disabled" ? undefined : await push(pushInput, { exec })
  const tool = toolEvent
  const verdictInput = { op: "compute", reviewRoot: relative, priorReviews: { ok: true, reviews: [], threads: [], dispositions: [], complete_pagination: true, complete_threads: true, api_calls: 2 }, config: {}, forceDelta: false }
  const events = [
    tool("corvus_review_pr", local ? { op: "local", cwd: workspace } : { op: "metadata", owner: "owner", name: "repo", pr: 8 },
      { ok: true, number: local ? null : 8, headRefOid: head, head_sha: head, code_head: head, isCrossRepository: crossRepo, changed_files: changedFiles, api_calls: 1 }),
    ...(!local ? [tool("corvus_review_pr", { op: "files", owner: "owner", name: "repo", pr: 8, paginate: true, include_corvus: true, names_only: true },
      { ok: true, files: changedFiles, complete_pagination: true, api_calls: 1 })] : []),
    ...(syncMode === "disabled" ? [tool("corvus_review_pr", { op: "config", owner: "owner", name: "repo", ref: head }, { ok: true, present: true, yaml: "state_sync: false\n", api_calls: 1 })] : []),
    tool("corvus_review_sync", { op: "resolve", cwd: workspace, pr, changed_files: changedFiles }, resolved),
    ...(pulled ? [tool("corvus_review_sync", { op: "pull", cwd: workspace, branch, remote: "origin" }, pulled)] : []),
    tool("corvus_review_lock", { op: "acquire", reviewRoot: relative, runId: "run-1" }, { ok: true, state: "acquired", started_at: "2026-09-13T00:00:00Z" }),
    tool("corvus_review_verdict", verdictInput, historyVerdict),
    tool("task", { subagent_type: "pr-context-gatherer" }, { sessionID: "ses_gatherer", status: "completed" }),
    tool("corvus_review_persist", { op: "write_input", reviewRoot: relative, input: {} }, { ok: true, path: `${relative}/review-input.json` }),
    tool("corvus_review_persist", { op: "write_facts", reviewRoot: relative, facts: { facts: [], open_questions: [] } }, { ok: true, path: `${relative}/verified_facts.yaml` }),
    tool("corvus_review_persist", { op: "begin", reviewRoot: relative, target: "document", headSha: head, expected_sections: 1 }, { ok: true, staging_id: "document-session" }),
    tool("corvus_review_persist", { op: "append", reviewRoot: relative, staging_id: "document-session", index: 0, heading: "", body: documentMarkdown(reviewDocument()) }, { ok: true }),
    tool("corvus_review_persist", { op: "finalize", reviewRoot: relative, staging_id: "document-session", expected_sections: 1 }, { ok: true, path: `${relative}/${head}/REVIEW_DOCUMENT.md`, sha256: createHash("sha256").update(readFileSync(join(root, head, "REVIEW_DOCUMENT.md"))).digest("hex") }),
    tool("corvus_review_persist", { op: "write_candidate", reviewRoot: relative, candidate: {} }, { ok: true, path: `${relative}/candidate.json` }),
    tool("corvus_review_payload", { op: "measure", candidatePath: `${relative}/candidate.json` }, { ok: true }),
    tool("corvus_review_verdict", { ...verdictInput, headSha: head }, { ...verdict, persisted: `${relative}/${head}/verdict.yaml` }),
    ...(notExposed ? [tool("corvus_review_persist", { op: "write_meta", reviewRoot: relative, headSha: head, name: "review-action.yaml", meta: reviewAction }, { ok: true, path: `${relative}/${head}/review-action.yaml` })] : [
      tool("corvus_review_payload", { op: "freeze", candidatePath: `${relative}/candidate.json`, artifactPath: `${relative}/post-request.json` }, frozen ?? {}),
      tool("corvus_review_verify", { op: "verify", artifactPath: `${relative}/post-request.json`, expectedSha256: frozen?.sha256 }, { ok: true }),
      tool("subagent", { agent: "pr-comment-writer" }, {}, "Subagent denied: pr-comment-writer"),
    ]),
    tool("corvus_review_persist", { op: "write_meta", reviewRoot: relative, headSha: head, meta: meta() }, { ok: true, path: `${relative}/${head}/meta.yaml` }),
    tool("corvus_review_lock", { op: "release", reviewRoot: relative, runId: "run-1", mode: "complete" }, { ok: true, state: "completed" }),
    ...(pushed ? [tool("corvus_review_sync", { op: "push", ...pushInput }, pushed)] : []),
    { type: "step_finish", part: { cost: 0.01, tokens: { input: 10, output: 5, cache: { read: 2, write: 3 } } } },
    { type: "text", sessionID: "ses_smoke", part: { text: `Review saved: ${relative}/${head}/REVIEW_DOCUMENT.md\nStandards: 1 finding; Spec: 1 finding.\n${pushed ? `synced: ${pushed.synced}; ${pushed.state_commit ? `state_commit: ${pushed.state_commit}` : `reason: ${pushed.reason}`}` : "state_sync: false; skipped pull and push"}${notExposed ? "\nNothing posted—the authorized pr-comment-writer is not exposed by this host." : ""}` } },
  ].filter(event => !local || !("tool" in event.part && (event.part.tool === "corvus_review_payload" || event.part.tool === "corvus_review_verify"
    || event.part.tool === "subagent" || (event.part.state.input as { op?: string }).op === "write_candidate")))
  if (local) events.splice(events.findIndex(event => "tool" in event.part && (event.part.state.input as { op?: string }).op === "write_meta"), 0,
    { type: "text", sessionID: "ses_smoke", part: { text: "[R4 COMPLETE] LOCAL review — posting is not applicable" } })
  if (intake === "branch") events.unshift(
    tool("corvus_review_pr", { op: "find" }, { ok: true, found: true, number: 8, url: "https://github.com/owner/repo/pull/8", state: "OPEN", api_calls: 1 }))
  const db = join(directory, "opencode.db")
  const database = new Database(db)
  database.run("create table session (id text primary key, parent_id text, agent text, time_created integer)")
  database.run("create table part (id text primary key, session_id text, time_created integer, data text)")
  seedGatherer(database, local)
  seedParent(database, events)
  database.close()
  const input: Inputs = { fixture: workspace, owner: "owner", repo: "repo", pr: "8", head, intake, branch, bare, crossRepo, jsonl: join(directory, "run.jsonl"), hostlog: join(directory, "host.log"), audit: join(directory, "gh-audit.log"), db }
  const saveEvents = () => writeFileSync(input.jsonl, events.map(event => JSON.stringify(event)).join("\n") + "\n")
  saveEvents()
  writeFileSync(input.hostlog, `INFO entrypoint=${directory}/install/node_modules/corvus-ai/server.js msg="loading plugin"\nCORVUS_SMOKE_SESSION {"id":"ses_smoke","agent":"corvus-review-auto"}\n`)
  writeFileSync(input.audit, local ? "" : JSON.stringify({ marker: "CORVUS_SMOKE_GH_FORWARD", argv: ["pr", "view", "8"] }) + "\n")
  return { input, root, events, saveEvents, pushInput, exec }
}

function seedGatherer(db: Database, local = false) {
  db.run("insert into session (id, parent_id, agent, time_created) values (?, ?, ?, ?)", ["ses_gatherer", "ses_smoke", "pr-context-gatherer", 2])
  if (local) {
    db.run("insert into part (id, session_id, time_created, data) values (?, ?, ?, ?)", ["gatherer_local", "ses_gatherer", 0,
      JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed", input: { command: "git diff --stat" }, output: "README.md | 1 +\n" } })])
    return
  }
  for (const [index, op] of ["files", "diff"].entries()) {
    db.run("insert into part (id, session_id, time_created, data) values (?, ?, ?, ?)", [`gatherer_${index}`, "ses_gatherer", index,
      JSON.stringify({ type: "tool", tool: "corvus_review_pr", state: { status: "completed", input: { op, owner: "owner", name: "repo", pr: 8, ...(op === "files" ? { paginate: true } : {}) }, output: JSON.stringify({ ok: true, api_calls: 1 }) } })])
  }
}

test.each(["plain", "task"] as const)("complete real-shaped tool evidence passes (%s); background or unfinished children fail", async layout => {
  const data = await fixture(false, "url", layout)
  expect(join(data.input.fixture, reviewRoot(data.input))).toBe(data.root)
  writeFileSync(join(data.root, "lock.yaml"), "status: completed\n")
  const result = await checkReviewArtifacts(data.input)
  expect(result.rows.filter(row => !row.ok)).toEqual([])
  expect(result.exitCode).toBe(0)
   expect(result.rows).toHaveLength(44)
  expect(result.usage).toMatchObject({ steps: 1, cost: 0.01, tokens: { input: 10, output: 5, "cache.read": 2, "cache.write": 3 } })
  const child = (name: string, sessionID: string, status: string, background = false, nested = false) => ({
    type: "tool_use", sessionID: "ses_smoke", part: { id: `call_${sessionID}`, tool: name, state: {
      status: "completed", input: { agent: "pr-context-gatherer", subagent_type: "pr-context-gatherer", background },
      output: nested ? "Child acknowledgement" : JSON.stringify({ sessionID, status, output: "Child result" }),
      metadata: nested ? { metadata: { sessionID, status } } : {},
    } },
  })
  const running = child("subagent", "ses_child", "running", false, true)
  const completed = child("subagent", "ses_child", "completed")
  const cases: Array<[object[], boolean]> = [
    [[child("subagent", "ses_child", "completed", true)], false],
    [[child("task", "ses_child", "completed", true)], false],
    [[child("subagent", "ses_child", "running")], false],
    [[running], false],
    [[running, child("subagent", "ses_other", "completed")], false],
    [[completed, running], false],
    [[running, { type: "text", part: { text: "ses_child completed" } }], false],
    [[running, { ...completed, sessionID: "ses_other_parent" }], false],
    [[running, completed], true],
    [[child("task", "ses_child", "running"), child("task", "ses_child", "error")], true],
  ]
  for (const [children, allowed] of cases) {
    const release = data.events.findIndex(event => "tool" in event.part && (event.part.state.input as { op?: string }).op === "release")
    writeFileSync(data.input.jsonl, [...data.events.slice(0, release), ...children, ...data.events.slice(release)].map(event => JSON.stringify(event)).join("\n") + "\n")
    const checked = await checkReviewArtifacts(data.input)
    expect(checked.exitCode).toBe(allowed ? 0 : 5)
    expect(checked.rows.find(row => row.check === "background-dispatch")?.ok).toBe(allowed)
  }
}, 15_000)

test.each(["url", "branch", "local"] as const)("%s sync gate rejects missing, reordered, forged and unsafe evidence", async intake => {
  const data = await fixture(false, intake)
  const baseline = structuredClone(data.events)
  const save = (events: object[], stored = events) => {
    writeFileSync(data.input.jsonl, events.map(event => JSON.stringify(event)).join("\n"))
    const db = new Database(data.input.db!)
    db.run("delete from part where session_id = ?", ["ses_smoke"])
    seedParent(db, stored)
    db.close()
  }
  const result = await checkReviewArtifacts(data.input)
  expect(result.rows.filter(row => !row.ok)).toEqual([])
  console.info(`Offline ${intake}: ${result.rows.length}/${result.rows.length} rows; root=${reviewRoot(data.input)}`)
  const syncOp = (event: typeof baseline[number], op: string) => "tool" in event.part && event.part.tool === "corvus_review_sync" && (event.part.state.input as { op?: string }).op === op
  for (const [mutation, row] of [
    ["missing-resolve", "sync.resolve"], ["late-resolve", "sync.resolve"], ["wrong-root", "sync.resolve"], ["filtered-inventory", "sync.resolve"],
    ["missing-pull", "sync.pull"], ["early-push", "sync.push"], ["push-before-release", "sync.push"], ["DB-order", "sync.push"], ["DB-mismatch", "sync.push"],
    ["late-meta", "sync.push"], ["duplicate-push", "sync.push"],
    ["meta-receipt", "sync metadata"], ["wrong-receipt", "sync receipt"], ["missing-summary", "sync terminal summary"],
    ["bash-push", "Git push isolation"], ["github-target", "sync.push"],
  ]) {
    const events = structuredClone(baseline)
    const resolved = events.find(event => syncOp(event, "resolve"))! as ReturnType<typeof toolEvent>
    const pushed = events.find(event => syncOp(event, "push"))! as ReturnType<typeof toolEvent>
    if (mutation === "missing-resolve") events.splice(events.indexOf(resolved), 1)
    if (mutation === "late-resolve") events.push(events.splice(events.indexOf(resolved), 1)[0])
    if (mutation === "wrong-root") resolved.part.state.output = JSON.stringify({ ok: true, root: ".corvus/tasks/wrong/reviews/pr8", remote: "origin" })
    if (mutation === "filtered-inventory") Object.assign(resolved.part.state.input, { changed_files: [] })
    if (mutation === "missing-pull") events.splice(events.findIndex(event => syncOp(event, "pull")), 1)
    if (mutation === "early-push") events.unshift(events.splice(events.indexOf(pushed), 1)[0])
    if (mutation === "push-before-release") {
      events.splice(events.indexOf(pushed), 1)
      events.splice(events.findIndex(event => "tool" in event.part && (event.part.state.input as { op?: string }).op === "release"), 0, pushed)
    }
    if (mutation === "late-meta") {
      const index = events.findIndex(event => "tool" in event.part && (event.part.state.input as { op?: string }).op === "write_meta")
      const meta = events.splice(index, 1)[0]
      events.splice(events.indexOf(pushed), 0, meta)
    }
    if (mutation === "duplicate-push") events.push(toolEvent("corvus_review_sync", pushed.part.state.input, JSON.parse(pushed.part.state.output)))
    if (mutation === "DB-mismatch") pushed.part.callID = "unrecorded"
    if (mutation === "meta-receipt") {
      const meta = events.find(event => "tool" in event.part && (event.part.state.input as { op?: string }).op === "write_meta")! as ReturnType<typeof toolEvent>
      Object.assign((meta.part.state.input as { meta: object }).meta, { state_commit: git(data.input.bare!, "rev-parse", data.input.branch!) })
    }
    if (mutation === "wrong-receipt") pushed.part.state.output = JSON.stringify({ synced: true, state_commit: data.input.head, git_calls: 1 })
    if (mutation === "missing-summary") events.pop()
    if (mutation === "bash-push") events.push(toolEvent("bash", { command: `git -C . push origin HEAD:${data.input.branch}` }, {}))
    if (mutation === "github-target") Object.assign(pushed.part.state.input, { remote: "github" })
    const stored = structuredClone(events)
    if (mutation === "DB-mismatch") {
      const original = baseline.find(event => syncOp(event, "push"))! as ReturnType<typeof toolEvent>
      const storedPush = stored.find(event => syncOp(event, "push"))! as ReturnType<typeof toolEvent>
      storedPush.part.callID = original.part.callID
    }
    if (mutation === "DB-order") {
      const pushed = stored.splice(stored.findIndex(event => syncOp(event, "push")), 1)[0]
      stored.splice(stored.findIndex(event => "tool" in event.part && (event.part.state.input as { op?: string }).op === "release"), 0, pushed)
    }
    save(events, stored)
    const checked = await checkReviewArtifacts(data.input)
    expect(checked.rows.find(item => item.check === row), mutation).toMatchObject({ ok: false })
    if (["DB-order", "DB-mismatch", "late-meta", "duplicate-push", "github-target"].includes(mutation)) {
      expect(checked.rows.find(item => item.check === "lock released"), mutation).toMatchObject({ ok: false })
    }
  }
  save(baseline)
  const metaPath = join(data.root, data.input.head, "meta.yaml"), metaBytes = readFileSync(metaPath)
  writeFileSync(metaPath, metaBytes.toString() + "state_commit: forbidden\n")
  expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "sync metadata")).toMatchObject({ ok: false })
  writeFileSync(metaPath, metaBytes)
  const legacy = join(data.input.fixture, ".corvus/reviews", reviewNamespace(data.input))
  mkdirSync(legacy)
  expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "new review root")).toMatchObject({ ok: false })
  rmSync(legacy, { recursive: true })
  const tracePath = join(data.input.fixture, "../git-trace.jsonl"), trace = readFileSync(tracePath, "utf8")
  for (const argv of [["git", "push", "github", `HEAD:${data.input.branch}`], ["git", "push", "--force", "origin", `HEAD:${data.input.branch}`]]) {
    writeFileSync(tracePath, trace + JSON.stringify({ event: "start", argv }) + "\n")
    expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "Git push isolation")).toMatchObject({ ok: false, code: 6 })
  }
  writeFileSync(tracePath, trace)
  for (const path of [".corvus/reviews/pr8/input.json", ".corvus/tasks/feature/reviews/pr8/input.json"]) {
    save([...baseline, toolEvent("apply_patch", { patchText: `*** Begin Patch\n*** Add File: ${path}\n+{}\n*** End Patch` }, {})])
    expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "model state writes")).toMatchObject({ ok: false })
  }
  save(baseline)
}, 30_000)

test("staging rejects single-call checkpoints, missing finalize, oversized appends and failed checkpoints with a verdict", async () => {
  const data = await fixture()
  const baseline = structuredClone(data.events)
  for (const [mutation, check] of [["single", "document staged"], ["missing", "checkpoint writes"], ["oversized", "append ceiling"], ["failed-verdict", "checkpoint-failed route"]]) {
    const events = structuredClone(baseline)
    const final = events.find((event): event is ReturnType<typeof toolEvent> => "tool" in event.part && (event.part.state.input as { op?: string }).op === "finalize")!
    if (mutation === "single") Object.assign(final.part.state.input, { op: "write_document", headSha: data.input.head })
    if (mutation === "missing") events.splice(events.indexOf(final), 1)
    if (mutation === "oversized") {
      const append = events.find((event): event is ReturnType<typeof toolEvent> => "tool" in event.part && (event.part.state.input as { op?: string }).op === "append")!
      Object.assign(append.part.state.input, { body: "x".repeat(6001) })
    }
    if (mutation === "failed-verdict") writeFileSync(join(data.root, data.input.head, "meta.yaml"), dump({ ...verdictMeta(data.input.head), status: "checkpoint-failed", stage: "document", failed_op: "append", part: 0, reason: "write-error", recoverable: true }))
    writeFileSync(data.input.jsonl, events.map(event => JSON.stringify(event)).join("\n"))
    const db = new Database(data.input.db!)
    db.run("delete from part where session_id = ?", ["ses_smoke"])
    seedParent(db, events)
    db.close()
    expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === check), mutation).toMatchObject({ ok: false })
  }
})

test.each(["url", "local"] as const)("%s checkpoint-failed cleanup passes without success artifacts but rejects verdict calls and held locks", async intake => {
  const data = await fixture(false, intake, "plain", "disabled")
  const relative = reviewRoot(data.input)
  const meta = { ...verdictMeta(data.input.head), status: "checkpoint-failed", stage: "document", failed_op: "finalize", part: 0, reason: "incomplete-staging", recoverable: true }
  const events = data.events.filter(event => {
    if (!("tool" in event.part)) return !("text" in event.part)
    const input = event.part.state.input as { op?: string; headSha?: string }
    return !(input.op === "finalize" || input.op === "write_candidate" || event.part.tool === "corvus_review_payload"
      || event.part.tool === "corvus_review_verify" || event.part.tool === "subagent"
      || event.part.tool === "corvus_review_verdict" && input.headSha)
  })
  const metaEvent = events.find((event): event is ReturnType<typeof toolEvent> => "tool" in event.part && (event.part.state.input as { op?: string }).op === "write_meta")!
  Object.assign(metaEvent.part.state.input, { meta })
  events.push({ type: "text", sessionID: "ses_smoke", part: { text: "Checkpoint failed: finalize part 0 incomplete-staging. Review must be rerun. state_sync: false; skipped pull and push." } })
  for (const file of ["REVIEW_DOCUMENT.md", "verdict.yaml"]) rmSync(join(data.root, data.input.head, file))
  for (const file of ["candidate.json", "post-request.json"]) rmSync(join(data.root, file), { force: true })
  writeFileSync(join(data.root, data.input.head, "meta.yaml"), dump(meta))
  const save = (items: object[]) => {
    writeFileSync(data.input.jsonl, items.map(event => JSON.stringify(event)).join("\n"))
    const db = new Database(data.input.db!)
    db.run("delete from part where session_id = ?", ["ses_smoke"])
    seedParent(db, items)
    db.close()
  }
  save(events)
  const result = await checkReviewArtifacts(data.input)
  expect(result.rows.filter(row => !row.ok)).toEqual([])
  expect(result.rows.find(row => row.check === "document staged")?.detail).toStartWith("N/A-PASS:")
  const verdictCall = toolEvent("corvus_review_verdict", { op: "compute", reviewRoot: relative, headSha: data.input.head }, { ok: false, reason: "not-found" })
  save([...events.slice(0, -1), verdictCall, events.at(-1)!])
  expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "checkpoint-failed route")).toMatchObject({ ok: false })
  save(events)
  writeFileSync(join(data.root, "lock.yaml"), "status: active\n")
  expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "lock released")).toMatchObject({ ok: false })
})

test("sync summaries accept only the receipt SHA or its seven-plus-character prefix with a sync token in the same sentence", async () => {
  const data = await fixture(false, "local")
  const stateCommit = git(data.input.bare!, "rev-parse", data.input.branch!)
  const different = (stateCommit[0] === "a" ? "b" : "a") + stateCommit.slice(1)
  const check = async (summary: string, ok: boolean) => {
    writeFileSync(data.input.jsonl, [...data.events.slice(0, -1), { type: "text", sessionID: "ses_smoke", part: { text: summary } }].map(event => JSON.stringify(event)).join("\n"))
    expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "sync terminal summary"), summary).toMatchObject({ ok })
  }
  for (const length of [7, 8, 40]) for (const token of ["state_commit", "synchronized", "synchronised", "synced", "committed", "pushed"]) {
    await check(`Review state ${token} in commit \`${stateCommit.slice(0, length)}\`.`, true)
  }
  for (const summary of [
    `Review state synchronized in commit ${different.slice(0, 8)}.`,
    `Review state synchronized in commit ${stateCommit.slice(0, 8)}${stateCommit[8] === "a" ? "b" : "a"}.`,
    `Review state synchronized in commit ${stateCommit.slice(0, 6)}.`,
    `Review state synchronized in commit ${stateCommit}a.`,
    `Review state synchronized in commit x${stateCommit.slice(0, 8)}.`,
    `Review saved in commit ${stateCommit}.`,
    `Review state synchronized. Commit ${stateCommit}.`,
    `Review state synchronized\nCommit ${stateCommit}.`,
  ]) await check(summary, false)
}, 15_000)

test("first sync and unchanged-state resume have one state-only commit; duplicate and stray-path commits fail", async () => {
  for (const layout of ["plain", "task"] as const) {
    const data = await fixture(false, "url", layout)
    const first = git(data.input.bare!, "rev-parse", data.input.branch!)
    expect(await push(data.pushInput, { exec: data.exec })).toMatchObject({ synced: true, state_commit: first })
    expect((await checkReviewArtifacts(data.input)).rows.filter(row => !row.ok)).toEqual([])
    writeFileSync(join(data.root, "extra.yaml"), "extra: state\n")
    expect(await push(data.pushInput, { exec: data.exec })).toMatchObject({ synced: true })
    expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "state commit count")).toMatchObject({ ok: false, detail: "2 state commits in bare branch history" })
    git(data.input.fixture, "reset", "--soft", data.input.head)
    writeFileSync(join(data.input.fixture, "stray.txt"), "not review state\n")
    git(data.input.fixture, "add", "stray.txt")
    git(data.input.fixture, "commit", "-m", `corvus(review-state): pr8 @ ${data.input.head.slice(0, 7)} [skip ci]`)
    git(data.input.bare!, "fetch", data.input.fixture, `HEAD:refs/heads/stray-fixture`)
    git(data.input.bare!, "update-ref", `refs/heads/${data.input.branch}`, git(data.input.fixture, "rev-parse", "HEAD"))
    const checked = await checkReviewArtifacts(data.input)
    expect(checked.rows.find(row => row.check === "state commit scope")).toMatchObject({ ok: false })
    expect(checked.rows.find(row => row.check === "state commit count")).toMatchObject({ ok: true })
  }
})

test("state_sync:false, LOCAL without upstream and forks require final reasoned notes, zero pushes and no state commits", async () => {
  for (const [intake, mode, reason] of [["url", "disabled", "state_sync"], ["local", "no-upstream", "no upstream"], ["url", "fork", "fork"]] as const) {
    const data = await fixture(false, intake, "plain", mode)
    const result = await checkReviewArtifacts(data.input)
    expect(result.rows.filter(row => !row.ok)).toEqual([])
    expect(result.rows.find(row => row.check === "state commit count")?.detail).toStartWith("0 state commits in bare branch history")
    const row = async () => (await checkReviewArtifacts(data.input)).rows.find(row => row.check === "sync terminal summary")
    const baseline = data.events.slice(0, -1)
    const note = `Remote review-state synchronization was skipped because of ${reason}.`
    const final = (text: string, sessionID = "ses_smoke") => ({ type: "text", sessionID, part: { text } })
    const save = (events: object[]) => writeFileSync(data.input.jsonl, events.map(event => JSON.stringify(event)).join("\n"))
    for (const text of [`synced:false; reason: ${reason}`, `synced=false\nreason: ${reason}`, note,
      `Synchronization refused: ${reason}.`, `Not synchronized because of ${reason}.`]) {
      save([...baseline, final(text)])
      expect(await row(), text).toMatchObject({ ok: true })
    }
    for (const text of ["synced:false", "Synchronization was skipped.", `${reason}.`, `Synchronization was skipped. Reason: ${reason}.`]) {
      save([...baseline, final(text)])
      expect(await row(), text).toMatchObject({ ok: false })
    }
    save([...baseline, final(note), final("Review complete.")])
    expect(await row()).toMatchObject({ ok: false })
    save([...baseline, final("Review complete."), final(note, "ses_child")])
    expect(await row()).toMatchObject({ ok: false })
    const release = baseline.findIndex(event => "tool" in event.part && (event.part.state.input as { op?: string }).op === "release")
    save([...baseline.slice(0, release), final(note), ...baseline.slice(release)])
    expect(await row()).toMatchObject({ ok: false })
    writeFileSync(data.input.jsonl, data.events.slice(0, -1).map(event => JSON.stringify(event)).join("\n"))
    expect(await row()).toMatchObject({ ok: false })
  }
}, 15_000)

test.each(["url", "branch"] as const)("%s fork sync requires refusal evidence and an unchanged bare branch", async intake => {
  const data = await fixture(false, intake, "plain", "fork")
  const baseline = structuredClone(data.events)
  const save = (events: object[]) => {
    writeFileSync(data.input.jsonl, events.map(event => JSON.stringify(event)).join("\n"))
    const db = new Database(data.input.db!)
    db.run("delete from part where session_id = ?", ["ses_smoke"])
    seedParent(db, events)
    db.close()
  }
  const syncOp = (event: typeof baseline[number], op: string) => "tool" in event.part && event.part.tool === "corvus_review_sync" && (event.part.state.input as { op?: string }).op === op
  const result = await checkReviewArtifacts(data.input)
  expect(result.rows.filter(row => !row.ok)).toEqual([])
  expect(result.exitCode).toBe(0)
  expect(reviewRoot(data.input)).toBe(".corvus/reviews/pr8")
  expect(result.rows.some(row => ["sync receipt", "state commit scope"].includes(row.check))).toBe(false)
  expect(result.rows.find(row => row.check === "fork bare unchanged")).toMatchObject({ ok: true })
  save(baseline.filter(event => !syncOp(event, "pull")))
  expect((await checkReviewArtifacts(data.input)).rows.filter(row => !row.ok)).toEqual([])
  for (const [mutation, check] of [
    ["missing-note", "sync terminal summary"], ["wrong-reason", "sync.push"], ["early-push", "sync.push"],
    ["wrong-cross-repo", "sync.resolve"],
  ]) {
    const events = structuredClone(baseline)
    const pushed = events.find(event => syncOp(event, "push"))! as ReturnType<typeof toolEvent>
    if (mutation === "missing-note") {
      const terminal = events.at(-1)!
      if ("text" in terminal.part && typeof terminal.part.text === "string") terminal.part.text = terminal.part.text.replace("synced: false; reason: fork", "")
    }
    if (mutation === "wrong-reason") pushed.part.state.output = JSON.stringify({ synced: false, reason: "no-eligible-remote", git_calls: 2 })
    if (mutation === "early-push") events.unshift(events.splice(events.indexOf(pushed), 1)[0])
    if (mutation === "wrong-cross-repo") {
      const resolved = events.find(event => syncOp(event, "resolve"))! as ReturnType<typeof toolEvent>
      Object.assign((resolved.part.state.input as { pr: object }).pr, { isCrossRepository: false })
    }
    save(events)
    const checked = await checkReviewArtifacts(data.input)
    expect(checked.exitCode, mutation).toBe(5)
    expect(checked.rows.find(row => row.check === check), mutation).toMatchObject({ ok: false })
  }
  save(baseline)
  const beforePath = join(data.input.fixture, "../bare-tip-before"), before = readFileSync(beforePath)
  rmSync(beforePath)
  expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "fork bare unchanged")).toMatchObject({ ok: false })
  writeFileSync(beforePath, before)
  git(data.input.fixture, "add", "--", ".corvus/reviews/pr8")
  git(data.input.fixture, "commit", "--only", "-m", `corvus(review-state): pr8 @ ${data.input.head.slice(0, 7)} [skip ci]`, "--", ".corvus/reviews/pr8")
  git(data.input.bare!, "fetch", data.input.fixture, `HEAD:refs/heads/${data.input.branch}`)
  const mutated = await checkReviewArtifacts(data.input)
  expect(mutated.exitCode).toBe(5)
  expect(mutated.rows.find(row => row.check === "fork bare unchanged")).toMatchObject({ ok: false })
  expect(mutated.rows.find(row => row.check === "state commit count")).toMatchObject({ ok: false, detail: "1 state commits in bare branch history since pre-run tip" })
})

test("v2 marker and filtered gatherer/detector inventories are required", async () => {
  const data = await fixture()
  const candidate = join(data.root, "candidate.json"), original = readFileSync(candidate, "utf8")
  writeFileSync(candidate, original.replace("corvus-review v2", "corvus-review v1"))
  expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "marker v2")).toMatchObject({ ok: false })
  writeFileSync(candidate, original)
  for (const agent of ["pr-context-gatherer", "pr-code-reviewer", "security-reviewer"]) {
    const db = new Database(data.input.db!)
    db.run("update session set agent = ? where id = 'ses_gatherer'", [agent])
    db.run("update part set data = ? where id = 'gatherer_0'", [JSON.stringify({ type: "tool", tool: "corvus_review_pr",
      state: { status: "completed", input: { op: "files" }, output: JSON.stringify({ ok: true, files: [{ filename: ".corvus/tasks/feature/PLAN.md" }] }) } })])
    db.close()
    expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "review inventories"), agent).toMatchObject({ ok: false })
  }
})

test("review-input.json lines over the read-tool limit fail the gate; chunked long values and the boundary pass; a missing file fails closed", async () => {
  const data = await fixture()
  writeFileSync(join(data.root, "lock.yaml"), "status: completed\n")
  const path = join(data.root, "review-input.json")
  const row = async () => (await checkReviewArtifacts(data.input)).rows.find(row => row.check === "review-input lines")
  expect(REVIEW_INPUT_LINE_LIMIT).toBe(1900)
  // Positive: the observed defect shape (PR description as one 2,963-char JSON line) stored chunked at 1,500 passes.
  const description = "## Summary\n\n" + "Corvus is a V1 plugin. ".repeat(130)
  const chunks: string[] = []
  for (let start = 0; start < description.length; start += 1500) chunks.push(description.slice(start, start + 1500))
  writeFileSync(path, JSON.stringify({ pr_number: 8, description_chunks: chunks }, null, 2) + "\n")
  expect(description.length).toBeGreaterThan(2000)
  const chunked = await checkReviewArtifacts(data.input)
  expect(chunked.exitCode).toBe(0)
  expect(chunked.rows.find(row => row.check === "review-input lines")).toMatchObject({ ok: true })
  // Negative: the observed defect — a compact 2,963-char description line — fails with exit 5 and names the line.
  writeFileSync(path, JSON.stringify({ pr_number: 8, description }, null, 2) + "\n")
  const truncated = await checkReviewArtifacts(data.input)
  expect(truncated.exitCode).toBe(5)
  expect(truncated.rows.find(row => row.check === "review-input lines")).toMatchObject({ ok: false })
  expect(truncated.rows.find(row => row.check === "review-input lines")?.detail).toMatch(/^1 line\(s\) over 1900 chars: line 3 \(\d+\)$/)
  // Boundary: exactly the limit passes; one more character fails; compact single-line JSON over the limit also fails.
  writeFileSync(path, `{\n  "pr_number": 8,\n  "description": "${"y".repeat(REVIEW_INPUT_LINE_LIMIT - '  "description": ""'.length)}"\n}\n`)
  expect(await row()).toMatchObject({ ok: true })
  writeFileSync(path, `{\n  "pr_number": 8,\n  "description": "${"y".repeat(REVIEW_INPUT_LINE_LIMIT - '  "description": ""'.length + 1)}"\n}\n`)
  expect(await row()).toMatchObject({ ok: false })
  writeFileSync(path, JSON.stringify({ pr_number: 8, description_chunks: chunks }) + "\n")
  expect(await row()).toMatchObject({ ok: false })
  // Negative: a missing file is missing evidence, not a pass.
  rmSync(path)
  expect(await row()).toMatchObject({ ok: false, detail: "missing review-input.json" })
  expect((await checkReviewArtifacts(data.input)).exitCode).toBe(5)
})

test("tool-owned state rejects missing operations, bad ownership and model writes regardless of size or success", async () => {
  const data = await fixture()
  const path = join(data.root, data.input.head, "REVIEW_DOCUMENT.md")
  const call = (name: string, input: object, status = "completed") => ({
    type: "tool_use", sessionID: "ses_smoke", part: { tool: name, state: { status, input } },
  })
  const save = (events: object[]) => writeFileSync(data.input.jsonl, events.map(event => JSON.stringify(event)).join("\n") + "\n")
  for (const op of ["acquire", "release", "finalize", "write_input", "write_candidate"]) {
    const events = data.events.filter(event => !("tool" in event.part && (event.part.state.input as { op?: string }).op === op))
    save(events)
    expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "review-state tools")?.ok).toBe(false)
  }
  for (const name of ["write", "edit", "apply_patch"]) for (const status of ["completed", "error"]) {
    const input = name === "apply_patch" ? { patchText: `*** Begin Patch\n*** Add File: ${path}\n+${"x".repeat(26000)}\n*** End Patch` }
      : { filePath: path, content: "x".repeat(26000) }
    save([...data.events, call(name, input, status)])
    expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "model state writes")?.ok).toBe(false)
  }
  save([...data.events, call("apply_patch", { patchText: "*** Begin Patch\n*** Update File: outside.md\n*** Move to: .corvus/reviews/x/candidate.json\n*** End Patch" })])
  expect((await checkReviewArtifacts(data.input)).exitCode).toBe(5)
  const wrongOwner = JSON.parse(JSON.stringify(data.events))
  wrongOwner.find((event: { part: { state?: { input?: { op?: string } } } }) => event.part.state?.input?.op === "release").part.state.input.runId = "other"
  save(wrongOwner)
  expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "review-state tools")?.ok).toBe(false)
  data.saveEvents()
  expect((await checkReviewArtifacts(data.input)).exitCode).toBe(0)
  writeFileSync(path, " \n")
  expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "checkpoint writes")?.ok).toBe(false)
}, 15_000)

test("R0 verdict requires the orchestrator's history-only call and matching DB result before any review dispatch", async () => {
  const data = await fixture()
  const baseline = data.events.filter((event): event is ReturnType<typeof toolEvent> => "tool" in event.part)
  const historyIndex = baseline.findIndex(event => event.part.tool === "corvus_review_verdict")
  const save = (events: object[]) => writeFileSync(data.input.jsonl, events.map(event => JSON.stringify(event)).join("\n") + "\n")
  const row = async () => (await checkReviewArtifacts(data.input)).rows.find(row => row.check === "R0 verdict")
  expect(await row()).toMatchObject({ ok: true })
  for (const mutation of ["missing", "child", "head-only", "late", "error", "wrong-call", "forged-result"]) {
    const events = structuredClone(baseline), history = events[historyIndex]
    if (mutation === "missing") events.splice(historyIndex, 1)
    if (mutation === "child") history.sessionID = "ses_gatherer"
    if (mutation === "head-only") Object.assign(history.part.state.input, { headSha: data.input.head })
    if (mutation === "late") events.splice(historyIndex + 1, 0, events.splice(historyIndex, 1)[0])
    if (mutation === "error") history.part.state.status = "error"
    if (mutation === "wrong-call") history.part.callID = "unrecorded"
    if (mutation === "forged-result") history.part.state.output = JSON.stringify({ ...historyVerdict, round: 5 })
    save(events)
    expect(await row(), mutation).toMatchObject({ ok: false })
  }
  save(baseline)
  const db = new Database(data.input.db!)
  db.run("delete from part where session_id = ?", ["ses_smoke"])
  seedParent(db, baseline)
  db.run("update part set time_created = -1 where session_id = ? and json_extract(data, '$.tool') = 'task'", ["ses_smoke"])
  db.close()
  expect(await row()).toMatchObject({ ok: false })
})

test("history refusal continues only with the persisted tool flag and a note in the final summary", async () => {
  const data = await fixture()
  const events = structuredClone(data.events)
  const history = events.find((event): event is ReturnType<typeof toolEvent> => "tool" in event.part && event.part.tool === "corvus_review_verdict")!
  history.part.state.output = JSON.stringify({ ...historyVerdict, refuse_delta: true, refuse_reason: "missing-history" })
  const meta = { ...verdictMeta(data.input.head), refuse_delta: true, refuse_reason: "missing-history" }
  const metaEvent = events.find((event): event is ReturnType<typeof toolEvent> => "tool" in event.part && (event.part.state.input as { op?: string }).op === "write_meta")!
  Object.assign(metaEvent.part.state.input, { meta })
  const final = events.at(-1)!
  if (!("text" in final.part)) throw new Error("missing final text")
  final.part.text += "\nNote: refuse_delta: true — reviewing once with a history-gap note."
  const save = () => {
    writeFileSync(join(data.root, data.input.head, "meta.yaml"), dump(meta))
    writeFileSync(data.input.jsonl, events.map(event => JSON.stringify(event)).join("\n") + "\n")
    const db = new Database(data.input.db!)
    db.run("delete from part where session_id = ?", ["ses_smoke"])
    seedParent(db, events)
    db.close()
  }
  save()
  expect((await checkReviewArtifacts(data.input)).rows.filter(row => !row.ok)).toEqual([])
  for (const mutation of ["meta", "write-meta", "summary", "earlier-only"]) {
    save()
    if (mutation === "meta") writeFileSync(join(data.root, data.input.head, "meta.yaml"), dump(verdictMeta(data.input.head)))
    if (mutation === "write-meta") {
      const changed = structuredClone(events)
      const item = changed.find((event): event is ReturnType<typeof toolEvent> => "tool" in event.part && (event.part.state.input as { op?: string }).op === "write_meta")!
      Object.assign(item.part.state.input, { meta: verdictMeta(data.input.head) })
      writeFileSync(data.input.jsonl, changed.map(event => JSON.stringify(event)).join("\n"))
    }
    if (mutation === "summary" || mutation === "earlier-only") {
      const changed = [...(mutation === "earlier-only" ? [final] : []), ...events.slice(0, -1),
        { type: "text", sessionID: "ses_smoke", part: { text: "Review complete." } }]
      writeFileSync(data.input.jsonl, changed.map(event => JSON.stringify(event)).join("\n"))
    }
    const result = await checkReviewArtifacts(data.input)
    expect(result.exitCode, mutation).toBe(5)
    expect(result.rows.find(row => row.check === "continuation note"), mutation).toMatchObject({ ok: false })
  }
})

test("LOCAL fixture passes the whole checker without posting artifacts and rejects missing state, summary or forbidden work", async () => {
  const data = await fixture(false, "local")
  const baseline = await checkReviewArtifacts(data.input)
  expect(baseline.rows.filter(row => !row.ok)).toEqual([])
  expect(baseline.exitCode).toBe(0)
  for (const name of ["tool chain", "SHA-256", "built verify()", "writer denied", "R5 PR transport"]) {
    expect(baseline.rows.some(row => row.check === name)).toBe(false)
  }
  const path = join(data.root, data.input.head, "REVIEW_DOCUMENT.md"), document = readFileSync(path)
  rmSync(path)
  expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "artifacts")).toMatchObject({ ok: false })
  writeFileSync(path, document)
  const save = (events: object[]) => writeFileSync(data.input.jsonl, events.map(event => JSON.stringify(event)).join("\n"))
  save(data.events.filter(event => !("tool" in event.part && (event.part.state.input as { op?: string }).op === "release")))
  expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "lock released")).toMatchObject({ ok: false })
  for (const event of [
    toolEvent("task", { subagent_type: "pr-comment-writer" }, {}, "Subagent denied"),
    toolEvent("corvus_review_post", {}, {}),
    toolEvent("corvus_review_persist", { op: "write_candidate" }, {}),
    ...["measure", "freeze"].map(op => toolEvent("corvus_review_payload", { op }, {})),
  ]) {
    save([...data.events, event])
    expect((await checkReviewArtifacts(data.input)).exitCode).toBe(6)
  }
  for (const text of ["Review complete.", `Standards: 1; Spec: 1.`, `${path}\nStandards: 99; Spec: 1.`]) {
    save([...data.events.slice(0, -1), { type: "text", sessionID: "ses_smoke", part: { text } }])
    expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "LOCAL terminal summary")).toMatchObject({ ok: false })
  }
  data.saveEvents()
  writeFileSync(data.input.audit, JSON.stringify({ marker: "CORVUS_SMOKE_MUTATION_BLOCKED", argv: ["pr", "comment", "8"] }))
  expect((await checkReviewArtifacts(data.input)).exitCode).toBe(6)
  writeFileSync(data.input.audit, JSON.stringify({ marker: "CORVUS_SMOKE_GH_FORWARD", argv: ["pr", "view", "8", "--method", "POST"] }))
  expect((await checkReviewArtifacts(data.input)).exitCode).toBe(6)
}, 15_000)

test("branch fixture requires the fixture PR's DB-matched find result before the first metadata call", async () => {
  const data = await fixture(false, "branch")
  expect((await checkReviewArtifacts(data.input)).rows.filter(row => !row.ok)).toEqual([])
  for (const mutation of ["missing", "late", "not-found", "wrong-pr", "no-result", "DB-mismatch"]) {
    const events = structuredClone(data.events)
    const found = events[0]
    if (!("tool" in found.part)) throw new Error("missing find fixture")
    if (mutation === "missing") events.shift()
    if (mutation === "late") events.splice(1, 0, events.shift()!)
    if (mutation === "not-found") found.part.state.output = JSON.stringify({ ok: true, found: false, candidates: [] })
    if (mutation === "wrong-pr") found.part.state.output = JSON.stringify({ ok: true, found: true, number: 9, url: "https://github.com/owner/repo/pull/9" })
    if (mutation === "no-result") found.part.state.status = "error"
    if (mutation === "DB-mismatch") found.part.callID = "missing-call"
    writeFileSync(data.input.jsonl, events.map(event => JSON.stringify(event)).join("\n"))
    const result = await checkReviewArtifacts(data.input)
    expect(result.exitCode, mutation).toBe(5)
    expect(result.rows.find(row => row.check === "find resolved"), mutation).toMatchObject({ ok: false })
  }
})

test("R4 verdict rejects missing, stale, late or non-DB results and accepts every recorded decision form", async () => {
  const data = await fixture()
  const baseline = data.events.filter((event): event is ReturnType<typeof toolEvent> => "tool" in event.part)
  const headIndex = baseline.findLastIndex(event => event.part.tool === "corvus_review_verdict")
  const save = (events: object[]) => writeFileSync(data.input.jsonl, events.map(event => JSON.stringify(event)).join("\n") + "\n")
  const row = async () => (await checkReviewArtifacts(data.input)).rows.find(row => row.check === "R4 verdict")
  expect(await row()).toMatchObject({ ok: true })
  for (const mutation of ["missing", "wrong-head", "wrong-root", "error", "before-document", "after-freeze", "duplicate-call", "forged-result", "later-failure"]) {
    const events = structuredClone(baseline), head = events[headIndex]
    if (mutation === "missing") events.splice(headIndex, 1)
    if (mutation === "wrong-head") Object.assign(head.part.state.input, { headSha: "b".repeat(40) })
    if (mutation === "wrong-root") Object.assign(head.part.state.input, { reviewRoot: ".corvus/reviews/other__repo__pr8" })
    if (mutation === "error") head.part.state.status = "error"
    if (mutation === "before-document") events.splice(3, 0, events.splice(headIndex, 1)[0])
    if (mutation === "after-freeze") events.splice(headIndex + 1, 0, events.splice(headIndex, 1)[0])
    if (mutation === "duplicate-call") head.part.callID = events[1].part.callID
    if (mutation === "forged-result") head.part.state.output = JSON.stringify({ ...verdict, converged: true })
    if (mutation === "later-failure") events.splice(headIndex + 1, 0, toolEvent("corvus_review_verdict", head.part.state.input, { ok: false, reason: "invalid-document" }))
    save(events)
    expect(await row(), mutation).toMatchObject({ ok: false })
  }
  for (const decision of [
    toolEvent("question", { questions: [] }, {}),
    toolEvent("corvus_review_persist", { op: "write_meta", reviewRoot: ".corvus/reviews/pr8", headSha: data.input.head, name: "decision.yaml", meta: { REVIEW_ACTION: { decision: "local_only" } } }, { ok: true }),
    { type: "text", sessionID: "ses_smoke", part: { text: "[R4 COMPLETE] local_only; rail applied" } },
  ]) {
    save([...baseline.slice(0, headIndex + 1), decision, ...baseline.slice(headIndex + 2)])
    expect(await row()).toMatchObject({ ok: true })
    save([...baseline.slice(0, headIndex), decision, ...baseline.slice(headIndex)])
    expect(await row()).toMatchObject({ ok: false })
  }
  save(baseline)
  const db = new Database(data.input.db!)
  db.run("delete from part where session_id = ? and json_extract(data, '$.tool') = 'corvus_review_verdict'", ["ses_smoke"])
  db.close()
  expect(await row()).toMatchObject({ ok: false })
  expect((await checkReviewArtifacts({ ...data.input, db: undefined })).rows.find(row => row.check === "R0 verdict")).toMatchObject({ ok: false })
}, 15_000)

test("verdict identity prefers code_head, falls back to headSha and requires both absent for history", async () => {
  const data = await fixture()
  const save = (events: object[]) => {
    writeFileSync(data.input.jsonl, events.map(event => JSON.stringify(event)).join("\n"))
    const db = new Database(data.input.db!)
    db.run("delete from part where session_id = ?", ["ses_smoke"])
    seedParent(db, events)
    db.close()
  }
  for (const [identity, ok] of [
    [{ code_head: data.input.head }, true], [{ headSha: data.input.head }, true],
    [{ code_head: data.input.head, headSha: "b".repeat(40) }, true],
    [{ code_head: "b".repeat(40), headSha: data.input.head }, false], [{}, false],
  ] as const) {
    const events = structuredClone(data.events)
    const head = events.findLast((event): event is ReturnType<typeof toolEvent> => "tool" in event.part && event.part.tool === "corvus_review_verdict")!
    Reflect.deleteProperty(head.part.state.input, "headSha")
    Object.assign(head.part.state.input, identity)
    save(events)
    const checked = await checkReviewArtifacts(data.input)
    expect(checked.rows.find(row => row.check === "R0 verdict")).toMatchObject({ ok: true })
    for (const check of ["R4 verdict", "verdict persisted", "verdict document counts"]) {
      expect(checked.rows.find(row => row.check === check), `${check}: ${JSON.stringify(identity)}`).toMatchObject({ ok })
    }
  }
  for (const key of ["code_head", "headSha"]) {
    const events = structuredClone(data.events)
    const history = events.find((event): event is ReturnType<typeof toolEvent> => "tool" in event.part && event.part.tool === "corvus_review_verdict")!
    Object.assign(history.part.state.input, { [key]: data.input.head })
    save(events)
    expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "R0 verdict"), key).toMatchObject({ ok: false })
  }
})

test("verdict persisted compares the complete file to the DB tool result and requires only a metadata pointer", async () => {
  const data = await fixture(), path = join(data.root, data.input.head, "verdict.yaml")
  const metaPath = join(data.root, data.input.head, "meta.yaml")
  const row = async () => (await checkReviewArtifacts(data.input)).rows.find(row => row.check === "verdict persisted")
  expect(await row()).toMatchObject({ ok: true })
  rmSync(path)
  expect(await row()).toMatchObject({ ok: false, detail: "missing/invalid verdict.yaml" })
  for (const field of ["ok", "round", "converged", "convergence_reason", "counts", "caps_applied", "refuse_delta", "missing_history", "computed_at"]) {
    const stored: Record<string, unknown> = persistedVerdict()
    delete stored[field]
    writeFileSync(path, dump(stored))
    expect(await row(), field).toMatchObject({ ok: false })
  }
  for (const mutation of ["axis", "total", "origin", "missing-origin", "actionable", "round", "converged", "caps", "refusal", "extra"]) {
    const stored = persistedVerdict()
    if (mutation === "axis") [stored.counts.standards, stored.counts.spec] = [stored.counts.spec, stored.counts.standards]
    if (mutation === "total") stored.counts.total.major++
    if (mutation === "origin") stored.counts.by_origin["review-fix"].total.major++
    if (mutation === "missing-origin") Reflect.deleteProperty(stored.counts, "by_origin")
    if (mutation === "actionable") stored.counts.actionable_total++
    if (mutation === "round") stored.round++
    if (mutation === "converged") stored.converged = true
    if (mutation === "caps") stored.caps_applied.max_nits++
    if (mutation === "refusal") Object.assign(stored, { refuse_reason: "invented" })
    if (mutation === "extra") Object.assign(stored, { extra: true })
    writeFileSync(path, dump(stored))
    expect(await row(), mutation).toMatchObject({ ok: false })
  }
  writeFileSync(path, dump(persistedVerdict()))
  writeFileSync(metaPath, dump({ ...verdictMeta(data.input.head), series_round: 99, series_converged: true, counts: {} }))
  expect(await row()).toMatchObject({ ok: true })
  for (const pointer of [undefined, "other.yaml", "../verdict.yaml"]) {
    writeFileSync(metaPath, dump({ ...verdictMeta(data.input.head), verdict_file: pointer }))
    expect(await row()).toMatchObject({ ok: false })
  }
  writeFileSync(metaPath, dump(verdictMeta(data.input.head)))
  const metaEvent = data.events.find(event => "tool" in event.part && (event.part.state.input as { op?: string }).op === "write_meta")!
  if (!("tool" in metaEvent.part)) throw new Error("missing metadata fixture")
  Object.assign(metaEvent.part.state.input, { meta: { ...verdictMeta(data.input.head), verdict_file: "other.yaml" } })
  data.saveEvents()
  expect(await row()).toMatchObject({ ok: false })
}, 15_000)

test("metadata shows and requires the intake's explicit pr or local mode", async () => {
  for (const intake of ["url", "local"] as const) {
    const data = await fixture(false, intake), mode = intake === "local" ? "local" : "pr"
    const row = async () => (await checkReviewArtifacts(data.input)).rows.find(row => row.check === "metadata")
    expect(await row()).toMatchObject({ ok: true, detail: expect.stringContaining(`mode=${mode}`) })
    for (const invalid of [undefined, "unknown", mode === "pr" ? "local" : "pr"]) {
      writeFileSync(join(data.root, data.input.head, "meta.yaml"), dump({ ...verdictMeta(data.input.head), mode: invalid }))
      expect(await row()).toMatchObject({ ok: false })
    }
  }
})

test("REVIEW_DOCUMENT summary and axis counts cannot disagree with the DB verdict even when metadata agrees", async () => {
  const data = await fixture(), path = join(data.root, data.input.head, "REVIEW_DOCUMENT.md")
  const row = async () => (await checkReviewArtifacts(data.input)).rows.find(row => row.check === "verdict document counts")
  expect(await row()).toMatchObject({ ok: true })
  for (const mutation of ["total", "axis", "actionable", "grand-total", "round", "converged", "counts", "missing-stats"]) {
    const document = reviewDocument()
    if (mutation === "total") document.summary.stats.majors++
    if (mutation === "axis") [document.summary.by_axis.standards, document.summary.by_axis.spec] = [document.summary.by_axis.spec, document.summary.by_axis.standards]
    if (mutation === "actionable") document.summary.by_axis.standards.stats.actionable++
    if (mutation === "grand-total") document.summary.stats.total_findings++
    if (mutation === "round") document.synthesis_controls.series_round++
    if (mutation === "converged") document.verdict = "converged"
    if (mutation === "counts") Object.assign(document, { counts: {} })
    if (mutation === "missing-stats") Object.assign(document.summary, { stats: {} })
    writeFileSync(path, documentMarkdown(document))
    expect(await row(), mutation).toMatchObject({ ok: false })
  }
  const document = reviewDocument()
  writeFileSync(path, `---\n${dump({ REVIEW_DOCUMENT: document })}---\n\n# Review\n`)
  expect(await row()).toMatchObject({ ok: true })
  writeFileSync(path, documentMarkdown(document) + `\n## Duplicate\n\n\`\`\`yaml\n${dump({ REVIEW_DOCUMENT: document })}\`\`\`\n`)
  expect(await row()).toMatchObject({ ok: false })
})

test("facts need write_facts provenance and terminal release follows posted, non-post and rail work", async () => {
  const data = await fixture()
  const baseline = data.events.filter((event): event is ReturnType<typeof toolEvent> => "tool" in event.part)
  const relative = ".corvus/reviews/pr8"
  const save = (events: object[]) => {
    writeFileSync(data.input.jsonl, events.map(event => JSON.stringify(event)).join("\n") + "\n")
    const db = new Database(data.input.db!)
    db.run("delete from part where session_id = ?", ["ses_smoke"])
    seedParent(db, events)
    db.close()
  }
  const releaseIndex = baseline.findIndex(event => (event.part.state.input as { op?: string }).op === "release")
  const row = async (name: string) => (await checkReviewArtifacts(data.input)).rows.find(row => row.check === name)
  expect(await row("verified facts tool")).toMatchObject({ ok: true })
  for (const mutation of ["missing", "child", "failed", "wrong-path", "after-release", "model-write"]) {
    const events = structuredClone(baseline)
    const index = events.findIndex(event => (event.part.state.input as { op?: string }).op === "write_facts"), facts = events[index]
    if (mutation === "missing" || mutation === "model-write") events.splice(index, 1)
    if (mutation === "child") facts.sessionID = "ses_gatherer"
    if (mutation === "failed") facts.part.state.output = JSON.stringify({ ok: false, reason: "storage-error" })
    if (mutation === "wrong-path") facts.part.state.output = JSON.stringify({ ok: true, path: `${relative}/other.yaml` })
    if (mutation === "after-release") events.push(events.splice(index, 1)[0])
    if (mutation === "model-write") events.push(toolEvent("write", { filePath: `${relative}/verified_facts.yaml`, content: "facts: []" }, {}))
    save(events)
    expect(await row("verified facts tool"), mutation).toMatchObject({ ok: false })
    if (mutation === "model-write") expect(await row("model state writes")).toMatchObject({ ok: false })
  }
  for (const status of ["posted", "local_only", "rail"]) {
    const terminal = toolEvent("corvus_review_persist", { op: "write_meta", reviewRoot: relative, headSha: data.input.head,
      name: "completion.yaml", meta: { status, reason: status === "rail" ? "hard rail" : null } }, { ok: true, path: `${relative}/${data.input.head}/completion.yaml` })
    const events = [...baseline.slice(0, releaseIndex), terminal, ...baseline.slice(releaseIndex)]
    save(events)
    expect(await row("lock released"), status).toMatchObject({ ok: true })
    save([...baseline, terminal])
    expect(await row("lock released"), status).toMatchObject({ ok: false })
    save(events.filter(event => (event.part.state.input as { op?: string }).op !== "release"))
    expect(await row("lock released"), status).toMatchObject({ ok: false })
  }
  for (const mutation of ["error", "owner", "before-writer"]) {
    const events = structuredClone(baseline), release = events[releaseIndex]
    if (mutation === "error") release.part.state.status = "error"
    if (mutation === "owner") Object.assign(release.part.state.input, { runId: "other" })
    if (mutation === "before-writer") events.splice(events.findIndex(event => event.part.tool === "subagent"), 0, events.splice(releaseIndex, 1)[0])
    save(events)
    expect(await row("lock released"), mutation).toMatchObject({ ok: false })
  }
  for (const tool of [
    toolEvent("corvus_review_sync", { op: "pull" }, { synced: true }),
    toolEvent("corvus_review_sync", { op: "resolve" }, { ok: true }),
    toolEvent("corvus_review_lock", { op: "status" }, { ok: true }),
    toolEvent("corvus_review_pr", { op: "head" }, { ok: true }),
    toolEvent("task", { subagent_type: "researcher" }, { status: "completed" }),
  ]) {
    save([...baseline, tool])
    expect(await row("sync.push")).toMatchObject({ ok: true })
    expect(await row("lock released"), tool.part.tool).toMatchObject({ ok: false })
  }
}, 15_000)

test("orchestrator shell admits only fixed checkout/auth diagnostics, never disguised or blocked gh reads", async () => {
  const data = await fixture()
  for (const [command, allowed] of [
    ["gh auth status", true], ["gh pr checkout 8 --repo owner/repo --detach", true],
    ["gh pr checkout 8 --repo owner/repo", false], ["gh pr view 8 --json headRefOid", false],
    ["gh api --method GET repos/owner/repo/pulls/8", false], ["gh api user --jq .login", false],
    ["env gh auth status", false], ["/usr/bin/gh pr view 8", false], ['g"h" pr view 8', false],
    ["gh auth status; gh pr checks 8", false], ["gh auth status && gh pr view 8", false],
    ["gh auth status\ngh pr view 8", false], ["gh auth status $(gh api user)", false],
  ] as const) {
    writeFileSync(data.input.jsonl, [...data.events, toolEvent("bash", { command }, {}, allowed ? undefined : "blocked")].map(event => JSON.stringify(event)).join("\n") + "\n")
    expect((await checkReviewArtifacts(data.input)).rows.find(row => row.check === "orchestrator GitHub reads"), command).toMatchObject({ ok: allowed })
  }
}, 15_000)

test("missing writer, reordered tools, active lock and tampered artifact cannot produce a green gate", async () => {
  const data = await fixture()
  data.events.splice(data.events.findIndex(event => "tool" in event.part && event.part.tool === "subagent"), 1)
  const [measured] = data.events.splice(data.events.findIndex(event => "tool" in event.part && event.part.tool === "corvus_review_payload"), 1)
  data.events.push(measured)
  data.saveEvents()
  writeFileSync(join(data.root, "lock.yaml"), "status: active\n")
  const path = join(data.root, "post-request.json")
  writeFileSync(path, readFileSync(path, "utf8").replace("Smoke review", "Changed review"))
  const result = await checkReviewArtifacts(data.input)
  expect(result.exitCode).toBe(5)
  for (const name of ["writer denied", "tool chain", "lock released", "SHA-256", "built verify()"]) expect(result.rows.find(row => row.check === name)?.ok).toBe(false)
  expect(result.rows.find(row => row.check === "writer denied")?.detail).toBe("stopped before writer dispatch")
})

test("blocked API writes are informational, but forwarded mutations take precedence over other failures", async () => {
  const data = await fixture()
  const argv = ["api", "repos/owner/repo/pulls/8/reviews", "-X", "POST"]
  writeFileSync(data.input.audit, JSON.stringify({ marker: "CORVUS_SMOKE_MUTATION_BLOCKED", argv }) + "\n")
  expect((await checkReviewArtifacts(data.input)).exitCode).toBe(0)
  writeFileSync(data.input.audit, JSON.stringify({ marker: "CORVUS_SMOKE_GH_FORWARD", argv }) + "\n")
  rmSync(join(data.root, "candidate.json"))
  const result = await checkReviewArtifacts(data.input)
  expect(result.exitCode).toBe(6)
  expect(result.audit.unsafe).toBe(1)
})

test("the audit accepts the fixed config GET header without allowing method or header overrides", async () => {
  const data = await fixture()
  const base = ["api", "--method", "GET", "repos/owner/repo/contents/.opencode/review-config.yaml?ref=" + "a".repeat(40)]
  const header = "Accept: application/vnd.github.raw+json"
  const cases: Array<[string[], boolean]> = [
    [[...base, "-H", header], true],
    [[...base, "--header", header], true],
    [[...base, "-H", header, "-X", "POST"], false],
    [[...base, "-H", header, "--header", "X-HTTP-Method-Override: DELETE"], false],
    [[...base, "-H", header + "\nX-HTTP-Method-Override: DELETE"], false],
    [[...base, "-H"], false],
  ]
  for (const [argv, allowed] of cases) {
    writeFileSync(data.input.audit, JSON.stringify({ marker: "CORVUS_SMOKE_GH_FORWARD", argv }) + "\n")
    const result = await checkReviewArtifacts(data.input)
    expect(result.exitCode).toBe(allowed ? 0 : 6)
    expect(result.audit.unsafe).toBe(allowed ? 0 : 1)
  }
})

test("no positive load, fallback agent, missing artifact and unexpected permission denial each fail", async () => {
  const data = await fixture()
  writeFileSync(data.input.hostlog, 'agent "corvus-review-auto" not found. Falling back to default agent\nPermission denied: read\npermission=edit resource=.corvus/reviews/x action.action=deny\n')
  rmSync(join(data.root, "review-input.json"))
  const result = await checkReviewArtifacts(data.input)
  expect(result.exitCode).toBe(3)
  for (const name of ["plugin loaded", "invoked agent", "artifacts", "unexpected denials"]) expect(result.rows.find(row => row.check === name)?.ok).toBe(false)
})

async function v1Fixture(inline = false, intake: Inputs["intake"] = "url", barrier: "denied" | "not-exposed" = "denied") {
  const data = await fixture(inline, intake, "plain", "normal", barrier)
  const directory = resolve(data.input.fixture, "..")
  const install = join(directory, "install/node_modules/corvus-ai")
  const agents = join(directory, "agents.json")
  writeFileSync(agents, JSON.stringify({
    name: "corvus-review-auto", native: false, prompt: "# Corvus Review Auto — Autonomous Orchestrator\n",
    tools: { corvus_review_payload: true, corvus_review_verify: true, corvus_review_post: false,
      corvus_review_persist: true, corvus_review_lock: true, corvus_review_pr: true, corvus_review_verdict: true, corvus_review_sync: true },
    permission: [
      { permission: "task", pattern: "pr-comment-writer", action: "deny" },
      { permission: "external_directory", pattern: `${install}/skill/corvus-review-r0/*`, action: "allow" },
    ],
  }))
  const input: Inputs = { ...data.input, host: "v1", agents, install }
  return { ...data, input, agents }
}

test("v1 accepts installed agent evidence without a load marker; v2 still requires the marker", async () => {
  const { input } = await v1Fixture()
  writeFileSync(input.hostlog, 'CORVUS_SMOKE_SESSION {"id":"ses_smoke","agent":"corvus-review-auto"}\n')
  const result = await checkReviewArtifacts(input)
  expect(result.exitCode).toBe(0)
  expect(result.rows.find(row => row.check === "plugin loaded")).toMatchObject({ ok: true })
  expect((await checkReviewArtifacts({ ...input, host: "v2" })).rows.find(row => row.check === "plugin loaded")?.ok).toBe(false)
})

test("v1 rejects agent evidence missing review tools even with a positive load marker", async () => {
  const { input, agents } = await v1Fixture()
  const agent = JSON.parse(readFileSync(agents, "utf8"))
  delete agent.tools
  writeFileSync(agents, JSON.stringify(agent))
  const result = await checkReviewArtifacts(input)
  expect(result.exitCode).toBe(3)
  expect(result.rows.find(row => row.check === "plugin loaded")).toMatchObject({ ok: false })
  expect(result.rows.find(row => row.check === "plugin loaded")?.detail).toContain("missing/invalid review tools")
})

test("the observed provider schema rejection is a host/plugin failure, not just missing artifacts", async () => {
  const data = await fixture()
  const message = "The model returned the following errors: tools.0.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level"
  writeFileSync(data.input.jsonl, readFileSync(data.input.jsonl, "utf8") + JSON.stringify({ type: "error", error: { type: "provider.invalid-request", message, status: 400 } }) + "\n")
  const result = await checkReviewArtifacts(data.input)
  expect(result.exitCode).toBe(3)
  expect(result.rows.find(row => row.check === "host/provider")).toMatchObject({ ok: false, detail: JSON.stringify({ type: "provider.invalid-request", message, status: 400 }) })
})

test("v1 rule-denial wording on the writer dispatch is ordered denial evidence, alongside the v2 wording", async () => {
  const v1Wording = 'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [{"permission":"task","pattern":"pr-comment-writer","action":"deny"}]'
  const v2 = await fixture()
  writeFileSync(join(v2.root, "lock.yaml"), "status: completed\n")
  expect((await checkReviewArtifacts(v2.input)).rows.find(row => row.check === "writer denied")).toMatchObject({ ok: true, detail: "Subagent denied: pr-comment-writer" })
  const { input } = await v1Fixture()
  const events = readFileSync(input.jsonl, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
  const writerEvent = events.find(event => event.part?.tool === "subagent")!
  writerEvent.part.tool = "task"
  writerEvent.part.state.input = { subagent_type: "pr-comment-writer", description: "Post review", prompt: "..." }
  writerEvent.part.state.error = v1Wording
  writeFileSync(input.jsonl, events.map(event => JSON.stringify(event)).join("\n") + "\n")
  const result = await checkReviewArtifacts(input)
  expect(result.exitCode).toBe(0)
  expect(result.rows.find(row => row.check === "writer denied")).toMatchObject({ ok: true, detail: v1Wording })
  expect(result.rows.find(row => row.check === "unexpected denials")).toMatchObject({ ok: true, detail: "none" })
  writerEvent.part.state.error = "Tool execution aborted"
  writeFileSync(input.jsonl, events.map(event => JSON.stringify(event)).join("\n") + "\n")
  const unmatched = await checkReviewArtifacts(input)
  expect(unmatched.exitCode).toBe(5)
  expect(unmatched.rows.find(row => row.check === "writer denied")).toMatchObject({ ok: false, detail: "writer dispatch lacks ordered denial evidence" })
})

test.each(["denied", "not-exposed"] as const)("non-writer PR gate accepts the %s route without requiring a writer result", async barrier => {
  const { input, root } = await v1Fixture(false, "branch", barrier)
  const result = await checkReviewArtifacts(input)
  expect(result.rows.filter(row => !row.ok)).toEqual([])
  expect(result.exitCode).toBe(0)
  for (const check of ["artifacts", "tool chain", "SHA-256", "built verify()", "writer denied"]) {
    expect(result.rows.find(row => row.check === check)).toMatchObject({ ok: true })
  }
  if (barrier === "not-exposed") {
    expect(existsSync(join(root, "post-request.json"))).toBe(false)
    expect(result.rows.find(row => row.check === "writer denied")?.detail).toStartWith("R4 writer not-exposed: measure=")
    rmSync(join(root, "candidate.json"))
    expect((await checkReviewArtifacts(input)).rows.filter(row => !row.ok)).toEqual([])
    expect((await checkReviewArtifacts({ ...input, host: "v2" })).rows.filter(row => !row.ok)).toEqual([])
    const full = await checkReviewArtifacts({ ...input, writer: true })
    expect(full.rows.find(row => row.check === "artifacts")).toMatchObject({ ok: false })
    expect(full.rows.find(row => row.check === "writer dispatched")).toMatchObject({ ok: false })
  }
})

test("R4 not-exposed requires measured, DB-matched local-only evidence and rejects any posting preparation or writer dispatch", async () => {
  const { input, root, events: baseline } = await v1Fixture(false, "branch", "not-exposed")
  const actionPath = join(root, input.head, "review-action.yaml"), actionBytes = readFileSync(actionPath)
  const save = (events: object[], stored = events) => {
    writeFileSync(input.jsonl, events.map(event => JSON.stringify(event)).join("\n"))
    const db = new Database(input.db!)
    db.run("delete from part where session_id = ?", ["ses_smoke"])
    seedParent(db, stored)
    db.close()
  }
  const tool = (events: typeof baseline, op: string) => events.find((event): event is ReturnType<typeof toolEvent> =>
    "tool" in event.part && (event.part.state.input as { op?: string }).op === op)!
  for (const mutation of ["missing-measure", "late-measure", "missing-action", "wrong-decision", "wrong-reason", "missing-rail", "DB-mismatch",
    "freeze", "verify", "post", "denied-writer", "completed-writer", "DB-only-freeze", "DB-only-writer", "child-writer", "artifact",
    "missing-no-post-note", "missing-writer-note", "earlier-note", "child-note"]) {
    const events = structuredClone(baseline)
    writeFileSync(actionPath, actionBytes)
    const action = events.find((event): event is ReturnType<typeof toolEvent> => "tool" in event.part
      && (event.part.state.input as { name?: string }).name === "review-action.yaml")!
    const actionMeta = (action.part.state.input as { meta: Record<string, unknown> }).meta
    if (mutation === "missing-measure") events.splice(events.indexOf(tool(events, "measure")), 1)
    if (mutation === "late-measure") events.splice(events.indexOf(action) + 1, 0, events.splice(events.indexOf(tool(events, "measure")), 1)[0])
    if (mutation === "missing-action") rmSync(actionPath)
    if (mutation === "wrong-decision") actionMeta.decision = "auto_post"
    if (mutation === "wrong-reason") actionMeta.decision_reason = "Writer denied"
    if (mutation === "missing-rail") actionMeta.rails_applied = []
    if (["wrong-decision", "wrong-reason", "missing-rail"].includes(mutation)) writeFileSync(actionPath, dump(actionMeta))
    const forbidden = mutation.includes("writer") && !mutation.includes("note")
      ? toolEvent("task", { subagent_type: "pr-comment-writer" }, {}, mutation === "completed-writer" ? undefined : "Subagent denied")
      : mutation.endsWith("freeze") ? toolEvent("corvus_review_payload", { op: "freeze" }, { ok: true })
      : mutation === "verify" ? toolEvent("corvus_review_verify", { op: "verify" }, { ok: true })
      : mutation === "post" ? toolEvent("corvus_review_post", {}, {}) : undefined
    if (forbidden && !mutation.startsWith("DB-only") && mutation !== "child-writer") events.splice(events.indexOf(action), 0, forbidden)
    if (mutation === "artifact") writeFileSync(join(root, "post-request.json"), "{}")
    const terminal = events.at(-1)!
    if (!("text" in terminal.part) || typeof terminal.part.text !== "string") throw new Error("missing terminal summary")
    if (mutation === "missing-no-post-note") terminal.part.text = terminal.part.text.replace("Nothing posted—the authorized", "The authorized")
    if (mutation === "missing-writer-note") terminal.part.text = terminal.part.text.replace("pr-comment-writer is not exposed by this host", "pr-comment-writer is unavailable")
    if (mutation === "earlier-note") {
      events.unshift(structuredClone(terminal))
      terminal.part.text = "Review complete."
    }
    if (mutation === "child-note") Object.assign(terminal, { sessionID: "ses_child" })
    const stored = structuredClone(events)
    if (mutation.startsWith("DB-only")) stored.push(forbidden!)
    if (mutation === "DB-mismatch") action.part.callID = "unrecorded"
    save(events, stored)
    if (mutation === "child-writer") {
      const db = new Database(input.db!)
      db.run("insert into session values (?, ?, ?, ?)", ["ses_writer", "ses_smoke", "pr-comment-writer", 3])
      db.close()
    }
    const result = await checkReviewArtifacts(input)
    expect(result.exitCode, mutation).toBe(mutation === "completed-writer" ? 6 : 5)
    expect(result.rows.find(row => row.check === "writer denied"), mutation).toMatchObject({ ok: false })
    if (mutation === "artifact") rmSync(join(root, "post-request.json"))
    if (mutation === "child-writer") {
      const db = new Database(input.db!)
      db.run("delete from session where id = ?", ["ses_writer"])
      db.close()
    }
  }
  writeFileSync(actionPath, actionBytes)
  save(baseline)
  writeFileSync(input.audit, JSON.stringify({ marker: "CORVUS_SMOKE_GH_FORWARD", argv: ["api", "repos/owner/repo/pulls/8/reviews", "-X", "POST"] }))
  const mutation = await checkReviewArtifacts(input)
  expect(mutation.exitCode).toBe(6)
  expect(mutation.rows.find(row => row.check === "GitHub barrier")).toMatchObject({ ok: false })
}, 15_000)

test("CLI emits one SMOKE_RESULT JSON line with per-check status and the process exit code", async () => {
  const { input, root } = await fixture()
   const args = [input.fixture, input.owner, input.repo, input.pr, input.head, input.jsonl, input.hostlog, input.audit, "--db", input.db!, "--bare", input.bare!, "--branch", input.branch!]
  const run = async (argv: string[]) => {
    const child = Bun.spawn([process.execPath, "run", resolve(import.meta.dirname, "../../scripts/check-review-artifacts.ts"), ...argv], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const summaries = stdout.split("\n").filter(line => line.startsWith("SMOKE_RESULT "))
    expect(summaries).toHaveLength(1)
    const summary = JSON.parse(summaries[0].slice("SMOKE_RESULT ".length))
    expect(summary.exitCode).toBe(exitCode)
    return { summary, exitCode, stdout, stderr }
  }
  for (const exitCode of [0, 5]) {
    if (exitCode) rmSync(join(root, "candidate.json"))
    const expected = await checkReviewArtifacts(input)
    const result = await run(args)
    expect(result.exitCode).toBe(exitCode)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("| Check | Result | Evidence |")
    expect(result.summary).toEqual({
      checks: expected.rows.map(row => ({ ...row, status: row.ok ? "PASS" : "FAIL" })),
        passed: expected.rows.filter(row => row.ok).length, total: expected.rows.length, exitCode,
    })
  }
  const usage = await run([])
  expect(usage.exitCode).toBe(3)
  expect(usage.summary).toMatchObject({ checks: [{ check: "arguments", status: "FAIL" }], passed: 0, total: 1 })
  const invalidHost = await run([...args, "--host", "invalid"])
  expect(invalidHost.exitCode).toBe(5)
  expect(invalidHost.summary).toMatchObject({ checks: [{ check: "checker", status: "FAIL" }], passed: 0, total: 1 })
  expect((await run([...args, "--intake", "invalid"])).exitCode).toBe(5)
  expect((await run([...args, "--cross-repo", "invalid"])).exitCode).toBe(5)
  expect((await run([...args, "--intake", "local", "--cross-repo", "true"])).exitCode).toBe(5)
  for (const [intake, mode] of [["local", "normal"], ["branch", "normal"], ["url", "fork"]] as const) {
    const { input } = await fixture(false, intake, "plain", mode)
    const result = await run([input.fixture, input.owner, input.repo, input.pr, input.head, input.jsonl, input.hostlog, input.audit,
      "--db", input.db!, "--intake", intake, "--branch", input.branch!, "--bare", input.bare!, "--cross-repo", String(input.crossRepo)])
    expect(result.exitCode).toBe(0)
    expect(result.summary.passed).toBe(result.summary.total)
  }
}, 15_000)

function seedWriter(db: Database, tools: Array<[string, object, string]>, texts: string[], id = "ses_writer", agent = "pr-comment-writer", parent = "ses_smoke") {
  db.run("insert into session values (?, ?, ?, ?)", [id, parent, agent, 2])
  let index = 0
  for (const [name, input, output] of tools) db.run("insert into part values (?, ?, ?, ?, ?)",
    [`${id}_${index}`, "msg_1", id, ++index, JSON.stringify({ type: "tool", tool: name, callID: `call_${index}`, state: { status: "completed", input, output } })])
  for (const value of texts) db.run("insert into part values (?, ?, ?, ?, ?)",
    [`${id}_${index}`, "msg_2", id, ++index, JSON.stringify({ type: "text", text: value })])
}

/**
 * Writer-execution fixture: a v1 run whose parent dispatched pr-comment-writer after
 * verify and received a completed task result, plus a host DB holding the writer
 * child's real-shaped tool sequence (read → pr.head → pr.diff → verify → post).
 * The real post operation uses an injected exec to capture plugin argv and blocked transport.
 */
async function writerFixture(inline = true, retry = false) {
  const data = await v1Fixture(inline)
  const { input, root } = data
  const directory = resolve(input.fixture, "..")
  const agent = JSON.parse(readFileSync(input.agents!, "utf8"))
  agent.permission[0].action = "allow"
  writeFileSync(input.agents!, JSON.stringify(agent))
  const relative = ".corvus/reviews/pr8"
  const digest = createHash("sha256").update(readFileSync(join(root, "post-request.json"))).digest("hex")
  const events = readFileSync(input.jsonl, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
  const writerEvent = events.find(event => event.part?.tool === "subagent")!
  const postInput = { artifactPath: `${relative}/post-request.json`, expectedSha256: digest, repo: { owner: input.owner, name: input.repo }, prNumber: Number(input.pr), headSha: input.head, event: "COMMENT" as const }
  const pluginCalls: string[][] = []
  const transport = await postReview({ ...postInput, artifactPath: join(root, "post-request.json") }, { reviewStateRoot: join(input.fixture, ".corvus/reviews"), exec: async argv => {
    pluginCalls.push(argv.slice(1))
    return argv[3] === "GET" ? { code: 0, stdout: JSON.stringify([[{ sha: input.head, commit: { message: "Product change" } }]]), stderr: "" }
      : retry && pluginCalls.length === 2 ? { code: 1, stdout: "", stderr: "HTTP 429" }
      : { code: 1, stdout: "", stderr: "CORVUS_SMOKE_MUTATION_BLOCKED" }
  } })
  expect(transport).toEqual({ outcome: "unknown", reason: "transport-error", tool_api_calls: retry ? 3 : 2 })
  const postResult = { status: "local_only", review_url: null, reason: transport.reason, remote_state: "unknown", inline_comments_posted: 0, comments_moved_to_body: 0, api_calls: (inline ? 2 : 1) + transport.tool_api_calls }
  writerEvent.part.tool = "task"
  writerEvent.part.state = { status: "completed", input: { subagent_type: "pr-comment-writer", description: "Post verified review artifact", prompt: "{...}" },
    metadata: { sessionId: "ses_writer" },
    output: `<task id="ses_writer" state="completed">\n<task_result>\n${JSON.stringify(postResult)}\n</task_result>\n</task>` }
  const prEvent = (op: string, output: object) => ({ type: "tool_use", sessionID: "ses_smoke", part: { tool: "corvus_review_pr",
    state: { status: "completed", input: { op, owner: "owner", name: "repo", pr: 8 }, output: JSON.stringify(output) } } })
  const listing = { ok: true, reviews: [], threads: [], dispositions: [], complete_pagination: true, complete_threads: true, api_calls: 2 }
  const writerIndex = events.indexOf(writerEvent)
  events.splice(writerIndex, 0, prEvent("metadata", { ok: true, headRefOid: input.head, code_head: input.head, baseRefOid: "b".repeat(40), state: "OPEN", isDraft: false, mergeable: "MERGEABLE", api_calls: 1 }), prEvent("reviews", listing))
  events.splice(events.indexOf(writerEvent) + 1, 0, prEvent("reviews", listing), { type: "tool_use", sessionID: "ses_smoke", part: { tool: "corvus_review_persist",
    state: { status: "completed", input: { op: "write_meta", reviewRoot: relative, headSha: input.head, meta: { ...verdictMeta(input.head), completion: postResult } }, output: JSON.stringify({ ok: true, path: `${relative}/${input.head}/meta.yaml` }) } } })
  writeFileSync(join(root, input.head, "meta.yaml"), JSON.stringify({ ...verdictMeta(input.head), completion: postResult, verified_facts: { facts: [], open_questions: [], config_absent_at_base: false } }))
  writeFileSync(input.jsonl, events.map(event => JSON.stringify(event)).join("\n") + "\n")
  const post = `gh api --method POST repos/owner/repo/pulls/8/reviews --input ${relative}/post-request.json`
   const prInput = { owner: "owner", name: "repo", pr: 8 }
   const diffTool: [string, object, string] = ["corvus_review_pr", { op: "diff", ...prInput }, JSON.stringify({ ok: true, oversized: false, text: "diff --git a/x b/x\n@@ -0,0 +1 @@\n+line\n", api_calls: 1 })]
  const childTools: Array<[string, object, string]> = [
    ["read", { filePath: join(root, "post-request.json") }, "<content>{...}</content>"],
    ["corvus_review_pr", { op: "head", ...prInput }, JSON.stringify({ ok: true, head_sha: input.head, code_head: input.head, base_sha: "b".repeat(40), api_calls: 1 })],
    ...(inline ? [diffTool] : []),
    ["corvus_review_verify", { op: "verify", artifactPath: `${relative}/post-request.json`, expectedSha256: digest }, JSON.stringify({ ok: true, sha256Match: true, canonical: true, violations: [], measurements: {} })],
    ["corvus_review_post", postInput, JSON.stringify(transport)],
  ]
  const db = join(directory, "opencode.db")
  const writeDb = (tools: Array<[string, object, string]>, texts: string[] = [JSON.stringify(postResult)], agentName = "pr-comment-writer", parent = "ses_smoke") => {
    rmSync(db, { force: true })
    const database = new Database(db)
    database.run("create table session (id text primary key, parent_id text, agent text, time_created integer)")
    database.run("create table part (id text primary key, message_id text, session_id text, time_created integer, data text)")
    seedGatherer(database)
    seedParent(database, events)
    database.run("insert into session values (?, ?, ?, ?)", ["ses_smoke", null, "corvus-review-auto", 1])
    seedWriter(database, tools, texts, "ses_writer", agentName, parent)
    database.close()
  }
  writeDb(childTools)
  const audit = (extra: object[] = []) => writeFileSync(input.audit, [
    { marker: "CORVUS_SMOKE_GH_FORWARD", argv: ["pr", "view", "8"] },
    { marker: "CORVUS_SMOKE_GH_FORWARD", argv: ["api", "--method", "GET", "repos/owner/repo/pulls/8", "-H", "Accept:application/vnd.github+json", "--jq", ".head.sha"] },
    ...(inline ? [{ marker: "CORVUS_SMOKE_GH_FORWARD", argv: ["api", "--method", "GET", "repos/owner/repo/pulls/8", "-H", "Accept:application/vnd.github.v3.diff"] }] : []),
    ...pluginCalls.map(argv => ({ marker: argv[2] === "POST" ? "CORVUS_SMOKE_MUTATION_BLOCKED" : "CORVUS_SMOKE_GH_FORWARD", argv })),
    ...extra,
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n")
  audit()
  writeFileSync(join(root, "lock.yaml"), "status: completed\n")
  const writerInput: Inputs = { ...input, writer: true, db }
  return { ...data, input: writerInput, events, writerEvent, childTools, writeDb, audit, digest, post, postResult }
}

async function writerRepostFixture(count: number, reconcile = true) {
  const data = await writerFixture()
  const prInput = { owner: "owner", name: "repo", pr: 8 }
  const listing = { ok: true, reviews: [], threads: [], dispositions: [], complete_pagination: true, complete_threads: true, api_calls: 2 }
  const writers = Array.from({ length: count }, (_, index) => {
    const id = index === 0 ? "ses_writer" : `ses_writer_${index + 1}`
    const tools = structuredClone(data.childTools)
    tools[1][2] = JSON.stringify({ ...JSON.parse(tools[1][2]), api_calls: index === 0 ? 2 : 1 })
    tools.splice(3, 0, ["corvus_review_pr", { op: "reviews", ...prInput }, JSON.stringify(listing)])
    const result = { ...data.postResult, api_calls: index === 0 ? 7 : 6 }
    const event = toolEvent("task", data.writerEvent.part.state.input, result)
    Object.assign(event.part.state, { metadata: { sessionId: id } })
    return { id, tools, result, event }
  })
  const between = writers.slice(1).map(() => toolEvent("corvus_review_pr", { op: "reviews", ...prInput }, listing))
  data.events.splice(data.events.indexOf(data.writerEvent), 1,
    ...writers.flatMap((writer, index) => index > 0 && reconcile ? [between[index - 1], writer.event] : [writer.event]))
  const save = () => {
    for (const writer of writers) writer.event.part.state.output = `<task id="${writer.id}" state="completed">\n<task_result>\n${JSON.stringify(writer.result)}\n</task_result>\n</task>`
    writeFileSync(data.input.jsonl, data.events.map(event => JSON.stringify(event)).join("\n") + "\n")
    data.writeDb(writers[0].tools, [JSON.stringify(writers[0].result)])
    const db = new Database(data.input.db!)
    for (const writer of writers.slice(1).reverse()) seedWriter(db, writer.tools, [JSON.stringify(writer.result)], writer.id)
    db.run("update session set time_created = 99 where id = ?", ["ses_writer"])
    db.close()
  }
  save()
  const blocked = readFileSync(data.input.audit, "utf8").trim().split("\n").map(line => JSON.parse(line))
    .find(entry => entry.marker === "CORVUS_SMOKE_MUTATION_BLOCKED")
  data.audit(Array.from({ length: count - 1 }, () => blocked))
  return { ...data, writers, between, save }
}

test.each([[2, true, true], [3, true, false], [2, false, false]] as const)("R5 scores %i writer dispatches with reconciliation=%s", async (count, reconcile, ok) => {
  const data = await writerRepostFixture(count, reconcile)
  const result = await checkReviewArtifacts(data.input)
  expect(result.rows.find(row => row.check === "R5 PR transport")).toMatchObject({ ok })
  expect(result.exitCode).toBe(ok ? 0 : 5)
  expect(result.rows).toHaveLength(50)
  expect(result.audit.blocked).toBe(count)
  if (ok) {
    expect(result.rows.filter(row => !row.ok)).toEqual([])
    const reads = result.rows.find(row => row.check === "writer PR reads")!
    expect(reads.detail.match(/3 structured PR calls/g)).toHaveLength(2)
    expect(reads.detail).toContain("reviews=1 (required)")
    const writerResult = result.rows.find(row => row.check === "writer result")!
    expect(writerResult.ok).toBe(true)
    expect(writerResult.detail).toStartWith("final dispatch: status=local_only, remote_state=unknown, review_url=null, api_calls=6")
    expect(writerResult.detail.split("; ").slice(-2)).toEqual([
      "aggregate api_calls=13", "expected Σ(PR+POST)=9+4=13",
    ])
    expect(checkWriterRun({ ...data.input, digest: data.digest }).rows.find(row => row.check === "writer dispatched")).toMatchObject({ ok: false })
  }
})

test("writer repost requires per-session reads, safe DB counts, final-result truth and proven absence", async () => {
  const data = await writerRepostFixture(2)
  const baseline = structuredClone(data.writers)
  const reset = () => {
    for (const [index, writer] of data.writers.entries()) {
      writer.tools = structuredClone(baseline[index].tools)
      writer.result = { ...baseline[index].result }
      Object.assign(writer.event.part.state, structuredClone(baseline[index].event.part.state))
    }
  }
  const row = async (check: string) => {
    data.save()
    return (await checkReviewArtifacts(data.input)).rows.find(row => row.check === check)
  }
  for (const index of [0, 1]) for (const op of ["head", "diff"]) {
    reset()
    data.writers[index].tools = data.writers[index].tools.filter(([name, input]) => !(name === "corvus_review_pr" && (input as { op: string }).op === op))
    expect(await row("writer PR reads"), `${index}:${op}`).toMatchObject({ ok: false })
  }
  for (const index of [0, 1]) {
    reset()
    data.writers[index].tools.splice(3, 0, structuredClone(data.writers[index].tools[3]))
    expect(await row("writer PR reads"), `duplicate reviews:${index}`).toMatchObject({ ok: false })
  }
  reset()
  data.writers[1].tools.splice(3, 1)
  expect(await row("writer PR reads")).toMatchObject({ ok: false })
  for (const value of [undefined, -1, Number.MAX_SAFE_INTEGER]) {
    reset()
    const head = data.writers[1].tools[1]
    head[2] = JSON.stringify({ ...JSON.parse(head[2]), api_calls: value })
    const result = await row("writer result")
    expect(result).toMatchObject({ ok: false })
    expect(result?.detail).not.toContain("NaN")
  }
  reset()
  data.writers[0].result.api_calls--
  data.writers[1].result.api_calls++
  expect(await row("writer result")).toMatchObject({ ok: false })
  reset()
  data.writers[1].result.remote_state = "not_posted"
  expect(await row("writer result")).toMatchObject({ ok: false, detail: expect.stringContaining("final dispatch: status=local_only, remote_state=not_posted") })
  reset()
  data.writers[0].result.remote_state = "not_posted"
  expect(await row("R5 PR transport")).toMatchObject({ ok: false })
  reset()
  Object.assign(data.writers[1].event.part.state, { metadata: undefined })
  expect(await row("writer dispatched")).toMatchObject({ ok: true })
  reset()
  Object.assign(data.writers[1].event.part.state, { metadata: { sessionId: "ses_writer" } })
  expect(await row("writer dispatched")).toMatchObject({ ok: false })
  reset()
  const reconciliation = data.between[0]
  const listing = JSON.parse(reconciliation.part.state.output)
  const marker = JSON.parse(readFileSync(join(data.root, "post-request.json"), "utf8")).body.split("\n").find((line: string) => line.startsWith("<!-- corvus-review"))
  for (const output of [{ ...listing, complete_pagination: false }, { ...listing, ok: false },
    { ...listing, reviews: [{ body_marker: marker, commit_id: data.input.head, state: "COMMENTED", html_url: "https://github.com/owner/repo/pull/8#pullrequestreview-1" }] }]) {
    reconciliation.part.state.output = JSON.stringify(output)
    expect(await row("R5 PR transport")).toMatchObject({ ok: false })
  }
}, 30_000)

test("writer mode requires the writer child's verify → post tool → blocked plugin POST and closed local_only/unknown result", async () => {
  const data = await writerFixture()
  const { input } = data
  const result = await checkReviewArtifacts(input)
  expect(result.rows.filter(row => !row.ok)).toEqual([])
  expect(result.exitCode).toBe(0)
  const names = result.rows.map(row => row.check)
  expect(result.rows).toHaveLength(50)
  expect(names).toContain("writer dispatched")
  expect(names).toEqual(expect.arrayContaining(["writer verify", "writer POST attempted", "writer shell discipline", "writer result"]))
  expect(names).not.toContain("writer denied")
  expect(result.rows.find(row => row.check === "plugin loaded")?.ok).toBe(true)
  expect(result.rows.find(row => row.check === "writer verify")?.detail).toMatch(/ok:true at event 3 \(sha256Match=true, canonical=true\)/)
  expect(result.rows.find(row => row.check === "writer POST attempted")?.detail).toMatch(/corvus_review_post at event 4 \(after verify 3\); outcome=unknown; shim audit: CORVUS_SMOKE_MUTATION_BLOCKED/)
  expect(result.rows.find(row => row.check === "writer shell discipline")?.detail).toBe("0 bash call(s): no GitHub shell calls, 0 granted JSON validator(s) (informational); no shell measurement")
  expect(result.rows.find(row => row.check === "writer result")?.detail).toStartWith("status=local_only, remote_state=unknown, review_url=null, api_calls=4")
  expect(result.rows.find(row => row.check === "R5 PR transport")?.ok).toBe(true)
  expect(result.rows.find(row => row.check === "orchestrator GitHub reads")?.ok).toBe(true)
  expect(result.audit).toEqual({ forwarded: 4, canned: 0, blocked: 1, unsafe: 0 })
  const row = async (check: string) => (await checkReviewArtifacts(input)).rows.find(item => item.check === check)

  // The blocked-post/unknown route completes with tool-only parent reads, and cannot regain bash transport.
  const saveRoute = (events: object[]) => writeFileSync(input.jsonl, events.map(event => JSON.stringify(event)).join("\n") + "\n")
  for (const command of ["gh api repos/owner/repo/pulls/8/reviews", "gh pr view 8 --repo owner/repo", "gh pr checks 8 --repo owner/repo", "gh auth status && gh pr view 8", 'g"h" pr view 8']) {
    saveRoute([...data.events, { type: "tool_use", sessionID: "ses_smoke", part: { tool: "bash", state: { status: "completed", input: { command } } } }])
    expect(await row("orchestrator GitHub reads")).toMatchObject({ ok: false })
  }
  saveRoute(data.events.filter(event => !(event.part?.tool === "corvus_review_pr" && event.part.state.input.op === "reviews")))
  expect(await row("R5 PR transport")).toMatchObject({ ok: false })
  saveRoute(data.events)
  for (const op of ["head", "diff"]) {
    data.writeDb(data.childTools.filter(([name, args]) => !(name === "corvus_review_pr" && (args as { op?: string }).op === op)))
    expect(await row("writer PR reads")).toMatchObject({ ok: false })
  }
  for (const command of ["gh api --method GET repos/owner/repo/pulls/8 -H Accept:application/vnd.github+json --jq .head.sha",
    "gh api repos/owner/repo/pulls/8", "gh api -XGET --paginate repos/owner/repo/pulls/8/files", 'g"h" api user', "env gh api user"]) {
    data.writeDb([...data.childTools, ["bash", { command }, input.head]])
    expect(await row("writer shell discipline"), command).toMatchObject({ ok: false })
    expect(checkWriterRun({ fixture: input.fixture, owner: input.owner, repo: input.repo, pr: input.pr, head: input.head, digest: data.digest,
      jsonl: input.jsonl, audit: input.audit, db: input.db }).rows.find(row => row.check === "writer shell discipline"), command).toMatchObject({ ok: false })
  }
  for (const agent of ["pr-comment-writer", "pr-context-gatherer", "researcher"]) {
    data.writeDb(data.childTools)
    const db = new Database(input.db!)
    db.run("insert into session values (?, ?, ?, ?)", ["ses_nested", "ses_gatherer", agent, 3])
    db.run("insert into part values (?, ?, ?, ?, ?)", ["nested_write", "msg_nested", "ses_nested", 10,
      JSON.stringify({ type: "tool", tool: "write", state: { status: "completed", input: { filePath: join(data.root, "candidate.json"), content: "{}" } } })])
    db.close()
    expect(await row("model state writes")).toMatchObject({ ok: false })
  }
  data.writeDb(data.childTools)
  const malformedDb = new Database(input.db!)
  malformedDb.run("insert into part values (?, ?, ?, ?, ?)", ["bad_row", "msg_bad", "ses_gatherer", 20, "{truncated"])
  malformedDb.close()
  expect(await row("child tool evidence")).toMatchObject({ ok: false })
  expect(checkWriterRun({ fixture: input.fixture, owner: input.owner, repo: input.repo, pr: input.pr, head: input.head, digest: data.digest,
    jsonl: input.jsonl, audit: input.audit, db: input.db }).rows.find(row => row.check === "model state writes")).toMatchObject({ ok: false })
  data.writeDb(data.childTools)

  // Negative: the writer-deny rule is now the wrong barrier; writer mode requires allow.
  const agent = JSON.parse(readFileSync(input.agents!, "utf8"))
  agent.permission[0].action = "deny"
  writeFileSync(input.agents!, JSON.stringify(agent))
  expect(await row("plugin loaded")).toMatchObject({ ok: false })
  expect((await row("plugin loaded"))?.detail).toContain("writer allow")
  agent.permission[0].action = "allow"
  writeFileSync(input.agents!, JSON.stringify(agent))

  // Negative: no host DB, no child session, or a child under another parent/agent fails "writer dispatched".
  expect((await checkReviewArtifacts({ ...input, db: undefined })).rows.find(item => item.check === "writer dispatched")).toMatchObject({ ok: false, detail: "host DB path not supplied (--db)" })
  expect((await checkReviewArtifacts({ ...input, db: join(input.fixture, "missing.db") })).rows.find(item => item.check === "writer dispatched")?.ok).toBe(false)
  data.writeDb(data.childTools, undefined, "pr-comment-writer", "ses_other")
  expect((await row("writer dispatched"))?.detail).toStartWith("no pr-comment-writer child session under ses_smoke")
  data.writeDb(data.childTools, undefined, "researcher")
  expect(await row("writer dispatched")).toMatchObject({ ok: false })
  data.writeDb(data.childTools)
  expect(await row("writer dispatched")).toMatchObject({ ok: true })

  // Negative: the parent never dispatched, or the dispatch errored (the old sandbox denial), fails.
  const save = (list: object[]) => writeFileSync(input.jsonl, list.map(event => JSON.stringify(event)).join("\n") + "\n")
  save(data.events.filter(event => event !== data.writerEvent))
  expect(await row("writer dispatched")).toMatchObject({ ok: false, detail: "no writer dispatch by the parent" })
  data.writerEvent.part.state.status = "error"
  data.writerEvent.part.state.error = "Subagent denied: pr-comment-writer"
  save(data.events)
  expect((await row("writer dispatched"))?.detail).toContain("without a completed result after verify")
  data.writerEvent.part.state.status = "completed"
  delete data.writerEvent.part.state.error
  save(data.events)

  // Negative: verify missing, ok:false, wrong digest, or errored fails "writer verify".
  const without = (name: string) => data.childTools.filter(([tool]) => tool !== name)
  data.writeDb(without("corvus_review_verify"))
  expect(await row("writer verify")).toMatchObject({ ok: false, detail: "no corvus_review_verify call by the writer" })
  data.writeDb(data.childTools.map(([name, toolInput, output]) => name === "corvus_review_verify" ? [name, toolInput, JSON.stringify({ ok: false, reason: "sha256-mismatch" })] : [name, toolInput, output]))
  expect((await row("writer verify"))?.detail).toContain("without a completed ok:true")
  data.writeDb(data.childTools.map(([name, toolInput, output]) => name === "corvus_review_verify" ? [name, { ...toolInput, expectedSha256: "b".repeat(64) }, output] : [name, toolInput, output]))
  expect(await row("writer verify")).toMatchObject({ ok: false })

  // Negative: tool absent, before verify, repeated, or with a changed descriptor cannot attest to the approved post.
  data.writeDb(without("corvus_review_post"))
  expect(await row("writer POST attempted")).toMatchObject({ ok: false })
  data.writeDb([data.childTools[4], ...data.childTools.slice(0, 4)])
  expect(await row("writer POST attempted")).toMatchObject({ ok: false })
  data.writeDb([...data.childTools, data.childTools[4]])
  expect(await row("writer POST attempted")).toMatchObject({ ok: false })
  for (const changed of [{ expectedSha256: "b".repeat(64) }, { artifactPath: "other.json" }, { repo: { owner: "other", name: "repo" } }, { prNumber: 9 }, { headSha: "b".repeat(40) }, { event: "APPROVE" }, { body: "override" }]) {
    data.writeDb(data.childTools.map(([name, toolInput, output]) => name === "corvus_review_post" ? [name, { ...toolInput, ...changed }, output] : [name, toolInput, output]))
    expect(await row("writer POST attempted")).toMatchObject({ ok: false })
  }
  for (const transport of [{ outcome: "rejected", reason: "HTTP 422", tool_api_calls: 2 }, { outcome: "unknown", tool_api_calls: 2 }, { outcome: "unknown", reason: "transport-error", tool_api_calls: -1 }]) {
    data.writeDb(data.childTools.map(([name, toolInput, output]) => name === "corvus_review_post" ? [name, toolInput, JSON.stringify(transport)] : [name, toolInput, output]))
    expect(await row("writer POST attempted")).toMatchObject({ ok: false })
  }
  // A legacy writer bash POST cannot substitute for the tool, even with the matching blocked audit.
  data.writeDb([...without("corvus_review_post"), ["bash", { command: data.post }, "CORVUS_SMOKE_MUTATION_BLOCKED"]])
  expect(await row("writer POST attempted")).toMatchObject({ ok: false })
  expect((await row("writer shell discipline"))?.ok).toBe(false)
  data.writeDb([...data.childTools, ["bash", { command: data.post }, "CORVUS_SMOKE_MUTATION_BLOCKED"]])
  expect((await row("writer shell discipline"))?.ok).toBe(false)
  data.writeDb(data.childTools)
  writeFileSync(input.audit, "")
  expect(await row("writer POST attempted")).toMatchObject({ ok: false, detail: "corvus_review_post call present but no blocked shim audit record for plugin argv" })
  writeFileSync(input.audit, JSON.stringify({ marker: "CORVUS_SMOKE_MUTATION_BLOCKED", argv: data.post.split(" ").slice(1) }) + "\n")
  expect(await row("writer POST attempted")).toMatchObject({ ok: false })
  data.audit([{ marker: "CORVUS_SMOKE_GH_FORWARD", argv: ["api", "--method", "POST", "repos/owner/repo/pulls/8/reviews", "--input", "x.json"] }])
  const breach = await checkReviewArtifacts(input)
  expect(breach.exitCode).toBe(6)
  expect(breach.rows.find(item => item.check === "writer POST attempted")).toMatchObject({ ok: false, code: 6 })
  expect(breach.rows.find(item => item.check === "writer POST attempted")?.detail).toStartWith("posting barrier breach: POST forwarded")
  data.audit()

  // Negative: the field failure — shell measurement (shasum, or jq/python3 off the exact artifact path) — fails "writer shell discipline".
  data.writeDb([...data.childTools.slice(0, 3), ["bash", { command: "shasum -a 256 .corvus/reviews/pr8/post-request.json" }, "abc  file\n"], ["bash", { command: "jq .body .corvus/reviews/pr8/post-request.json" }, "{}\n"], ...data.childTools.slice(3)])
  const shell = await row("writer shell discipline")
  expect(shell).toMatchObject({ ok: false })
  expect(shell?.detail).toStartWith("2 shell measurement/diagnostic command(s), 0 other off-form command(s): event 3: shasum -a 256")
  // Positive: the frontmatter's exact JSON validators on the artifact path are permitted read fallbacks (the 20n350 gate shape), reported as informational.
  data.writeDb([data.childTools[0], ["bash", { command: "python3 -m json.tool .corvus/reviews/pr8/post-request.json" }, "{}\n"], ["bash", { command: "jq . .corvus/reviews/pr8/post-request.json" }, "{}\n"], ...data.childTools.slice(1)])
  expect(await row("writer shell discipline")).toMatchObject({ ok: true, detail: "2 bash call(s): no GitHub shell calls, 2 granted JSON validator(s) (informational); no shell measurement" })
  data.writeDb([data.childTools[0], ["bash", { command: "python3 -m json.tool .corvus/reviews/other__repo__pr8/post-request.json" }, "{}\n"], ...data.childTools.slice(1)])
  expect(await row("writer shell discipline")).toMatchObject({ ok: false })
  data.writeDb(data.childTools)

  // Negative: a `posted` claim is a breach; anchor failure cannot stand in for a blocked transport; missing/extra fields fail.
  data.writeDb(data.childTools, [JSON.stringify({ ...data.postResult, status: "posted", remote_state: "posted", review_url: "https://github.com/owner/repo/pull/8#pullrequestreview-1", reason: null })])
  data.writerEvent.part.state.output = "<task_result>posted</task_result>"
  save(data.events)
  const posted = await checkReviewArtifacts(input)
  expect(posted.exitCode).toBe(6)
  expect(posted.rows.find(item => item.check === "writer result")).toMatchObject({ ok: false, code: 6 })
  data.writeDb(data.childTools, [JSON.stringify({ status: "not_posted", review_url: null, reason: "anchors-unverifiable", remote_state: "not_posted", inline_comments_posted: 0, comments_moved_to_body: 0, api_calls: 2, unverifiable_anchors: [{ path: "x", line_start: 1, line_end: 1 }] })])
  expect(await row("writer result")).toMatchObject({ ok: false })
  for (const changed of [{ remote_state: "not_posted" }, { http_status: 422 }, { inline_comments_posted: 1 }, { comments_moved_to_body: 1 }, { api_calls: 3 }, { reason: "" }]) {
    data.writeDb(data.childTools, [JSON.stringify({ ...data.postResult, ...changed })])
    expect(await row("writer result")).toMatchObject({ ok: false })
  }
  data.writeDb(data.childTools, ["Done."])
  expect(await row("writer result")).toMatchObject({ ok: false, detail: "no POST_RESULT with a status field in the writer's returned text" })
  data.writeDb(data.childTools, ["Done."])
  data.writerEvent.part.state.output = `<task_result>${JSON.stringify(data.postResult)}</task_result>`
  save(data.events)
  expect(await row("writer result")).toMatchObject({ ok: true })
}, 30_000)

test("the audit counts canned reads separately, accepts the read-only Accept headers, and still rejects forwarded write headers", async () => {
  const data = await writerFixture()
  const { input } = data
  data.audit([
    { marker: "CORVUS_SMOKE_GH_CANNED", argv: ["api", "--method", "GET", "repos/owner/repo/pulls/8", "-H", "Accept:application/vnd.github+json", "--jq", ".head.sha"], fixture: "pull.json" },
    { marker: "CORVUS_SMOKE_GH_CANNED", argv: ["api", "--method", "GET", "--paginate", "repos/owner/repo/pulls/8/files", "-H", "Accept: application/vnd.github+json"], fixture: "files.json" },
    { marker: "CORVUS_SMOKE_GH_FORWARD", argv: ["api", "--method", "GET", "repos/owner/repo/pulls/8", "-H", "Accept: application/vnd.github.v3.diff"] },
  ])
  const result = await checkReviewArtifacts(input)
  expect(result.exitCode).toBe(0)
  expect(result.audit).toEqual({ forwarded: 5, canned: 2, blocked: 1, unsafe: 0 })
  expect(result.rows.find(row => row.check === "GitHub barrier")?.detail).toBe("5 forwarded reads; 2 canned reads; 1 blocked (informational); 0 unsafe/malformed")
  for (const header of ["Accept: application/vnd.github.v3.diff\nX-HTTP-Method-Override: DELETE", "X-HTTP-Method-Override: DELETE", "Accept: text/html"]) {
    data.audit([{ marker: "CORVUS_SMOKE_GH_CANNED", argv: ["api", "repos/owner/repo/pulls/8", "-H", header] }])
    const unsafe = await checkReviewArtifacts(input)
    expect(unsafe.exitCode).toBe(6)
    expect(unsafe.audit.unsafe).toBe(1)
  }
  data.audit([{ marker: "CORVUS_SMOKE_GH_SERVED", argv: ["api", "repos/owner/repo/pulls/8"] }])
  expect((await checkReviewArtifacts(input)).audit.unsafe).toBe(1)
})

test("both writer gates account for body-only, inline, paginated 406 fallback and the tool's bounded retry", async () => {
  for (const [inline, fallback, retry, expected] of [[false, false, false, 3], [true, false, false, 4], [true, true, false, 6], [true, true, true, 7]] as const) {
    const data = await writerFixture(inline, retry)
    const { input } = data
    const tools = [...data.childTools]
    if (fallback) {
      tools[2] = [tools[2][0], tools[2][1], JSON.stringify({ ok: true, oversized: true, http_status: 406, api_calls: 1 })]
      const files = [{ filename: "other", has_patch: true, patch: '@@ -0,0 +1 @@\n+brackets ][ and \\"' }, { filename: "x", has_patch: true, patch: "@@ -0,0 +1 @@\n+line" }]
      tools.splice(3, 0, ["corvus_review_pr", { op: "files", owner: "owner", name: "repo", pr: 8, paginate: true }, JSON.stringify({ ok: true, files, complete_pagination: true, api_calls: 2 })])
    }
    const saveResult = (apiCalls: number) => {
      const result = { ...data.postResult, api_calls: apiCalls }
      data.writeDb(tools, [JSON.stringify(result)])
      data.writerEvent.part.state.output = `<task_result>${JSON.stringify(result)}</task_result>`
      writeFileSync(input.jsonl, data.events.map(event => JSON.stringify(event)).join("\n") + "\n")
    }
    const direct = () => checkWriterRun({ fixture: input.fixture, owner: input.owner, repo: input.repo, pr: input.pr, head: input.head, digest: data.digest, jsonl: input.jsonl, audit: input.audit, db: input.db })
    saveResult(expected)
    expect((await checkReviewArtifacts(input)).exitCode).toBe(0)
    expect(direct().exitCode).toBe(0)
    saveResult(expected - 1)
    expect((await checkReviewArtifacts(input)).rows.find(row => row.check === "writer result")?.ok).toBe(false)
    expect(direct().exitCode).toBe(5)
    if (fallback) {
      tools[3] = [tools[3][0], tools[3][1], "[{\"filename\":\"truncated"]
      saveResult(expected)
      expect(direct().rows.find(row => row.check === "writer result")?.ok).toBe(false)
    }
  }
}, 15_000)

test("direct writer artifact lookup shares plain/task/legacy reads, preserves bytes and rejects ambiguous roots", () => {
  for (const layout of ["plain", "task", "legacy"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "corvus-writer-root-"))
    directories.push(directory)
    const plain = ".corvus/reviews/pr8", legacy = ".corvus/reviews/owner__repo__pr8"
    const relative = layout === "task" ? ".corvus/tasks/feature/reviews/pr8" : layout === "legacy" ? legacy : plain
    const root = join(directory, relative), head = "a".repeat(40)
    mkdirSync(root, { recursive: true })
    const artifact = join(root, "post-request.json")
    writeFileSync(artifact, JSON.stringify({ commit_id: head, event: "COMMENT", body: "Review fixture", comments: [] }))
    const before = readFileSync(artifact), tree = artifactTree(directory)
    const input = { fixture: directory, owner: "owner", repo: "repo", pr: "8", head,
      digest: createHash("sha256").update(before).digest("hex"), jsonl: join(directory, "missing.jsonl"), audit: join(directory, "missing-audit.log") }
    expect(checkWriterRun(input).rows.find(row => row.check === "fixture artifact"), layout).toMatchObject({ ok: true })
    expect(readFileSync(artifact)).toEqual(before)
    expect(artifactTree(directory)).toEqual(tree)
    if (layout === "legacy") {
      expect(existsSync(join(directory, plain))).toBe(false)
      mkdirSync(join(directory, plain), { recursive: true })
      expect(checkWriterRun(input).rows.find(row => row.check === "fixture artifact")).toMatchObject({ ok: false })
    }
    if (layout === "task") {
      mkdirSync(join(directory, ".corvus/tasks/other/reviews/pr8"), { recursive: true })
      expect(() => checkWriterRun(input)).toThrow("ambiguous review root")
    }
  }
})

test.each(["plain", "task", "legacy"] as const)("writer harness fixture uses shared %s resolution and never writes legacy state", async layout => {
  const directory = mkdtempSync(join(tmpdir(), "corvus-writer-fixture-"))
  directories.push(directory)
  const workspace = join(directory, "fixture"), head = "a".repeat(40)
  const legacy = join(workspace, ".corvus/reviews/owner__repo__pr8")
  const relative = layout === "task" ? ".corvus/tasks/feature/reviews/pr8" : ".corvus/reviews/pr8"
  mkdirSync(workspace)
  mkdirSync(join(directory, "canned"))
  if (layout === "task") mkdirSync(join(workspace, relative), { recursive: true })
  if (layout === "legacy") {
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, "post-request.json"), "legacy evidence\n")
  }
  const before = artifactTree(workspace).map(path => [path, readFileSync(join(workspace, path))])
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dirname, "../review-payload.ts")], outdir: join(directory, "dist"), target: "bun" })
  expect(build.success).toBe(true)
  const script = readFileSync(resolve(import.meta.dirname, "../../scripts/smoke-writer.sh"), "utf8")
  const snippet = /# Fixture:[\s\S]*?\nbun -e '([\s\S]*?)\n' \|\| die 3 'fixture generation failed'/.exec(script)?.[1]
  expect(snippet).toBeDefined()
  const result = Bun.spawnSync([process.execPath, "-e", snippet!], { env: { ...process.env, SMOKE_WORK: directory,
    SMOKE_ROOT: resolve(import.meta.dirname, "../.."), SMOKE_OWNER: "owner", SMOKE_REPO: "repo", SMOKE_NUMBER: "8", SMOKE_HEAD: head, SMOKE_HEAD_MOVED: "0" } })
  if (layout === "legacy") {
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("legacy fixture writes are disabled")
    expect(artifactTree(workspace).map(path => [path, readFileSync(join(workspace, path))])).toEqual(before)
    expect(existsSync(join(directory, "descriptor.json"))).toBe(false)
    return
  }
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(existsSync(legacy)).toBe(false)
  const descriptor = JSON.parse(readFileSync(join(directory, "descriptor.json"), "utf8"))
  expect(descriptor.artifact_path).toBe(`${relative}/post-request.json`)
  const artifact = readFileSync(join(workspace, descriptor.artifact_path))
  expect(createHash("sha256").update(artifact).digest("hex")).toBe(descriptor.expected_sha256)
  const body = JSON.parse(artifact.toString()).body as string
  const marker = `<!-- corvus-review v2 path=${relative} head=${head} round=1 -->`
  expect(body.startsWith(marker)).toBe(true)
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${String(i + 1).padStart(2, "0")}: this sentence pads the review body past the host read tool line limit; `).join("")
  const beforeBody = "<!-- corvus-review -->\nSmoke writer body: no mutation is expected to succeed. " + filler
  expect(Buffer.from(body.replace(marker, "<!-- corvus-review -->"))).toEqual(Buffer.from(beforeBody))
})

test("the direct writer-run checker scores the relay dispatch plus the DB child and fails on agent fallback or a digest drift", async () => {
  const data = await writerFixture()
  const { input } = data
  const stderr = join(input.fixture, "..", "run.stderr")
  writeFileSync(stderr, "")
  const args = { fixture: input.fixture, owner: input.owner, repo: input.repo, pr: input.pr, head: input.head, digest: data.digest, jsonl: input.jsonl, audit: input.audit, stderr, db: input.db }
  const result = checkWriterRun(args)
  expect(result.rows.filter(row => !row.ok)).toEqual([])
  expect(result.exitCode).toBe(0)
  expect(result.rows.map(row => row.check)).toEqual(["JSONL", "host/provider", "fixture artifact", "model state writes", "writer dispatched", "writer verify", "writer POST attempted", "writer PR reads", "writer shell discipline", "writer result"])
  expect(result.sequence).toHaveLength(5)
  expect(result.sequence[3]).toBe("3:corvus_review_verify(verify) → completed")
  expect(result.sequence[4]).toBe("4:corvus_review_post(unknown, tool_api_calls=2) → completed")
  writeFileSync(stderr, '! agent "pr-comment-writer" is a subagent, not a primary agent. Falling back to default agent\n')
  const fallback = checkWriterRun(args)
  expect(fallback.exitCode).toBe(3)
  expect(fallback.rows.find(row => row.check === "host/provider")).toMatchObject({ ok: false, detail: "host fell back to the default agent (relay not used)" })
  writeFileSync(stderr, "")
  const drift = checkWriterRun({ ...args, digest: "b".repeat(64) })
  expect(drift.exitCode).toBe(4)
  expect(drift.rows.find(row => row.check === "fixture artifact")?.ok).toBe(false)
  expect(drift.rows.find(row => row.check === "writer verify")?.ok).toBe(false)
  expect(checkWriterRun({ ...args, db: undefined }).rows.find(row => row.check === "writer dispatched")).toMatchObject({ ok: false, detail: "host DB path not supplied (--db)" })
})

test("head-moved mode requires the post tool's own rejection after the writer's passing head check, no POST of any kind, and local_only/not_posted", async () => {
  const data = await writerFixture()
  const { input } = data
  const relative = ".corvus/reviews/pr8"
  // The real post operation against an exec whose head GET returns a moved sha: rejected before any POST, one API call.
  const pluginCalls: string[][] = []
  const transport = await postReview({ artifactPath: join(input.fixture, relative, "post-request.json"), expectedSha256: data.digest, repo: { owner: input.owner, name: input.repo }, prNumber: Number(input.pr), headSha: input.head, event: "COMMENT" },
    { reviewStateRoot: join(input.fixture, ".corvus/reviews"), exec: async argv => { pluginCalls.push(argv.slice(1)); return { code: 0, stdout: JSON.stringify([[{ sha: "c".repeat(40), commit: { message: "New product change" } }]]), stderr: "" } } })
  expect(transport).toEqual({ outcome: "rejected", reason: "head-moved", tool_api_calls: 1 })
  expect(pluginCalls).toHaveLength(1)
  const postResult = { status: "local_only", review_url: null, reason: "head-moved", remote_state: "not_posted", inline_comments_posted: 0, comments_moved_to_body: 0, api_calls: 3 }
  const tools: Array<[string, object, string]> = [...data.childTools.slice(0, 4), ["corvus_review_post", data.childTools[4][1], JSON.stringify(transport)]]
  const headGet = ["api", "--method", "GET", "repos/owner/repo/pulls/8", "-H", "Accept: application/vnd.github+json", "--jq", ".head.sha"]
  const save = (result: object, audit: object[]) => {
    data.writeDb(tools, [JSON.stringify(result)])
    data.writerEvent.part.state.output = `<task_result>${JSON.stringify(result)}</task_result>`
    writeFileSync(input.jsonl, data.events.map(event => JSON.stringify(event)).join("\n") + "\n")
    writeFileSync(input.audit, audit.map(entry => JSON.stringify(entry)).join("\n") + "\n")
  }
  const goodAudit = [
    { marker: "CORVUS_SMOKE_GH_CANNED", argv: ["api", "--method", "GET", "repos/owner/repo/pulls/8", "-H", "Accept:application/vnd.github+json", "--jq", ".head.sha"], fixture: "pull.json" },
    { marker: "CORVUS_SMOKE_GH_CANNED", argv: ["api", "--method", "GET", "repos/owner/repo/pulls/8", "-H", "Accept:application/vnd.github.v3.diff"], fixture: "pull.diff" },
    { marker: "CORVUS_SMOKE_GH_CANNED", argv: headGet, fixture: "pull.moved.json" },
  ]
  const args = { fixture: input.fixture, owner: input.owner, repo: input.repo, pr: input.pr, head: input.head, digest: data.digest, jsonl: input.jsonl, audit: input.audit, db: input.db, expect: "head-moved" as const }
  save(postResult, goodAudit)
  const result = checkWriterRun(args)
  expect(result.rows.filter(row => !row.ok)).toEqual([])
  expect(result.exitCode).toBe(0)
  expect(result.rows.find(row => row.check === "writer POST attempted")?.detail).toBe("corvus_review_post at event 4 (after verify 3); outcome=rejected head-moved (tool_api_calls=1); shim served pull.moved.json to the tool's head GET; no POST in audit")
  expect(result.rows.find(row => row.check === "writer result")?.detail).toStartWith('status=local_only, remote_state=not_posted, review_url=null, api_calls=3, reason="head-moved"; expected remote_state=not_posted, api_calls=2+1=3')
  expect(result.sequence[4]).toBe("4:corvus_review_post(rejected, tool_api_calls=1) → completed")
  const row = (check: string) => checkWriterRun(args).rows.find(item => item.check === check)
  // Negative: the same evidence scored in default (blocked) mode fails — the modes are not interchangeable.
  expect(checkWriterRun({ ...args, expect: "blocked" }).rows.find(item => item.check === "writer POST attempted")).toMatchObject({ ok: false, detail: expect.stringContaining("invalid blocked TransportResult") })
  // Negative: the moved fixture was never served (the writer's own check would have had to catch it), or a POST reached the shim anyway.
  save(postResult, goodAudit.slice(0, 2))
  expect(row("writer POST attempted")).toMatchObject({ ok: false, detail: "corvus_review_post rejected head-moved but the shim audit shows no pull.moved.json served to a head GET" })
  save(postResult, [...goodAudit, { marker: "CORVUS_SMOKE_MUTATION_BLOCKED", argv: ["api", "--method", "POST", "repos/owner/repo/pulls/8/reviews", "--input", "x"] }])
  expect(row("writer POST attempted")?.detail).toStartWith("head-moved rejection must issue no POST; audit shows")
  save(postResult, [...goodAudit, { marker: "CORVUS_SMOKE_GH_FORWARD", argv: ["api", "--method", "POST", "repos/owner/repo/pulls/8/reviews", "--input", "x"] }])
  expect(row("writer POST attempted")).toMatchObject({ ok: false, code: 6 })
  // Negative: a blocked-style unknown transport, a rejection with another reason, or two tool calls cannot attest to head-moved.
  for (const bad of [{ outcome: "unknown", reason: "transport-error", tool_api_calls: 2 }, { outcome: "rejected", reason: "artifact-head-mismatch", tool_api_calls: 0 }, { outcome: "rejected", reason: "head-moved", tool_api_calls: 2 }, { outcome: "rejected", reason: "head-moved", http_status: 409, tool_api_calls: 1 }]) {
    tools[4] = ["corvus_review_post", data.childTools[4][1], JSON.stringify(bad)]
    save(postResult, goodAudit)
    expect(row("writer POST attempted")).toMatchObject({ ok: false })
  }
  tools[4] = ["corvus_review_post", data.childTools[4][1], JSON.stringify(transport)]
  // Negative: the writer must map rejected → not_posted (never unknown), carry the tool reason verbatim and count writer GETs + 1.
  for (const changed of [{ remote_state: "unknown" }, { reason: "PR head moved after review synthesis (commit_id mismatch)" }, { api_calls: 2 }, { api_calls: 4 }]) {
    save({ ...postResult, ...changed }, goodAudit)
    expect(row("writer result")).toMatchObject({ ok: false })
  }
  save({ ...postResult, status: "posted", remote_state: "posted", review_url: "https://github.com/owner/repo/pull/8#pullrequestreview-1", reason: null }, goodAudit)
  expect(row("writer result")).toMatchObject({ ok: false, code: 6 })
})

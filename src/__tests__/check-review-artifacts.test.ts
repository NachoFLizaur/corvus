import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CHECKPOINT_WRITE_ARGUMENT_BUDGET, REVIEW_INPUT_LINE_LIMIT, checkReviewArtifacts, type Inputs } from "../../scripts/check-review-artifacts"
import { freeze } from "../review-payload"

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "corvus-review-check-"))
  directories.push(directory)
  const workspace = join(directory, "fixture")
  const relative = ".corvus/reviews/owner__repo__pr8"
  const root = join(workspace, relative)
  const head = "a".repeat(40)
  mkdirSync(join(root, head), { recursive: true })
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dirname, "../review-payload.ts")], outdir: join(directory, "dist"), target: "bun" })
  expect(build.success).toBe(true)
  writeFileSync(join(root, head, "REVIEW_DOCUMENT.md"), "# Review\n")
  writeFileSync(join(root, head, "meta.yaml"), "autonomous: true\nposted: false\n")
  writeFileSync(join(root, "verified_facts.yaml"), "facts: []\nopen_questions: []\n")
  writeFileSync(join(root, "candidate.json"), JSON.stringify({ commit_id: head, event: "COMMENT", body: "Smoke review — ✓", comments: [] }))
  writeFileSync(join(root, "review-input.json"), JSON.stringify({ pr_number: 8, head_sha: head, description_chunks: ["## Summary\n", "x".repeat(1500)], file_map: {} }, null, 2) + "\n")
  const frozen = freeze(join(root, "candidate.json"), join(root, "post-request.json"), { reviewStateRoot: join(workspace, ".corvus/reviews") })
  if (!frozen.ok) throw new Error(JSON.stringify(frozen))
  const tool = (name: string, input: object, output: object, error?: string) => ({
    type: "tool_use", sessionID: "ses_smoke", part: { tool: name, state: { status: error ? "error" : "completed", input, output: JSON.stringify(output), error } },
  })
  const events = [
    tool("corvus_review_payload", { op: "measure", candidatePath: `${relative}/candidate.json` }, { ok: true }),
    tool("corvus_review_payload", { op: "freeze", candidatePath: `${relative}/candidate.json`, artifactPath: `${relative}/post-request.json` }, frozen),
    tool("corvus_review_verify", { op: "verify", artifactPath: `${relative}/post-request.json`, expectedSha256: frozen.sha256 }, { ok: true }),
    tool("subagent", { agent: "pr-comment-writer" }, {}, "Subagent denied: pr-comment-writer"),
    { type: "step_finish", part: { cost: 0.01, tokens: { input: 10, output: 5, cache: { read: 2, write: 3 } } } },
  ]
  const input: Inputs = { fixture: workspace, owner: "owner", repo: "repo", pr: "8", head, jsonl: join(directory, "run.jsonl"), hostlog: join(directory, "host.log"), audit: join(directory, "gh-audit.log") }
  const saveEvents = () => writeFileSync(input.jsonl, events.map(event => JSON.stringify(event)).join("\n") + "\n")
  saveEvents()
  writeFileSync(input.hostlog, `INFO entrypoint=${directory}/install/node_modules/corvus-ai/server.js msg="loading plugin"\nCORVUS_SMOKE_SESSION {"id":"ses_smoke","agent":"corvus-review-auto"}\n`)
  writeFileSync(input.audit, JSON.stringify({ marker: "CORVUS_SMOKE_GH_FORWARD", argv: ["pr", "view", "8"] }) + "\n")
  return { input, root, events, saveEvents }
}

test("complete real-shaped tool evidence passes; background or unfinished children fail", async () => {
  const data = await fixture()
  writeFileSync(join(data.root, "lock.yaml"), "status: completed\n")
  const result = await checkReviewArtifacts(data.input)
  expect(result.rows.filter(row => !row.ok)).toEqual([])
  expect(result.exitCode).toBe(0)
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
    writeFileSync(data.input.jsonl, [...data.events, ...children].map(event => JSON.stringify(event)).join("\n") + "\n")
    const checked = await checkReviewArtifacts(data.input)
    expect(checked.exitCode).toBe(allowed ? 0 : 5)
    expect(checked.rows.find(row => row.check === "background-dispatch")?.ok).toBe(allowed)
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

test("checkpoint writes: size is advisory, a non-empty document is required, and only an unrecovered write error fails", async () => {
  const data = await fixture()
  const path = join(data.root, data.input.head, "REVIEW_DOCUMENT.md")
  const call = (name: string, input: object, status = "completed") => ({
    type: "tool_use", sessionID: "ses_smoke", part: { tool: name, state: { status, input } },
  })
  const sized = (name: string, chars: number, status = "completed", filePath = path) => {
    const input: Record<string, string> = name === "apply_patch" ? { patchText: "" }
      : name === "write" ? { filePath, content: "" } : { filePath, oldString: "", newString: "" }
    const key = name === "apply_patch" ? "patchText" : name === "write" ? "content" : "newString"
    input[key] = "x".repeat(chars - JSON.stringify(input).length)
    expect(JSON.stringify(input).length).toBe(chars)
    return call(name, input, status)
  }
  const check = async (calls: object[], ok: boolean) => {
    writeFileSync(data.input.jsonl, [...data.events, ...calls].map(event => JSON.stringify(event)).join("\n") + "\n")
    const result = await checkReviewArtifacts(data.input)
    const row = result.rows.find(row => row.check === "checkpoint writes")
    expect(row).toMatchObject({ ok, code: 5 })
    expect(result.exitCode).toBe(ok ? 0 : 5)
    return row!
  }
  expect(CHECKPOINT_WRITE_ARGUMENT_BUDGET).toBe(20000)
  for (const name of ["write", "edit", "apply_patch"]) {
    const bounded = [sized(name, 19999), sized(name, 20000), sized(name, 20000)]
    expect((await check(bounded, true)).detail).toContain("max serialized args 20000 chars (advisory budget 20000; 0 over, informational)")
    // Positive (R10-2): the observed defect shape — a 26k-char write that succeeded — is a success, reported as information only.
    const over = sized(name, 26000)
    expect((await check([over, ...bounded], true)).detail).toContain("max serialized args 26000 chars (advisory budget 20000; 1 over, informational)")
    expect((await check([sized(name, 65000), ...bounded], true)).detail).toContain("1 over, informational")
    // Negative: a write-family error with no later successful write is a real failure.
    const failed = sized(name, 26000, "error")
    expect((await check([failed], false)).detail).toContain(`1 write error(s) without a successful retry: ${name} event`)
    // Positive: retry-with-subdivision — the same error followed by successful smaller writes to the same target passes.
    expect((await check([failed, sized(name, 12000), sized(name, 12000)], true)).detail).toContain("1 write error(s) recovered by a later successful write")
    // Negative: a later successful write to a DIFFERENT known target does not recover the failed one; an earlier success does not either.
    await check([failed, sized("write", 1000, "completed", join(data.root, "meta.yaml"))], name === "apply_patch")
    await check([sized(name, 12000), failed], false)
  }
  // Escapes count toward the advisory size but never fail the gate.
  const escaped = { filePath: join(data.root, "review-input.json"), content: '"\n'.repeat(6100) }
  expect(escaped.content.length).toBeLessThan(20000)
  expect(JSON.stringify(escaped).length).toBeGreaterThan(20000)
  expect((await check([call("write", escaped)], true)).detail).toContain("1 over, informational")
  // R9-3 shape: a 65k apply_patch whose generation was cut mid-JSON errors; it fails only without a successful retry.
  const cut = call("apply_patch", { value: '{"patchText":"' + "x".repeat(65000) }, "error")
  await check([cut], false)
  await check([cut, sized("apply_patch", 12000)], true)
  // Errors from a different parent session do not recover this parent's failure.
  const foreign = { ...sized("write", 1000), sessionID: "ses_other" }
  await check([sized("write", 26000, "error"), foreign], false)
  await check([call("read", { filePath: "x".repeat(65000) })], true)
  for (const content of ["", " \n\t"]) {
    writeFileSync(path, content)
    expect((await check([], false)).detail).toContain("missing/empty REVIEW_DOCUMENT.md")
  }
  rmSync(path)
  expect((await check([], false)).detail).toContain("missing/empty REVIEW_DOCUMENT.md")
})

test("missing writer, reordered tools, active lock and tampered artifact cannot produce a green gate", async () => {
  const data = await fixture()
  data.events.splice(3, 1)
  const measured = data.events.shift()!
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
  rmSync(join(data.root, "verified_facts.yaml"))
  const result = await checkReviewArtifacts(data.input)
  expect(result.exitCode).toBe(3)
  for (const name of ["plugin loaded", "invoked agent", "artifacts", "unexpected denials"]) expect(result.rows.find(row => row.check === name)?.ok).toBe(false)
})

async function v1Fixture() {
  const data = await fixture()
  const directory = resolve(data.input.fixture, "..")
  const install = join(directory, "install/node_modules/corvus-ai")
  const agents = join(directory, "agents.json")
  writeFileSync(agents, JSON.stringify({
    name: "corvus-review-auto", native: false, prompt: "# Corvus Review Auto — Autonomous Orchestrator\n",
    tools: { corvus_review_payload: true, corvus_review_verify: true },
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

test("v1 not-exposed writer capability passes only with zero dispatches and complete local-only evidence; v2 still requires denial", async () => {
  const completion = (apiCalls: number, classification = "not-exposed, cause unknown") => [
    "schema_version: 1",
    "POST_RESULT:",
    "  status: local_only",
    "  review_url: null",
    "  reason: \"pr-comment-writer not-exposed, cause unknown\"",
    "  remote_state: not_posted",
    "  inline_comments_posted: 0",
    "  comments_moved_to_body: 0",
    `  api_calls: ${apiCalls}`,
    "capability_diagnostic:",
    `  classification: "${classification}"`,
    "  capability: pr-comment-writer",
    "  denial_observed: false",
    "  writer_dispatch_attempts: 0",
    "",
  ].join("\n")
  const { input } = await v1Fixture()
  const root = join(input.fixture, ".corvus/reviews/owner__repo__pr8")
  const events = readFileSync(input.jsonl, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
  const writerEvent = events.find(event => event.part?.tool === "subagent")!
  const withoutWriter = events.filter(event => event !== writerEvent)
  const save = (list: object[]) => writeFileSync(input.jsonl, list.map(event => JSON.stringify(event)).join("\n") + "\n")
  const meta = (remoteState: string) => writeFileSync(join(root, input.head, "meta.yaml"), `autonomous: true\nposted: false\nremote_state: ${remoteState}\n`)

  // Positive: no dispatch, completion.yaml + meta.yaml attest local-only, deny rule held, audit clean.
  save(withoutWriter)
  meta("not_posted")
  writeFileSync(join(root, input.head, "completion.yaml"), completion(0))
  const positive = await checkReviewArtifacts(input)
  expect(positive.exitCode).toBe(0)
  expect(positive.rows.find(row => row.check === "writer denied")).toMatchObject({ ok: true })
  expect(positive.rows.find(row => row.check === "writer denied")?.detail).toStartWith("v1 not-exposed: 0 writer dispatch attempts; not-exposed, cause unknown")

  // Negative: same evidence with a recorded posting API call cannot pass.
  writeFileSync(join(root, input.head, "completion.yaml"), completion(1))
  const apiCall = await checkReviewArtifacts(input)
  expect(apiCall.exitCode).toBe(5)
  expect(apiCall.rows.find(row => row.check === "writer denied")).toMatchObject({ ok: false, detail: "stopped before writer dispatch" })

  // Negative: a denied classification, missing terminal diagnostics everywhere, or meta remote_state drift each fail.
  writeFileSync(join(root, input.head, "completion.yaml"), completion(0, "denied"))
  expect((await checkReviewArtifacts(input)).rows.find(row => row.check === "writer denied")?.ok).toBe(false)
  rmSync(join(root, input.head, "completion.yaml"))
  expect((await checkReviewArtifacts(input)).rows.find(row => row.check === "writer denied")?.ok).toBe(false)
  writeFileSync(join(root, input.head, "completion.yaml"), completion(0))
  meta("unknown")
  expect((await checkReviewArtifacts(input)).rows.find(row => row.check === "writer denied")?.ok).toBe(false)
  meta("not_posted")

  // Negative: not-exposed evidence cannot excuse an attempted dispatch lacking denial.
  writerEvent.part.tool = "task"
  writerEvent.part.state.input = { subagent_type: "pr-comment-writer", description: "Post review", prompt: "..." }
  writerEvent.part.state.error = "Tool execution aborted"
  save(events)
  const attempted = await checkReviewArtifacts(input)
  expect(attempted.exitCode).toBe(5)
  expect(attempted.rows.find(row => row.check === "writer denied")).toMatchObject({ ok: false, detail: "writer dispatch lacks ordered denial evidence" })

  // Negative: a completed writer with the same local-only files is still a breach (exit 6).
  writerEvent.part.state.status = "completed"
  delete writerEvent.part.state.error
  save(events)
  const breach = await checkReviewArtifacts(input)
  expect(breach.exitCode).toBe(6)
  expect(breach.rows.find(row => row.check === "writer denied")).toMatchObject({ ok: false, detail: "posting barrier breach: writer executed" })

  // Negative: a forwarded gh mutation in the audit blocks the not-exposed path.
  save(withoutWriter)
  writeFileSync(input.audit, JSON.stringify({ marker: "CORVUS_SMOKE_GH_FORWARD", argv: ["api", "repos/owner/repo/pulls/8/reviews", "-X", "POST"] }) + "\n")
  const mutated = await checkReviewArtifacts(input)
  expect(mutated.exitCode).toBe(6)
  expect(mutated.rows.find(row => row.check === "writer denied")?.ok).toBe(false)
  writeFileSync(input.audit, JSON.stringify({ marker: "CORVUS_SMOKE_GH_FORWARD", argv: ["pr", "view", "8"] }) + "\n")

  // v2 rule unchanged: identical not-exposed evidence without a denial fails.
  writeFileSync(input.hostlog, readFileSync(input.hostlog, "utf8") + `INFO entrypoint=${resolve(input.fixture, "..")}/install/node_modules/corvus-ai/server.js msg="loading plugin"\n`)
  const v2 = await checkReviewArtifacts({ ...input, host: "v2" })
  expect(v2.exitCode).toBe(5)
  expect(v2.rows.find(row => row.check === "writer denied")).toMatchObject({ ok: false, detail: "stopped before writer dispatch" })
})

test("v1 reads decision/meta terminal diagnostics without completion.yaml and rejects missing or conflicting fields", async () => {
  const { input, root, events, saveEvents } = await v1Fixture()
  events.splice(3, 1)
  saveEvents()
  const metaPath = join(root, input.head, "meta.yaml")
  const decisionPath = join(root, input.head, "decision.yaml")
  const completionPath = join(root, input.head, "completion.yaml")
  const baseMeta = { autonomous: true, posted: false }
  const meta = {
    ...baseMeta, status: "posting-validation-failed", remote_state: "not_posted",
    reason: "R5 writer capability not-exposed, cause unknown: host functions.task inventory lists pr-code-reviewer, pr-context-gatherer, researcher, security-reviewer, but not required pr-comment-writer. No writer dispatch or posting API call attempted.",
  }
  const postResult = { status: "local_only", remote_state: "not_posted", api_calls: 0 }
  const diagnostic = { classification: "not-exposed, cause unknown" }
  const save = (path: string, value: object) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n")
  const check = async (ok: boolean) => {
    const result = await checkReviewArtifacts(input)
    expect(result.rows.find(row => row.check === "writer denied")).toMatchObject({ ok })
    expect(result.rows.filter(row => !row.ok).map(row => row.check)).toEqual(ok ? [] : ["writer denied"])
    expect(result.exitCode).toBe(ok ? 0 : 5)
  }

  save(metaPath, meta)
  save(decisionPath, { POST_RESULT: postResult })
  await check(true)
  save(decisionPath, { POST_RESULT: { ...postResult, api_calls: 1 } })
  await check(false)
  save(completionPath, { POST_RESULT: postResult, capability_diagnostic: diagnostic })
  await check(false)
  rmSync(completionPath)
  save(decisionPath, { POST_RESULT: postResult, capability_diagnostic: { classification: "denied" } })
  await check(false)

  rmSync(decisionPath)
  save(metaPath, { ...baseMeta, ...postResult, capability_diagnostic: diagnostic })
  await check(true)
  for (const missing of ["remote_state", "api_calls", "capability_diagnostic"]) {
    const terminal: Record<string, unknown> = { ...baseMeta, ...postResult, capability_diagnostic: diagnostic }
    delete terminal[missing]
    save(metaPath, terminal)
    await check(false)
  }
  save(metaPath, baseMeta)
  await check(false)
})

test("CLI emits one SMOKE_RESULT JSON line with per-check status and the process exit code", async () => {
  const { input, root } = await fixture()
  const args = [input.fixture, input.owner, input.repo, input.pr, input.head, input.jsonl, input.hostlog, input.audit]
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
      passed: exitCode ? 17 : 18, total: 18, exitCode,
    })
  }
  const usage = await run([])
  expect(usage.exitCode).toBe(3)
  expect(usage.summary).toMatchObject({ checks: [{ check: "arguments", status: "FAIL" }], passed: 0, total: 1 })
  const invalidHost = await run([...args, "--host", "invalid"])
  expect(invalidHost.exitCode).toBe(5)
  expect(invalidHost.summary).toMatchObject({ checks: [{ check: "checker", status: "FAIL" }], passed: 0, total: 1 })
})

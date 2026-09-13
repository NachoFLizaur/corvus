import { Buffer } from "node:buffer"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import * as nodeFs from "node:fs"
import { isAbsolute } from "node:path"
import { verify, type CandidateRequest, type ReviewPayloadFs } from "./review-payload"

export type PostInput = {
  artifactPath: string
  expectedSha256: string
  repo: { owner: string; name: string }
  prNumber: number
  headSha: string
  event: CandidateRequest["event"]
}

export type PostExecResult = { code: number; stdout: string; stderr: string }
export type PostExec = (argv: string[]) => Promise<PostExecResult>
export type PostOptions = {
  reviewStateRoot: string
  fs?: ReviewPayloadFs
  exec?: PostExec
  timeoutMs?: number
}
export type TransportResult = {
  outcome: "posted" | "rejected" | "unknown"
  http_status?: number
  review_url?: string
  reason?: string
  tool_api_calls: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const RETRY_DELAY_MS = 2_000
const INPUT_KEYS = ["artifactPath", "expectedSha256", "repo", "prNumber", "headSha", "event"]
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value
const rejected = (reason: string, calls = 0): TransportResult =>
  ({ outcome: "rejected", reason, tool_api_calls: calls })

/**
 * The closed descriptor is the input oracle, checked before file I/O or exec.
 * Invalid controls reject for direct callers and the tool wrapper alike; exact
 * regex matches prevent trailing-newline acceptance. No argument bypasses this.
 */
function invalidInput(input: unknown): string | undefined {
  if (!isRecord(input) || Object.keys(input).some(key => !INPUT_KEYS.includes(key))) return "arguments"
  if (typeof input.artifactPath !== "string" || input.artifactPath.length === 0 || input.artifactPath.includes("\0")) return "artifactPath"
  if (!matches(input.expectedSha256, /^[a-f0-9]{64}$/)) return "expectedSha256"
  if (!isRecord(input.repo) || Object.keys(input.repo).some(key => key !== "owner" && key !== "name")) return "repo"
  if (!matches(input.repo.owner, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)) return "repo.owner"
  if (!matches(input.repo.name, /^[A-Za-z0-9._-]{1,100}$/) || input.repo.name === "." || input.repo.name === "..") return "repo.name"
  if (typeof input.prNumber !== "number" || !Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) return "prNumber"
  if (!matches(input.headSha, /^[a-f0-9]{40}$/)) return "headSha"
  if (input.event !== "APPROVE" && input.event !== "REQUEST_CHANGES" && input.event !== "COMMENT") return "event"
}

type ArtifactResult = { ok: true; path: string; request: CandidateRequest } | { ok: false; reason: string }

/**
 * verify owns containment, schema, canonical-byte, digest and budget checks.
 * Capture its read so commit/event checks inspect those same bytes, not a second
 * unchecked read. Before GET and each POST, failures reject without that exec;
 * injected filesystems cannot disable verification. No filesystem write is used.
 */
function readArtifact(input: PostInput, opts: PostOptions): ArtifactResult {
  const fs = opts.fs ?? nodeFs
  let bytes: Buffer | undefined
  let path = input.artifactPath
  const checked = verify(input.artifactPath, input.expectedSha256, {
    reviewStateRoot: opts.reviewStateRoot,
    fs: {
      readFileSync(target) {
        path = target
        bytes = Buffer.from(fs.readFileSync(target))
        return bytes
      },
      realpathSync: target => fs.realpathSync(target),
      statSync: target => fs.statSync(target),
      lstatSync: target => fs.lstatSync(target),
      writeFileSync() { throw new Error("artifact-write-disabled") },
    },
  })
  if (!checked.ok) return { ok: false, reason: `artifact-verify-failed:${checked.reason ?? "unknown"}` }
  if (!bytes) return { ok: false, reason: "artifact-verify-failed:artifact-read-error" }
  const request = JSON.parse(bytes.toString("utf8")) as CandidateRequest
  if (request.commit_id !== input.headSha) return { ok: false, reason: "artifact-head-mismatch" }
  if (request.event !== input.event) return { ok: false, reason: "artifact-event-mismatch" }
  return { ok: true, path, request }
}

class ExecTimeout extends Error {}

/**
 * A per-attempt deadline starts before exec/spawn. Expiry rejects to unknown,
 * kills the owned gh process, and never authorizes a retry. Injected executors
 * get the same deadline but own cancellation of their work; no option disables
 * the deadline. PATH and the inherited environment select gh, never a shell.
 */
function execute(argv: string[], exec: PostExec | undefined, timeoutMs: number): Promise<PostExecResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams | undefined
    const timer = setTimeout(() => {
      reject(new ExecTimeout())
      child?.kill("SIGKILL")
    }, timeoutMs)
    const done = (result: PostExecResult) => { clearTimeout(timer); resolve(result) }
    const failed = (error: unknown) => { clearTimeout(timer); reject(error) }
    try {
      if (exec) {
        exec(argv).then(done, failed)
        return
      }
      child = spawn("gh", argv.slice(1), { stdio: "pipe", env: process.env })
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
      child.once("error", failed)
      child.once("close", code => {
        if (code === null) failed(new Error("exec-signal"))
        else done({ code, stdout, stderr })
      })
      child.stdin.on("error", failed)
      child.stdin.end()
    } catch (error) {
      failed(error)
    }
  })
}

function jsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function codeHead(text: string): string | undefined {
  try {
    const pages: unknown = JSON.parse(text)
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) return undefined
    const commits: unknown[] = pages.flat()
    let head: string | undefined
    for (const item of commits) {
      if (!isRecord(item) || !matches(item.sha, /^[a-fA-F0-9]{40}$/)
        || !isRecord(item.commit) || typeof item.commit.message !== "string") return undefined
      if (!item.commit.message.startsWith("corvus(review-state):")) head = item.sha.toLowerCase()
    }
    return head
  } catch {
    return undefined
  }
}

function httpStatus(result: PostExecResult): number | undefined {
  for (const text of [result.stderr, result.stdout]) {
    const match = /\bHTTP\s+([45][0-9]{2})\b/.exec(text)
    if (match) return Number(match[1])
  }
  for (const text of [result.stdout, result.stderr]) {
    const status = jsonRecord(text)?.status
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return status
    if (matches(status, /^[45][0-9]{2}$/)) return Number(status)
  }
}

/**
 * Only API message fields or gh's first diagnostic line feed failure reasons;
 * response bodies, error objects and raw command output are never returned.
 * Artifact bodies and their lines/JSON escapes are the redaction oracle before
 * returning a remote message. A match suppresses the message; no caller bypasses
 * redaction. This does not identify arbitrary paraphrases of review content.
 */
function failureReason(result: PostExecResult, status: number, request: CandidateRequest): string {
  const prefix = `HTTP ${status}`
  let message: string | undefined
  for (const text of [result.stdout, result.stderr]) {
    const value = jsonRecord(text)?.message
    if (typeof value === "string" && value.trim()) { message = value; break }
  }
  message ??= result.stderr.split(/\r?\n/).find(line => line.startsWith("gh: "))
    ?.slice(4).replace(/\s*\(HTTP [0-9]{3}\)\s*$/, "")
  if (!message) return `${prefix}: request failed`
  const bodies = [request.body, ...request.comments.map(comment => comment.body)]
  for (const body of bodies) {
    const fragments = [body, ...body.split(/\r?\n/)].filter(fragment => fragment.trim().length > 0)
    if (fragments.some(fragment => message.includes(fragment) || message.includes(JSON.stringify(fragment).slice(1, -1)))) {
      return `${prefix}: remote message redacted`
    }
  }
  return `${prefix}: ${message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 512)}`
}

function failure(result: PostExecResult, request: CandidateRequest, calls: number): TransportResult {
  const status = httpStatus(result)
  if (status === undefined) return { outcome: "unknown", reason: "transport-error", tool_api_calls: calls }
  return {
    outcome: status < 500 ? "rejected" : "unknown",
    http_status: status,
    reason: failureReason(result, status, request),
    tool_api_calls: calls,
  }
}

function reviewUrl(stdout: string): string | undefined {
  const value = jsonRecord(stdout)?.html_url
  if (typeof value !== "string" || value.trim() !== value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The validated descriptor, verified file bytes and live GET code head are the posting
 * oracles, read before POST. Preflight failures reject; HTTP 4xx reject, while
 * timeout, network, 5xx and malformed success responses remain unknown for the
 * writer/R5. Only the first POST's definitive 429 permits one retry after 2s;
 * the retry re-verifies the same descriptor and file without changing the event.
 * No body-only path or option disables these checks. Exec attempts are counted
 * before dispatch, including failures. Verification and gh's file read are not
 * atomic, and the GET head is not a lock against later head movement.
 * The paginated commit messages select the newest non-state commit before POST;
 * state-only tips therefore preserve identity. Slurped pages are parsed in TypeScript;
 * missing or malformed identity fails closed as unknown/transport-error without POST.
 */
export async function post(input: PostInput, opts: PostOptions): Promise<TransportResult> {
  const invalid = invalidInput(input)
  if (invalid) return rejected(`invalid-input:${invalid}`)
  if (!opts || typeof opts.reviewStateRoot !== "string" || !opts.reviewStateRoot.trim()) return rejected("invalid-review-state-root")
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return rejected("invalid-timeout")
  const descriptor: PostInput = { ...input, repo: { ...input.repo } }
  const options: PostOptions = { ...opts }
  let artifact = readArtifact(descriptor, options)
  if (!artifact.ok) return rejected(artifact.reason)
  const endpoint = `repos/${descriptor.repo.owner}/${descriptor.repo.name}/pulls/${descriptor.prNumber}`
  const accept = ["-H", "Accept: application/vnd.github+json"]
  let calls = 0
  const run = (argv: string[]) => {
    calls++
    return execute(argv, options.exec, timeoutMs)
  }
  try {
    const head = await run(["gh", "api", "--method", "GET", "--paginate", "--slurp", `${endpoint}/commits`, ...accept])
    if (head.code !== 0) return failure(head, artifact.request, calls)
    const currentHead = codeHead(head.stdout)
    if (!currentHead) return { outcome: "unknown", reason: "transport-error", tool_api_calls: calls }
    if (currentHead !== descriptor.headSha) return rejected("head-moved", calls)
    let retried = false
    for (;;) {
      artifact = readArtifact(descriptor, options)
      if (!artifact.ok) return rejected(artifact.reason, calls)
      const result = await run(["gh", "api", "--method", "POST", `${endpoint}/reviews`, "--input", artifact.path, ...accept])
      if (result.code === 0) {
        const url = reviewUrl(result.stdout)
        return url ? { outcome: "posted", review_url: url, tool_api_calls: calls }
          : { outcome: "unknown", reason: "invalid-post-response", tool_api_calls: calls }
      }
      if (httpStatus(result) !== 429 || retried) return failure(result, artifact.request, calls)
      retried = true
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
  } catch (error) {
    return { outcome: "unknown", reason: error instanceof ExecTimeout ? "timeout" : "exec-failed", tool_api_calls: calls }
  }
}

/**
 * Capture the host-supplied absolute review-state root, never a tool argument.
 * Both hosts receive JSON transport results; invalid context rejects before I/O.
 * No input overrides the root. Artifact paths retain verify's path semantics.
 *
 * The caller oracle is host ctx.agent, forwarded separately on each invocation
 * before artifact I/O or transport. Only pr-comment-writer passes; missing or
 * other identities reject with zero tool_api_calls for both hosts. No tool
 * argument or option disables this check.
 */
export function createPostExecutor(reviewStateRoot: string): (input: unknown, caller?: unknown) => Promise<string> {
  const root = typeof reviewStateRoot === "string" && isAbsolute(reviewStateRoot) ? reviewStateRoot : undefined
  return async (input, caller) => {
    if (caller !== "pr-comment-writer") return JSON.stringify(rejected("caller-not-allowed"))
    return JSON.stringify(root
      ? await post(input as PostInput, { reviewStateRoot: root })
      : rejected("invalid-review-state-root"))
  }
}

import { Buffer } from "node:buffer"
import { isLegacyReviewPath, isReviewPath } from "./review-persist"
import { createHash } from "node:crypto"
import * as nodeFs from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"

export type CandidateRequest = {
  commit_id: string
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
  body: string
  comments: Array<{
    path: string
    line: number
    side: "LEFT" | "RIGHT"
    start_line?: number
    start_side?: "LEFT" | "RIGHT"
    body: string
  }>
}

export const LIMITS = Object.freeze({ body: 24000, comment: 4000, total: 48000 })

export type Size = { codePoints: number; utf8Bytes: number }
export type Measurements = {
  body: Size
  comments: Array<Size & { index: number }>
  total: Size
}
export type Violation = {
  field: "body" | `comments[${number}].body` | "total"
  unit: keyof Size
  limit: number
  actual: number
  reason: "limit-exceeded"
}
export type CandidateRejection = {
  ok: false
  reason: "unknown-field" | "missing-field" | "invalid-field"
  field: string
}
export type MeasureResult = CandidateRejection | {
  ok: boolean
  canonical: string
  sha256: string
  measurements: Measurements
  violations: Violation[]
}

export type ReviewPayloadFs = {
  readFileSync(path: string): Buffer
  writeFileSync(path: string, data: Uint8Array): void
  realpathSync(path: string): string
  statSync(path: string): Pick<nodeFs.Stats, "isFile" | "isDirectory">
  lstatSync(path: string): Pick<nodeFs.Stats, "isSymbolicLink">
}
export type ReviewPayloadOptions = {
  reviewStateRoot: string
  fs?: ReviewPayloadFs
}

type PathRejection = {
  ok: false
  reason: "path-outside-root" | "path-resolution-error" | "not-regular-file"
  path: string
}
type ParseReason = "parse-error" | "duplicate-key" | "encoding-error"
export type FreezeResult =
  | { ok: true; artifactPath: string; sha256: string; measurements: Measurements }
  | CandidateRejection
  | PathRejection
  | { ok: false; reason: "candidate-bom" | `candidate-${ParseReason}` | "candidate-read-error" | "artifact-write-error" | "artifact-read-error" }
  | { ok: false; reason: "budget-violation"; violations: Violation[]; measurements: Measurements }
  | { ok: false; reason: "readback-mismatch"; expectedBytes: number; actualBytes: number }

export type VerifyResult = {
  ok: boolean
  sha256Match: boolean
  canonical: boolean
  violations: Violation[]
  measurements: Measurements | null
  reason?: PathRejection["reason"] | CandidateRejection["reason"] | `artifact-${ParseReason}`
    | "artifact-read-error" | "artifact-bom" | "artifact-crlf" | "missing-final-lf"
    | "non-canonical" | "budget-violation" | "sha256-mismatch"
  field?: string
  path?: string
}

const REQUEST_KEYS = ["commit_id", "event", "body", "comments"] as const
const COMMENT_KEYS = ["path", "line", "side", "start_line", "start_side", "body"] as const
const COMMENT_REQUIRED = ["path", "line", "side", "body"] as const
const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const isSide = (value: unknown): value is "LEFT" | "RIGHT" => value === "LEFT" || value === "RIGHT"
const isLine = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0
const invalid = (field: string): CandidateRejection => ({ ok: false, reason: "invalid-field", field })

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  prefix = "",
): CandidateRejection | undefined {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return { ok: false, reason: "unknown-field", field: prefix + key }
  }
  for (const key of required) {
    if (!hasOwn(value, key)) return { ok: false, reason: "missing-field", field: prefix + key }
  }
}

/**
 * The closed schema is the oracle, inspected before serialization or file writes.
 * R3/R4 receive a rejection and R5 cannot verify invalid input; no option disables
 * validation. Bodies are opaque strings, never diagnostic values.
 */
function checkCandidate(value: unknown): CandidateRejection | undefined {
  if (!isRecord(value)) return invalid("request")
  const keys = checkKeys(value, REQUEST_KEYS, REQUEST_KEYS)
  if (keys) return keys
  if (typeof value.commit_id !== "string" || value.commit_id.length !== 40 || !/^[a-f0-9]{40}$/.test(value.commit_id)) return invalid("commit_id")
  if (value.event !== "APPROVE" && value.event !== "REQUEST_CHANGES" && value.event !== "COMMENT") return invalid("event")
  if (!nonempty(value.body)) return invalid("body")
  if (!Array.isArray(value.comments)) return invalid("comments")
  for (let index = 0; index < value.comments.length; index++) {
    const comment: unknown = value.comments[index]
    const field = `comments[${index}]`
    if (!isRecord(comment)) return invalid(field)
    const keys = checkKeys(comment, COMMENT_KEYS, COMMENT_REQUIRED, `${field}.`)
    if (keys) return keys
    if (!nonempty(comment.path) || /^[A-Za-z]:/.test(comment.path)
      || /[\\\u0000-\u001f\u007f]/.test(comment.path)
      || comment.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      return invalid(`${field}.path`)
    }
    if (!isLine(comment.line)) return invalid(`${field}.line`)
    if (!isSide(comment.side)) return invalid(`${field}.side`)
    if (!nonempty(comment.body)) return invalid(`${field}.body`)
    const hasStartLine = hasOwn(comment, "start_line")
    const hasStartSide = hasOwn(comment, "start_side")
    if (hasStartLine !== hasStartSide) return invalid(`${field}.${hasStartLine ? "start_side" : "start_line"}`)
    if (hasStartLine) {
      if (!isLine(comment.start_line) || comment.start_line >= comment.line) return invalid(`${field}.start_line`)
      if (!isSide(comment.start_side) || comment.start_side !== comment.side) return invalid(`${field}.start_side`)
    }
  }
}

function serialize(req: CandidateRequest): string {
  return JSON.stringify({
    commit_id: req.commit_id,
    event: req.event,
    body: req.body,
    comments: req.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      ...(hasOwn(comment, "start_line") ? { start_line: comment.start_line } : {}),
      ...(hasOwn(comment, "start_side") ? { start_side: comment.start_side } : {}),
      body: comment.body,
    })),
  }, null, 2) + "\n"
}

/** R3/R4 serialize exact strings and ordered API keys; invalid input throws a TypeError with a CandidateRejection cause. */
export function canonicalize(req: CandidateRequest): string {
  const rejection = checkCandidate(req)
  if (rejection) throw new TypeError("Invalid review candidate", { cause: rejection })
  return serialize(req)
}

const size = (text: string): Size => ({ codePoints: [...text].length, utf8Bytes: Buffer.byteLength(text, "utf8") })
const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/**
 * R3 measures rendered candidates; R4 and writer/R5 repeat the same checks.
 * Decoded bodies and the entire canonical serialization are the size oracle,
 * read before any write. Either unit exceeding its ceiling rejects posting;
 * no option or empty comments array disables a ceiling. Only `canonical`
 * contains payload text; diagnostics contain fields and measurements only.
 */
export function measure(req: unknown): MeasureResult {
  const rejection = checkCandidate(req)
  if (rejection) return rejection
  const candidate = req as CandidateRequest
  const canonical = serialize(candidate)
  const measurements: Measurements = {
    body: size(candidate.body),
    comments: candidate.comments.map((comment, index) => ({ index, ...size(comment.body) })),
    total: size(canonical),
  }
  const violations: Violation[] = []
  const check = (field: Violation["field"], measured: Size, limit: number): void => {
    for (const unit of ["codePoints", "utf8Bytes"] as const) {
      if (measured[unit] > limit) violations.push({ field, unit, limit, actual: measured[unit], reason: "limit-exceeded" })
    }
  }
  check("body", measurements.body, LIMITS.body)
  for (const comment of measurements.comments) check(`comments[${comment.index}].body`, comment, LIMITS.comment)
  check("total", measurements.total, LIMITS.total)
  return { ok: violations.length === 0, canonical, sha256: digest(canonical), measurements, violations }
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

/**
 * The real review root, real parent and any existing leaf target are the oracle,
 * checked before reads/writes. R4/R5 reject traversal and escapes; missing parents
 * fail closed, and only an absent artifact leaf is permitted for creation.
 * No option disables containment. These preflight checks are not an atomic
 * filesystem snapshot and do not prevent concurrent path replacement.
 * With a .corvus host root, both the requested and real paths must include the
 * review layout before I/O; artifact creation also rejects legacy namespaces.
 */
function checkedPath(
  path: string,
  opts: ReviewPayloadOptions,
  fs: ReviewPayloadFs,
  allowMissing: boolean,
): { ok: true; path: string } | PathRejection {
  const reject = (reason: PathRejection["reason"]): PathRejection => ({ ok: false, reason, path })
  if (path.split(/[\\/]/).includes("..")) return reject("path-outside-root")
  try {
    const configuredRoot = resolve(opts.reviewStateRoot)
    const root = fs.realpathSync(configuredRoot)
    if (!fs.statSync(root).isDirectory()) return reject("path-resolution-error")
     const absolute = resolve(path)
     if (!inside(configuredRoot, absolute) && !inside(root, absolute)) return reject("path-outside-root")
     if (basename(configuredRoot) === ".corvus" && (!isReviewPath(relative(inside(configuredRoot, absolute) ? configuredRoot : root, absolute))
       || (allowMissing && isLegacyReviewPath(absolute)))) return reject("path-outside-root")
    const parent = fs.realpathSync(dirname(absolute))
     if (!inside(root, parent)) return reject("path-outside-root")
     if (basename(configuredRoot) === ".corvus" && !isReviewPath(relative(root, parent))) return reject("path-outside-root")
    if (!fs.statSync(parent).isDirectory()) return reject("path-resolution-error")
    const target = resolve(parent, basename(absolute))
    let metadata: ReturnType<ReviewPayloadFs["lstatSync"]>
    try {
      metadata = fs.lstatSync(target)
    } catch (error) {
      if (allowMissing && isMissing(error)) return { ok: true, path: target }
      return reject("path-resolution-error")
    }
    const realTarget = metadata.isSymbolicLink() ? fs.realpathSync(target) : target
    if (!inside(root, realTarget)) return reject("path-outside-root")
    if (!fs.statSync(realTarget).isFile()) return reject("not-regular-file")
    return { ok: true, path: realTarget }
  } catch {
    return reject("path-resolution-error")
  }
}

const hasBom = (bytes: Buffer): boolean => bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf

/**
 * JSON syntax and decoded object keys are checked before measurement or writes.
 * R4/R5 reject invalid UTF-8 and duplicate keys instead of accepting replacement
 * characters or last-key-wins parsing; there is no bypass.
 */
function parse(bytes: Buffer): { ok: true; value: unknown } | { ok: false; reason: ParseReason } {
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) return { ok: false, reason: "encoding-error" }
  try {
    const value: unknown = JSON.parse(text)
    const stack: Array<Set<string> | null> = []
    for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}]|\[|\]/g)) {
      const part = token[0]
      if (part === "{") stack.push(new Set())
      else if (part === "[") stack.push(null)
      else if (part === "}" || part === "]") stack.pop()
      else if (/^\s*:/.test(text.slice(token.index + part.length))) {
        const keys = stack[stack.length - 1]
        const key: string = JSON.parse(part)
        if (keys?.has(key)) return { ok: false, reason: "duplicate-key" }
        keys?.add(key)
      }
    }
    return { ok: true, value }
  } catch {
    return { ok: false, reason: "parse-error" }
  }
}

/**
 * R4 freezes an authorized candidate; authorization itself belongs to the caller.
 * Measured canonical bytes are the oracle before writing. Length and byte equality
 * of the full read-back precede returning its digest; any failure keeps R4 local-only.
 * No option disables these checks, and no failure result contains review text.
 */
export function freeze(candidatePath: string, artifactPath: string, opts: ReviewPayloadOptions): FreezeResult {
  const fs = opts.fs ?? nodeFs
  const candidate = checkedPath(candidatePath, opts, fs, false)
  if (!candidate.ok) return candidate
  const artifact = checkedPath(artifactPath, opts, fs, true)
  if (!artifact.ok) return artifact
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(candidate.path)
  } catch {
    return { ok: false, reason: "candidate-read-error" }
  }
  if (hasBom(bytes)) return { ok: false, reason: "candidate-bom" }
  const parsed = parse(bytes)
  if (!parsed.ok) return { ok: false, reason: `candidate-${parsed.reason}` }
  const measured = measure(parsed.value)
  if ("reason" in measured) return measured
  if (!measured.ok) {
    return { ok: false, reason: "budget-violation", violations: measured.violations, measurements: measured.measurements }
  }
  const expected = Buffer.from(measured.canonical, "utf8")
  try {
    fs.writeFileSync(artifact.path, Buffer.from(expected))
  } catch {
    return { ok: false, reason: "artifact-write-error" }
  }
  let actual: Buffer
  try {
    actual = fs.readFileSync(artifact.path)
  } catch {
    return { ok: false, reason: "artifact-read-error" }
  }
  if (actual.length !== expected.length || !actual.equals(expected)) {
    return { ok: false, reason: "readback-mismatch", expectedBytes: expected.length, actualBytes: actual.length }
  }
  return { ok: true, artifactPath: artifact.path, sha256: digest(actual), measurements: measured.measurements }
}

/**
 * Writer/R5 verify without writing. The trusted expected digest and canonical
 * reserialization are the oracles for the bytes read on this call, before posting.
 * Any path, read, schema, format, digest or budget failure rejects posting; no
 * option disables a check. This does not attest to bytes changed after the read.
 */
export function verify(artifactPath: string, expectedSha256: string, opts: ReviewPayloadOptions): VerifyResult {
  const fs = opts.fs ?? nodeFs
  const failed: VerifyResult = { ok: false, sha256Match: false, canonical: false, violations: [], measurements: null }
  const artifact = checkedPath(artifactPath, opts, fs, false)
  if (!artifact.ok) return { ...failed, reason: artifact.reason, path: artifact.path }
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(artifact.path)
  } catch {
    return { ...failed, reason: "artifact-read-error" }
  }
  const sha256Match = digest(bytes) === expectedSha256
  const readFailure = { ...failed, sha256Match }
  if (hasBom(bytes)) return { ...readFailure, reason: "artifact-bom" }
  const formattingReason = bytes.includes(Buffer.from("\r\n")) ? "artifact-crlf"
    : bytes[bytes.length - 1] !== 0x0a ? "missing-final-lf" : undefined
  const parsed = parse(bytes)
  if (!parsed.ok) return { ...readFailure, reason: formattingReason ?? `artifact-${parsed.reason}` }
  const measured = measure(parsed.value)
  if ("reason" in measured) return { ...readFailure, reason: measured.reason, field: measured.field }
  const canonical = !formattingReason && Buffer.from(measured.canonical, "utf8").equals(bytes)
  const reason = formattingReason ?? (!canonical ? "non-canonical"
    : !measured.ok ? "budget-violation" : !sha256Match ? "sha256-mismatch" : undefined)
  return {
    ok: sha256Match && canonical && measured.ok,
    sha256Match,
    canonical,
    violations: measured.violations,
    measurements: measured.measurements,
    ...(reason ? { reason } : {}),
  }
}

/** Measure a contained candidate file without returning its review text or writing it. */
export function measureFile(candidatePath: string, opts: ReviewPayloadOptions) {
  const fs = opts.fs ?? nodeFs
  const candidate = checkedPath(candidatePath, opts, fs, false)
  if (!candidate.ok) return candidate
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(candidate.path)
  } catch {
    return { ok: false, reason: "candidate-read-error" } as const
  }
  if (hasBom(bytes)) return { ok: false, reason: "candidate-bom" } as const
  const parsed = parse(bytes)
  if (!parsed.ok) return { ok: false, reason: `candidate-${parsed.reason}` } as const
  const measured = measure(parsed.value)
  if ("reason" in measured) return measured
  const { canonical: _canonical, ...result } = measured
  return result
}

/**
 * The host directory captured at registration is the root oracle, never tool args
 * or process cwd. Closed operation-specific keys are checked before any file I/O;
 * relative paths retain traversal segments for checkedPath to reject. R3/R4 and
 * writer/R5 receive a failure for missing host context, invalid args or containment
 * failures. The verify entry cannot dispatch a write; no argument disables this
 * separation or containment. Only freeze writes, after the core's preflight checks.
 */
export function createReviewToolExecutors(directory: string) {
  const opts = typeof directory === "string" && isAbsolute(directory)
     ? { reviewStateRoot: resolve(directory, ".corvus") } : undefined
  const path = (value: string) => isAbsolute(value) ? value : `${directory}${sep}${value}`
  const validate = (input: unknown, operations: readonly string[]): CandidateRejection | undefined => {
    if (!isRecord(input)) return invalid("arguments")
    if (typeof input.op !== "string" || !operations.includes(input.op)) return invalid("op")
    const keys = input.op === "measure" ? ["op", "candidatePath"]
      : input.op === "freeze" ? ["op", "candidatePath", "artifactPath"]
      : ["op", "artifactPath", "expectedSha256"]
    return checkKeys(input, keys, keys) ?? keys.map(key => nonempty(input[key]) ? undefined : invalid(key)).find(Boolean)
  }
  return {
    payload(input: unknown): string {
      const rejection = validate(input, ["measure", "freeze"])
      if (rejection) return JSON.stringify(rejection)
      if (!opts) return JSON.stringify({ ok: false, reason: "invalid-workspace-directory" })
      const args = input as { op: "measure"; candidatePath: string } | { op: "freeze"; candidatePath: string; artifactPath: string }
      return JSON.stringify(args.op === "measure"
        ? measureFile(path(args.candidatePath), opts)
        : freeze(path(args.candidatePath), path(args.artifactPath), opts))
    },
    verify(input: unknown): string {
      const rejection = validate(input, ["verify"])
      if (rejection) return JSON.stringify(rejection)
      if (!opts) return JSON.stringify({ ok: false, reason: "invalid-workspace-directory" })
      const args = input as { op: "verify"; artifactPath: string; expectedSha256: string }
      return JSON.stringify(verify(path(args.artifactPath), args.expectedSha256, opts))
    },
  }
}

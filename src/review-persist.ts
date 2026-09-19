import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import * as nodeFs from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import yaml from "js-yaml"
import { measure, type CandidateRequest, type ReviewPayloadFs } from "./review-payload"

export type ReviewPersistFs = Omit<ReviewPayloadFs, "writeFileSync"> & {
  writeFileSync(path: string, data: Uint8Array, options: { flag: "wx"; mode: number }): void
  mkdirSync(path: string): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
  rmSync?(path: string, options: { recursive: true; force: true }): void
  linkSync?(existingPath: string, newPath: string): void
}
export type PersistOptions = { reviewStateRoot: string; fs?: ReviewPersistFs }
export type DocumentSection = { heading: string; body: string }
export type DocumentInput = {
  reviewRoot: string
  headSha: string
  sections: DocumentSection[]
  frontmatterYaml?: string
}
export type InputInput = { reviewRoot: string; input: object }
export type MetaInput = { reviewRoot: string; headSha: string; meta: object; name?: string }
export type FactsInput = { reviewRoot: string; facts: object }
export type CandidateInput = { reviewRoot: string; candidate: CandidateRequest }
export type ReadDocumentInput = { reviewRoot: string; headSha: string }
export type PersistRejection = {
  ok: false
  reason: "invalid-arguments" | "invalid-op" | "invalid-review-state-root" | "invalid-head-sha"
    | "invalid-json" | "invalid-yaml" | "invalid-document" | "ambiguous-document"
    | "unknown-field" | "missing-field" | "invalid-field" | "chunk-field-collision"
    | "unbreakable-line" | "line-too-long" | "path-outside-root" | "path-resolution-error"
    | "not-regular-file" | "symlink-target" | "write-error" | "read-error" | "encoding-error"
    | "readback-mismatch" | "cleanup-error" | "unknown-record" | "not-found"
    | "unknown-staging" | "incomplete-staging" | "chunk-too-large" | "heading-conflict"
    | "part-count-conflict" | "part-type-conflict" | "merge-conflict"
  expectedBytes?: number
  actualBytes?: number
  length?: number
  missing?: StagingGap[]
  unexpected?: Array<number | string>
}
export type WriteResult = PersistRejection | {
  ok: true; path: string; sha256: string; lines: number; bytes: number
}
export type ReadDocumentResult = PersistRejection | {
  ok: true; sections: DocumentSection[]; frontmatterYaml: string | null; sha256: string; lines: number
}
export type ReadFactsResult = PersistRejection | {
  ok: true; facts: object; sha256: string; lines: number
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type Operation = "write_document" | "write_input" | "write_meta" | "write_candidate" | "read_document" | "write_facts" | "read_facts"
type StagingOperation = "begin" | "append" | "finalize" | "abort" | "status"
type StagingFs = ReviewPersistFs & Required<Pick<ReviewPersistFs, "rmSync" | "linkSync">>
type ParsedDocument = { sections: DocumentSection[]; frontmatterYaml: string | null }
const LINE_LIMIT = 1_900
const STRING_LIMIT = 1_500
const KEYS: Record<Operation, readonly string[]> = {
  write_document: ["reviewRoot", "headSha", "sections", "frontmatterYaml"],
  write_input: ["reviewRoot", "input"],
  write_meta: ["reviewRoot", "headSha", "meta", "name"],
  write_candidate: ["reviewRoot", "candidate"],
  read_document: ["reviewRoot", "headSha"],
  write_facts: ["reviewRoot", "facts"],
  read_facts: ["reviewRoot"],
}
const META_NAMES = new Set(["meta.yaml", "decision.yaml", "completion.yaml", "authorization.yaml", "review-action.yaml"])
const STAGING_KEYS: Record<StagingOperation, readonly string[]> = {
  begin: ["reviewRoot", "headSha", "target", "expected_sections", "frontmatterYaml", "commit_id", "event"],
  append: ["reviewRoot", "staging_id", "index", "part", "parts", "heading", "body", "key", "value", "chunk", "path", "comment", "field", "text", "anchor"],
  finalize: ["reviewRoot", "staging_id", "expected_sections", "expected_keys", "expected_comments"],
  abort: ["reviewRoot", "staging_id"],
  status: ["reviewRoot", "staging_id"],
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")
const lineCount = (text: string): number => text === "" ? 0 : text.split("\n").length - Number(text.endsWith("\n"))
const overlong = (text: string): boolean => text.split("\n").some(line => line.length > LINE_LIMIT)
const missing = (error: unknown): boolean => isRecord(error) && error.code === "ENOENT"
const inside = (root: string, path: string): boolean => {
  const suffix = relative(root, path)
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

/**
 * Repo spelling and the branch (or detached head SHA) are read before path I/O.
 * Invalid repo/empty branch inputs reject; every non-slug character becomes one
 * hyphen, leaving a single local namespace component. No override disables this
 * derivation; resolveReviewDirectory still enforces filesystem containment.
 */
export function localReviewNamespace(repo: string, branch: string): string {
  if (typeof repo !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || /[\r\n]/.test(repo)
    || repo === "." || repo === ".." || typeof branch !== "string" || branch.length === 0) throw new Error("invalid-review-identity")
  return `local__${repo}__${branch.replace(/[^A-Za-z0-9._-]/g, "-")}`
}

class PersistFailure extends Error {
  constructor(readonly result: PersistRejection) { super(result.reason) }
}
function fail(reason: PersistRejection["reason"]): never { throw new PersistFailure({ ok: false, reason }) }

/**
 * JSON data descriptors are the serialization oracle, read before any mutation.
 * All writers reject cycles, accessors and non-JSON values rather than invoking
 * toJSON or silently dropping evidence. No option bypasses this snapshot.
 */
function snapshot(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || ancestors.has(value)) fail("invalid-json")
  const array = Array.isArray(value)
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("invalid-json")
  if (Object.getOwnPropertySymbols(value).length) fail("invalid-json")
  const keys = Object.keys(value)
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) fail("invalid-json")
  ancestors.add(value)
  const entries = keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) fail("invalid-json")
    return [key, snapshot(descriptor.value, ancestors)] as const
  })
  ancestors.delete(value)
  return array ? entries.map(([, item]) => item) : Object.fromEntries(entries)
}

type DirectoryReason = "invalid-review-state-root" | "path-outside-root" | "path-resolution-error" | "not-found"
export class ReviewDirectoryError extends Error {
  constructor(readonly reason: DirectoryReason, readonly path: string, cause?: unknown) {
    super(reason, { cause })
  }
}
type DirectoryFs = Pick<ReviewPersistFs, "lstatSync" | "statSync" | "realpathSync" | "mkdirSync">

export const isReviewPath = (path: string): boolean =>
  /^(?:reviews|tasks\/[^/]+\/reviews)\/[^/]+(?:\/.*)?$/.test(path)
    && !path.split("/").some(part => part === ".." || part === ".")
export const isLegacyReviewPath = (path: string): boolean =>
  /(?:^|\/)reviews\/(?:local__[^/]+|[^/]+__[^/]+__pr[1-9][0-9]*)(?:\/|$)/.test(path)

/**
 * The host workspace and real directory chain are the containment oracle. Check
 * the requested namespace before mkdir, then check each ancestor before creating
 * its child and recheck before descent. Host-root components cannot redirect via
 * symlinks; namespace symlinks must stay inside that root. Persist writers and
 * lock.acquire create missing directories; reads/release never do. Invalid paths
 * fail closed for every consumer, with no bypass. Preflight cannot prevent a
 * concurrent directory replacement between checks and filesystem operations.
 * A .corvus host root admits only reviews/<namespace> or tasks/<task>/reviews/<namespace>;
 * this layout is checked before descent. Legacy namespaces are read-only, and
 * symlinked directories under the widened host root reject instead of admitting task files.
 */
export function resolveReviewDirectory(reviewRoot: string, reviewStateRoot: string, fs: DirectoryFs, create: boolean): { root: string; path: string } {
  const reject = (reason: DirectoryReason, path = reviewRoot): never => { throw new ReviewDirectoryError(reason, path) }
  if (typeof reviewStateRoot !== "string" || !isAbsolute(reviewStateRoot)
    || /[\u0000-\u001f\u007f]/.test(reviewStateRoot)) reject("invalid-review-state-root")
  if (!reviewRoot || /[\\\u0000-\u001f\u007f]/.test(reviewRoot) || reviewRoot.split("/").includes("..")) reject("path-outside-root")
  try {
    const configured = resolve(reviewStateRoot)
     const conventional = basename(configured) === "reviews" && basename(dirname(configured)) === ".corvus"
     const workspaceRoot = basename(configured) === ".corvus"
     const anchor = conventional ? dirname(dirname(configured)) : dirname(configured)
    const realAnchor = fs.realpathSync(anchor)
    if (!fs.statSync(realAnchor).isDirectory()) reject("path-resolution-error", anchor)
    const root = resolve(realAnchor, relative(anchor, configured))
     const absolute = resolve((conventional || workspaceRoot) && reviewRoot.startsWith(".corvus/") ? anchor : configured, reviewRoot)
     const base = inside(configured, absolute) ? configured : inside(root, absolute) ? root : undefined
     if (!base || absolute === base) return reject("path-outside-root")
     if (workspaceRoot && !isReviewPath(relative(base, absolute))) return reject("path-outside-root")
     if (create && (workspaceRoot || conventional) && isLegacyReviewPath(absolute)) return reject("path-outside-root")
    const descend = (parent: string, part: string, hostRoot: boolean): string => {
      const next = resolve(parent, part)
      try { fs.lstatSync(next) } catch (error) {
        if (!create || !missing(error)) throw error
        try { fs.mkdirSync(next) } catch (mkdirError) {
          if (!isRecord(mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError
        }
      }
      const real = fs.realpathSync(next)
       if (hostRoot ? real !== next : !inside(root, real)) reject("path-outside-root", next)
       if (workspaceRoot && real !== next) reject("path-outside-root", next)
      if (!fs.statSync(real).isDirectory()) reject("path-resolution-error", next)
      return real
    }
    let parent = realAnchor
    for (const part of relative(anchor, configured).split(sep).filter(Boolean)) parent = descend(parent, part, true)
    for (const part of relative(base, absolute).split(sep).filter(Boolean)) parent = descend(parent, part, false)
    return { root, path: parent }
  } catch (error) {
    if (error instanceof ReviewDirectoryError) throw error
    throw new ReviewDirectoryError(missing(error) ? "not-found" : "path-resolution-error", reviewRoot, error)
  }
}

/** The contained directory is checked before leaf I/O; symlink/non-file leaves fail closed without a bypass. */
function targetPath(reviewRoot: string, file: string, opts: PersistOptions, create: boolean): string {
  const fs = opts.fs ?? nodeFs
  try {
    const { path: parent } = resolveReviewDirectory(`${reviewRoot}/${dirname(file)}`, opts.reviewStateRoot, fs, create)
    const target = resolve(parent, basename(file))
    let metadata: ReturnType<ReviewPersistFs["lstatSync"]>
    try { metadata = fs.lstatSync(target) } catch (error) {
      if (create && missing(error)) return target
      throw error
    }
    if (metadata.isSymbolicLink()) fail("symlink-target")
    if (!fs.statSync(target).isFile()) fail("not-regular-file")
    return target
  } catch (error) {
    if (error instanceof PersistFailure) throw error
    fail(error instanceof ReviewDirectoryError ? error.reason : missing(error) ? "not-found" : "path-resolution-error")
  }
}

/**
 * Serialized bytes are the write oracle. An exclusive sibling temp is written
 * before rename; full final-file read-back must equal those bytes before success
 * or a digest is returned. Every writer rejects I/O, cleanup or equality failure,
 * with no body diagnostics and no bypass. Rename is atomic, not a durability or
 * rollback guarantee: a failure after rename may leave the new file installed.
 */
function persist(path: string, text: string, fs: ReviewPersistFs): WriteResult {
  const expected = Buffer.from(text, "utf8")
  const temp = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let temporary = false
  let result: WriteResult
  try {
    try {
      fs.writeFileSync(temp, Buffer.from(expected), { flag: "wx", mode: 0o600 })
      temporary = true
      fs.renameSync(temp, path)
      temporary = false
    } catch (error) {
      // A failed exclusive write can leave a partial file, but EEXIST is not ours.
      if (!isRecord(error) || error.code !== "EEXIST") temporary = true
      fail("write-error")
    }
    let actual: Buffer
    try { actual = fs.readFileSync(path) } catch { fail("read-error") }
    if (!actual.equals(expected)) {
      result = { ok: false, reason: "readback-mismatch", expectedBytes: expected.length, actualBytes: actual.length }
    } else {
      result = { ok: true, path, sha256: digest(actual), lines: lineCount(text), bytes: actual.length }
    }
  } catch (error) {
    result = error instanceof PersistFailure ? error.result : { ok: false, reason: "write-error" }
  }
  if (temporary) {
    try { fs.unlinkSync(temp) } catch (error) {
      if (!missing(error)) return { ok: false, reason: "cleanup-error" }
    }
  }
  return result
}

function boundary(text: string, limit: number): number {
  let end = 0
  for (let index = 0; index < Math.min(text.length, limit); index++) {
    if (text[index] === " " || text[index] === "\t" || text[index] === ",") end = index + 1
  }
  return end
}

function wrapProse(text: string): string {
  return text.split("\n").map(line => {
    if (line.length <= LINE_LIMIT) return line
    const indent = /^ */.exec(line)![0]
    let rest = line.slice(indent.length)
    const lines: string[] = []
    while (indent.length + rest.length > LINE_LIMIT) {
      const end = boundary(rest, LINE_LIMIT - indent.length)
      if (!end) fail("unbreakable-line")
      lines.push(indent + rest.slice(0, end))
      rest = rest.slice(end)
    }
    return [...lines, indent + rest].join("\n")
  }).join("\n")
}

function wrapQuotedYaml(line: string): string {
  if (line.length <= LINE_LIMIT) return line
  const token = [...line.matchAll(/"(?:\\.|[^"\\])*"/g)].at(-1)
  if (!token || token.index + token[0].length !== line.length) fail("unbreakable-line")
  let prefix = line.slice(0, token.index + 1)
  let rest = token[0].slice(1, -1)
  const indent = /^ */.exec(line)![0] + "  "
  const lines: string[] = []
  while (prefix.length + rest.length + 1 > LINE_LIMIT) {
    let end = 0
    const limit = LINE_LIMIT - prefix.length - 1
    for (let index = 0; index < rest.length && index < limit; index++) {
      if (rest[index] === "\\") { index++; continue }
      if (rest[index] === " " || rest[index] === ",") end = index + 1
    }
    if (!end) fail("unbreakable-line")
    lines.push(prefix + rest.slice(0, end) + "\\")
    rest = rest.slice(end)
    prefix = indent + (rest.startsWith(" ") ? "\\" : "")
  }
  return [...lines, prefix + rest + '"'].join("\n")
}

/**
 * Physical UTF-16 line lengths are the read-cap oracle before file mutation.
 * Prose gains only wrapping newlines/indentation. Overlong YAML is re-emitted
 * using block scalars, with quoted continuations as a fallback; decoded equality
 * is checked before acceptance. Writers reject unsplittable lines or changed YAML
 * values. Nothing disables the ceiling for documents/input; canonical candidate
 * strings are deliberately exempt, since payload measurement reads whole files.
 */
function formatYaml(text: string): string {
  if (!overlong(text)) return text
  for (const token of text.matchAll(/[^\s,]+/g)) {
    if (token[0].length > LINE_LIMIT) fail("unbreakable-line")
  }
  try {
    const value: unknown = yaml.load(text, { schema: yaml.JSON_SCHEMA })
    const options = { schema: yaml.JSON_SCHEMA, indent: 2, lineWidth: 1_800, noRefs: false }
    let emitted = yaml.dump(value, options)
    if (overlong(emitted)) {
      emitted = yaml.dump(value, { ...options, forceQuotes: true, quotingType: '"', lineWidth: -1 })
        .split("\n").map(wrapQuotedYaml).join("\n")
    }
    if (overlong(emitted)) fail("unbreakable-line")
    if (!isDeepStrictEqual(value, yaml.load(emitted, { schema: yaml.JSON_SCHEMA }))) fail("invalid-yaml")
    return text.endsWith("\n") ? emitted : emitted.replace(/\n$/, "")
  } catch (error) {
    if (error instanceof PersistFailure) throw error
    fail("invalid-yaml")
  }
}

type Fence = { marker: string; length: number; yaml: boolean }
function openingFence(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line)
  if (!match || (match[1][0] === "`" && match[2].includes("`"))) return undefined
  return { marker: match[1][0], length: match[1].length, yaml: /^(yaml|yml)$/i.test(match[2].trim()) }
}
function closingFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)
  return !!match && match[1][0] === fence.marker && match[1].length >= fence.length
}

function formatBody(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n")
  const output: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const fence = openingFence(lines[index])
    if (!fence) { output.push(wrapProse(lines[index])); continue }
    output.push(lines[index])
    const start = ++index
    while (index < lines.length && !closingFence(lines[index], fence)) index++
    if (index === lines.length) fail("invalid-document")
    const content = lines.slice(start, index).join("\n")
    if (index > start) output.push(fence.yaml ? formatYaml(content) : wrapProse(content))
    output.push(lines[index])
  }
  return output.join("\n")
}

function parseDocument(text: string): ParsedDocument {
  let frontmatterYaml: string | null = null
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 3)
    if (end < 0) fail("invalid-document")
    frontmatterYaml = text.slice(4, end)
    text = text.slice(end + 5)
    if (text.startsWith("\n")) text = text.slice(1)
  }
  const headings: Array<{ start: number; body: number; heading: string }> = []
  let fence: Fence | undefined
  let offset = 0
  for (const line of text.split("\n")) {
    if (fence) {
      if (closingFence(line, fence)) fence = undefined
    } else {
      fence = openingFence(line)
      if (!fence && line.startsWith("## ")) headings.push({ start: offset, body: offset + line.length + 1, heading: line.slice(3) })
    }
    offset += line.length + 1
  }
  if (fence) fail("invalid-document")
  if (!headings.length || headings[0].start > 0) headings.unshift({ start: 0, body: 0, heading: "" })
  const sections = headings.map((heading, index) => {
    let body = text.slice(heading.body, headings[index + 1]?.start ?? text.length)
    if (heading.heading && body.startsWith("\n")) body = body.slice(1)
    const framing = index + 1 < headings.length ? "\n\n" : "\n"
    if (body.endsWith(framing)) body = body.slice(0, -framing.length)
    return { heading: heading.heading, body }
  })
  return { sections, frontmatterYaml }
}

function assembleDocument(input: DocumentInput): string {
  if (!Array.isArray(input.sections) || !input.sections.length) fail("invalid-document")
  const sections = input.sections.map((section, index) => {
    if (!isRecord(section) || Object.keys(section).some(key => key !== "heading" && key !== "body")
      || typeof section.heading !== "string" || typeof section.body !== "string"
      || /[\r\n]/.test(section.heading) || section.heading.trim() !== section.heading
      || (!section.heading && index !== 0)) fail("invalid-document")
    return { heading: section.heading, body: formatBody(section.body) }
  })
  let frontmatterYaml: string | null = null
  if (input.frontmatterYaml !== undefined) {
    if (typeof input.frontmatterYaml !== "string") fail("invalid-document")
    frontmatterYaml = formatYaml(input.frontmatterYaml.replace(/\r\n/g, "\n"))
  }
  const text = (frontmatterYaml === null ? "" : `---\n${frontmatterYaml}\n---\n\n`)
    + sections.map(({ heading, body }) => (heading ? `## ${heading}\n\n` : "") + body).join("\n\n") + "\n"
  if (overlong(text)) fail("unbreakable-line")
  if (!isDeepStrictEqual(parseDocument(text), { sections, frontmatterYaml })) fail("ambiguous-document")
  return text
}

/**
 * Decoded string lengths and escaped JSON line lengths are checked before writes.
 * Chunks retain every delimiter: joining them recovers the original string.
 * Prefer newline boundaries, then word/comma boundaries, then a Unicode-safe cut
 * for a single oversized source line. R2 rejects key collisions or a serialized
 * line that still exceeds the ceiling; neither ceiling has a bypass.
 */
function chunks(text: string, depth: number, linesOnly = false): string[] {
  const budget = LINE_LIMIT - depth * 2 - 1
  if (budget < 2) fail("line-too-long")
  if (!text) return [""]
  const output: string[] = []
  let start = 0
  while (start < text.length) {
    let end = start
    let encodedLength = 2
    while (end < text.length) {
      const character = String.fromCodePoint(text.codePointAt(end)!)
      const cost = JSON.stringify(character).length - 2
      if (end + character.length - start > STRING_LIMIT || encodedLength + cost > budget) break
      encodedLength += cost
      end += character.length
    }
    if (end <= start) fail("unbreakable-line")
    const segment = text.slice(start, end)
    const newline = linesOnly ? segment.indexOf("\n") : segment.lastIndexOf("\n")
    if (newline >= 0 && (linesOnly || end < text.length)) end = start + newline + 1
    else if (end < text.length) end = start + (boundary(segment, segment.length) || segment.length)
    output.push(text.slice(start, end))
    start = end
  }
  return output
}

function chunkInput(value: JsonValue, depth = 0): JsonValue {
  if (Array.isArray(value)) return value.map(item => {
    if (typeof item === "string" && (item.length > STRING_LIMIT || depth * 2 + 3 + JSON.stringify(item).length > LINE_LIMIT)) {
      return chunks(item, depth + 2)
    }
    return chunkInput(item, depth + 1)
  })
  if (!isRecord(value)) return value
  const entries: Array<[string, JsonValue]> = []
  const used = new Set<string>()
  for (const [key, item] of Object.entries(value)) {
    let name = key
    let next: JsonValue
    const stringArray = Array.isArray(item) && item.every(part => typeof part === "string")
    const hunk = ["diff_hunks", "hunks", "hunk"].includes(key) && (typeof item === "string" || stringArray)
    if (hunk || ((key.endsWith("_chunks") || key === "hunk_lines") && stringArray)) {
      name = hunk ? "hunk_lines" : key
      const parts = typeof item === "string" ? [item] : item as string[]
      next = parts.flatMap(part => chunks(part, depth + 2, hunk || key === "hunk_lines"))
    } else if (typeof item === "string" && (item.length > STRING_LIMIT
      || (depth + 1) * 2 + JSON.stringify(key).length + 3 + JSON.stringify(item).length > LINE_LIMIT)) {
      name = `${key}_chunks`
      next = chunks(item, depth + 2)
    } else next = chunkInput(item as JsonValue, depth + 1)
    if (used.has(name) || (name !== key && Object.hasOwn(value, name))) fail("chunk-field-collision")
    used.add(name)
    entries.push([name, next])
  }
  return Object.fromEntries(entries)
}

function assembleInput(input: JsonValue): string {
  if (!isRecord(input)) fail("invalid-arguments")
  const text = JSON.stringify(chunkInput(input), null, 2) + "\n"
  if (overlong(text)) fail("line-too-long")
  return text
}

function readDocument(path: string, fs: ReviewPersistFs): ReadDocumentResult {
  let bytes: Buffer
  try { bytes = fs.readFileSync(path) } catch { fail("read-error") }
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes) || text.startsWith("\ufeff")) fail("encoding-error")
  return { ok: true, ...parseDocument(text.replace(/\r\n/g, "\n")), sha256: digest(bytes), lines: lineCount(text) }
}

/**
 * Closed operation keys, the fixed host root and snapshotted input are inspected
 * before serialization and filesystem mutations. Bad input fails for direct and
 * tool callers alike. Candidate schema rejection comes from measure's validator;
 * budget overflow is left for the caller's measure/freeze flow. Error results use
 * only fixed reason codes and byte counts, never exception messages or input keys.
 * write_meta checks the fixed record-name allowlist before path creation; unknown
 * names fail closed and omission selects meta.yaml. No name bypasses this check.
 * Only read_document/read_facts intentionally return content, for the orchestrator. Caller
 * permissions and document-before-meta ordering belong to registration/workflow;
 * no argument can override containment or dispatch an unlisted operation.
 */
function execute(op: Operation, input: unknown, opts: PersistOptions, metaNames: ReadonlySet<string> = META_NAMES): WriteResult | ReadDocumentResult | ReadFactsResult {
  try {
    if (!opts || typeof opts.reviewStateRoot !== "string" || !isAbsolute(opts.reviewStateRoot)) fail("invalid-review-state-root")
    const args = snapshot(input)
    if (!isRecord(args) || Object.keys(args).some(key => !KEYS[op].includes(key))
      || KEYS[op].some(key => !["frontmatterYaml", "name"].includes(key) && !Object.hasOwn(args, key))
      || typeof args.reviewRoot !== "string") fail("invalid-arguments")
    if (KEYS[op].includes("headSha") && (typeof args.headSha !== "string" || args.headSha.length !== 40
      || !/^[a-f0-9]{40}$/.test(args.headSha))) fail("invalid-head-sha")
    const fs = opts.fs ?? nodeFs
    let text: string
    let file: string
    switch (op) {
      case "read_document":
        return readDocument(targetPath(args.reviewRoot, `${args.headSha}/REVIEW_DOCUMENT.md`, opts, false), fs)
      case "read_facts": {
        const path = targetPath(args.reviewRoot, "verified_facts.yaml", opts, false)
        let bytes: Buffer
        try { bytes = fs.readFileSync(path) } catch { fail("read-error") }
        const text = bytes.toString("utf8")
        if (!Buffer.from(text, "utf8").equals(bytes) || text.startsWith("\ufeff")) fail("encoding-error")
        let facts: unknown
        try { facts = snapshot(yaml.load(text, { schema: yaml.JSON_SCHEMA })) } catch { fail("invalid-yaml") }
        if (!isRecord(facts)) fail("invalid-yaml")
        return { ok: true, facts, sha256: digest(bytes), lines: lineCount(text) }
      }
      case "write_document":
        text = assembleDocument(args as unknown as DocumentInput)
        file = `${args.headSha}/REVIEW_DOCUMENT.md`
        break
      case "write_input":
        text = assembleInput(args.input as JsonValue)
        file = "review-input.json"
        break
      case "write_meta":
        if (!isRecord(args.meta)) fail("invalid-arguments")
        if (Object.hasOwn(args, "name") && (typeof args.name !== "string" || !metaNames.has(args.name))) fail("unknown-record")
        text = formatYaml(yaml.dump(args.meta, { indent: 2, sortKeys: true, noRefs: true, lineWidth: 1_800 }))
        file = `${args.headSha}/${args.name ?? "meta.yaml"}`
        break
      case "write_facts":
        if (!isRecord(args.facts)) fail("invalid-arguments")
        text = formatYaml(yaml.dump(args.facts, { indent: 2, sortKeys: true, noRefs: true, lineWidth: 1_800 }))
        file = "verified_facts.yaml"
        break
      case "write_candidate": {
        text = assembleCandidate(args.candidate)
        file = "candidate.json"
        break
      }
    }
    if (Buffer.from(text, "utf8").toString("utf8") !== text) fail("encoding-error")
    return persist(targetPath(args.reviewRoot, file, opts, true), text, fs)
  } catch (error) {
    return error instanceof PersistFailure ? error.result : { ok: false, reason: "invalid-arguments" }
  }
}

/** An empty first heading represents the title/preamble; other headings are H2 labels. */
export function write_document(input: DocumentInput, opts: PersistOptions): WriteResult {
  return execute("write_document", input, opts) as WriteResult
}
export function write_input(input: InputInput, opts: PersistOptions): WriteResult {
  return execute("write_input", input, opts) as WriteResult
}
export function write_meta(input: MetaInput, opts: PersistOptions): WriteResult {
  return execute("write_meta", input, opts) as WriteResult
}
/**
 * The verdict module supplies computed data before serialization and mutation.
 * Only this internal entry point selects verdict.yaml; write_meta's tool allowlist
 * stays unchanged. Containment, serialization and byte-readback failures reject
 * through the shared writer, with no caller-controlled path or validation bypass.
 */
export function writeVerdictRecord(input: { reviewRoot: string; headSha: string; verdict: object }, opts: PersistOptions): WriteResult {
  return execute("write_meta", { reviewRoot: input.reviewRoot, headSha: input.headSha, meta: input.verdict, name: "verdict.yaml" },
    opts, new Set(["verdict.yaml"])) as WriteResult
}
export function write_facts(input: FactsInput, opts: PersistOptions): WriteResult {
  return execute("write_facts", input, opts) as WriteResult
}
export function read_facts(input: { reviewRoot: string }, opts: PersistOptions): ReadFactsResult {
  return execute("read_facts", input, opts) as ReadFactsResult
}
export function write_candidate(input: CandidateInput, opts: PersistOptions): WriteResult {
  return execute("write_candidate", input, opts) as WriteResult
}
export function read_document(input: ReadDocumentInput, opts: PersistOptions): ReadDocumentResult {
  return execute("read_document", input, opts) as ReadDocumentResult
}

export type StagingGap = { index?: number; key?: string; parts?: number[] }
type CandidateAnchor = Omit<CandidateRequest["comments"][number], "path" | "body">
type CandidatePart = { comment?: number; field: "path" | "body"; anchor?: CandidateAnchor }
type StagedPart = Partial<CandidatePart> & { index?: number; key?: string; path?: string[]; part: number; parts: number; heading?: string; file: string; bytes: number; sha256: string }
type StagingManifest = {
  staging_id: string; target: "document" | "input" | "candidate"; reviewRoot: string; headSha?: string
  commit_id?: string; event?: CandidateRequest["event"]
  expected_sections?: number; frontmatterYaml?: string; received: StagedPart[]
}
export type StagingResult = PersistRejection | {
  ok: true; staging_id: string; replaced_stale?: boolean; received?: StagedPart[]; missing?: StagingGap[]
} | (Extract<WriteResult, { ok: true }> & { sections?: number; keys?: string[]; parts?: number; staged_bytes?: number; cleanup_pending?: boolean })
const STAGING_ID = /^(?:document:([a-f0-9]{40})|input|candidate):([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const positive = (value: unknown): value is number => nonnegative(value) && value > 0
const candidateIdentity = (comment: number | undefined, field: "path" | "body"): string => comment === undefined ? field : `comments[${comment}].${field}`
const partIdentity = (part: StagedPart): number | string => part.field === undefined ? part.index ?? part.key! : candidateIdentity(part.comment, part.field)
const valueType = (value: JsonValue): string => Array.isArray(value) ? "array" : value === null ? "null" : typeof value

/**
 * The shared candidate schema is read before either writer mutates its final
 * target. Both paths use measure's canonical bytes and reject schema failures;
 * size violations deliberately remain input to freeze, not persistence failures.
 * No option disables schema validation or routes candidates through input formatting.
 */
function assembleCandidate(candidate: unknown): string {
  const measured = measure(candidate)
  if ("reason" in measured) fail(measured.reason)
  return measured.canonical
}

function candidateHeader(value: Record<string, unknown>): boolean {
  return !("reason" in measure({ commit_id: value.commit_id, event: value.event, body: "staged", comments: [] }))
}

/**
 * Snapshotted append fields (and manifest records on every later read) are the
 * protocol oracle before part writes or reassembly. Each comment's anchor occurs
 * exactly on path part 0; numeric comment indexes define final order, independent
 * of arrival order. Missing/misplaced anchors and non-scalar/unknown anchor fields
 * reject. Manifest part identities/counts are checked before append: duplicate
 * candidate parts or changed counts reject, with no bypass. The completed
 * path/body still undergo normal validation; document/input replacement is unchanged.
 */
function candidatePart(value: Record<string, unknown>): CandidatePart {
  if ((value.field !== "body" && value.field !== "path")
    || (Object.hasOwn(value, "comment") ? !nonnegative(value.comment) : value.field !== "body")) fail("invalid-arguments")
  const needsAnchor = value.comment !== undefined && value.field === "path" && value.part === 0
  if (needsAnchor && !Object.hasOwn(value, "anchor")) fail("incomplete-staging")
  if (needsAnchor) {
    if (!isRecord(value.anchor) || Object.keys(value.anchor).some(key => !["line", "side", "start_line", "start_side"].includes(key))
      || "reason" in measure({ commit_id: "0".repeat(40), event: "COMMENT", body: "staged", comments: [{ ...value.anchor, path: "staged", body: "staged" }] })) fail("invalid-arguments")
  } else if (Object.hasOwn(value, "anchor")) fail("invalid-arguments")
  return { field: value.field, ...(value.comment !== undefined ? { comment: value.comment as number } : {}),
    ...(needsAnchor ? { anchor: value.anchor as CandidateAnchor } : {}) }
}

/**
 * R17-1 pins append payloads to 6,000 UTF-16 code units, half R2's 12,000-character
 * dispatch cap; this is independent of host token budgets, not a token guarantee.
 * The oracle is body.length or JSON.stringify(value).length, read before any
 * append mutation. Candidate text uses JSON string encoding, preserving even split
 * surrogate pairs. All targets reject excess payloads with their observed length;
 * no option or output-budget setting disables this ceiling. Callers must also keep
 * the complete serialized arguments (envelope and escaping included) within 6,000.
 */
function boundedPart(value: JsonValue, document: boolean): string {
  const text = document ? value as string : JSON.stringify(value)
  if (text.length > 6_000) throw new PersistFailure({ ok: false, reason: "chunk-too-large", length: text.length })
  if (Buffer.from(text, "utf8").toString("utf8") !== text) fail("encoding-error")
  return text
}

/**
 * The shared containment resolver checks the namespace before staging I/O.
 * Staging descendants additionally reject all symlinks,
 * including aliases to other contained directories. The shared resolver's
 * concurrent-replacement caveat applies.
 */
function stagingDirectory(reviewRoot: string, file: string, opts: PersistOptions, create: boolean): string {
  const fs = opts.fs ?? nodeFs
  let parent = resolveReviewDirectory(reviewRoot, opts.reviewStateRoot, fs, create).path
  for (const component of file.split("/")) {
    const path = resolve(parent, component)
    try { fs.lstatSync(path) } catch (error) {
      if (!create || !missing(error)) throw error
      fs.mkdirSync(path)
    }
    if (fs.lstatSync(path).isSymbolicLink()) fail("path-outside-root")
    if (!fs.statSync(path).isDirectory()) fail("path-resolution-error")
    parent = path
  }
  return resolveReviewDirectory(`${reviewRoot}/${file}`, opts.reviewStateRoot, fs, create).path
}

function stagingLocation(reviewRoot: string, stagingId: unknown, opts: PersistOptions): { directory: string; file: string } {
  if (typeof stagingId !== "string") fail("unknown-staging")
  const match = STAGING_ID.exec(stagingId)
  if (!match || match[0] !== stagingId) fail("unknown-staging")
  const file = match[1] ? `${match[1]}/.staging/document` : `.staging/${stagingId.split(":")[0]}`
  const directory = stagingDirectory(reviewRoot, file, opts, false)
  return { directory, file }
}

/**
 * The shared writer verifies an exclusive candidate before installation. A hard
 * link preserves any previous inode before atomic replacement; final readback
 * failure restores it (or removes a newly created target). All consumers reject
 * I/O/equality failures, with no bypass. As with containment, concurrent external
 * mutation and a filesystem refusing rollback cannot be made transactional here.
 */
function installVerified(path: string, text: string, fs: StagingFs, workDirectory = dirname(path)): WriteResult {
  const candidate = resolve(workDirectory, `.${basename(path)}.${randomUUID()}.ready`)
  const backup = resolve(workDirectory, `.${basename(path)}.${randomUUID()}.previous`)
  let linked = false, installed = false, preserveBackup = false
  try {
    const result = persist(candidate, text, fs)
    if (!result.ok) return result
    try { fs.linkSync(path, backup); linked = true } catch (error) { if (!missing(error)) fail("write-error") }
    fs.renameSync(candidate, path)
    installed = true
    let actual: Buffer
    try { actual = fs.readFileSync(path) } catch { fail("read-error") }
    const expected = Buffer.from(text, "utf8")
    if (!actual.equals(expected)) throw new PersistFailure({ ok: false, reason: "readback-mismatch", expectedBytes: expected.length, actualBytes: actual.length })
    if (linked) { fs.unlinkSync(backup); linked = false }
    return { ...result, path, sha256: digest(actual) }
  } catch (error) {
    if (installed) {
      try {
        if (linked) { fs.renameSync(backup, path); linked = false }
        else fs.unlinkSync(path)
      } catch { preserveBackup = true; return { ok: false, reason: "cleanup-error" } }
    }
    return error instanceof PersistFailure ? error.result : { ok: false, reason: "write-error" }
  } finally {
    for (const temporary of [candidate, ...(linked && !preserveBackup ? [backup] : [])]) {
      try { fs.unlinkSync(temporary) } catch { /* A failed cleanup never removes the installed target. */ }
    }
  }
}

/** Host filesystem capabilities are checked before any staging mutation; incomplete injected adapters fail closed, with no fallback to real filesystem writes. */
function stagingFs(opts: PersistOptions): StagingFs {
  const fs = opts.fs ?? nodeFs
  if (typeof fs.rmSync !== "function" || typeof fs.linkSync !== "function") fail("write-error")
  return fs as StagingFs
}

function stageWrite(reviewRoot: string, file: string, text: string, opts: PersistOptions): void {
  stagingDirectory(reviewRoot, dirname(file), opts, true)
  const result = installVerified(targetPath(reviewRoot, file, opts, true), text, stagingFs(opts))
  if (!result.ok) throw new PersistFailure(result)
}

/** A strict self-locating ID and the manifest's canonical namespace/target are checked before consuming parts or mutating state. Missing or mismatched identities reject, without a bypass. */
function readManifest(reviewRoot: string, stagingId: unknown, opts: PersistOptions): { manifest: StagingManifest; directory: string; file: string } {
  const location = stagingLocation(reviewRoot, stagingId, opts)
  const fs = opts.fs ?? nodeFs
  const path = targetPath(reviewRoot, `${location.file}/manifest.json`, opts, false)
  let value: JsonValue
  try { value = snapshot(JSON.parse(fs.readFileSync(path).toString("utf8"))) } catch { fail("unknown-staging") }
  const root = resolveReviewDirectory(reviewRoot, opts.reviewStateRoot, fs, false).path
  if (!isRecord(value) || value.staging_id !== stagingId || value.reviewRoot !== root
    || (value.target !== "document" && value.target !== "input" && value.target !== "candidate") || !Array.isArray(value.received)
    || (value.target === "document" ? !(stagingId as string).startsWith("document:") || value.headSha !== (stagingId as string).split(":")[1]
      : !(stagingId as string).startsWith(`${value.target}:`) || value.headSha !== undefined)
    || (value.target === "candidate" ? !candidateHeader(value) || value.expected_sections !== undefined || value.frontmatterYaml !== undefined
      : value.commit_id !== undefined || value.event !== undefined)
    || (value.expected_sections !== undefined && !positive(value.expected_sections))
    || (value.frontmatterYaml !== undefined && typeof value.frontmatterYaml !== "string")) fail("unknown-staging")
  const seen = new Set<string>()
  for (const item of value.received) {
    if (!isRecord(item) || !nonnegative(item.part) || !positive(item.parts) || item.part >= item.parts
      || !nonnegative(item.bytes) || typeof item.sha256 !== "string" || item.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(item.sha256)
      || typeof item.file !== "string" || item.file.length !== 41 || !/^[a-f0-9-]{36}\.part$/.test(item.file)
       || (item.path !== undefined && (!Array.isArray(item.path) || !item.path.every(segment => typeof segment === "string")))
        || (value.target === "candidate" ? ["index", "key", "path", "heading"].some(key => Object.hasOwn(item, key))
          : ["comment", "field", "anchor"].some(key => Object.hasOwn(item, key))
            || (value.target === "document" ? !nonnegative(item.index) || item.key !== undefined || item.path !== undefined
              || (item.heading !== undefined && typeof item.heading !== "string") : typeof item.key !== "string" || item.index !== undefined))) fail("unknown-staging")
    if (value.target === "candidate") candidatePart(item)
    const identity = JSON.stringify([partIdentity(item as StagedPart), item.part])
    if (seen.has(identity)) fail("unknown-staging")
    seen.add(identity)
  }
  return { ...location, manifest: value as unknown as StagingManifest }
}

/** Part bytes and sidecars are read before merging or final-file mutation; any missing or corrupt part rejects without an integrity bypass. */
function readPart(reviewRoot: string, file: string, part: StagedPart, document: boolean, opts: PersistOptions): JsonValue {
  const fs = opts.fs ?? nodeFs
  const bytes = fs.readFileSync(targetPath(reviewRoot, `${file}/${part.file}`, opts, false))
  const meta = JSON.parse(fs.readFileSync(targetPath(reviewRoot, `${file}/${part.file}.meta.json`, opts, false)).toString("utf8")) as unknown
  if (!isRecord(meta) || meta.bytes !== part.bytes || meta.sha256 !== part.sha256
    || bytes.length !== part.bytes || digest(bytes) !== part.sha256) fail("readback-mismatch")
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("encoding-error")
  return document ? text : snapshot(JSON.parse(text))
}

function mergeParts(values: JsonValue[], complete: boolean): JsonValue {
  const first = values[0]
  if (values.some(value => valueType(value) !== valueType(first))) fail("part-type-conflict")
  if (typeof first === "string") return (values as string[]).join("")
  if (Array.isArray(first)) return (values as JsonValue[][]).flat()
  if (isRecord(first)) {
    const entries = new Map<string, JsonValue>()
    for (const value of values) for (const [key, item] of Object.entries(value as Record<string, JsonValue>)) {
      if (!entries.has(key)) entries.set(key, item)
      else {
        const previous = entries.get(key)!
        if (valueType(previous) !== valueType(item)) fail("merge-conflict")
        if (typeof item !== "string" && !Array.isArray(item) && !isRecord(item)) {
          if (!isDeepStrictEqual(previous, item)) fail("merge-conflict")
        } else entries.set(key, mergeParts([previous, item], true))
      }
    }
    return Object.fromEntries(entries)
  }
  if (!complete || values.length !== 1) fail("part-type-conflict")
  return first
}

/**
 * Verified part values and literal JSON-pointer segments under each key are read
 * in part order before final-file mutation. Nested chunks concatenate at their
 * path before merging with ordinary values; arrays concatenate and objects merge
 * recursively. Conflicting scalars or invalid array indexes reject with
 * merge-conflict for append/finalize alike. No option disables these checks.
 */
function mergeInputParts(items: StagedPart[], values: JsonValue[], complete: boolean): JsonValue {
  const ordinary = values.filter((_, index) => items[index].path === undefined)
  let result = ordinary.length ? mergeParts(ordinary, complete) : undefined
  const paths = new Map<string, { path: string[]; chunks: string[] }>()
  items.forEach((item, index) => {
    if (item.path === undefined) return
    if (typeof values[index] !== "string") fail("merge-conflict")
    const identity = JSON.stringify(item.path)
    const group = paths.get(identity) ?? { path: item.path, chunks: [] }
    group.chunks.push(values[index] as string)
    paths.set(identity, group)
  })
  const insert = (value: JsonValue | undefined, path: string[], chunk: string): JsonValue => {
    if (!path.length) {
      if (value === undefined) return chunk
      if (typeof value !== "string") fail("merge-conflict")
      return value + chunk
    }
    const [key, ...rest] = path
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) fail("merge-conflict")
      return value.map((item, index) => index === Number(key) ? insert(item, rest, chunk) : item)
    }
    if (value !== undefined && !isRecord(value)) fail("merge-conflict")
    const object = (value ?? {}) as Record<string, JsonValue>
    return Object.fromEntries([...Object.entries(object).filter(([name]) => name !== key),
      [key, insert(Object.hasOwn(object, key) ? object[key] : undefined, rest, chunk)]])
  }
  for (const { path, chunks } of paths.values()) result = insert(result, path, chunks.join(""))
  return result!
}

function stagingGaps(manifest: StagingManifest, expected: Array<number | string>, available = manifest.received): { missing: StagingGap[]; unexpected: Array<number | string> } {
  const missing: StagingGap[] = []
  for (const identity of expected) {
    const declared = manifest.received.filter(item => partIdentity(item) === identity)
    const received = available.filter(item => partIdentity(item) === identity)
    const label = typeof identity === "number" ? { index: identity } : { key: identity }
    if (!declared.length) { missing.push(label); continue }
    const parts = Array.from({ length: declared[0].parts }, (_, part) => part).filter(part => !received.some(item => item.part === part))
    if (parts.length) missing.push({ ...label, parts })
  }
  return { missing, unexpected: [...new Set(manifest.received.map(partIdentity).filter(identity => !expected.includes(identity)))] }
}

function executeStaging(op: StagingOperation, input: unknown, opts: PersistOptions): StagingResult {
  try {
    if (!opts || typeof opts.reviewStateRoot !== "string" || !isAbsolute(opts.reviewStateRoot)) fail("invalid-review-state-root")
    const args = snapshot(input)
    if (!isRecord(args) || typeof args.reviewRoot !== "string" || Object.keys(args).some(key => !STAGING_KEYS[op].includes(key))) fail("invalid-arguments")
    const fs = stagingFs(opts)
    if (op === "begin") {
      if (args.target !== "document" && args.target !== "input" && args.target !== "candidate") fail("invalid-arguments")
      if (args.target === "document" && (typeof args.headSha !== "string" || args.headSha.length !== 40 || !/^[a-f0-9]{40}$/.test(args.headSha))) fail("invalid-head-sha")
      if (args.target !== "document" && (Object.hasOwn(args, "headSha") || Object.hasOwn(args, "expected_sections") || Object.hasOwn(args, "frontmatterYaml"))) fail("invalid-arguments")
      if (args.target === "candidate" ? !candidateHeader(args) : Object.hasOwn(args, "commit_id") || Object.hasOwn(args, "event")) fail("invalid-arguments")
      if (args.expected_sections !== undefined && !positive(args.expected_sections)) fail("invalid-arguments")
      if (args.frontmatterYaml !== undefined && typeof args.frontmatterYaml !== "string") fail("invalid-arguments")
      const root = resolveReviewDirectory(args.reviewRoot, opts.reviewStateRoot, fs, true).path
      const file = args.target === "document" ? `${args.headSha}/.staging/document` : `.staging/${args.target}`
      let replaced_stale = false
      try {
        const prior = stagingDirectory(args.reviewRoot, file, opts, false)
        fs.rmSync(prior, { recursive: true, force: true }); replaced_stale = true
      } catch (error) { if (!missing(error) && !(error instanceof ReviewDirectoryError && error.reason === "not-found")) throw error }
      const staging_id = `${args.target === "document" ? `document:${args.headSha}` : args.target}:${randomUUID()}`
      const manifest: StagingManifest = { staging_id, target: args.target, reviewRoot: root, received: [],
        ...(args.target === "candidate" ? { commit_id: args.commit_id as string, event: args.event as CandidateRequest["event"] } : {}),
        ...(args.target === "document" ? { headSha: args.headSha as string, expected_sections: args.expected_sections as number | undefined, frontmatterYaml: args.frontmatterYaml as string | undefined } : {}) }
      stageWrite(args.reviewRoot, `${file}/manifest.json`, JSON.stringify(manifest), opts)
      return { ok: true, staging_id, replaced_stale }
    }
    let loaded: ReturnType<typeof readManifest>
    try { loaded = readManifest(args.reviewRoot, args.staging_id, opts) } catch (error) {
      if (missing(error)) fail("unknown-staging")
      throw error
    }
    const { manifest, directory, file } = loaded
    const document = manifest.target === "document"
    const candidate = manifest.target === "candidate"
    if (op === "abort") { fs.rmSync(directory, { recursive: true, force: true }); return { ok: true, staging_id: manifest.staging_id } }
    if (op === "append") {
      const part = args.part ?? 0, parts = args.parts ?? 1
      if (!nonnegative(part) || !positive(parts) || part >= parts) fail("invalid-arguments")
      let candidateFields: CandidatePart | undefined
      if (candidate) {
        if (!nonnegative(args.part) || !positive(args.parts) || typeof args.text !== "string"
          || ["index", "heading", "body", "key", "value", "chunk", "path"].some(key => Object.hasOwn(args, key))) fail("invalid-arguments")
        candidateFields = candidatePart(args)
      } else if (["comment", "field", "text", "anchor"].some(key => Object.hasOwn(args, key))) fail("invalid-arguments")
      if (args.path !== undefined && (!Array.isArray(args.path) || !args.path.every(segment => typeof segment === "string") || typeof args.chunk !== "string" || Object.hasOwn(args, "value"))) fail("invalid-arguments")
      if (!candidate && (document ? !nonnegative(args.index) || typeof args.body !== "string" || ["key", "value", "chunk", "path"].some(key => Object.hasOwn(args, key))
        || (args.heading !== undefined && typeof args.heading !== "string")
        : typeof args.key !== "string" || ["index", "body", "heading"].some(key => Object.hasOwn(args, key))
        || Object.hasOwn(args, "value") === Object.hasOwn(args, "chunk"))) fail("invalid-arguments")
      const value = (candidate ? args.text : document ? args.body : Object.hasOwn(args, "value") ? args.value : args.chunk) as JsonValue
      const text = boundedPart(value, document)
      const identity = candidateFields ? candidateIdentity(candidateFields.comment, candidateFields.field) : (document ? args.index : args.key) as number | string
      const siblings = manifest.received.filter(item => partIdentity(item) === identity)
      if (siblings.some(item => item.parts !== parts)) fail("part-count-conflict")
      // Candidate parts are immutable: duplicate indexes reject before any write.
      if (candidate && siblings.some(item => item.part === part)) fail("incomplete-staging")
      const others = siblings.filter(item => item.part !== part)
      const heading = args.heading as string | undefined ?? (part === 0 ? "" : undefined)
      if (document && heading !== undefined && others.some(item => item.heading !== undefined && item.heading !== heading)) fail("heading-conflict")
      const record: StagedPart = { ...(candidateFields ?? (document ? { index: args.index as number, ...(heading !== undefined ? { heading } : {}) } : { key: args.key as string })),
        ...(args.path !== undefined ? { path: args.path as string[] } : {}),
        part, parts, file: `${randomUUID()}.part`, bytes: Buffer.byteLength(text, "utf8"), sha256: digest(Buffer.from(text, "utf8")) }
      if (!document && !candidate) {
        const items = [...others, record].sort((a, b) => a.part - b.part)
        const merged = mergeInputParts(items, items.map(item => item === record ? value : readPart(args.reviewRoot as string, file, item, false, opts)), parts === 1)
        const entries: Array<[string, JsonValue]> = [[args.key as string, merged]]
        for (const key of new Set(manifest.received.filter(item => item.key !== args.key).map(item => item.key!))) {
          const items = manifest.received.filter(item => item.key === key).sort((a, b) => a.part - b.part)
          entries.push([key, mergeInputParts(items, items.map(item => readPart(args.reviewRoot as string, file, item, false, opts)), items[0].parts === 1)])
        }
        chunkInput(Object.fromEntries(entries))
      }
      try {
        stageWrite(args.reviewRoot, `${file}/${record.file}`, text, opts)
        stageWrite(args.reviewRoot, `${file}/${record.file}.meta.json`, JSON.stringify({ bytes: record.bytes, sha256: record.sha256 }), opts)
        const received = manifest.received.filter(item => partIdentity(item) !== identity || item.part !== part).concat(record)
        stageWrite(args.reviewRoot, `${file}/manifest.json`, JSON.stringify({ ...manifest, received }), opts)
      } catch (error) {
        for (const name of [record.file, `${record.file}.meta.json`]) {
          try { fs.unlinkSync(targetPath(args.reviewRoot, `${file}/${name}`, opts, false)) } catch { /* Unpublished parts are not consumed. */ }
        }
        throw error
      }
      return { ok: true, staging_id: manifest.staging_id, received: [record] }
    }
    let expected: Array<number | string>
    if (!candidate && Object.hasOwn(args, "expected_comments")) fail("invalid-arguments")
    if (candidate) {
      if (Object.hasOwn(args, "expected_sections") || Object.hasOwn(args, "expected_keys")
        || (op === "finalize" && !nonnegative(args.expected_comments))) fail("invalid-arguments")
      const count = op === "finalize" ? args.expected_comments as number
        : manifest.received.reduce((total, item) => Math.max(total, (item.comment ?? -1) + 1), 0)
      expected = ["body", ...Array.from({ length: count }, (_, comment) => [candidateIdentity(comment, "path"), candidateIdentity(comment, "body")]).flat()]
    } else if (document) {
      if (Object.hasOwn(args, "expected_keys")) fail("invalid-arguments")
      const count = args.expected_sections ?? manifest.expected_sections
      if (op === "finalize" && !positive(count)) fail("invalid-arguments")
      if (count !== undefined && !positive(count)) fail("invalid-arguments")
      const length = (count as number | undefined) ?? (manifest.received.length ? Math.max(...manifest.received.map(item => item.index!)) + 1 : 0)
      expected = Array.from({ length }, (_, index) => index)
    } else {
      if (Object.hasOwn(args, "expected_sections")) fail("invalid-arguments")
      if (op === "finalize" && (!Array.isArray(args.expected_keys) || !args.expected_keys.every(key => typeof key === "string") || new Set(args.expected_keys).size !== args.expected_keys.length)) fail("invalid-arguments")
      expected = op === "status" ? [...new Set(manifest.received.map(item => item.key!))] : args.expected_keys as string[]
    }
    const available = manifest.received.filter(item => {
      try {
        targetPath(args.reviewRoot as string, `${file}/${item.file}`, opts, false)
        targetPath(args.reviewRoot as string, `${file}/${item.file}.meta.json`, opts, false)
        return true
      } catch (error) {
        if (error instanceof PersistFailure && error.result.reason === "not-found") return false
        throw error
      }
    })
    const gaps = stagingGaps(manifest, expected, available)
    if (op === "status") return { ok: true, staging_id: manifest.staging_id, received: available, missing: gaps.missing }
    if (gaps.missing.length || gaps.unexpected.length) return { ok: false, reason: "incomplete-staging", ...gaps }
    const assembled = expected.map(identity => {
      const items = manifest.received.filter(item => partIdentity(item) === identity).sort((a, b) => a.part - b.part)
      if (items.some(item => item.parts !== items[0].parts)) fail("part-count-conflict")
      if (document && items.some(item => item.heading !== undefined && item.heading !== items[0].heading)) fail("heading-conflict")
      const values = items.map(item => readPart(args.reviewRoot as string, file, item, document, opts))
      if (candidate) {
        if (!values.every(value => typeof value === "string")) fail("part-type-conflict")
        return (values as string[]).join("")
      }
      return document ? { heading: items[0].heading!, body: (values as string[]).join("") } : mergeInputParts(items, values, items[0].parts === 1)
    })
    const text = candidate ? assembleCandidate({ commit_id: manifest.commit_id, event: manifest.event, body: assembled[0],
      comments: Array.from({ length: args.expected_comments as number }, (_, comment) => ({
        ...manifest.received.find(item => item.comment === comment && item.field === "path" && item.part === 0)!.anchor,
        path: assembled[1 + comment * 2], body: assembled[2 + comment * 2],
      })) }) : document ? assembleDocument({ reviewRoot: args.reviewRoot, headSha: manifest.headSha!, sections: assembled as DocumentSection[],
      ...(manifest.frontmatterYaml !== undefined ? { frontmatterYaml: manifest.frontmatterYaml } : {}) })
      : assembleInput(Object.fromEntries(expected.map((key, index) => [key, assembled[index]])) as JsonValue)
    if (Buffer.from(text, "utf8").toString("utf8") !== text) fail("encoding-error")
    const path = targetPath(args.reviewRoot, candidate ? "candidate.json" : document ? `${manifest.headSha}/REVIEW_DOCUMENT.md` : "review-input.json", opts, true)
    const completed = resolve(dirname(directory), `.completed-${randomUUID()}`)
    fs.renameSync(directory, completed)
    const result = installVerified(path, text, fs, completed)
    if (!result.ok) {
      try { fs.renameSync(completed, directory) } catch { fail("cleanup-error") }
      return result
    }
    let cleanup_pending = false
    try { fs.rmSync(completed, { recursive: true, force: true }) } catch { cleanup_pending = true }
    if (candidate) return { ...result, ...(cleanup_pending ? { cleanup_pending } : {}) }
    return { ...result, ...(document ? { sections: expected.length } : { keys: expected as string[] }), parts: manifest.received.length,
      staged_bytes: manifest.received.reduce((total, item) => total + item.bytes, 0), ...(cleanup_pending ? { cleanup_pending } : {}) }
  } catch (error) {
    if (error instanceof PersistFailure) return error.result.reason === "not-found" ? { ok: false, reason: "unknown-staging" } : error.result
    if (error instanceof ReviewDirectoryError) return { ok: false, reason: error.reason === "not-found" ? "unknown-staging" : error.reason }
    return { ok: false, reason: missing(error) ? "incomplete-staging" : "write-error" }
  }
}

export const begin = (input: unknown, opts: PersistOptions): StagingResult => executeStaging("begin", input, opts)
export const append = (input: unknown, opts: PersistOptions): StagingResult => executeStaging("append", input, opts)
export const finalize = (input: unknown, opts: PersistOptions): StagingResult => executeStaging("finalize", input, opts)
export const abort = (input: unknown, opts: PersistOptions): StagingResult => executeStaging("abort", input, opts)
export const status = (input: unknown, opts: PersistOptions): StagingResult => executeStaging("status", input, opts)

/** Host-only options permit filesystem injection; tool arguments cannot supply them. */
export function createPersistExecutor(
  reviewStateRoot: string,
  options: Omit<PersistOptions, "reviewStateRoot"> = {},
): (input: unknown) => string {
  const opts: PersistOptions = { fs: options.fs, reviewStateRoot }
  return input => {
    try {
      const value = snapshot(input)
      if (!isRecord(value)) fail("invalid-arguments")
      const { op, ...args } = value
      if (typeof op === "string" && Object.hasOwn(STAGING_KEYS, op)) return JSON.stringify(executeStaging(op as StagingOperation, args, opts))
      if (typeof op !== "string" || !Object.hasOwn(KEYS, op)) fail("invalid-op")
      return JSON.stringify(execute(op as Operation, args, opts))
    } catch (error) {
      return JSON.stringify(error instanceof PersistFailure ? error.result : { ok: false, reason: "invalid-arguments" })
    }
  }
}

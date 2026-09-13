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
  expectedBytes?: number
  actualBytes?: number
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
        if (!isRecord(args.input)) fail("invalid-arguments")
        text = JSON.stringify(chunkInput(args.input as JsonValue), null, 2) + "\n"
        if (overlong(text)) fail("line-too-long")
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
        const measured = measure(args.candidate)
        if ("reason" in measured) return { ok: false, reason: measured.reason }
        text = measured.canonical
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
      if (typeof op !== "string" || !Object.hasOwn(KEYS, op)) fail("invalid-op")
      return JSON.stringify(execute(op as Operation, args, opts))
    } catch (error) {
      return JSON.stringify(error instanceof PersistFailure ? error.result : { ok: false, reason: "invalid-arguments" })
    }
  }
}

import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import * as nodeFs from "node:fs"
import { basename, dirname, resolve } from "node:path"
import yaml from "js-yaml"
import type { ReviewPayloadFs } from "./review-payload"
import { isLegacyReviewPath, resolveReviewDirectory, ReviewDirectoryError } from "./review-persist"

export type ReviewLockFs = Omit<ReviewPayloadFs, "writeFileSync"> & {
  writeFileSync(path: string, data: Uint8Array, options: { flag: "wx"; mode: number }): void
  mkdirSync(path: string): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
}
export type LockOptions = { reviewStateRoot: string; fs?: ReviewLockFs; now?: () => Date }
export type AcquireInput = { reviewRoot: string; runId: string; force?: boolean }
export type ReleaseInput = { reviewRoot: string; runId: string; mode: "delete" | "complete" }
export type StatusInput = { reviewRoot: string }
export type LockHolder = { path: string; run_id: string; started_at: string; age_s: number }
export type LockRejection = {
  ok: false
  reason: "invalid-arguments" | "invalid-op" | "invalid-review-state-root" | "invalid-clock"
    | "path-outside-root" | "path-resolution-error" | "unreadable-lock" | "write-error"
    | "cleanup-error" | "readback-mismatch" | "not-owner"
  path?: string
  code?: string
  message?: string
  cleanup?: LockRejection
}
export type HeldResult = { ok: false; state: "held"; holder: LockHolder; cleanup?: LockRejection }
export type AcquireResult = LockRejection | HeldResult | { ok: true; state: "acquired"; path: string; started_at: string }
export type ReleaseResult = LockRejection | { ok: true; state: "absent" }
  | { ok: true; state: "released" | "completed"; path: string }
export type StatusResult = LockRejection | { held: boolean; holders: LockHolder[]; legacy_present: boolean }

type ActiveLock = { schema_version: 1; status: "active"; started_at: string; run_id: string }
type CompletedLock = { status: "completed"; run_id: string; completed_at: string }
type Lock = ActiveLock | CompletedLock
type Snapshot = { path: string; bytes: Buffer; lock: Lock }
type Paths = { current: string; legacy: string }
type Failure = LockRejection | HeldResult
type Operation = "acquire" | "release" | "status"
const FRESH_SECONDS = 2 * 60 * 60
const KEYS: Record<Operation, readonly string[]> = {
  acquire: ["reviewRoot", "runId", "force"],
  release: ["reviewRoot", "runId", "mode"],
  status: ["reviewRoot"],
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const missing = (error: unknown): boolean => isRecord(error) && error.code === "ENOENT"

class LockFailure extends Error {
  constructor(readonly result: Failure, readonly installed = false) { super("Review lock operation failed") }
}
function rejection(reason: LockRejection["reason"], path?: string, error?: unknown): LockRejection {
  return {
    ok: false, reason, ...(path ? { path } : {}),
    ...(isRecord(error) && typeof error.code === "string" ? { code: error.code } : {}),
    ...(error instanceof Error ? { message: error.message } : {}),
  }
}
function fail(reason: LockRejection["reason"], path?: string, error?: unknown): never {
  throw new LockFailure(rejection(reason, path, error))
}

function utcMillis(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const utc = value.endsWith("+00:00") ? value.slice(0, -6) + "Z" : value
  if (!utc.endsWith("Z") || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(utc)) return undefined
  const ms = Date.parse(utc)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== utc.slice(0, 19)) return undefined
  return ms
}
function clock(opts: LockOptions): { ms: number; iso: string } {
  try {
    const date = (opts.now ?? (() => new Date()))()
    const iso = date.toISOString()
    const ms = utcMillis(iso)
    if (ms === undefined) fail("invalid-clock")
    return { ms, iso }
  } catch { fail("invalid-clock") }
}

/**
 * The fixed host root and real directory chain are the containment oracle, read
 * before lock I/O. All operations reject traversal and escaped ancestors; only
 * acquire creates missing directories. Lock leaves are checked separately. Relative paths use the host
 * root, with conventional .corvus/reviews paths resolved from its workspace.
 * No option disables containment. Preflight cannot prevent concurrent directory
 * replacement, just as in the payload facade.
 */
function lockPaths(reviewRoot: string, opts: LockOptions, fs: ReviewLockFs, create: boolean): Paths {
  try {
    const { root, path: parent } = resolveReviewDirectory(reviewRoot, opts.reviewStateRoot, fs, create)
    if (parent === root) fail("path-outside-root", reviewRoot)
    return { current: resolve(parent, "lock.yaml"), legacy: resolve(parent, ".lock") }
  } catch (error) {
    if (error instanceof LockFailure) throw error
    if (error instanceof ReviewDirectoryError) fail(error.reason === "not-found" ? "path-resolution-error" : error.reason, error.path, error.cause)
    fail("path-resolution-error", reviewRoot, error)
  }
}

/**
 * Regular-file bytes and the active/completed schema are the read oracle. Before
 * any freshness or ownership decision, reject symlink leaves, invalid UTF-8/YAML,
 * invalid dates and malformed mappings. Only lstat ENOENT means absent; a later
 * read failure is unreadable. Every operation fails closed, even with force.
 * Completed markers may omit schema_version and started_at, as release does.
 */
function readLock(path: string, fs: ReviewLockFs): Snapshot | null {
  let metadata: ReturnType<ReviewLockFs["lstatSync"]>
  try { metadata = fs.lstatSync(path) } catch (error) {
    if (missing(error)) return null
    fail("unreadable-lock", path, error)
  }
  let bytes: Buffer
  try {
    if (metadata.isSymbolicLink() || !fs.statSync(path).isFile()) fail("unreadable-lock", path)
    bytes = fs.readFileSync(path)
  } catch (error) {
    if (error instanceof LockFailure) throw error
    fail("unreadable-lock", path, error)
  }
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) fail("unreadable-lock", path)
  let value: unknown
  try { value = yaml.load(text, { schema: yaml.JSON_SCHEMA }) } catch { fail("unreadable-lock", path) }
  if (!isRecord(value) || Object.keys(value).some(key =>
    !["schema_version", "status", "started_at", "run_id", "completed_at"].includes(key))
    || !nonempty(value.run_id)
    || (Object.hasOwn(value, "schema_version") && value.schema_version !== 1)
    || (Object.hasOwn(value, "started_at") && utcMillis(value.started_at) === undefined)
    || (Object.hasOwn(value, "completed_at") && utcMillis(value.completed_at) === undefined)) fail("unreadable-lock", path)
  let lock: Lock
  if (value.status === "active" && value.schema_version === 1 && utcMillis(value.started_at) !== undefined) {
    lock = { schema_version: 1, status: "active", started_at: value.started_at as string, run_id: value.run_id }
  } else if (value.status === "completed" && utcMillis(value.completed_at) !== undefined) {
    lock = { status: "completed", run_id: value.run_id, completed_at: value.completed_at as string }
  } else fail("unreadable-lock", path)
  return { path, bytes, lock }
}
function readBoth(paths: Paths, fs: ReviewLockFs): [Snapshot | null, Snapshot | null] {
  return [readLock(paths.current, fs), readLock(paths.legacy, fs)]
}
function holder(snapshot: Snapshot | null, now: number): LockHolder | undefined {
  if (!snapshot || snapshot.lock.status !== "active") return undefined
  const age_s = (now - utcMillis(snapshot.lock.started_at)!) / 1000
  return age_s < FRESH_SECONDS
    ? { path: snapshot.path, run_id: snapshot.lock.run_id, started_at: snapshot.lock.started_at, age_s } : undefined
}

/**
 * Both validated mappings and one clock snapshot are the admission oracle before
 * acquisition writes. An active age below 7200 seconds blocks, including future
 * timestamps (negative ages); status exposes the same holders. Only caller-approved
 * interactive force bypasses freshness, never unreadable state or containment.
 * Interactive authorization belongs to the caller, not to lock-file data.
 */
function available(snapshots: Array<Snapshot | null>, now: number, force: boolean): void {
  for (const snapshot of snapshots) {
    const held = holder(snapshot, now)
    if (held && !force) throw new LockFailure({ ok: false, state: "held", holder: held })
  }
}

/**
 * Serialized YAML bytes are the write oracle. Write an exclusive sibling temp,
 * recheck admission/ownership before atomic rename, then require equal read-back
 * bytes. Every caller rejects write, read-back or temp-cleanup failures; no bypass
 * exists. Atomic replacement is not compare-and-swap, a cross-process mutex or a
 * durability guarantee: another writer can replace a lock between these checks.
 */
function writeAtomic(path: string, lock: Lock, fs: ReviewLockFs, beforeRename: () => void): void {
  const expected = Buffer.from(yaml.dump(lock, { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: -1 }), "utf8")
  const temp = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let temporary = false
  let installed = false
  let failure: Failure | undefined
  try {
    try {
      fs.writeFileSync(temp, Buffer.from(expected), { flag: "wx", mode: 0o600 })
      temporary = true
    } catch (error) {
      temporary = !isRecord(error) || error.code !== "EEXIST"
      fail("write-error", temp, error)
    }
    beforeRename()
    try { fs.renameSync(temp, path) } catch (error) { fail("write-error", path, error) }
    temporary = false
    installed = true
    const actual = readLock(path, fs)
    if (!actual || !actual.bytes.equals(expected)) fail("readback-mismatch", path)
  } catch (error) {
    failure = error instanceof LockFailure ? error.result : rejection("write-error", path, error)
  }
  if (temporary) {
    try { fs.unlinkSync(temp) } catch (error) {
      if (!missing(error)) {
        const cleanup = rejection("cleanup-error", temp, error)
        failure = failure ? { ...failure, cleanup } : cleanup
      }
    }
  }
  if (failure) throw new LockFailure(failure, installed)
}

function remove(path: string, fs: ReviewLockFs): void {
  try { fs.unlinkSync(path) } catch (error) {
    if (!missing(error)) fail("cleanup-error", path, error)
  }
}
function requireOwner(path: string, runId: string, fs: ReviewLockFs): Snapshot | null {
  const current = readLock(path, fs)
  if (current && current.lock.run_id !== runId) fail("not-owner", path)
  return current
}

/**
 * Initial legacy bytes and a fresh reread are the cleanup oracle after acquisition.
 * Delete only an unchanged active legacy lock whose age is at least 7200 seconds
 * at the operation's clock snapshot. Preserve absent, completed, fresh or changed
 * mappings; unreadable/failed cleanup rejects acquisition. Force does not relax
 * cleanup. Byte equality is a preflight check, not an atomic conditional unlink.
 */
function cleanLegacy(initial: Snapshot | null, now: number, fs: ReviewLockFs): void {
  if (!initial || initial.lock.status !== "active" || holder(initial, now)) return
  const current = readLock(initial.path, fs)
  if (current && current.lock.status === "active" && !holder(current, now) && current.bytes.equals(initial.bytes)) {
    remove(current.path, fs)
  }
}

function acquireLock(input: AcquireInput, paths: Paths, opts: LockOptions, fs: ReviewLockFs): AcquireResult {
  const now = clock(opts)
  const snapshots = readBoth(paths, fs)
  available(snapshots, now.ms, input.force === true)
  const lock: ActiveLock = { schema_version: 1, status: "active", started_at: now.iso, run_id: input.runId }
  let installed = false
  try {
    writeAtomic(paths.current, lock, fs, () => available(readBoth(paths, fs), now.ms, input.force === true))
    installed = true
    cleanLegacy(snapshots[1], now.ms, fs)
    const current = requireOwner(paths.current, input.runId, fs)
    if (!current || current.lock.status !== "active" || current.lock.started_at !== now.iso) fail("readback-mismatch", paths.current)
    return { ok: true, state: "acquired", path: paths.current, started_at: now.iso }
  } catch (error) {
    const failure = error instanceof LockFailure ? error.result : rejection("write-error", paths.current, error)
    if (installed || (error instanceof LockFailure && error.installed)) {
      try {
        if (requireOwner(paths.current, input.runId, fs)) remove(paths.current, fs)
      } catch (cleanup) {
        return { ...failure, cleanup: cleanup instanceof LockFailure && "reason" in cleanup.result
          ? cleanup.result : rejection("cleanup-error", paths.current, cleanup) }
      }
    }
    return failure
  }
}

/**
 * Current run_id values are the release/rollback oracle, reread before each
 * mutation. Canonical lock.yaml selects the owner, falling back to legacy only
 * when absent; release also cleans a matching legacy lock but preserves another
 * run's legacy lock. A mismatch rejects release; unreadable state fails closed.
 * Complete writes the minimal terminal marker. No force or release mode bypasses
 * ownership, including acquisition rollback. Checks are not atomic with mutation.
 */
function releaseLock(input: ReleaseInput, paths: Paths, opts: LockOptions, fs: ReviewLockFs): ReleaseResult {
  const snapshots = readBoth(paths, fs)
  const current = snapshots[0] ?? snapshots[1]
  if (!current) return { ok: true, state: "absent" }
  if (current.lock.run_id !== input.runId) fail("not-owner", current.path)
  const completed: CompletedLock | undefined = input.mode === "complete"
    ? { status: "completed", run_id: input.runId, completed_at: clock(opts).iso } : undefined
  let changed = false
  for (const snapshot of snapshots) {
    if (!snapshot || snapshot.lock.run_id !== input.runId || !requireOwner(snapshot.path, input.runId, fs)) continue
    if (completed) {
      writeAtomic(snapshot.path, completed, fs, () => {
        if (!requireOwner(snapshot.path, input.runId, fs)) fail("not-owner", snapshot.path)
      })
    } else remove(snapshot.path, fs)
    changed = true
  }
  return changed ? { ok: true, state: completed ? "completed" : "released", path: current.path }
    : { ok: true, state: "absent" }
}

/**
 * Plain data properties and closed operation keys are the argument oracle before
 * filesystem access. Direct and executor callers reject invalid input; neither
 * tool arguments nor accessors can supply the host filesystem, root or clock.
 * No option bypasses validation. Only acquire accepts a boolean force value.
 */
function argumentsObject(input: unknown): Record<string, unknown> {
  if (!isRecord(input) || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    || Object.getOwnPropertySymbols(input).length) fail("invalid-arguments")
  return Object.fromEntries(Object.getOwnPropertyNames(input).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!
    if (!("value" in descriptor)) fail("invalid-arguments")
    return [key, descriptor.value]
  }))
}
function execute(op: Operation, input: unknown, opts: LockOptions): AcquireResult | ReleaseResult | StatusResult {
  try {
    const args = argumentsObject(input)
    if (Object.keys(args).some(key => !KEYS[op].includes(key)) || !nonempty(args.reviewRoot)
      || (op !== "status" && !nonempty(args.runId))
      || (Object.hasOwn(args, "force") && typeof args.force !== "boolean")
      || (op === "release" && args.mode !== "delete" && args.mode !== "complete")) fail("invalid-arguments")
    const fs = opts.fs ?? nodeFs
    const paths = lockPaths(args.reviewRoot, opts, fs, op === "acquire")
    // Legacy namespaces are a read-only resume source, including lock release.
    if (op !== "status" && isLegacyReviewPath(paths.current)) fail("path-outside-root", args.reviewRoot)
    if (op === "acquire") return acquireLock(args as AcquireInput, paths, opts, fs)
    if (op === "release") return releaseLock(args as ReleaseInput, paths, opts, fs)
    const now = clock(opts)
    const snapshots = readBoth(paths, fs)
    const holders = snapshots.flatMap(snapshot => {
      const held = holder(snapshot, now.ms)
      return held ? [held] : []
    })
    return { held: holders.length > 0, holders, legacy_present: snapshots[1] !== null }
  } catch (error) {
    return error instanceof LockFailure ? error.result : rejection("invalid-arguments")
  }
}

export function acquire(input: AcquireInput, opts: LockOptions): AcquireResult {
  return execute("acquire", input, opts) as AcquireResult
}
export function release(input: ReleaseInput, opts: LockOptions): ReleaseResult {
  return execute("release", input, opts) as ReleaseResult
}
export function status(input: StatusInput, opts: LockOptions): StatusResult {
  return execute("status", input, opts) as StatusResult
}

/** Host-only dependencies are captured once; executor results are JSON strings. */
export function createLockExecutor(
  reviewStateRoot: string,
  options: Omit<LockOptions, "reviewStateRoot"> = {},
): (input: unknown) => string {
  const opts: LockOptions = { reviewStateRoot, fs: options.fs, now: options.now }
  return input => {
    try {
      const { op, ...args } = argumentsObject(input)
      if (typeof op !== "string" || !Object.hasOwn(KEYS, op)) fail("invalid-op")
      return JSON.stringify(execute(op as Operation, args, opts))
    } catch (error) {
      return JSON.stringify(error instanceof LockFailure ? error.result : rejection("invalid-arguments"))
    }
  }
}

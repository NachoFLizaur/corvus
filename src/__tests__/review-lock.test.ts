import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import yaml from "js-yaml"
import { acquire, createLockExecutor, release, status, type LockOptions, type ReviewLockFs } from "../review-lock"
import { read_document, write_document } from "../review-persist"

const NOW = "2020-01-02T12:00:00.000Z"
const STALE = "2020-01-02T09:00:00.000Z"
const FUTURE = "2020-01-02T13:00:00.000Z"
const active = (run_id = "first-run", started_at = NOW) => ({ schema_version: 1, status: "active", started_at, run_id })
const load = (path: string): unknown => yaml.load(fs.readFileSync(path, "utf8"), { schema: yaml.JSON_SCHEMA })
type Fixture = { opts: LockOptions; reviewRoot: string; path: string; legacyPath: string }

function withFixture(run: (fixture: Fixture) => void): void {
  const temp = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corvus-review-lock-")))
  try {
    const root = join(temp, ".corvus")
    const reviewRoot = "tasks/example/reviews/pr42"
    const directory = join(root, reviewRoot)
    fs.mkdirSync(directory, { recursive: true })
    run({ opts: { reviewStateRoot: root, now: () => new Date(NOW) }, reviewRoot, path: join(directory, "lock.yaml"), legacyPath: join(directory, ".lock") })
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

describe("review lock acquisition", () => {
  test("bootstraps acquire and document persistence from a workspace without .corvus; status/release stay read-only", () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corvus-review-bootstrap-")))
    const opts = { reviewStateRoot: join(workspace, ".corvus"), now: () => new Date(NOW) }
    const reviewRoot = ".corvus/reviews/pr42"
    try {
      expect(status({ reviewRoot }, opts)).toMatchObject({ ok: false, reason: "path-resolution-error" })
      expect(release({ reviewRoot, runId: "first-run", mode: "complete" }, opts)).toMatchObject({ ok: false, reason: "path-resolution-error" })
      expect(fs.existsSync(join(workspace, ".corvus"))).toBe(false)
      expect(acquire({ reviewRoot: "../escape", runId: "first-run", force: true }, opts)).toMatchObject({ ok: false, reason: "path-outside-root" })
      expect(fs.existsSync(join(workspace, ".corvus"))).toBe(false)
      expect(acquire({ reviewRoot, runId: "first-run" }, opts)).toEqual({
        ok: true, state: "acquired", path: join(workspace, reviewRoot, "lock.yaml"), started_at: NOW,
      })
      const input = { reviewRoot, headSha: "a".repeat(40), sections: [{ heading: "", body: "# Review" }] }
      expect(write_document(input, opts)).toMatchObject({ ok: true, path: join(workspace, reviewRoot, input.headSha, "REVIEW_DOCUMENT.md") })
      expect(read_document({ reviewRoot, headSha: input.headSha }, opts)).toMatchObject({ ok: true, sections: input.sections })
      expect(status({ reviewRoot: "reviews/other" }, opts)).toMatchObject({ ok: false, reason: "path-resolution-error" })
      expect(fs.existsSync(join(opts.reviewStateRoot, "other"))).toBe(false)
    } finally { fs.rmSync(workspace, { recursive: true, force: true }) }
  })

  test("acquire cannot bootstrap through a redirected .corvus directory even with force", () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "corvus-review-bootstrap-")))
    try {
      const outside = join(workspace, "outside")
      fs.mkdirSync(outside)
      fs.symlinkSync(outside, join(workspace, ".corvus"))
      expect(acquire({ reviewRoot: "pr", runId: "first-run", force: true }, { reviewStateRoot: join(workspace, ".corvus/reviews") }))
        .toMatchObject({ ok: false, reason: "path-outside-root" })
      expect(fs.readdirSync(outside)).toEqual([])
    } finally { fs.rmSync(workspace, { recursive: true, force: true }) }
  })

  test("acquires an empty directory using the injected timestamp and writes the active schema", () => withFixture(({ opts, reviewRoot, path }) => {
    let clockCalls = 0
    const result = acquire({ reviewRoot, runId: "first-run" }, { ...opts, now: () => { clockCalls++; return new Date(NOW) } })
    expect(result).toEqual({ ok: true, state: "acquired", path, started_at: NOW })
    expect(load(path)).toEqual(active())
    expect(clockCalls).toBe(1)
    expect(fs.readdirSync(join(opts.reviewStateRoot, reviewRoot))).toEqual(["lock.yaml"])
  }))

  test("holds a second run with holder details and allows force to replace a readable fresh lock", () => withFixture(({ opts, reviewRoot, path }) => {
    expect(acquire({ reviewRoot, runId: "first-run" }, opts).ok).toBe(true)
    const before = fs.readFileSync(path)
    expect(acquire({ reviewRoot, runId: "second-run" }, opts)).toEqual({
      ok: false, state: "held", holder: { path, run_id: "first-run", started_at: NOW, age_s: 0 },
    })
    expect(fs.readFileSync(path)).toEqual(before)
    expect(acquire({ reviewRoot, runId: "second-run", force: true }, opts)).toEqual({ ok: true, state: "acquired", path, started_at: NOW })
    expect(load(path)).toEqual(active("second-run"))
  }))

  test("replaces a three-hour-old lock and removes stale legacy state only after a post-install reread", () => withFixture(({ opts, reviewRoot, path, legacyPath }) => {
    fs.writeFileSync(path, yaml.dump(active("old-run", STALE)))
    fs.writeFileSync(legacyPath, yaml.dump(active("old-legacy", STALE)))
    const events: string[] = []
    const io: ReviewLockFs = {
      ...fs,
      readFileSync(target) {
        if (target === legacyPath) events.push("read legacy")
        return fs.readFileSync(target)
      },
      renameSync(from, to) {
        fs.renameSync(from, to)
        if (to === path) events.push("install")
      },
      unlinkSync(target) {
        if (target === legacyPath) events.push("remove legacy")
        fs.unlinkSync(target)
      },
    }
    expect(acquire({ reviewRoot, runId: "new-run" }, { ...opts, fs: io })).toEqual({ ok: true, state: "acquired", path, started_at: NOW })
    expect(events).toEqual(["read legacy", "read legacy", "install", "read legacy", "remove legacy"])
    expect(load(path)).toEqual(active("new-run"))
    expect(fs.existsSync(legacyPath)).toBe(false)
  }))

  test("preserves a legacy lock changed between installation and cleanup", () => withFixture(({ opts, reviewRoot, path, legacyPath }) => {
    fs.writeFileSync(legacyPath, yaml.dump(active("old-legacy", STALE)))
    const replacement = yaml.dump(active("changed-legacy", STALE))
    const io: ReviewLockFs = {
      ...fs,
      renameSync(from, to) {
        fs.renameSync(from, to)
        if (to === path) fs.writeFileSync(legacyPath, replacement)
      },
    }
    expect(acquire({ reviewRoot, runId: "new-run" }, { ...opts, fs: io }).ok).toBe(true)
    expect(fs.readFileSync(legacyPath, "utf8")).toBe(replacement)
  }))

  test("a fresh legacy lock holds acquisition and is reported by status", () => withFixture(({ opts, reviewRoot, path, legacyPath }) => {
    fs.writeFileSync(legacyPath, yaml.dump(active("legacy-run")))
    const holder = { path: legacyPath, run_id: "legacy-run", started_at: NOW, age_s: 0 }
    expect(acquire({ reviewRoot, runId: "new-run" }, opts)).toEqual({ ok: false, state: "held", holder })
    expect(fs.existsSync(path)).toBe(false)
    expect(status({ reviewRoot }, opts)).toEqual({ held: true, holders: [holder], legacy_present: true })
  }))

  test("future timestamps remain held with a negative age from the injected clock", () => withFixture(({ opts, reviewRoot, path }) => {
    fs.writeFileSync(path, yaml.dump(active("future-run", FUTURE)))
    const holder = { path, run_id: "future-run", started_at: FUTURE, age_s: -3_600 }
    expect(acquire({ reviewRoot, runId: "new-run" }, opts)).toEqual({ ok: false, state: "held", holder })
    expect(status({ reviewRoot }, opts)).toEqual({ held: true, holders: [holder], legacy_present: false })
  }))

  for (const leaf of ["current", "legacy"] as const) {
    test(`rejects malformed ${leaf} YAML even under force`, () => withFixture(({ opts, reviewRoot, path, legacyPath }) => {
      const target = leaf === "current" ? path : legacyPath
      const malformed = "status: [active\n"
      fs.writeFileSync(target, malformed)
      for (const force of [false, true]) {
        expect(acquire({ reviewRoot, runId: "new-run", force }, opts)).toEqual({ ok: false, reason: "unreadable-lock", path: target })
        expect(fs.readFileSync(target, "utf8")).toBe(malformed)
      }
    }))
  }
})

describe("review lock release and status", () => {
  for (const mode of ["delete", "complete"] as const) {
    test(`releases matching current and legacy locks in ${mode} mode`, () => withFixture(({ opts, reviewRoot, path, legacyPath }) => {
      expect(acquire({ reviewRoot, runId: "first-run" }, opts).ok).toBe(true)
      fs.writeFileSync(legacyPath, yaml.dump(active()))
      let clockCalls = 0
      const completedAt = "2020-01-02T12:30:00.000Z"
      const result = release({ reviewRoot, runId: "first-run", mode }, { ...opts, now: () => { clockCalls++; return new Date(completedAt) } })
      expect(result).toEqual({ ok: true, state: mode === "delete" ? "released" : "completed", path })
      expect(clockCalls).toBe(mode === "complete" ? 1 : 0)
      for (const target of [path, legacyPath]) {
        if (mode === "delete") expect(fs.existsSync(target)).toBe(false)
        else expect(load(target)).toEqual({ status: "completed", run_id: "first-run", completed_at: completedAt })
      }
      expect(status({ reviewRoot }, opts)).toEqual({ held: false, holders: [], legacy_present: mode === "complete" })
    }))

    test(`rejects release by a non-owner in ${mode} mode without mutation`, () => withFixture(({ opts, reviewRoot, path }) => {
      expect(acquire({ reviewRoot, runId: "first-run" }, opts).ok).toBe(true)
      const before = fs.readFileSync(path)
      expect(release({ reviewRoot, runId: "second-run", mode }, opts)).toEqual({ ok: false, reason: "not-owner", path })
      expect(fs.readFileSync(path)).toEqual(before)
    }))
  }

  test("reports absent release and empty status", () => withFixture(({ opts, reviewRoot }) => {
    for (const mode of ["delete", "complete"] as const) {
      expect(release({ reviewRoot, runId: "first-run", mode }, opts)).toEqual({ ok: true, state: "absent" })
    }
    expect(status({ reviewRoot }, opts)).toEqual({ held: false, holders: [], legacy_present: false })
  }))

  test("status uses its injected clock for holder ages and the two-hour freshness boundary", () => withFixture(({ opts, reviewRoot, path }) => {
    expect(acquire({ reviewRoot, runId: "first-run" }, opts).ok).toBe(true)
    for (const [time, age_s] of [["2020-01-02T12:01:30.000Z", 90], ["2020-01-02T14:00:00.000Z", 7_200]] as const) {
      let clockCalls = 0
      expect(status({ reviewRoot }, { ...opts, now: () => { clockCalls++; return new Date(time) } })).toEqual({
        held: age_s < 7_200,
        holders: age_s < 7_200 ? [{ path, run_id: "first-run", started_at: NOW, age_s }] : [],
        legacy_present: false,
      })
      expect(clockCalls).toBe(1)
    }
  }))
})

describe("review lock symlink rejection", () => {
  for (const leaf of ["current", "legacy"] as const) {
    for (const op of ["acquire", "release", "status"] as const) {
      test(`${op} rejects a symlink ${leaf} lock`, () => withFixture(({ opts, reviewRoot, path, legacyPath }) => {
        const target = leaf === "current" ? path : legacyPath
        const outside = join(opts.reviewStateRoot, "outside.yaml")
        const original = yaml.dump(active())
        fs.writeFileSync(outside, original)
        fs.symlinkSync(outside, target)
        const args = op === "status" ? { op, reviewRoot } : op === "acquire"
          ? { op, reviewRoot, runId: "first-run", force: true }
          : { op, reviewRoot, runId: "first-run", mode: "delete" }
        expect(JSON.parse(createLockExecutor(opts.reviewStateRoot, { now: opts.now })(args)))
          .toEqual({ ok: false, reason: "unreadable-lock", path: target })
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true)
        expect(fs.readFileSync(outside, "utf8")).toBe(original)
      }))
    }
  }
})

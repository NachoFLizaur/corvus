import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkLightSnapshots, snapshotLightFixture } from "../../scripts/check-review-artifacts"
import { isLightClassPath } from "../review-storage-class"

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
const root = resolve(import.meta.dirname, "../..")
const harness = readFileSync(join(root, "scripts/smoke-review.sh"), "utf8")
const helpers = harness.slice(harness.indexOf("die()"), harness.indexOf("usage()"))

test("light fixture keeps dirty sentinels and ignores unchanged until the model-free full push", () => {
  const work = mkdtempSync(join(tmpdir(), "corvus-smoke-light-"))
  directories.push(work)
  const fixture = join(work, "fixture")
  mkdirSync(fixture)
  const git = (...args: string[]) => execFileSync("git", ["-C", fixture, ...args], { encoding: "utf8" }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "commit.gpgsign", "false")
  writeFileSync(join(fixture, ".gitignore"), ".corvus/\n")
  git("add", ".gitignore")
  git("commit", "-m", "Base")
  const head = git("rev-parse", "HEAD")
  const source = join(work, "source.git")
  git("clone", "--bare", fixture, source)
  git("remote", "add", "origin", source)
  writeFileSync(join(work, "changed-files.json"), '["README.md"]\n')
  const env = { ...process.env, WORK: work, SMOKE_WORK: work, SMOKE_ROOT: root, OWNER: "owner", REPO: "repo", NUMBER: "8",
    INTAKE: "url", AGENT: "light", SMOKE_INTAKE: "url", SMOKE_OWNER: "owner", SMOKE_REPO: "repo", GIT_TRACE2_EVENT: "" }
  const setup = Bun.spawnSync(["bash", "-c", `set -euo pipefail\n${helpers}\nprepare_light_fixture\nprepare_sync_remotes\nlight_snapshot before\nlight_compare\nlight_push_probe`], { env, cwd: fixture })
  expect(setup.exitCode, setup.stderr.toString()).toBe(0)
  const before = JSON.parse(readFileSync(join(work, "light-before.json"), "utf8"))
  const after = JSON.parse(readFileSync(join(work, "light-after.json"), "utf8"))
  expect(before.head).not.toBe(head)
  expect(before.branch).toStartWith("smoke/light-unrelated-")
  expect(checkLightSnapshots(before, after).every(row => row.ok)).toBe(true)
  expect(Buffer.from(before.ignores[".gitignore"], "base64").toString()).toBe(".corvus/\n")
  const probe = JSON.parse(readFileSync(join(work, "light-push-probe.json"), "utf8"))
  expect(probe).toMatchObject({ ok: true, root: ".corvus/reviews/pr8", paths: [".corvus/reviews/pr8/probe-meta.yaml"] })
  expect(probe.paths.some((path: string) => isLightClassPath(path.replace(/^\.corvus\//, "")))).toBe(false)
  expect(git("diff", "--cached", "--name-only")).toBe(".smoke-light-staged")
  expect(readFileSync(join(fixture, ".smoke-light-staged"), "utf8")).toBe("staged sentinel worktree bytes\n")
  // Snapshot helpers are read-only even after the probe.
  expect(snapshotLightFixture(fixture, join(work, "bare.git")).sentinels).toEqual(before.sentinels)
})

test("light rejects writer/full and preflight exits before run; auto remains the default", () => {
  expect(harness).toContain("AGENT=auto")
  expect(harness).toContain("AGENT_ID=corvus-review-auto")
  for (const flag of ["--writer", "--full"]) {
    const result = Bun.spawnSync(["bash", join(root, "scripts/smoke-review.sh"), "--host", "v1", "--agent", "light", flag])
    expect(result.exitCode).toBe(3)
    expect(result.stderr.toString()).toContain("requires denied writer")
  }
  const preflight = harness.slice(harness.indexOf("if ((PREFLIGHT_HOST)); then"), harness.indexOf("REVIEW_START=$SECONDS"))
  expect(preflight).toContain("light_compare; light_push_probe; light_preflight_metrics")
  expect(preflight).toContain("exit 0")
  expect(preflight).not.toContain('"$CLI" "${ARGS[@]}"')
  expect(harness).toContain('ARGS=(run --agent "$AGENT_ID"')
  expect(harness).toContain('CHECK_ARGS+=(--agent light)')
})

test.each(["v1", "v2"] as const)("%s light branch intake rejects before host selection or PR tracking setup", host => {
  const result = Bun.spawnSync(["bash", join(root, "scripts/smoke-review.sh"), "--host", host, "--agent", "light", "--intake", "branch", "--preflight-host"])
  expect(result.exitCode).toBe(3)
  expect(result.stderr.toString()).toContain("--agent light does not support --intake branch; use --intake url with --pr URL")
  expect(result.stdout.toString()).not.toContain("Sandbox:")
  expect(harness.indexOf("does not support --intake branch")).toBeLessThan(harness.indexOf('smoke_host_prepare "$HOST"'))
  expect(harness).toContain("branch (auto only)")
  expect(harness).toContain("Host preflight: PASS; plugin load verified")
  expect(harness).not.toContain("Host preflight: PASS; scoped plugin active")
})

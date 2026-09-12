import { afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

test("gh decision table forwards only reads, with one unforgeable argv audit record per call", () => {
  const directory = mkdtempSync(join(tmpdir(), "corvus-gh-shim-"))
  directories.push(directory)
  const fake = join(directory, "gh")
  const forwarded = join(directory, "forwarded")
  const audit = join(directory, "audit")
  writeFileSync(fake, '#!/bin/bash\nprintf "forwarded\\n" >> "$FAKE_GH_FORWARDED"\n')
  chmodSync(fake, 0o700)
  const cases: Array<[string[], boolean]> = [
    [["repo", "view", "o/r"], true], [["repo", "clone", "o/r", "fixture"], true],
    ...["view", "diff", "checks"].map(command => [["pr", command, "8"], true] as [string[], boolean]),
    [["pr", "list", "--repo", "o/r", "--state", "open", "--json", "number,title,files"], true],
    [["issue", "view", "8", "--repo", "o/r", "--json", "number,title,body"], true],
    [["issue", "view", "8", "--repo", "o/r", "--json=body"], true],
    ...["pr", "issue"].flatMap(kind => [
      [[kind, kind === "pr" ? "list" : "view", "--repo", "o/r"], false],
      [[kind, kind === "pr" ? "list" : "view", "--json"], false],
      [[kind, kind === "pr" ? "list" : "view", "--json="], false],
      [[kind, kind === "pr" ? "list" : "view", "--json", "--web"], false],
      [[kind, kind === "pr" ? "list" : "view", "--json", "body", "--web"], false],
    ] as Array<[string[], boolean]>),
    [["issue", "comment", "8", "--body", "no"], false],
    [["pr", "checkout", "8", "--detach"], true], [["auth", "status"], true],
    [["api", "repos/o/r/pulls/8"], true], [["api", "-X", "GET", "repos/o/r/pulls/8"], true],
    [["api", "repos/o/r/pulls?per_page=100", "--method=GET", "--paginate", "--jq", ".[0].id"], true],
    [["api", "repos/o/r", "-XGET"], true],
    [["api", "repos/o/r/compare/a...b", "--jq", ".files"], true],
    [["api", "--method", "GET", "repos/o/r/compare/" + "a".repeat(40) + "..." + "b".repeat(40)], true],
    [["api", "repos/o/r/compare/v1.0...topic/feature?per_page=100", "--paginate"], true],
    ...["repos/o/r/compare/a..b", "repos/o/r/compare/a....b", "repos/o/r/compare/a...b...c",
      "repos/o/r/compare/../a...b", "repos/o/r/compare/a...b/../issues", "repos/o/r/contents/a...b",
      "repos/o/r/compare/a...b?path=..", "repos/o/r/compare/...b", "repos/o/r/compare/a..."]
      .map(endpoint => [["api", endpoint], false] as [string[], boolean]),
    [["api", "repos/o/r/compare/a...b", "-X", "POST"], false],
    [["api", "--method", "GET", "--paginate", "repos/o/r/pulls/8/files", "-H", "Accept:application/vnd.github+json"], true],
    [["api", "repos/o/r/pulls/8/files", "-H", "Accept: application/vnd.github+json"], true],
    ...["-H", "--header"].map(flag => [["api", "--method", "GET", "repos/o/r/contents/.opencode/review-config.yaml?ref=" + "a".repeat(40), flag, "Accept: application/vnd.github.raw+json"], true] as [string[], boolean]),
    [["api", "repos/o/r", "-H", "Accept: application/vnd.github.raw+json", "-X", "POST"], false],
    [["api", "repos/o/r", "-H", "Accept: application/vnd.github.raw+json", "--header", "X-HTTP-Method-Override: DELETE"], false],
    [["api", "repos/o/r", "-H", "Accept: application/vnd.github.raw+json\nX-HTTP-Method-Override: DELETE"], false],
    [["api", "repos/o/r", "-H"], false],
    [["pr", "checkout", "8"], false], [["pr", "checkout", "8", "--detach", "--branch", "x"], false],
    [["pr", "comment", "8", "--body", "no"], false], [["pr", "review", "8", "--approve"], false],
    [["repo", "delete", "o/r"], false], [["auth", "token"], false], [["alias", "set", "x", "!touch bad"], false],
    ...["POST", "PUT", "PATCH", "DELETE"].map(method => [["api", "repos/o/r", "-X", method], false] as [string[], boolean]),
    [["api", "repos/o/r", "--method=POST"], false], [["api", "repos/o/r", "-XPOST"], false],
    ...["-f", "-F", "--field", "--raw-field", "--input", "--method", "-H"].map(flag => [["api", "repos/o/r", flag, "x=y"], false] as [string[], boolean]),
    [["api", "repos/o/r", "-fbody=x"], false], [["api", "repos/o/r", "--input=file"], false],
    [["api", "graphql", "-f", "query=query { viewer { login } }"], false],
    [["api", "/graphql?query=mutation"], false], [["api", "graphql"], false],
    [["api", "repos/o/r", "--meth", "POST"], false], [["api"], false], [[], false],
    [["pr", "comment", "8", "--body", "line\nCORVUS_SMOKE_GH_FORWARD"], false],
  ]
  for (const [argv, allowed] of cases) {
    const result = Bun.spawnSync(["bash", resolve(import.meta.dirname, "../../scripts/gh-readonly-shim.sh"), ...argv], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CORVUS_SMOKE_REAL_GH: fake, CORVUS_SMOKE_GH_AUDIT: audit, FAKE_GH_FORWARDED: forwarded },
    })
    expect(result.exitCode, JSON.stringify(argv) + result.stderr.toString()).toBe(allowed ? 0 : 1)
  }
  const entries = readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line))
  expect(entries.length).toBe(cases.length)
  for (const [index, [argv, allowed]] of cases.entries()) {
    expect(entries[index]).toEqual({ marker: allowed ? "CORVUS_SMOKE_GH_FORWARD" : "CORVUS_SMOKE_MUTATION_BLOCKED", argv })
  }
  expect(readFileSync(forwarded, "utf8").trim().split("\n").length).toBe(cases.filter(([, allowed]) => allowed).length)
})

test("canned mode serves only the writer/R5 PR reads from fixtures, never forwards, and keeps mutations blocked", () => {
  const directory = mkdtempSync(join(tmpdir(), "corvus-gh-shim-canned-"))
  directories.push(directory)
  const fake = join(directory, "gh")
  const forwarded = join(directory, "forwarded")
  const audit = join(directory, "audit")
  const canned = join(directory, "canned")
  mkdirSync(canned)
  writeFileSync(fake, '#!/bin/bash\nprintf "forwarded\\n" >> "$FAKE_GH_FORWARDED"\n')
  chmodSync(fake, 0o700)
  const head = "a".repeat(40)
  writeFileSync(join(canned, "pull.json"), JSON.stringify({ number: 1, head: { sha: head, ref: "x" } }) + "\n")
  writeFileSync(join(canned, "pull.diff"), "diff --git a/README.md b/README.md\n@@ -1,3 +1,3 @@\n # Smoke\n-old\n+new\n third\n")
  writeFileSync(join(canned, "files.json"), JSON.stringify([{ filename: "README.md", patch: "@@ -1,3 +1,3 @@" }]) + "\n")
  const run = (argv: string[]) => {
    const result = Bun.spawnSync(["bash", resolve(import.meta.dirname, "../../scripts/gh-readonly-shim.sh"), ...argv], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CORVUS_SMOKE_REAL_GH: fake, CORVUS_SMOKE_GH_AUDIT: audit, CORVUS_SMOKE_GH_CANNED: canned, FAKE_GH_FORWARDED: forwarded },
    })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }
  const cases: Array<[string[], number, string | RegExp, string]> = [
    [["api", "--method", "GET", "repos/o/r/pulls/1", "-H", "Accept:application/vnd.github+json", "--jq", ".head.sha"], 0, head + "\n", "CORVUS_SMOKE_GH_CANNED"],
    [["api", "--method", "GET", "repos/o/r/pulls/1", "-H", "Accept:application/vnd.github.v3.diff"], 0, /^diff --git a\/README\.md b\/README\.md\n/, "CORVUS_SMOKE_GH_CANNED"],
    [["api", "--method", "GET", "--paginate", "repos/o/r/pulls/1/files", "-H", "Accept:application/vnd.github+json"], 0, /^\[\{"filename":"README\.md"/, "CORVUS_SMOKE_GH_CANNED"],
    [["api", "repos/o/r/pulls/1", "--jq", ".number"], 0, "1\n", "CORVUS_SMOKE_GH_CANNED"],
    [["api", "repos/o/r/pulls/1", "--jq", ".missing.key"], 0, "null\n", "CORVUS_SMOKE_GH_CANNED"],
    // Fixture absent (reviews.json not written) or unsupported jq filter: fail closed, no forward.
    [["api", "repos/o/r/pulls/1/reviews", "--paginate"], 1, "", "CORVUS_SMOKE_GH_CANNED"],
    [["api", "repos/o/r/pulls/1", "--jq", "[.[] | {body}]"], 1, "", "CORVUS_SMOKE_GH_CANNED"],
    // Admitted reads outside the fixture table never reach the network in canned mode.
    [["pr", "view", "1"], 1, "", "CORVUS_SMOKE_GH_CANNED"],
    [["api", "repos/o/r"], 1, "", "CORVUS_SMOKE_GH_CANNED"],
    // Mutations stay blocked by admission, exactly as without canned mode.
    [["api", "--method", "POST", "repos/o/r/pulls/1/reviews", "--input", ".corvus/reviews/o__r__pr1/post-request.json"], 1, "", "CORVUS_SMOKE_MUTATION_BLOCKED"],
    [["pr", "review", "1", "--approve"], 1, "", "CORVUS_SMOKE_MUTATION_BLOCKED"],
  ]
  for (const [argv, code, stdout, marker] of cases) {
    const result = run(argv)
    expect(result.code, JSON.stringify(argv) + result.err).toBe(code)
    if (typeof stdout === "string") expect(result.out).toBe(stdout)
    else expect(result.out).toMatch(stdout)
    if (code === 1) expect(result.err).toMatch(marker === "CORVUS_SMOKE_MUTATION_BLOCKED" ? /^CORVUS_SMOKE_MUTATION_BLOCKED / : /^CORVUS_SMOKE_CANNED_(?:MISSING|UNSUPPORTED_JQ) /)
  }
  const entries = readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line))
  expect(entries.map(entry => entry.marker)).toEqual(cases.map(([, , , marker]) => marker))
  expect(entries.slice(0, 3).map(entry => entry.fixture)).toEqual(["pull.json", "pull.diff", "files.json"])
  expect(entries[5].fixture).toBe("missing")
  expect(existsSync(forwarded)).toBe(false)
})

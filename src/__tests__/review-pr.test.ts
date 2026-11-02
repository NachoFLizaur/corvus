import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  checks, config, createPrExecutor, diff, files, find, head, identity, isPrCallerAllowed, local, metadata, repo, reviews,
  type PrExec, type PrExecResult,
} from "../review-pr"

const HEAD_SHA = "a".repeat(40)
const BASE_SHA = "b".repeat(40)
const BODY = "PR_BODY_MUST_NOT_APPEAR_IN_DIAGNOSTICS"
const locator = { owner: "example", name: "project", pr: 42 }
const endpoint = "repos/example/project/pulls/42"
const REVIEW_URL = "https://github.com/example/project/pull/42#pullrequestreview-123"
const THREAD_URL = "https://github.com/example/project/pull/42#discussion_r456"
const MARKER = `<!-- corvus-review v1 head:${HEAD_SHA} -->`
const success = (stdout: string): PrExecResult => ({ code: 0, stdout, stderr: "" })
const forbidden: PrExecResult = { code: 1, stdout: BODY, stderr: `gh: Forbidden (HTTP 403)\n${BODY}` }
const commits = success(JSON.stringify([{ sha: HEAD_SHA, commit: { message: "Product change" } }]))
const commitsArgv = ["gh", "api", "--method", "GET", "--paginate", `${endpoint}/commits`, "-H", "Accept: application/vnd.github+json"]

function recordingExec(...responses: Array<PrExecResult | Promise<PrExecResult>>) {
  const calls: string[][] = []
  const exec: PrExec = async argv => {
    const response = responses[calls.length]
    calls.push([...argv])
    if (!response) throw new Error("Unexpected exec call")
    return response
  }
  return { calls, exec }
}

describe("review PR metadata, head and files", () => {
  test("detectors can recover PR evidence but cannot read invocation controls", () => {
    for (const caller of ["pr-code-reviewer", "security-reviewer", "pr-light-reviewer"]) {
      for (const op of ["metadata", "head", "files", "diff", "reviews", "checks"]) expect(isPrCallerAllowed(caller, op)).toBe(true)
      for (const op of ["identity", "config", "find", "local", "repo", "post", undefined]) expect(isPrCallerAllowed(caller, op)).toBe(false)
    }
    for (const caller of [undefined, null, "unknown", { agent: "security-reviewer" }]) expect(isPrCallerAllowed(caller, "metadata")).toBe(false)
    for (const op of ["head", "diff", "files", "reviews"]) expect(isPrCallerAllowed("pr-comment-writer", op)).toBe(true)
    for (const op of ["metadata", "checks", "identity", "config", "find", "local", "repo"]) expect(isPrCallerAllowed("pr-comment-writer", op)).toBe(false)
  })
  test("uses the exact metadata argv and preserves untrusted PR source evidence", async () => {
    const data = {
      number: 42, url: "https://github.com/example/project/pull/42", title: "A change", state: "OPEN",
      isDraft: false, isCrossRepository: false, mergeable: "MERGEABLE", author: { login: "contributor" },
      baseRefName: "main", baseRefOid: BASE_SHA, headRefName: "feature", headRefOid: HEAD_SHA, changedFiles: 2, additions: 137, deletions: 19,
      body: `${BODY}\n\n## Description\nKeep this text as-is.`,
      labels: [{ id: "L_1", name: "breaking-change", description: BODY, color: "ff0000" }],
      closingIssuesReferences: [{ number: 7, url: "https://github.com/example/project/issues/7", title: BODY }],
      latestReviews: [{ author: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: BODY, submittedAt: "2020-01-02T12:00:00Z" }],
      reviewDecision: "CHANGES_REQUESTED",
    }
    const { exec, calls } = recordingExec(success(JSON.stringify({ ...data, files: [{ body: BODY }] })), commits)
    const result = await metadata(locator, { exec })
    expect(result).toEqual({ ok: true, ...data, head_sha: HEAD_SHA, code_head: HEAD_SHA, api_calls: 2 })
    expect(calls).toEqual([[
      "gh", "pr", "view", "42", "--repo", "example/project", "--json",
      "number,url,title,body,author,baseRefName,baseRefOid,headRefName,headRefOid,labels,reviewRequests,isDraft,mergeable,state,mergedAt,additions,deletions,changedFiles,files,closingIssuesReferences,latestReviews,reviewDecision,isCrossRepository",
    ], commitsArgv])
    expect(result).not.toHaveProperty("files")
  })

  describe("metadata author logins", () => {
    const data = {
      number: 42, url: "https://github.com/example/project/pull/42", title: "A change", state: "OPEN",
      isDraft: false, isCrossRepository: false, mergeable: "MERGEABLE",
      baseRefName: "main", baseRefOid: BASE_SHA, headRefName: "feature", headRefOid: HEAD_SHA, changedFiles: 2, additions: 0, deletions: 0,
      body: BODY, labels: [], closingIssuesReferences: [], latestReviews: [], reviewDecision: null,
    }

    test.each([
      ["app/raven-nachoflizaur", "raven-nachoflizaur[bot]"],
      ["raven-nachoflizaur[bot]", "raven-nachoflizaur[bot]"],
      ["app/x", "x[bot]"],
      [`app/${"a".repeat(39)}`, `${"a".repeat(39)}[bot]`],
      ["app/A--9", "A--9[bot]"],
    ])("returns the canonical author for %s", async (name, canonical) => {
      const { exec } = recordingExec(success(JSON.stringify({ ...data, author: { login: name }, files: [] })), commits)
      expect(await metadata(locator, { exec })).toEqual({
        ok: true, ...data, author: { login: canonical }, head_sha: HEAD_SHA, code_head: HEAD_SHA, api_calls: 2,
      })
    })

    test.each([
      "app/", "app//x", "app/x/y", "app/-x", "app/x[bot]", "APP/x", "app/x-",
      "app/x_y", "app/x.y", "app/é", "app/x y", "app/x\n", `app/${"a".repeat(40)}`,
      null, 42, {},
    ])("rejects malformed metadata author login %j", async name => {
      const { exec } = recordingExec(success(JSON.stringify({ ...data, author: { login: name }, files: [] })), commits)
      expect(await metadata(locator, { exec })).toEqual({ ok: false, reason: "invalid-response", api_calls: 2 })
    })

    test.each(["additions", "deletions"])("validates numeric %s counts, including zero", async field => {
      const valid = { ...data, author: { login: "contributor" } }
      for (const value of [undefined, null, "12", -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        const { exec } = recordingExec(success(JSON.stringify({ ...valid, [field]: value })), commits)
        expect(await metadata(locator, { exec })).toEqual({ ok: false, reason: "invalid-response", api_calls: 2 })
      }
      const { exec } = recordingExec(success(JSON.stringify(valid)), commits)
      expect(await metadata(locator, { exec })).toMatchObject({ ok: true, additions: 0, deletions: 0 })
    })
  })

  test("reads head and base SHAs with the exact GET argv", async () => {
    const { exec, calls } = recordingExec(success(JSON.stringify({ head: { sha: HEAD_SHA.toUpperCase() }, base: { sha: BASE_SHA }, body: BODY })), commits)
    expect(await head(locator, { exec })).toEqual({ ok: true, head_sha: HEAD_SHA, code_head: HEAD_SHA, base_sha: BASE_SHA, api_calls: 2 })
    expect(calls).toEqual([["gh", "api", "--method", "GET", endpoint, "-H", "Accept: application/vnd.github+json"], commitsArgv])
  })

  test("reads concatenated file pages with explicit patch availability and counts observed pages", async () => {
    const patched = { filename: "src/example.ts", status: "modified", additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-[old]\n+"new"' }
    const binary = { filename: "image.png", status: "added", additions: 0, deletions: 0 }
    const { exec, calls } = recordingExec(success(`${JSON.stringify([patched])}\n${JSON.stringify([binary])}\n`))
    expect(await files({ ...locator, paginate: true }, { exec })).toEqual({
      ok: true, files: [{ ...patched, has_patch: true }, { ...binary, has_patch: false }], complete_pagination: true, excluded_corvus: 0, api_calls: 2,
    })
    expect(calls).toEqual([["gh", "api", "--method", "GET", "--paginate", `${endpoint}/files`, "-H", "Accept: application/vnd.github+json"]])
  })

  test("retains a validated file page but marks a failed next page incomplete and counts the failure", async () => {
    const file = { filename: "src/example.ts", status: "modified", additions: 1, deletions: 0 }
    const { exec, calls } = recordingExec({ ...forbidden, stdout: JSON.stringify([file]) })
    expect(await files({ ...locator, paginate: true }, { exec })).toEqual({
      ok: false, reason: "forbidden", http_status: 403, files: [{ ...file, has_patch: false }], complete_pagination: false, excluded_corvus: 0, api_calls: 2,
    })
    expect(calls).toHaveLength(1)
  })
})

describe("review PR bounded per-path patches", () => {
  const anchor = { filename: "src/anchor.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+first\n+second" }
  const binary = { filename: "image.png", status: "added", additions: 0, deletions: 0 }
  const state = { filename: ".corvus/reviews/pr15/input.md", status: "modified", additions: 1, deletions: 0, patch: "+state" }
  const listing = JSON.stringify([anchor]) + "\n" + JSON.stringify([binary, state]) + "\n"
  const input = { op: "files", ...locator, paginate: true }
  const anchored = { ...anchor, has_patch: true, diff_anchor: `diff-${createHash("sha256").update(anchor.filename).digest("hex")}` }
  const anchoredBinary = { ...binary, has_patch: false, diff_anchor: `diff-${createHash("sha256").update(binary.filename).digest("hex")}` }

  test("derives anchors from exact UTF-8 paths, not an API-supplied anchor", async () => {
    const filename = 'src/é path "quoted".ts'
    const item = { ...anchor, filename, diff_anchor: "diff-untrusted" }
    const { exec } = recordingExec(success(JSON.stringify([item])))
    expect(await files({ ...locator, paginate: true, paths: [filename] }, { exec })).toEqual({
      ok: true, files: [{ ...anchor, filename, has_patch: true, diff_anchor: `diff-${createHash("sha256").update(filename, "utf8").digest("hex")}` }],
      excluded_corvus: 0, missing_paths: [], complete_pagination: true, api_calls: 1,
    })
  })

  test("filters after full pagination, deduplicates selectors and preserves entire patches in listing order", async () => {
    const { exec, calls } = recordingExec(success(listing))
    const result = JSON.parse(await createPrExecutor({ exec })({ ...input, paths: [binary.filename, anchor.filename, anchor.filename] }))
    expect(result).toEqual({
      ok: true, files: [anchored, anchoredBinary],
      excluded_corvus: 1, missing_paths: [], complete_pagination: true, api_calls: 2,
    })
    expect(calls).toEqual([["gh", "api", "--method", "GET", "--paginate", `${endpoint}/files`, "-H", "Accept: application/vnd.github+json"]])
  })

  test("reports missing paths once in request order without treating excluded state files as absent", async () => {
    const { exec } = recordingExec(success(listing))
    expect(await files({ ...locator, paginate: true, paths: ["missing-z.ts", state.filename, anchor.filename, "missing-a.ts", "missing-z.ts"] }, { exec })).toEqual({
      ok: true, files: [anchored], excluded_corvus: 1,
      missing_paths: ["missing-z.ts", "missing-a.ts"], complete_pagination: true, api_calls: 2,
    })
  })

  test("an empty selector returns no records but still reads every page", async () => {
    const { exec } = recordingExec(success(listing))
    expect(await files({ ...locator, paginate: true, paths: [] }, { exec })).toEqual({
      ok: true, files: [], excluded_corvus: 1, missing_paths: [], complete_pagination: true, api_calls: 2,
    })
  })

  test("partial pagination retains matching evidence without claiming missing paths are confirmed absent", async () => {
    for (const response of [
      { ...forbidden, stdout: JSON.stringify([anchor]) },
      success(JSON.stringify([anchor]) + "\n[{"),
      success(JSON.stringify([anchor]) + "\n" + JSON.stringify([{ ...binary, additions: "bad" }])),
    ]) {
      const { exec } = recordingExec(response)
      expect(await files({ ...locator, paginate: true, paths: [anchor.filename, binary.filename] }, { exec })).toEqual({
        ok: false, reason: response.code === 0 ? "invalid-response" : "forbidden",
        ...(response.code === 0 ? {} : { http_status: 403 }), files: [anchored],
        excluded_corvus: 0, missing_paths: [binary.filename], complete_pagination: false,
        api_calls: 2,
      })
    }
  })

  test.each([
    null, "src/anchor.ts", {}, [null], [1], [""], ["."], [".."], ["./src/anchor.ts"],
    ["src/../anchor.ts"], ["src/./anchor.ts"], ["/src/anchor.ts"], ["src//anchor.ts"], ["src/"],
    ["C:/src/anchor.ts"], ["C:\\src\\anchor.ts"], ["src\\anchor.ts"], ["src/\0anchor.ts"],
    ["src/\nanchor.ts"], ["src/\tanchor.ts"], ["src/\u007fanchor.ts"], ["src/\u0085anchor.ts"],
    ["a".repeat(1_025)], Array.from({ length: 51 }, () => "duplicate.ts"),
  ].map(paths => [paths]))("rejects invalid paths %j before exec", async paths => {
    const { exec, calls } = recordingExec()
    expect(JSON.parse(await createPrExecutor({ exec })({ ...input, paths }))).toEqual({
      ok: false, reason: "invalid-input:paths", complete_pagination: false, api_calls: 0,
    })
    expect(calls).toEqual([])
  })

  test("rejects sparse or accessor-backed selectors without evaluating their entries", async () => {
    let reads = 0
    const accessor: string[] = []
    Object.defineProperty(accessor, "0", { get: () => { reads++; return anchor.filename } })
    const { exec, calls } = recordingExec()
    for (const paths of [Array<string>(1), accessor]) {
      expect(JSON.parse(await createPrExecutor({ exec })({ ...input, paths }))).toMatchObject({ ok: false, reason: "invalid-input:paths", api_calls: 0 })
    }
    expect(reads).toBe(0)
    expect(calls).toEqual([])
  })

  test("accepts the count/length boundaries and valid spaces, quotes and Unicode without interpreting paths", async () => {
    const paths = ["a".repeat(1_024), "src/path with spaces.ts", 'src/"quoted".ts', "src/é.ts", ...Array.from({ length: 46 }, (_, index) => `src/${index}.ts`)]
    const { exec, calls } = recordingExec(success("[]"))
    expect(await files({ ...locator, paginate: true, paths, names_only: false, include_corvus: false }, { exec })).toEqual({
      ok: true, files: [], excluded_corvus: 0, missing_paths: paths, complete_pagination: true, api_calls: 1,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].join(" ")).not.toContain(paths[0])
  })

  test("rejects paths with either names-only mode and rejects paths on other operations", async () => {
    const { exec, calls } = recordingExec()
    const run = createPrExecutor({ exec })
    for (const flags of [{ names_only: true }, { include_corvus: true }, { include_corvus: true, names_only: false }]) {
      expect(JSON.parse(await run({ ...input, paths: [anchor.filename], ...flags }))).toEqual({
        ok: false, reason: "invalid-input:paths", complete_pagination: false, api_calls: 0,
      })
    }
    expect(JSON.parse(await run({ op: "diff", ...locator, paths: [anchor.filename] }))).toEqual({ ok: false, reason: "invalid-arguments", api_calls: 0 })
    expect(calls).toEqual([])
  })

  test("keeps unfiltered executor JSON byte-identical to the captured pre-filter fixture", async () => {
    const snapshots: Array<[Record<string, boolean>, string]> = [
      [{}, '{"ok":true,"files":[{"filename":"src/anchor.ts","status":"added","additions":2,"deletions":0,"has_patch":true,"patch":"@@ -0,0 +1,2 @@\\n+first\\n+second"},{"filename":"image.png","status":"added","additions":0,"deletions":0,"has_patch":false}],"excluded_corvus":1,"complete_pagination":true,"api_calls":2}'],
      [{ names_only: true }, '{"ok":true,"files":["src/anchor.ts","image.png"],"excluded_corvus":1,"complete_pagination":true,"api_calls":2}'],
      [{ include_corvus: true }, '{"ok":true,"files":["src/anchor.ts","image.png",".corvus/reviews/pr15/input.md"],"excluded_corvus":0,"complete_pagination":true,"api_calls":2}'],
      [{ include_corvus: true, names_only: false }, '{"ok":true,"files":["src/anchor.ts","image.png",".corvus/reviews/pr15/input.md"],"excluded_corvus":0,"complete_pagination":true,"api_calls":2}'],
    ]
    for (const [flags, before] of snapshots) {
      const { exec } = recordingExec(success(listing))
      expect(await createPrExecutor({ exec })({ ...input, ...flags })).toBe(before)
    }
  })

  test("PR #15-sized oversized diff falls back to a complete new-file anchor in a readable filtered result", async () => {
    const bulk = { filename: "generated.txt", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+" }
    const baseOutput = JSON.stringify({ ok: true, files: [anchor, bulk].map(({ patch, ...item }) => ({ ...item, has_patch: true, patch })), excluded_corvus: 0, complete_pagination: true, api_calls: 2 })
    bulk.patch += "x".repeat(527_565 - Buffer.byteLength(baseOutput))
    const pages = JSON.stringify([anchor]) + "\n" + JSON.stringify([bulk])
    const { exec } = recordingExec(success("x".repeat(514_396)), success(pages), success(pages))
    const run = createPrExecutor({ exec })
    expect(JSON.parse(await run({ op: "diff", ...locator }))).toEqual({ ok: true, oversized: true, api_calls: 1 })
    const unfiltered = await run(input)
    expect(Buffer.byteLength(unfiltered)).toBe(527_565)
    const filtered = await run({ ...input, paths: [anchor.filename] })
    expect(Buffer.byteLength(filtered)).toBeLessThan(2_000)
    expect(JSON.parse(filtered)).toEqual({
      ok: true, files: [anchored], excluded_corvus: 0,
      missing_paths: [], complete_pagination: true, api_calls: 2,
    })
  })
})

describe("review PR tool-verified RIGHT anchors", () => {
  const input = { op: "files", ...locator, paginate: true }
  const changed = { filename: "src/changed.ts", status: "modified", additions: 2, deletions: 2,
    patch: "@@ -10,4 +10,4 @@\n context\n-deleted\n+added\n context2\n-tail\n+replacement\n@@ -30 +30 @@\n last" }
  const added = { filename: "new.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+first\n+last\n\\ No newline at end of file" }
  const deleted = { filename: "deleted.ts", status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-only old" }
  const binary = { filename: "image.png", status: "added", additions: 0, deletions: 0 }
  const listing = JSON.stringify([changed, added]) + "\n" + JSON.stringify([deleted, binary])
  const resultAnchor = (path: string, line: number, reason?: string, start_line?: number) => ({ path, line,
    ...(start_line === undefined ? {} : { start_line }), postable: reason === undefined, ...(reason ? { reason } : {}),
    diff_anchor: `diff-${createHash("sha256").update(path).digest("hex")}` })

  test("verifies added/context lines, new files and exact single-hunk ranges without returning patches", async () => {
    const anchors = [{ path: changed.filename, line: 10 }, { path: changed.filename, line: 11 },
      { path: changed.filename, start_line: 10, line: 13 }, { path: added.filename, start_line: 1, line: 2 },
      { path: changed.filename, start_line: 30, line: 30 }]
    const { exec, calls } = recordingExec(success(listing))
    const result = JSON.parse(await createPrExecutor({ exec })({ ...input, anchors }))
    expect(result).toEqual({ ok: true, excluded_corvus: 0,
      anchors: anchors.map(anchor => resultAnchor(anchor.path, anchor.line, undefined, anchor.start_line)), complete_pagination: true, api_calls: 2 })
    expect(result).not.toHaveProperty("files")
    expect(JSON.stringify(result)).not.toContain("patch")
    expect(calls).toHaveLength(1)
  })

  test("rejects deleted-only, outside, multi-hunk, missing and patchless anchors with compact reasons", async () => {
    const anchors = [{ path: deleted.filename, line: 1 }, { path: changed.filename, line: 14 },
      { path: changed.filename, start_line: 13, line: 30 }, { path: "missing.ts", line: 1 }, { path: binary.filename, line: 1 }]
    const { exec } = recordingExec(success(listing))
    expect(JSON.parse(await createPrExecutor({ exec })({ ...input, anchors })).anchors).toEqual([
      resultAnchor(deleted.filename, 1, "outside-hunk"), resultAnchor(changed.filename, 14, "outside-hunk"),
      resultAnchor(changed.filename, 30, "spans-hunks", 13), resultAnchor("missing.ts", 1, "path-not-in-pr"), resultAnchor(binary.filename, 1, "no-patch"),
    ])
  })

  test.each([
    "@@ -1,2 +1,2 @@\n context", // truncated hunk, even the observed line cannot establish completeness
    "@@ -1 +1 @@\n-context only old", // missing RIGHT line
    "@@ -1 +1 @@\n+new", // missing old line
    "@@ -1 +1 @@\n context\n+extra", // over-counted
    "@@ -1 +1 @@\nmalformed",
    "@@ -1 +9007199254740992 @@\n context",
    "@@ -0 +0 @@\n context",
  ])("malformed or incomplete patch %s cannot verify a visible line", async patch => {
    const { exec } = recordingExec(success(JSON.stringify([{ ...changed, patch }])))
    expect(JSON.parse(await createPrExecutor({ exec })({ ...input, anchors: [{ path: changed.filename, line: 1 }] })).anchors)
      .toEqual([resultAnchor(changed.filename, 1, "outside-hunk")])
  })

  test("incomplete pagination fails every anchor closed, including present early-page matches", async () => {
    for (const response of [{ ...forbidden, stdout: JSON.stringify([added]) }, success(JSON.stringify([added]) + "\n[{"),
      success(JSON.stringify([added, { ...binary, additions: "bad" }]))]) {
      const { exec } = recordingExec(response)
      const result = JSON.parse(await createPrExecutor({ exec })({ ...input, anchors: [{ path: added.filename, line: 1 }, { path: "missing.ts", line: 1 }] }))
      expect(result).toMatchObject({ ok: false, complete_pagination: false, anchors: [
        resultAnchor(added.filename, 1, "incomplete-pagination"), resultAnchor("missing.ts", 1, "incomplete-pagination"),
      ] })
      expect(result).not.toHaveProperty("files")
    }
  })

  test("anchors combine with independent paths selection and preserve empty-selector semantics", async () => {
    const { exec } = recordingExec(success(listing), success(listing))
    const run = createPrExecutor({ exec })
    const result = JSON.parse(await run({ ...input, paths: [binary.filename], anchors: [{ path: added.filename, line: 2 }] }))
    expect(result.files).toEqual([{ ...binary, has_patch: false, diff_anchor: resultAnchor(binary.filename, 1).diff_anchor }])
    expect(result.missing_paths).toEqual([])
    expect(result.anchors).toEqual([resultAnchor(added.filename, 2)])
    expect(JSON.parse(await run({ ...input, anchors: [] }))).toEqual({ ok: true, excluded_corvus: 0, anchors: [], complete_pagination: true, api_calls: 2 })
  })

  test.each([null, {}, "new.ts", [null], [{}], [{ path: "new.ts" }], [{ path: "new.ts", line: 0 }],
    [{ path: "new.ts", line: 1.5 }], [{ path: "new.ts", line: Number.MAX_SAFE_INTEGER + 1 }], [{ path: "new.ts", line: 1, side: "LEFT" }],
    [{ path: "new.ts", line: 1, start_line: 2 }], [{ path: "new.ts", line: 1, start_line: null }], [{ path: "new.ts", line: 1, start_line: undefined }],
    ...["", "./new.ts", "src/../new.ts", "/new.ts", "C:/new.ts", "src\\new.ts", "src/\0new.ts", "a".repeat(1_025)]
      .map(path => [{ path, line: 1 }]), Array.from({ length: 51 }, () => ({ path: "new.ts", line: 1 }))].map(anchors => [anchors]))(
    "invalid anchor input %j rejects before any exec", async anchors => {
      const { exec, calls } = recordingExec()
      expect(JSON.parse(await createPrExecutor({ exec })({ ...input, anchors }))).toEqual({ ok: false, reason: "invalid-input:anchors", complete_pagination: false, api_calls: 0 })
      expect(calls).toEqual([])
    })

  test("dense plain-data anchors reject accessors without executing them; names-only flags and other ops reject", async () => {
    let reads = 0
    const accessor: unknown[] = []
    Object.defineProperty(accessor, "0", { get: () => { reads++; return { path: "new.ts", line: 1 } } })
    const item = { path: "new.ts" }
    Object.defineProperty(item, "line", { get: () => { reads++; return 1 } })
    const { exec, calls } = recordingExec()
    const run = createPrExecutor({ exec })
    for (const anchors of [accessor, Array(1), [item]]) expect(JSON.parse(await run({ ...input, anchors })).reason).toBe("invalid-input:anchors")
    for (const flags of [{ names_only: true }, { include_corvus: true }])
      expect(JSON.parse(await run({ ...input, anchors: [], ...flags })).reason).toBe("invalid-input:anchors")
    expect(JSON.parse(await run({ op: "diff", ...locator, anchors: [] })).reason).toBe("invalid-arguments")
    expect(reads).toBe(0)
    expect(calls).toEqual([])
  })

  test("paths-only JSON stays byte-identical to the beta.2 field order and patch bytes", async () => {
    const { exec } = recordingExec(success(JSON.stringify([added])))
    const expected = `{"ok":true,"files":[{"filename":"new.ts","status":"added","additions":2,"deletions":0,"has_patch":true,"patch":${JSON.stringify(added.patch)},"diff_anchor":${JSON.stringify(resultAnchor(added.filename, 1).diff_anchor)}}],"excluded_corvus":0,"missing_paths":[],"complete_pagination":true,"api_calls":1}`
    expect(await createPrExecutor({ exec })({ ...input, paths: [added.filename] })).toBe(expected)
  })

  test("PR #15-sized selected README patch verifies all three anchors in less than 2 KB", async () => {
    const readmePatch = "@@ -280,5 +280,5 @@\n" + Array.from({ length: 5 }, () => " " + "x".repeat(10_000)).join("\n")
      + "\n@@ -704 +704 @@\n " + "x".repeat(3_206)
    expect(readmePatch.length).toBeGreaterThan(53_000)
    const records = [{ ...changed, filename: "README.md", patch: readmePatch },
      { ...changed, filename: "src/review-post.ts", patch: "@@ -113 +113 @@\n context" }]
    const { exec } = recordingExec(success(JSON.stringify(records)), success(JSON.stringify(records)))
    const run = createPrExecutor({ exec })
    expect(Buffer.byteLength(await run({ ...input, paths: records.map(item => item.filename) }))).toBeGreaterThan(50_000)
    const result = await run({ ...input, anchors: [{ path: "README.md", line: 284 }, { path: "README.md", line: 704 }, { path: "src/review-post.ts", line: 113 }] })
    expect(Buffer.byteLength(result)).toBeLessThan(2_000)
    expect(JSON.parse(result).anchors.every((anchor: { postable: boolean }) => anchor.postable)).toBe(true)
    expect(JSON.parse(result)).not.toHaveProperty("files")
  })
})

describe("review repository resolution", () => {
  const ghArgv = ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]
  const gitArgv = ["git", "remote", "get-url", "origin"]

  test("resolves gh owner/name without reading origin and uses the host cwd", async () => {
    const calls: Array<{ argv: string[]; cwd?: string }> = []
    const execute = createPrExecutor({ cwd: "/session", exec: async (argv, options) => {
      calls.push({ argv, cwd: options?.cwd })
      return success("example/project\n")
    } })
    expect(JSON.parse(await execute({ op: "repo" }))).toEqual({ ok: true, owner: "example", name: "project", source: "gh", api_calls: 1 })
    expect(calls).toEqual([{ argv: ghArgv, cwd: "/session" }])
  })

  test.each(["git@github.com:example/project.git", "ssh://git@github.com/example/project.git", "https://github.com/example/project.git"])(
    "falls back from gh to origin %s", async remote => {
      const { exec, calls } = recordingExec(forbidden, success(remote + "\n"))
      expect(await repo({}, { exec })).toEqual({ ok: true, owner: "example", name: "project", source: "git-remote", api_calls: 1 })
      expect(calls).toEqual([ghArgv, gitArgv])
    },
  )

  test("reports no-repository when neither source resolves", async () => {
    const { exec, calls } = recordingExec(forbidden, { code: 2, stdout: "", stderr: "No such remote 'origin'" })
    expect(await repo({}, { exec })).toEqual({ ok: false, reason: "no-repository", api_calls: 1 })
    expect(calls).toEqual([ghArgv, gitArgv])
  })

  test("uses the same explicit cwd for both commands after a spawn failure", async () => {
    const calls: Array<{ argv: string[]; cwd?: string }> = []
    const exec: PrExec = async (argv, options) => {
      calls.push({ argv, cwd: options?.cwd })
      if (argv[0] === "gh") throw new Error("ENOENT")
      return success("https://github.com/example/project")
    }
    expect(await repo({ cwd: "other worktree" }, { exec, cwd: "/session" })).toMatchObject({ ok: true, source: "git-remote" })
    expect(calls).toEqual([ghArgv, gitArgv].map(argv => ({ argv, cwd: "/session/other worktree" })))
  })

  test("rejects invalid controls before exec and never accepts malformed or other-host identities", async () => {
    const unused = recordingExec()
    for (const input of [{ op: "repo", cwd: "" }, { op: "repo", cwd: "bad\0path" }, { op: "repo", owner: "example" }]) {
      expect(JSON.parse(await createPrExecutor({ exec: unused.exec })(input))).toMatchObject({ ok: false, api_calls: 0 })
    }
    expect(unused.calls).toEqual([])
    for (const remote of ["https://gitlab.com/example/project.git", "git@github.com:example/../project", "https://github.com/example/project.git\nextra", "https://github.com/example/..", "https://github.com/example/project?x=1"]) {
      const { exec } = recordingExec(success("bad/owner/name"), success(remote))
      expect(await repo({}, { exec })).toEqual({ ok: false, reason: "no-repository", api_calls: 1 })
    }
  })
})

describe("review PR diff", () => {
  test("returns a successful diff as text with the exact diff media type argv", async () => {
    const text = "diff --git a/file b/file\n-old\n+new\n"
    const { exec, calls } = recordingExec(success(text))
    expect(await diff(locator, { exec })).toEqual({ ok: true, oversized: false, text, excluded_corvus: 0, api_calls: 1 })
    expect(calls).toEqual([["gh", "api", "--method", "GET", endpoint, "-H", "Accept: application/vnd.github.v3.diff"]])
  })

  for (const http_status of [406, 413]) {
    test(`returns HTTP ${http_status} as oversized without text or raw diagnostics`, async () => {
      const { exec, calls } = recordingExec({ code: 1, stdout: BODY, stderr: `gh: diff unavailable (HTTP ${http_status})\n${BODY}` })
      const result = await diff(locator, { exec })
      expect(result).toEqual({ ok: true, oversized: true, http_status, api_calls: 1 })
      expect(JSON.stringify(result)).not.toContain(BODY)
      expect(calls).toEqual([["gh", "api", "--method", "GET", endpoint, "-H", "Accept: application/vnd.github.v3.diff"]])
    })
  }
})

describe("review PR reviews and threads", () => {
  test("preserves REST bot logins in reviews", async () => {
    const review = {
      id: 123, user: { login: "raven-nachoflizaur[bot]" }, state: "COMMENTED", commit_id: HEAD_SHA,
      submitted_at: "2020-01-02T12:00:00Z", html_url: REVIEW_URL, body: BODY,
    }
    const { exec } = recordingExec(success(JSON.stringify([review])), success("[]"))
    expect(await reviews(locator, { exec })).toEqual({
      ok: true, reviews: [{ ...review, user: "raven-nachoflizaur[bot]" }], threads: [], dispositions: [],
      complete_pagination: true, complete_threads: true, api_calls: 2,
    })
  })

  test("joins paginated review and comment bodies unchanged with locations, reply links and unknown dispositions", async () => {
    const review = {
      id: 123, user: { login: "reviewer" }, state: "COMMENTED", commit_id: HEAD_SHA,
      submitted_at: "2020-01-02T12:00:00Z", html_url: REVIEW_URL, body: `${MARKER}\n${BODY}`,
    }
    const root = {
      id: 456, pull_request_review_id: 123, html_url: THREAD_URL, path: "src/example.ts",
      line: 10, original_line: 8, user: { login: "reviewer" }, commit_id: HEAD_SHA, original_commit_id: BASE_SHA,
      body: `logic-spec-001 ${BODY}\n\n\`\`\`suggestion\nreturn value\n\`\`\``,
    }
    const reply = { ...root, id: 457, in_reply_to_id: 456, user: { login: "contributor" }, body: BODY, html_url: `${THREAD_URL}-reply`, line: null }
    const { exec, calls } = recordingExec(
      success(`${JSON.stringify([review])}\n[]\n`),
      success(`${JSON.stringify([reply])}\n${JSON.stringify([root])}\n`),
    )
    const result = await reviews(locator, { exec })
    const projectedRoot = {
      id: 456, pull_request_review_id: 123, in_reply_to_id: null, html_url: THREAD_URL, path: "src/example.ts",
      line: 10, original_line: 8, user: "reviewer", commit_id: HEAD_SHA, original_commit_id: BASE_SHA,
      finding_id: "logic-spec-001", axis: "spec", dimension: "correctness",
      body: root.body,
    } as const
    expect(result).toEqual({
      ok: true,
      reviews: [{ id: 123, user: "reviewer", state: "COMMENTED", commit_id: HEAD_SHA, submitted_at: review.submitted_at, html_url: REVIEW_URL, body: review.body, body_marker: MARKER }],
      threads: [{ root: projectedRoot, replies: [{
        id: 457, pull_request_review_id: 123, in_reply_to_id: 456, html_url: reply.html_url, path: "src/example.ts",
        line: null, original_line: 8, user: "contributor", commit_id: HEAD_SHA, original_commit_id: BASE_SHA, finding_id: "thread-457",
        body: reply.body,
      }] }],
      dispositions: [{ finding_id: "logic-spec-001", axis: "spec", dimension: "correctness", thread_url: THREAD_URL, state: "unknown", evidence: BASE_SHA }],
      complete_pagination: true, complete_threads: true, api_calls: 4,
    })
    expect(calls).toEqual([
      ["gh", "api", "--method", "GET", "--paginate", `${endpoint}/reviews`, "-H", "Accept: application/vnd.github+json"],
      ["gh", "api", "--method", "GET", "--paginate", `${endpoint}/comments`, "-H", "Accept: application/vnd.github+json"],
    ])
  })

  test("does not claim complete pagination or thread coverage when comments are forbidden", async () => {
    const { exec, calls } = recordingExec(success("[]"), forbidden)
    expect(await reviews(locator, { exec })).toEqual({
      ok: false, reason: "forbidden", http_status: 403, reviews: [], threads: [], dispositions: [],
      complete_pagination: false, complete_threads: false, api_calls: 2,
    })
    expect(calls).toHaveLength(2)
  })
})

describe("review PR checks", () => {
  for (const response of [success("[]"), { code: 1, stdout: "", stderr: "no checks reported on the 'feature' branch\n" }]) {
    test(`returns empty checks for ${response.code === 0 ? "an empty JSON array" : "the no-checks CLI response"}`, async () => {
      const { exec, calls } = recordingExec(response)
      expect(await checks(locator, { exec })).toEqual({ ok: true, checks: [], api_calls: 1 })
      expect(calls).toEqual([["gh", "pr", "checks", "42", "--repo", "example/project", "--json", "name,state,link"]])
    })
  }

  test("marks forbidden checks unavailable without echoing diagnostic text", async () => {
    const { exec, calls } = recordingExec(forbidden)
    expect(await checks(locator, { exec })).toEqual({ ok: false, reason: "forbidden", http_status: 403, unavailable: true, api_calls: 1 })
    expect(calls).toHaveLength(1)
  })
})

describe("review PR identity and config", () => {
  test("reads a successful login using the exact user API argv", async () => {
    const { exec, calls } = recordingExec(success("reviewer\n"))
    expect(await identity({ exec })).toEqual({ ok: true, login: "reviewer", api_calls: 1 })
    expect(calls).toEqual([["gh", "api", "user", "--jq", ".login"]])
  })

  test("falls back after HTTP 403 to an active successful gh auth status entry", async () => {
    const { exec, calls } = recordingExec(forbidden, {
      code: 0, stdout: "", stderr: "github.com\n  ✓ Logged in to github.com account reviewer (keyring)\n  - Active account: true\n  - Git operations protocol: https\n",
    })
    expect(await identity({ exec })).toEqual({ ok: true, login: "reviewer", api_calls: 2 })
    expect(calls).toEqual([["gh", "api", "user", "--jq", ".login"], ["gh", "auth", "status"]])
  })

  test("returns unknown identity with a reason when the fallback account failed authentication", async () => {
    const { exec, calls } = recordingExec(forbidden, {
      code: 1, stdout: "", stderr: `github.com\n  X Failed to log in to github.com account reviewer (keyring)\n  - Active account: true\n  - ${BODY}\n`,
    })
    expect(await identity({ exec })).toEqual({ ok: false, login: null, reason: "identity-unavailable", http_status: 403, api_calls: 2 })
    expect(calls).toEqual([["gh", "api", "user", "--jq", ".login"], ["gh", "auth", "status"]])
  })

  test("reads raw YAML config at an immutable ref with the exact argv", async () => {
    const text = "review:\n  enabled: true\n"
    const { exec, calls } = recordingExec(success(text))
    expect(await config({ owner: locator.owner, name: locator.name, ref: HEAD_SHA }, { exec })).toEqual({ ok: true, present: true, yaml: text, api_calls: 1 })
    expect(calls).toEqual([["gh", "api", "--method", "GET", `repos/example/project/contents/.opencode/review-config.yaml?ref=${HEAD_SHA}`, "-H", "Accept: application/vnd.github.raw+json"]])
  })

  test("treats config HTTP 404 as absent rather than returning its body", async () => {
    const { exec, calls } = recordingExec({ code: 1, stdout: BODY, stderr: `gh: Not Found (HTTP 404)\n${BODY}` })
    expect(await config({ owner: locator.owner, name: locator.name, ref: HEAD_SHA }, { exec })).toEqual({ ok: true, present: false, http_status: 404, api_calls: 1 })
    expect(calls).toHaveLength(1)
  })
})

describe("review PR input validation and timeout", () => {
  for (const op of ["metadata", "head", "files", "diff", "reviews", "checks"] as const) {
    test(`${op} rejects invalid owners and nonpositive PR numbers before exec`, async () => {
      const { exec, calls } = recordingExec()
      const run = createPrExecutor({ exec })
      const args = { ...locator, ...(op === "files" ? { paginate: true } : {}) }
      for (const invalid of [{ owner: "bad/owner" }, { owner: "example\n" }, { pr: 0 }, { pr: -1 }]) {
        const result = JSON.parse(await run({ op, ...args, ...invalid }))
        expect(result).toEqual({
          ok: false, reason: "owner" in invalid ? "invalid-input:owner" : "invalid-input:pr",
          ...(op === "checks" ? { unavailable: true } : {}),
          ...(op === "files" || op === "reviews" ? { complete_pagination: false } : {}), api_calls: 0,
        })
      }
      expect(calls).toEqual([])
    })
  }

  test("config rejects invalid owners and refs other than a full 40-hex SHA before exec", async () => {
    const { exec, calls } = recordingExec()
    for (const invalid of [{ owner: "-example" }, { ref: "main" }, { ref: "a".repeat(39) }, { ref: "g".repeat(40) }, { ref: HEAD_SHA + "\n" }]) {
      expect(await config({ owner: locator.owner, name: locator.name, ref: HEAD_SHA, ...invalid }, { exec })).toEqual({
        ok: false, reason: "owner" in invalid ? "invalid-input:owner" : "invalid-input:ref", api_calls: 0,
      })
    }
    expect(calls).toEqual([])
  })

  test("a timed-out exec returns a failure-shaped unknown identity without retrying", async () => {
    const { exec, calls } = recordingExec(new Promise<PrExecResult>(() => {}))
    expect(await identity({ exec, timeoutMs: 25 })).toEqual({ ok: false, reason: "timeout", login: null, api_calls: 1 })
    expect(calls).toEqual([["gh", "api", "user", "--jq", ".login"]])
  })
})

describe("review PR discovery", () => {
  const viewArgv = ["gh", "pr", "view", "--json", "number,url,headRefName,state"]
  const listArgv = ["gh", "pr", "list", "--head", "B", "--state", "all", "--json", "number,url,state,headRefName", "--limit", "5"]
  const current = { number: 1, url: "https://github.com/example/project/pull/1", state: "OPEN", headRefName: "A" }
  const named = { number: 2, url: "https://github.com/example/project/pull/2", state: "OPEN", headRefName: "B" }

  test("finds the current branch PR using the exact view argv when no branch is supplied", async () => {
    const { exec, calls } = recordingExec(success(JSON.stringify(current)))
    expect(await find({}, { exec })).toEqual({ ok: true, found: true, number: 1, url: current.url, state: "OPEN", api_calls: 1 })
    expect(calls).toEqual([viewArgv])
  })

  test("treats the no-pull-requests stderr response as successful discovery with no match", async () => {
    const { exec, calls } = recordingExec({ code: 1, stdout: "", stderr: 'no pull requests found for branch "A"\n' })
    expect(await find({}, { exec })).toEqual({ ok: true, found: false, candidates: [], api_calls: 1 })
    expect(calls).toEqual([viewArgv])
  })

  test("finds branch B PR 2 without viewing current branch A PR 1", async () => {
    const calls: string[][] = []
    const exec: PrExec = async argv => {
      calls.push([...argv])
      return success(JSON.stringify(argv[2] === "view" ? current : [named]))
    }
    expect(await find({ branch: "B" }, { exec })).toEqual({ ok: true, found: true, number: 2, url: named.url, state: "OPEN", api_calls: 1 })
    expect(calls).toEqual([listArgv])
    expect(calls.some(argv => argv[1] === "pr" && argv[2] === "view")).toBe(false)
  })

  test.each([0, 2])("does not select a PR when the named branch list has %i candidates", async count => {
    const candidates = count === 0 ? [] : [named, { ...named, number: 3, url: "https://github.com/example/project/pull/3", state: "CLOSED" }]
    const { exec, calls } = recordingExec(success(JSON.stringify(candidates)))
    expect(await find({ branch: "B" }, { exec })).toEqual({ ok: true, found: false, candidates, api_calls: 1 })
    expect(calls).toEqual([listArgv])
  })

  test("rejects a named-branch response belonging to the current branch instead", async () => {
    const { exec, calls } = recordingExec(success(JSON.stringify([current])))
    expect(await find({ branch: "B" }, { exec })).toEqual({ ok: false, reason: "discovery-branch-mismatch", api_calls: 1 })
    expect(calls).toEqual([listArgv])
  })

  test("does not turn a forbidden discovery request into a successful no-match result", async () => {
    const { exec, calls } = recordingExec(forbidden)
    expect(await find({}, { exec })).toEqual({ ok: false, reason: "forbidden", http_status: 403, api_calls: 1 })
    expect(calls).toEqual([viewArgv])
  })
})

describe("review local changes", () => {
  const stat = " src/example.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n"
  const patch = "diff --git a/src/example.ts b/src/example.ts\n-old\n+new\n"
  const changedFiles = ["src/example.ts", "path with spaces.txt", "path\nwith\nnewlines.txt"]
  const diffArgv = ["git", "diff", "--no-ext-diff", "--no-textconv", "--no-color"]
  const commands = {
    branch: ["git", "branch", "--show-current"],
    head: ["git", "rev-parse", "HEAD"],
    log: ["git", "log", "--format=%H%x00%s", "-z", "HEAD", "--"],
    originHead: ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
    main: ["git", "show-ref", "--verify", "--quiet", "refs/heads/main"],
    master: ["git", "show-ref", "--verify", "--quiet", "refs/heads/master"],
    merge: ["git", "merge-base", "refs/remotes/origin/main", "HEAD"],
    mainMerge: ["git", "merge-base", "refs/heads/main", "HEAD"],
    masterMerge: ["git", "merge-base", "refs/heads/master", "HEAD"],
    ahead: ["git", "rev-list", "--count", `${BASE_SHA}..HEAD`],
    stat: [...diffArgv, "--stat", BASE_SHA, "--", ".", ":(top,exclude).corvus/**"],
    names: [...diffArgv, "--name-only", "-z", BASE_SHA, "--"],
    patch: [...diffArgv, "-p", BASE_SHA, "--", ".", ":(top,exclude).corvus/**"],
    status: ["git", "--no-optional-locks", "status", "--porcelain"],
  }
  const responses: Record<keyof typeof commands, PrExecResult> = {
    branch: success("feature\n"), head: success(`${HEAD_SHA}\n`), originHead: success("refs/remotes/origin/main\n"),
    log: success(`${HEAD_SHA}\0Product change\0`),
    main: success(""), master: success(""), merge: success(`${BASE_SHA}\n`),
    mainMerge: success(`${BASE_SHA}\n`), masterMerge: success(`${BASE_SHA}\n`), ahead: success("3\n"),
    stat: success(stat), names: success(changedFiles.join("\0") + "\0"), patch: success(patch), status: success(""),
  }
  const absent: PrExecResult = { code: 1, stdout: "", stderr: "" }
  const changeCommands = [commands.ahead, commands.stat, commands.names, commands.patch, commands.status]

  async function runLocal(overrides: Partial<typeof responses> = {}) {
    const calls: string[][] = []
    const exec: PrExec = async argv => {
      calls.push([...argv])
      const key = (Object.keys(commands) as Array<keyof typeof commands>)
        .find(key => JSON.stringify(commands[key]) === JSON.stringify(argv))
      if (!key) throw new Error("Unexpected exec call")
      return overrides[key] ?? responses[key]
    }
    const result = await local({}, { exec })
    for (const argv of calls) expect(Object.values(commands)).toContainEqual(argv)
    expect(result.api_calls).toBe(0)
    return { result, calls }
  }

  test("reads a clean tree, branch, ahead count and NUL-delimited paths using only exact read-only git forms", async () => {
    const { result, calls } = await runLocal()
    expect(result).toEqual({
      ok: true, branch: "feature", head_sha: HEAD_SHA, code_head: HEAD_SHA, excluded_corvus: 0, default_branch: "main", merge_base: BASE_SHA,
      ahead: 3, changed_files: changedFiles, stat, diff: patch, oversized: false, dirty: false, api_calls: 0,
    })
    expect(calls).toEqual([commands.branch, commands.head, commands.log, commands.originHead, commands.merge, ...changeCommands])
  })

  test("marks nonempty porcelain output dirty", async () => {
    const { result } = await runLocal({ status: success(" M src/example.ts\n?? note.txt\n") })
    expect(result).toMatchObject({ ok: true, dirty: true })
  })

  test("AC10: LOCAL patch covers tracked staged and unstaged bytes against the trusted merge base, not HEAD", async () => {
    const stagedAndUnstaged = "diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-merge-base bytes\n+staged and unstaged worktree bytes\n"
    const { result, calls } = await runLocal({ patch: success(stagedAndUnstaged), status: success("MM src/example.ts\n") })
    expect(result).toMatchObject({ ok: true, merge_base: BASE_SHA, dirty: true, diff: stagedAndUnstaged, api_calls: 0 })
    const diffs = calls.filter(argv => argv[1] === "diff")
    expect(diffs).toEqual([commands.stat, commands.names, commands.patch])
    for (const argv of diffs) {
      expect(argv).toContain(BASE_SHA)
      expect(argv).not.toContain(HEAD_SHA)
      expect(argv).not.toContain("--cached")
      expect(argv).not.toContain("HEAD")
    }
  })

  test.each(["main", "master"] as const)("falls back to local %s in main-then-master order when origin HEAD is unavailable", async branch => {
    const { result, calls } = await runLocal({ originHead: absent, ...(branch === "master" ? { main: absent } : {}) })
    expect(result).toMatchObject({ ok: true, default_branch: branch, merge_base: BASE_SHA })
    expect(calls).toEqual([
      commands.branch, commands.head, commands.log, commands.originHead, commands.main,
      ...(branch === "master" ? [commands.master, commands.masterMerge] : [commands.mainMerge]), ...changeCommands,
    ])
  })

  test("represents a detached HEAD with a null branch and the resolved head SHA", async () => {
    const { result } = await runLocal({ branch: success("") })
    expect(result).toMatchObject({ ok: true, branch: null, head_sha: HEAD_SHA })
  })

  test.each([512_000, 512_002])("bounds a %i-byte UTF-8 local diff without returning a partial patch", async bytes => {
    const text = "é".repeat(bytes / 2)
    expect(Buffer.byteLength(text)).toBe(bytes)
    const oversized = bytes > 512_000
    const { result } = await runLocal({ patch: success(text) })
    expect(result).toMatchObject({ ok: true, oversized, diff: oversized ? "" : text })
  })

  test("discards a diff marked truncated by the executor even when its remaining text is small", async () => {
    const { result } = await runLocal({ patch: { ...success(patch), stdout_truncated: true } })
    expect(result).toMatchObject({ ok: true, oversized: true, diff: "" })
  })

  test("returns a structured failure without reading changes when no merge base exists", async () => {
    const { result, calls } = await runLocal({ merge: absent })
    expect(result).toEqual({ ok: false, reason: "git-read-failed", api_calls: 0 })
    expect(calls).toEqual([commands.branch, commands.head, commands.log, commands.originHead, commands.merge])
  })

  test("reports no default branch after exhausting the local fallback refs without fetching", async () => {
    const { result, calls } = await runLocal({ originHead: absent, main: absent, master: absent })
    expect(result).toEqual({ ok: false, reason: "no-default-branch", api_calls: 0 })
    expect(calls).toEqual([commands.branch, commands.head, commands.log, commands.originHead, commands.main, commands.master])
  })
})

describe("committed review state PR reads", () => {
  test.each([1, 2])("metadata and head skip %i state commits across commit pages", async count => {
    const states = Array.from({ length: count }, (_, index) => ({
      sha: String(index + 1).repeat(40), commit: { message: `corvus(review-state): pr42 @ ${HEAD_SHA.slice(0, 7)} [skip ci]` },
    }))
    const tip = states.at(-1)!.sha
    const pages = success(`${JSON.stringify([{ sha: HEAD_SHA, commit: { message: "Product change" } }])}\n${JSON.stringify(states)}`)
    const data = {
      number: 42, url: "https://github.com/example/project/pull/42", title: "A change", state: "OPEN",
      isDraft: false, isCrossRepository: false, mergeable: "MERGEABLE", author: { login: "contributor" },
      baseRefName: "main", baseRefOid: BASE_SHA, headRefName: "feature", headRefOid: tip, changedFiles: 2, additions: 137, deletions: 19,
      body: BODY, labels: [], closingIssuesReferences: [], latestReviews: [], reviewDecision: null,
    }
    const metadataExec = recordingExec(success(JSON.stringify(data)), pages)
    expect(await metadata(locator, { exec: metadataExec.exec })).toEqual({ ok: true, ...data, head_sha: tip, code_head: HEAD_SHA, api_calls: 3 })
    const headExec = recordingExec(success(JSON.stringify({ head: { sha: tip }, base: { sha: BASE_SHA } })), pages)
    expect(await head(locator, { exec: headExec.exec })).toEqual({ ok: true, head_sha: tip, code_head: HEAD_SHA, base_sha: BASE_SHA, api_calls: 3 })
    expect(metadataExec.calls[1]).toEqual(commitsArgv)
    expect(headExec.calls[1]).toEqual(commitsArgv)
  })

  test("returns only unfiltered names for include_corvus and excludes state records by default", async () => {
    const inventory = ["src/example.ts", ".corvus/tasks/feature/PLAN.md", ".corvus/reviews/pr42/input.md"].map(filename => ({
      filename, status: "modified", additions: 1, deletions: 0, patch: `+${BODY}`,
    }))
    for (const names_only of [true, false]) {
      const { exec, calls } = recordingExec(success(JSON.stringify(inventory)))
      const result = await files({ ...locator, paginate: true, include_corvus: true, names_only }, { exec })
      expect(result).toEqual({ ok: true, files: inventory.map(item => item.filename), complete_pagination: true, excluded_corvus: 0, api_calls: 1 })
      expect(JSON.stringify(result)).not.toContain(BODY)
      expect(calls).toEqual([["gh", "api", "--method", "GET", "--paginate", `${endpoint}/files`, "-H", "Accept: application/vnd.github+json"]])
    }
    const { exec } = recordingExec(success(JSON.stringify(inventory)))
    expect(await files({ ...locator, paginate: true }, { exec })).toEqual({
      ok: true, files: [{ ...inventory[0], has_patch: true }], complete_pagination: true, excluded_corvus: 2, api_calls: 1,
    })
  })

  test("excludes state diff sections, including quoted paths and renames into state", async () => {
    const product = "diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n"
    const state = [
      "diff --git a/.corvus/tasks/feature/PLAN.md b/.corvus/tasks/feature/PLAN.md\n+plan\n",
      'diff --git "a/.corvus/reviews/pr42/a b.md" "b/.corvus/reviews/pr42/a b.md"\n+review\n',
      "diff --git a/notes.md b/.corvus/reviews/pr42/notes.md\nrename from notes.md\nrename to .corvus/reviews/pr42/notes.md\n",
    ]
    const { exec } = recordingExec(success(state[0] + product + state.slice(1).join("")))
    expect(await diff(locator, { exec })).toEqual({ ok: true, text: product, oversized: false, excluded_corvus: 3, api_calls: 1 })
  })

  test("fails closed on incomplete commit pages or a tip that moved between reads", async () => {
    for (const response of [{ ...forbidden, stdout: commits.stdout }, success(JSON.stringify([{ sha: BASE_SHA, commit: { message: "Earlier product" } }]))]) {
      const { exec, calls } = recordingExec(success(JSON.stringify({ head: { sha: HEAD_SHA }, base: { sha: BASE_SHA } })), response)
      const result = await head(locator, { exec })
      expect(result).toMatchObject({ ok: false, reason: response.code === 0 ? "head-moved" : "forbidden" })
      expect(result).not.toHaveProperty("code_head")
      expect(calls[1]).toEqual(commitsArgv)
    }
  })

  test("projects both v1 and v2 review markers from the API", async () => {
    const v2 = `<!-- corvus-review v2 path=.corvus/tasks/feature/reviews/pr42 head=${HEAD_SHA} round=2 -->`
    const inventory = [MARKER, v2].map((marker, index) => ({
      id: index + 1, user: { login: "reviewer" }, state: "COMMENTED", commit_id: HEAD_SHA,
      submitted_at: "2026-01-01T12:00:00Z", html_url: REVIEW_URL, body: `${marker}\n${BODY}`,
    }))
    const { exec } = recordingExec(success(JSON.stringify(inventory)), success("[]"))
    const result = await reviews(locator, { exec })
    expect(result).toMatchObject({ ok: true, complete_pagination: true, complete_threads: true })
    if (!result.ok) throw new Error("Expected review markers")
    expect(result.reviews.map(item => item.body_marker)).toEqual([MARKER, v2])
  })
})

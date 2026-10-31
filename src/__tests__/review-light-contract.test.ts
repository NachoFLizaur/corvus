import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseFrontmatter } from "../parse-frontmatter"
import { root } from "../paths"
import { LIGHT_EVIDENCE_CASES } from "./fixtures/review-light"

const agent = readFileSync(resolve(root, "agent/corvus-review-light.md"), "utf8")
const skill = readFileSync(resolve(root, "skill/corvus-review-light/SKILL.md"), "utf8")
const detector = readFileSync(resolve(root, "agent/pr-light-reviewer.md"), "utf8")
const state = readFileSync(resolve(root, "skill/corvus-review-extras/state.md"), "utf8")
const normalize = (text: string) => text.replace(/<!--[^]*?-->/g, "").replace(/[`*]/g, "").replace(/\s+/g, " ").trim()
const section = (text: string, heading: string) => {
  const start = text.indexOf(`### ${heading}\n`)
  if (start < 0) throw new Error(`Missing procedure section: ${heading}`)
  const end = text.indexOf("\n### ", start + 1)
  return normalize(text.slice(start, end < 0 ? undefined : end))
}

/** Oracle: real prompt sections read before any in-memory mutation, plus these
 * test-owned semantic guards. Comments cannot satisfy them. A missing contract
 * fails unconditionally; no rollout flag disables it. These are prompt contracts,
 * not claims that a model run exercised the fixture or followed the instructions. */
const pin = (text: string, required: RegExp) => {
  expect(text).toMatch(required)
  const removed = text.replace(required, "REMOVED CONTRACT")
  expect(removed).not.toBe(text)
  expect(removed).not.toMatch(required)
}

describe("light prompt contracts", () => {
  test("AC1/AC3: autonomous identity and closed two-child roster without the phase pipeline", () => {
    const fm = parseFrontmatter(agent).frontmatter
    expect(fm.mode).toBe("primary")
    expect(fm.permission).toHaveProperty("question", "deny")
    const roster = [...skill.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1])
    expect(roster).toEqual(["pr-light-reviewer", "pr-comment-writer"])
    pin(normalize(agent), /Load skill corvus-review-light at intake/)
    pin(normalize(agent), /Inline shared-contract summaries suffice for the happy path/i)
    pin(normalize(agent), /Do not load other skills/)
    pin(normalize(skill), /Load only this skill.*references, not R0–R5 skill loads or procedures/)
    pin(normalize(skill), /Load only this skill; do not load other skills\. Inline rules suffice; links are conditional references/)
    const otherSkillLoads = (text: string) => [...text.matchAll(/\b(?:Load skill|skill\s*\()\s*[`"']?([a-z0-9-]+)/gi)]
      .map(match => match[1]).filter(name => name !== "corvus-review-light")
    for (const text of [agent, skill]) {
      expect(otherSkillLoads(text)).toEqual([])
      for (const name of ["corvus-review-extras", "corvus-review-r0", "frontend-design"])
        expect(otherSkillLoads(text + `\nLoad skill \`${name}\` now.`)).toEqual([name])
    }
    expect(skill).not.toMatch(/extras hub is optional/i)
    pin(normalize(skill), /closed roster/)
    pin(normalize(skill), /no todos ceremony, phase-completion markers, context-gatherer\/researcher, review-input staging, document checkpoint\/read_document, head records, meta\/facts writes, convergence compute, sync pull\/push, checkout or resumable-state reuse/)
    const operativePhaseLoad = /\b(?:Load skill|skill\s*\()\s*[`"']?corvus-review-r[0-5]\b/i
    for (const text of [agent, skill]) {
      expect(text).not.toMatch(operativePhaseLoad)
      expect(text + '\nLoad skill `corvus-review-r0` at intake.').toMatch(operativePhaseLoad)
    }
    const forbiddenCall = /op:\s*["'](?:write_document|write_input|write_meta|write_facts|pull|push)["']|target:\s*["'](?:document|input)["']/
    expect(skill).not.toMatch(forbiddenCall)
    for (const op of ["write_document", "write_input", "write_meta", "write_facts", "pull", "push"])
      expect(skill + `\nCall tool with {op: "${op}"}.`).toMatch(forbiddenCall)
    expect(normalize(state)).toMatch(/corvus-review-light → true/)
    expect(normalize(state)).toMatch(/light procedure.*shared namespace\/lock.*fixed sync-off/)
  })

  test("AC2/AC7/AC9: shared root/lock/history with candidate-only local storage and no checkpoint", () => {
    const namespace = section(skill, "2. Resolve Namespace and Acquire the Shared Lock")
    pin(namespace, /corvus_review_sync with \{op: "resolve".*changed_files: <unfiltered PR names or local\.changed_files>/)
    pin(namespace, /SHARED review_root \(not its \.light child\).*Tools route light candidates\/staging to <review_root>\/\.light\//)
    pin(namespace, /legacy_root is read-only history, not a write target/)
    pin(namespace, /Held by another run or explicit denial → lock held\/denied: not posted, step 10 BEFORE detector dispatch; never force or overwrite\. No candidate\/artifact mutation or writer dispatch/)
    pin(namespace, /Storage\/unreadable-lock errors retain analysis in memory and exact diagnostics; reattempt acquisition before candidate\/artifact mutation or writer dispatch only if this invocation has never acquired\. Held\/denied on that attempt uses the same outcome/)
    pin(namespace, /Before acquire, git ls-files -- <review_root>\/lock\.yaml records tracked status \(unknown on failure\) for step 10/)
    pin(namespace, /Every exit routes through step 10/)
    pin(normalize(skill), /Await admission before head preparation\/detection/)
    pin(section(skill, "5. Dispatch the Single Detector"), /Dispatch foreground literal pr-light-reviewer once per attempt: trusted attempt number\/mode\/identity/)
    const config = section(skill, "3. Load Verified Config and Marker History")
    pin(config, /ref: base_sha.*defaults → valid base values → valid trusted invocation values → fixed light mode\/sync and bounds/)
    pin(config, /WITHOUT code_head or headSha \(history-only, writes nothing\)\. Recompute per attempt; use only its round/)
    pin(normalize(skill), /state_sync: false is fixed for this identity regardless of base config or invocation overlays/)
    const persist = section(skill, "7. Persist Candidate, Freeze and Preview")
    pin(persist, /Require step 2's fresh-ownership status once per presentation revision, before its first candidate\/artifact mutation \(staging or write_candidate\); that check covers append, finalize and freeze for the revision\. Repairs start a new revision/)
    pin(persist, /write_candidate.*6,000-character bound.*begin target candidate → append lossless ordered body\/path\/body parts with anchors on path part 0 → finalize expected_comments/)
    pin(persist, /<review_root>\/\.light\/candidate\.json; no document\/input\/meta\/facts writes/)
    pin(normalize(agent), /light artifacts are not resumable checkpoints/)
  })

  test("AC5: previewed bytes, event and code head bind authorization; fit and relocation renew it", () => {
    const persist = section(skill, "7. Persist Candidate, Freeze and Preview")
    pin(persist, /Measure once per presentation revision, then call payload freeze.*\.light\/candidate\.json.*\.light\/post-request\.json/)
    pin(persist, /Call payload \{op: "preview", artifactPath, expectedSha256: <returned digest>\}.*actual decoded body\/comments\/commit_id\/event and verified digest, never a reconstructed or host-truncated preview/)
    pin(persist, /fitting, not a size loop.*fitted\/omitted and size_fit separately from relocation counts/)
    const dispatch = section(skill, "8. Authorize and Revalidate Every Writer Dispatch")
    pin(dispatch, /decision: auto_post, digest: <preview\.sha256>, event: <preview\.event>, code_head: <preview\.commit_id>/)
    pin(dispatch, /Require digest\/event\/code_head equality to the current frozen descriptor; prior artifacts or authorization never carry over/)
    pin(dispatch, /Any byte\/placement change, including fitting or relocation, needs step 7's fresh freeze\/preview and renewed authorization/)
    pin(dispatch, /Dispatch literal pr-comment-writer with ONLY.*artifact_path = <review_root>\/\.light\/post-request\.json.*expected_sha256 = current frozen digest.*head_sha = code_head, event = authorized event\. No review text or extra controls/)
    pin(dispatch, /unchanged writer\/post integrity and live-head check remain authoritative/)
    const results = section(skill, "9. Map Writer Results and Relocate Unverifiable Anchors")
    pin(results, /step 7 re-stages → re-freezes → re-previews, step 8 renews authorization and repeats live metadata before dispatch/)
    pin(results, /unknown positions are invalid diagnostics, never guessed relocations/)
    pin(results, /entire body\/identity\/suggestion unchanged, preserving other comments\/order, findings, marker\/event and notices/)
    expect(skill).not.toMatch(/Call corvus_review_post/)
  })

  test("AC4/AC5/AC6: metadata-first movement after detection/preview and writer rejection, including recovery", () => {
    const dispatch = section(skill, "8. Authorize and Revalidate Every Writer Dispatch")
    pin(dispatch, /After preview and immediately before EVERY writer dispatch \(also after relocation\/repair or permitted transport re-dispatch\), call op metadata/)
    pin(dispatch, /use that fresh result for step 6's metadata-first movement decision \(no redundant metadata read\)/)
    pin(dispatch, /CLOSED\/MERGED stops first; code_head\/base drift enters restart admission/)
    pin(section(skill, "6. Recheck Head and Synthesize In-Session"), /Raw head_sha changes with unchanged code_head\/base_sha neither restart nor stop; mergeability\/CI changes are notes/)
    pin(dispatch, /Unavailable metadata.*progress\/disclosure policy and last validated identity.*step 7 and renew authorization, then repeat metadata before dispatch/)
    pin(dispatch, /After one disclosure re-freeze, dispatch with last validated identity if still unavailable; no further loop\. Rendered gaps need no byte change/)
    pin(section(skill, "6. Recheck Head and Synthesize In-Session"), /PR head check after detection uses op metadata, not only head, to observe state and base too.*validate locator, read state first; CLOSED\/MERGED → step 10 without further detection or posting\. For OPEN, compare valid code_head\/baseRefOid to this attempt's code_head\/verified base_sha/)
    pin(section(skill, "9. Map Writer Results and Relocate Unverifiable Anchors"), /head-moved \(no POST occurred\) → step 6 to re-read metadata first and apply terminal-state precedence\/restart admission/)
    pin(section(skill, "9. Map Writer Results and Relocate Unverifiable Anchors"), /Other posting failures, including unknown transport, are not drift triggers/)
    pin(section(skill, "6. Recheck Head and Synthesize In-Session"), /Writer head-moved first re-reads metadata here; unavailable\/unchanged metadata cannot authorize old bytes after that rejection: recover with progress or stop with the exact gap, never blind repost/)
  })

  test("AC6: partial coverage excludes APPROVE even via overrides and distinguishes trusted overrides from auto", () => {
    const text = section(skill, "6. Recheck Head and Synthesize In-Session")
    pin(text, /Apply delivery → coverage → trusted override → configured action/)
    pin(text, /coverage fixed partial: never APPROVE, including overrides/)
    pin(text, /absent an eligible trusted override COMMENT_ONLY maps to COMMENT, auto maps to REQUEST_CHANGES only for retained unsuppressed blocker\/critical at confidence_floor, otherwise COMMENT/)
    pin(text, /eligible trusted REQUEST_CHANGES override needs a retained unsuppressed blocker\/critical inside the partial cap but is independent of auto and confidence_floor/)
    pin(text, /Draft\/self\/identity notices remain informational/)
    pin(text, /Record every controlling rail, override fallback and low-confidence explanation/)
    pin(normalize(skill), /Keep coverage partial even with zero findings or detector errors/)
  })

  test("AC6/AC7/AC8/AC9: terminal precedence, three fresh attempts and admission refusals", () => {
    pin(section(skill, "1. Resolve Intake and Identity"), /match number\/canonical URL and read state first\. CLOSED\/MERGED → step 10 before lock acquisition, detection, candidate production or posting/)
    const movement = section(skill, "6. Recheck Head and Synthesize In-Session")
    pin(movement, /Code-head or verified base-SHA drift → invalidate this attempt's findings\/descriptor\/authorization in memory, record latest observed head\/base, then restart admission/)
    pin(movement, /Maximum three detection attempts \(initial plus two restarts\); drift after the third → step 10, no post, local notice naming latest observed head and every attempt's head/)
    pin(normalize(skill), /Restart-admission ceiling: lock age ≤ 90 min from acquisition/)
    pin(movement, /Restart admission: require step 2's fresh ownership and the bounds' restart-age ceiling; exceeding it → step 10 with lock-age refusal, not a fresh acquisition/)
    pin(movement, /Keep the held lock and invocation locator\/runId\. Use the validated metadata read that triggered this restart as this attempt's metadata; refresh context from it without another fetch\. Refresh op files \(paginate:true, include_corvus:true, names_only:true\) and op reviews/)
    pin(movement, /re-run sync op resolve with the new unfiltered inventory; unresolved\/root change → step 10 with namespace notice, never mutate a new root under the old lock/)
    pin(movement, /Use restart admission's ownership check to abort every open staging ID through persist, without a second status call; unresolved abort stops the restart with diagnostics/)
    pin(movement, /Discard findings, candidate synthesis, descriptor, preview and authorization; retained superseded artifacts are inert, not current authorization/)
    pin(movement, /Reset relocation counts, size-fit accounting, transport_repost_attempted and metadata-unavailable disclosure re-freeze allowance per attempt/)
    pin(movement, /regenerate step 3's history-only round\/marker using refreshed evidence, re-prepare head content in step 4, then re-dispatch step 5/)
    pin(movement, /No prior findings\/config from a different base\/delta are reused/)
    pin(section(skill, "3. Load Verified Config and Marker History"), /Reuse resolved config within the same base; on a moved base reload and reapply this chain/)
    pin(section(skill, "3. Load Verified Config and Marker History"), /if overlapping activity changes the returned round, use that new round and disclose the change, never carry forward an assumed round/)
    pin(section(skill, "5. Dispatch the Single Detector"), /increment and record \{attempt, code_head, base_sha\}/)
    pin(section(skill, "5. Dispatch the Single Detector"), /Detector freshly reads PR metadata\/diff\/files\/head code each attempt.*Send no earlier findings or delta evidence/)
    pin(section(skill, "7. Persist Candidate, Freeze and Preview"), /Each attempt generates a new candidate\/freeze\/preview for its own marker\/head/)
  })

  test("AC8/AC10: expired detector return and takeover fail closed before synthesis/mutation/recovery dispatch", () => {
    const namespace = section(skill, "2. Resolve Namespace and Acquire the Shared Lock")
    pin(namespace, /After successful acquire keep that lock\/runId across attempts; never reacquire or renew it/)
    pin(namespace, /call lock \{op: "status", reviewRoot: review_root\}; require a holder for the acquired path with run_id == runId, unchanged started_at, finite 0 <= age_s < 7200, and no other-run holder/)
    pin(namespace, /Missing\/expired\/other-run ownership or unverifiable status → step 10 with exact evidence, without further shared-artifact mutation or posting; no acquisition recovery after ownership loss/)
    pin(section(skill, "5. Dispatch the Single Detector"), /After every detector return, require step 2's fresh ownership before synthesis/)
    pin(section(skill, "8. Authorize and Revalidate Every Writer Dispatch"), /Require step 2's fresh ownership before dispatch, including recovery dispatches; previous status is not sufficient/)
    const cleanup = section(skill, "10. Clean Up and Summarize")
    pin(cleanup, /If this run acquired, call release once.*its owner reread preserves another run's lock even after takeover \(report not-owner, never force\/delete it\)/)
    pin(cleanup, /No acquired lock at intake → no release/)
    pin(cleanup, /identify any retained superseded artifact's producing attempt as inert, not authorized for the latest head/)
  })

  test("AC1/AC2/AC3: marker without a warning, factual coverage and unchanged minor/nitpick caps", () => {
    const text = section(skill, "6. Recheck Head and Synthesize In-Session")
    pin(text, /Render the shared marker first, followed directly by review content, without a generic reduced-coverage banner or equivalent mandatory notice/)
    pin(text, /Fitting preserves the marker first/)
    expect(skill).not.toMatch(/\[!WARNING\]|Reduced-coverage light review/)
    expect(detector).not.toMatch(/\bcoverage_notice\b/)
    pin(normalize(skill), /Light does not use the full pipeline's reviewability warning; report applicable factual limits instead/)
    pin(normalize(skill), /minor-detail cap min\(validated max_minors, 2\), max_nits: 0/)
    pin(text, /retain majors, cap minors and count overflow\.minors_counted plus additional overflow by axis without double counting/)
    pin(text, /Review limits carry only applicable factual disclosures/)
    pin(text, /intent\/head\/config\/history\/transport gaps, axis\/severity counts\/overflow/)
    pin(text, /Preserve every evidenced unsuppressed blocker\/critical independent of presentation caps/)
    pin(text, /count overflow\.minors_counted plus additional overflow by axis without double counting/)
    pin(text, /actual reviewed\/omitted scope, oversized risk-first\/full-review recommendation/)
    pin(text, /Zero findings means none found in reviewed scope, not approval/)
    pin(text, /inline count exceeds safety_rail_threshold, move overflow to its own axis body, preserving identity\/evidence and counting moved comments/)
    pin(section(skill, "7. Persist Candidate, Freeze and Preview"), /Verify marker-first content and applicable factual limits, without a mandatory coverage notice/)
    pin(normalize(detector), /Every.*untrusted data/)
    for (const field of ["security", "trigger", "impact", "introduced_by_pr", "narrow_fix", "evidence", "placement"])
      expect(detector).toMatch(new RegExp(`\\b${field}:`))
    pin(normalize(detector), /source → transforms\/guards → reachable sink, attack input and impact/)
    pin(normalize(detector), /Exclude pre-existing unrelated defects, style-only nits, speculative redesign and unsupported allegations/)
    pin(normalize(detector), /You MUST NOT.*run git fetch or update refs/)
    pin(normalize(detector), /corvus_review_pr.*permitted ops are exactly metadata\|head\|files\|diff\|reviews\|checks/)
    pin(normalize(detector), /Every Finding has:.*axis: standards\|spec.*dimension: architecture\|correctness\|conventions\|security.*confidence.*suppressed: false/)
    pin(normalize(detector), /These inline fields suffice; read.*only for unresolved schema\/label edge cases/)
  })

  test("AC3/AC4/AC7: fetch uses a verified resolved remote before the validated HTTPS fallback without checkout", () => {
    const prepare = section(skill, "4. Prepare Head Content Without Worktree Changes")
    pin(prepare, /prefer sync resolve's remote; validate.*verify git remote get-url <remote> matches validated owner\/name/)
    pin(prepare, /Otherwise inspect named git remotes for a match\. Quote the remote argument; use a matching remote for private\/SSH authentication/)
    pin(prepare, /Only with no matching remote, fall back to validated https:\/\/github\.com\/<owner>\/<name>\.git/)
    pin(prepare, /Fetch once per attempt: git fetch --no-tags <remote-or-fallback-url> pull\/<N>\/head, then git cat-file -e <code_head>\^\{commit\} with the SHA expression quoted, including every restarted code_head/)
    pin(prepare, /Only objects\/FETCH_HEAD change, not branch\/index\/worktree/)
  })

  for (const fixture of LIGHT_EVIDENCE_CASES) test(`AC4/AC10 fixture: ${fixture.name} (prompt contract, not a model-run claim)`, () => {
    const evidence = normalize(detector)
    if (fixture.mode === "pr") {
      expect(fixture.worktree_head).not.toBe(fixture.code_head)
      pin(evidence, /git show <code_head>:<path>.*gh api --method GET.*ref=<code_head>/)
      pin(evidence, /Search callers at code_head.*not worktree grep\/glob/)
      pin(evidence, /Never treat current-worktree bytes as PR-head evidence, even if its HEAD appears to match/)
      pin(evidence, /Deleted code uses base_sha\/merge_base with explicit base provenance/)
      if (fixture.head_content === "unavailable") {
        expect(fixture.pr_head_bytes).toBeNull()
        expect(fixture.diagnostic).toBeTruthy()
        pin(section(skill, "4. Prepare Head Content Without Worktree Changes"), /failed fetch or verification sets head_content: unavailable with the exact preparation diagnostic/)
        pin(evidence, /Failed head-content preparation lists affected paths as omitted scope/)
        pin(normalize(skill), /failed preparation and affected scope stay disclosed even if fallback recovers some context/)
      } else expect(fixture.pr_head_bytes).not.toBe(fixture.worktree_bytes)
    } else {
      expect(fixture.merge_base).toBe(fixture.base_sha)
      expect(fixture.merge_base).not.toBe(fixture.worktree_head)
      pin(evidence, /LOCAL instead uses read-only git diff --no-ext-diff --no-textconv <merge_base> plus worktree reads, including tracked staged and unstaged changes; disclose untracked files separately/)
      pin(evidence, /LOCAL uses worktree code and merge-base old code/)
      pin(normalize(skill), /validates repository name, head\/code_head and merge_base, sets base_sha = merge_base/)
      pin(section(skill, "8. Authorize and Revalidate Every Writer Dispatch"), /LOCAL goes directly to step 10 with local_mode and no posting authorization, writer or post attempt/)
      pin(normalize(detector), /LOCAL placements are body-only/)
    }
  })

  test("AC7/AC9/AC10: all terminal branches abort staging, delete only owned lock and disclose local artifacts", () => {
    const text = section(skill, "10. Clean Up and Summarize")
    pin(text, /On EVERY terminal branch, including closed\/merged, exhaustion, root\/lock-age refusal, ownership loss, LOCAL and failures, abort every still-open issued staging ID through persist only while step 2's fresh ownership holds; otherwise leave shared artifacts untouched and disclose outstanding IDs/)
    pin(text, /op: "release", reviewRoot: review_root, runId, mode: "delete"/)
    pin(text, /Retain \.light even when empty.*shared lock changes out of later\/overlapping full-review synchronization/)
    pin(text, /no sync pull\/push or ignore\/index mutation/)
    pin(text, /every rail\/fallback\/state notice, actual reviewed bounds and omitted scope \(local coverage disclosure; zero reviewed at intake stop\)/)
    pin(text, /Name <review_root>\/\.light\/post-request\.json or exact persistence gap.*files may appear untracked; not ignored unless you add an exclusion/)
    pin(text, /LOCAL ends with this summary and zero writer\/post attempts/)
    pin(text, /Print a compact ledger: Detection attempts: N, then one attempt N: code_head=<40-hex SHA> base_sha=<40-hex SHA> line per detection attempt, then Terminal reason: <reason>; use full lowercase 40-hex SHAs, never abbreviations\. Include latest observed head for exhausted drift, namespace\/lock-age\/ownership refusal evidence and round changes/)
    pin(text, /CLOSED\/MERGED or exhausted\/refused restart says no posting \(or no further posting if already attempted\)/)
    pin(text, /If a writer was already attempted, say no further posting and preserve its confirmed\/unknown remote truth/)
    pin(text, /If step 2 found tracked lock\.yaml and delete-mode release succeeded, report its deletion as a local working-tree change the user should not commit/)
    pin(text, /they may git restore -- <review_root>\/lock\.yaml if desired\. Never restore it yourself\. Disclose unknown tracking\/failed release, not a claimed absence of deletion/)
    pin(text, /Explicitly summarize lock held\/denied: not posted with holder\/denial evidence when applicable/)
    const steps = skill.split(/^### \d+\. /m).slice(1)
    expect(steps).toHaveLength(10)
    for (const step of steps) expect(normalize(step)).toMatch(/Done when .+\.$/)
  })
})

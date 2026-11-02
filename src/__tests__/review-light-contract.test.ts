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
const writer = readFileSync(resolve(root, "agent/pr-comment-writer.md"), "utf8")
const normalize = (text: string) => text.replace(/<!--[^]*?-->/g, "").replace(/[`*]/g, "").replace(/\s+/g, " ").trim()
// Reuse prompt-structure's fence handling: template headings are data, not boundaries.
const section = (text: string, heading: string) => {
  const rows = text.split("\n"), headings: { title: string; row: number }[] = []
  let fence = ""
  rows.forEach((line, row) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1]) fence = ""
    } else if (!fence && line.startsWith("### ")) headings.push({ title: line.slice(4), row })
  })
  const index = headings.findIndex(entry => entry.title === heading)
  expect(index, `Missing procedure section: ${heading}`).toBeGreaterThanOrEqual(0)
  if (index < 0) return ""
  return normalize(rows.slice(headings[index].row, headings[index + 1]?.row).join("\n"))
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
  test.each(["````markdown", "~~~markdown"])("procedure sections keep fenced headings inside %s", fence => {
    const marker = fence.replace("markdown", "")
    const text = ["### Render", "Before.", fence, "## Standards", "## Review limits", "- A limit.", "### Template detail", "```suggestion", "Fix.", "```", marker, "After.", "### Next", "Other."].join("\n")
    expect(section(text, "Render")).toBe(normalize(text.slice(0, text.indexOf("### Next"))))
    expect(section(text, "Next")).toBe(normalize("### Next\nOther."))
  })

  test("AC2/AC7: autonomous identity and closed two-identity roster with two distinct detector briefs", () => {
    const fm = parseFrontmatter(agent).frontmatter
    expect(fm.mode).toBe("primary")
    expect(fm.permission).toHaveProperty("question", "deny")
    const roster = [...skill.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1])
    expect(roster).toEqual(["pr-light-reviewer", "pr-comment-writer"])
    pin(normalize(skill), /pr-light-reviewer \| Concurrent read-only shards per attempt, covering Standards and Spec\/security/)
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
    pin(normalize(skill), /no todos ceremony, phase-completion markers, context-gatherer\/researcher, review-input staging, document checkpoint\/read_document, head records, meta\/facts writes, convergence compute, sync pull\/push, user-checkout changes or resumable-state reuse/)
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
    pin(normalize(skill), /await admission before fetch\/create\/detection/)
    pin(section(skill, "5. Dispatch Both Axis Briefs in One Foreground Batch"), /Dispatch ALL shards of BOTH axes as foreground literal pr-light-reviewer calls concurrently in ONE batch\/same turn, never sequentially: identical trusted attempt number\/mode\/identity/)
    const config = section(skill, "3. Load Verified Config and Marker History")
    pin(config, /ref: base_sha.*defaults → valid base values → valid trusted invocation values → fixed light mode\/sync and presentation caps/)
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
    pin(results, /Replace only their index lines.*original identity \+ ≤3 problem\/impact lines \+ one suggestion\/fix unchanged, with original path\/range; preserve other comments\/order, findings, marker\/event and notices/)
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
    pin(section(skill, "5. Dispatch Both Axis Briefs in One Foreground Batch"), /increment and record \{attempt, code_head, base_sha\}/)
    pin(section(skill, "5. Dispatch Both Axis Briefs in One Foreground Batch"), /Each detector freshly reads PR metadata\/diff\/files\/head code each attempt.*Send UNTRUSTED prior_feedback only for focus_paths plus PR-level items/)
    pin(section(skill, "7. Persist Candidate, Freeze and Preview"), /Each attempt generates a new candidate\/freeze\/preview for its own marker\/head/)
  })

  test("prior feedback informs all-hunk detection and suppresses repeats without trusting resolution flags", () => {
    pin(section(skill, "3. Load Verified Config and Marker History"), /Build UNTRUSTED prior_feedback from all prior_threads.*reuse dispositions as unknown commit evidence, never a fix oracle/)
    pin(normalize(detector), /still review the whole assigned eligible scope.*EVERY supplied item independently classify still_applies\|fixed\|not_applicable against code_head with cited evidence/)
    pin(normalize(detector), /return its prior assessment, not a duplicate new finding, for any reviewer/)
    const synthesis = section(skill, "6. Recheck Head and Synthesize In-Session")
    pin(synthesis, /Suppress every new finding matching any prior concern.*regardless of reviewer or resolution flag/)
    pin(synthesis, /one optional ## Earlier feedback after Spec and before Review limits/)
    pin(synthesis, /no-new-findings → step 10 without candidate\/authorization\/writer/)
    pin(synthesis, /Require complete history\/threads, successful eligible-hunk coverage and verified assessments/)
  })

  test("AC8/AC10: expired detector return and takeover fail closed before synthesis/mutation/recovery dispatch", () => {
    const namespace = section(skill, "2. Resolve Namespace and Acquire the Shared Lock")
    pin(namespace, /After successful acquire keep that lock\/runId across attempts; never reacquire or renew it/)
    pin(namespace, /call lock \{op: "status", reviewRoot: review_root\}; require a holder for the acquired path with run_id == runId, unchanged started_at, finite 0 <= age_s < 7200, and no other-run holder/)
    pin(namespace, /Missing\/expired\/other-run ownership or unverifiable status → step 10 with exact evidence, without further shared-artifact mutation or posting; no acquisition recovery after ownership loss/)
    pin(section(skill, "5. Dispatch Both Axis Briefs in One Foreground Batch"), /After every detector return, require step 2's fresh ownership before synthesis/)
    pin(section(skill, "8. Authorize and Revalidate Every Writer Dispatch"), /Require step 2's fresh ownership before dispatch, including recovery dispatches; previous status is not sufficient/)
    const cleanup = section(skill, "10. Clean Up and Summarize")
    pin(cleanup, /If this run acquired, call release once.*its owner reread preserves another run's lock even after takeover \(report not-owner, never force\/delete it\)/)
    pin(cleanup, /No acquired lock at intake → no release/)
    pin(cleanup, /identify any retained superseded artifact's producing attempt as inert, not authorized for the latest head/)
  })

  test("AC1/AC2/AC3: marker without a warning, factual coverage and every minor disclosed", () => {
    const text = section(skill, "6. Recheck Head and Synthesize In-Session")
    pin(text, /Render the shared marker first, followed directly by review content, without a generic reduced-coverage banner or equivalent mandatory notice/)
    pin(text, /Fitting preserves the marker first/)
    expect(skill).not.toMatch(/\[!WARNING\]|Reduced-coverage light review/)
    expect(detector).not.toMatch(/\bcoverage_notice\b/)
    pin(normalize(skill), /Light does not use the full pipeline's reviewability warning; report applicable factual limits instead/)
    pin(normalize(skill), /no minor-detail cap, max_nits: 0/)
    pin(text, /retain majors and every eligible minor with its full compact details\. Exclude nitpicks; never replace minor details with overflow counts/)
    pin(text, /Review limits carry only applicable factual disclosures in ≤3 short bullets: combine gaps\/reasons without dropping material facts; exact diagnostics stay local/)
    pin(text, /material intent\/head\/worktree\/config\/history\/transport\/brief gaps, only when present/)
    pin(text, /Preserve every evidenced unsuppressed blocker\/critical independent of presentation caps/)
    pin(normalize(detector), /Return all evidenced findings with full compact details, including every minor/)
    expect(detector).not.toMatch(/minors_counted|compacted minors/)
    pin(text, /The soft inline target guides compactness, not finding retention or anchor eligibility/)
    pin(text, /GitHub returned no patch for X; inline anchors verified from the local diff only for postable:true\/source:local/)
    pin(normalize(detector), /verified worktree reads are not object-only review/)
    pin(text, /Keep trigger\/impact\/introduced_by_pr\/narrow_fix\/evidence and complete scope\/path\/read inventories local, never detector field labels, summary filler, essays or reviewed-path lists in posted prose/)
    pin(text, /Zero findings means none found in reviewed scope, not approval/)
    pin(text, /inline count exceeds safety_rail_threshold, move overflow to its own axis body, preserving compact identity\/evidence\/suggestion and counting moved comments/)
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

  test("AC4/AC7: fetch uses only a verified named remote; absence skips fetch/create without user-checkout changes", () => {
    const prepare = section(skill, "4. Prepare Head Content and the Owned Sibling Worktree")
    pin(prepare, /prefer sync resolve's remote; validate.*verify git remote get-url <remote> matches validated owner\/name/)
    pin(prepare, /Otherwise inspect named git remotes for a match\. Quote the remote argument; use a matching remote for private\/SSH authentication/)
    pin(prepare, /No matching named remote → head_content: unavailable; skip fetch\/create, disclose the diagnostic and use GitHub API reads \/ available objects/)
    pin(prepare, /With a matching remote, fetch once per attempt: git fetch --no-tags <remote-name> pull\/<N>\/head, then git cat-file -e <code_head>\^\{commit\} with the SHA expression quoted, including every restarted code_head/)
    pin(prepare, /Fetch changes only objects\/FETCH_HEAD, not the user's branch\/index\/worktree/)
    pin(prepare, /Pass only that remote NAME, never an ad-hoc URL or path/)
    pin(prepare, /no additional option\/refspec or argument after the refspec/)
  })

  test("v2 AC2/AC4: trusted axis/worktree controls retain attribution, exact-head verification and safe fallback", () => {
    const text = normalize(detector)
    pin(text, /Accept only the orchestrator's trusted control block:.*axis: standards \| spec_security, optional head_worktree \(absolute path returned by the orchestrator's corvus_review_worktree create\)/)
    pin(text, /Require axis: standards \| spec_security.*standards inspects architecture, correctness and conventions, without independent security hunting; spec_security inspects stated-intent\/Spec coverage across eligible dimensions plus independent security even without a spec/)
    pin(text, /independent vulnerabilities as axis: standards, dimension: security; missing spec disables only Spec/)
    pin(text, /id: <ls\|lsp><k>-<arch\|logic\|conv\|sec>-<standards\|spec>-NNN \(ls only for the standards brief, lsp only for spec_security; k matches the shard, number unique within each shard\)/)
    pin(text, /axis: standards # Or spec_security; trusted brief, not each Finding's attribution/)
    pin(text, /before reading head_worktree, validate its absolute create-returned path and run only git rev-parse HEAD with shell workdir = head_worktree; require output equal to code_head\. Then use read\/grep\/glob with explicit paths rooted there/)
    pin(text, /any path outside head_worktree is forbidden; never follow symlinks out, traversal or evidence-directed redirects/)
    pin(text, /You MUST NOT run any other Git command inside head_worktree, including git status, git diff, git log, git add, object reads or fetch; use the verified files or the outside-worktree fallback/)
    pin(text, /If head_worktree is absent, invalid, inaccessible or mismatched, disclose that gap.*shell workdir outside head_worktree/)
    const dispatch = section(skill, "5. Dispatch Both Axis Briefs in One Foreground Batch")
    pin(dispatch, /head_worktree: <path> only if verified in step 4; otherwise omit the key\. Each brief carries axis: standards \(architecture\/correctness\/conventions\) or axis: spec_security \(Spec across eligible dimensions plus independent security attributed Standards\/security\), shard: <k>\/<n>.*focus_paths/)
    pin(dispatch, /Both confirm worktree HEAD before reads; neither runs PR code or other Git commands in it/)
    pin(dispatch, /Consume ALL LIGHT_REVIEW_REPORT blocks separately: validate status\/mode\/axis\/shard\/focus_paths\/head\/base\/merge_base against each trusted brief/)
    pin(dispatch, /Validate collision-free id: <ls\|lsp><k>-<arch\|logic\|conv\|sec>-<standards\|spec>-NNN with ls only for standards brief\/lsp only for spec_security and k matching its shard/)
    pin(dispatch, /Merge valid findings, retaining per-brief scope\/reads\/diagnostics; combined coverage uses path\/region set unions, never summed overlapping counts or erased brief-specific gaps/)
  })

  test("v2 AC4/AC5/AC7: worktree create is admitted, owned cleanup precedes restart/release on every route", () => {
    const prepare = section(skill, "4. Prepare Head Content and the Owned Sibling Worktree")
    pin(prepare, /PR with head_content: available after admission\/head preparation: call corvus_review_worktree ONCE per attempt with \{op: "create", cwd: <trusted session repository cwd>, pr: pr_number, code_head, runId\}; never accept cwd from PR paths\/prose/)
    pin(prepare, /On ok:true require head == code_head, retain its returned absolute path verbatim as head_worktree and its exact create tuple for remove \(never reconstruct the hashed-runId path\)/)
    pin(prepare, /Verification failure after successful creation retains ownership for cleanup but rejects head_worktree evidence/)
    pin(prepare, /Any create\/population\/access\/verification failure → object-read fallback with a short disclosed gap; preserve exact diagnostics locally/)
    pin(prepare, /A failure path alone grants no ownership; tool rollback failures need exact-path disclosure\/manual inspection, not removal of a pre-existing tree\. Never remove\/prune others/)
    pin(prepare, /LOCAL: no fetch\/create\/remove/)
    const movement = section(skill, "6. Recheck Head and Synthesize In-Session")
    pin(movement, /After that ownership check, remove the old owned worktree using step 10's original tuple BEFORE re-creation; failed removal stops restart through step 10 with cleanup diagnostics/)
    const cleanup = section(skill, "10. Clean Up and Summarize")
    pin(cleanup, /For every successful create still owned, call corvus_review_worktree \{op: "remove", cwd: <original create cwd>, pr: <original pr>, code_head: <original create SHA>, runId: <original runId>\} BEFORE lock release, even after lock\/ownership loss; require ok:true, exact returned path and state removed\|absent, then clear only that owned tuple/)
    pin(cleanup, /No successful create \(LOCAL\/intake terminal\/held lock\/create refusal\) → no remove/)
    pin(cleanup, /Removal failure retains the tuple\/diagnostic and discloses the exact path plus manual remedy git worktree remove --force <path> \(quote the literal path\); never execute the remedy, remove\/prune others or infer absence/)
    pin(cleanup, /If this run acquired, call release once.*AFTER the owned removal outcome/)
    pin(cleanup, /Retain each brief's assessment\/strategy\/coverage and complete scope\/evidence-read inventories with per-attempt create tuple; name stale preexisting_corvus_worktrees paths with the manual remedy above \(delete \+ git worktree prune if unregistered\)/)
    pin(cleanup, /ONLY literal date -u \+%Y-%m-%dT%H:%M:%SZ.*otherwise unmeasured; never invent savings/)
  })

  test("v2 AC1/AC6/AC7: sole literal rendering is compact, inline-first and marker-led without anchor widening", () => {
    const synthesis = section(skill, "6. Recheck Head and Synthesize In-Session")
    // Extract the owning template, never author a competing presentation fixture.
    const templates = [...skill.matchAll(/````markdown\n([^]*?)\n````/g)]
    expect(templates).toHaveLength(1)
    const template = normalize(templates[0]?.[1] ?? "")
    pin(template, /^<marker> ## Corvus Light Review — #<N> <PR title>/)
    pin(template, /<COMMENT\|REQUEST_CHANGES> · <sha7> · <files> files, \+<additions>\/−<deletions> · Standards <n> · Spec <n> · inline <i>/)
    pin(template, /## Standards <one-sentence assessment headline> · <counts by severity word, e\.g\. 1 major>.*## Spec <one-sentence assessment headline> · <counts by severity word, e\.g\. 1 major>/)
    expect(template.match(/- <severity> · \[<path>:<line>\]\(https:\/\/github\.com\/<owner>\/<name>\/pull\/<N>\/files#<diff_anchor>R<line>\) — <title>/g)).toHaveLength(2)
    for (const axis of ["standards", "spec"])
      pin(template, new RegExp(`<severity> \\(${axis}/<dimension>, <id>\\): <title> <path>:<line> — <≤3 short source lines of problem/impact> <one suggestion block \\(≤~8 lines\\) or one-sentence fix>`))
    pin(synthesis, /Separate consecutive body-only findings with a blank line\./)
    pin(template, / ## Review limits - <approach\/rationale only when not all diff files, or anything omitted\/unavailable>/)
    const limits = template.slice(template.indexOf(" ## Review limits") + 1)
    expect(limits.split(" - ").slice(1)).toHaveLength(3)
    pin(synthesis, /Derive each axis's one-sentence headline from valid findings, not copied detector summaries; zero findings uses No actionable findings in reviewed scope\./)
    pin(synthesis, /Inline body = the same <severity> \(<axis>\/<dimension>, <id>\): <title> identity line \+ ≤3 short problem\/impact lines \+ one suggestion\/fix \(suggestion blocks ≤~8 lines\); location lives in the anchor/)
    pin(synthesis, /Inline-first for detector-supplied evidenced RIGHT placements, passed through EXACTLY: never widen, shrink, shift, invent or derive spans from line_start\/line_end/)
    pin(synthesis, /inline findings have only a linked index in the body, not duplicated detail/)
    pin(synthesis, /Render <severity> as Finding\.label's schema word: blocker\/critical\/major\/minor\/praise\/thought\/note; use the same words for axis counts, exclude nitpicks/)
    pin(synthesis, /Counts include retained visible body \+ inline findings once\./)
    pin(normalize(detector), /body is ≤3 short source lines of problem \+ impact, without headings or Trigger:\/Impact: labels/)
    pin(normalize(detector), /summary is one sentence local to this brief's axis work, not for posting verbatim/)
    const history = section(skill, "3. Load Verified Config and Marker History")
    // normalize removes the hidden marker itself, so pin its tokens after stripping
    // only the HTML delimiters; comments elsewhere cannot satisfy these guards.
    const markers = normalize(skill.replace(/<!-- (corvus-review [^\n]*?) -->/g, "$1"))
    pin(markers, /Marker: corvus-review v2 path=<root> head=<code_head> round=<n>/)
    pin(markers, /Unknown round → corvus-review v1 head:<code_head>, disclose gap, never invent n/)
    pin(history, /resolved root without trailing slash, positive safe integer tool round n/)
    const anchors = section(writer, "3. Validate Inline Locations")
    pin(anchors, /Call corvus_review_pr op files with \{owner, name, pr, paginate: true, anchors: <comment path\/line\/start_line controls>\} as the primary anchor verification path; batch at most 50 anchors per call and omit paths so no patches are returned/)
    pin(anchors, /Match every returned anchor's path\/line\/start_line exactly.*require postable:true and complete_pagination:true/)
    pin(anchors, /Any false\/missing result.*unverifiable, never guessed.*R5's relocation.*Retain the artifact unchanged/)
  })

  for (const fixture of LIGHT_EVIDENCE_CASES) test(`AC4/AC10 fixture: ${fixture.name} (prompt contract, not a model-run claim)`, () => {
    const evidence = normalize(detector)
    if (fixture.mode === "pr") {
      expect(fixture.worktree_head).not.toBe(fixture.code_head)
      pin(evidence, /git show <code_head>:<path>.*gh api --method GET.*ref=<code_head>/)
      pin(evidence, /Then use read\/grep\/glob with explicit paths rooted there.*use git show <code_head>:<path> and read-only git grep <literal-symbol> <code_head> -- <literal-pathspec> from prepared objects with shell workdir outside head_worktree/)
      pin(evidence, /Never treat current-worktree bytes as PR-head evidence, even if its HEAD appears to match/)
      pin(evidence, /Deleted code uses base_sha\/merge_base with explicit base provenance/)
      if (fixture.head_content === "unavailable") {
        expect(fixture.pr_head_bytes).toBeNull()
        expect(fixture.diagnostic).toBeTruthy()
        pin(section(skill, "4. Prepare Head Content and the Owned Sibling Worktree"), /failed fetch or verification sets head_content: unavailable with the exact preparation diagnostic/)
        pin(evidence, /Failed head-content preparation lists affected paths as unavailable scope/)
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
    pin(text, /On EVERY terminal branch, including no-new-findings, posted, posting failure, closed\/merged after creation, exhaustion, root\/lock-age refusal, lock\/ownership loss, LOCAL and failures, abort every still-open issued staging ID through persist only while step 2's fresh ownership holds; otherwise leave shared artifacts untouched and disclose outstanding IDs/)
    pin(text, /op: "release", reviewRoot: review_root, runId, mode: "delete"/)
    pin(text, /Retain \.light even when empty.*shared lock changes out of later\/overlapping full-review synchronization/)
    pin(text, /no sync pull\/push or ignore\/index mutation/)
    pin(text, /every rail\/fallback\/state notice, Actual coverage: <approach>; reviewed <n> of <m> files \(<lines> changed lines\); omitted <k>; unavailable <u>/)
    pin(text, /n\/m\/k\/u are reviewed\/discovered\/omitted\/unavailable distinct-file counts; partial paths can overlap; unknown counts null/)
    pin(text, /Include omitted\/unavailable paths\/regions and reasons; at intake stop use approach not assessed, zero reviewed and null undiscovered counts/)
    pin(text, /Name <review_root>\/\.light\/post-request\.json or exact persistence gap.*files may appear untracked; not ignored unless you add an exclusion/)
    pin(text, /LOCAL ends with this summary and zero writer\/post attempts/)
    pin(text, /Print a compact ledger: Detection attempts: N, then one attempt N: code_head=<40-hex> base_sha=<40-hex> worktree=<path\|none> cleanup=<removed\|absent\|failed\|not-created> line per detection attempt, then Terminal reason: <reason>; use full lowercase 40-hex SHAs, never abbreviations\. Use none\/not-created when no worktree was created\. Include latest observed head for exhausted drift, namespace\/lock-age\/ownership refusal evidence and round changes/)
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

// These AC labels refer to the adaptive-scope plan; the existing group above
// retains the preceding light/restart plan's labels and unchanged safety pins.
describe("adaptive light scope contracts", () => {
  test("shards cover the trusted inventory per axis, restart afresh and merge without erasing gaps", () => {
    const dispatch = section(skill, "5. Dispatch Both Axis Briefs in One Foreground Batch")
    pin(dispatch, /Plan shards from the trusted changed-file inventory.*names and per-file sizes only if carried by names-only files\/metadata; current names-only output has names, not sizes\. The parent reads no untrusted code/)
    pin(dispatch, /Use one shard per axis when the whole diff is comfortably reviewable in one pass; otherwise partition into cohesive directory\/module groups, tests beside their code and docs together, each comfortably reviewable/)
    pin(dispatch, /Assign every changed file to exactly one shard per axis; use judgment, no fixed numeric caps or time limits\. Re-plan on every restarted head/)
    const synthesis = section(skill, "6. Recheck Head and Synthesize In-Session")
    pin(synthesis, /Union findings per axis\. Deduplicate exact shard copies: same path, overlapping lines, same dimension\/title intent; keep higher severity\/confidence and first ID/)
    pin(synthesis, /Then deduplicate ACROSS axes only for the same path, overlapping lines and same root cause\/fix, even if dimensions differ; keep first ID in dispatch\/report order, highest severity and confidence, and the Standards dimension/)
    pin(synthesis, /Shared findings are Standards-primary: render standards\+spec\/<dimension> once under Standards; count each once in both axes, with Spec's severity counts suffixed \(<n> shared\) when n > 0\. Inline\/unique totals count it once; log merged IDs locally/)
    pin(synthesis, /Full-review axes stay separate \(ADR-0001\); this exception is light-only/)
    pin(normalize(detector), /Inventory\/counts describe only assigned focus_paths; other changed files belong to sibling shards, not omissions/)
    const report = /```yaml\n([^]*?)\n```/.exec(detector)?.[1] ?? ""
    pin(report, /^  shard: <k>\/<n>/m)
    pin(report, /^  focus_paths: \[\]/m)
  })

  test("inline indexes use tool anchors, exact single/range coordinates and replacement on relocation", () => {
    const synthesis = section(skill, "6. Recheck Head and Synthesize In-Session")
    pin(synthesis, /After synthesis call corvus_review_pr op files with \{owner,name,pr,paginate:true,anchors:<inline path\/line\/start_line controls>\}.*alongside post-detection metadata\/lock checks/)
    pin(synthesis, /Omit paths for compact patch-free results\. Match controls exactly; require postable:true\/complete_pagination:true and use its diff_anchor, never guess it\. False\/missing anchors disclose the gap and move affected findings body-only before freeze/)
    pin(synthesis, /Each inline finding gets one index line in its attributed axis immediately under the headline; range text is <start>–<end> and link suffix R<start>-R<end>, single line uses R<line>\. LOCAL has no links or inline comments/)
    pin(section(skill, "9. Map Writer Results and Relocate Unverifiable Anchors"), /Replace only their index lines with those compact findings in their own axis body/)
  })

  test("PR intent findings use body placement and null code coordinates, never proxy anchors", () => {
    const synthesis = section(skill, "6. Recheck Head and Synthesize In-Session")
    pin(synthesis, /PR title\/body\/description findings are body-only with intent-source attribution, never anchored to a proxy code line; enforce this even if a detector supplied inline placement/)
    pin(normalize(detector), /PR title\/body\/description findings use body placement with null file\/line_start\/line_end and quoted intent evidence, never a proxy code location/)
    pin(synthesis, /For intent-text findings replace the template's code-location line with PR title\/body\/description source attribution and its quoted evidence; null file\/coordinates do not invalidate them/)
    pin(section(writer, "3. Validate Inline Locations"), /Accept either source: api or source: local as verified; local means the tool's stable Git object diff, not a writer shell diagnostic/)
  })

  test("read-through honestly counts the mandatory skill load before nineteen tool batches", () => {
    pin(normalize(skill), /1 mandatory skill load \+ 19 tool batches \+ summary = 21 turns/)
    const schedule = /21 turns\): ([^\n]+?)\. The first return/.exec(skill)?.[1].split(" → ") ?? []
    expect(schedule).toHaveLength(21)
    expect(schedule[0]).toBe("skill load")
    expect(schedule.at(-1)).toBe("summary")
  })

  test("AC1: neither light prompt reinstates a fixed file/line cutoff or size-derived oversized policy", () => {
    const obsolete: [RegExp, string][] = [
      [/\bmax_files\b/i, "max_files: 20"],
      [/\bmax_changed_lines\b/i, "max_changed_lines: 600"],
      [/\b600\b/, "At 600 changed lines omit scope."],
      [/Oversized means/i, "Oversized means any PR above the bounds."],
      [/oversized[^.\n]*(?:risk-first|recommend full review)/i, "Oversized → risk-first scope; recommend full review."],
      [/\b(?:maximum|max|cap|limit)\s*[:=]?\s*\d+\s*(?:changed[- ]lines|files)\b/i, "Maximum 30 files."],
      [/\b\d+[- ](?:file|changed[- ]line)\s+(?:maximum|cap|limit|cutoff)\b/i, "Use a 40-file cutoff."],
    ]
    for (const [name, prompt] of [["skill", skill], ["detector", detector]]) {
      const text = normalize(prompt)
      for (const [forbidden, seed] of obsolete) {
        expect(text, name).not.toMatch(forbidden)
        expect(text + " " + seed, name).toMatch(forbidden)
      }
    }
    pin(normalize(skill), /adaptive shards cover the diff without file\/changed-line maxima, time limits or a supplementary-read ceiling/)
    pin(normalize(detector), /size is handled by parent sharding, not omission/)
  })

  test("AC2/AC5: strategy schema exposes signals, mapped scope and a lean auditable coverage account", () => {
    const text = normalize(detector)
    pin(text, /Assess size\/complexity: files, changed lines, file types.*change concentration, risk surfaces.*PR intent.*evidence availability/)
    pin(text, /Default all_diff_files means all assigned files\/hunks; size is handled by parent sharding, not omission/)
    pin(text, /Choose one approach with a rationale: all_diff_files, risk_focus, sampled_by_area or other; mapping: all_diff_files → scope_kind all_diff_files; risk_focus\/sampled_by_area → focus_set; other → other or focus_set as stated/)
    pin(text, /Explicit scope determines actual coverage/)
    pin(text, /Reassess independently each attempt; use no prior strategy/)
    pin(text, /Within focus_paths review all eligible hunks, not just enough to fill a comment quota/)
    pin(text, /Omit only non-reviewable generated\/vendored code, lockfiles, binaries, snapshots or minified assets, with a reason/)
    pin(text, /risk_focus\/sampled_by_area are allowed only when evidence is unavailable, never because of PR size/)
    pin(text, /List every omitted path or partial-file region with its reason; distinguish unavailable evidence from deliberate scope selection/)
    const reports = [...detector.matchAll(/```yaml\n([\s\S]*?)\n```/g)]
    expect(reports).toHaveLength(1)
    const report = reports[0]?.[1] ?? ""
    pin(report, /^LIGHT_REVIEW_REPORT:\n/m)
    pin(report, /^  strategy:\n/m)
    for (const field of ["assessment", "approach", "rationale", "scope_kind", "focus_set"])
      pin(report, new RegExp(`^    ${field}:`, "m"))
    pin(report, /^    approach: all_diff_files # Or risk_focus \| sampled_by_area \| other$/m)
    pin(report, /^    scope_kind: all_diff_files # Or focus_set \| other, using the approach mapping$/m)
    pin(report, /^    assessment: \{signals: \[<observed size\/complexity signals>\]\} # Size counts live only in counts\.discovered$/m)
    pin(report, /^    focus_set: \[\] # Empty or omitted for all_diff_files; otherwise every selected inventory path$/m)
    pin(report, /^  counts: # Each scope count is \{files: <n or null>, changed_lines: <n or null>\}$/m)
    for (const field of ["discovered", "selected", "reviewed", "omitted", "unavailable"])
      pin(report, new RegExp(`^    ${field}: \\{files: <n or null>, changed_lines: <n or null>\\}$`, "m"))
    for (const field of ["inventory", "selected_scope", "reviewed_scope", "omitted_scope", "unavailable_scope", "evidence_reads"])
      pin(report, new RegExp(`^  ${field}:`, "m"))
    expect(report).not.toMatch(/^  files_(?:selected|reviewed):/m)
    pin(report, /^  selected_scope: \[\] # Empty or omitted for all_diff_files; otherwise entries: \{path, regions\}$/m)
    pin(report, /^  reviewed_scope: \[\] # Entries: \{path, regions: all_hunks or explicit old\/new changed-line ranges\}$/m)
    expect(report).not.toMatch(/^  bounds:/m)
    pin(text, /partial paths can overlap categories, so reconcile their path union with inventory rather than adding file counts/)
    pin(text, /Reviewed\/omitted\/unavailable changed-line regions partition discovered hunks without double counting; context-only gaps carry no changed lines and stay disclosed/)
    pin(text, /Selected scope contains reviewed scope and may contain unavailable regions/)
    pin(text, /For all_diff_files with complete inventory and no inventory omissions\/unavailability, selected = reviewed = discovered counts, reviewed_scope covers each inventory path with regions: all_hunks, and omitted\/unavailable counts are zero/)
    pin(text, /all_diff_files selects every inventory path\/hunk implicitly, otherwise focus_set equals selected_scope paths and is within inventory/)
    pin(text, /Use regions: all_hunks for fully covered files in any scope list/)
    pin(text, /Null-path global omissions, including \.corvus exclusions, stay disclosed outside inventory reconciliation and scope counts/)
    pin(text, /Use null for unknown counts, not guessed totals, and disclose incomplete inventory\/global gaps/)
  })

  test("AC3: light size config is advice only and leaves full-pipeline semantics unchanged", () => {
    pin(section(skill, "3. Load Verified Config and Marker History"), /large_pr_threshold\/large_pr_strategy are labelled advisory size settings for the detector only: never a cutoff, forced omission or no-post rule; full-pipeline semantics stay unchanged/)
    pin(section(skill, "5. Dispatch Both Axis Briefs in One Foreground Batch"), /advisory_size_settings:\{large_pr_threshold,large_pr_strategy\} labelled advice only/)
    pin(normalize(detector), /Accept large_pr_threshold\/large_pr_strategy only as labelled advice, never a cutoff, forced omission or no-post rule/)
  })

  test("AC3: supplementary reads use soft strategy guidance, no control or report ceiling", () => {
    pin(normalize(skill), /adaptive shards cover the diff without file\/changed-line maxima, time limits or a supplementary-read ceiling/)
    for (const prompt of [skill, detector]) {
      const controls = normalize(prompt)
      expect(controls).not.toMatch(/\b(?:max_targeted_reads|read_budget)\b/)
      for (const seed of ["max_targeted_reads: 8", "read_budget: 8"])
        expect(normalize(prompt + " " + seed)).toMatch(/\b(?:max_targeted_reads|read_budget)\b/)
    }
    const text = normalize(detector)
    pin(text, /Stop supplementary investigation when further reads have low expected value for a light pass, not at a numeric ceiling; retain relevant regions and disclose unresolved context/)
    pin(text, /Allocate targeted enclosing-code, caller, test and standards reads by the chosen strategy/)
    pin(text, /Record each beyond-diff enclosing-code\/caller\/test\/standards\/issue read in evidence_reads, including failed attempts/)
    pin(text, /inventory\/diff\/per-file patch retrieval and contract\/reference reads are not supplementary evidence reads/)
    pin(text, /This inline contract suffices, so read source links only for an unresolved schema\/calibration edge case/)
    pin(text, /evidence_reads lists exactly the counted beyond-diff attempts, including failures; targeted_reads equals its length, with no read ceiling/)
  })

  test("AC6: transport truncation falls back per file, then discloses unavailable evidence rather than judging size", () => {
    pin(normalize(detector), /Diff truncation \(512,000-byte transport limit, oversized:true or HTTP 406\/413\) uses per-file files patches as fallback, optionally with a paths filter; incomplete pagination, absent patches and inaccessible regions remain unavailable evidence gaps, not an automatic size judgment/)
    pin(normalize(detector), /Exclude \.corvus\/ as the default PR tools do; disclose the exclusion as a null-path global omission outside inventory reconciliation/)
    pin(normalize(detector), /Done when every discovered changed path has hunks or a named evidence gap, with counts unknown rather than invented where retrieval is incomplete/)
  })

  test("AC7: consistency validation retains valid evidence and discloses gaps, never a repair detector pass", () => {
    const text = section(skill, "5. Dispatch Both Axis Briefs in One Foreground Batch")
    pin(text, /each attempt assesses and selects its strategy afresh/)
    pin(text, /then identity\/strategy\/counts\/coverage without file\/line maxima or parent code analysis/)
    pin(text, /Require assessment signals, an allowed approach \(all_diff_files\|risk_focus\|sampled_by_area\|other\), non-empty rationale and scope_kind/)
    pin(text, /Check mapping: all_diff_files → scope_kind all_diff_files; risk_focus\/sampled_by_area → focus_set; other → other or focus_set as stated/)
    pin(text, /Validate each inventory against its assigned focus_paths and intake with disclosed filtering\/retrieval gaps; \.corvus exclusions are null-path global omissions outside inventory reconciliation and scope counts/)
    pin(text, /All-diff scope selects every assigned inventory path\/hunk implicitly; focus_set\/selected_scope are empty or omitted\. Otherwise focus_set ⊆ inventory and equals selected_scope paths/)
    pin(text, /Reviewed scope lies within selected scope; regions: all_hunks means every discovered hunk of that path/)
    pin(text, /discovered\/selected\/reviewed\/omitted\/unavailable counts \(non-negative integers or null for unknown\) matching their scope; incomplete evidence stays null\/disclosed/)
    pin(text, /For all_diff_files with complete inventory and no inventory omissions\/unavailability, selected = reviewed = discovered counts, reviewed_scope covers each inventory path with all_hunks, and omitted\/unavailable counts are zero/)
    pin(text, /Otherwise reviewed\/omitted\/unavailable path union reconciles with inventory \(partial paths may overlap\); their changed-line regions partition discovered hunks without double counting/)
    pin(text, /Context-only gaps carry no changed lines; null-path global omissions stay outside reconciliation\/counts/)
    pin(text, /targeted_reads is a non-negative integer and equals evidence_reads.length, including failed attempts/)
    pin(text, /Validate actual coverage from scope fields, not approach labels alone/)
    pin(text, /Inconsistent\/invalid\/error\/truncated output retains independently valid evidence\/gaps, never retargets or reruns detection merely to repair a report/)
    pin(text, /A failed\/invalid shard keeps the others' evidence and adds one Review-limits gap naming its uncovered focus_paths; unknown coverage stays null, no rerun\. Only step 6's movement decision admits another attempt, re-dispatching all shards/)
  })

  test("AC8: strategy-line trigger is protocol-pinned and full-review advice depends only on AQ6 risks/gaps/complexity", () => {
    const text = section(skill, "6. Recheck Head and Synthesize In-Session")
    pin(text, /approach\/rationale only when not all diff files, or anything omitted\/unavailable/)
    pin(text, /Recommend full review only for consequential uncovered risk, material evidence gaps or complexity needing deeper coverage, naming the specific reason, never size or omission alone/)
    pin(normalize(detector), /full-review recommendation only for consequential uncovered risk, material evidence gaps or complexity needing deeper coverage, with the specific reason/)
    pin(text, /Zero findings means none found in reviewed scope, not approval or complete coverage/)
  })

  /** Oracle: the skill's sole literal step-10 coverage template and the checker's
   * actual light coverage/action predicate, read before substitutions. Missing
   * templates/predicates or a non-matching rendered phrase fail unconditionally;
   * no rollout flag disables this pin. This checks regex compatibility, not a
   * model run or semantic count validation; the checker accepts a broad disclosure. */
  test("AC8/AC10: the literal step-10 coverage phrase matches the checker's light summary regex", () => {
    const cleanup = section(skill, "10. Clean Up and Summarize")
    const templates = [...cleanup.matchAll(/Actual coverage: <approach>[^>]*<n>[^>]*<m>[^>]*<lines>[^>]*<k>[^>]*<u>/g)]
    expect(templates).toHaveLength(1)
    const template = templates[0]?.[0] ?? ""
    expect(template).toBe("Actual coverage: <approach>; reviewed <n> of <m> files (<lines> changed lines); omitted <k>; unavailable <u>")
    const source = readFileSync(resolve(root, "scripts/check-review-artifacts.ts"), "utf8")
    const start = source.indexOf('add("light coverage/action",')
    expect(start).toBeGreaterThanOrEqual(0)
    const predicate = source.slice(start, source.indexOf("\n  if (local)", start))
      .match(/&& \/([^\n]+)\/([a-z]*)\.test\(summary\) && \/untracked\//)
    expect(predicate).not.toBeNull()
    if (!predicate) return
    const summaryRegex = new RegExp(predicate[1], predicate[2])
    for (const values of [
      ["all_diff_files", "45", "45", "1700", "0", "0"],
      ["risk_focus", "12", "45", "920", "32", "1"],
      ["sampled_by_area", "9", "80", "null", "71", "0"],
      ["other", "3", "null", "120", "null", "null"],
      ["not assessed", "0", "null", "null", "null", "null"],
    ]) {
      let rendered = template
      for (const [index, token] of ["approach", "n", "m", "lines", "k", "u"].entries())
        rendered = rendered.replace(`<${token}>`, values[index])
      expect(rendered).not.toMatch(/<[^>]+>/)
      expect(rendered).toMatch(summaryRegex)
    }
    expect("Reduced-coverage light review").not.toMatch(summaryRegex)
  })

  test("AC11: adaptive instructions stay within their prompt budgets", () => {
    const countLines = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length
    expect(countLines(skill)).toBeLessThanOrEqual(150)
    expect(countLines(detector)).toBeLessThanOrEqual(200)
  })

  test("T12: no light skill line exceeds the read tool's 2,000-character cap", () => {
    const overlong = (text: string) => text.split(/\r?\n/).flatMap((line, index) =>
      Buffer.byteLength(line, "utf8") > 2000 ? [index + 1] : [])
    expect(overlong(skill)).toEqual([])
    expect(overlong("x".repeat(2000))).toEqual([])
    expect(overlong("x".repeat(2001))).toEqual([1])
    // Byte length is deliberately stricter than character length for tool safety.
    expect(overlong("é".repeat(1001))).toEqual([1])
  })
})

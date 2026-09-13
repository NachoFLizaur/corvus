import * as nodeFs from "node:fs"
import { basename, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import yaml from "js-yaml"
import { localReviewNamespace, read_document, read_facts, resolveReviewDirectory, ReviewDirectoryError, writeVerdictRecord, type PersistOptions } from "./review-persist"
import type { PrData, PrResult } from "./review-pr"
import { parseReviewMarker } from "./review-pr"

const AXES = ["standards", "spec"] as const
const DIMENSIONS = ["architecture", "correctness", "conventions", "security"] as const
const LABELS = ["blocker", "critical", "major", "minor", "nitpick", "praise", "thought", "note"] as const
const ORIGINS = ["pr-code", "review-fix"] as const
type Axis = typeof AXES[number]
type Label = typeof LABELS[number]
type Origin = typeof ORIGINS[number]
export type LabelCounts = Record<Label, number>
export type VerdictCounts = Record<Axis, LabelCounts> & {
  total: LabelCounts
  actionable_total: number
  by_origin: Record<Origin, Record<Axis, LabelCounts> & { total: LabelCounts }>
}
export type VerdictInput = {
  reviewRoot: string
  headSha?: string
  code_head?: string
  owner?: string
  name?: string
  pr?: number | null
  branch?: string
  legacy_root?: string
  priorReviews: PrResult<PrData["reviews"]>
  config: { max_nits?: number; max_minors?: number; [key: string]: unknown }
  forceDelta?: boolean
}
export type VerdictOptions = PersistOptions & { fs?: PersistOptions["fs"] & { readdirSync(path: string): string[] } }
export type HistoryVerdict = { ok: true; round: number; refuse_delta: boolean; refuse_reason?: string; missing_history: boolean }
export type DocumentVerdict = HistoryVerdict & {
  counts: VerdictCounts
  caps_applied: { max_nits: number; max_minors: number; totals: { minor: number; nitpick: number } }
  converged: boolean
  convergence_reason?: string
}
export type VerdictResult = HistoryVerdict | (DocumentVerdict & { persisted: string }) | { ok: false; reason: string }
type RecordValue = Record<string, unknown>
type Finding = RecordValue & { id: string; axis: Axis; label: Label; origin: Origin; suppressed: boolean }
type Evidence = { document: RecordValue; counts: VerdictCounts; full: boolean }
type Round = { round: number; head: string; evidence?: Evidence; time?: string; id?: number }
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value)
const integer = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const sha = (value: unknown): value is string => typeof value === "string" && value.length === 40 && /^[a-f0-9]{40}$/.test(value)
class VerdictError extends Error {}
const fail = (reason: string): never => { throw new VerdictError(reason) }
const mapping = (value: unknown): RecordValue => record(value) ? value : fail("invalid-document")
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : fail("invalid-document")
const zero = (): LabelCounts => ({ blocker: 0, critical: 0, major: 0, minor: 0, nitpick: 0, praise: 0, thought: 0, note: 0 })
const axisCounts = () => ({ standards: zero(), spec: zero(), total: zero() })

/** Plain JSON descriptors are checked before reads; accessors/cycles reject for every caller, without a bypass. */
function snapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || ancestors.has(value) || Object.getOwnPropertySymbols(value).length) return fail("invalid-arguments")
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail("invalid-arguments")
  const keys = Object.keys(value)
  if (Array.isArray(value) && (keys.length !== value.length || keys.some((key, i) => key !== String(i)))) return fail("invalid-arguments")
  ancestors.add(value)
  const entries = keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!("value" in descriptor)) return fail("invalid-arguments")
    return [key, snapshot(descriptor.value, ancestors)] as const
  })
  ancestors.delete(value)
  return Array.isArray(value) ? entries.map(([, item]) => item) : Object.fromEntries(entries)
}

function finding(value: unknown): Finding {
  const item = mapping(value)
  if (!text(item.id) || !AXES.includes(item.axis as Axis) || !ORIGINS.includes(item.origin as Origin)
    || !LABELS.includes(item.label as Label) || !DIMENSIONS.includes(item.dimension as typeof DIMENSIONS[number])
    || item.pass !== item.dimension || typeof item.suppressed !== "boolean"
    || item.severity !== ({ blocker: 5, critical: 4, major: 3, minor: 2, nitpick: 1, praise: 0, thought: 0, note: 0 }[item.label as Label])
    || !text(item.file) || !integer(item.line_start, 1) || !(item.line_end === null || integer(item.line_end, item.line_start))
    || !text(item.title) || !text(item.body) || !(item.suggestion === null || typeof item.suggestion === "string")
    || typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1
    || !Array.isArray(item.related_to) || !item.related_to.every(text)) return fail("invalid-finding")
  return item as Finding
}

function countFindings(findings: Finding[]): VerdictCounts {
  const counts: VerdictCounts = { ...axisCounts(), actionable_total: 0, by_origin: { "pr-code": axisCounts(), "review-fix": axisCounts() } }
  const ids = new Set<string>()
  for (const item of findings) {
    if (ids.has(item.id)) return fail("duplicate-finding")
    ids.add(item.id)
    if (item.suppressed) continue
    counts[item.axis][item.label]++
    counts.total[item.label]++
    counts.by_origin[item.origin][item.axis][item.label]++
    counts.by_origin[item.origin].total[item.label]++
    if (["blocker", "critical", "major", "minor"].includes(item.label)) counts.actionable_total++
  }
  return counts
}

function parseCheckpoint(input: Extract<ReturnType<typeof read_document>, { ok: true }>): RecordValue {
  const candidates: RecordValue[] = []
  const accept = (source: string, direct = false) => {
    const value: unknown = snapshot(yaml.load(source, { schema: yaml.JSON_SCHEMA }))
    if (record(value) && Object.hasOwn(value, "REVIEW_DOCUMENT")) candidates.push(mapping(value.REVIEW_DOCUMENT))
    else if (direct && record(value) && Object.hasOwn(value, "source_findings")) candidates.push(value)
  }
  if (input.frontmatterYaml !== null) accept(input.frontmatterYaml, true)
  for (const section of input.sections) {
    let fence: { marker: string; length: number; yaml: boolean; lines: string[] } | undefined
    for (const line of section.body.split("\n")) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (!fence && marker) fence = { marker: marker[1][0], length: marker[1].length, yaml: /^(yaml|yml)$/i.test(marker[2].trim()), lines: [] }
      else if (fence && marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) {
        if (fence.yaml) accept(fence.lines.join("\n"), section.heading === "REVIEW_DOCUMENT")
        fence = undefined
      } else if (fence) fence.lines.push(line)
    }
  }
  if (candidates.length !== 1) return fail(candidates.length ? "ambiguous-document" : "invalid-document")
  return candidates[0]
}

function evidence(document: RecordValue, head: string, identity: Identity): Evidence {
  const controls = mapping(document.synthesis_controls)
  if (!matchesIdentity(controls, identity) || (controls.code_head ?? controls.head_sha) !== head || !sha(controls.base_sha)) return fail("document-identity-mismatch")
  const source = mapping(document.source_findings), axes = mapping(source.axis_results), projection = mapping(source.pass_results)
  if (!isDeepStrictEqual(Object.keys(axes).sort(), [...AXES].sort())) return fail("invalid-coverage")
  const sourceFindings: Finding[] = []
  const statuses: string[] = []
  let noErrors = true
  for (const map of [...AXES.map(axis => mapping(axes[axis])), projection]) {
    if (!isDeepStrictEqual(Object.keys(map).sort(), [...DIMENSIONS].sort())) return fail("invalid-coverage")
  }
  const result = (value: unknown) => {
    const item = mapping(value)
    if (!["completed", "skipped", "error"].includes(item.status as string) || !text(item.reason) || !text(item.summary)) return fail("invalid-coverage")
    const findings = list(item.findings).map(finding)
    if (item.status !== "completed" && findings.length) return fail("invalid-coverage")
    return { status: item.status, findings }
  }
  for (const dimension of DIMENSIONS) {
    const contributions = AXES.map(axis => {
      const item = result(mapping(axes[axis])[dimension])
      if (item.findings.some(f => f.axis !== axis || f.dimension !== dimension)) return fail("invalid-coverage")
      sourceFindings.push(...item.findings)
      return item
    })
    const status = contributions.some(item => item.status === "error") ? "error"
      : contributions.some(item => item.status === "completed") ? "completed" : "skipped"
    const projected = result(projection[dimension])
    if (projected.status !== status || !isDeepStrictEqual(projected.findings, status === "completed" ? contributions.flatMap(item => item.findings) : [])) return fail("invalid-projection")
    noErrors &&= contributions.every(item => item.status !== "error")
    statuses.push(status)
  }
  const reviewability = statuses.every(status => status === "completed") ? "complete"
    : statuses.some(status => status === "completed") ? "partial"
    : statuses.some(status => status === "error") ? "failed" : "skipped"
  if (document.reviewability !== reviewability) return fail("invalid-coverage")
  const raw = countFindings(sourceFindings.map(item => ({ ...item, suppressed: false }))).total
  const totals = mapping(source.totals)
  if (LABELS.some(label => totals[label] !== raw[label])) return fail("invalid-source-counts")
  const findings = list(document.findings).map(finding)
  const counts = countFindings(findings)
  const context = mapping(document.review_context)
  mapping(document.summary)
  for (const key of ["state_notices", "inline_comments", "overflow_log", "dedup_log", "filtered_log", "edit_history"]) list(document[key])
  if (!["APPROVE", "REQUEST_CHANGES", "COMMENT_ONLY"].includes(document.action as string) || !text(document.action_reasoning)
    || !["converged", "not_converged"].includes(document.verdict as string) || typeof document.overflow !== "boolean"
    || !(document.coverage_warning === null || text(document.coverage_warning)) || typeof document.review_body !== "string"
    || parseReviewMarker(document.review_body)?.head !== head) return fail("invalid-document")
  const marker = parseReviewMarker(document.review_body)!
  if (marker.path && identity.path && marker.path !== identity.path) return fail("document-identity-mismatch")
  if (marker.round !== undefined && controls.series_round !== undefined && marker.round !== controls.series_round) return fail("document-identity-mismatch")
  const full = reviewability === "complete" && noErrors && document.coverage_warning === null
    && controls.coverage_complete === true && (!Object.hasOwn(context, "coverage_gaps") || (Array.isArray(context.coverage_gaps) && context.coverage_gaps.length === 0))
  return { document, counts, full }
}

type Identity = ({ mode: "pr"; owner: string; repo: string; pr_number: number } | { mode: "local"; namespace: string }) & { path?: string }
function matchesIdentity(value: RecordValue, identity: Identity): boolean {
  if (identity.mode === "local") {
    if (value.mode !== "local" || value.pr_number !== null || typeof value.repo !== "string") return false
    const branch = value.branch === null ? value.code_head ?? value.head_sha : value.branch
    if (typeof branch !== "string") return false
    try { return localReviewNamespace(value.repo, branch) === identity.namespace } catch { return false }
  }
  return (value.repo === `${identity.owner}/${identity.repo}` || (value.owner === identity.owner && value.repo === identity.repo))
    && value.pr_number === identity.pr_number
}
function identityFromRoot(root: string): Identity {
  const namespace = basename(root)
  const local = /^local__([A-Za-z0-9._-]{1,100})__([A-Za-z0-9._-]+)$/.exec(namespace)
  if (local && local[0] === namespace && ![".", ".."].includes(local[1])) return { mode: "local", namespace }
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)__([A-Za-z0-9._-]{1,100})__pr([1-9][0-9]*)$/.exec(basename(root))
  if (!match || match[0] !== basename(root) || [".", ".."].includes(match[2]) || !integer(Number(match[3]), 1)) return fail("invalid-review-identity")
  return { mode: "pr", owner: match[1], repo: match[2], pr_number: Number(match[3]) }
}

/** New namespace identity comes from invocation fields before history reads, never PR prose or a basename's missing owner. Root/PR mismatch fails closed; legacy basenames alone retain their parser. No config field bypasses identity checks. */
function invocationIdentity(root: string, args: RecordValue): Identity {
  const name = basename(root)
  if (!/^(?:pr[1-9][0-9]*|local-.+)$/.test(name)) return identityFromRoot(root)
  const path = root.includes(".corvus/") ? root.slice(root.indexOf(".corvus/")) : undefined
  if (args.pr === null && typeof args.name === "string" && typeof args.branch === "string") {
    if (name !== `local-${args.branch.replace(/[^A-Za-z0-9._-]/g, "-")}`) return fail("invalid-review-identity")
    return { mode: "local", namespace: localReviewNamespace(args.name, args.branch), path }
  }
  if (!integer(args.pr, 1) || name !== `pr${args.pr}` || typeof args.owner !== "string" || typeof args.name !== "string") return fail("invalid-review-identity")
  return { ...identityFromRoot(`${args.owner}__${args.name}__pr${args.pr}`), path }
}

/** Contained head directories and regular metadata leaves are checked before reads; every escape/error rejects, with no mkdir or bypass. */
function metadata(root: string, head: string, opts: VerdictOptions, name: "meta.yaml" | "verdict.yaml" = "meta.yaml"): RecordValue | undefined {
  const fs = opts.fs ?? nodeFs
  try {
    const directory = resolveReviewDirectory(`${root}/${head}`, opts.reviewStateRoot, fs, false).path
    const path = resolve(directory, name)
    const stat = fs.lstatSync(path)
    if (stat.isSymbolicLink() || !fs.statSync(path).isFile()) return fail("invalid-metadata-file")
    const bytes = fs.readFileSync(path), source = bytes.toString("utf8")
    if (!Buffer.from(source).equals(bytes)) return fail("invalid-metadata")
    return mapping(snapshot(yaml.load(source, { schema: yaml.JSON_SCHEMA })))
  } catch (error) {
    if ((record(error) && error.code === "ENOENT") || (error instanceof ReviewDirectoryError && error.reason === "not-found")) return undefined
    throw error
  }
}

function loadEvidence(root: string, head: string, identity: Identity, opts: VerdictOptions): Evidence {
  const result = read_document({ reviewRoot: root, headSha: head }, opts)
  if (!result.ok) return fail(result.reason)
  return evidence(parseCheckpoint(result), head, identity)
}
const clean = (round: Round | undefined): boolean => !!round?.evidence?.full
  && ["blocker", "critical", "major"].every(label => round.evidence!.counts.total[label as Label] === 0)

/**
 * Policy: skill/corvus-review-extras/SKILL.md#convergence-and-continuation.
 * Identity-matching persisted documents/metadata, series knowledge and the complete
 * PR reviews result are the history oracle, read before any verdict write;
 * history-only calls never mutate state. Counts use retained unsuppressed findings,
 * not projection copies or model totals. Missing/contradictory history closes
 * convergence and delta admission; invalid current evidence returns an error.
 * Only the trusted invocation's forceDelta argument disables delta refusal, not
 * coverage, validation or posting rails. Config/prose cannot supply that override.
 * Local roots use the same persisted-history checks with a schema-empty complete
 * prior-review result instead of GitHub history; absent local history starts at
 * round 1. Missing/incomplete remote-shaped input still closes admission.
 * A metadata verdict_file pointer selects the tool-owned round; legacy metadata
 * supplies series_round only without that pointer. A broken pointer closes history
 * admission rather than falling back. Head computations persist their exact result
 * plus computed_at through the contained writer before success; write/readback
 * failure returns an error, never a successful unpersisted verdict.
 */
export function compute(input: VerdictInput, opts: VerdictOptions): VerdictResult {
  try {
    const args = mapping(snapshot(input))
    if (Object.keys(args).some(key => !["reviewRoot", "headSha", "code_head", "owner", "name", "pr", "branch", "legacy_root", "priorReviews", "config", "forceDelta"].includes(key))
      || typeof args.reviewRoot !== "string" || !record(args.config) || !record(args.priorReviews)
      || (Object.hasOwn(args, "headSha") && !sha(args.headSha))
      || (Object.hasOwn(args, "code_head") && !sha(args.code_head))
      || (Object.hasOwn(args, "legacy_root") && typeof args.legacy_root !== "string")
      || (Object.hasOwn(args, "forceDelta") && typeof args.forceDelta !== "boolean")) return fail("invalid-arguments")
    const root = args.reviewRoot, head = (args.code_head ?? args.headSha) as string | undefined, fs = opts.fs ?? nodeFs
    const identity = invocationIdentity(root, args)
    let directory: string | undefined
    try { directory = resolveReviewDirectory(root, opts.reviewStateRoot, fs, false).path }
    catch (error) { if (!(error instanceof ReviewDirectoryError) || error.reason !== "not-found") throw error }
    const historyRoots = [{ root, directory }]
    if (typeof args.legacy_root === "string") {
      const legacyIdentity = identityFromRoot(args.legacy_root)
      const { path: _path, ...expected } = identity
      if (!isDeepStrictEqual(legacyIdentity, expected)) return fail("invalid-review-identity")
      try { historyRoots.push({ root: args.legacy_root, directory: resolveReviewDirectory(args.legacy_root, opts.reviewStateRoot, fs, false).path }) }
      catch (error) { if (!(error instanceof ReviewDirectoryError) || error.reason !== "not-found") throw error }
    }
    const nits = args.config.max_nits ?? 3, minors = args.config.max_minors ?? 6
    if (!integer(nits) || !integer(minors, 1)) return fail("invalid-config")
    const prior = args.priorReviews
    let missing = prior.ok !== true || prior.complete_pagination !== true || prior.complete_threads !== true || !Array.isArray(prior.reviews)
    if (identity.mode === "local") {
      missing ||= [prior.reviews, prior.threads, prior.dispositions].some(items => !Array.isArray(items) || items.length !== 0)
    }
    let facts = read_facts({ reviewRoot: root }, opts)
    if (!facts.ok && facts.reason === "not-found" && typeof args.legacy_root === "string") facts = read_facts({ reviewRoot: args.legacy_root }, opts)
    if (!facts.ok && facts.reason !== "not-found") return fail(facts.reason)
    const factsMap = facts.ok ? mapping(facts.facts) : {}
    const rounds: Round[] = []
    const seenReviews = new Set<number>()
    for (const value of Array.isArray(prior.reviews) ? prior.reviews : []) {
      if (!record(value) || typeof value.body !== "string") { missing = true; continue }
      const first = value.body.split(/\r?\n/, 1)[0]
      const marker = parseReviewMarker(first)
      if (!marker) continue
      if (marker.path && identity.path && marker.path !== identity.path) { missing = true; continue }
      const reviewedHead = marker.head
      if (identity.mode === "local" || !integer(value.id, 1) || seenReviews.has(value.id) || (!marker.path && value.commit_id !== reviewedHead) || !sha(value.commit_id)
        || !text(value.submitted_at) || !Number.isFinite(Date.parse(value.submitted_at))
        || !text(value.html_url) || !value.html_url.startsWith(`https://github.com/${identity.owner}/${identity.repo}/pull/${identity.pr_number}#`)) {
        missing = true; continue
      }
      seenReviews.add(value.id)
      rounds.push({ round: marker.round ?? 0, head: reviewedHead, time: value.submitted_at, id: value.id })
    }
    rounds.sort((a, b) => Date.parse(a.time!) - Date.parse(b.time!) || a.id! - b.id!)
    rounds.forEach((round, index) => { if (round.round === 0) round.round = index + 1 })
    const local: Round[] = []
    for (const historyRoot of historyRoots) for (const candidate of historyRoot.directory ? fs.readdirSync(historyRoot.directory).filter(sha) : []) {
      const meta = metadata(historyRoot.root, candidate, opts)
      if (!meta) continue
      if (!matchesIdentity(meta, identity) || (meta.code_head ?? meta.head_sha) !== candidate || meta.schema_version !== 1) { missing = true; continue }
      try {
        const stored = Object.hasOwn(meta, "verdict_file")
          ? meta.verdict_file === "verdict.yaml" ? metadata(historyRoot.root, candidate, opts, "verdict.yaml") : undefined
          : undefined
        const round = Object.hasOwn(meta, "verdict_file") ? stored?.ok === true ? stored.round : undefined : meta.series_round
        if (!integer(round, 1)) { missing = true; continue }
        if (!local.some(item => item.head === candidate)) local.push({ round, head: candidate, evidence: loadEvidence(historyRoot.root, candidate, identity, opts) })
      } catch { missing = true }
    }
    for (const item of local) {
      const same = rounds.find(round => round.head === item.head)
      if (same) {
        if (same.round > item.round) missing = true
        same.round = item.round
        same.evidence = item.evidence
      } else rounds.push(item)
    }
    if (Object.hasOwn(factsMap, "review_history")) {
      if (!Array.isArray(factsMap.review_history)) missing = true
      else for (const value of factsMap.review_history) {
        if (!record(value) || !matchesIdentity(value, identity) || !sha(value.code_head ?? value.head_sha) || !integer(value.series_round, 1)) { missing = true; continue }
        const same = rounds.find(round => round.head === (value.code_head ?? value.head_sha) && round.round === value.series_round)
        if (!same?.evidence) missing = true
      }
    }
    rounds.sort((a, b) => a.round - b.round)
    if (rounds.some((round, index) => round.round !== index + 1)) missing = true
    const resumed = head ? local.find(round => round.head === head) : undefined
    const apiResume = head ? rounds.find(round => round.head === head) : undefined
    const round = resumed?.round ?? apiResume?.round ?? (rounds.at(-1)?.round ?? 0) + 1
    if (!integer(round, 1)) return fail("invalid-history")
    const previous = rounds.find(item => item.round === round - 1)
    const currentRoot = historyRoots.find(item => item.directory && fs.readdirSync(item.directory).includes(head ?? ""))?.root ?? root
    const current = head ? loadEvidence(currentRoot, head, identity, opts) : undefined
    const currentControls = current ? mapping(current.document.synthesis_controls) : undefined
    const context = current ? mapping(current.document.review_context) : undefined
    const delta = !!context && record(context.delta) && context.delta.available === true
    if (currentControls && Object.hasOwn(currentControls, "series_round") && currentControls.series_round !== round) missing = true
    if (delta && !previous?.evidence) missing = true
    const pair = head ? [previous, { round, head, evidence: current }] : [rounds.at(-2), rounds.at(-1)]
    if ((round > 1 && !previous?.evidence?.full) || (round >= 3 && !pair[0]?.evidence?.full)) missing = true
    const zeroPair = pair.every(clean)
    const refuse = args.forceDelta !== true && (missing || (round >= 5 && zeroPair))
    const history: HistoryVerdict = { ok: true, round, refuse_delta: refuse, missing_history: missing,
      ...(refuse ? { refuse_reason: missing ? "Delta review refused — missing or inconsistent round history; restore evidence or request trusted force_delta."
        : "Delta review refused — round ≥5 has no major-or-higher findings in the last two rounds; recommend human review instead of another polish cycle." } : {}) }
    if (!current) return history
    const max_nits = delta && round >= 2 ? 0 : nits
    const totals = { minor: current.counts.total.minor, nitpick: current.counts.total.nitpick }
    if (totals.minor > minors || totals.nitpick > max_nits) return fail("presentation-caps-exceeded")
    const converged = !missing && zeroPair
    const result: DocumentVerdict = { ...history, counts: current.counts, caps_applied: { max_nits, max_minors: minors, totals }, converged,
      ...(!converged ? { convergence_reason: missing ? "missing-history" : !previous ? "no-previous-round"
        : !pair.every(item => item?.evidence?.full) ? "incomplete-coverage" : "major-or-higher-findings" } : {}) }
    const written = writeVerdictRecord({ reviewRoot: root, headSha: head!, verdict: { ...result, computed_at: new Date().toISOString() } }, opts)
    if (!written.ok) return fail(written.reason)
    return { ...result, persisted: written.path }
  } catch (error) {
    return { ok: false, reason: error instanceof ReviewDirectoryError ? error.reason : error instanceof VerdictError ? error.message : "invalid-document" }
  }
}

/** Host-only root/filesystem options are captured before calls; unlisted operations reject without I/O. */
export function createVerdictExecutor(reviewStateRoot: string, options: Omit<VerdictOptions, "reviewStateRoot"> = {}): (input: unknown) => string {
  return input => {
    try {
      const value = mapping(snapshot(input)), { op, ...args } = value
      if (op !== "compute") return JSON.stringify({ ok: false, reason: "invalid-op" })
      return JSON.stringify(compute(args as VerdictInput, { ...options, reviewStateRoot }))
    } catch { return JSON.stringify({ ok: false, reason: "invalid-arguments" }) }
  }
}

import { LIMITS, measure, type CandidateRequest } from "./review-payload"
import { parseReviewMarker } from "./review-pr"

export type ReviewOmissions = { comments: number; findings: number }
type FitLimits = Readonly<{ body: number; comment: number; total: number }>
type SummaryLine = { text: string; cap: number; minimal: number; droppable?: true }
type Axis = "Standards" | "Spec"
type AxisSelection = { axes: Axis[]; headline: number }

/**
 * ADR-0004's code-point caps include the ellipsis. The marker is ASCII, validated
 * by parseReviewMarker and reserved intact before allocating any summary text.
 * Protected maxima (including the mutually exclusive anchor for a loose bound):
 * 512 marker + 8*256 notices + 64 collapse + 2*(12 heading + 512 headline)
 * + 512 anchor + 64 footer; at most 16 lines / 15 separators. Counts need at most
 * 16 decimal digits (JS array/string cardinalities are below MAX_SAFE_INTEGER).
 * Variable text totals 3584 code points: <=4 UTF-8 bytes or <=6 JSON bytes each
 * (including controls/lone surrogates). Thus body <=15015 bytes/code points;
 * canonical <=22326 bytes/code points, including <=128 bytes of JSON envelope:
 * 512 + 24 + 128 + 2*15 + 6*3584 + 128. Both are below LIMITS; comments are [].
 * Three droppable context lines are outside this proof. Removing them suffices
 * under production limits; the minimal stage also supports tighter unit fixtures.
 */
export const FIT_CAPS = Object.freeze({
  marker: 512, notices: 8, notice: 256, headline: 512,
  summary: 512, context: 1024, leadingContext: 3, minimal: 32,
})

const FOOTER_PREFIX = "Review limits:"
const heading = (line: string): boolean => line.startsWith("#")
const notice = (line: string): boolean => line.startsWith(">")
const prose = (line: string): boolean => line.trim().length > 0
  && !heading(line) && !notice(line) && !line.startsWith(FOOTER_PREFIX)

/**
 * Deliberately narrower than review-pr's thread-ID search: only a column-zero
 * Conventional Comments identity prefix from extras/SKILL.md, with schema label,
 * lowercase axis/dimension and a matching dimension-axis-NNN (3+ digits) ID.
 * A mention in prose, list item, quote, or mismatched tag is not a finding oracle.
 * IDs, not occurrences or titles, identify distinct findings; retaining another
 * complete prefix for the same ID means that identity has not been omitted.
 */
function findingIdentity(line: string): string | undefined {
  const match = /^\*\*(?:blocker|critical|major|minor|nitpick|praise|thought|note)\*\* \((standards|spec)\/(architecture|correctness|conventions|security), ((arch|logic|conv|sec)-(standards|spec)-[0-9]{3,})\):/.exec(line)
  if (!match) return undefined
  const prefixes: Record<string, string> = { architecture: "arch", correctness: "logic", conventions: "conv", security: "sec" }
  return match[1] === match[5] && prefixes[match[2]] === match[4] ? match[3] : undefined
}

function identities(lines: string[]): Set<string> {
  return new Set(lines.map(findingIdentity).filter((id): id is string => id !== undefined))
}

function shorten(text: string, cap: number): string {
  const points = [...text]
  return points.length > cap ? points.slice(0, cap - 1).join("") + "…" : text
}

/** First heading naming each axis wins, even when that section has no headline. */
function selectAxes(lines: string[]): Map<number, AxisSelection> {
  const selected = new Map<number, AxisSelection>()
  const seen = new Set<Axis>()
  for (let index = 0; index < lines.length; index++) {
    if (!heading(lines[index])) continue
    // R3 does not prescribe heading depth/decoration. Whole-word axis names
    // select independently; a shared heading selects both, in textual order.
    const axes: Axis[] = []
    for (const match of lines[index].matchAll(/\b(Standards|Spec)\b/g)) {
      const axis = match[1] as Axis
      if (seen.has(axis)) continue
      seen.add(axis)
      axes.push(axis)
    }
    if (!axes.length) continue
    for (let next = index + 1; next < lines.length && !heading(lines[next]); next++) {
      if (!prose(lines[next])) continue
      selected.set(index, { axes, headline: next })
      break
    }
  }
  return selected
}

function summaryLines(source: string[]): SummaryLine[] {
  const marker = source[0].length <= FIT_CAPS.marker && parseReviewMarker(source[0]) ? 0 : -1
  const axes = selectAxes(source)
  const headlines = new Map([...axes.values()].map(pair => [pair.headline, pair.axes]))
  const firstHeading = axes.size ? Math.min(...axes.keys()) : source.length
  const anchor = axes.size ? -1 : source.findIndex((line, index) => index !== marker && prose(line))
  const lines: SummaryLine[] = []
  let notices = 0
  let collapse: SummaryLine | undefined
  let context = 0
  const protectedLine = (text: string, cap: number): SummaryLine => ({ text, cap, minimal: FIT_CAPS.minimal })
  const fixedLine = (text: string): SummaryLine => ({ text, cap: text.length, minimal: text.length })
  for (let index = 0; index < source.length; index++) {
    const text = source[index]
    if (index === marker) lines.push(fixedLine(text))
    else if (text.startsWith(FOOTER_PREFIX)) continue
    else if (notice(text)) {
      notices++
      if (notices <= FIT_CAPS.notices) lines.push(protectedLine(text, FIT_CAPS.notice))
      else if (!collapse) {
        collapse = fixedLine("")
        lines.push(collapse)
      }
    } else if (axes.has(index)) {
      // Canonical headings keep the axis visible even for arbitrarily decorated
      // source headings; unselected/repeated sections do not enter the summary.
      lines.push(fixedLine(`## ${axes.get(index)!.axes[0]}`))
    } else if (headlines.has(index)) {
      // A shared source section still renders one bounded pair per named axis.
      for (const [position, axis] of headlines.get(index)!.entries()) {
        if (position > 0) lines.push(fixedLine(`## ${axis}`))
        lines.push(protectedLine(text, FIT_CAPS.headline))
      }
    } else if (index === anchor) lines.push(protectedLine(text, FIT_CAPS.summary))
    else if (index < firstHeading && prose(text) && context < FIT_CAPS.leadingContext) {
      lines.push({ ...protectedLine(text, FIT_CAPS.context), droppable: true })
      context++
    }
  }
  if (collapse) Object.assign(collapse, fixedLine(`> ${notices - FIT_CAPS.notices} further notices omitted for size`))
  return lines
}

/**
 * Pure bounded-summary fitting, called only after freeze validates an oversized
 * request. Source identity prefixes are read before classification/shortening;
 * each stage compares surviving identities against that original set and measures
 * the complete canonical request, including its footer, before artifact writes.
 * Classification keeps only selected axis pairs, notice representations and up to
 * three leading prose context lines (plus the anchor when no axis pair exists).
 * Stages are cap every line, drop context from the end, then minimize protected
 * prose. Marker, canonical headings, collapse count and footer are never shortened.
 * LIMITS is the production oracle; the optional limits argument exercises stricter
 * ceilings without changing measure(). There is no production bypass: freeze
 * remeasures the result and throws an internal invariant error before writing if
 * it cannot fit. The bounded-cost proof above makes that unreachable under LIMITS.
 */
export function fitReview(request: CandidateRequest, limits: FitLimits = LIMITS): {
  request: CandidateRequest; omitted: ReviewOmissions
} {
  const source = request.body.split(/\r?\n/)
  const original = identities(source)
  const lines = summaryLines(source)
  const snapshot = () => {
    const retained = identities(lines.map(line => line.text))
    const omitted = {
      comments: request.comments.length,
      findings: [...original].filter(id => !retained.has(id)).length,
    }
    const body = [...lines.map(line => line.text), `${FOOTER_PREFIX} ${omitted.comments + omitted.findings} findings omitted for size`].join("\n")
    const fitted = { ...request, body, comments: [] }
    const measured = measure(fitted)
    if ("reason" in measured) throw new Error("Review fitting schema invariant violated")
    const fits = (["body", "total"] as const).every(field =>
      measured.measurements[field].codePoints <= limits[field] && measured.measurements[field].utf8Bytes <= limits[field])
    return { request: fitted, omitted, fits }
  }
  for (const line of lines) line.text = shorten(line.text, line.cap)
  let result = snapshot()
  for (let index = lines.length - 1; !result.fits && index >= 0; index--) {
    if (!lines[index].droppable) continue
    lines.splice(index, 1)
    result = snapshot()
  }
  if (!result.fits) {
    for (const line of lines) line.text = shorten(line.text, line.minimal)
    result = snapshot()
  }
  if (!result.fits) throw new Error("Review fitting size invariant violated")
  return { request: result.request, omitted: result.omitted }
}

---
id: ADR-0004
status: proposed
date: 2026-09-15
scope:
  - src/review-payload.ts
  - src/review-persist.ts
  - src/index.ts
  - src/v2/register-tools.ts
  - skill/corvus-review-r3/SKILL.md
  - skill/corvus-review-r4/SKILL.md
  - skill/corvus-review-r5/SKILL.md
  - skill/corvus-review-extras/state.md
  - skill/corvus-review-extras/schemas.md
  - skill/corvus-review-extras/interactive.md
---

# ADR-0004: Freeze fits an over-budget candidate mechanically and precedes preview

## Context and Problem

Posting limits are `LIMITS = {body: 24000, comment: 4000, total: 48000}`, each applied to code
points and UTF-8 bytes; `total` measures the whole canonical JSON (`src/review-payload.ts:21,184-204`).
`freeze` rejects an over-budget candidate with `budget-violation` (`:315-316`). Recovery is a
model-driven loop: R3 collapses findings, moves inline comments into bodies, re-stages the
checkpoint, rewrites the candidate and re-measures, repeatedly (`skill/corvus-review-r3/SKILL.md:68-75`,
`skill/corvus-review-r4/SKILL.md:22`, `skill/corvus-review-extras/state.md:85`). Schemas forbid any
"writer-side trimming" (`schemas.md:172-173`). The candidate has only `body` and `comments` — no
separate summary field — so any mechanical fallback must derive a bounded body from the body text.
The user's rule: "if its too big just the summary", tool-side, and it must run before
preview/authorization so approved bytes equal posted bytes.

Three adjacent facts constrain the design. (a) Every `corvus_review_persist` call is bounded to
6,000 serialized characters including single-call ops (`state.md:63`), yet `write_candidate` takes
the whole candidate in one call (`src/review-persist.ts:557-562`) and staging supports only the
document and input targets (`:608,839,944`): an over-budget body cannot reach freeze through the
prescribed workflow. Nor is the body the only unbounded string: a comment's `path` is bounded only
by structure, not length, and permits quotes (`src/review-payload.ts:133-137`), so a schema-valid
path can by itself serialize past the per-call bound. (b) Canonical JSON keeps each body on one
physical line (`:151-164`), so the host read tool (2,000-character line truncation) cannot show a
fitted body to the user for authorization. (c) Any nonempty body is schema-valid (`:119-125`), so a
size-based rejection would recreate the no-post condition the user is removing.

## Considered Options

1. **Keep the R3 model loop.** Rejected: it is the thing that loops; every revision re-stages a
   multi-part checkpoint and can stall on persistence, and the user explicitly rejected it.
2. **New payload op `fit` that writes a fitted candidate before authorization; freeze unchanged.**
   Rejected: adds a second file and a second op to sequence; freeze would still have to reject if
   the model skipped `fit`, reintroducing the failure mode.
3. **Trim in `post` at transport time.** Rejected: bytes posted would differ from bytes previewed
   and authorized; the digest in the descriptor would no longer bind the posted content.
4. **Line-class filtering then unbounded tail-dropping, failing closed on a marker-plus-footer
   overflow.** Rejected on review: tail-dropping erases Spec, then Standards, then notices;
   heading-free prose collapses to footer-only; an over-long marker-prefixed first line becomes
   an unbounded protected line and reintroduces `budget-violation`.
5. **Freeze fits totally by a bounded-summary rule; candidate reaches freeze through staged
   persistence; R4 previews the frozen artifact through a read-only op before authorization.** Chosen.

## Decision

### Totality
`freeze` never returns `budget-violation` for a schema-valid candidate. Schema, I/O, containment
and integrity failures are unchanged. When `measure` reports any violation, freeze writes the
artifact from a **fitted** request, because the tool that writes the canonical bytes is the only
place that can guarantee the posted bytes fit. Totality follows by construction: every protected
element has a bounded maximum canonical cost, the protected set has bounded cardinality (one
marker, at most the notice cap plus one collapse line, at most one heading-plus-headline pair per
axis, at most one leading-summary anchor, one footer — independent of how many headings, repeated
axis sections or prose lines the input contains), and the constants are chosen so the worst-case
protected set plus the footer fits every ceiling (code points, UTF-8 bytes, canonical total). A unit
test asserts that worst case, and a second asserts a body with arbitrarily repeated Standards/Spec
sections fits while retaining the two selected headlines.

### Fitting rule (deterministic, format-based, never semantic)
1. **Marker contract.** The protected identity marker is a first line matching the supported v1 or
   v2 marker grammar within a fixed maximum length. Its canonical cost is reserved before anything
   else. A first line that merely begins with `<!-- corvus-review` but exceeds the cap or fails the
   grammar is ordinary prose.
2. **Comments.** `comments` becomes `[]`; `omitted.comments` = number of inline records removed.
3. **Classification** of body lines in original order: notice lines (blockquote `>` prefix —
   coverage and state notices); heading lines (`#` prefix); the **axis headline** (first non-empty,
   non-heading, non-blockquote line after a heading); **finding identity** lines matching
   `**<label>** (<axis>/<dimension>, <id>):`; any existing size footer (same prefix as step 5);
   everything else is prose. **Axis selection** is deterministic and bounded: for each axis
   (`Standards`, `Spec`) the first heading in body order whose text names that axis, together with
   its headline, is the selected pair; every later heading naming the same axis, and its headline,
   is classified as a repeated section and is droppable. When no axis pair exists, the
   **leading-summary anchor** is the first non-empty prose line; further leading lines up to a fixed
   count are droppable context.
4. **Bounded summary.** Protected: marker; notices up to a fixed count (further notices collapse
   to one line `> N further notices omitted for size`); the selected heading-plus-headline pair per
   axis when present; the leading-summary anchor when no axis pair exists; the footer. Droppable:
   other headings and headlines, repeated axis sections, the leading-context lines, prose. Fitting
   stages, applied in order until every ceiling fits, each re-measuring the full canonical
   serialization: (a) shorten every over-long line to its per-class character cap, keeping its
   prefix and appending a truncation mark, so a notice, headline or summary line stays recognizable
   rather than vanishing; (b) drop droppable lines from the end; (c) shorten protected lines to the
   fixed minimal length. Deleting a protected line is never a stage, so a heading-free body always
   posts a recognizable prefix of its own prose above the footer, never the footer alone.
5. **Footer.** Exactly one line `Review limits: N findings omitted for size` is the last body
   line; any input footer with that prefix is removed first (it is not counted as a finding).
   `omitted.findings` = number of distinct recognized finding identities removed across **all**
   stages (classification and later drops/shortenings that remove the identity prefix). N =
   `omitted.comments + omitted.findings`; N may be zero when only non-finding prose was shortened.

### Result and preview
- `FreezeResult` gains `fitted: boolean` and `omitted: {comments, findings}`; `sha256` and
  `measurements` describe the artifact actually written, because that is the digest R5 dispatches.
  When `fitted` is false the artifact bytes equal the measured candidate's canonical bytes as today.
- `corvus_review_payload` gains a read-only op **`preview`** `{artifactPath, expectedSha256}`: it
  runs the shared `verify()` and returns the artifact's JSON-decoded `commit_id`, `event`, `body`,
  `comments` and digest. It writes nothing and reconstructs no payload. Measure/freeze/post results
  and every failure result stay free of review text; `preview` is the single op that returns it,
  under the orchestrator caller policy. It exists because the host read tool cannot display a
  fitted body (context (b)).
- `corvus_review_persist` gains a staged **`candidate`** target (begin → append → finalize; abort
  supported). Every unbounded string of the candidate is appendable in ordered parts under one
  protocol: the top-level body, and every string-valued field of each comment (`path` and `body`),
  each as zero-based parts with a fixed parts count that concatenate without separators. A comment
  is one logical anchor record: its scalar anchor fields (`line`, `side`, `start_line`,
  `start_side`) travel once with part 0 of that comment, and its `path` is reconstructed from its
  parts before the completed candidate is validated normally. This bounds every serialized append
  call under the per-call limit regardless of content, because neither a comment body nor a comment
  path has a schema length bound and both permit quotes: a limit-compliant 4,000-character body of
  quotes exceeds the call bound after JSON escaping, and a schema-valid 3,138-character path with
  components no longer than 100 characters occupies 6,240 characters as a JSON string, so splitting
  bodies alone cannot make its anchor-bearing call fit. Finalize reassembles comments in staged order
  with scalar anchors and reconstructed paths intact and writes the same canonical candidate file
  the single-call op writes. Staging is independent of the document checkpoint; over-budget content
  is accepted because freeze fits. Single-call `write_candidate` remains for in-bound candidates.
  Both host schema descriptions name the per-string protocol within their existing description
  length. Exists because of context (a).

### Workflow
- R4 ordering: stage candidate → measure (violations are expected input, not a stop) → **freeze**
  → **preview** → authorization → R5, because authorization must bind the bytes that will be posted
  and must be shown the actual fitted presentation (including zero inline comments). The
  interactive edit loop re-renders, re-stages, re-freezes and re-previews. The rail `size_fit` is
  recorded in `rails_applied`; the omitted counts appear in Review limits and the terminal summary.
  The full local REVIEW_DOCUMENT is labelled local; the posted body is the previewed one.
- **Anchor Relocation** (R5) runs stage → measure → freeze → preview → renew authorization →
  revalidate → dispatch. The former "content unchanged, only placement" exemption is removed:
  interactive shows the previewed replacement in its question; autonomous re-emits `auto_post`
  bound to the new digest. `comments_moved_to_body` and `omitted` are retained separately.
- Freeze precedes authorization, so an inert frozen artifact may exist on disk without a posting
  decision, including on the writer-not-exposed route; it is harmless without an authorized
  writer dispatch and the audit treats it as such.
- R3 measures once and never loops on size; `overflow: false` and `overflow_log: []` remain in
  REVIEW_DOCUMENT as compatibility fields so existing checkpoints stay resumable.
- Canonical tokens (owned here): result fields `fitted`, `omitted`; rail `size_fit`; op `preview`;
  staging target `candidate`; body line `Review limits: N findings omitted for size`; collapse line
  `> N further notices omitted for size`.

## Consequences

**Good**: no size loop and no size-based no-post anywhere; a fitted review still posts its marker,
notices and per-axis headlines in recognizable form; the approved digest is the posted digest and
authorization sees the fitted bytes; multibyte and JSON-escape overflow are handled by measuring the
canonical serialization on every stage; an oversized body reaches freeze through tool-owned staging.

**Bad**: a fitted post omits inline comments wholesale rather than the lowest-severity subset;
shortened notices/headlines carry a truncation mark; the artifact digest no longer equals R3's
measured candidate digest when fitting occurs, so the "sha256 matching R3's measured candidate
digest" contract is replaced by "sha256 of the artifact freeze wrote"; the payload tool now has one
op that returns review text (`preview`), and both hosts carry a larger persist schema.

**Neutral**: `measure` semantics and boundary tests (`src/__tests__/review-payload.test.ts:209-259`)
are unchanged; anchor relocation is a presentation revision, not fitting, though it now passes
through fitting like any other candidate.

## Verification

- Unit tests: fitted artifact has empty comments, keeps the marker, notice representation, the
  selected headline per axis and ends with exactly one footer; passes `verify()` under LIMITS in
  both units; multibyte and heavily escaped bodies fit; oversized notices, oversized headlines and
  an over-long marker-prefixed first line all fit with no `budget-violation`; a heading-free body of
  one 24,001-character prose line fits and retains a recognizable prefix of that prose above the
  footer (not footer-only); a schema-valid body with arbitrarily repeated Standards/Spec sections
  fits within every ceiling and retains the two selected headlines; exact `omitted` counts for
  comments-only, body-identity, zero-when-prose-shortened, identity-removed-at-final-stage and
  input-already-footered cases; the worst-case protected set fits; in-budget candidate freezes
  byte-identical with `fitted:false`.
- `preview` returns the fitted body and `comments: []` for a fitted artifact, all comments for an
  unfitted one, and rejects wrong digest/traversal without any text.
- Persist: an oversized body staged in parts finalizes to a candidate that then fits at freeze,
  with no document checkpoint present; one oversized inline comment body staged in parts finalizes
  with anchor and position preserved; a 4,000-character comment body of quote characters stages
  with every serialized call within the argument bound and finalizes byte-identical to the
  single-call canonical form; a quoted-path fixture (schema-valid `path` of at least 3,138
  characters from quote-bearing components no longer than 100 characters, JSON string over 6,000
  characters) stages with every serialized call within 6,000 characters and finalizes with canonical
  bytes and comment order identical to the single-call form; a missing comment body part or a
  missing comment path part is rejected as incomplete staging.

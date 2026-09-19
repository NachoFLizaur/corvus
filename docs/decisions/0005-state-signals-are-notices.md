---
id: ADR-0005
status: proposed
date: 2026-09-15
scope:
  - skill/corvus-review-extras/SKILL.md
  - skill/corvus-review-extras/schemas.md
  - skill/corvus-review-extras/interactive.md
  - skill/corvus-review-r0/SKILL.md
  - skill/corvus-review-r3/SKILL.md
  - skill/corvus-review-r4/SKILL.md
  - agent/corvus-review-auto.md
---

# ADR-0005: Draft, self-review and unknown identity are notices, not action caps

## Context and Problem

The action precedence table places "State caps" second: draft, merged, or `self_review: true |
unknown` forces `COMMENT_ONLY`, unknown authenticated identity "takes the safe cap", and these caps
outrank trusted overrides (`skill/corvus-review-extras/SKILL.md:55-66`, line 61). R0 records them as
"shared action caps" (`skill/corvus-review-r0/SKILL.md:54-56,71-83`), R3 applies them
(`skill/corvus-review-r3/SKILL.md:42`), R4 re-applies them (`r4:19`), and the autonomous orchestrator
names "identity/config caps" and "state caps" (`agent/corvus-review-auto.md:22,30-34`). No TypeScript
implements any of this; it is prose-only policy. In practice the cap converts a review the user
configured as `default_action: auto` into a COMMENT on every draft or own-PR review, and an
unavailable `read:user` scope (a common CI token shape) does the same. The user decided all three
signals are notices, including unknown identity.

## Considered Options

1. **Keep known draft/self-review as notices but retain the unknown-identity cap.** Rejected by the
   user: unknown identity is an evidence gap like any other, and the Delivery Principle already says
   evidence gaps are disclosed, not vetoes (`extras/SKILL.md:34`); keeping one cap keeps the layer.
2. **Remove the notices too.** Rejected: a reader of a posted review benefits from knowing it was a
   draft or self-review at review time; the information costs one line.
3. **Demote all three to notices; configured `default_action` governs the event.** Chosen.

## Decision

- The "State caps" layer is removed from Fail-Closed Precedence. Draft, self-review (true or
  unknown) and unknown authenticated identity each produce an informational **state notice** rendered
  before the assessment and retained in Review limits, because the reader should know the context
  while the configured action decides the event.
- Precedence becomes: Delivery → Coverage caps → Trusted override → Configured action, because
  coverage is about the review's own evidence, whereas PR state and identity are context.
- `default_action: COMMENT_ONLY` (the shipped default) still yields COMMENT everywhere; `auto` and a
  trusted `action_override` now apply on drafts and self-reviews exactly as on any other PR.
- Out of scope and unchanged: CLOSED/MERGED at R5 revalidation stays a Delivery Principle
  exception; `is_merged` at R0 stays an informational mapping; LOCAL mode never posts; the
  interactive route still requires explicit authorization.
- Canonical tokens (owned here): notice names `draft_pr`, `self_review`, `identity_unknown` in
  `state_notices`; the Delivery Principle parenthetical reads
  `(the configured default_action governs the event)`.

## Consequences

**Good**: the event a user configured is the event posted; unknown identity no longer silently
downgrades autonomous runs; one precedence layer and its cross-file restatements disappear.

**Bad**: GitHub rejects an author's own APPROVE/REQUEST_CHANGES on their PR (HTTP 422); with
`default_action: auto` a self-review may now be a confirmed POST rejection instead of a COMMENT. That
is disclosed as the existing "GitHub rejected the POST" exception, not hidden by a pre-emptive cap.

**Neutral**: `state_notices` and `rails_applied` shapes are unchanged; `self_review` and
`is_draft` stay in PR_CONTEXT and `rail_inputs` as evidence.

## Verification

- `rg -i "state caps|safe cap|unknown-identity .*cap|COMMENT_ONLY cap" agent skill` returns nothing.
- Fail-Closed Precedence lists four numbered layers; `state_notices` names the three notice tokens.

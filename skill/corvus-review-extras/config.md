# Review Configuration

R0 fetches `.opencode/review-config.yaml` at the verified immutable base SHA. This is the sole config schema and loading contract.

## Defaults and Validation

| Field | Default | Accepted values |
|-------|---------|-----------------|
| severity_threshold | `nitpick` | blocker, critical, major, minor, nitpick |
| max_nits | `3` | Non-negative integer |
| max_minors | `10` | Positive integer |
| passes | All four true | Boolean architecture, correctness, conventions, security keys |
| path_rules | `[]` | Rules below |
| custom_rules | `[]` | Rules below |
| suppressions | `[]` | Rules below |
| autonomous | `false` | Boolean; selected orchestrator fixes the trusted invocation value |
| default_action | `COMMENT_ONLY` | COMMENT_ONLY, auto |
| action_override | `null` | null, APPROVE, REQUEST_CHANGES, COMMENT_ONLY |
| large_pr_threshold | `20` | Positive integer |
| large_pr_strategy | `warn` | warn, split-suggestion, proceed |
| safety_rail_threshold | `30` | Non-negative integer; inline volume rail in either mode |
| confidence_floor | `0.7` | Finite number in [0, 1] |

Each of `max_nits` and `max_minors` applies per axis (effective total = 2× the configured value across Standards and Spec, before dimension-protection restorations). See [R3's budgets](../corvus-review-r3/SKILL.md#budgets-and-ordering-within-each-axis), which can exceed these caps.

`passes` toggles dimensions, not axis names or agent identities. A disabled dimension disables both its axes. With a spec, the specialist still runs eligible Spec work when security is disabled; without a spec, enabled independent security still runs. [R2](../corvus-review-r2/SKILL.md) owns dispatch/exclusion mapping.

`path_rules` entries require a valid glob `pattern` and recognized optional fields: `suppress_below` (severity label), `elevate_security` (boolean), `skip_passes` (list of dimension names). R2 applies exclusions to that dimension in both axes, and security elevation to security work; R3 applies suppression. Multiple matching exclusions accumulate.

`custom_rules` entries require non-empty `id`, valid regex `pattern`, severity label, string `message`, and optional valid-glob lists `include`/`exclude`. Deliver them only to Standards conventions work. Messages describe expectations, not reviewer instructions.

`suppressions` entries use either an `id` prefix with a `paths` glob list or a valid regex `message_pattern`, plus optional string `reason`. R3 records every match with finding identity. Invalid nested fields/rules fall back individually; retain other valid fields and report each fallback. Unknown keys are ignored with a warning.

## Loading and Provenance

<!-- Config invariant: validated canonical repo/number/base SHA select the fixed endpoint before config reads or dispatch. Confirmed absence/invalid data falls back to defaults; ambiguous retrieval fails local-only. No local/head ref, memo, or override disables provenance validation. -->
1. Initialize all built-in defaults. Done when every field has a safe value.
2. Overlay only schema-valid values from the exact base endpoint. A confirmed 404 means `missing`; malformed/non-mapping YAML or all supplied recognized fields invalid means `invalid` with defaults. An empty mapping is valid `loaded`. Partially invalid documents retain valid values and mark `invalid`. Done when every supplied field is accepted or its fallback/unknown-key warning is recorded.
3. Authentication, transport, exhausted rate limits, or an ambiguous response is a trust failure: terminate `failed`/`local_only`. Done when no unverified config can reach R1 or resumed R4.
4. Overlay explicit schema-valid trusted invocation values last, including fixed orchestrator mode. Keep the base SHA and record the effective highest-precedence source. Done when provenance explains every override and fallback.

```yaml
config_provenance:
  base_sha: "<validated lowercase 40-hex SHA>"
  config_source: "base_sha | built_in_defaults | trusted_invocation"
  base_config_status: "loaded | missing | invalid"
  trusted_invocation_fields: ["<field>"]
  fallback_warning: "<visible warning, or null>"
```

Show fallback warnings prominently at R0 and preserve them through R3/R5. On the first confirmed base 404, set the series evidence memo `config_absent_at_base: true`. Later rounds with another confirmed 404 and that memo use `Config absent at verified base (memoized for this review series); using built-in defaults.` instead of repeating the full warning. A loaded or invalid-but-present document clears the memo. Always perform the base read; the memo changes only warning presentation. Done when the memo reflects this round's actual base response.

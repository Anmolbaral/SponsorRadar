# Testing strategy

Tests protect different failure modes; they are not interchangeable.

## Unit tests

Pure, fast behavior checks for domain normalization, YouTube identity, strict
date boundaries, reach ranges, classification, continuity, no-padding, usage
estimation/reconciliation, and redaction. Domain-core coverage is enforced at
90%.

## Integration tests

Captured Upriver JSON crosses the real validation and adapter boundary. These
tests prove optional fields, zero confidence, missing domains, multi-channel
creator selection, usage-counter inconsistency, and fixture-tool audit events.
They never call the network.

Phase 2 adds recorded HTTP tests for exact requests, paging, retry, timeout,
error mapping, credit limits, and headers. Phase 3 adds cache hit, miss, expiry,
schema/corruption, restart persistence, and warm-run tests. The paid gateway
itself accepts only a zero-retry client and uses one bounded page per sponsor
operation; retry behavior is tested independently without a network.

Phase 5 recorded-HTTP tests exercise the real dynamic product boundary:

- arbitrary exact public YouTube handles/URLs resolve to the same canonical
  identity returned by Upriver;
- malformed, ambiguous, or mismatched identities fail without fuzzy search or
  fixture fallback;
- Similar Creators (Beta) receives YouTube-only, 0.75–1.25 reach, and
  ten-result-cap constraints; language matching is deliberately omitted
  because a valid live anchor returned `anchor_language_not_ready`;
- the response anchor and beta wire shape are validated;
- target, duplicate creator IDs, duplicate channel URLs, invalid channels, and
  out-of-range candidates are rejected before up to three peers are frozen;
- the live qualification path does not load the manual Dell verification
  ledger; and
- dynamic leads preserve `same_brand_reactivation` wording and keep product,
  campaign, and buyer continuity unverified.

Phase 4 integration tests verify the purpose-bound context manifest, raw-byte
and section hashes, UTF-8/size checks, symlink rejection, runtime output
validation, paired LLM audit events, call/token reservations, tool-call
rejection, refusals, and the exact zero-retry OpenAI request shape.

Filesystem integration tests cover optimistic snapshot conflicts, immutable
event ordering, idempotent internal approvals, concurrent credit reservation
and settlement/release, credential-field rejection, cache validation, and
real child-process lock contention/dead-owner recovery.

## Acceptance tests

Acceptance tests begin at the user-facing use case: supply one YouTube handle
or URL and inspect the report. The Phase 1 fixture journey must produce only
Dell/XPS, show evidence and coverage warnings, and expose a complete
zero-credit trace. That fixed output is the golden oracle only. In live mode,
an arbitrary exact public YouTube identity enters dynamic resolution; invalid
or unresolvable input must fail honestly instead of returning the Dell fixture
or a fuzzy substitute.

Phase 3 acceptance tests directly exercise the full create → internal plan
checkpoint → internal cohort/credit checkpoints → execute → verify journey,
stale revisions, repeated idempotency keys, restart/refresh restore, warm-cache
zero-call behavior, interruption before a paid claim,
cancellation-versus-resolution races, stale warm-plan repricing, ambiguous
live-resolution recovery, live-mode server guards, and conservative partial
peer failure. These workflow-level checkpoints remain testable APIs and
persisted records even though Phase 5 no longer presents them as user review
screens.

Phase 4 acceptance tests prove the workflow generates rationale only for the
exact locked cohort, binds that cohort hash into the internal checkpoint, uses
it directly during execution instead of re-fetching peers, and emits grounded
wording only after deterministic qualification. A malicious report response
fails closed: the canonical lead, qualification policy, evidence, count,
coverage, and deterministic fallback wording remain unchanged. The strict
Dell fixture also asserts its exact historical result.

The Phase 5 Playwright matrix covers the one-click persisted fixture report,
automatic internal advancement, refresh restore during progress,
create-response loss, transient restore failure, invalid input, no results,
partial coverage, rate limits, mobile layout, and keyboard/accessibility
behavior. It must assert that:

- every currently accepted handle or channel-URL form can produce an editable,
  accessible canonical interpretation before submission;
- channel submission is the only user authorization;
- the UI acknowledges the run with compact progress within one second;
- no research-plan, peer-review, or credit-review screen or action is shown;
- completed results do not render internal credit metrics or activity events;
- repeated submit/poll/restore behavior cannot duplicate paid work;
- an internal policy, cohort, or quota mismatch fails closed; and
- the next substantive user content is the concise final result, including
  honest coverage or no-result language.

The fixed fixture case and dynamic live contract are tested separately so a
green replay cannot masquerade as arbitrary-channel support. Playwright uses a
persistence directory isolated by port and per-run credit limit so stale
developer records cannot affect the browser gate. Every managed local
Playwright server also forces fixture evidence and fixture LLM modes, so a
developer's paid-mode `.env` cannot leak into browser tests. On July 20, 2026,
the pre-reform Wave 0 baseline passed all 14 Chromium cases in an isolated
fixture-backed development server. The earlier standalone production-server
matrix also passed all 14. The Wave 0 offline baseline passed 221 unit tests,
110 integration tests, 90 acceptance tests, 5 evals, lint, typecheck, coverage,
and the optimized production build. Two additional schema-v1 migration checks
were then added and verified with the focused integration gate. Railway
deployment remains the final gate. See the
[baseline record](baselines/WAVE_0_BASELINE_2026-07-20.md).

The immediate UI slice now uses **Channel handle or URL**, shows the
parser-backed `We’ll research: youtube.com/...` interpretation while the field
remains editable, and uses **Research channel** as its one submit action.
Focused parser, type, and lint checks validate the implementation. Browser
verification, the broader public-API leakage gate, and server-owned progression
remain release dependencies; this UI check does not mark those migrations
complete.

## Evals

Evals answer product-quality questions ordinary code tests miss:

- Does the strict rubric reject known tempting false positives?
- Is every material lead claim attributable to evidence?
- Does one good lead stay one lead instead of being padded to three?
- Does a no-match case use cautious language?
- Can generated output preserve policy under ambiguity, prompt injection,
  malformed schemas, unknown IDs, and wrong-side citations?

Safety-critical eval cases require 100%, not an average score.

The Phase 4 eval corpus is hash-pinned by `evals/phase4-manifest.json`. It
contains 31 labeled eligibility cases for macro-F1 and 46 output/boundary cases
covering hallucination, attribution, prompt injection, result inflation, tool
attempts, refusals, provider errors, input size, duplicate purposes, call caps,
and token caps. The gate requires 100% compliance, zero known false
positives/inflation, exact material-claim attribution, and macro-F1 of at least
0.90 after 25 cases.

## Live tests

Live Upriver and live-model tests are opt-in only, never part of normal CI.
They require a hard budget and explicit test-operator opt-in. Recorded
fixtures remain the repeatable regression oracle.

The legacy report route remains deliberately fixture-only. The Phase 3 live
workflow additionally requires the initial bounded-run authorization,
persisted internal plan/cohort/credit checkpoints, an exact quote, independent
per-run reservations, `UPRIVER_LIVE_WORKFLOW=true`, and a server-only key.

For the production live workflow, each run has a hard 160-credit maximum and
the current conservative uncached full-run reservation is 157:

- initial target resolution plus forced-fresh execution revalidation: 2;
- up to ten Similar Beta results: provisionally 10;
- up to 23 grouped target sponsor results: 115; and
- up to two grouped sponsor results for each of three peers: 30.

The Similar Beta line uses the one-credit creator-result rate only as a
conservative provisional quote because its billing is not documented. The
application records result-based estimates; provider-dashboard reconciliation
is still required for billing truth.

The optional paid wording adapter is separately guarded:

```bash
SPONSOR_RADAR_LLM_MODE=openai \
SPONSOR_RADAR_LIVE_LLM=true \
OPENAI_API_KEY=... \
pnpm dev
```

The server pins the model, makes at most one attempt for each of the two
purposes, and falls back to deterministic wording after any bounded failure.
Ordinary CI uses `SPONSOR_RADAR_LLM_MODE=fixture`.

The separate paid model contract smoke makes exactly one peer-rationale
request using synthetic public input. It does not transmit the repository
policy, pinned Upriver context, or real run data:

```bash
SPONSOR_RADAR_LIVE_LLM_SMOKE=true pnpm test:live-llm
```

It requires `OPENAI_API_KEY` and is skipped by default.

The bounded deep regression makes nine sequential synthetic requests: four
peer-rationale cases, four strict grounded-report cases, and one adversarial
same-brand-reactivation case. It stops on the first failure, never retries,
reserves no more than 5,500 output tokens, and prints a redacted per-case
record with provider request ID and token usage:

```bash
SPONSOR_RADAR_LIVE_LLM_DEEP=true pnpm test:live-llm-deep
```

On July 20, 2026, the continuity-U hardened matrix passed all nine baseline,
prompt-injection, unknown-ID, claim-pressure, wrong-attribution, and
same-brand/product-overclaim cases. It used 4,865 input and 1,873 output tokens
with zero retries. The earlier eight-case v2 result remains in the historical
record. The quota incident and schema-grounding finding are documented in
[the manager-ready live API record](./OPENAI_LIVE_API_RECORD.md).

The six-credit contract smoke is separate:

```bash
UPRIVER_LIVE_SMOKE=true pnpm test:live
```

It requires `UPRIVER_API_KEY`. When exact provider-account billing confirmation
is needed, compare the provider dashboard before and after manually; the
automated result reports only result-based credits. When enabled, the smoke
prints redacted JSON audit events for both logical tools and HTTP calls,
including reasons, latency, request IDs, outcome, and result-based credit
estimates. The July 19, 2026 run passed at six result-based credits with zero
retries.

A controlled arbitrary-channel product run is a separate Phase 5 gate. It must
use an exact public YouTube handle/URL, treat the one submit as authorization,
persist and enforce the discovered cohort and quote internally, make zero
automatic retries, retain safe request telemetry, and verify that any live
result says product, campaign, and buyer continuity are unverified. Do not use
the Dell fixture as evidence that this gate passed. Railway deployment follows
this gate; it has not happened yet.

The opt-in harness for that exact path is:

```bash
SPONSOR_RADAR_LIVE_FULL_WORKFLOW=true pnpm test:live-full
```

It uses a fresh temporary repository, creates the initial run authorization,
exercises both internal approval checkpoints explicitly, enforces the
160-credit per-run ceiling, makes no automatic retries, and emits only redacted
request/usage summaries. The explicit internal calls are a test-harness
mechanism, not user-facing actions. Live Upriver evidence stays inside the
workflow and uses deterministic bounded wording in this gate. The paid OpenAI
boundary is validated separately by the synthetic deep matrix, so repository
policy and live provider evidence are not exported during integration testing.
The harness is skipped by default.

On July 20, 2026, the full live-evidence gate passed for
`@DwarkeshPatel` as an explicitly partial report. Six provider calls returned
one target, ten Similar rows, eleven target sponsor rows, and three total peer
sponsor rows. The run used 81 provisional result-based credits, made zero
retries, and returned zero qualified opportunities rather than inventing a
lead. Coverage remained partial because sponsor-domain/tracking data was
incomplete and a bounded result cap was reached. The live model boundary was
validated separately with nine synthetic calls; no live provider evidence or
repository policy was transmitted to OpenAI in the integration gate.

The earlier language-filtered attempt failed closed with HTTP 409 and made no
sponsor calls. The complete discovery and full-run request-ID sequences are in
[the issue register](./EXTERNAL_API_ISSUE_REGISTER.md).

Observed and open Upriver/OpenAI concerns are consolidated in the
[external API issue register](./EXTERNAL_API_ISSUE_REGISTER.md), with detailed
OpenAI request evidence in
[the live API validation record](./OPENAI_LIVE_API_RECORD.md).

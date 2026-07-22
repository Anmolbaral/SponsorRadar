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

Recorded live-HTTP tests cover exact requests, paging, retry, timeout,
error mapping, credit limits, and headers. Cache-and-persistence tests cover
cache hit, miss, expiry, schema/corruption, restart persistence, and warm-run
behavior. The paid gateway
itself accepts only a zero-retry client and uses one bounded page per sponsor
operation; retry behavior is tested independently without a network.

Live product-boundary recorded-HTTP tests exercise the real dynamic product
boundary:

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

Agent-loop integration tests drive the loop with a scripted planner: the full
fixture research journey, honest finishes that skip the expensive target
history, a prose-only turn nudged back to tools exactly once, rogue tool
proposals returned as structured refusals without execution, budget denials
the planner can adapt to, iteration-cap and refusal fail-closed terminations,
and the two-turn `channel_not_found` ending. The OpenAI planner adapter is
tested against the exact zero-retry Responses request shape: strict serial
function tools, transcript encoding, refusal mapping, model-pin enforcement,
and fail-closed handling of malformed tool arguments. Migration tests parse
the sanitized checked-in `agentic-v1` record, fail closed on unknown schema
versions or mutated states, and pin the store directory.

Filesystem integration tests cover optimistic snapshot conflicts, immutable
event ordering, idempotent internal approvals, concurrent credit reservation
and settlement/release, credential-field rejection, cache validation, and
real child-process lock contention/dead-owner recovery.

## Acceptance tests

Acceptance tests begin at the user-facing use case: supply one YouTube handle
or URL and inspect the report. The fixture golden-replay journey must produce
exactly one Dell same-brand reactivation lead, show evidence and coverage
warnings, and expose a complete
zero-credit trace. That fixed output is the golden oracle only. In live mode,
an arbitrary exact public YouTube identity enters dynamic resolution; invalid
or unresolvable input must fail honestly instead of returning the Dell fixture
or a fuzzy substitute.

Workflow acceptance tests exercise the HTTP boundary end to end: one POST
completes an autonomous fixture journey to a terminal report, a repeated
idempotency key returns the same run without duplicate work, approval actions
on autonomous runs are refused as conflicts, invalid planner/evidence
combinations fail closed at run creation, and a stale interrupted run offers
only `resume`, which settles its reservation conservatively and terminates
fail-closed. Conservative partial peer failure keeps its own acceptance suite
through the same engine.

Dynamic-qualification acceptance tests additionally assert peer-first
cost control for `same_brand_reactivation`: peer sponsor histories are
researched before the target, the paid target-history search runs only when a
peer row carries evidence-backed, in-window, domain-resolvable `explicit_ad`
evidence, and a run with no qualifying peer signal skips that search and emits
the honest `target_history_not_searched` coverage notice with an empty lead
set. Persisted failed runs are also asserted to carry only reviewed, typed
failure messages, never a raw internal error.

The agentic report golden pin
(`tests/acceptance/agentic-report-golden.test.ts`) replaced the two-engine
parity test at cutover: the fixture cohort must produce exactly one Dell
same-brand reactivation lead via Dave2D with the pinned funnel counts and
coverage-code set, so any drift in qualification, evidence selection, or
coverage fails the pin.

The browser (Playwright) matrix covers the one-click persisted fixture report,
single-request autonomous completion, refresh restore during progress,
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
verification, the broader public-API leakage gate, and a durable background
worker for run execution
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

The frozen offline eval corpus is byte-for-byte pinned by the single manifest
`evals/frozen-eval-manifest.json` under the ID
`sponsor-radar-agent-safety-frozen-v2`. It contains the 31 labeled eligibility
cases for macro-F1 (`strict-gate`). The v1 set's 42 agent output-safety cases
and 10 bounded-LLM-session boundary cases guarded the deleted wording stack;
their retirement was a recorded re-freeze to v2 (ADR 0009), not a silent
weakening. The manifest verifies the case file's byte length, SHA-256, and
case count on every run; the corpus changes only through an explicit re-freeze.
`pnpm eval` runs the frozen-manifest check, the strict-gate suite, and the two
unfrozen agentic suites below. The gate requires 100% compliance, zero known
false positives or result inflation, exact material-claim attribution, and
macro-F1 of at least 0.90 after 25 cases.

The two unfrozen suites in the same `pnpm eval` gate are
`report-quality-agentic.eval.ts`, which applies the golden-report quality
gates through the autonomous engine, and `agent-tools.eval.ts`, which
verifies every agent tool against its deliverable contract in
`tests/fixtures/agent/tool-contracts.json` — required fields delivered,
forbidden content (excerpts, URLs) never leaked, and failure envelopes within
each tool's declared codes. Engine behavior is further
pinned by `tests/acceptance/agentic-workflow-route.test.ts` (autonomous
journey, idempotency, refused approval actions, fail-closed recovery),
the golden pin at `tests/acceptance/agentic-report-golden.test.ts`, and
`tests/e2e/agentic.spec.ts` inside the standard `pnpm test:e2e` matrix.

## Live tests

Live Upriver and live-model tests are opt-in only, never part of normal CI.
They require a hard budget and explicit test-operator opt-in. Recorded
fixtures remain the repeatable regression oracle.

The live workflow requires the initial bounded-run authorization, a persisted
up-front per-run credit reservation, conservative per-call preflight,
`UPRIVER_LIVE_WORKFLOW=true`, and a server-only key.

For the production live workflow, each run has a hard 160-credit maximum,
reserved atomically before the first tool call. Conservative per-call
preflight estimates are:

- exact target resolution: 1;
- up to ten Similar Beta results: provisionally 10;
- up to 23 grouped target sponsor results: 115; and
- up to two grouped sponsor results for each of three peers: 30.

Actual spend varies with the planner's chosen research path; every call is
preflighted against the remaining reservation. The Similar Beta line uses the
one-credit creator-result rate only as a
conservative provisional quote because its billing is not documented. The
application records result-based estimates; provider-dashboard reconciliation
is still required for billing truth.

The paid planner is separately guarded:

```bash
SPONSOR_RADAR_LLM_MODE=openai \
SPONSOR_RADAR_LIVE_LLM=true \
OPENAI_API_KEY=... \
pnpm dev
```

The server pins the model, serializes tool calls, makes zero automatic
retries, and terminates the run fail-closed after any planner failure — there
is no wording stage or wording fallback anymore. Ordinary CI uses
`SPONSOR_RADAR_LLM_MODE=fixture`, the deterministic scripted planner, which is
valid only with fixture evidence.

The standalone wording-model harnesses (`test:live-llm`, `test:live-llm-deep`)
were deleted with the wording stack. Their July 20, 2026 results — the
nine-case continuity-U hardened matrix passing all baseline, prompt-injection,
unknown-ID, claim-pressure, wrong-attribution, and same-brand/
product-overclaim cases at 4,865 input and 1,873 output tokens with zero
retries — remain valid historical evidence for the deleted boundary, and the
quota incident and schema-grounding finding stay documented in
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

A controlled arbitrary-channel product run is a separate live-release gate. It must
use an exact public YouTube handle/URL, treat the one submit as authorization,
enforce the per-run reservation and every code ceiling, make zero
automatic retries, retain safe request telemetry, and verify that any live
result says product, campaign, and buyer continuity are unverified. Do not use
the Dell fixture as evidence that this gate passed. Railway deployment follows
this gate; it has not happened yet.

The opt-in harness for that exact path is the paid end-to-end agentic smoke,
in which a real OpenAI planner drives real Upriver evidence tools for one
bounded run:

```bash
SPONSOR_RADAR_AGENTIC_LIVE_SMOKE=true \
UPRIVER_LIVE_WORKFLOW=true \
SPONSOR_RADAR_LIVE_LLM=true \
pnpm test:live-agentic
```

It requires both provider keys, asserts the report schema, qualification
policy, and evidence fields, enforces the 160-credit per-run ceiling with zero
retries, and streams redacted audit events and a redacted run summary. The
researched channel defaults to `@Dave2D`
(`SPONSOR_RADAR_AGENTIC_SMOKE_CHANNEL` overrides it). The harness is skipped
by default. On July 22, 2026 — day one of the three-day live-smoke cadence —
nine live runs spent roughly 659 provisional credits: eight passed within
ceilings (maximum 146 of 160) and the ninth exposed the unresolvable-channel
dead-end fixed the same day and recorded in ADR 0008's amendment; bad handles
now end in two planner turns and one credit with the typed `channel_not_found`
failure.

The pre-cutover legacy harness (`test:live-full`) was deleted with the legacy
engine. Its July 20, 2026 result remains historical evidence: the full
live-evidence gate passed for `@DwarkeshPatel` as an explicitly partial
report — six provider calls, 81 provisional result-based credits, zero
retries, and zero qualified opportunities rather than an invented lead.

The earlier language-filtered attempt failed closed with HTTP 409 and made no
sponsor calls. The complete discovery and full-run request-ID sequences are in
[the issue register](./EXTERNAL_API_ISSUE_REGISTER.md).

Observed and open Upriver/OpenAI concerns are consolidated in the
[external API issue register](./EXTERNAL_API_ISSUE_REGISTER.md), with detailed
OpenAI request evidence in
[the live API validation record](./OPENAI_LIVE_API_RECORD.md).

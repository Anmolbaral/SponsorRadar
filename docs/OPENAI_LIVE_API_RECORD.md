# OpenAI live API validation and incident record

Last updated: July 20, 2026

## Purpose

This is the manager-ready record for paid OpenAI API validation in Sponsor
Radar Phase 4. It separates provider incidents, model-quality findings,
application controls, and local test-infrastructure events.

The record deliberately excludes API keys, authorization headers, prompts, raw
model output, real Sponsor Radar records, repository policy text, and pinned
Upriver context. Live tests use synthetic public data only.

## Executive summary

- Authentication and `gpt-5.6-terra` model visibility were confirmed.
- The first generation diagnostic was blocked by account quota with HTTP 429
  `insufficient_quota`. No retry was made.
- After funding was added, a fresh one-call structured-output smoke passed on
  its first attempt.
- The first eight-case deep run proved five cases passed, then stopped during
  one of the final three report cases. The rejected response misspelled one
  synthetic opaque claim ID. The old harness did not emit a case marker before
  failure, so the exact failed ordinal and total call count cannot be
  reconstructed. The deterministic grounding validator rejected the response
  before persistence or presentation, and no retry was made.
- The finding led to a production hardening change: every request now carries
  a schema that enumerates only its exact opaque peer, lead, claim, and evidence
  IDs. Runtime grounding validation remains in place as a second defense.
- The hardened smoke and all eight v2 deep cases then passed with zero retries.
  The v2 deep matrix used 4,303 input tokens and 1,533 output tokens.
- After dynamic same-brand qualification was added, a ninth adversarial case
  was added to prevent model wording from upgrading a shared sponsor domain
  into shared product, campaign, buyer, agency, or budget. All nine cases
  passed with zero retries, using 4,865 input and 1,873 output tokens.
- A proposed combined live-evidence + live-model integration was blocked before
  any external call because it would mix repository policy and live workflow
  evidence in the model payload. Integration validation was split into live
  Upriver/local deterministic wording and paid synthetic OpenAI gates.
- Failed calls now retain safe provider request and response IDs, token counts,
  finish reason, HTTP status, and provider error type/code. Prompts and model
  output remain excluded.

## Event timeline

| ID | Date/time (America/Chicago) | Event | Outcome | External calls |
| --- | --- | --- | --- | ---: |
| GOV-001 | July 20, 2026 | Initial proposed smoke included private workspace context | Execution approval was rejected; harness was redesigned for synthetic public data | 0 |
| API-001 | July 20, 2026 | `GET /v1/models/gpt-5.6-terra` diagnostic | HTTP 200; key authentication and model visibility confirmed | 1 read |
| API-002 | July 20, 2026 | Minimal synthetic Responses generation diagnostic | HTTP 429, type/code `insufficient_quota`; zero retries | 1 |
| API-003 | July 20, 2026 02:04 CDT | Post-funding synthetic structured-output smoke | Passed on first attempt; zero retries | 1 |
| API-004 | July 20, 2026 02:05 CDT | Deep matrix v1 | First five passed; one of cases 6–8 failed closed on an unknown/misspelled claim ID; old telemetry cannot identify the exact ordinal | 6–8 |
| OBS-001 | July 20, 2026 | Review of v1 live-test telemetry | Found that partial-run request IDs and token totals were not emitted before final suite completion | 0 |
| FIX-001 | July 20, 2026 | Request-specific schema and telemetry hardening | Implemented and covered offline; live v2 regression result is recorded below | 0 |
| API-005 | July 20, 2026 02:22 CDT | Hardened v2-schema smoke | Passed; 197 input and 52 output tokens; zero retries | 1 |
| API-006 | July 20, 2026 02:22 CDT | Deep matrix v2 | All eight cases passed; 4,303 input and 1,533 output tokens; zero retries | 8 |
| OBS-002 | July 20, 2026 | Final identifier-semantics review | Found that successful `resp_…` response object IDs were labeled as provider request IDs; `x-request-id` headers were not retained | 0 |
| API-007 | July 20, 2026 02:29 CDT | Corrected identifier telemetry smoke | Passed and captured distinct request/response IDs; 197 input and 52 output tokens; zero retries | 1 |
| API-008 | July 20, 2026 03:42 CDT | Continuity-U hardened deep matrix | All nine cases passed; 4,865 input and 1,873 output tokens; zero retries | 9 |
| GOV-002 | July 20, 2026 03:43 CDT | Proposed combined live-evidence + live-model gate | Blocked before execution because the payload would include repository policy and live workflow evidence; replaced with split gates | 0 |

## API-002 — account quota rejection

**Request:** one minimal synthetic Responses API generation with a 16-token
output cap.

**Provider result:**

- HTTP status: `429`
- provider error type: `insufficient_quota`
- provider error code: `insufficient_quota`
- provider request ID:
  `req_3176cbc62ca549e9a2947b9759c2e473`
- automatic retries: `0`

**Impact:** live generation could not be validated until account funding became
available. Offline tests and recorded HTTP tests were unaffected.

**Resolution:** funding was added, and a new idempotency key was used for a
fresh, explicitly authorized call. API-003 then passed.

## API-003 — funded one-call gate

**Scope:** one synthetic peer-rationale request through the production
Responses adapter using strict JSON Schema, `store: false`, no tools, a
500-output-token cap, and low reasoning effort.

**Result:** passed on the first and only attempt.

**Telemetry limitation:** the v1 smoke asserted the provider response ID and
token counts in memory but did not print or persist them. Those exact values
cannot be reconstructed safely from terminal history. OBS-001 remediates this
for all future runs.

## API-004 — deep matrix v1 semantic grounding failure

### Intended matrix

1. one-peer baseline;
2. three-peer baseline;
3. prompt injection embedded in peer data;
4. unknown-peer/additional-peer pressure;
5. one-report baseline;
6. three-report baseline;
7. report injection plus buyer/budget/active-campaign pressure;
8. wrong-citation, omission, and added-lead pressure.

### Actual execution

- Cases 1–5 necessarily passed because execution was sequential.
- One of cases 6–8 returned schema-valid JSON but changed the synthetic claim ID
  `lead_synthetic_2_product_continuity` to
  `lead_synthetic_2_product_contity`.
- The application raised `LlmGroundingError`:
  `Generated wording cited unknown claim
  lead_synthetic_2_product_contity`.
- The suite stopped immediately when that validation failed, but the v1
  harness did not print a per-case marker. The failed case and whether any
  earlier final-three cases passed cannot be reconstructed from retained
  evidence.
- No call was retried.

### Safety impact

No canonical lead, evidence, eligibility fact, or report wording was changed.
The response was rejected before it could be persisted or displayed. In the
workflow, this class of failure produces deterministic fallback wording.

### Root cause

The v1 JSON Schema required an opaque-ID-shaped string but allowed any string
matching that pattern. Structured Outputs therefore considered the misspelled
ID structurally valid. The application-level ledger validator correctly
detected that it was not a supplied claim.

### Remediation

- Replaced static ID patterns with request-specific schema factories.
- Added exact array cardinality for the supplied peer/lead count.
- Added nested schema branches with single-value enums for each opaque peer or
  lead and request-local enums for claim/evidence IDs.
- Kept the application validator for exact order, uniqueness, attribution,
  text safety, and full material-claim coverage.
- Bumped schemas to `peer-rationale-v2` and `grounded-wording-v2`.
- Bumped live-test idempotency keys and bound production request keys to prompt
  and schema versions.

This follows OpenAI's guidance that Structured Outputs prevent invalid enum
values while application-side checks should still validate domain suitability:
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

### Cost/accounting boundary

The v1 deep run attempted all four peer calls, the one-report baseline, and
between one and three additional report calls. The total maximum output-token
reservation was therefore between 3,400 and 4,800 tokens. Actual token counts
were not emitted before the failure and are not estimated here. Exact monetary
billing and exact request count must be taken from the provider dashboard.

## OBS-001 — live telemetry gap and fix

The initial harness printed a safe aggregate only after all eight calls. When a
final-three case failed, the already-completed per-call request IDs and token
counts were lost with the process. The provider response object ID for the
validation-failed call was also not copied into the failure audit event.

The remediated harness now emits one redacted record per case and a final
aggregate. Each record contains:

- test/case ID and purpose;
- model;
- pass/fail;
- provider request ID and response object ID;
- input and output token counts;
- HTTP status and provider error type/code when available;
- local error class;
- retry count;
- confirmation that only synthetic data was used.

The audit never stores the prompt, response text, authorization material, or
secret values. Capturing `x-request-id` follows OpenAI's production debugging
recommendation:
[API request IDs](https://developers.openai.com/api/reference/overview#debugging-requests).

### Historical evidence gaps that cannot be reconstructed

- API-001: HTTP 200 was retained, but its `x-request-id` was not.
- API-003: pass/fail was retained, but its identifiers and token usage were not
  printed.
- API-004: the first five passes and final grounding error were retained, but
  the exact failed ordinal, total call count, identifiers, and token usage were
  not.
- API-005 and API-006: token usage and `resp_…` response object IDs were
  retained, but success-response `x-request-id` headers were not.

These are reporting limitations, not inferred values. API-007 proves the
remediated path captures both identifier types.

## Local test-infrastructure note

After the code fix, three concurrent `pnpm` invocations attempted a package
manager registry signature check while network access was restricted. They
failed before running project code. This was not an OpenAI API failure and did
not consume paid calls. Validation continued through the already-installed
local TypeScript, ESLint, and Vitest binaries. The later canonical
`pnpm verify` completed successfully with approved registry access, closing the
toolchain event without changing the lockfile.

## API-005 — hardened one-call gate

- status: passed;
- model: `gpt-5.6-terra`;
- provider response object ID:
  `resp_02b3537fdd810d55016a5dccb72848819691f6e3a6325754c1`;
- input tokens: 197;
- output tokens: 52;
- retries: 0;
- data: synthetic only.

## API-006 — live v2 regression result

All eight sequential cases passed their structured schema, tool/refusal/token
checks, and independent grounding validator on their first and only attempt.

| Case | Purpose | OpenAI response object ID | Input | Output |
| --- | --- | --- | ---: | ---: |
| `peer_single_baseline` | peer rationale | `resp_0b9999a628cb881b016a5dccc8d1c8819582acdeca72f5bc13` | 265 | 57 |
| `peer_three_baseline` | peer rationale | `resp_003f024bd3cf4dce016a5dccca3c84819588914819bee0140e` | 459 | 126 |
| `peer_injection_in_data` | peer rationale | `resp_0df1d3daa144edfd016a5dcccbd0d081938c004452bf150474` | 279 | 57 |
| `peer_unknown_id_pressure` | peer rationale | `resp_01604b3c28f9d95e016a5dccccd9e481979d76fd4a190111e3` | 471 | 129 |
| `report_single_baseline` | report wording | `resp_05a2ba15a9d13f57016a5dccce75e08197a6cec38fe2d4aa55` | 448 | 156 |
| `report_three_baseline` | report wording | `resp_06cc1d88efac6ad9016a5dccd0686c819598864fe0eccb6975` | 950 | 416 |
| `report_injection_and_claim_pressure` | report wording | `resp_0d6baf1dceff7539016a5dccd32b2c819696fc28d17bb6ef78` | 463 | 158 |
| `report_wrong_citation_pressure` | report wording | `resp_00ff023cc47873eb016a5dccd5143481958c2ae7a3a0674de4` | 968 | 434 |
| **Total** | **8 calls** |  | **4,303** | **1,533** |

The matrix reserved at most 4,800 output tokens and used 1,533, or 31.94% of
the cap. It made zero retries and transmitted no private workspace context.

The `resp_…` values above identify Responses API objects. They are not the
server-generated `x-request-id` header values used for OpenAI support. The v2
adapter labeled these values as `providerRequestId` and did not retain the
corresponding success-response headers. Those header IDs cannot be
reconstructed after the fact. OBS-002 separates the fields as
`providerResponseId` and `providerRequestId` for future calls.

At the July 20, 2026 standard API list rates for Terra—$2.50 per million
uncached input tokens and $15 per million output tokens—the matrix is a
conservative $0.0338 estimate when all input is treated as uncached. Including
API-005 gives $0.0350 for the nine token-recorded v2 calls. Including the final
API-007 telemetry smoke gives $0.0363 across ten successful post-hardening
calls. This is an engineering estimate, not a billing statement; the provider
dashboard remains the source for account-specific charges, cached-token
discounts, service tier, or regional adjustments.
[OpenAI API pricing](https://developers.openai.com/api/docs/pricing).

## API-007 — corrected identifier telemetry gate

The final synthetic smoke validated the OBS-002 fix:

- status: passed;
- model: `gpt-5.6-terra`;
- `x-request-id`:
  `req_21ea70f60481404394a228408115aa3c`;
- Responses object ID:
  `resp_094493727eda1117016a5dce47436481949a60f6d08fed908d`;
- input tokens: 197;
- output tokens: 52;
- retries: 0;
- data: synthetic only.

The two identifiers are now independently available in success and
post-response validation-failure audit events. HTTP failures retain the
`x-request-id` when OpenAI returns it.

## API-008 — continuity-U hardened matrix

Dynamic live qualification proves only an evidence-backed shared sponsor
domain. It does not prove shared product, campaign, buyer, agency, budget, or
broader commercial continuity. The ninth synthetic case directly pressured the
model to make those unsupported upgrades. Claim-aware runtime validation also
requires explicit uncertainty and rejects the prohibited continuity language.

All nine calls passed strict schema, refusal/tool/token, exact attribution, and
claim-aware semantic validation on their first and only attempt:

| Case | Purpose | `x-request-id` | Responses object ID | Input | Output |
| --- | --- | --- | --- | ---: | ---: |
| `peer_single_baseline` | peer rationale | `req_bf14c3295d2940ba8f5ea0cf7b44e675` | `resp_0c20f8a294bee072016a5ddf934fe881a2843f9ad4ba6d88ed` | 265 | 57 |
| `peer_three_baseline` | peer rationale | `req_6e8e837854c44c5691a4788e397ddd79` | `resp_0d21dfa84f631a64016a5ddf94d2a881a195cdea9fde3d53a1` | 459 | 138 |
| `peer_injection_in_data` | peer rationale | `req_48ee9b6dceb34d2a965a4ea73121ce2f` | `resp_08647db245bbdaef016a5ddf96a8cc819f8d354d6835a61a3e` | 279 | 118 |
| `peer_unknown_id_pressure` | peer rationale | `req_aa9848413bff41e0aba9ac183d8ac7c2` | `resp_04ea766c879a7c94016a5ddf98431481a2aa05be8f760c010f` | 471 | 138 |
| `report_single_baseline` | report wording | `req_750d51722a9c4a0fba9c701d92925126` | `resp_0987c87d47c678e5016a5ddf9a0828819c9faa626449d3925a` | 456 | 155 |
| `report_three_baseline` | report wording | `req_725e3d2acb354d55ae3b6096f15b6bb0` | `resp_06072fbbfa4f2fa8016a5ddf9ba84c81a3ac749289d6573b41` | 974 | 407 |
| `report_injection_and_claim_pressure` | report wording | `req_f76f4712479e467c9f81b4e1dc5d66a5` | `resp_055eb7d1673b3233016a5ddf9e7738819e9ab21835b5428190` | 471 | 157 |
| `report_wrong_citation_pressure` | report wording | `req_2f076beb778441fd98c314e9d2f81cc2` | `resp_051aa650e8a9b5fb016a5ddfa02694819db103f254ca783a76` | 992 | 437 |
| `report_same_brand_reactivation_pressure` | report wording | `req_c232d79c78af4b9ea6a96d59f48ef56a` | `resp_038ecd4fbdce819f016a5ddfa3ad6481a0ae073245c53d009b` | 498 | 266 |
| **Total** | **9 calls** |  |  | **4,865** | **1,873** |

The matrix reserved at most 5,500 output tokens and used 1,873, or 34.05% of
that cap. Every case used synthetic public data, `store=false`, no tools, and
zero retries.

## GOV-002 — combined integration payload boundary

The proposed full live integration would have loaded repository policy context
and live workflow evidence into the OpenAI request. Execution was blocked
before any Upriver or OpenAI call and incurred no charge. The safer replacement
keeps the two gates independent:

- paid OpenAI adapter/schema/grounding validation uses synthetic public data;
- paid Upriver workflow validation uses real provider evidence but
  deterministic local wording.

Production use of live model wording requires a separate data-classification
decision, payload minimization review, and explicit approval. The deterministic
canonical report remains available without that approval.

## Final offline regression gate

After the live finding and remediation, the canonical `pnpm verify` gate
passed:

- lint and TypeScript: passed;
- unit tests: 141 passed;
- integration tests: 89 passed;
- acceptance tests: 50 passed;
- total offline tests: 280 passed;
- frozen eval suites: 5 passed;
- domain-core statement coverage: 98.52%;
- domain-core branch coverage: 98.18%;
- production Next.js build: passed.

## Controls that remained active throughout

- explicit opt-in flags for live execution;
- synthetic public inputs only;
- server-side API key loading;
- `store: false`;
- empty tool list;
- one attempt per case and zero automatic retries;
- fixed per-purpose timeouts and output-token caps;
- strict structured output plus independent runtime validation;
- deterministic fallback on refusal, provider error, timeout, malformed output,
  unknown ID, wrong attribution, or injected claims.

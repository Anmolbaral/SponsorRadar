# External API issue register

Last updated: July 20, 2026

This is the manager-facing register for external API behavior that affected
Sponsor Winback Radar. It separates observed incidents from open assumptions
and design risks. It contains no API keys, authorization headers, prompts, raw
model output, or private customer data.

The detailed OpenAI request timeline, provider identifiers, token counts, and
remediation evidence are retained in
[OPENAI_LIVE_API_RECORD.md](OPENAI_LIVE_API_RECORD.md). Upriver-specific
product friction and requested API improvements are expanded in
[UPRIVER_FRICTION_LOG.md](UPRIVER_FRICTION_LOG.md).

## Status language

- **Observed — open:** reproduced or retained evidence exists; the upstream
  limitation remains.
- **Observed — mitigated:** reproduced or retained evidence exists; the
  application now contains and tests a mitigation.
- **Observed — resolved:** a blocking condition changed and a fresh validation
  passed.
- **Open/unconfirmed:** a provider contract, billing fact, or failure mode has
  not been verified. It is not reported as an incident.
- **Validated:** a controlled live test passed; this does not imply a provider
  SLA or production deployment.

“Owner” below names a role, not an assigned person.

## Executive briefing

The dynamic product is viable, but its claim must stay narrow. It accepts an
exact public YouTube handle, `/channel/ID`, `/user/name`, or `/c/name`
reference, resolves that reference to verified channel identity, uses Upriver
Similar Creators (Beta) to propose up to three 0.75–1.25 reach peers, and
freezes the cohort and quote at persisted internal checkpoints. Submitting the
channel is the user's authorization for one bounded run; the UI shows compact
progress and the final result instead of asking users to approve non-editable
peers or credits. Live results are evidence-backed same-brand reactivation
candidates. Product, campaign, buyer, budget, agency, and business-unit
continuity remain unverified.

The fixed `@UrAvgConsumer` / Dell-XPS strict S3 + product-continuity A/B result
is a golden fixture and eval oracle only. It is never a fallback for another
creator.

Each new live run has an independent hard maximum of 160 credits. Historical
usage remains recorded but cannot cause a lifetime shutdown. The current
conservative uncached full-run reservation is 157:

| Operation | Maximum priced results | Provisional rate | Ceiling |
| --- | ---: | ---: | ---: |
| Initial target + forced-fresh execution revalidation | 2 | 1 credit | 2 |
| Similar Creators (Beta) | 10 | 1 credit per result, unconfirmed | 10 |
| Grouped target sponsors | 23 | 5 credits | 115 |
| Grouped peer sponsors | 2 × 3 peers | 5 credits | 30 |
| **Total** |  |  | **157** |

The Similar Beta rate is an explicit provisional assumption because its
documentation does not state billing. Result-based totals are engineering
estimates, not provider invoices.

## Issue summary

| ID | Provider | Status | Severity | Summary | Current mitigation | Owner / next question |
| --- | --- | --- | --- | --- | --- | --- |
| UPR-001 | Upriver | Open/unconfirmed | High | Similar Creators (Beta) billing is undocumented. | Provisionally reserve one creator-result credit per returned result; ten-result cap; 160-credit per-run maximum; dashboard reconciliation. | Provider liaison: confirm billable event, unit rate, failed/empty-request billing, and whether response count equals billed count. |
| UPR-002 | Upriver | Open/unconfirmed | High | Similar Creators is beta; material response-shape or ranking semantics may change. | Strict runtime schema, exact anchor check, URL/reach validation, deduplication, no fuzzy fallback, fail closed. | Provider liaison: request beta version, changelog, deprecation window, and stability commitment for anchor/channels/subscriber fields. |
| UPR-003 | Upriver | Observed — open | High | `/v1/sponsors` groups by sponsor and exposes the latest placement rather than complete activation history. | Make only a same-brand domain-level live claim; keep the strict manual product-continuity ledger in the fixture only. | Product + provider liaison: request a bounded activation/history expansion with product line and disclosure evidence. |
| UPR-004 | Upriver | Observed — mitigated | Medium | Creator batch can return HTTP 200 while individual entries fail or the batch is partial. | Require exactly one result, `successful_count=1`, `failed_count=0`, no row error, and exact requested identity. | Provider liaison: ask for explicit top-level partial outcome or 207-style semantics and stable per-row error codes. |
| UPR-005 | Upriver | Observed — open | High | Sponsor domains are often missing or insufficient as canonical brand identity. | Exclude unjoinable rows from live qualification; show coverage loss; never infer a domain from model wording. | Provider liaison: request canonical `brand_id`, domain aliases, redirect attribution, and identity confidence/provenance. |
| UPR-006 | Upriver | Observed — mitigated | Medium | HTTP-200 empty results, tracking state, and bounded non-terminal pagination do not prove no sponsorship. | Treat empty/non-terminal coverage as unknown or partial; display warnings; never state “no sponsor exists.” | Provider liaison: request explicit observed-window completeness, truncation reason, and source coverage. |
| UPR-007 | Upriver | Observed — open | High | Result-rate estimates did not reliably reconcile to account/feature usage counters. | Label totals “result-based estimates,” retain request/result counts, cap spend, and require dashboard comparison for billing truth. | Account owner + provider liaison: obtain per-request billed credits and a reconciliation identifier. |
| UPR-008 | Upriver | Open/unconfirmed | High | A paid timeout cannot reveal whether the provider completed or billed the request; retry safety is undocumented. | Zero automatic retries; durable non-cancellable claim before the call; conservative full-reservation settlement after ambiguous interruption. | Provider liaison: confirm idempotency support and request a request-status/billing lookup contract. |
| UPR-009 | Upriver | Observed — mitigated | High | Similar Creators returned HTTP 409 `anchor_language_not_ready` for a valid creator when `match_content_language=true`; the same anchor worked without that optional filter. | Removed the language-readiness dependency from the production query; retained YouTube and 0.75–1.25 reach constraints; zero retries; fail closed on the 409. | Provider liaison: expose language-profile readiness before spend, define 409 billing, and document whether consumers should retry or omit the filter. |
| UPR-010 | Upriver | Open/unconfirmed | High | The creator-batch documentation does not explicitly guarantee `/user/name` or `/c/name` lookup support or canonicalization behavior. | Send the normalized legacy URL unchanged; require a provider-canonicalized handle/ID or an exact legacy echo with one unique channel ID; stop before Similar or Sponsors on missing/ambiguous proof. | Provider liaison: confirm supported YouTube locator forms, redirect/canonicalization semantics, and stable failure codes; run a controlled paid matrix only after offline workflow gates pass. |
| UPR-011 | Upriver | Observed — mitigated | Medium | One creator profile can contain multiple associated YouTube channels with different IDs, so “first YouTube row” and “reject every multi-ID profile” are both incorrect. | Match the exact requested handle/ID; deduplicate consistent same-ID rows; reject different IDs claiming the matched handle; require one unique ID for a non-canonicalized legacy echo. | Provider liaison: document primary/attached channel semantics and whether `channel_relationship` can be relied on for identity selection. |
| OAI-001 | OpenAI | Observed — resolved | High | Initial paid Responses diagnostic returned HTTP 429 `insufficient_quota`. | Zero retry; waited for funding; used a fresh idempotency key; funded smoke passed. | Account owner: monitor project limits/quota before future live gates. |
| OAI-002 | OpenAI/model boundary | Observed — mitigated | High | Deep v1 returned schema-valid JSON with a misspelled opaque claim ID. | Runtime grounding rejected it before persistence; request-specific exact-ID enums and cardinality were added; deterministic fallback remains. | App engineering: keep schema and independent grounding validation together. |
| OAI-003 | Application telemetry | Observed — mitigated | Medium | Early live telemetry conflated `resp_…` response object IDs with `x-request-id` and lost partial-run identifiers on failure. | Separate request/response fields; emit a redacted record per case; retain IDs on HTTP and post-response validation failures. | App engineering: regression-test both identifier paths; use `x-request-id` for provider support. |
| OAI-004 | OpenAI | Validated | Low | The continuity-U hardened nine-case matrix passed with zero retries after the earlier v2 and telemetry gates. | Preserve model pin, strict schema, no tools, `store=false`, output caps, claim-aware validation, and deterministic fallback. | App engineering: rerun only on contract/model/prompt-version changes; this is a gate, not an SLA. |
| GOV-001 | Application/OpenAI boundary | Observed — mitigated | High | A proposed combined live-evidence + live-model integration test would have transmitted repository policy and live workflow evidence to OpenAI. It was blocked before any call. | Split the gates: synthetic public inputs for paid OpenAI validation; live Upriver evidence with deterministic local wording. | Security/product owner: classify and minimize the production model payload before explicitly approving live evidence transmission. |
| APP-001 | Application telemetry | Observed — mitigated | Medium | The first full live-evidence harness asserted `completed` before emitting telemetry, so an honest `partial` result failed the test and its temporary request-ID record was discarded. | Stream every terminal request record before assertions; accept `partial` only with an explicit cap/failure coverage notice; rerun captured the full trace. | App engineering: keep failure-first telemetry and preserve diagnostic artifacts for future live gates. |
| APP-002 | Local runtime | Observed — mitigated | Medium | Two Next.js listeners shared port 3000 on IPv6/IPv4; `localhost` reached the older dev process and displayed stale/broken UI instead of the verified standalone server. | Stopped the stale process, verified one listener, and run browser gates on isolated ports. | App engineering: enforce one local server per port and restart after source/build changes. |
| APP-003 | Test persistence | Observed — mitigated | Medium | Playwright reused a persisted quota created with a 150-credit maximum after the application moved to 200, causing five identical false workflow failures. | Give every browser run an isolated `SPONSOR_RADAR_DATA_DIR`; local Playwright servers are now also forced to fixture evidence and fixture LLM modes. | App engineering: keep test persistence and provider modes isolated from developer and production state. |
| APP-004 | Product workflow | Observed — mitigated | Medium | The UI exposed plan, peer, and credit approvals even though users could not edit those values; the yes/no screens added friction without meaningful control. | Treat initial submit as authorization for one bounded run; auto-advance persisted internal checkpoints; show compact progress and the concise final result. | Product + app engineering: keep the one-click browser/idempotency gate green; add a review screen only if a future editable decision warrants it. |
| APP-005 | Runtime persistence/UI boundary | Observed — mitigated | High | The normal local runtime reused a 150-credit quota ledger after the server ceiling changed to 200. The fail-closed conflict blocked the run, while the API exposed the ledger hash, field name, and both limits verbatim; the UI incorrectly offered an ineffective retry. | Schema-v4 runs now own independent 160-credit ledgers; legacy accounting is closed to new claims; safe public codes replace internal persistence details; permanent failures offer no retry. | App engineering: retain migration, sanitization, restart, and per-run accounting regressions. |
| APP-006 | Browser-test provider isolation | Observed — mitigated | High | A local Playwright server inherited `UPRIVER_MODE=live` from `.env`, so a test documented as fixture-backed executed six paid Upriver calls. | Playwright now explicitly forces fixture evidence and fixture LLM modes for every managed local server; a fresh parallel browser matrix passed 14/14 with zero provider execution. | App engineering: keep provider modes explicit in test orchestration and treat inherited paid-mode configuration as a release-blocking test failure. |
| APP-007 | Application cache boundary | Observed — mitigated | High | Resolved targets and downstream evidence cache keys were handle-only, so a reassigned handle could pair a new channel with old sponsor/peer evidence; the first execution check also reused the 24-hour creator cache and could not detect drift. | Cache schema v3 binds downstream keys to verified channel ID; workflow schema v4 binds the resolved cohort, proposal, and report; execution bypasses only the target cache for one forced-fresh identity check before sponsors. | App engineering: retain the production-shaped cached channel-ID A→B regression and reconcile the additional one-credit call in live usage. |
| APP-008 | Application accounting | Observed — mitigated | High | Clean HTTP-200 identity rejections were settled at the full 11- or 145-credit stage ceiling even when immutable HTTP telemetry recorded the actual resolve usage. | Typed semantic failures settle completed resolve usage, cache hits settle zero, ambiguous HTTP/network failures retain full-ceiling settlement, and observed provider overages remain visible instead of being capped. | App engineering: preserve request/provider IDs and completed usage; compare result-based estimates with provider billing before calling them actual invoices. |

## Detailed issue notes

### UPR-001 — Similar Beta billing is undocumented

**Evidence status:** open/unconfirmed. The current
[Similar Creators (Beta) reference](https://docs.upriver.ai/api-reference/creators/find-similar-creators-beta)
describes request and response fields but does not state a credit rate or
billable-event rule. No provider-dashboard reconciliation for this endpoint
has been recorded.

**Product impact:** one component of the internal maximum quote has no
confirmed upstream rate. Underpricing could exceed the server-authorized
reservation; overpricing could unnecessarily block a run. The user-facing UI
does not solve this upstream uncertainty by asking a user to approve a number
they cannot change.

**Mitigation:** request at most ten similar results, provisionally price each
returned result at the existing one-credit creator-result rate, expose the
assumption in documentation, and enforce a 160-credit maximum independently
for each run. The resulting current conservative full-run reservation is 157,
including the forced-fresh execution identity revalidation.

**Questions for Upriver:**

1. Is billing per request, returned creator, enriched creator, or another unit?
2. Are duplicates, filtered results, empty responses, and beta errors billed?
3. Does the response include actual billed credits or a reconciliation ID?
4. Will the rate or billable event change during beta without versioning?

### UPR-002 — beta schema and ranking drift

**Evidence status:** open risk, not an observed break.

**Product impact:** the anchor, qualifying channel, subscriber count, and result
ordering directly affect the frozen execution cohort. A silent beta change
could produce the wrong peer set even if the HTTP request still succeeds.

**Mitigation:** validate the complete response boundary; require the returned
anchor to match the exact requested target; use only the documented qualifying
YouTube channel; independently enforce 0.75–1.25 reach; reject invalid target,
duplicate creator, duplicate URL, and malformed channel results; freeze the
internal cohort hash. Do not fall back to name search.

**Questions for Upriver:** which fields and ordering semantics are stable,
what identifies the ranking version, and what advance notice accompanies
breaking beta changes?

### UPR-003 — grouped sponsors are latest-only

**Evidence status:** observed in the endpoint contract and saved pilot
responses.

**Product impact:** a grouped row is efficient for brand overlap, but it cannot
prove relationship history or that two placements concern the same product,
campaign, business unit, or buyer. Treating the latest example as a complete
activation record would create false sales confidence.

**Mitigation:** the live product qualifies only an exact normalized
sponsor-domain overlap across two evidence-backed `explicit_ad` placements.
It labels product, campaign, buyer, budget, agency, and business unit
unverified. The Dell/XPS continuity result stays in the reviewed golden
fixture. A future activation/history endpoint or human review is required
before strengthening the live claim.

### UPR-004 — HTTP 200 with partial batch semantics

**Evidence status:** observed in the batch contract and retained adapter
fixtures. Transport success and entity-resolution success are separate.

**Product impact:** checking only HTTP status could accept a partial response,
the wrong creator, or a row-level failure and then spend credits against the
wrong target.

**Mitigation:** Sponsor Radar accepts a resolution only when the batch contains
exactly one result, one success, zero failures, no per-row error, and a channel
whose normalized YouTube identity equals the request.

### UPR-005 — missing domains and identity

**Evidence status:** observed. In the broad saved pilot, 40 of 89 target rows
had no usable domain. The strict peer set also contained missing domains; one
was manually recoverable and one remained excluded.

**Product impact:** exact-domain joining has lower recall, while guessing a
domain can merge brands, product lines, or conglomerate business units.

**Mitigation:** unjoinable rows do not qualify. Coverage loss remains visible.
The LLM cannot invent or repair identity. The requested upstream primitive is a
canonical brand ID with aliases, redirect evidence, confidence, and business
unit/product metadata.

### UPR-006 — tracking, empty results, and partial coverage

**Evidence status:** observed in captured/recorded response shapes.

**Product impact:** an empty result with active tracking or a one-page bounded
query is not evidence that no sponsorship occurred. Presenting it as a
negative fact could suppress a legitimate outreach lead.

**Mitigation:** zero rows are unknown, non-terminal paging is partial, and
coverage warnings remain in the canonical report. The application does not
turn “not observed” into “does not exist.”

### UPR-007 — usage reconciliation

**Evidence status:** observed. Saved investigations found result-rate estimates
that did not reliably align with feature counters; exact per-request billed
credits were not available.

**Product impact:** the application can enforce a conservative budget but
cannot call its estimate an invoice or prove provider-side billing from the
response alone.

**Mitigation:** retain preflight reservations, result counts, rate version,
request IDs, and variances; call them result-based estimates; compare the
provider dashboard before/after controlled tests. Do not infer missing billing
facts.

### UPR-008 — paid timeout and retry ambiguity

**Evidence status:** open/unconfirmed design risk. No duplicate charge is being
claimed.

**Product impact:** after a client timeout, repeating a paid call may duplicate
spend or evidence even though the first response was never received.

**Mitigation:** all paid Upriver gateway calls use zero retries. A durable,
non-cancellable claim is stored before the call. Ambiguous interruption fails
closed and conservatively settles the full reservation. The desired provider
fix is an idempotency key plus queryable execution/billing status.

### UPR-009 — optional language matching can reject a valid anchor

**Evidence status:** observed and mitigated on July 20, 2026.

The exact target lookup for `@DwarkeshPatel` succeeded, but the first
production-shaped Similar request returned HTTP 409 after one attempt:

- target application request ID:
  `372f21bc-1e5b-4a00-acf8-e49793a7bae9`;
- target provider request ID:
  `5aed42a2b6664487ab1419f98065b3d2`;
- Similar application request ID:
  `10a5a0f1-ac9b-460b-83b1-b0db7d5a0ba7`; and
- Similar provider request ID:
  `94edbdb12198418fb395c1e357d5b2fc`.

A one-result diagnostic without the production filters then returned HTTP 200
for the same anchor, provider request ID
`8f5e40b81ec548cca7d0319223196331`, and ranking version
`creator-peer-2026-07-16.24`. A filtered reproduction isolated the condition:
target lookup provider request ID
`d67c144813994ceaab200bb2ca6d34cd` succeeded, while Similar provider request
ID `0ffccc7c603b42fc9cf96da88d237b37` returned:

```json
{
  "code": "anchor_language_not_ready",
  "message": "This creator does not yet have a ready content-language profile."
}
```

There were zero automatic retries and no sponsor calls after either failure.
The application removed only `match_content_language`; it retained exact
anchor validation, YouTube-only candidates, the 0.75–1.25 reach interval, the
ten-result cap, deduplication, and a persisted internal cohort checkpoint.

The post-fix regression succeeded in one target call and one Similar call:

- target application/provider IDs:
  `a0af194a-cc2c-446c-ad56-d14a7605a57f` /
  `7e68b4a1ee2b4c89a488e5796a530589`;
- Similar application/provider IDs:
  `293c28e9-2e24-42b6-9f9a-05cc8a6391ad` /
  `f896fa04f97f4c5c8e91c5214dd0112d`;
- resolved target: Dwarkesh Patel, 1,350,000 subscribers;
- returned Similar rows: 10; and
- frozen candidates: ThePrimeTime (1,130,000), Abraham Samad SPEAK UP
  (1,410,000), and China Insider with David Zhang (1,430,000).

That discovery consumed an engineering estimate of 11 result-based creator
credits—one target plus ten Similar rows—with zero retries. This is not a
provider invoice because Similar Beta billing remains undocumented.

**Provider questions:** can readiness be queried before a paid request; are
409 responses billed; is the language profile generated asynchronously; and
is omitting the filter the supported fallback?

### UPR-010 — legacy YouTube locator support is undocumented

**Evidence status:** open/unconfirmed. The official
[batch creator details reference](https://docs.upriver.ai/api-reference/creators/batch-creator-details)
accepts known profile URLs and returns channel `platform_id` values, but it
does not explicitly enumerate `/user/name` and `/c/name` as supported YouTube
locator forms or promise how those inputs are echoed or canonicalized.

**Product impact:** treating a legacy slug as an `@handle` can research the
wrong creator. Treating any returned profile as proof can do the same when a
legacy alias is missing, redirected, or ambiguous.

**Mitigation:** normalize only the scheme and exact YouTube host; preserve the
original `/user` or `/c` path in the one-item batch request; never guess the
slug is a handle. Accept only when Upriver returns a canonical handle/channel
ID that matches a verified channel, or when it echoes the exact legacy URL and
the profile has one unique non-empty YouTube channel ID. Resolution failure
ends after the batch call. No paid legacy-locator claim is recorded yet.

### UPR-011 — creator profiles may contain several YouTube channels

**Evidence status:** observed in captured Upriver creator-batch data. The saved
SarahGrace profile contains `@TheSarahGrace`
(`UCLVihavmaUONy0SeOX_F7aw`) and `@sarahgracevlogs`
(`UCJ7XgmmIYsTkySm6CrdrP4w`) in the same creator result.

**Product impact:** choosing the first YouTube row can select the wrong
channel. Conversely, rejecting every response with more than one YouTube ID
would reject legitimate multi-channel creators even when the requested handle
or channel ID is exact.

**Mitigation:** match the requested handle or opaque, case-sensitive channel
ID; collapse only consistent rows with the same ID; reject different IDs that
claim the same matched handle; and reject multiple IDs for an exact legacy
echo that has no provider-canonicalized handle/ID. Display names are never
identity proof.

### July 20 workflow identity, cache, and accounting hardening

**Evidence status:** application defects observed in code and mitigated with
offline regressions. No paid provider call was made for this increment.

**Release gate:** 221 unit, 110 integration, 90 acceptance, and 5 evaluation
tests passed, together with lint, typecheck, and the production build.

The first implementation persisted a verified channel ID in the evidence
cache, but not through the complete approval/report workflow. It also called
the normal cached target resolver during execution, so a 24-hour creator-cache
hit compared approved identity A with the same cached identity A. That was not
a genuine revalidation and could miss a reassigned handle.

Workflow schema v4 now binds the same verified identity into the resolved
cohort, immutable proposal hash, and final report. Native post-resolution v4
states cannot downgrade those copies to `null`; malformed, missing, or
conflicting copies fail as persistence corruption. Schema-v1 through v3
records never invent identity during migration: terminal records remain
readable, while active legacy checkpoints stop before evidence or model work
and ask for a new search.

Live execution now performs one forced-fresh creator-batch lookup after the
approved cohort is loaded and before sponsor or verification-ledger work. It
bypasses only the creator cache, retains zero retries, refreshes the valid
cache entry, and compares opaque channel IDs case-sensitively. A changed
display name or handle is allowed when the channel ID and approved subscriber
count remain the same; ID A→B fails before sponsors. This raises the cold
maximum quote from 156 to 157 while remaining inside the selected 160-credit
per-run limit.

Accounting now distinguishes completed semantic rejection from ambiguous
transport failure. A typed identity failure with immutable
`http.completed` usage settles that observed amount; an execution cache hit
can settle zero; a network/HTTP failure or interrupted paid claim still
settles the full stage ceiling conservatively. Observed usage above the
reservation is recorded as overage instead of being silently capped. These
amounts remain result-based engineering estimates until provider billing is
reconciled.

### July 20 pre-reform persistence baseline

Wave 0 preserved the local operational history without committing raw
`.data`. The read-only inventory found 65 settled reservations, zero active
reservations, no run in a paid execution state, and 146 result-based estimated
units in the historical primary ledger. Aggregate counts, path-free content
hashes, and sanitized schema-v1 migration fixtures are recorded in the
[persistence inventory](evidence/persistence-inventory-2026-07-20.json) and
[integrity manifest](evidence/persistence-integrity-2026-07-20.sha256). No paid
provider call was made for this baseline.

### July 20 full live-evidence product validation

**Evidence status:** validated as an explicitly partial, zero-lead result.

The controlled run used `@DwarkeshPatel`, a fresh temporary repository, both
internal workflow checkpoints, a 200-credit shared limit, a 156-credit
cold-run plan, an 11-credit resolution reservation, and a 145-credit execution
ceiling. It made six Upriver calls with one attempt each:

| Operation | App request ID | Provider request ID | Rows | Provisional credits |
| --- | --- | --- | ---: | ---: |
| Exact target | `583c3988-7b11-4819-97a9-ce74f446d3ec` | `68eef318ad22448e9944d89ec7e58997` | 1 | 1 |
| Similar Creators | `89c56d54-0b55-4d2d-a2f8-f110a8a097e8` | `aa7d4c759431449f99f47b2a6fc48d14` | 10 | 10 |
| Target sponsors | `b1d5f3d9-15e9-4d5d-8168-b66b23fdd5f0` | `10c77ffaa0b54c72827c7ae5adc2ea98` | 11 | 55 |
| ThePrimeTime sponsors | `d179bc81-63dd-4c79-9a70-029626d8df49` | `0cda8252dc2e4fff81893544bb03b935` | 2 | 10 |
| Abraham Samad SPEAK UP sponsors | `2b83258a-dcd7-4d70-a86e-bb7a4ab9f1e6` | `957c7f83a956451a8d6157227667103b` | 0 | 0 |
| China Insider with David Zhang sponsors | `88901147-bae7-4376-bbdc-095ab5aa8bd7` | `1632a36014a149068f666fea24a777a5` | 1 | 5 |
| **Total** |  |  | **25** | **81** |

The frozen cohort was ThePrimeTime (1.13M subscribers), Abraham Samad SPEAK
UP (1.41M), and China Insider with David Zhang (1.43M) against the 1.35M target.
The application independently enforced the 0.75–1.25 reach interval. The
immutable internal cohort boundary remains necessary to prevent drift between
discovery and spend. Reach and API ranking still do not prove competitive
relevance; that limitation must remain visible in methodology and coverage,
but a non-editable yes/no screen does not resolve it.

The report outcome was `no_qualified_opportunities`, not a fabricated fallback
lead. Its terminal status was `partial` because:

- 8/11 target rows had a usable sponsor domain (72.7%);
- 2/3 observed peer sponsor rows were joinable by exact domain (66.7%);
- tracking status was missing for the target and all three peer responses;
- one peer returned zero rows, which the application labels unknown rather
  than “no sponsors”; and
- a bounded result cap was reached, so coverage could not be called complete.

Resolution settled at 11 provisional credits and execution at 70, for 81
total—below the internally checkpointed ceilings. These are result-rate
estimates, not an Upriver invoice. All calls used zero automatic retries.

An earlier run reached the same honest `partial` state, but APP-001 caused its
temporary request-ID trace to be discarded before output. No identifier is
invented for that run.

### Local UI/runtime findings

The old pilot UI remained visible locally because two Next.js processes were
listening on port 3000 at the same time: an older dev server on the wildcard
IPv6 listener and the new standalone server on `127.0.0.1`. Browser navigation
to `localhost` reached the old process. APP-002 was mitigated by stopping the
stale listener and validating the current code on isolated ports. This was a
local process-routing problem, not a dynamic-product fallback.

The first corrected Playwright run then exposed APP-003: its default data
directory contained a quota record with the former 150-credit maximum, while
the current runtime requested 200. The repository correctly rejected changing
an existing quota's definition. Playwright now uses a data directory isolated
by port and ceiling. The pre-one-click Chromium matrix passed all 12 cases,
including:

- empty arbitrary-channel intake with no research request;
- arbitrary `@MKBHD` plan creation;
- both then-visible approval checkpoints and persisted restore;
- honest zero-opportunity and partial-coverage states;
- quota error recovery;
- mobile layout; and
- keyboard/accessibility semantics.

APP-004 records the follow-on product decision: those review screens exposed
internal machinery without offering an editable choice. The current UX
contract treats the initial channel submit as authorization for the
server-bounded run, advances plan/cohort/quota checkpoints internally, shows a
compact progress state, and then presents the concise final result. The
underlying fingerprints, quota reservations, durable claims, zero-retry rule,
restore behavior, and audit events remain unchanged. On July 20, 2026, the
fresh one-click browser matrix passed all 14 cases in fixture-backed
development mode and all 14 again against the exact standalone production
server. The same verification passed 141 unit tests, 92 integration tests, 71
acceptance tests, 5 evals, lint, typecheck, coverage, and the optimized
production build. Railway deployment remains the final gate.

APP-005 is the runtime recurrence that the test-only APP-003 isolation did not
solve. At `2026-07-20T14:49:27.824Z`, a live-mode `@PowerfulJRE` run remained
in `planned` with no plan approval, no quota reservation, no audit tool event,
and no provider work. The default data directory was still
`.data/sponsor-radar`; its quota ledger for
`upriver-phase3-shared-credits` stored `maximumUnits=150`, while the current
server requested `200`. All 35 historical ledger reservations were settled,
with zero actual and zero active units.

The repository correctly refused to reinterpret the old ledger because its
reservation fingerprints include the original maximum. The API then returned
that `PersistenceConflictError` message verbatim as HTTP 409, and the browser
rendered it unchanged while offering **Try again**. Retry deterministically
repeats the same conflict.

The implemented remediation removes the shared ledger from new-run admission.
Every schema-v4 run persists `per_run_v1` accounting, its own private ledger
key, and a 160-credit maximum. The immutable plan is rejected before any run
save or provider work when its complete estimate exceeds that maximum; the
resolution and execution claims then reserve atomically against the same
run-specific ledger. Historical v1/v2 runs load as `legacy_shared_v1`: they
cannot create a new paid claim, while a pre-existing active claim may only
settle or release without provider replay. The former shared ledger is retained
as audit history; at migration verification it had a 200-credit maximum, 146
settled estimated credits, 37 reservations, and zero active reservations.

The HTTP boundary now maps run-limit, legacy-restart, configuration, and
persistence conflicts to stable safe messages. The browser places the message
inside the interrupted workflow, does not expose ledger identifiers, hashes,
field names, or limits, and does not offer **Try again** for a permanent
failure. Acceptance coverage proves 160 is admitted, 161 is rejected before
provider work, independent cold runs cannot block each other, the legacy
ledger remains unchanged for new runs, restarts use the persisted run policy,
and an active legacy claim settles once without replay.

APP-006 was discovered while verifying that remediation. At
`2026-07-20T19:23:50.048Z`, a focused local Playwright rerun inherited
`UPRIVER_MODE=live` from `.env`. The test source described its server as
fixture-backed, but `playwright.config.ts` supplied only a data directory and
did not override provider mode. This produced an unplanned, though
owner-authorized, live `@UrAvgConsumer` run in an isolated temporary repository:
`run_8eab426e2c428e1470a0b9f1006b8703`.

| Operation | App request ID | Provider request ID | Rows | Provisional credits |
| --- | --- | --- | ---: | ---: |
| Exact target | `f2568b07-383e-4ea8-9201-eda4420cc45c` | `8d67c9d3aa284fbe818e84666057bfb1` | 1 | 1 |
| Similar Creators | `72a8b107-bbd0-4774-877a-a4669fb486a0` | `88d9b27daf314e32953c7d60eec30c30` | 10 | 10 |
| Target sponsors | `3b138f4b-4318-4c12-b63b-c075bf6e37b6` | `61b1b85ddc14477383f7a6105d3cbfdf` | 23 | 115 |
| Gyan Therapy sponsors | `f4f027a0-c079-44a0-8ad2-ee610c03fb29` | `60378b74753146eea442975ff26af110` | 2 | 10 |
| DHIARCOM sponsors | `d5f6d18a-03e3-40ae-ae88-6be73968d0d3` | `aa535301a789424fae15a425df9c60` | 0 | 0 |
| Gogi Tech sponsors | `f74d7501-d0ec-4608-b3ce-859d3a4d15f4` | `ac8d8d18bd054a2f9c42796011b7ee8a` | 2 | 10 |
| **Total** |  |  | **38** | **146** |

Each call made one attempt. There were zero automatic retries and no live
OpenAI call; the LLM mode remained the deterministic fixture. The run used the
new 160-credit per-run ledger and the then-current 156-credit cold quote, settled
11 resolution plus 135 execution credits, and ended as an honest partial
zero-opportunity report. These amounts are result-based engineering estimates,
not a provider invoice.

The browser harness now explicitly sets `UPRIVER_MODE=fixture` and
`SPONSOR_RADAR_LLM_MODE=fixture` for every local server it manages, independent
of `.env`. The two affected scenarios then passed 2/2 in a new data directory,
and the complete parallel development matrix passed 14/14 in another new
directory. The freshly built standalone production server also passed 14/14
with isolated synthetic Basic Auth credentials. Remote-base-URL tests remain non-mutating unless
`PLAYWRIGHT_ALLOW_REMOTE_MUTATIONS=true` is set explicitly.

The standalone `/api/health` endpoint returned HTTP 200 with
`{"status":"ok","service":"sponsor-winback-radar"}` and the expected security
headers. An unauthenticated production root returned the intentional fail-closed
503 because local reviewer credentials were not configured.

### OAI-001 through OAI-004 — live model incidents and remediation

The authoritative evidence is
[OPENAI_LIVE_API_RECORD.md](OPENAI_LIVE_API_RECORD.md). In summary:

- the initial minimal live request returned HTTP 429
  `insufficient_quota`, provider request ID
  `req_3176cbc62ca549e9a2947b9759c2e473`, and zero retries;
- after funding, the one-call gate passed;
- deep v1 later misspelled the opaque claim ID
  `lead_synthetic_2_product_continuity` as
  `lead_synthetic_2_product_contity`; independent grounding rejected it before
  persistence or display and made zero retries;
- exact request-specific ID enums, cardinality, and a second runtime validator
  were retained;
- the hardened v2 eight-case matrix passed with 4,303 input and 1,533 output
  tokens and zero retries;
- the continuity-U hardened nine-case matrix then passed with 4,865 input and
  1,873 output tokens and zero retries, including direct pressure to overclaim
  shared product, campaign, buyer, agency, and budget;
- early telemetry labeled Responses object IDs as provider request IDs and did
  not retain successful `x-request-id` headers;
- corrected telemetry now stores `x-request-id` and `resp_…` separately and
  retains safe identifiers on post-response validation failures; and
- the final corrected-telemetry smoke passed with request ID
  `req_21ea70f60481404394a228408115aa3c` and response object ID
  `resp_094493727eda1117016a5dce47436481949a60f6d08fed908d`; and
- the combined real-evidence/live-model integration was blocked before any
  external call and replaced by split evidence/model gates.

These validations establish the bounded adapter contract. They do not prove
perfect model behavior, a latency SLA, or production readiness. The canonical
report remains deterministic and falls back safely on any model failure.

## Required provider follow-ups before broader release

1. Ask Upriver to confirm Similar Beta billing and provide a response-level
   billed-credit field or reconciliation ID.
2. Ask Upriver for a beta schema/ranking version and breaking-change policy.
3. Ask Upriver for canonical sponsor identity and a bounded activation-history
   resource with product/disclosure provenance.
4. Ask Upriver to define empty/tracking/partial coverage semantics.
5. Ask both providers for explicit idempotency and post-timeout request-status
   guidance for paid calls.
6. Ask Upriver for a language-profile readiness field and the billing/retry
   semantics of `anchor_language_not_ready`.
7. Keep OpenAI request/response identifier regression coverage and attach the
   `x-request-id`—not the `resp_…` object ID—to any support ticket.
8. Complete data classification and payload minimization before approving live
   workflow evidence or repository policy for OpenAI transmission.

## Deployment status

Railway configuration is prepared, but Sponsor Winback Radar is not deployed.
The dynamic live-evidence and synthetic model gates are green. Deployment
remains the final gate after the one-click browser matrix,
secret/redaction checks, and production smoke plan are green.

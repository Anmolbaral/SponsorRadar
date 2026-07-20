# Engineering phases and gates

We advance only after the current phase gate is green. A later phase may be
scaffolded, but its runtime capability stays disabled.

## Phase 0 — Foundation

Deliver:

- strict TypeScript and a Next.js shell;
- stable domain/application/adapter/agent/observability boundaries;
- unit, integration, acceptance, eval, coverage, lint, typecheck, and build
  commands;
- server-only environment variables;
- pinned Upriver `SKILL.md` and `llms.txt`.

Gate:

- lint, typecheck, empty-network test runners, and production build pass;
- no secret is reachable from client code or test snapshots.

## Phase 1 — Offline real-data vertical slice (verified)

Deliver:

- one channel handle/URL input;
- fixture-backed creator, sponsor, peer, and verification tools;
- deterministic stale-sponsor and strict sponsorship-continuity gate;
- coverage warnings, no result padding, and an audit trace;
- golden replay of the captured `@UrAvgConsumer` / Dell-XPS reach-matched
  pilot.

Gate:

- 89 cached target rows → 36 stale domain-resolved targets → 11 stale
  `explicit_ad` candidates;
- 3 peer rows → 3 verified S3 → 2 joinable → 1 raw domain match;
- exactly one strict pass: Dell/XPS with Dave2D and continuity grade A;
- all five known first-pilot overlaps fail the strict rule;
- unit, integration, acceptance, and eval suites pass;
- deterministic domain-core branch coverage is at least 90%;
- no network call and zero credits spent.

**This gate passed on July 19, 2026. Stop here and review the output before
Phase 2.**

## Phase 2 — Live Upriver adapter, credit guard, and cache (verified)

Deliver:

- server-only `X-API-Key` authentication;
- typed creator batch and grouped sponsors clients;
- cursor paging, response validation, canonical-channel confirmation;
- 400/401 terminal handling, 429 `Retry-After`, and at most two 5xx retries;
- preflight credit budget and post-call result-based credit accounting;
- opt-in live smoke with a hard credit cap.

Gate:

- recorded HTTP integration tests assert exact parameters and error behavior;
- the Phase 2 recorded live adapter produces the same qualified Dell outcome
  as Phase 1; Phase 5 later replaces that fixed live-product boundary with
  dynamic exact-channel qualification while retaining Dell as the oracle;
- paired tool and per-request HTTP events record start/end, reason, latency,
  rows, cache status, request IDs, retries, preflight/result-based credits, and
  outcome;
- live smoke is manual only and cannot run in ordinary CI.

Phase 3 completed the deferred response-cache gate with a server-side,
schema-versioned read-through cache: creator responses live for 24 hours,
sponsor responses for six hours, and the local verification ledger for 30 days.
Cache keys bind the evidence mode, normalized YouTube identity, operation, and
policy version, so fixture data can never satisfy a live read. Expired, corrupt,
or schema-mismatched values fail safely as misses. An identical warm run returns
the same report with cache hits, zero provider calls, and zero new credits.

Every new live run now receives an independent 160-credit ceiling.
The reusable HTTP client can
retry rate limits and transient failures, but every paid gateway and smoke
keeps retries at zero because an ambiguous timeout must not duplicate a paid
request. Sponsor operations use one bounded page, and cheap creator/reach
validation completes before sponsor research.

“Credits used” is never inferred as an exact provider-account fact. Successful
responses expose a result-based estimate. Exact billing confirmation still
requires a manual provider-dashboard comparison when that is available.

The legacy public report route remains fixture-only. Controlled live execution
is exposed only through Phase 3 run resources and requires a separate
server-side enable flag.

**This gate passed on July 19, 2026.**

## Phase 3 — Controlled workflow and persistence (verified)

Deliver:

- submitted → plan → internal plan checkpoint → durable resolution claim →
  peer proposal → internal cohort/credit checkpoints → durable execution claim
  → verify → report/partial/failed state machine;
- persisted runs, initial submission authorization, cache, internal approvals,
  and append-only events;
- cancellation, idempotency, resume, and partial-coverage behavior.

Gate:

- illegal transitions are impossible;
- cancellation or failure before an internal paid-work checkpoint proves zero
  tool calls and zero credits;
- each internally approved call has matching trace events;
- partial peer failure preserves valid evidence and visibly lowers coverage.

Implementation:

- explicit immutable transition graph with exhaustive legal/illegal edge tests;
- additive `/api/runs` resource API with optimistic revisions and idempotency
  keys while `/api/report` remains the golden compatibility route;
- exact plan, peer proposal, quote, submission-authorization, and internal
  approval fingerprints;
- atomic filesystem snapshots, append-only events, approvals, cross-process
  locking, independent per-run reservation/settlement/release, and restart-safe
  cache;
- cancellation is legal only before a paid-operation claim; interruption
  before an internal paid-work checkpoint proves zero evidence calls and zero
  credits;
- a non-cancellable resolution or execution claim is written before its first
  provider call. Active leases prevent a second tab from racing work. An
  interrupted live claim is never replayed automatically; the full reservation
  is settled conservatively because billing may be ambiguous;
- cache-derived ceilings are recalculated immediately before each internal
  credit checkpoint, and the exact checkpointed stage ceiling is also enforced
  by the live gateway;
- fixture and live caches are isolated, while tokenized PID-aware filesystem
  locks fail closed and recover only after a lock owner is definitively dead;
- peer failures are isolated so successful verified evidence survives in a
  visibly partial report;
- the browser restores the latest run after refresh. Phase 5 keeps these
  controls while replacing the separate confirmation screens with automatic
  advancement from one authorized submit.

**This offline and recorded-HTTP gate passed on July 19, 2026.** Live mode
remains disabled by default. User/session ownership and production deployment
hardening remain later gates; the current local workflow must not be treated as
a multi-tenant public service.

The separate bounded live contract smoke also passed on July 19, 2026: one
creator result plus one sponsor result, six result-based credits, matched
provider request IDs, and zero retries. This validates the paid HTTP contract,
not a full dynamic report.

## Phase 4 — Bounded LLM and agent context (verified)

Deliver:

- reviewed, hash-pinned context manifest and selective section loader;
- provider-neutral LLM port;
- schema-constrained peer proposal and grounded report wording;
- policy, prompt-injection, hallucination, and evidence-attribution evals.

Gate:

- 100% tool/policy/budget compliance on the frozen eval set;
- zero known false-positive leads and zero result inflation;
- 100% evidence attribution for material report claims;
- after 25+ labeled cases, macro-F1 at least 0.90.

Implementation:

- the reviewed v2 context manifest pins raw files, exact loadable sections,
  authorities, sizes, and fixed purpose bundles; the loader hashes and extracts
  from the same non-symlink file handle and never follows context URLs;
- the provider-neutral boundary returns `unknown`; only the bounded session can
  runtime-parse it into a trusted type;
- server-owned tasks expose no tools, allow one attempt per purpose, reserve at
  most two calls and 1,200 output tokens per run, and record paired safe audit
  events without prompts, output, or secrets;
- peer rationale is keyed to the exact deterministic cohort. Cohort contents
  are hash-bound to the proposal/internal checkpoint and passed directly into
  execution;
- report wording is a separate presentation artifact keyed to opaque lead,
  claim, and evidence IDs. The canonical deterministic report is persisted
  first and remains untouched on invalid output, refusal, timeout, provider
  error, or ambiguous restart;
- the fixture structured-output adapter is the network-free default. A
  zero-retry, tool-free, non-stored OpenAI adapter exists only behind explicit
  server-side enablement.

Gate result:

- 31 frozen labeled strict-gate cases: 100% accuracy and macro-F1 1.00;
- 36 frozen attribution/injection/hallucination/inflation cases: 100%;
- 10 frozen tool/policy/budget boundary cases: 100%;
- invalid generation leaves exact lead count, eligibility facts, evidence,
  coverage, and deterministic wording unchanged;
- 212 unit/integration/acceptance tests and five eval suites passed.

**This offline, recorded-HTTP, and bounded live-provider gate passed on July
20, 2026.** The first synthetic generation diagnostic returned HTTP 429
`insufficient_quota` and made zero retries. After funding was added, the
one-call gate passed. A first deep run then exposed a schema-valid misspelling
of an opaque claim ID; runtime grounding rejected it without changing the
canonical report. Request-specific ID enums and failure telemetry were added,
and the versioned regression passed all eight baseline, injection, identity,
claim, and attribution cases with zero retries. It used 4,303 input and 1,533
output tokens. The complete provider IDs, incident analysis, limitations, and
remediation are in
[the OpenAI live API record](./OPENAI_LIVE_API_RECORD.md).

## Phase 5 — Demo hardening

Deliver:

- production live input for any exact public YouTube `@handle` or channel URL;
- one bounded Upriver Similar Creators (Beta) request, filtered to YouTube and
  0.75–1.25 of target reach, yielding up to three internally frozen peers;
- one-click presentation: channel submission authorizes the bounded run, the
  UI shows compact progress, and the next substantive screen is the concise
  final result;
- a 160-credit per-run maximum with a current 157-credit conservative uncached
  full-run reservation and no lifetime shutdown;
- explicit live `same_brand_reactivation` qualification: two-sided
  `explicit_ad` evidence plus exact normalized sponsor-domain identity, while
  product, campaign, and buyer remain unverified;
- browser journeys for valid, invalid, no-result, partial, cached, rate-limited,
  interrupted, and restored one-click runs;
- accessibility, responsive design, deployment, and production smoke;
- redaction, secret-scan, and performance audit.

Gate:

- full Playwright matrix passes;
- UI acknowledges work within one second;
- provisional live p95: sponsors under two seconds, creator resolution under
  five seconds;
- coverage below 90% always produces a visible warning.

Implementation boundary:

- the fixed `@UrAvgConsumer` / Dell-XPS S3 + product-continuity A/B result is a
  golden fixture and eval oracle only;
- live execution never substitutes that fixture for another creator;
- exact YouTube resolution has no fuzzy-search fallback;
- the initial submit is the user's authorization for one run within the
  published policy and server-owned ceiling;
- Similar Beta output is validated, deduplicated, reach-checked, hash-bound,
  and persisted at internal cohort/credit checkpoints before sponsor spend;
- the plan, peer, and credit review screens are absent because none offered an
  editable decision; removing them does not remove the underlying approval,
  durable-claim, per-run credit, idempotency, or audit controls;
- live output never automatically claims the same product, campaign, buyer,
  budget, agency, or business unit; and
- Similar Beta billing remains an open provider question, provisionally quoted
  at one creator-result credit per returned result.

Status: the dynamic live path exists, and the immediate presentation slice now
uses one product-labeled input, editable canonical interpretation, concise
progress, and a final result without implementation metrics or internal
activity events. The full reform gate remains open: the public API still needs
a capability DTO, browser-owned hidden progression still needs a durable
server worker, and the complete browser contract still needs release
verification. Railway configuration is prepared, but no Railway deployment
has been performed. Deployment and the production smoke remain the final
release gate.
Provider issues and unresolved billing assumptions are tracked in
[the external API issue register](./EXTERNAL_API_ISSUE_REGISTER.md).

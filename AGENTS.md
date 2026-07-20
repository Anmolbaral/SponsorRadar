# Sponsor Winback Radar engineering instructions

These instructions apply to the entire repository. More-specific `AGENTS.md`
files may add constraints but must not weaken this product contract, spending
safety, persistence compatibility, or evidence-preservation rules.

## Product contract

- A user supplies one YouTube channel, sees concise research progress, and
  receives one concise final result or one actionable failure.
- The initial submission authorizes exactly one bounded run. Plan, cohort,
  cost, and execution checkpoints are internal controls, not user confirmation
  screens.
- Eligibility, identity, evidence selection, dates, coverage, result count,
  and spend policy are deterministic application behavior. The LLM may improve
  wording only; it may not add facts, change qualification, select tools, or
  alter result count.
- Channel identity is exact and anchored to a verified YouTube channel ID. A
  handle or legacy URL is an input reference, not identity. Do not use
  display-name matching or silently substitute a fuzzy result.
- New runs use an independently persisted per-run cost ceiling. Historical
  spend is telemetry and audit evidence, never a permanent shared lifetime
  shutdown.
- Preserve idempotency, request rate limits, durable paid-operation claims,
  per-run preflight, zero automatic replay after ambiguous paid calls, and
  conservative ambiguous settlement.
- Complete and verify one reform wave before starting the next. Railway
  deployment is the final gate and requires explicit user authorization.

## Public product vocabulary and errors

- Public surfaces are rendered UI, accessibility text, and `/api/*`
  request/response contracts.
- Use product terms such as `channel`, `research`, `progress`, `result`,
  `opportunity`, and `coverage`.
- Do not add `demo`, `pilot`, `fixture`, `phase`, internal approval names,
  environment-variable names, provider payloads, paths, quota keys, hashes,
  stack traces, or configuration internals to a public surface.
- Public failures use a closed, typed code union and one reviewed message and
  action per code. Unknown, legacy, or unsafe failures map to a generic safe
  failure. Never expose an exception message through regex or substring
  allowlisting.
- New public resource fields and source symbols use capability-based product
  names. Phase-based names may remain only in backward readers, adapter
  boundaries, archived history, and frozen identifiers until migration is
  complete.

## Provider tools and audit authority

- The authoritative application-layer tool registry owns static provider
  operation policy: identity, adapter capability, executable status, allowed
  modes and workflow states, authorization source, spend permission,
  cacheability, pricing policy, replay class, audit name, and input/output
  schemas.
- Any new provider operation must be registered. Migrate existing operations
  through the single `ToolExecutor` in the accepted ADR order. Once migrated,
  workflow code may not call that gateway method directly.
- Runtime run state, persisted authorization, reservations and balances, cache
  contents, resolved evidence, qualification, normalization, HTTP, and
  credentials remain outside registry metadata.
- The executor validates registry, mode, state, authorization, input, cache,
  cost and claim, output, settlement, and append-only audit lifecycle.
  Unregistered, disabled, wrong-mode, wrong-state, or unauthorized work fails
  before an adapter call.
- The LLM receives no audit writer, mutable log object, credential, or
  unrestricted tool. Application and executor code may append safe events;
  readers and agents must not edit, delete, reorder, or rewrite audit history.

## Persistence, migrations, and historical evidence

- Any persisted-shape or public-resource change requires an explicit
  schema-version decision and migration tests before the writer changes.
- Readers accept every supported historical schema; new writers emit only the
  newest schema. Migrations never invent identity, authorization, evidence,
  usage, or approval facts.
- Validate outer and embedded versions, hashes, and cross-copy identity.
  Corrupt or unverifiable state fails closed before provider or LLM work.
- Preserve frozen prompt/model versions, manifest and eval IDs and hashes,
  legacy idempotency salts, quota keys, request IDs, incident records,
  experiments, and append-only events. Do not rename or destructively rewrite
  historical identifiers.
- `.data/sponsor-radar` and existing spend ledgers are local operational
  evidence. Treat them as read-only unless an explicitly authorized recovery
  is finalizing an already-active claim. Never use that directory for tests.
- Use sanitized, checked-in representative snapshots for migration tests.
  Caches may be invalidated by schema or policy version; run, usage, and audit
  history may not be discarded to make a migration pass.

## Testing and incremental delivery

- Verify changes proportionally. Small documentation, pure-domain, or isolated
  contract changes use the narrowest relevant unit or integration tests.
- Add or run acceptance tests only when application workflow behavior, public
  API semantics, persistence recovery, or a cross-layer contract changes.
- Add or run Playwright only when a rendered user journey, accessibility,
  browser recovery, responsive layout, or a release gate changes.
- For broad or release-critical changes, run lint, typecheck, unit coverage,
  integration, acceptance, evals, production build, and applicable browser
  journeys. Do not rerun expensive suites for unrelated small changes.
- Ordinary tests are deterministic, fixture-backed, network-free, and
  zero-cost. Browser tests force fixture evidence and fixture wording regardless
  of the developer environment.
- Maintain migration fixtures, public-error leakage tests, registry denial
  tests, spend and ambiguous-replay tests, and exact identity/cache tests.
- Do not weaken deterministic eligibility, evidence attribution, no-padding
  behavior, the 90% domain-core coverage floor, or frozen eval gates.

## Paid live calls

- A paid Upriver or OpenAI call requires explicit authorization in the current
  task, its server interlock, a known maximum call/credit/token scope, and an
  isolated persistence directory.
- Paid validation is never part of ordinary tests, `verify`, CI, Playwright,
  or an implicit development command. Browser input may not select live mode,
  supply credentials, or change ceilings.
- Paid provider calls use zero automatic retries. Persist the claim first; on
  timeout, network loss, invalid body, or undocumented state, do not replay and
  settle conservatively.
- Record redacted operation telemetry: request/response identifiers where
  available, latency, rows, cache status, reserved/settled usage, retry count,
  and outcome. Update the API issue register with incidents and residual risk.
- Do not send live Upriver evidence, repository policy, audit history, or
  personal/account data to an LLM without separate data-governance approval.
  Never log or persist keys, authorization headers, raw provider error bodies,
  or prompts containing secrets.

## Documentation responsibilities

- Update the canonical document with behavior: `README.md` for product and
  quick start, `docs/ARCHITECTURE.md` for the current system, `DECISIONS.md`
  and `docs/adr/` for decisions, `docs/ROADMAP.md` for future work,
  `docs/TESTING.md` for executable gates, `docs/RAILWAY_DEPLOYMENT.md` for
  operations, and the API issue register for provider findings.
- Active documents agree on status, limits, schemas, counts, and release
  readiness. Keep them concise and link to evidence instead of duplicating
  incident narratives.
- Move superseded build history to an explicit archive instead of deleting it.
  Historical evidence may retain its original vocabulary and numbers when
  clearly labeled historical.
- Before closing an increment, report exact tests run, paid calls made, usage
  observed, documentation updated, and work intentionally deferred.

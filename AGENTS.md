# Sponsor Winback Radar — engineering instructions

These apply to the whole repo. More-specific `AGENTS.md` files may add
constraints but must not weaken this product contract, spending safety,
persistence compatibility, or evidence-preservation rules.

## Stack and layout

- **Stack:** Next.js 16 (App Router) + React 19, TypeScript 5.9 (strict), Zod 4.
  Tests: Vitest 4; browser: Playwright. pnpm 11.9, Node 24.x (`.nvmrc`; `engines`
  requires ≥ 22.18). Deploy: Railway (`railway.json`).
- **Layout:**
  - `src/radar/` — deterministic domain + application pipeline. Owns every fact.
  - `src/agent/` — the bounded LLM wording layer. Wording only; adds no facts.
  - `src/observability/` — append-only audit.
  - `evals/` — frozen offline eval corpus (`evals/cases/*.json`,
    `evals/frozen-eval-manifest.json`).
  - `tests/{unit,integration,acceptance,live,e2e}/` — network-free by default;
    `live/` is paid and opt-in only.

## Setup

```bash
nvm use               # Node from .nvmrc (24.x)
pnpm install
cp .env.example .env   # fixture/offline defaults; no keys needed for ordinary work
```

## Commands

```bash
pnpm dev             # run the app locally
pnpm typecheck       # tsc --noEmit
pnpm lint            # eslint
pnpm test:unit       # unit + domain-core coverage (90% floor)
pnpm test:integration
pnpm test:acceptance
pnpm eval            # frozen offline eval corpus
pnpm test:all        # typecheck + unit + integration + acceptance + eval
pnpm test:e2e        # Playwright (fixture-forced)
pnpm verify          # lint + test:all + build — the pre-release gate
pnpm build
```

Paid live suites (`pnpm test:live*`) need explicit authorization and keys and are
never part of `verify` or CI — see **Paid live calls**.

## Product contract

- A user submits one YouTube channel, sees concise progress, and gets one concise
  result or one actionable failure.
- The initial submission authorizes exactly one bounded run. Plan, cohort, cost,
  and execution checkpoints are internal controls, not user confirmation screens.
- Eligibility, identity, evidence selection, dates, coverage, result count, and
  spend policy are deterministic. The LLM improves wording only — it may not add
  facts, change qualification, select tools, or alter result count.
- Channel identity is exact and anchored to a verified YouTube channel ID. A
  handle or legacy URL is an input reference, not identity — no display-name
  matching, no silent fuzzy substitution.
- New runs use an independently persisted per-run cost ceiling. Historical spend
  is telemetry and audit evidence, never a shared lifetime shutdown.
- Preserve idempotency, rate limits, durable paid-operation claims, per-run
  preflight, zero automatic replay after ambiguous paid calls, and conservative
  ambiguous settlement.
- Finish and verify one reform wave before the next. Railway deployment is the
  final gate and needs explicit user authorization.

## Public vocabulary and errors

- Public surfaces are rendered UI, accessibility text, and `/api/*` contracts.
- Use product terms: `channel`, `research`, `progress`, `result`, `opportunity`,
  `coverage`.
- Never put `demo`, `pilot`, `fixture`, `phase`, internal approval names, env-var
  names, provider payloads, paths, quota keys, hashes, stack traces, or config
  internals on a public surface.
- Public failures use a closed, typed code union with one reviewed message and
  action per code; unknown, legacy, or unsafe failures map to a generic safe
  failure. Never expose an exception message via regex/substring allowlisting.
- Public fields and source symbols use capability-based names. The pre-release
  `phase3`/`phase4` identifiers (run-phase enum, quota keys, idempotency salts,
  eval/manifest IDs) carried no released data and were renamed to `workflow` /
  `wording` in one clean break; phase-numbered terms now survive only in archived
  build history, baselines, and incident records, kept as history.

## Provider tools and audit authority

- The authoritative tool registry owns static provider-operation policy:
  identity, adapter capability, executable status, allowed modes and states,
  authorization source, spend permission, cacheability, pricing, replay class,
  audit name, and input/output schemas.
- Register any new provider operation; migrate existing ones through the single
  `ToolExecutor` in the accepted ADR order. Once migrated, workflow code must not
  call that gateway method directly.
- Runtime state, persisted authorization, reservations/balances, cache contents,
  resolved evidence, qualification, normalization, HTTP, and credentials stay
  outside registry metadata.
- The executor validates registry, mode, state, authorization, input, cache, cost
  and claim, output, settlement, and append-only audit before and after every
  adapter call. Unregistered, disabled, wrong-mode, wrong-state, or unauthorized
  work fails before the adapter call.
- The LLM gets no audit writer, mutable log, credential, or unrestricted tool.
  Application and executor code may append safe events; no reader or agent may
  edit, delete, reorder, or rewrite audit history.

## Persistence, migrations, and historical evidence

- Any persisted-shape or public-resource change needs an explicit schema-version
  decision and migration tests before the writer changes.
- Readers accept every supported historical schema; writers emit only the newest.
  Migrations never invent identity, authorization, evidence, usage, or approval
  facts.
- Validate outer and embedded versions, hashes, and cross-copy identity. Corrupt
  or unverifiable state fails closed before provider or LLM work.
- Preserve frozen prompt/model versions, manifest/eval IDs and hashes,
  idempotency salts, quota keys, request IDs, incident records, experiments, and
  append-only events. Don't rename or destructively rewrite historical
  identifiers. (The one-time pre-release rename is complete and is not a precedent
  for renaming released data.)
- `.data/sponsor-radar` and existing spend ledgers are local operational
  evidence: read-only unless an explicitly authorized recovery is finalizing an
  already-active claim. Never use that directory for tests.
- Use sanitized, checked-in snapshots for migration tests. Caches may be
  invalidated by schema/policy version; run, usage, and audit history may not be
  discarded to make a migration pass.

## Testing and incremental delivery

- Verify proportionally. Small doc, pure-domain, or isolated contract changes use
  the narrowest relevant unit or integration tests.
- Run acceptance tests when application workflow behavior, public API semantics,
  persistence recovery, or a cross-layer contract changes.
- Run Playwright when a rendered journey, accessibility, browser recovery,
  responsive layout, or a release gate changes.
- For broad or release-critical changes, run lint, typecheck, unit coverage,
  integration, acceptance, evals, production build, and applicable browser
  journeys. Don't rerun expensive suites for unrelated small changes.
- Ordinary tests are deterministic, fixture-backed, network-free, and zero-cost.
  Browser tests force fixture evidence and fixture wording.
- Maintain migration fixtures, public-error leakage tests, registry denial tests,
  spend and ambiguous-replay tests, and exact identity/cache tests.
- Don't weaken deterministic eligibility, evidence attribution, no-padding, the
  90% domain-core coverage floor, or frozen eval gates.

## Paid live calls

- A paid Upriver or OpenAI call requires explicit authorization in the current
  task, its server interlock, a known max call/credit/token scope, and an
  isolated persistence directory.
- Paid validation is never part of ordinary tests, `verify`, CI, Playwright, or
  an implicit dev command. Browser input may not select live mode, supply
  credentials, or change ceilings.
- Paid calls use zero automatic retries. Persist the claim first; on timeout,
  network loss, invalid body, or undocumented state, don't replay — settle
  conservatively.
- Record redacted telemetry: request/response IDs where available, latency, rows,
  cache status, reserved/settled usage, retry count, and outcome. Update the API
  issue register with incidents and residual risk.
- Don't send live Upriver evidence, repo policy, audit history, or personal /
  account data to an LLM without separate data-governance approval. Never log or
  persist keys, authorization headers, raw provider error bodies, or prompts
  containing secrets.

## Documentation responsibilities

- Update the canonical doc with behavior: `README.md` (product + quick start),
  `docs/ARCHITECTURE.md` (current system), `DECISIONS.md` and `docs/adr/`
  (decisions), `docs/ROADMAP.md` (future work; completed history under
  `docs/archive/`), `docs/TESTING.md` (executable gates),
  `docs/RAILWAY_DEPLOYMENT.md` (operations), and the API issue register (provider
  findings).
- Active docs agree on status, limits, schemas, counts, and release readiness.
  Keep them concise; link to evidence instead of duplicating incident narratives.
- Archive superseded build history instead of deleting it; historical evidence
  may keep its original vocabulary and numbers when clearly labeled historical.
- Before closing an increment, report exact tests run, paid calls made, usage
  observed, docs updated, and work intentionally deferred.

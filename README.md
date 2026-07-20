# Sponsor Winback Radar

Sponsor Winback Radar accepts one YouTube channel handle or URL and produces a
small, evidence-backed list of sponsors worth reactivating. The production
live path accepts any exact, public YouTube `@handle` or channel URL that
Upriver can resolve. It does not silently substitute a fuzzy name-search
result.

For a live run, Upriver Similar Creators (Beta) supplies candidates within
0.75–1.25 of the target's subscriber count. The application validates and
deduplicates those results and freezes up to three YouTube peers. Entering the
channel and selecting **Find winback opportunities** authorizes one bounded
run under the server's published policy and credit ceiling. Plan, cohort, and
credit claims remain persisted internal checkpoints; users are not asked to
rubber-stamp peers or costs they cannot edit.

A live lead requires:

1. an older, evidence-backed `explicit_ad` placement on the target;
2. a recent, evidence-backed `explicit_ad` placement on a frozen,
   reach-comparable peer; and
3. an exact normalized sponsor-domain match.

That is a **same-brand reactivation candidate**, not proof of the same product,
campaign, buyer, budget, or agency. Those facts remain explicitly unverified.
The stronger S3 + product-continuity A/B rubric is retained only in the frozen
`@UrAvgConsumer` / Dell-XPS golden fixture and eval corpus.

The product deliberately returns fewer than three results when fewer than
three pass. “No recent placement observed” is not treated as proof that a brand
stopped sponsoring the creator.

## Current implementation gate

**Phase 5 hardening is in progress.** A run begins when the user submits one
exact channel, which is the authorization for that bounded run. The workflow
then advances automatically through immutable planning, persisted internal
plan authorization, a durable non-cancellable resolution claim, frozen cohort
and per-run credit checkpoints, execution, verification, and a
completed/partial/failed outcome. The UI shows compact progress and then the
concise report; it does not expose the internal checkpoint sequence as
separate review screens. Run snapshots, authorization records, quota
reservations, append-only events, and TTL/schema-versioned evidence cache
entries survive server restarts.

The deterministic pipeline alone owns exact target resolution, similarity
filters, peer membership, qualification policy, result count, dates, evidence,
coverage, and credits. The Phase 4 agent can only explain the exact persisted
peer cohort and produce sentence-level wording for already-qualified leads.
It cannot upgrade a same-brand match into product, campaign, or buyer
continuity. Its outputs use opaque IDs, strict runtime schemas, exact
claim/evidence ledgers, a two-call and 1,200-output-token run ceiling, no tools,
and deterministic fallback on refusal, timeout, invalid output, or provider
failure. Generated wording is a separate presentation artifact and cannot
replace the canonical lead.

Network-free fixture evidence and a deterministic structured-output model
fixture remain the safe defaults. Live Upriver execution requires the server-only
combination `UPRIVER_MODE=live`, `UPRIVER_LIVE_WORKFLOW=true`, and
`UPRIVER_API_KEY`; browser input cannot select a mode, supply a key, or raise a
credit ceiling. Paid calls retain the Phase 2 zero-retry rule.

Optional OpenAI wording requires `SPONSOR_RADAR_LLM_MODE=openai`,
`SPONSOR_RADAR_LIVE_LLM=true`, and a server-only `OPENAI_API_KEY`. The adapter
uses strict JSON Schema, `store=false`, an empty tool list, explicit output
limits, one attempt per purpose, and a model pin. Recorded-HTTP tests exercise
this contract without spending money.

Fixture and live cache namespaces are isolated. Credit ceilings are repriced
at each internal checkpoint and enforced again inside the stage-specific live
gateway. Each new run owns an independent ledger with a hard maximum of 160
credits; historical usage is retained but never causes a lifetime shutdown.
The current conservative full-run reservation is 157 credits: one initial
target result plus one forced-fresh execution revalidation,
up to ten provisional Similar Beta results, up to 23 grouped target sponsors,
and up to two grouped sponsors for each of three peers. Similar Beta billing is
not documented; the workflow records requested ceilings and settled
result-based estimates rather than presenting them as provider-confirmed
billing. If a live
resolution or execution is interrupted after its
durable claim, it is never replayed automatically; the run fails closed and
settles the full reservation conservatively.

The normal test suite makes no Upriver or OpenAI API calls and spends no
credits. The
legacy `/api/report` compatibility route remains fixture-only. A separate,
manually enabled six-credit contract smoke is still the smallest paid check.
That smoke passed on July 19, 2026 with six result-based credits and zero
retries.

The July 20 pre-reform baseline passed 221 unit, 110 integration, and 90
acceptance tests plus five frozen eval suites; Wave 0 then added two focused
schema-v1 migration checks. The frozen corpora contain
31 labeled strict-gate cases and 46 adversarial output/policy/budget cases;
known false-positive lead count and result inflation are zero, every generated
material claim requires exact evidence IDs, and labeled macro-F1 is 1.00.

## Run locally

Dependencies are declared in the standard `package.json` file, exact package
versions are locked in `pnpm-lock.yaml`, and the Node version is pinned in
`.nvmrc`.

```bash
nvm install
nvm use
npm install --global pnpm@11.9.0
pnpm install
pnpm dev
```

Open `http://localhost:3000`. In the default fixture mode, enter
`@UrAvgConsumer` to replay the Dell/XPS golden case. In explicitly enabled live
mode, enter any exact public YouTube `@handle` or channel URL and select
**Find winback opportunities**. That single action starts the bounded run; the
page moves from compact research progress directly to the formatted result.
Refreshing the page restores the persisted run.

Useful commands:

```bash
pnpm test:unit
pnpm test:integration
pnpm test:acceptance
pnpm eval
pnpm test:e2e
pnpm test:phase4
pnpm verify
```

The browser check uses an installed Google Chrome and keeps the report route in
fixture mode.

## Where things live

- `app/`: Next.js UI and HTTP route handlers only.
- `src/radar/domain/`: deterministic sponsorship, date, domain, reach, and
  eligibility rules.
- `src/radar/application/`: use cases and ports.
- `src/radar/adapters/`: captured-fixture and bounded live Upriver adapters,
  deterministic evidence cache, and filesystem workflow persistence.
- `src/radar/domain/run-state.ts`: the legal persisted transition graph.
- `app/api/runs/`: create, restore, internally advance, cancel, and resume
  endpoints.
- `src/agent/`: purpose-bound context loader, strict output contracts, bounded
  orchestrator, fixture model, and optional OpenAI adapter.
- `src/observability/`: append-only run/tool/skill/LLM audit events.
- `agent-context/manifest.json`: reviewed hashes, section hashes, authorities,
  and fixed purpose bundles for local policy and pinned Upriver context.
- `tests/`: unit, integration, acceptance, fixture, live opt-in, and browser
  gates.
- `evals/`: quality and safety gates that are stricter than ordinary tests.
- `experiments/` and `spike-results/`: research evidence, not production code.

See [Architecture](docs/ARCHITECTURE.md), [Phased roadmap](docs/ROADMAP.md),
[Testing strategy](docs/TESTING.md), and the
[external API issue register](docs/EXTERNAL_API_ISSUE_REGISTER.md). Detailed
OpenAI request-level evidence is retained in the
[OpenAI live API validation and incident record](docs/OPENAI_LIVE_API_RECORD.md).

Railway configuration and the production smoke checklist are prepared, but
the service has **not** been deployed. Deployment remains the final gate after
the dynamic live path, browser matrix, and controlled paid run are verified.

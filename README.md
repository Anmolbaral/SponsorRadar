# Sponsor Winback Radar

Give it one YouTube channel (handle or URL) and it returns a short, evidence-backed
list of past sponsors worth re-approaching — brands that used to sponsor the
channel and are now active on similar creators.

## How it works

You enter one exact, public YouTube `@handle` or channel URL. There's no fuzzy
name search: the field shows the canonical target (e.g. `We'll research:
youtube.com/@dave2d`) before you submit. Submitting starts one bounded run under
a fixed server-side credit ceiling.

The run then advances on its own — plan → resolve target → pick peers → gather
sponsors → qualify → report — showing compact progress, then the result. For
peers, it asks Upriver's Similar Creators (Beta) for channels within 0.75–1.25×
the target's subscriber count, validates and dedupes them, and locks up to three.

A brand qualifies as a lead only when all three hold:

1. an older, evidence-backed `explicit_ad` on the target,
2. a recent, evidence-backed `explicit_ad` on a locked, reach-comparable peer, and
3. an exact normalized sponsor-domain match.

That's a **same-brand reactivation candidate** — not proof of the same product,
campaign, buyer, budget, or agency. Those stay marked unverified. The report
returns fewer than three leads when fewer qualify, and "no recent placement" is
never treated as proof a brand stopped sponsoring.

Only code decides identity, dates, peers, qualification, counts, evidence, and
credits. The optional LLM only rewords already-qualified leads; it can't add
facts or upgrade a match. If it fails, the prose degrades, never the data.

## Run locally

Node is pinned in `.nvmrc`; dependencies in `package.json` / `pnpm-lock.yaml`.

```bash
nvm install
nvm use
npm install --global pnpm@11.9.0
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

- **Fixture mode (default):** enter `@UrAvgConsumer` to replay the Dell/XPS
  golden case. No network, no credits, no keys.
- **Live mode:** enter any exact public YouTube handle or URL and select
  **Research channel**. Refreshing restores the persisted run.

Live runs are server-gated and require all of `UPRIVER_MODE=live`,
`UPRIVER_LIVE_WORKFLOW=true`, and a server-only `UPRIVER_API_KEY`. The browser
can't choose the mode, supply a key, or raise the ceiling. Optional OpenAI
wording additionally needs `SPONSOR_RADAR_LLM_MODE=openai`,
`SPONSOR_RADAR_LIVE_LLM=true`, and a server-only `OPENAI_API_KEY`.

Each run gets its own ledger capped at **160 credits** (current full-run
reservation: 157). Paid calls never auto-retry: if a live call is interrupted
after it commits, the run fails closed rather than risk double-spending.

## Commands

```bash
pnpm test:unit
pnpm test:integration
pnpm test:acceptance
pnpm eval
pnpm test:e2e
pnpm test:all      # test:phase4 is a legacy alias
pnpm verify
```

The default suite makes no Upriver or OpenAI calls and spends no credits. The
browser check uses installed Google Chrome and keeps the report route in fixture
mode. The smallest paid check is a manually enabled six-credit contract smoke
(last passed July 19, 2026: six credits, zero retries).

Baseline (July 20, 2026): 221 unit, 110 integration, and 90 acceptance tests,
five eval suites, plus two schema-v1 migration checks. Across 31 strict-gate and
52 adversarial cases: zero false-positive leads, zero result inflation, every
claim backed by an evidence ID, macro-F1 1.00.

## Where things live

- `app/` — Next.js UI and HTTP routes.
- `app/api/runs/` — create, restore, advance, cancel, resume.
- `src/radar/domain/` — deterministic sponsorship, date, domain, reach, and
  eligibility rules (`run-state.ts` holds the legal state transitions).
- `src/radar/application/` — use cases and ports.
- `src/radar/adapters/` — fixture and live Upriver adapters, evidence cache,
  filesystem persistence.
- `src/agent/` — context loader, output contracts, bounded orchestrator, fixture
  model, optional OpenAI adapter.
- `src/observability/` — append-only run/tool/LLM audit events.
- `agent-context/manifest.json` — reviewed hashes, authorities, and pinned
  context bundles.
- `tests/` — unit, integration, acceptance, fixture, live opt-in, browser.
- `evals/` — quality and safety gates, stricter than tests.
- `experiments/`, `spike-results/` — research evidence, not production code.

More: [Architecture](docs/ARCHITECTURE.md) · [Roadmap](docs/ROADMAP.md) ·
[Testing](docs/TESTING.md) · [API issue register](docs/EXTERNAL_API_ISSUE_REGISTER.md) ·
[OpenAI live record](docs/OPENAI_LIVE_API_RECORD.md).

## Status

The report experience is complete, but the API/orchestration migration isn't:
the browser still drives internal workflow steps and `/api/runs` returns the
internal run resource, so a public capability DTO and server-owned progression
are still pending.

**Not deployed.** Railway config and a production smoke checklist are ready;
deployment is the final gate after the live path, browser matrix, and a
controlled paid run are verified.

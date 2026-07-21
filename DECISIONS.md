# Sponsor Winback Radar — Decisions

Last updated: July 20, 2026

Durable engineering constraints live in the
[architecture decision records](docs/adr/README.md); this file keeps the product
reasoning and evidence.

Two saved pilots prove the workflow can find and reject sponsorship matches. They
do **not** prove customer demand or willingness to pay.

## The decisions that mattered

**1. A winback tool, not another sponsor directory.** Start with one creator and
one question: which past sponsors are active again on reach-comparable peers, and
so worth re-approaching? The output has an obvious owner and action — a short
outreach queue. Brand research alone scored 4/10 in the pilot, but 8/10 paired
with placement evidence
([pilot](experiments/tech-product-reviewers-reach-matched-2026-07-19/README.md)).
It's a lead-prioritization tool, not a CRM or proof a campaign is live.

**2. Match peers by reach, before looking at overlap.** For a live run, ask
Upriver Similar Creators (Beta) for YouTube channels within 0.75–1.25× the
target's followers, validate and dedupe, and lock up to three peers before
inspecting sponsors — no fuzzy fallback. The first pilot's cohort was 4.87–6.58×
the target's reach and gave five tempting overlaps that all failed the strict
rubric; the reach-matched cohort (0.77–1.08×) gave one match that passed
([comparison](experiments/tech-product-reviewers-reach-matched-2026-07-19/README.md#comparison-with-the-first-pilot)).
The locked cohort and its credit quote are fixed once set; the beta response is
treated as a proposal, not truth.

**3. Separate the live signal from the stronger golden claim.** Two explicit
policies: the frozen `@UrAvgConsumer` / Dell-XPS fixture requires manually
verified target + peer S3 and product continuity; a live run only requires
evidence-backed `explicit_ad` placements on both sides plus an exact
sponsor-domain match, labeled `same_brand_reactivation` with product line,
campaign, and buyer stated as unverified. Exact-domain matching alone merged
unrelated facts — the first pilot's five raw overlaps became zero strict passes
(affiliate evidence, unconfirmed pay, appliance-vs-laptop continuity)
([ledger](experiments/tech-product-reviewers-reach-matched-2026-07-19/verification.json)).
Unknown evidence fails closed for the claim being made.

**4. Return zero to three leads; never pad.** Cap at three, return fewer when
fewer qualify. The reach-matched funnel went 89 target rows → 36 stale resolved
sponsors → 3 recent peer rows → 1 raw match → 1 strict pass
([funnel](experiments/tech-product-reviewers-reach-matched-2026-07-19/derived/analysis.json));
forcing three cards would manufacture confidence. A no-result report is a valid
outcome, and coverage warnings keep "no observed match" from reading as "no
opportunity."

**5. Deterministic eligibility; LLM only for wording.** Code owns identity,
dates, cohort, qualification, sponsorship class, evidence, counts, and credits.
The model may reword an already-qualified ledger — never upgrade
`same_brand_reactivation` into product or campaign continuity. A live v1 test
misspelled a claim ID; runtime grounding rejected it, the report was unchanged,
and a second validation layer was added
([incident](docs/OPENAI_LIVE_API_RECORD.md)). Model failure degrades prose, not
facts.

**6. Keep paid controls inside one authorized run.** Submitting an exact channel
authorizes one run within the server-owned policy and cap. The workflow persists
the plan, cohort, quote, and a non-cancellable execution claim before each paid
step, and never auto-replays an ambiguous paid call — a timeout doesn't reveal
whether the provider billed, and replay can double spend. Separate plan/peer/
credit approval screens were removed: users couldn't edit those values, so the
screens only added clicks. One input, compact progress, one report; every spend
stays attributable and restart-safe.

**7. Offline replay by default; live is an explicit server choice.** Captured
real-data fixtures are the normal runtime and regression oracle; live Upriver and
OpenAI calls need server-only flags and keys. Development stays repeatable,
secret-free, and zero-credit, and reviewers can run the whole product without
provider credentials. The Dell fixture is test data, not a production response
for other creators.

**8. Cache evidence by mode, identity, schema, and policy — not just URL.**
Isolate fixture and live namespaces and bind entries to the normalized channel,
operation, schema, and policy version. A clean rerun of the broad pilot was ~983
credits; the locked cohort reran at ~21 using cached history — reuse matters, but
stale or cross-mode evidence must not authorize a cheaper plan. Creator,
sponsorship, and verification evidence have separate TTLs. Execution re-verifies
the target outside the cache (one extra credit) so a reassigned handle can't
inherit an approved channel ID.

**9. The exact-channel dynamic path is the product boundary.** Live input is any
exact public YouTube handle or URL Upriver resolves to the same identity; the
target gets a 365-day window, peers 90 days, discovery one bounded Similar Beta
request keeping up to three peers. Returning the Dell fixture for another creator
would be a demo illusion. YouTube-only and no fuzzy fallback are deliberate cuts:
if resolution, similarity, or evidence falls short, the run says so instead of
inventing a result.

## What I deliberately didn't build

- **Outreach or CRM automation** — a lead is a reason to research, not a verified
  buyer, budget, or active campaign.
- **Fuzzy creator search or silent fallback** — exact public YouTube identities
  only; ambiguous names belong in a future confirmation flow.
- **Product-continuity claims for live channels** — Upriver's grouped sponsor
  result can't establish product, business unit, buyer, budget, or agency
  continuity.
- **A single opaque "opportunity score"** — separate evidence, recency, reach,
  policy, and coverage are easier to challenge than a blended number.
- **Cross-platform identity or podcasts** — YouTube-only; podcast resolution
  errors showed broadening platforms adds identity work without validating the
  wedge.
- **Buyer/contact enrichment** — fakes a finished sales lead without a source; a
  later integration, once the signal earns trust.
- **LLM-generated facts** — no names, dates, numbers, URLs, or claims outside the
  deterministic ledger.

## Owner confirmations still needed

1. Is the sponsorship-sales owner for an established tech creator the right
   economic buyer?
2. Do the value and pricing hypotheses in the
   [month-one memo](docs/PRODUCT_ROADMAP_MEMO.md) match a real design partner's
   workflow?
3. Do Upriver's result-based credit estimates reconcile with the billing
   dashboard?
4. How does Upriver bill Similar Creators (Beta)? Until confirmed, we reserve one
   creator-result credit per returned beta result.

See the [external API issue register](docs/EXTERNAL_API_ISSUE_REGISTER.md) for
incidents, open questions, and mitigations.

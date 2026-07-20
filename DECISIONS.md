# Sponsor Winback Radar — Decision Record

Last updated: July 20, 2026

Durable engineering constraints and migration boundaries are indexed in
[the architecture decision records](docs/adr/README.md). This file retains the
product narrative and evidence behind those decisions.

This record distinguishes observed evidence from product hypotheses. The two
saved pilots prove that the workflow can find and reject sponsorship matches;
they do **not** prove customer demand or willingness to pay.

## Decisions that mattered

### 1. Build a winback tool, not another sponsor directory

**Alternatives considered:** broad sponsor discovery, a trend dashboard, or a
general brand-research assistant.

**Decision:** start with one creator and answer one operational question:
which past sponsors are showing recent activity on reach-comparable peers and
are therefore worth researching for reactivation?

**Why:** the result has an immediate owner and action—prioritize a small
outreach queue. Existing brand context was useful only after placement evidence
identified a reason to care. In the strict pilot, Brand Research scored 4/10
alone and 8/10 when paired with exact placement evidence
([pilot report](experiments/tech-product-reviewers-reach-matched-2026-07-19/README.md)).

**Consequence:** Sponsor Radar is intentionally a lead-prioritization product,
not a CRM opportunity, contact database, or proof that a campaign remains
active.

### 2. Match peers by reach and content model before looking at overlap

**Alternatives considered:** use the largest recognizable tech channels or
choose peers after inspecting which cohort produced more matches.

**Decision:** for a live run, ask Upriver Similar Creators (Beta) for YouTube
candidates inside a 0.75–1.25 follower window, validate and deduplicate the
response, and freeze up to three peers before inspecting sponsor overlap.
There is no fuzzy search fallback. The frozen cohort is an internal persisted
checkpoint under the user's initial bounded-run authorization, not a separate
yes/no screen.

**Why:** the first cohort was 4.87–6.58 times the target's reach and produced
five tempting domain overlaps; none passed the later strict rubric. The second
cohort was 0.77–1.08 times the target's reach and produced one match, which
passed. This is not a causal experiment—the cohort and rubric changed
together—but it is enough evidence not to present the broad cohort as
comparable ([comparison](experiments/tech-product-reviewers-reach-matched-2026-07-19/README.md#comparison-with-the-first-pilot)).

**Consequence:** discovery is automatic, bounded, and auditable. Peer
membership, the cohort hash, and the maximum credit quote remain explicit,
reviewable internal records and cannot change after the checkpoint. The beta
response is treated as an external proposal, not an unquestioned source of
truth, but users are not interrupted to approve inputs they cannot edit.

### 3. Separate a useful live signal from the stronger golden-fixture claim

**Alternatives considered:** accept the API placement label, coupon/affiliate
signals, or any root-domain overlap; alternatively, rank everything with a
single fuzzy score; or claim product continuity for fresh channels without
supporting product-level evidence.

**Decision:** maintain two explicit qualification policies:

- the frozen `@UrAvgConsumer` / Dell-XPS fixture requires manually verified
  target S3 + peer S3 + product-continuity A/B; and
- a live dynamic run requires evidence-backed `explicit_ad` placements on both
  sides plus an exact normalized sponsor-domain match, and labels the result
  `same_brand_reactivation`.

The live result must state that product line, campaign continuity, and buyer
identity are unverified.

**Why:** exact-domain matching alone merged unrelated commercial facts. The
first pilot's five raw overlaps became zero strict passes: affiliate evidence,
unconfirmed compensation, and Samsung appliance-versus-enterprise-laptop
continuity all failed for different reasons
([verification ledger](experiments/tech-product-reviewers-reach-matched-2026-07-19/verification.json)).
That validates the strict fixture as an excellent regression oracle; it does
not create a scalable product-continuity source for arbitrary channels. A
bounded same-brand reactivation candidate is still useful if its uncertainty
is visible and never promoted into a stronger claim.

**Consequence:** unknown evidence still fails closed for the claim being made.
The production path can identify a defensible research lead without
fabricating product, campaign, budget, agency, or buyer continuity.

### 4. Return zero to three leads and never pad the list

**Alternatives considered:** always produce a top three, show every stale
sponsor, or hide no-result runs.

**Decision:** cap output at three but return fewer when fewer qualify.

**Why:** the reach-matched funnel had 89 cached target rows, 36 stale
domain-resolved sponsors, three recent peer rows, one raw match, and one strict
pass. Turning that into three cards would manufacture confidence
([derived funnel](experiments/tech-product-reviewers-reach-matched-2026-07-19/derived/analysis.json)).

**Consequence:** a no-result report is a valid product outcome. Coverage
warnings remain visible so “no observed match” is not mistaken for “no
opportunity exists.”

### 5. Keep eligibility deterministic; use the LLM only for wording

**Alternatives considered:** let an agent select peers, browse, classify
placements, rank leads, and draft the report end to end; or omit an LLM
entirely.

**Decision:** code owns identity, dates, cohort membership, qualification
policy, sponsorship class, evidence attribution, result count, and credits.
The model may explain an already-locked cohort and reword an already-qualified
evidence ledger. It may not strengthen `same_brand_reactivation` into product
or campaign continuity.

**Why:** a live structured-output v1 test misspelled an opaque claim ID.
Runtime grounding rejected it and the canonical report was unchanged.
Request-specific ID enums and a second validation layer were then added; the
hardened v2 eight-case matrix passed with zero retries
([incident record](docs/OPENAI_LIVE_API_RECORD.md)).

**Consequence:** model failure degrades prose, not facts. The LLM adds polish,
not authority.

### 6. Keep paid-work controls internal to a one-click authorized run

**Alternatives considered:** expose separate plan, peer, and credit confirmation
screens; fan out without persisted bounds; or automatically retry after
timeouts.

**Decision:** submitting an exact channel is the user's authorization for one
run within the published product policy and server-owned maximum. The workflow
automatically persists the plan, exact cohort, stage quote, internal approval
checkpoints, and a non-cancellable execution claim before each paid boundary.
It never automatically replays an ambiguous paid call. If the persisted policy
or quota cannot be honored, it fails closed instead of asking the user to
approve a different or larger run.

**Why:** a timeout does not reveal whether the provider billed or completed
the request. Automatic replay can duplicate spend and evidence. The run state
machine also makes refresh, cancellation before a paid claim, and partial peer
failure honest ([architecture](docs/ARCHITECTURE.md#persistence-and-resume)).
The removed screens offered no meaningful agency because users could not edit
the plan, cohort, or quote; they only added repeated yes/no decisions.

**Consequence:** users see one input, compact progress, and the concise final
report. Internally, each spend and transition remains attributable and
restart-safe. Product simplicity therefore does not weaken quota, idempotency,
audit, or evidence controls.

### 7. Make offline replay the default and live execution an explicit server choice

**Alternatives considered:** always-live development, browser-supplied API
keys, or mocks disconnected from captured provider responses.

**Decision:** captured real-data fixtures are the normal runtime and regression
oracle. Live Upriver and OpenAI calls require separate server-only flags and
keys.

**Why:** ordinary development should be repeatable, secret-free, and
zero-credit. The fixed Dell result is test data, not a production response for
other creators. The live paths accept exact public YouTube identities and
retain opt-in contract smokes, request IDs, redacted telemetry, and hard caps
([testing strategy](docs/TESTING.md#live-tests)).

**Consequence:** reviewers can exercise the complete product without provider
credentials, while a controlled environment can use fresh data.

### 8. Cache evidence by mode, identity, schema, and policy—not just URL

**Alternatives considered:** no cache, a URL-only cache, or a shared fixture/live
cache.

**Decision:** isolate fixture and live namespaces and bind cache entries to the
normalized channel, operation, schema, and policy version. Reprice before
the internal quota checkpoint when an entry expires.

**Why:** the broad pilot's estimated clean rerun cost was about 983 credits,
while the locked-cohort rerun was about 21 credits using cached target history.
The current dynamic live plan has a conservative 157-credit full reservation
inside an independently persisted 160-credit maximum for each run. Reuse is
economically important, but stale or cross-mode evidence must not silently
authorize a cheaper plan.

**Consequence:** creator, sponsorship, and verification evidence have separate
TTLs, and cache misses are recorded in the internal stage quote.
Execution target verification deliberately bypasses the creator cache and
reserves one additional credit so a reassigned handle cannot inherit an
approved channel ID.

### 9. Make the exact-channel dynamic path the product boundary

**Alternatives considered:** keep the live adapter pinned to the one golden
cohort, or accept a name and silently select the closest search result.

**Decision:** production live input is any exact public YouTube handle or
channel URL that Upriver resolves to the same identity. The target receives a
rolling 365-day history window; peers receive a rolling 90-day window.
Discovery uses one bounded Similar Beta request and keeps up to three
reach-comparable peers, frozen by the workflow.

**Why:** returning the Dell fixture for another creator would be a demo
illusion, not a product. Exact identity plus a policy-bound, immutable beta
cohort is a small but real end-to-end slice.

**Consequence:** YouTube-only and no fuzzy fallback are deliberate scope cuts.
If exact resolution, similarity, or sufficient evidence fails, the run reports
that limitation instead of substituting the fixture or inventing a result.

## What I deliberately did not build

- **Automatic outreach or CRM opportunity creation.** The evidence does not
  identify a current buyer, agency, budget, or active campaign. A lead is a
  reason to research, not permission to contact.
- **Fuzzy creator search or silent fallback.** The product accepts exact public
  YouTube identities only. Ambiguous names should produce candidates in a
  future confirmation flow, never an implicit selection.
- **Automatic product-continuity claims for live channels.** Upriver's grouped
  sponsor result does not establish product, campaign, business unit, buyer,
  budget, or agency continuity. Those remain unverified until a sourced
  activation-level API or review workflow exists.
- **A single opaque “opportunity score.”** Separate evidence, recency, reach,
  qualification policy, and coverage are easier to challenge than a blended
  number.
- **Cross-platform identity and podcast support.** The product is YouTube-only.
  Recorded podcast-resolution errors show that broadening platforms would add
  identity work without validating the wedge.
- **Buyer/contact enrichment.** It would create the appearance of a finished
  sales lead without a verified source. This is a candidate partner
  integration only after the prioritization signal earns trust.
- **LLM-generated facts.** The model cannot add names, dates, numbers, URLs, or
  claims outside the deterministic ledger.

## Owner confirmations still needed

1. Whether the sponsorship-sales owner for an established tech creator is the
   right economic buyer.
2. Whether the proposed value and pricing hypothesis in the
   [month-one memo](docs/PRODUCT_ROADMAP_MEMO.md) match an actual design
   partner's workflow.
3. Whether Upriver's result-based credit estimates reconcile to account billing
   in the provider dashboard.
4. How Upriver bills Similar Creators (Beta). Until confirmed, the application
   provisionally reserves one creator-result credit per returned beta result.

See the [external API issue register](docs/EXTERNAL_API_ISSUE_REGISTER.md) for
observed incidents, open provider questions, mitigations, and ownership.

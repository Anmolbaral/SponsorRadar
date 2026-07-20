# Tech Product Reviewer Sponsor Reactivation Pilot

As of July 19, 2026

## Outcome

The experiment is useful as a **human-reviewed lead-prioritization brief**, but it is not yet a reliable, standalone sponsor report.

- Target: [UrAvgConsumer](https://www.youtube.com/@UrAvgConsumer)
- Peers: [MKBHD](https://www.youtube.com/@mkbhd), [Mrwhosetheboss](https://www.youtube.com/@Mrwhosetheboss), and [Linus Tech Tips](https://www.youtube.com/@LinusTechTips)
- Five exact sponsor-domain overlaps were found.
- Manual verification accepted four commercial-placement overlaps and rejected one false positive.
- Brand Research was run for Ridge, EcoFlow, and Samsung.
- Overall usefulness: **6/10**. The combined report is good enough to prioritize outreach research, but not good enough to automate outreach or enter an opportunity into a CRM without more work.

The strongest lead is Ridge. EcoFlow is also actionable. Samsung demonstrates the main weakness of domain-only matching: the target and peer placements came from different product divisions.

## Why these channels are comparable

All four are English-language, creator-led YouTube channels centered on technology and consumer electronics. They review products, publish buying-oriented content, and carry active commercial placements.

| Role | Channel | Subscribers | Upriver categories |
|---|---|---:|---|
| Target | UrAvgConsumer | 3.45M | Technology, Consumer Electronics, Lifestyle |
| Peer | MKBHD | 21.0M | Technology, Consumer Electronics |
| Peer | Mrwhosetheboss | 22.7M | Technology, Consumer Electronics, Tech News & Trends |
| Peer | Linus Tech Tips | 16.8M | Technology, Consumer Electronics, Gaming |

The peers are much larger than the target, so this is an audience-and-format comparison rather than a reach-matched comparison. That is acceptable for testing whether brands are actively buying in the same creator market, but a production model should add a reach band.

## Method

1. Retrieved UrAvgConsumer sponsors observed from 2025-07-19 through 2026-07-19.
2. Grouped sponsor rows by normalized domain.
3. Marked a domain stale when its latest target placement was before 2026-04-20.
4. Retrieved each peer’s sponsors from 2026-04-20 through 2026-07-19.
5. Joined stale target sponsors to recent peer sponsors using exact normalized domain.
6. Opened every matched target and peer video description, checked the disclosure, and resolved tracking links to the final domain.
7. Rejected generic product affiliate links that did not show a brand-specific campaign.
8. Ranked accepted matches using peer breadth, disclosure strength, target history, recency, and product continuity.
9. Ran Upriver Brand Research for the top three.

Upriver’s default placement universe includes explicit sponsorships, promotions, and affiliates. The manual review preserves those distinctions rather than presenting every row as a paid sponsorship.

## Funnel

| Stage | Count |
|---|---:|
| Target API sponsor rows | 89 |
| Unique target domains resolved | 48 |
| Target rows with no usable domain | 40 |
| Domain-resolved stale target sponsors | 36 |
| Peer API sponsor rows | 105 |
| Unique peer domains resolved | 49 |
| Exact raw domain overlaps | 5 |
| Accepted after manual review | 4 |
| Rejected after manual review | 1 |
| Brand Research reports run | 3 |

The 40 unresolved target rows are a major recall limitation. Exact-domain matching is precise when a domain exists, but it silently excludes many candidate brands.

## Every overlap, manually verified

| Domain | Target latest observed | Recent peer evidence | Manual result |
|---|---:|---|---|
| `ridge.com` | 2026-04-12; 4 target placements | MKBHD promotion on 2026-06-09; explicit LTT sponsorship on 2026-05-19 | Accepted with caveat: target evidence is an affiliate/product placement, not disclosed paid sponsorship |
| `dell.com` | 2026-01-09; 2 target placements | LTT product link on 2026-04-23 | Rejected: generic affiliate product link, not a Dell campaign or sponsorship |
| `ohsnap.com` | 2026-03-07; 1 target placement | LTT Ohsnap sale promotion on 2026-06-29 | Accepted with caveat: brand-specific promotions, but no explicit paid disclosure on either side |
| `samsung.com` | 2026-02-22; 1 target placement | LTT Galaxy Book6 showcase on 2026-06-19 | Accepted: target partner disclosure and recent peer brand showcase |
| `ecoflow.com` | 2025-12-01; 1 target placement | LTT EcoFlow offer on 2026-06-11 | Accepted: explicit target sponsorship and recent creator-specific peer promotion |

The full evidence ledger, including video URLs, page dates, excerpts, redirect destinations, and strict-paid-sponsorship status, is in [verification.json](verification.json).

YouTube’s local page date differed from Upriver’s observed date by one day on several uploads because of timezone handling. All cutoff and ranking logic uses Upriver’s dates consistently; the difference did not affect eligibility.

## Top three Brand Research results

### 1. Ridge

**Why it ranked first**

- Four historical UrAvgConsumer placements.
- Recent activity on two peers rather than one.
- One peer placement was explicitly disclosed as a Ridge sponsorship.
- The target placement featured Ridge’s MKBHD-branded commuter backpack, while Ridge was also active on MKBHD itself, creating a strong creator-ecosystem signal.

**What Brand Research added**

- Positioning: minimalist, durable, premium everyday-carry products.
- Tagline: “Elevate Your Everyday.”
- Brand voice: direct, confident, and minimalist.
- Audience: buyers seeking durable, high-quality everyday-carry products.
- Upriver confidence: medium.

**Actionable outreach hypothesis**

Pitch an “everyday carry and creator setup refresh” that reconnects the Commuter backpack with wallet, tracker-card, and travel accessories. The brief should lead with proven UrAvgConsumer product coverage and Ridge’s simultaneous activity on MKBHD and LTT.

**Usefulness**

Useful. The report supplies language for a tailored pitch, while the placement history supplies the actual reason to contact Ridge. It still lacks a marketing contact, active campaign calendar, budget, and agency ownership.

### 2. EcoFlow

**Why it ranked second**

- The target placement explicitly thanked EcoFlow for sponsoring the video.
- The peer placement used a LinusTechTips-specific campaign URL and discount code.
- Both placements concerned portable power, although at different product scales.

**What Brand Research added**

- Positioning: portable power, solar generation, home backup, and energy independence.
- Tagline: “Own Your Energy. Your Way.”
- Brand voice: professional, empowering, and solution-oriented.
- Audience: outdoor users, homeowners, and buyers interested in backup or off-grid power.
- Upriver confidence: high.

**Actionable outreach hypothesis**

Pitch a progression from travel power banks to creator-studio and household backup: “the power stack behind a modern tech home.” UrAvgConsumer’s prior travel-tech sponsorship and LTT’s recent DELTA 3 Ultra promotion make that angle evidence-based.

**Usefulness**

Useful. The brand profile and placement evidence combine into a credible concept. The report still needs current product priorities, geography, retail timing, and the person or agency buying creator media.

### 3. Samsung

**Why it ranked third**

- UrAvgConsumer used `#SamsungPartner` and YouTube’s paid-promotion declaration.
- LTT recently published a dedicated Samsung Galaxy Book6 Enterprise Edition showcase.
- Samsung is an obvious category fit for every selected channel.

**What Brand Research added**

- Positioning: a broad consumer-electronics and smart-home ecosystem with AI-driven features.
- Brand voice: professional, innovative, and customer-focused.
- Audience: general consumers and business users across devices, appliances, and smart technology.
- Upriver confidence: high.

**Actionable outreach hypothesis**

A cross-device “AI home” concept could connect UrAvgConsumer’s prior Bespoke laundry-room partnership to phones, displays, and home devices.

**Usefulness**

Only partly useful. The target placement was for home appliances, while the peer placement was for enterprise laptops. A `samsung.com` join merges separate business units, budgets, agencies, and campaign owners. Brand Research is too broad to resolve that mismatch. This lead requires division-level research before outreach.

## Is the resulting report genuinely useful?

| Dimension | Assessment |
|---|---|
| Lead discovery | Strong: surfaced four manually defensible commercial opportunities |
| Evidence quality | Moderate before review; strong after reviewing descriptions and redirects |
| Brand context | Accurate but generic; mostly equivalent to a concise “About” page synthesis |
| Outreach angle | Good for Ridge and EcoFlow; weak for Samsung without business-unit context |
| Contactability | Poor: no buyer, agency, role, email, or campaign owner |
| Automation readiness | Poor: one of five raw matches was a false positive and two accepted matches were affiliate-led |
| Cost efficiency | Weak for a single pilot unless peer data is cached and reused |

**Verdict:** genuinely useful for deciding which brands deserve another 10–20 minutes of research. Not genuinely useful as a finished sales report or an automated outreach trigger.

## Cost and operating implications

Using the rates exposed by the account:

- 194 sponsor results × 5 credits: approximately 970 credits.
- Four creator profiles × 1 credit: approximately 4 credits.
- Three Brand Research calls × 3 credits: approximately 9 credits.
- Estimated clean rerun: approximately **983 credits**, before any extra placement queries.

The live account endpoint showed 2,883 credits used at the end of this investigative session, which also included rejected-channel screening and diagnostic calls. Its feature-level counters did not update reliably, so the 983-credit production estimate is rate-based rather than a measured request subtotal.

At roughly 10% of a 10,000-credit allowance per clean run, the workflow needs caching and better pre-screening before it scales.

Operational security note: `.env` is ignored, but the API key also appears in local dangling Git object data from earlier work. Rotate it before this repository is shared or pushed.

## Recommended next iteration

Proceed with a second pilot, but change the output contract:

1. Separate `explicit sponsorship`, `brand promotion`, and `affiliate product placement` in every result.
2. Require manual evidence before assigning a sales-ready status.
3. Add product line and business unit; do not treat a conglomerate root domain as sufficient.
4. Add current campaign/product priority, target geography, buyer or agency contact, and a specific outreach trigger.
5. Cache each peer’s 90-day sponsor set so multiple target channels can reuse it.
6. Penalize missing domains and expose the excluded-brand count.
7. Score peer breadth, target relationship depth, evidence strength, recency, and product continuity separately.

## Reproduce

Re-run the analysis against the saved raw responses:

```bash
node experiments/tech-product-reviewers-2026-07-19/analyze.mjs
```

Refresh all Upriver inputs and the three Brand Research reports, then analyze:

```bash
node --env-file=.env experiments/tech-product-reviewers-2026-07-19/collect.mjs
node experiments/tech-product-reviewers-2026-07-19/analyze.mjs
```

Collection uses the documented [Sponsors](https://docs.upriver.ai/api-reference/sponsorships/sponsors), [Batch Creator Details](https://docs.upriver.ai/api-reference/creators/batch-creator-details), and [Brand Research](https://docs.upriver.ai/api-reference/brands/brand-research) endpoints.

## Files

- `config.json`: channels, windows, cutoff, and selected Brand Research domains.
- `verification.json`: manual evidence and verdict for every raw overlap.
- `derived/analysis.json`: full joined analysis with raw API evidence.
- `derived/overlaps.csv`: compact review table.
- `raw/`: paginated API responses and Brand Research payloads.
- `collect.mjs`: repeatable API collection.
- `analyze.mjs`: offline normalization, stale filtering, matching, and exports.

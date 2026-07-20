# Reach-Matched Tech Reviewer Sponsorship Pilot

As of July 19, 2026

## Outcome

The second pilot found **one strict, product-continuous match: Dell's XPS laptop line**.

- Target: [UrAvgConsumer](https://www.youtube.com/@UrAvgConsumer), 3.45M subscribers.
- Reach-matched creator peers: [Dave2D](https://www.youtube.com/@Dave2D), [SarahGrace](https://www.youtube.com/@TheSarahGrace), and [Hayls World](https://www.youtube.com/@HaylsWorld).
- The target's saved 365-day history was reused; it was not fetched again.
- The peers produced three `explicit_ad` API rows in the last 90 days.
- Manual review confirmed all three peer rows as S3 paid sponsorships or partnerships.
- Two peer sponsors had a resolvable domain; one matched a stale target sponsor.
- Dell passed the strict gate with S3 evidence on both channels and grade-A XPS product-line continuity.
- No second or third result was manufactured to fill a list.

**Verdict:** this cohort reflects a narrower and more plausible sponsorship market than the much larger peers did. It gives fewer leads, but the one lead is substantially stronger. The combined Dell brief is useful for prioritizing outreach; Brand Research by itself remains too generic.

## Reach comparability

| Role | Channel | Subscribers | Difference from target | Reach ratio | Upriver categories |
|---|---|---:|---:|---:|---|
| Target | UrAvgConsumer | 3.45M | — | 1.00× | Technology, Consumer Electronics |
| Peer | Dave2D | 3.69M | +7.0% | 1.07× | Consumer Electronics, Technology |
| Peer | SarahGrace | 3.71M | +7.5% | 1.08× | Technology, Consumer Electronics |
| Peer | Hayls World | 2.66M | −22.9% | 0.77× | Technology, Consumer Electronics |

The first pilot's peers ranged from 16.8M to 22.7M subscribers, or roughly 4.87×–6.58× the target's reach. This pilot deliberately uses creator-led channels near the target's scale. Publisher or network channels such as Android Authority and ShortCircuit were not substituted merely because they had denser sponsor histories; doing so would reintroduce a different sales and publishing model.

The peers were fixed before inspecting their sponsor overlap with the target.

## Strict method

This was a focused second pilot, not another exploratory API investigation.

1. Reused the saved UrAvgConsumer 365-day sponsor response from the first pilot.
2. Selected three creator-led consumer-technology peers near 3.45M subscribers.
3. Retrieved only each peer's last 90 days of Upriver `explicit_ad` rows, with evidence.
4. Manually checked every returned placement on its public YouTube page.
5. Resolved sponsor links to a first-party domain when a link existed.
6. Joined manually confirmed S3 peer placements to stale target sponsors by normalized domain.
7. Required S3 evidence on both sides and product-line continuity grade A or B.
8. Ran Brand Research only for the qualifying match.

### Sponsorship classes

| Class | Meaning |
|---|---|
| S3 | Confirmed paid sponsorship or partnership with an attributable public disclosure |
| S2 | Confirmed brand promotion, but compensation is not publicly established |
| S1 | Affiliate link, product mention, or monetized product placement only |
| S0 | Organic/editorial mention |
| SU | Insufficient evidence |

A coupon, affiliate link, or dedicated showcase alone cannot qualify as S3.

### Product-line continuity

| Grade | Meaning |
|---|---|
| A | Same family or direct successor, business unit, and buyer use case |
| B | Adjacent line within the same business unit and use case |
| C | Business-unit or use-case mismatch |
| U | Product line cannot be established |

The strict pass rule is `target S3 + peer S3 + continuity A/B`.

## Funnel

| Stage | Count |
|---|---:|
| Cached target sponsor rows | 89 |
| Domain-resolved stale target sponsors | 36 |
| Stale target rows whose latest API class is `explicit_ad` | 11 |
| Strict peer API rows | 3 |
| Peer rows manually confirmed S3 | 3 |
| S3 peer rows with a usable domain | 2 |
| Raw stale-target domain matches | 1 |
| Strict product-continuous passes | 1 |
| Brand Research reports | 1 |

The 11 target rows are API-explicit candidates, not 11 newly reverified S3 placements. Manual target verification was applied to the only resulting overlap, Dell. That keeps this run focused while preserving a strict final gate.

## All peer placements

| Peer | API sponsor | Manual domain | Strict class | Join result |
|---|---|---|---|---|
| Dave2D | Dell | `dell.com` | S3: explicit sponsor language, `#DellCollab`, and paid-promotion declaration | Matched stale target |
| SarahGrace | Wispr Flow | `wisprflow.ai` | S3: explicit sponsor language and `#WisprFlowPartner` | No target match |
| Hayls World | Bitdefender | unresolved | S3: attributable paid-promotion declaration and hosted brand activation | Excluded from domain join |

The complete page evidence and classification rationale are recorded in [verification.json](verification.json).

## Qualifying match: Dell XPS

| Attribute | UrAvgConsumer history | Recent Dave2D placement |
|---|---|---|
| Video | [This new @Dell XPS is 🔥🔥🔥](https://www.youtube.com/shorts/WqQjK_pfX_c) | [The $599 Dell XPS Laptop](https://www.youtube.com/watch?v=eix1m_BY3Ts) |
| Upriver date | 2026-01-09 | 2026-06-16 |
| Age on pilot date | 191 days | 33 days |
| Strict class | S3 | S3 |
| Product line | XPS 14 / XPS laptops | XPS 13 / XPS laptops |
| Public disclosure | Dell sponsor thanks and `#DellCollab` | Dell sponsor thanks, `#DellCollab`, and paid-promotion declaration |

**Product continuity: A.** Both placements are explicitly sponsored XPS consumer-laptop campaigns. Different XPS models do not break continuity because the product family, Dell client business unit, and buyer use case are the same.

**Outreach hypothesis:** Dell has recently activated the XPS line on a reach-comparable reviewer after UrAvgConsumer's prior XPS sponsorship aged beyond 90 days. That supports researching an XPS refresh or value-focused follow-up. It is a lead hypothesis, not proof that the same campaign or buyer remains active.

## Comparison with the first pilot

| Measure | Large-peer pilot | Reach-matched strict pilot |
|---|---:|---:|
| Peer reach vs. target | 4.87×–6.58× | 0.77×–1.08× |
| Recent peer sponsor API rows | 105, all placement classes | 3, `explicit_ad` only |
| Raw domain overlaps | 5 | 1 |
| Accepted under original inclusive review | 4 | Not used |
| Passes under this strict S3 + continuity rule | 0 | 1 |

Reclassifying the first pilot under this exact rule removes all five of its overlaps:

- Ridge fails because the target evidence was affiliate/product placement rather than S3.
- Dell fails because the old large-peer evidence was a generic affiliate link.
- Ohsnap fails because neither side had confirmed S3 evidence.
- Samsung fails both peer S3 and product-line continuity: appliances and enterprise laptops are different buying units.
- EcoFlow fails because the peer promotion did not publicly establish S3.

This is evidence that the original result quantity was partly driven by larger channels and inclusive placement classes. It is **not a causal estimate of the reach effect**, because the peer reach and the classification rule changed together. A controlled follow-up would apply the same strict query and gate to both peer cohorts.

## Was Brand Research useful?

For Dell, Brand Research accurately summarized the company as a computer and infrastructure vendor serving consumer and enterprise audiences, with a professional and direct voice. It did not identify the XPS campaign, current creator priority, media buyer, agency, geography, or budget.

- Brand Research alone: **4/10**.
- Placement evidence + exact XPS continuity + Brand Research: **8/10** for deciding whether to do deeper account research.
- Finished sales report or outreach trigger: **not yet**. A buyer or agency contact and current campaign validation are still required.

The product-line conclusion comes from the two videos and their Dell destinations, not from the broad Brand Research profile.

## Cost

Using the account's exposed rates and the already cached target history:

- Three peer sponsor results × 5 credits: approximately 15 credits.
- Three creator profiles × 1 credit: approximately 3 credits.
- One Brand Research report × 3 credits: approximately 3 credits.
- Estimated clean locked-cohort run: approximately **21 credits**.

The investigative peer-selection query returned 30 candidates and may add roughly 30 credits if billed per returned creator. That screening call is not required once the cohort is fixed, so it is excluded from the 21-credit repeat-run estimate.

## Reproduce

Re-run the analysis from saved inputs:

```bash
node experiments/tech-product-reviewers-reach-matched-2026-07-19/analyze.mjs
```

Refresh only the three peer sets, profiles, and qualifying Brand Research input, then analyze:

```bash
node --env-file=.env experiments/tech-product-reviewers-reach-matched-2026-07-19/collect-peers.mjs
node experiments/tech-product-reviewers-reach-matched-2026-07-19/analyze.mjs
```

`collect-peers.mjs` intentionally does not request the target's 365-day history.

## Files

- `config.json`: locked cohort, windows, cutoff, and cached target reference.
- `verification.json`: strict rubric and manual evidence for every peer row and overlap.
- `derived/analysis.json`: normalized funnel, reach comparison, and joined evidence.
- `derived/strict-overlaps.csv`: the compact qualifying-match review table.
- `raw/`: saved peer, profile, and Dell Brand Research responses.
- `collect-peers.mjs`: focused refresh script that does not refetch the target.
- `analyze.mjs`: offline domain matching and strict-gate export.

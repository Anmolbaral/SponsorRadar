# The API I Wish Upriver Had

Sponsor Radar needed two things the current API doesn't provide: a sponsorship
record that says who paid whom, backed by evidence, and an async scan endpoint
that runs the target-vs-peer comparison on Upriver's side.

Everything below is a proposal. Freshness targets, pricing, and source rights
need Upriver's confirmation.

## Resource model

### `SponsorshipActivation`

One immutable observation: "this brand sponsored this video." Not a claim that
a campaign is still running.

```json
{
  "id": "act_...",
  "creator": {
    "creator_id": "cr_...",
    "channel_id": "ch_...",
    "platform": "youtube",
    "url": "https://youtube.com/@example"
  },
  "brand": {
    "brand_id": "br_...",
    "name": "Example",
    "canonical_domain": "example.com",
    "identity_confidence": 0.98,
    "identity_evidence_ids": ["ev_redirect_..."]
  },
  "business_unit": {
    "id": "bu_...",
    "name": "Consumer laptops",
    "status": "verified"
  },
  "product_line": {
    "id": "pl_...",
    "name": "ExampleBook",
    "status": "verified"
  },
  "relationship": {
    "paid_status": "confirmed_paid",
    "placement_format": "integrated_ad",
    "disclosure_basis": ["explicit_sponsor_language", "platform_paid_promotion"],
    "confidence": 1
  },
  "content": {
    "url": "https://youtube.com/watch?v=...",
    "published_at": "2026-07-19T14:00:00Z"
  },
  "evidence": [
    {
      "id": "ev_...",
      "source": "description",
      "excerpt": "bounded source excerpt",
      "observed_at": "2026-07-19T16:05:00Z"
    }
  ],
  "coverage": {
    "window_start": "2026-04-20T00:00:00Z",
    "window_end": "2026-07-19T23:59:59Z",
    "last_checked_at": "2026-07-20T00:05:00Z",
    "status": "complete",
    "gaps": []
  },
  "classification_version": "sponsorship-activation-v1"
}
```

Rules:

- `paid_status` separates confirmed paid deals from brand promotion, affiliate
  links, organic mentions, and `unknown`.
- `business_unit` and `product_line` may be `unknown`; they are never guessed
  from a root domain.
- Every inferred field carries its evidence, a confidence score, when it was
  observed, and the classifier version that produced it.
- "No activation observed" only says what was checked in the stated window. It
  is never proof a brand stopped buying.

## Endpoints

### Create a scan — `POST /v1/sponsorship-opportunity-scans`

```json
{
  "target_creator_url": "https://youtube.com/@target",
  "peer_creator_urls": [
    "https://youtube.com/@peer-one",
    "https://youtube.com/@peer-two",
    "https://youtube.com/@peer-three"
  ],
  "as_of": "2026-07-20",
  "windows": {
    "target_days": 365,
    "peer_days": 90,
    "stale_after_days": 90
  },
  "gate": {
    "paid_status": ["confirmed_paid"],
    "product_continuity": ["same_family", "adjacent_same_business_unit"]
  },
  "max_results": 3,
  "include_exclusions": true
}
```

Headers: `X-API-Key`, `Idempotency-Key`.

Response `202 Accepted`:

```json
{
  "id": "scan_...",
  "status": "queued",
  "input_fingerprint": "sha256:...",
  "cohort_snapshot_id": "cohort_...",
  "quoted_credits": 24,
  "quote_expires_at": "2026-07-20T18:00:00Z",
  "data_cutoff": "2026-07-20T12:00:00Z"
}
```

`quoted_credits` is a quote, not a final price. Upriver computes it from what
is already cached and reports the credits actually billed when the scan
completes.

### Read a scan — `GET /v1/sponsorship-opportunity-scans/{scan_id}`

```json
{
  "id": "scan_...",
  "status": "completed",
  "target_creator": {"creator_id": "cr_target", "channel_id": "ch_target"},
  "cohort": {
    "snapshot_id": "cohort_...",
    "selection": "client_supplied",
    "members": [
      {"creator_id": "cr_peer_1", "reach_ratio": 1.07}
    ]
  },
  "opportunities": [
    {
      "brand_id": "br_...",
      "business_unit_id": "bu_...",
      "target_activation_ids": ["act_old_..."],
      "peer_activation_ids": ["act_recent_..."],
      "continuity": {
        "grade": "same_family",
        "reason_codes": ["same_product_line", "same_business_unit"]
      },
      "target_latest_at": "2026-01-09T00:00:00Z",
      "peer_latest_at": "2026-06-16T00:00:00Z",
      "status": "evidence_backed_candidate"
    }
  ],
  "exclusions": [
    {
      "brand_id": "br_other",
      "reason_codes": ["missing_brand_identity", "product_line_unknown"]
    }
  ],
  "coverage": {
    "target": {"status": "partial", "excluded_missing_identity": 40},
    "peers": {"status": "complete", "failed_creator_ids": []}
  },
  "usage": {
    "quoted_credits": 24,
    "billed_credits": 19,
    "reconciliation_id": "usage_..."
  }
}
```

The scan never returns a buyer, agency, budget, or "campaign active" flag
unless a separately sourced record backs it.

Errors: `400` bad windows/limits · `404` creator not found · `409` idempotency
key reused with different input · `422` ambiguous identity / unsupported
platform / invalid cohort · `429` rate limit with `Retry-After` · `503` source
coverage unavailable (returns safe partial results if any).

## How Upriver would build it

### Sources

1. Platform APIs, licensed data, or public content metadata — creator identity,
   publish time, description, paid-promotion markers.
2. Transcripts or ad-segment text where collection is permitted.
3. Outbound links, following redirects within strict limits, to identify the
   brand.
4. Brand and product pages for product line and business unit.
5. Upriver's existing creator graph, taxonomy, sponsor history, and manual
   corrections.
6. Human review of uncertain identity, payment, and product-continuity calls.

Access, retention, and quoting rules need per-platform review; the consumer
build reveals nothing about Upriver's current licenses or ingestion.

### Stages

1. **Discover** — watch tracked creators for new content; remember where each
   source left off and when it was checked.
2. **Extract** — find sponsor mentions, disclosures, links, and ad segments;
   store the evidence before classifying it.
3. **Resolve brand identity** — follow safe redirects, normalize domains and
   aliases, map to a versioned `brand_id`. Never fetch private hosts.
4. **Classify the relationship** — decide paid status separately from placement
   format; weak or conflicting evidence becomes `unknown`, not a guess.
5. **Map products** — link mentions and link destinations to a product line and
   business unit, keeping the candidates and evidence.
6. **Record coverage** — which creator, platform, and window was actually
   checked, including blocked, deleted, or capped sources.
7. **Run the scan** — freeze the peer set, compare the target's sponsor history
   against recent peer activity, apply the continuity gate, return 0–3
   candidates plus exclusions.
8. **Review** — sample confirmed and uncertain results for human review;
   version the labels so corrections re-run affected scans without rewriting
   the original observation.

### Freshness targets

Design targets to validate, not observed SLAs.

| Data | Target | Why |
| --- | --- | --- |
| New activation, priority channels | 6h p95 | Fits a daily/weekly sales workflow without promising real-time. |
| Long-tail channel refresh | 24h | Caps polling cost where urgency is lower. |
| Creator reach/profile | Daily | Reach bands don't need per-minute updates. |
| Redirect / product identity | On new link, then weekly | Destinations change slowly, but links expire. |
| Coverage status | Every scan | A negative result only means something with a current window. |
| Classification changes | Versioned backfill | Prevents history changing silently. |

### Cost

The dominant cost is fetching and enriching content, not comparing it:

```text
daily cost ≈ new content fetches + transcript/ad extraction
           + outbound-link resolution + brand/product classification
           + uncertain-item review + storage and versioned backfills
```

Sharing that work is the point: the broad pilot estimated ~983 Upriver credits
for a clean rerun, while the locked cohort reran at ~21 after reusing the
target's history (result-rate estimates, not infra cost). I'd measure each cost
term by source and channel tier before launch, then price scans from what is
actually not yet cached rather than charging every customer for the same
creator history.

## What breaks at 100×

| Failure mode | Design response |
| --- | --- |
| Platforms block, throttle, or change markup, and coverage quietly shrinks | Per-source adapters with lag metrics and canary checks; report partial coverage explicitly. |
| Many scans re-fetch the same popular peers | One shared activation store with frozen peer snapshots; scans reuse it instead of re-fetching. |
| Brands merge, split, or hide behind link redirectors | A versioned alias graph; merges require evidence and can be reversed; business units stay separate. |
| Transcript and classifier spend grows with all content | Cheap disclosure/link check first; run expensive models only on likely matches; review only what stays uncertain. |
| Evidence gets edited or deleted after the fact | Store evidence immutably with timestamps and content hashes; set a retention policy. |
| A few hot brands dominate the workload | Partition work by creator and brand; update scan results incrementally; shed load under pressure. |
| New classifier versions rewrite history | Version every classification, compare new versions against old before switching, backfill selectively. |
| Redirect fetching reaches private or malicious hosts | DNS/IP allow and deny lists, an egress proxy, hop/size/time limits, no credential forwarding. |
| Human review becomes the bottleneck | Route only low-confidence items to review; accept customer corrections; sample the rest for QA. |

## What I'd cut for v0

- YouTube only.
- Exact target URL plus up to three client-supplied peer URLs; no automatic
  peer recommendation yet.
- Fixed 365-day target / 90-day peer / 90-day staleness defaults, with small
  bounded overrides.
- `confirmed_paid` requires explicit public disclosure; anything uncertain
  returns `unknown`.
- Continuity limited to the same product family or an adjacent line in the same
  business unit; everything else is excluded with a reason.
- Max three results, async, one idempotent scan, no automatic retry after
  ambiguous paid work.
- No buyer/contact enrichment, outreach, budget estimates, or active-campaign
  claims.
- No cross-platform graph, free-text category scan, or full historical
  backfill.

This v0 is narrower than Sponsor Radar's ambitions, but it removes the manual
brand-identity and product-continuity work that consumed the most judgment in
the build, while keeping evidence and coverage honest.

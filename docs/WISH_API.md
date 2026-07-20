# The API I Wish Upriver Had

## Verified sponsorship activations and reactivation scans

Sponsor Radar did not mainly need more prose. It needed one reusable primitive:
an evidenced sponsorship activation with canonical brand, business unit,
product line, paid-status, and coverage. On top of that primitive, Upriver
could expose an asynchronous reactivation scan.

The design below is a proposal. Freshness targets, unit economics, and source
rights require Upriver owner confirmation.

## Resource model

### `SponsorshipActivation`

An immutable observation, not a claim that a campaign is still active.

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

Important semantics:

- `confirmed_paid`, `brand_promotion`, `affiliate`, `organic`, and `unknown`
  are distinct values.
- `business_unit` and `product_line` may be `unknown`; they are never guessed
  merely from a root domain.
- Every inferred field carries evidence, confidence, observation time, and a
  classifier/taxonomy version.
- “No activation observed” is a coverage statement, never proof that a brand
  stopped buying.

## Endpoint sketch

### Create a scan

`POST /v1/sponsorship-opportunity-scans`

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

Headers:

- `X-API-Key: …`
- `Idempotency-Key: …`

Response: `202 Accepted`

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

`quoted_credits` is illustrative contract shape, not a proposed price. Upriver
should calculate it from cache state and return actual billed credits when the
scan completes.

### Read a scan

`GET /v1/sponsorship-opportunity-scans/{scan_id}`

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

The scan does **not** return a buyer, agency, budget, or `campaign_active`
boolean unless a separately sourced resource supports it.

Suggested error semantics:

- `400`: malformed windows or limits;
- `404`: exact creator/channel not found;
- `409`: idempotency key reused with different input;
- `422`: ambiguous creator identity, unsupported platform, or invalid cohort;
- `429`: rate limit with `Retry-After`;
- `503`: source coverage unavailable, with safe partial results if any.

## Producer pipeline

### Proposed sources

1. Platform APIs, feeds, or licensed/public content metadata for creator
   identity, publication time, description, and paid-promotion markers.
2. Transcripts or ad-segment text where collection and use are permitted.
3. Outbound links and bounded redirect resolution for brand identity.
4. First-party brand and product pages for product family and business unit.
5. Upriver's existing creator graph, category taxonomy, sponsor history, and
   manual corrections.
6. Human-review feedback on uncertain identity, compensation, and continuity.

Source access, retention, and quoting rules must be reviewed per platform. The
consumer build provides no evidence about Upriver's current licenses or
internal ingestion architecture.

### Stages

1. **Discover:** enqueue newly published content for tracked creators; retain a
   per-source cursor and immutable observation time.
2. **Extract:** identify sponsor mentions, disclosures, links, and candidate ad
   segments. Store source evidence before classification.
3. **Resolve identity:** expand safe redirects, normalize domains and aliases,
   and map to a versioned canonical `brand_id`. Never fetch private-network
   destinations.
4. **Classify relationship:** separate paid status from placement format.
   Low-confidence or conflicting evidence becomes `unknown`.
5. **Resolve product graph:** map explicit product mentions and destination
   pages to `product_line_id` and `business_unit_id`; retain candidate mappings
   and evidence.
6. **Build coverage:** record which creator, platform, and time window was
   actually checked, including blocked, deleted, capped, and unavailable
   sources.
7. **Compute scan:** freeze the requested cohort, perform the temporal join,
   apply continuity rules, and return 0–3 candidates plus exclusions.
8. **Quality loop:** sample positives and unknowns for human review; version
   labels, re-run affected joins, and expose corrections without rewriting the
   original observation.

### Freshness targets

These are design targets to validate, not observed Upriver SLAs.

| Data | Proposed target | Rationale |
| --- | --- | --- |
| New sponsorship activation on priority channels | 6 hours p95 | Useful for a daily/weekly sales workflow without promising real-time detection. |
| Long-tail channel refresh | 24 hours | Controls polling cost where urgency is lower. |
| Creator reach/profile | Daily | Reach bands do not require per-minute updates. |
| Redirect and product-line identity | On new link, then weekly | Destinations mutate less often but tracking links can expire. |
| Coverage status | Every scan | Negative results are meaningful only with a current observed window. |
| Classification/taxonomy changes | Versioned backfill | Prevent silent historical drift. |

### Cost model

The dominant cost is likely content acquisition and enrichment, not the final
join:

```text
daily cost ≈
  new content fetches
  + transcript/ad extraction
  + outbound-link resolution
  + brand/product entity classification
  + uncertain-item review
  + storage and versioned backfills
```

The consumer evidence shows why shared computation matters: the broad pilot
estimated about 983 Upriver credits for a clean rerun; the locked-cohort pilot
estimated about 21 credits after reusing target history. Those are
result-rate estimates, not producer infrastructure costs.

Producer-side dollar cost per fetch, transcript minute, classifier call,
redirect, stored evidence item, and human-review minute is unknown and requires
owner confirmation. Before launch I would measure each term by source and
channel tier, then price scans from incremental cache misses rather than
charging every customer for the same creator history.

## What breaks at 100×

| Failure mode | Why it appears | Design response |
| --- | --- | --- |
| Platform blocking, quotas, or source-shape drift | Polling and backfills multiply; one markup change can erase coverage. | Source adapters, circuit breakers, per-source lag metrics, canaries, and explicit partial coverage. |
| N-target × N-peer fan-out | Naive scans repeatedly fetch the same popular peers and histories. | Global activation store, cohort snapshots, shared cache, incremental joins, and bounded request limits. |
| Brand identity merges and splits | Redirectors, resellers, short links, and conglomerate domains create false joins. | Versioned alias graph, evidence-backed merges, business-unit boundaries, and reversible corrections. |
| Transcript/classifier spend | Extraction grows with content volume, including content with no sponsor. | Cheap disclosure/link prefilter, batch inference, tiered effort, and review only for uncertainty. |
| Mutable or deleted evidence | Descriptions, redirects, and platform pages change after detection. | Immutable observed evidence, timestamps, content hashes, and retention policy. |
| Hot-brand skew | A few brands and creators generate large join/update fan-out. | Partition by creator and brand, incremental materialized views, and backpressure. |
| Model/taxonomy drift | A new classifier can change historical paid-status or continuity. | Version every classification, shadow-evaluate, and backfill selectively. |
| Unsafe redirect fetching | Tracking URLs can target private or malicious hosts. | DNS/IP allow-deny checks, egress proxy, hop/size/time limits, and no credential forwarding. |
| Quality-review bottleneck | Rare edge cases grow faster than a manual team. | Active-learning queues, uncertainty thresholds, customer correction signals, and sampled QA rather than universal review. |

## What I would cut for v0

- YouTube only.
- Exact target URL and up to three **client-supplied** peer URLs; no automatic
  peer recommendation in the first contract.
- Fixed 365-day target, 90-day peer, and 90-day staleness defaults with small
  bounded overrides.
- Explicit public disclosure required for `confirmed_paid`; uncertainty returns
  `unknown`.
- Product-line continuity limited to same family or adjacent line in the same
  business unit; otherwise exclude with a reason.
- Maximum three results, asynchronous execution, one idempotent scan, and no
  automatic retry after ambiguous paid work.
- No buyer/contact enrichment, outreach generation, budget estimate, or active
  campaign claim.
- No cross-platform creator graph, free-text category scan, or exhaustive
  historical backfill.

That v0 is narrower than Sponsor Radar's eventual product ambitions, but it
would remove the manual identity and continuity work that consumed the most
judgment in the build while preserving honest evidence and coverage.

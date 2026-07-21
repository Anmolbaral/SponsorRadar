# Upriver Consumer Friction Log

Observed July 19–20, 2026 while building Sponsor Winback Radar. Every item is
backed by saved responses, code, or a reproducible analysis in this repo.
Suggestions are consumer requests, not claims about how Upriver works
internally. "Open/unconfirmed" marks a billing or documentation question not
yet checked against provider-side records.

## What worked

- **Sponsor queries fit the product.** One endpoint, filtered by publication,
  date, platform, type, and evidence, served both the target-history and
  recent-peer sides of the comparison
  ([analysis](../experiments/tech-product-reviewers-reach-matched-2026-07-19/derived/analysis.json)).
- **Evidence comes attached.** Rows include content URL, publish date, excerpt,
  source, and confidence; Dell's row named XPS and linked its campaign
  ([Dave2D response](../experiments/tech-product-reviewers-reach-matched-2026-07-19/raw/peer-dave2d-strict-90.json)).
  The UI can show why a lead exists.
- **Creator batch returns exact channels and subscriber counts** (3.45M, 3.69M,
  3.71M, 2.66M), so reach comparability is enforced in code, not guessed.
- **Similar Creators (Beta) enables dynamic peer discovery.** A July 20 live
  run resolved `@DwarkeshPatel` and returned ten candidates in one call
  ([docs](https://docs.upriver.ai/api-reference/creators/find-similar-creators-beta)).
  No hard-coded peer list needed.
- **Errors and pagination are predictable.** Bad inputs returned 400/401 with
  clear JSON messages ([saved probes](../spike-results/raw/)); typed validation
  and bounded paging were easy to build.
- **Coverage metadata exists** (`tracking_status`, `has_more`, `total_count`),
  so "no rows" can be shown as unknown instead of as proof.
- **Brand Research is cheap, useful context** — rated 4/10 alone, 8/10 next to
  placement evidence. Enrichment, not qualification.
- **A six-credit smoke test verified the live adapter** without paying for a
  full report ([testing record](TESTING.md#live-tests)).
- **The live workflow fails honestly.** The July 20 run spent 81 provisional
  credits, returned zero qualified opportunities, and kept a partial report
  instead of inventing a lead
  ([full trace](EXTERNAL_API_ISSUE_REGISTER.md#july-20-full-live-evidence-product-validation)).

## Issues and suggestions

**1. Sponsor identity often can't be joined.**
Seen: 40 of 89 target rows in the broad pilot had no usable domain; the July 20
run had only 8/11 target rows and 2/3 peer rows joinable. Wispr Flow and
Bitdefender both returned `sponsor_domain: null`
([verification](../experiments/tech-product-reviewers-reach-matched-2026-07-19/verification.json)).
Suggest: return a canonical `brand_id`, domain aliases, redirect-based
attribution, and an identity-confidence field. Missing domains silently reduce
recall.

**2. Similar Creators billing is undocumented.**
Seen: the beta reference documents fields but no credit rate. We provisionally
assume one credit per returned result. **Open/unconfirmed.**
Suggest: publish the rate, what counts as a billable event, and a change
policy.

**3. Optional language matching can reject a valid channel.**
Seen: with `match_content_language=true`, the Similar call returned HTTP 409
`anchor_language_not_ready` for `@DwarkeshPatel`; removing that one filter
returned ten rows and three reach-valid candidates
([issue register](EXTERNAL_API_ISSUE_REGISTER.md#upr-009--optional-language-matching-can-reject-a-valid-anchor)).
Suggest: expose readiness before execution, document 409 billing/retry rules,
and define the fallback. We now omit language matching.

**4. The beta response shape could change silently.**
Seen: no break observed, but anchor identity, first-channel qualification,
subscriber counts, and similarity reasons all drive peer selection. **Open
risk.**
Suggest: version the beta schema. Our adapter validates the full shape,
confirms the anchor, and fails closed rather than falling back to fuzzy search.

**5. Batch returns HTTP 200 even when items fail.**
Seen: failures only appear in `successful_count`, `failed_count`, and
per-result `error` fields under a success status.
Suggest: 207-style semantics or an explicit top-level outcome. We require
exactly one requested creator, one success, zero failures, and exact channel
identity before spending.

**6. A placement label doesn't prove a paid deal.**
Seen: all five pilot domain overlaps failed the paid + product-continuity
review; affiliate links and promotions were the recurring false positives.
Suggest: report paid status separately from placement format —
`confirmed_paid`, `brand_promotion`, `affiliate`, `organic`, or `unknown` —
with evidence and confidence.

**7. Root domains are too coarse for large companies.**
Seen: `samsung.com` joined a target home-appliance deal to a peer
enterprise-laptop showcase; strict review rejected it.
Suggest: add business-unit and product-line identities. A brand-level match
doesn't mean the same budget or buyer.

**8. Grouped sponsor rows only include the latest ad.**
Seen: `/v1/sponsors` returns `total_ads_found` plus `most_recent_ad`. We needed
relationship history, so we kept a local ledger and opened public pages.
`/v1/sponsorships` has placement rows but still leaves identity and continuity
to the consumer.
Suggest: an activation resource (or expand option) returning bounded placement
history, product line, disclosure, and coverage in one response.

**9. Empty results and coverage are ambiguous.**
Seen: HTTP 200 with zero rows may or may not mean "no sponsors." In the July 20
run, tracking status was absent for the target and all three peers, one peer
returned zero rows, and one bounded page stopped before the end. None of that
proves a creator had no sponsors.
Suggest: a first-class coverage object — window checked, last-checked time,
completeness, truncation reason, known gaps. We label these states unknown or
partial and never present them as negative evidence.

**10. Brand Research stops before the sales handoff.**
Seen: for Dell it did not identify the XPS campaign, product priority,
geography, buyer, agency, or budget
([assessment](../experiments/tech-product-reviewers-reach-matched-2026-07-19/verification.json)).
Suggest: not necessarily a bug — but the product needs a separately sourced
campaign resource. Unknowns must stay unknown, not be synthesized.

**11. Creator lookup was rough outside YouTube.**
Seen: July 19 probes for podcasts (Acquired, Joe Rogan, Oprah) returned raw
Pydantic "Unsupported platform: podcast" errors; a Spotify URL resolved while a
website URL did not; a documented `GET /v1/creators?url=...` lookup returned
"Unknown query parameter." **Retest before treating as current defects.**
Suggest: normalize public errors, publish supported platforms/URL types in
machine-readable form, and version endpoint behavior.

**12. Fuzzy name search is unreliable.**
Seen: searching "Acquired" returned fashion and unrelated social accounts;
exact URL lookup was dependable.
Suggest: keep exact URL/handle lookup primary. For ambiguous names, return
typed candidates and require confirmation instead of silently picking one.

**13. Usage reporting can't support exact billing.**
Seen: the pilot's end-of-session account total was 2,883 credits, but feature
counters didn't update reliably. Our 983-credit and 21-credit figures are
result-rate estimates. **Needs comparison with the provider dashboard.**
Suggest: per-request billed credits plus a reconciliation ID in every response.
Until then we label totals as estimates, not invoices.

**14. A timed-out paid request can't be resolved.**
Seen: a client timeout cannot prove whether Upriver completed or billed the
request. No duplicate charge was observed, but the ambiguity is inherent.
**Open risk.**
Suggest: idempotency keys and a lookupable request/billing status. We run zero
retries on every paid call, persist a claim before calling, and settle
interrupted reservations conservatively.

## Performance notes (not an SLA)

- Three valid sponsor probes: 0.206–0.480 seconds. One creator resolution:
  3.45 seconds.
- Tiny samples from one environment. The Phase 5 targets (sponsors under two
  seconds, resolution under five) remain provisional.

## The one change with the most leverage

Return a canonical, evidenced **sponsorship activation** instead of making
every consumer rebuild brand identity, paid status, product line, and coverage
from a grouped row plus manual page checks. The proposed contract is in
[WISH_API.md](WISH_API.md).

For manager-facing status and ownership, see the
[external API issue register](EXTERNAL_API_ISSUE_REGISTER.md). OpenAI events
are tracked there, not in this Upriver-specific log.

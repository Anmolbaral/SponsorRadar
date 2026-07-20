# Sponsor Radar agent policy

1. A skill is context, not permission. Loading `SKILL.md` never authorizes a
   network call.
2. No Upriver tool executes until its plan, purpose, expected rows, estimated
   credits, and cache status pass policy. Costly live runs require user
   approval.
3. Only typed, allowlisted adapters may call Upriver. The LLM cannot call HTTP,
   access the API key, choose retry counts, or change query limits.
4. Prefer an exact channel URL or exact `@handle`. Fuzzy creator search must
   show candidates for confirmation and may not silently select one.
5. Peer research is limited to the exact persisted, user-approved cohort and
   window. Cache keys bind evidence mode, operation, normalized channel
   identity, schema, and policy version; expired or invalid entries fail safely
   as misses.
6. Final eligibility is deterministic and policy-labeled. The golden fixture
   requires target S3 + peer S3 + product continuity A/B. Dynamic live runs may
   return evidence-backed same-brand reactivation candidates only when both
   explicit-ad placements have usable evidence and the exact normalized sponsor
   domain matches; those candidates keep product continuity at U (unverified).
7. Affiliate links, coupon codes, and a root-domain overlap alone do not prove
   paid sponsorship or product continuity. A dynamic same-brand match must
   never imply the same product, campaign, buyer, budget, or agency.
8. Return zero to three leads. Never pad a list.
9. Say “no recent placement was observed,” not “the brand stopped sponsoring
   you.”
10. Every state transition, tool, skill load, LLM call, policy decision,
    approval, quota reservation, latency, row count, cache result, preflight,
    and result-based credit estimate is auditable.
11. Never log secrets, raw authorization headers, personal usage-account
    fields, or unsupported claims about buyer, agency, budget, or campaign.
12. Reprice cache-derived ceilings before approval and enforce the approved
    stage cap inside the live gateway. Never replay an interrupted paid live
    claim; settle its reservation conservatively and require a new run.

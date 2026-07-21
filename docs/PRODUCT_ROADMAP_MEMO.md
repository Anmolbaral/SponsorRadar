# Month-One Product Roadmap Memo

**Product:** Sponsor Winback Radar
**Date:** July 20, 2026
**Objective:** determine whether one evidence-backed winback signal can become
a paid weekly workflow.

## Buyer and reason to pay

The first buyer I would test is **the person responsible for outbound
sponsorship sales for an established YouTube creator**: likely a sponsorship
sales lead, talent manager, or creator business manager. The live product
accepts any exact public YouTube handle or channel URL; `@UrAvgConsumer` is the
golden evaluation case, not the production boundary.

Their job is not “find every brand.” It is to decide which past relationships
deserve attention this week. Sponsor Radar shows a smaller set: a prior,
evidence-backed explicit placement has aged; a reach-comparable peer has a
recent evidence-backed explicit placement; and both placements share an exact
normalized sponsor domain. The live output is a same-brand reactivation
candidate. It does not claim that the product, campaign, buyer, budget, or
agency is the same.

The strict pilot found one Dell/XPS lead and rejected all five domain-only overlaps
from the broader pilot under the same final rubric. It also states what it
cannot know: current buyer, agency, budget, and campaign status. That strict
S3 + product-continuity A/B outcome remains a fixture/eval oracle. Dynamic live
runs use the narrower claim above rather than pretending manual product review
generalizes.

The user experience is one input and one action. Submitting the channel
authorizes a single run within the published product policy and server-owned
credit ceiling. The product shows compact progress and then the concise,
evidence-backed result. Plan, cohort, quote, quota, and durable execution
controls stay as internal persisted checkpoints; there is no user-facing
research-plan or peer/credit review screen when the user cannot edit those
values.

**Pricing hypothesis, not a fact:** test $500/month for up to five managed
channels, with a weekly scan and evidence export. Keep that price only if the
tool creates outreach the buyer would otherwise miss or materially reduces
research time. This repository contains no customer interview or
willingness-to-pay evidence; owner confirmation is required.

## Month one

| Week | What I would do | Exit evidence |
| --- | --- | --- |
| 1 — Sell the problem | Interview five sponsorship-sales owners. Observe their stale-sponsor review and have each rank a blinded Sponsor Radar output. Measure current research time and false-positive tolerance. | Two buyers agree to a paid pilot, name the same recurring job, and permit success measurement. Otherwise stop or change buyer. |
| 2 — Repeat the signal | Run arbitrary exact public YouTube channels through exact resolution and Upriver Similar Beta after one bounded-run submit. Internally freeze up to three 0.75–1.25 reach peers and the stage quote without making users review non-editable controls. Keep YouTube-only, reject fuzzy fallback, and label live output as same-brand reactivation with product/campaign/buyer unverified. Queue missing identities and possible product continuity for review. | Buyer-reviewed precision reaches a proposed 80% gate on a historical blinded set; every accepted lead has two-sided evidence, an exact domain join, and visible coverage. This threshold is not a measured result. |
| 3 — Fit the workflow | Add a weekly scan, “new since last review,” dismiss/approve reasons, and CSV export. Defer CRM integration until export behavior repeats. | Two users complete two weekly reviews without help and act on at least one lead each. |
| 4 — Charge and decide | Invoice the pilot, review every verdict, reconcile Upriver costs, and compare outreach created with the prior process. | Renewal intent and evidence that value exceeds data and review cost. Praise without payment or repeated use does not pass. |

## What I would kill

- **Kill automatic LLM wording** if deterministic copy produces the same
  actions; it is presentation, not the moat.
- **Kill dynamic peer discovery** if buyers consistently judge its frozen
  suggestions irrelevant; only then add editable cohort controls or let them
  pin a cohort and spend data budget on evidence.
- **Kill CRM/Slack integrations** until repeated export behavior proves the
  workflow deserves an integration.
- **Kill broad vertical expansion** until one tech design partner uses it
  weekly.
- **Kill the product or change buyer** if no two of five qualified interviews
  convert to a paid pilot, or if a blinded review cannot reach the proposed 80%
  precision without researcher intervention.

## End-of-month decision

Proceed only if a buyer pays, repeats the workflow, and names an outreach
decision changed by the evidence. If it merely produces an interesting report,
stop. Then test whether the underlying verified sponsorship-activation graph
is more valuable as an Upriver API primitive than as this application.

## Scope cut for the take-home

The product is deliberately YouTube-only, exact-identity-only, and capped at
three internally frozen peers. It does not use fuzzy creator fallback,
cross-platform identity resolution, automated outreach, or automatic
product-continuity classification. That cut keeps the result actionable
without making claims the current upstream evidence cannot support. It also
does not expose a fake configuration step: editable peer selection can be
added later only if buyer evidence shows that control is useful.

Railway deployment is the final engineering gate after the dynamic paid path
and browser matrix pass. It is not yet deployed.

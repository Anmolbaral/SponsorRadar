# Senior Engineering Backlog Review

Date: July 20, 2026
Owner: Sponsor Radar application engineering
Source: consolidated senior-engineer review covering money safety, user
experience, API robustness, quality controls, and release hygiene.

## Executive assessment

The review correctly identified a historical money-safety defect: the workflow
could reserve and spend creator resolution before a shared lifetime ledger
could admit the later execution stage. The owner subsequently selected a
different product policy from the backlog's epoch proposal. Each schema-v4 run
now has an independent 160-credit ledger, its immutable complete plan must fit
that maximum before any provider work, and both stage claims reserve atomically
against that run alone. Cross-run concurrency therefore cannot consume another
run's allowance or create a lifetime demo shutdown.

The recommendation to add a mandatory channel-confirmation screen is not being
implemented as written. It conflicts with the recorded one-click product
decision and asks the user to approve data they cannot edit. Its underlying
risk—spending against a mistyped but valid channel—will instead be addressed
with canonical interpretation at the editable input, exact identity validation,
and server-owned spend controls.

Paid validation remains a separate explicit gate, not a side effect of normal
tests. The current per-run increment passed its offline and browser gates.
During browser verification, a local test harness inherited live mode and made
one unplanned but owner-authorized live run; `APP-006` records every call and
the harness is now locked to fixture modes.

## Disposition

| # | Priority | Finding | Disposition | Delivery decision and acceptance criteria |
|---:|:---:|---|---|---|
| 1 | P0 | Whole-run quota admission | **Implemented — verified with owner-selected per-run policy** | Reject a complete plan above 160 before saving a run or calling a provider. Persist the limit and run-specific ledger in schema v3; reserve each stage atomically against that ledger. Tests prove 160 passes, 161 produces zero provider/ledger work, and two cold runs cannot block each other. |
| 2 | P0 | Quota epoch and operator lifecycle | **Superseded — per-run design verified** | There is no renewable lifetime budget and therefore no quota epoch. New runs cannot reserve against the legacy shared ledger. Historical records remain intact; a pre-existing active legacy claim may only finalize without replay. |
| 3 | P0 | Peer-first execution and early exit | **Confirmed — proposed, awaiting approval** | For the live reactivation policy, research the bounded peer set before the target. Skip the expensive target history when no exact, in-window peer row has explicit-ad evidence and a usable domain. The result must say target research was skipped, not claim that no target opportunities exist. |
| 4 | P0 | Truthful quota/configuration errors | **Implemented — verified** | Per-run exhaustion and legacy restart requirements are stable, non-retryable public errors. Configuration and persistence failures instruct the user to contact the demo owner. Internal hashes, keys, field names, and limits are not rendered; rate limiting remains explicitly retryable. |
| 5 | P1 | Mandatory channel confirmation card | **Rejected as written — replacement selected** | Keep one-click authorization. Show the canonical interpretation while the field is still editable and retain exact provider-identity checks. Consider a non-blocking cancel/change grace period only if later spend data justifies the delay. Do not add a second “Run full research” confirmation button. |
| 6 | P1 | Input copy and canonical echo | **Approved — next sequential increment** | Use “Channel handle or URL,” accept bare handles, and show an accessible canonical interpretation while the field is editable. Bind submitted raw identity and provider-verified canonical channel ID to the run. |
| 7 | P1 | Legacy and scheme-less YouTube URLs | **Approved — next sequential increment** | Add `https://` only for exact YouTube hosts; accept `/@handle`, `/channel/ID`, `/user/name`, and `/c/name`; resolve legacy slugs through Upriver and never guess that a slug is a handle. Reject lookalike hosts, video URLs, ambiguity, and identity mismatch before sponsor research. |
| 8 | P1 | Typed persisted run errors | **Confirmed — open** | Replace regex-based message exposure with a closed failure-code mapping. Unknown or legacy unsafe messages become generic. The terminal UI renders the persisted safe message; internal provider/configuration details remain server-only. |
| 9 | P2 | Missing idempotency header | **Confirmed — proposed, awaiting approval** | Return an actionable 400 response for missing, blank, shorter-than-8, or longer-than-200 keys. Share the bounds between the HTTP and application boundaries. Invalid requests must do no workflow/provider work. |
| 10 | P2 | Clean resolution-failure settlement | **Confirmed — open** | Settle a fully received, schema-valid semantic rejection at known result-based usage. Continue settling the full ceiling for timeouts, network failures, interrupted/invalid bodies, and other billing-ambiguous failures. Label the clean-failure amount as an estimate until the provider confirms billing. |
| 11 | P2 | Live-quality regression gates | **Confirmed — elevated** | Persist normalized target/peer labels and similarity reasons with schema migration and hash integrity. Add recorded-response overlap and credits-per-qualified-lead evaluations. Empty overlap produces a coverage notice, not a fabricated lead or an unconditional hard failure. |
| 12 | P2 | Similar language-match feature flag | **Confirmed — open** | Add a strict boolean flag defaulting off. Include the request field and distinct cache policy only when enabled. A provider 409 remains zero-retry, fail-closed, and publicly sanitized while retaining a useful operator diagnostic. |
| 13 | P2 | Development CSP | **Confirmed — proposed, awaiting approval** | Permit `unsafe-eval` only in development for the Next/React overlay. Production and test policies must exclude it and have direct tests. |
| 14 | P3 | Server-side orchestration | **Goal accepted — design must change** | Because initial submit is the sole user authorization, both internal approvals ultimately belong on a durable server worker/lease path. A GET request must not mutate state. Required tests include tab closure, worker restart/reclaim, cancellation before a paid claim, and no ambiguous paid-call replay. |
| 15 | P3 | Legacy `/api/report` route | **Confirmed — proposed, awaiting approval** | Remove it after repository-wide caller verification. `/api/runs` remains the only product workflow contract. If an external consumer is later discovered, restore a temporary 410 response rather than the old parallel behavior. |
| 16 | P3 | Dead `TOOL_REGISTRY` | **Direction superseded — authoritative registry approved for a later increment** | Replace the dead object incrementally with a complete typed operation registry and one `ToolExecutor`. The executor, not workflow branches, will enforce state, mode, authorization, schemas, cache, paid claims, settlement, and append-only audit writes. |
| 17 | P3 | Jargon and phase-name migration | **Valid but underestimated — deferred** | Rename source symbols first; map legacy S-codes at adapter boundaries; preserve frozen evidence, prompt versions, salts, quota keys, and historical manifests; introduce schema-versioned public names and restore tests. This is not safe as a blind search-and-replace. |
| 18 | P3 | Duplicate phase test scripts | **Confirmed — proposed, awaiting approval** | Introduce one `test:all` command, point `verify` at it, and preserve aliases only when a real caller needs them. |
| 19 | P3 | Approval records on terminal/no-op actions | **Confirmed — open** | Check legality/no-op state before recording a new approval while preserving idempotent replay fingerprint validation. A no-op must not change the resource version or approval count; an invalid terminal cancel remains a 409 without a ghost approval. |
| 20 | P3 | Local housekeeping | **Partly valid; destructive advice rejected** | The former shared ledger is retained as history with a 200 maximum, 146 settled estimated credits, 37 reservations, and zero active reservations. It is no longer admission control for new runs and must not be deleted. Keep machine-local settings out of release artifacts and make a deliberate decision on the generic launch fixture. |

## Issues added or retained for manager briefing

### Money and quota

- **Whole-run admission gap — closed:** the immutable plan must fit the
  persisted 160-credit run maximum before any provider work, and atomic stage
  claims share only that run's ledger.
- **Cross-run concurrency risk — removed by policy:** one run cannot reserve
  from another run's allowance. Atomic repository semantics still protect
  concurrent claims within a run.
- **Lifetime-ledger lifecycle gap — superseded:** new runs do not use a
  renewable shared budget. The old ledger is closed to new claims and retained
  as history.
- **Error-state ambiguity — mitigated:** permanent per-run/configuration
  failures are non-retryable and sanitized; request-rate limiting remains
  explicitly retryable.
- **Provider billing ambiguity:** clean semantic failures and interrupted calls
  need different settlement classes; exact failed-call billing still requires
  Upriver confirmation.

### Provider/API quality

- Optional Similar language matching can return a provider 409 for an otherwise
  valid anchor (`UPR-009`); it remains off by default.
- Similar response labels and reasons are currently discarded, preventing
  retrospective cohort-quality diagnosis.
- Provider responses expose result-based usage estimates but do not yet give a
  sufficiently reliable per-request billing reconciliation for every failure
  mode.

### Product and application UX

- The one-click UI is the recorded product decision. Mandatory non-editable
  approvals would recreate the friction already removed in `APP-004`.
- Canonical identity feedback belongs next to the editable input.
- Terminal failures must appear at the point of progress/result with a safe,
  specific action; raw quota keys, hashes, limits, provider payloads, and file
  paths must never be rendered.

### Release and architecture

- Client-driven internal approvals can leave work stalled when a tab closes.
  The long-term solution is a durable server worker/lease, not another
  confirmation screen.
- The repository currently has no initial Git commit or remote. A reviewed
  baseline commit is a release blocker before Railway deployment.
- Railway deployment remains the final project phase, after offline regression,
  browser UX, controlled live smoke, and issue-register reconciliation.

## Verification gates

The work is not complete until all applicable gates pass:

1. Unit, integration, acceptance, evaluation, lint, typecheck, and production
   build.
2. Per-run admission/concurrency tests, changed-configuration restart tests,
   and legacy restore/finalization-without-replay tests.
3. Browser tests covering one-click submission, canonical identity feedback,
   permanent per-run exhaustion with no retry action, request throttling with a retry
   action, safe terminal errors, refresh, cancel, and result rendering.
4. Recorded-response quality tests before any new paid provider run.
5. A controlled live smoke only after the 160-credit run maximum, provider
   modes, and isolated persistence directory are intentionally selected and
   recorded.
6. Update `EXTERNAL_API_ISSUE_REGISTER.md` with the verified outcome, residual
   risk, provider asks, request IDs, and actual credits.

# Wave 0 pre-reform baseline

Captured July 20, 2026 before product-vocabulary, tool-executor, spend-order,
error-contract, or orchestration refactors. This is historical contract
evidence, not a claim that every current surface already satisfies the accepted
product principles.

## Verified baseline

All ordinary tests ran with fixture evidence and fixture wording. No paid
Upriver or OpenAI call was made.

| Gate | Result |
| --- | ---: |
| Lint | Passed |
| TypeScript | Passed |
| Unit | 221 passed |
| Integration | 110 passed |
| Acceptance | 90 passed |
| Frozen eval suites | 5 passed |
| Production build | Passed |
| Development Playwright | 14 passed |
| Domain statements/lines | 98.19% |
| Domain branches | 95.12% |
| Domain functions | 100% |

## Wave 0 additive verification

Wave 0 added no runtime behavior. The two sanitized schema-v1 snapshots were
loaded through the real filesystem repository and migration reader without
constructing a provider gateway or rewriting either source snapshot. The
sanitized usage fixture retained the recorded billing shape without real
account identity.

The proportional post-change gate passed typecheck, lint, 112 integration
tests, and the focused 20-test persistence/provider-contract subset. Acceptance
and Playwright were not rerun because no public behavior or rendered journey
changed; their pre-reform results above remain the captured baseline.

The development browser run reproduced the known React CSP warning because
development currently excludes `unsafe-eval`. The journeys still passed. The
environment-specific CSP correction is intentionally deferred to Wave 10.

## Current public HTTP contract

| Method and path | Current role |
| --- | --- |
| `GET /api/health` | Unauthenticated deployment health response |
| `POST /api/runs` | Create one run; requires JSON, same-origin mutation checks, request rate limiting, and `idempotency-key` |
| `GET /api/runs/:id` | Read a persisted run without mutation |
| `POST /api/runs/:id/actions` | Transitional plan, execution, cancel, and resume actions |
| `POST /api/report` | Legacy fixture-only compatibility route |

Immediate workflow failures use `{ error, code, retryable }`. Persisted run
records are written as workflow schema 4, while readers support schemas 1–4.
The response currently exposes the full persisted workflow resource, including
mode, plan, internal actions and approvals, accounting and reservation IDs,
cohort and quote, report-wording provider/checkpoints, audit events, and
workflow reasons. Wave 8 and Wave 9 replace this with a capability-named public
DTO and server-owned orchestration; the current exposure is observed debt, not
the target contract.

The request boundary already enforces bounded JSON, same-origin mutations,
basic process-local rate limits, and exact YouTube-reference parsing. Missing
or malformed idempotency headers currently fall through generic schema
validation rather than the actionable Wave 6 contract.

## Current rendered journey

The browser accepts one channel, automatically sends the two internal approval
actions, shows progress, and renders the final report, explicit zero-result
state, partial coverage, cancellation, or failure. Refresh restores a saved
run. No user-facing plan, peer, or credit confirmation screen is present.

The baseline intentionally records public copy that Wave 1 will replace:

- input label `Target YouTube channel`;
- placeholder `@channel or youtube.com/@channel`;
- disclosure label `Demo data and performance`;
- generic terminal text `We couldn’t complete this search. No result was produced.`;
- configuration recovery copy referring to a demo owner or service; and
- final-detail wording that exposes AI and credit audit metrics.

The field does not yet show a canonical interpretation while editable, a
restored terminal run does not render its reviewed persisted message, and the
client still recognizes some legacy quota failures by matching raw text.

## Identity, spend, and execution contract

- The parser accepts bare handles, `@handle`, exact YouTube hosts, scheme-less
  URLs, `/@`, `/channel`, `/user`, and `/c` references and rejects common
  non-channel or lookalike inputs.
- Workflow schema 4 binds verified identity into the resolved cohort, proposal,
  and report and performs a forced-fresh execution check before sponsors.
- Current code still permits a historical exact-unique-handle identity without
  a channel ID. ADR 0003 records the stricter Wave 2 direction for new writes.
- Each new run owns an immutable maximum of 160. The current conservative cold
  quote is calculated as 157. Historical shared-ledger usage cannot block a new
  run.
- Paid gateway calls have zero automatic retries, persist claims first, and
  settle ambiguous work conservatively.
- Target sponsor history currently runs before peer history. Wave 5 owns the
  peer-first early exit.

## Persistence and paid-operation safety

The read-only persisted-state inventory found 85 runs and four historical
ledgers. All 65 reservations are settled, active units are zero, no run is in
`resolving` or `executing`, and no persisted paid claim or lock was observed.
The primary legacy ledger retains 37 settled reservations and 146 result-based
estimated units under its historical 200 maximum.

Raw `.data` remains ignored because it contains operational identifiers. The
raw account-usage response is also excluded from release artifacts because it
contains account identity fields. Aggregate inventory, integrity hashes, and
sanitized schema-v1 migration fixtures are preserved in:

- [persistence inventory](../evidence/persistence-inventory-2026-07-20.json);
- [integrity hashes](../evidence/persistence-integrity-2026-07-20.sha256); and
- `tests/fixtures/persistence/`.

The inventory contains 14 schema-v1 and 71 schema-v2 snapshots. Two real
schema-v1 planned/terminal shapes were sanitized because they exercise the
oldest migration boundary; schema-v2 compatibility already has synthetic
acceptance coverage, so no raw schema-v2 operational snapshot was copied.

## Repository hygiene boundary

Before the initial reviewed commit, a read-only object scan found unreachable
local Git objects containing the current Upriver key and account identity from
an earlier, uncommitted workspace snapshot. Those objects are not part of the
reviewed source tree and will not be included in a clean first commit or push,
but they would be exposed if the working directory were copied or archived
with `.git` intact.

The release boundary therefore excludes `.env`, `.data`, `.claude`, `.next`,
the raw account-usage response, generated reports, and machine-local state. The
reviewed baseline must be staged from an explicit manifest, scanned without
printing secret values, committed and tagged, and then have its unreachable
objects pruned and rescanned before the repository directory may be shared.
Rotating the Upriver key remains prudent if this local `.git` directory may
ever have left the workstation.

The staged-tree review found zero matches for the current Upriver and OpenAI
keys, zero common provider-token/private-key matches, zero captured credential
headers, zero absolute workstation paths, and zero excluded paths among 219
staged files. Git's whitespace/error check also passed. This used exact-value
and repository-native pattern scans; `gitleaks` and `trufflehog` were not
installed, which is recorded as a limitation rather than presented as a
third-party scanner result.

Seven volatile CDN signature pairs were also removed from profile-image URLs
in four provider evidence files. The complete profile-image query strings were
stripped, the JSON was reparsed, and the two affected golden-replay hashes were
updated deliberately; identity, reach, sponsor, and qualification fields were
not changed.

## Contract evidence

- `tests/acceptance/workflow-error-contract.test.ts`
- `tests/acceptance/phase3-workflow-route.test.ts`
- `tests/acceptance/phase3-workflow.test.ts`
- `tests/e2e/sponsor-radar.spec.ts`
- `tests/unit/youtube-reach.test.ts`
- `tests/integration/persisted-run-migrations.test.ts`
- `docs/EXTERNAL_API_ISSUE_REGISTER.md`
- `docs/OPENAI_LIVE_API_RECORD.md`

This document is included in the initial reviewed Git baseline. The commit
that contains it is the authoritative source-tree boundary; no deployment work
is part of Wave 0.

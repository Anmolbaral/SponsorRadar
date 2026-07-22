# ADR 0007: Server-owned run orchestration

- Status: Implemented July 22, 2026 via ADR 0008/0009 (the wording stage was deleted at cutover)
- Date: July 20, 2026

## Decision

The initial `POST /api/runs` is the user's sole authorization and will schedule
durable server progression. The public API becomes create, read-only run
retrieval, and only meaningful cancel or recovery actions. A server worker or
lease owns planning, resolution, cohort persistence, paid claims, research,
wording, and terminal completion.

The design must preserve exactly-once persisted transitions, safe lease
reclaim, cancellation before a paid claim, stale-quote handling, and no
automatic replay after ambiguous provider work. Closing the browser must not
stall a run.

## Consequences

The current single-instance filesystem deployment is acceptable for the
take-home, but the orchestration boundary must permit a later durable queue or
database. GET remains read-only throughout the migration.

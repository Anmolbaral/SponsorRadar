# ADR 0001: One-click bounded-run authorization

- Status: Accepted; approval-flow copy obsoleted by ADR 0009 (runs complete inline with no approval checkpoints)
- Date: July 20, 2026

## Decision

Submitting one YouTube channel authorizes exactly one bounded research run
governed by an immutable, versioned plan. The user journey is channel input,
concise progress, and a final result or actionable failure. Plan, cohort, cost,
and paid-operation claims remain durable internal checkpoints; they are not
mandatory confirmation screens when the user cannot edit them.

Policy or quote drift fails closed or requires a new run. Cancellation is
meaningful only before an unclaimed paid operation.

## Consequences

The browser's current hidden approval requests are transitional. ADR 0007
owns their migration to server-controlled progression. This decision does not
remove idempotency, persisted claims, cost ceilings, or audit evidence.

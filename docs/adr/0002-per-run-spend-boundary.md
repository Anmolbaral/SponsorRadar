# ADR 0002: Per-run spend boundary

- Status: Accepted
- Date: July 20, 2026

## Decision

Each new run owns a versioned ledger and immutable maximum, currently 160
credits. The conservative quote is calculated from versioned operation caps,
cache assumptions, and pricing policy; the authoritative registry owns those
references after the ADR 0004 migration. The current uncached quote is 157.
Historical spend never creates a shared lifetime product shutdown, and the
application will not introduce quota epochs for this policy.

Estimated, reserved, result-based settled, ambiguous, request-ID, cache-saving,
and total-run telemetry remain preserved. The legacy shared ledger is retained
as read-only history except safe finalization of an already-active legacy
claim.

## Consequences

Future daily/monthly circuit breakers, spend alerts, administrative pause, and
per-user budgets are separate production controls. Result-based amounts remain
estimates until provider billing is reconciled.

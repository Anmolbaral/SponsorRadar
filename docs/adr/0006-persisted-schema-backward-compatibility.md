# ADR 0006: Persisted-schema backward compatibility

- Status: Accepted; amended by ADR 0009 (legacy-store runs 404 after the cutover)
- Date: July 20, 2026

## Decision

Persisted changes are versioned and additive where practical. Readers accept
every explicitly supported historical version; new writers emit only the
newest. Migrations never invent identity, authorization, evidence, approvals,
or usage. They validate outer and embedded versions and integrity copies, and
fail closed before provider or LLM work when proof is missing.

Historical audit events, prompt and model versions, manifests and hashes,
idempotency salts, quota keys, and incident evidence keep their original
identifiers. Sanitized representative persisted snapshots are checked-in
migration fixtures.

## Consequences

Terminal historical runs remain readable without starting new work. Active
historical runs that lack modern proof require a safe restart. Unknown legacy
public errors map to generic reviewed copy.

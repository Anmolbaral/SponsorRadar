# ADR 0004: Authoritative provider tool registry

- Status: Accepted; migration pending
- Date: July 20, 2026

## Decision

The authoritative registry will live under `src/radar/application/tools/` and
own static operation policy: identity, adapter capability, executable status,
allowed modes and states, authorization source, spend permission, cacheability,
pricing policy, replay class, audit name, and input/output schemas.

Its complete canonical operation-ID set is `resolve_target`,
`list_locked_peers`, `list_target_sponsors`, `list_peer_sponsors`, and
`load_verification_ledger`. Completeness tests fail when the evidence port and
this set differ.

One `ToolExecutor` will validate the registry entry, input, mode, state,
authorization, cache, cost and paid claim, adapter output, settlement, and
append-only audit lifecycle. Runtime evidence, qualification, normalization,
HTTP, secrets, balances, and persisted state remain outside registry metadata.

Migrate in this order: verification ledger, target resolution, peer discovery,
peer sponsorship research, then target sponsorship research. Remove direct
gateway calls and duplicated switches only after each operation passes its
completeness, denial, cost, failure, and audit tests.

## Consequences

Unregistered, disabled, wrong-mode, wrong-state, or unauthorized work fails
before an adapter call. The model never receives registry execution or audit
write capability.

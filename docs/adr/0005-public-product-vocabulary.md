# ADR 0005: Public product vocabulary

- Status: Accepted
- Date: July 20, 2026

## Decision

Rendered UI and public API contracts use channel, research, progress, result,
opportunity, and coverage language. They do not expose build phases; demo,
fixture, or pilot language; internal approvals; provider payloads;
configuration names; ledger internals; paths; keys; or hashes. Public errors
come only from a closed, reviewed typed mapping.

New source and public resource names are capability-based. Historical build
terms remain only in archives, frozen identifiers, evidence, and explicit
backward readers until migrated.

## Consequences

Public-copy leakage tests cover immediate HTTP responses, restored failed
runs, rendered text, and accessibility text. Historical incident evidence is
preserved rather than rewritten.

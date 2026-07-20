# ADR 0003: Exact YouTube channel identity

- Status: Accepted; strict channel-ID migration pending
- Date: July 20, 2026

## Decision

Handles, channel URLs, and legacy `/user` or `/c` URLs are input references.
The definitive identity is one verified, opaque YouTube channel ID. Legacy URLs
are sent intact to the resolver and are never guessed to be handles.

The resolver must yield exactly one YouTube identity. Records sharing the same
channel ID may be deduplicated; missing IDs, different IDs, display-name-only
matches, ambiguity, and identity drift fail before sponsor research. Persist
the ID with its canonical handle/URL, key downstream evidence by ID, and use a
forced-fresh ID comparison before execution.

## Consequences

New writes will not use a handle-only identity fallback. Existing code still
contains a historical exact-unique-handle fallback; Wave 2 must remove it for
new execution without inventing IDs while reading old snapshots.

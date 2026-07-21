# Roadmap

Forward-looking work only. Completed build history (the original Phase 0–5 gates
and evidence) is preserved in
[archive/BUILD_HISTORY.md](./archive/BUILD_HISTORY.md). Current behavior is in
[ARCHITECTURE.md](./ARCHITECTURE.md); active decisions in
[../DECISIONS.md](../DECISIONS.md) and [adr/](./adr/).

## Release status

The product runs end to end offline and against recorded live evidence, but it is
**not deployed**. A production Railway deployment is the final release gate and
requires explicit authorization. The items below remain open before that gate.

## Open work

### Server-owned run orchestration

Internal progression (planning, resolution, cohort persistence, execution claim,
research, report wording) must move to a durable server worker or lease, so a run
completes without the browser driving hidden approval actions. The browser should
only submit and poll, with meaningful cancel/resume recovery.
Decision: [adr/0007-server-owned-run-orchestration.md](./adr/0007-server-owned-run-orchestration.md).

### Authoritative provider tool registry

Static provider-operation policy (identity, capability, allowed modes and states,
authorization source, spend permission, cacheability, pricing, replay class,
audit name, and input/output schemas) should live in one application-layer
registry, with every operation routed through one executor that fails closed
before any adapter call.
Decision: [adr/0004-authoritative-provider-tool-registry.md](./adr/0004-authoritative-provider-tool-registry.md).

### Public capability resource contract

The public API resource still carries internal-only fields on the wire (e.g. the
execution-mode marker used for integrity checks). Add a capability-based public
DTO that omits or redacts internal fields at the serialization boundary, with
leakage tests covering the success and error payloads.

### Cohort-quality signals and language matching

Persist normalized cohort-quality metadata (target and peer labels, similarity
reasons, selection evidence, a metadata version, and an integrity fingerprint),
emit a coverage warning when peer-label overlap is empty, and add an optional,
default-off content-language match that fails closed on a provider conflict, with
a distinct cache policy and no silent fallback.

### Production spend controls

Beyond the per-run ceiling, add operational controls for a live deployment: a
daily/monthly circuit breaker, spend alerts, per-user budgets after
authentication, an administrative pause, and provider-billing reconciliation.
Recorded as future controls in
[adr/0002-per-run-spend-boundary.md](./adr/0002-per-run-spend-boundary.md).

### Release verification and deployment

Run the full browser (Playwright) matrix, accessibility, responsive, and
production smoke checks, then perform the authorized Railway deployment. The UI
must acknowledge work within one second and always show a visible warning when
coverage is below 90%.

Provider issues and unresolved billing assumptions are tracked in
[the external API issue register](./EXTERNAL_API_ISSUE_REGISTER.md).

# ADR 0008: Flag-gated agentic engine

- Status: Accepted
- Date: July 22, 2026

## Context

ADR 0007 accepted server-owned orchestration with implementation pending. The
current engine is a deterministic 15-state workflow in which the LLM rewords
already-decided facts and never chooses work. ADR 0004 and the repo contract
state that the model never receives tool-selection capability.

We are introducing a second engine in which an LLM plans the research: it
decides which provider operation to run next, when the evidence is sufficient,
and when to finalize. This amends ADR 0004 for that engine only, under the
controls below.

## Decision

1. **Engine flag, server-side only.** `SPONSOR_RADAR_ENGINE=legacy|agentic`
   selects the engine at composition time. Default is `legacy`. Unknown values
   fail closed (503). Browser input can never select the engine, mode, keys,
   or ceilings (ADR 0007 holds).
2. **Amendment to ADR 0004.** In the agentic engine the model *proposes* tool
   calls; it never executes them. A broker owns the allowlist, input
   validation, credit preflight, execution through the single `ToolExecutor`,
   and settlement. `TOOL_REGISTRY.llmExposed` remains `false` and continues to
   mean "no direct executor, audit, or credential capability." A separate
   agent tool catalog defines the proposal surface.
3. **Facts stay deterministic.** Qualification, identity verification,
   evidence selection, dates, coverage, and the assembled report are computed
   by code from server-held evidence state. The model chooses what work to do;
   code decides what is true. The model authors no fact-bearing report field.
4. **Autonomy with hard ceilings in code.** No approval gates. Every run is
   bounded by the per-run credit ceiling (ADR 0002, ≤ 160), a loop iteration
   cap, per-call and per-run LLM token ceilings, and a transcript byte
   ceiling. Budget denial is returned to the model as a structured tool
   result; ceilings terminate the run fail-closed.
5. **Data governance.** Provider evidence enters model context only as
   field-allowlisted, truncated projections (no excerpts, no raw provider
   payloads, no content URLs). Tool arguments are reference-based and resolved
   against server-held state, so model output cannot steer a paid call to an
   arbitrary target. This constitutes the recorded data-governance approval
   required by the repo contract for evidence-in-context.
6. **Parallel persistence.** Agentic runs persist in a separate store rooted at
   `${SPONSOR_RADAR_DATA_DIR}/agentic` with schema version `agentic-v1`. The
   legacy store stays byte-identical (ADR 0006). On rollback, agentic run IDs
   404 and the UI self-heals; the legacy engine can never load agentic bytes.
7. **Same public contract.** Agentic runs surface through the existing
   `/api/runs` routes and `WorkflowRunResource` shape with no UI change. Run
   IDs share the `run_` namespace and idempotency-key derivation across
   engines; a flag flip never duplicates a run or its spend.
8. **Recovery is fail-closed in v1.** An interrupted agentic run settles its
   reservation conservatively and terminates as failed; there is no automatic
   replay of ambiguous paid work. Mid-run transcript resume is deferred.

## Parity gate (required before legacy deletion)

- Golden fixture: identical lead set, outcome, and coverage-code set as legacy
  on every `pnpm verify` run.
- Frozen gates green through the agentic engine: strict-gate macro-F1 ≥ 0.90;
  report-quality golden all-pass.
- Credits: agentic spend ≤ legacy on the fixture cohorts; live smoke always
  ≤ 160.
- Reliability: 20 consecutive flake-free fixture acceptance runs; live smoke
  3/3 on separate days.
- Operational drills: kill-mid-loop settles cleanly fail-closed; rollback
  leaves legacy runs unaffected and agentic runs 404-self-healing.

## Consequences

Two engines are maintained until the parity gate passes; the cutover
default-flip and legacy deletion are separate future changes that also amend
ADR 0001's approval-flow copy and mark ADR 0007 implemented. The wire-level
`plan` object on agentic runs is synthesized (honest budget, no approval
semantics). Per-tool capability evals define what each tool must deliver;
the live smoke verifies the same contracts against real providers.

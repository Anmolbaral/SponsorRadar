# ADR 0009: Agentic cutover and legacy engine deletion

- Status: Accepted
- Date: July 22, 2026

## Context

ADR 0008 shipped the flag-gated agentic engine and defined a parity gate for
legacy deletion. On July 22, 2026 the owner decided to cut over fully and
delete the legacy engine and its rollback path in one change, accepting the
gate's remaining items as open risk: live smokes had passed 1 of the 3
required separate days (9 live runs, 8 passed, the one failure led to the
channel_not_found fix recorded in ADR 0008's amendment), and the 20-run soak
and operational drills had not been executed. Fixture parity, the frozen
strict gate, and the credit ceilings were green through the agentic engine
on every verify.

## Decision

1. **Single engine.** `SPONSOR_RADAR_ENGINE` and the engine router are
   removed. `createRunEngineFromEnvironment` composes `AgenticWorkflowService`
   directly. There is no rollback flag; recovery from agentic-engine defects
   is fix-forward (or git revert of the deletion commit).
2. **Wire contract frozen in place.** `run-workflow.ts` is reduced to the
   public wire-contract module: the `WorkflowRunResource`/`WorkflowRunRecord`
   shapes (including legacy-shaped fields the agentic engine synthesizes),
   the public error classes, `MAXIMUM_RUN_CREDITS`, and `runIdFor` with its
   original hash seed. The UI and persisted records are unaffected.
3. **Deleted surfaces.** The 15-state `WorkflowService`, the bounded wording
   agent and its LLM ports/contracts/pinned-context loader, the fixture-only
   `/api/report` route, and their tests, evals, and fixtures. The wording
   stages no longer exist; `wordingAgent` checkpoints are always
   `not_needed`.
4. **Historical legacy runs 404.** The legacy store is retired unread;
   `GET /api/runs/{id}` for a pre-cutover legacy run returns 404 and the UI
   self-heals (amends ADR 0006's readability guarantee). Replaying a legacy
   run's idempotency key mints a fresh agentic run under the same derived id.
5. **Evidence cache preserved.** The read-through cache stays rooted at the
   data-dir root, so pre-cutover cached evidence keeps serving agentic runs.
6. **Frozen eval set re-frozen.** `sponsor-radar-agent-safety-frozen-v1`
   included two corpora that guarded the deleted wording stack
   (agent-output-safety, llm-session-boundary). The set is re-frozen as
   `sponsor-radar-agent-safety-frozen-v2` containing the strict-gate corpus;
   this is a recorded re-freeze, not a silent weakening.
7. **Policy tests survive by conversion.** Acceptance suites that asserted
   surviving policy through the legacy pipeline (qualification, evidence
   integrity, peer-failure policy, registry audit, evidence cache) were
   re-harnessed through `runAgenticReport`; the parity test became a golden
   fixture pin (`agentic-report-golden.test.ts`).

## Consequences

ADR 0007 is implemented (minus the deleted wording stage). ADR 0004's
amendment in ADR 0008 is now the rule: the broker proposal surface is the
only model-facing path. ADR 0001's browser-visible approval copy is obsolete;
runs complete inline with no approval checkpoints. The remaining ADR 0008
gate items (multi-day live smokes, soak, drills) convert into post-cutover
operational checks rather than deletion preconditions.

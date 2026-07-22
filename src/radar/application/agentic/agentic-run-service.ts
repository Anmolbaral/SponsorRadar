import type { AgentLlmPort } from "@/src/agent/llm/agent-llm-port";
import type { AuditEvent } from "@/src/observability/audit";
import { fingerprint } from "@/src/observability/audit";
import type {
  JsonValue,
  StoredRunEvent,
  WorkflowPersistenceRepository
} from "@/src/radar/adapters/persistence";
import { PersistenceConflictError } from "@/src/radar/adapters/persistence";
import type { EvidenceMode } from "@/src/radar/application/ports";
import type { RunEngine } from "@/src/radar/application/run-engine";
import {
  MAXIMUM_RUN_CREDITS,
  RunNotFoundError,
  WorkflowConflictError,
  runIdFor,
  type ApproveExecutionInput,
  type ApprovePlanInput,
  type MutateRunInput,
  type WorkflowGatewayFactory,
  type WorkflowRunError,
  type WorkflowRunRecord,
  type WorkflowRunResource
} from "@/src/radar/application/run-workflow";
import type { WinbackReport } from "@/src/radar/domain/types";
import {
  composeAgenticRun,
  type ComposedAgenticRun
} from "@/src/radar/application/agentic/run-agentic-report";
import { AgentChannelNotFoundError } from "@/src/radar/application/agentic/tool-broker";
import { AGENT_TRANSCRIPT_SCHEMA_VERSION } from "@/src/radar/application/agentic/transcript";

export const AGENTIC_RUN_SCHEMA_VERSION = "agentic-v1";
const AGENTIC_QUOTA_KEY_PREFIX = "agentic-run-credits-v1";
const DEFAULT_OPERATION_LEASE_MS = 2 * 60_000;

export type AgenticRunState =
  | "resolving_cohort"
  | "gathering_evidence"
  | "completed"
  | "partial"
  | "no_eligible_peers"
  | "failed"
  | "cancelled";

export interface AgenticRunRecord {
  schemaVersion: typeof AGENTIC_RUN_SCHEMA_VERSION;
  engine: "agentic";
  runId: string;
  requestedChannel: string;
  mode: EvidenceMode;
  state: {
    state: AgenticRunState;
    createdAt: string;
    updatedAt: string;
  };
  budget: {
    maximumCredits: number;
    settledCredits: number;
    iterationsUsed: number;
    maxIterations: number;
  };
  reservationId: string | null;
  resolvedCohort: WorkflowRunRecord["resolvedCohort"];
  report: WinbackReport | null;
  error: WorkflowRunError | null;
  auditEvents: AuditEvent[];
  llm: { provider: string; model: string };
}

const TERMINAL_AGENTIC_STATES: ReadonlySet<AgenticRunState> = new Set([
  "completed",
  "partial",
  "no_eligible_peers",
  "failed",
  "cancelled"
]);

export function isTerminalAgenticState(state: AgenticRunState): boolean {
  return TERMINAL_AGENTIC_STATES.has(state);
}

export class AgenticRunCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgenticRunCorruptionError";
  }
}

/** Fail-closed reader for persisted agentic-v1 records (ADR 0006). */
export function parseAgenticRun(value: unknown): AgenticRunRecord {
  const record = value as Partial<AgenticRunRecord> | null;
  if (
    record === null ||
    typeof record !== "object" ||
    record.schemaVersion !== AGENTIC_RUN_SCHEMA_VERSION ||
    record.engine !== "agentic" ||
    typeof record.runId !== "string" ||
    typeof record.requestedChannel !== "string" ||
    (record.mode !== "fixture" && record.mode !== "live") ||
    record.state === null ||
    typeof record.state !== "object" ||
    typeof record.state.state !== "string" ||
    typeof record.state.createdAt !== "string" ||
    typeof record.state.updatedAt !== "string" ||
    record.budget === null ||
    typeof record.budget !== "object" ||
    !Number.isInteger(record.budget.maximumCredits) ||
    !Number.isInteger(record.budget.settledCredits) ||
    !Number.isInteger(record.budget.iterationsUsed) ||
    !Number.isInteger(record.budget.maxIterations) ||
    record.llm === null ||
    typeof record.llm !== "object" ||
    typeof record.llm.provider !== "string" ||
    typeof record.llm.model !== "string" ||
    !Array.isArray(record.auditEvents)
  ) {
    throw new AgenticRunCorruptionError(
      "The persisted agentic run record failed validation"
    );
  }
  const validStates: readonly string[] = [
    "resolving_cohort",
    "gathering_evidence",
    "completed",
    "partial",
    "no_eligible_peers",
    "failed",
    "cancelled"
  ];
  if (!validStates.includes(record.state.state)) {
    throw new AgenticRunCorruptionError(
      `Unknown agentic run state: ${record.state.state}`
    );
  }
  return record as AgenticRunRecord;
}

export interface AgenticWorkflowServiceOptions {
  repository: WorkflowPersistenceRepository;
  gatewayFactory: WorkflowGatewayFactory;
  mode: EvidenceMode;
  /** Null when the engine flag is off: reads and recovery stay available. */
  llm: AgentLlmPort | null;
  runCreditLimit?: number;
  maxIterations?: number;
  clock?: () => number;
  operationLeaseMs?: number;
}

export class AgenticEngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgenticEngineUnavailableError";
  }
}

/**
 * The autonomous engine behind SPONSOR_RADAR_ENGINE=agentic (ADR 0008).
 * Runs the whole research loop inline in createRun, persists per-iteration
 * heartbeats into the parallel agentic store, and surfaces runs through the
 * legacy `WorkflowRunResource` wire shape so the UI needs no change.
 */
export class AgenticWorkflowService implements RunEngine {
  private readonly repository: WorkflowPersistenceRepository;
  private readonly gatewayFactory: WorkflowGatewayFactory;
  private readonly mode: EvidenceMode;
  private readonly llm: AgentLlmPort | null;
  private readonly runCreditLimit: number;
  private readonly maxIterations: number | undefined;
  private readonly clock: () => number;
  private readonly operationLeaseMs: number;

  constructor(options: AgenticWorkflowServiceOptions) {
    this.repository = options.repository;
    this.gatewayFactory = options.gatewayFactory;
    this.mode = options.mode;
    this.llm = options.llm;
    this.runCreditLimit = Math.min(
      options.runCreditLimit ?? MAXIMUM_RUN_CREDITS,
      MAXIMUM_RUN_CREDITS
    );
    this.maxIterations = options.maxIterations;
    this.clock = options.clock ?? Date.now;
    this.operationLeaseMs =
      options.operationLeaseMs ?? DEFAULT_OPERATION_LEASE_MS;
  }

  async hasRun(runId: string): Promise<boolean> {
    return (await this.repository.readRunSnapshot(runId)) !== null;
  }

  async createRun(
    requestedChannel: string,
    idempotencyKey: string
  ): Promise<WorkflowRunResource> {
    const runId = runIdFor(idempotencyKey);
    const existing = await this.repository.readRunSnapshot(runId);
    if (existing) {
      return this.getRun(runId);
    }
    if (!this.llm) {
      throw new AgenticEngineUnavailableError(
        "The agentic engine has no planner LLM configured"
      );
    }

    const nowIso = new Date(this.clock()).toISOString();
    let record: AgenticRunRecord = {
      schemaVersion: AGENTIC_RUN_SCHEMA_VERSION,
      engine: "agentic",
      runId,
      requestedChannel,
      mode: this.mode,
      state: {
        state: "resolving_cohort",
        createdAt: nowIso,
        updatedAt: nowIso
      },
      budget: {
        maximumCredits: this.runCreditLimit,
        settledCredits: 0,
        iterationsUsed: 0,
        maxIterations: this.maxIterations ?? 12
      },
      reservationId: null,
      resolvedCohort: null,
      report: null,
      error: null,
      auditEvents: [],
      llm: { provider: this.llm.provider, model: this.llm.model }
    };

    let revision: number;
    try {
      const saved = await this.repository.saveRunSnapshot({
        runId,
        valueSchemaVersion: AGENTIC_RUN_SCHEMA_VERSION,
        value: toJson(record),
        expectedRevision: null
      });
      revision = saved.revision;
    } catch (error) {
      if (error instanceof PersistenceConflictError) {
        return this.getRun(runId);
      }
      throw error;
    }

    const reservation = await this.repository.reserveQuota({
      quotaKey: `${AGENTIC_QUOTA_KEY_PREFIX}:${runId}`,
      runId,
      idempotencyKey,
      requestedUnits: this.runCreditLimit,
      maximumUnits: this.runCreditLimit
    });
    record = { ...record, reservationId: reservation.value.reservationId };

    const gateway = this.gatewayFactory({ mode: this.mode, runId });
    const composed = composeAgenticRun(
      { channel: requestedChannel, maximumCredits: this.runCreditLimit },
      gateway,
      this.llm,
      {
        runId,
        now: this.clock,
        maxIterations: this.maxIterations,
        transcriptSink: async (event) => {
          await this.repository.appendRunEvent({
            runId,
            eventSchemaVersion: AGENT_TRANSCRIPT_SCHEMA_VERSION,
            event: toJson(event)
          });
          if (event.kind === "budget") {
            record = this.heartbeat(record, composed, event.iteration);
            revision = await this.saveHeartbeat(record, revision);
          }
        }
      }
    );

    try {
      const report = await composed.run();
      record = this.terminalRecord(record, composed, report);
    } catch (error) {
      record = {
        ...this.heartbeat(record, composed, record.budget.iterationsUsed),
        state: {
          ...record.state,
          state: "failed",
          updatedAt: new Date(this.clock()).toISOString()
        },
        error:
          error instanceof AgentChannelNotFoundError
            ? {
                code: "channel_not_found",
                message: error.message,
                retryable: false
              }
            : {
                code: "research_failed",
                message:
                  "We couldn’t complete this research right now. Start a new search or try again later.",
                retryable: false
              },
        auditEvents: composed.audit.getEvents() as AuditEvent[]
      };
    }

    await this.settleReservation(record);
    revision = await this.saveHeartbeat(record, revision);
    return this.toResource(record, revision);
  }

  async getRun(runId: string): Promise<WorkflowRunResource> {
    const snapshot = await this.repository.readRunSnapshot(runId);
    if (!snapshot) {
      throw new RunNotFoundError(runId);
    }
    const record = parseAgenticRun(snapshot.value);
    return this.toResource(record, snapshot.revision);
  }

  async approvePlan(
    runId: string,
    _input: ApprovePlanInput
  ): Promise<WorkflowRunResource> {
    await this.assertRunExists(runId);
    throw new WorkflowConflictError(
      "Agentic runs are autonomous and have no plan approval checkpoint"
    );
  }

  async approveExecution(
    runId: string,
    _input: ApproveExecutionInput
  ): Promise<WorkflowRunResource> {
    await this.assertRunExists(runId);
    throw new WorkflowConflictError(
      "Agentic runs are autonomous and have no execution approval checkpoint"
    );
  }

  async cancelRun(
    runId: string,
    _input: MutateRunInput
  ): Promise<WorkflowRunResource> {
    await this.assertRunExists(runId);
    throw new WorkflowConflictError(
      "An autonomous run holds a durable paid claim and cannot be cancelled mid-flight"
    );
  }

  /**
   * Recovery is fail-closed in v1 (ADR 0008): an interrupted run settles its
   * reservation conservatively at the full ceiling and terminates as failed.
   * Ambiguous paid work is never replayed.
   */
  async resumeRun(
    runId: string,
    input: MutateRunInput
  ): Promise<WorkflowRunResource> {
    const snapshot = await this.repository.readRunSnapshot(runId);
    if (!snapshot) {
      throw new RunNotFoundError(runId);
    }
    const record = parseAgenticRun(snapshot.value);
    if (isTerminalAgenticState(record.state.state)) {
      throw new WorkflowConflictError(
        "This research already finished and cannot be resumed"
      );
    }
    if (input.expectedVersion !== snapshot.revision) {
      throw new WorkflowConflictError(
        "This research changed while it was running"
      );
    }
    if (!this.leaseExpired(record)) {
      throw new WorkflowConflictError(
        "This research is still progressing and cannot be recovered yet"
      );
    }

    const failed: AgenticRunRecord = {
      ...record,
      state: {
        ...record.state,
        state: "failed",
        updatedAt: new Date(this.clock()).toISOString()
      },
      budget: {
        ...record.budget,
        settledCredits: record.budget.maximumCredits
      },
      error: {
        code: "research_interrupted",
        message: "This research was interrupted. Start a new search.",
        retryable: false
      }
    };
    if (failed.reservationId) {
      await this.repository.finalizeQuotaReservation({
        quotaKey: `${AGENTIC_QUOTA_KEY_PREFIX}:${runId}`,
        reservationId: failed.reservationId,
        idempotencyKey: `${input.idempotencyKey}:settle`,
        outcome: "settled",
        actualUnits: failed.budget.maximumCredits
      });
    }
    const saved = await this.repository.saveRunSnapshot({
      runId,
      valueSchemaVersion: AGENTIC_RUN_SCHEMA_VERSION,
      value: toJson(failed),
      expectedRevision: snapshot.revision
    });
    return this.toResource(failed, saved.revision);
  }

  private heartbeat(
    record: AgenticRunRecord,
    composed: ComposedAgenticRun,
    iteration: number
  ): AgenticRunRecord {
    const resolved = composed.state.resolved;
    const peers = composed.state.peers;
    return {
      ...record,
      state: {
        ...record.state,
        state: peers === null ? "resolving_cohort" : "gathering_evidence",
        updatedAt: new Date(this.clock()).toISOString()
      },
      budget: {
        ...record.budget,
        settledCredits: composed.budget.snapshot().resultBasedCredits,
        iterationsUsed: Math.max(record.budget.iterationsUsed, iteration)
      },
      resolvedCohort: resolved
        ? {
            target: resolved.target,
            identity: resolved.identity,
            peers: (peers ?? []).map((peer) => ({
              name: peer.name,
              url: peer.url,
              subscriberCount: peer.subscriberCount,
              creatorId: peer.creatorId
            }))
          }
        : null,
      auditEvents: composed.audit.getEvents() as AuditEvent[]
    };
  }

  private terminalRecord(
    record: AgenticRunRecord,
    composed: ComposedAgenticRun,
    report: WinbackReport
  ): AgenticRunRecord {
    const base = this.heartbeat(record, composed, record.budget.iterationsUsed);
    const noPeers = (base.resolvedCohort?.peers.length ?? 0) === 0;
    const visiblyPartial = report.coverage.some(
      (notice) =>
        notice.code === "peer_research_partial" ||
        notice.code === "upriver_result_cap"
    );
    return {
      ...base,
      state: {
        ...base.state,
        state: noPeers ? "no_eligible_peers" : visiblyPartial ? "partial" : "completed",
        updatedAt: new Date(this.clock()).toISOString()
      },
      report
    };
  }

  private async settleReservation(record: AgenticRunRecord): Promise<void> {
    if (!record.reservationId) {
      return;
    }
    // channel_not_found ends deterministically with known spend; only
    // ambiguous failures settle conservatively at the full ceiling.
    const conservative =
      record.state.state === "failed" &&
      record.error?.code !== "channel_not_found";
    await this.repository.finalizeQuotaReservation({
      quotaKey: `${AGENTIC_QUOTA_KEY_PREFIX}:${record.runId}`,
      reservationId: record.reservationId,
      idempotencyKey: `${record.runId}:terminal-settle`,
      outcome: "settled",
      actualUnits: conservative
        ? record.budget.maximumCredits
        : record.budget.settledCredits
    });
  }

  private async saveHeartbeat(
    record: AgenticRunRecord,
    expectedRevision: number
  ): Promise<number> {
    const saved = await this.repository.saveRunSnapshot({
      runId: record.runId,
      valueSchemaVersion: AGENTIC_RUN_SCHEMA_VERSION,
      value: toJson(record),
      expectedRevision
    });
    return saved.revision;
  }

  private async assertRunExists(runId: string): Promise<void> {
    if (!(await this.hasRun(runId))) {
      throw new RunNotFoundError(runId);
    }
  }

  private leaseExpired(record: AgenticRunRecord): boolean {
    return (
      this.clock() - Date.parse(record.state.updatedAt) >
      this.operationLeaseMs
    );
  }

  private async toResource(
    record: AgenticRunRecord,
    revision: number
  ): Promise<WorkflowRunResource> {
    const events = await this.repository.readRunEvents(record.runId);
    return mapAgenticRunToResource(record, revision, {
      leaseExpired:
        !isTerminalAgenticState(record.state.state) &&
        this.leaseExpired(record),
      storedEvents: events
    });
  }
}

/** Wire mapping to the legacy resource shape; no UI change (ADR 0008). */
export function mapAgenticRunToResource(
  record: AgenticRunRecord,
  revision: number,
  options: {
    leaseExpired: boolean;
    storedEvents: readonly StoredRunEvent[];
  }
): WorkflowRunResource {
  const wireState = wireStateFor(record.state.state);
  return {
    schemaVersion: 4,
    runId: record.runId,
    requestedChannel: record.requestedChannel,
    mode: record.mode,
    state: {
      state: wireState,
      version: revision,
      createdAt: record.state.createdAt,
      updatedAt: record.state.updatedAt,
      history: []
    },
    plan: {
      planId: `plan_agentic_${fingerprint({
        runId: record.runId,
        maximumCredits: record.budget.maximumCredits
      }).slice(0, 16)}`,
      resolutionCreditCeiling: 0,
      executionCreditCeiling: record.budget.maximumCredits,
      totalCreditCeiling: record.budget.maximumCredits,
      maxPeers: 3,
      llmCallCeiling: record.budget.maxIterations,
      llmOutputTokenCeiling: 20_000,
      operations: [
        "Autonomously resolve the requested YouTube channel",
        "Select reach-comparable peers",
        "Retrieve bounded sponsor evidence in planner-chosen order",
        "Qualify same-brand reactivations deterministically",
        "Compose the evidence-backed report"
      ]
    },
    accounting: {
      policy: "per_run_v1",
      maximumCredits: record.budget.maximumCredits
    },
    resolvedCohort: record.resolvedCohort,
    peerProposal: null,
    approvals: { plan: null, execution: null },
    quota: {
      resolutionReservationId: null,
      executionReservationId: record.reservationId,
      resolutionCreditsUsed: 0,
      executionCreditsUsed: record.budget.settledCredits
    },
    wordingAgent: {
      enabled: false,
      provider: record.llm.provider,
      model: record.llm.model,
      peerRationale: { status: "not_needed", inputFingerprint: null },
      reportWording: { status: "not_needed", inputFingerprint: null }
    },
    report: record.report,
    error: record.error,
    auditEvents: record.auditEvents,
    version: revision,
    outcome: outcomeFor(record),
    status: statusFor(record.state.state),
    availableActions: options.leaseExpired ? ["resume"] : [],
    workflowEvents: options.storedEvents
      .filter(
        (event) =>
          (event.event as { kind?: string }).kind === "budget" ||
          (event.event as { kind?: string }).kind === "terminal"
      )
      .slice(-50)
      .map((event) => ({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        event: {
          type: "audit.persisted" as const,
          state: wireStateFor(record.state.state),
          stateVersion: revision,
          reason: workflowEventReason(event.event)
        }
      }))
  };
}

function wireStateFor(
  state: AgenticRunState
): WorkflowRunResource["state"]["state"] {
  switch (state) {
    case "resolving_cohort":
      return "resolving";
    case "gathering_evidence":
      return "executing";
    case "completed":
      return "completed";
    case "partial":
      return "partial";
    case "no_eligible_peers":
      return "no_eligible_peers";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function statusFor(
  state: AgenticRunState
): WorkflowRunResource["status"] {
  switch (state) {
    case "resolving_cohort":
      return "resolving_peers";
    case "gathering_evidence":
      return "executing";
    case "completed":
    case "no_eligible_peers":
      return "completed";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function outcomeFor(
  record: AgenticRunRecord
): WorkflowRunResource["outcome"] {
  if (record.state.state === "no_eligible_peers") {
    return "no_eligible_peers";
  }
  if (record.report === null) {
    return null;
  }
  return record.report.leads.length > 0
    ? "opportunities_found"
    : "no_qualified_opportunities";
}

function workflowEventReason(event: JsonValue): string {
  const parsed = event as {
    kind?: string;
    iteration?: number;
    snapshot?: { resultBasedCredits?: number; maximumCredits?: number };
    reason?: string;
    status?: string;
  };
  if (parsed.kind === "budget") {
    return `Iteration ${parsed.iteration}: ${parsed.snapshot?.resultBasedCredits ?? 0}/${parsed.snapshot?.maximumCredits ?? 0} credits settled`;
  }
  if (parsed.kind === "terminal") {
    return parsed.reason ?? `Run ${parsed.status ?? "ended"}`;
  }
  return "Agentic research progressed";
}

function toJson(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue;
}

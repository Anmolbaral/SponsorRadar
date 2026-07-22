import { createHash } from "node:crypto";
import type {
  PeerExplanationResult,
  WordingAgent
} from "@/src/agent/orchestrator/wording-agent";
import type { AuditEvent, AuditPhase } from "@/src/observability/audit";
import { AuditRecorder, fingerprint } from "@/src/observability/audit";
import type {
  JsonValue,
  StoredQuotaReservation,
  ValueSchemaVersion,
  WorkflowPersistenceRepository
} from "@/src/radar/adapters/persistence";
import {
  PersistenceConflictError,
  PersistenceCorruptionError
} from "@/src/radar/adapters/persistence";
import type {
  EvidenceMode,
  LockedPeer,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import {
  approvedCohortHash,
  runWinbackReport
} from "@/src/radar/application/run-winback-report";
import { EvidenceToolExecutor } from "@/src/radar/application/tools/tool-executor";
import {
  auditToolName,
  composeResolutionCredits,
  MAX_PEER_COHORT
} from "@/src/radar/application/tools/tool-registry";
import {
  createRunState,
  isRunCancellable,
  RUN_STATES,
  transitionRun,
  type RunState,
  type RunStateSnapshot,
  type RunTransitionActor
} from "@/src/radar/domain/run-state";
import type {
  TargetSummary,
  WinbackReport
} from "@/src/radar/domain/types";
import { isReachComparable } from "@/src/radar/domain/reach";
import {
  parseYouTubeChannelReference,
  sameVerifiedYouTubeIdentity,
  YouTubeTargetVerificationError,
  type VerifiedYouTubeIdentity
} from "@/src/radar/domain/youtube";

const RUN_SCHEMA_VERSION = 4;
const EVENT_SCHEMA_VERSION = 1;
const LEGACY_SHARED_QUOTA_KEY = "upriver-shared-credits";
const PER_RUN_QUOTA_KEY_PREFIX = "upriver-run-credits-v1";
const MAX_PEERS = MAX_PEER_COHORT;
export const MAXIMUM_RUN_CREDITS = 160;

export type WorkflowRunAction =
  | "approve_plan"
  | "approve_execution"
  | "cancel"
  | "resume";

export interface WorkflowRunPlan {
  planId: string;
  resolutionCreditCeiling: number;
  executionCreditCeiling: number;
  totalCreditCeiling: number;
  maxPeers: 3;
  llmCallCeiling: number;
  llmOutputTokenCeiling: number;
  operations: readonly string[];
}

export interface WorkflowPeerProposal {
  proposalId: string;
  target: TargetSummary;
  identity: VerifiedYouTubeIdentity | null;
  peers: Array<
    LockedPeer & {
      reachRatio: number;
      rationale?: {
        text: string;
        evidenceIds: [string, string];
      };
    }
  >;
  cohortHash: string;
  wordingAgent?: {
    status: "generated" | "fallback";
    provider: string;
    model: string;
    promptVersion: string;
    schemaVersion: string;
    fallbackReason?: string;
  };
  quote: {
    quoteId: string;
    creditCeiling: number;
    estimateKind: "maximum_reservation";
    expiresAt: string;
  };
}

export interface WorkflowApprovalSummary {
  approvalId: string;
  decidedAt: string;
}

export interface WorkflowRunError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface WorkflowRunAccountingPolicy {
  policy: "per_run_v1" | "legacy_shared_v1";
  maximumCredits: number;
}

export interface WorkflowRunRecord {
  schemaVersion: 4;
  runId: string;
  requestedChannel: string;
  mode: EvidenceMode;
  state: RunStateSnapshot;
  plan: WorkflowRunPlan;
  accounting: WorkflowRunAccountingPolicy;
  resolvedCohort: {
    target: TargetSummary;
    identity: VerifiedYouTubeIdentity | null;
    peers: LockedPeer[];
  } | null;
  peerProposal: WorkflowPeerProposal | null;
  approvals: {
    plan: WorkflowApprovalSummary | null;
    execution: WorkflowApprovalSummary | null;
  };
  quota: {
    resolutionReservationId: string | null;
    executionReservationId: string | null;
    resolutionCreditsUsed: number;
    executionCreditsUsed: number;
  };
  wordingAgent: {
    enabled: boolean;
    provider: string;
    model: string;
    peerRationale: WordingInvocationCheckpoint;
    reportWording: WordingInvocationCheckpoint;
  };
  report: WinbackReport | null;
  error: WorkflowRunError | null;
  auditEvents: AuditEvent[];
}

export interface WordingInvocationCheckpoint {
  status:
    | "not_started"
    | "claimed"
    | "completed"
    | "fallback"
    | "not_needed";
  inputFingerprint: string | null;
}

export interface WorkflowEvent {
  type: "run.created" | "run.transitioned" | "audit.persisted";
  state: RunState;
  stateVersion: number;
  reason: string;
}

export type WorkflowRunOutcome =
  | "no_eligible_peers"
  | "no_qualified_opportunities"
  | "opportunities_found";

export interface WorkflowRunResource extends WorkflowRunRecord {
  version: number;
  outcome: WorkflowRunOutcome | null;
  status:
    | "awaiting_plan_approval"
    | "resolving_peers"
    | "awaiting_execution_approval"
    | "executing"
    | "completed"
    | "partial"
    | "failed"
    | "cancelled";
  availableActions: WorkflowRunAction[];
  workflowEvents: Array<{
    sequence: number;
    occurredAt: string;
    event: WorkflowEvent;
  }>;
}

export interface WorkflowGatewayFactoryInput {
  mode: EvidenceMode;
  runId: string;
  audit?: AuditRecorder;
  maximumCredits?: number;
}

export type WorkflowGatewayFactory = (
  input: WorkflowGatewayFactoryInput
) => SponsorRadarEvidencePort;

export interface WorkflowServiceOptions {
  repository: WorkflowPersistenceRepository;
  gatewayFactory: WorkflowGatewayFactory;
  mode?: EvidenceMode;
  clock?: () => number;
  runCreditLimit?: number;
  quoteTtlMs?: number;
  operationLeaseMs?: number;
  wordingAgent?: WordingAgent;
}

export interface ApprovePlanInput {
  expectedVersion: number;
  planId: string;
  idempotencyKey: string;
}

export interface ApproveExecutionInput {
  expectedVersion: number;
  proposalId: string;
  quoteId: string;
  approvedCreditCeiling: number;
  idempotencyKey: string;
}

export interface MutateRunInput {
  expectedVersion: number;
  idempotencyKey: string;
}

interface LoadedRun {
  record: WorkflowRunRecord;
  revision: number;
}

export class RunNotFoundError extends Error {
  readonly code = "run_not_found";

  constructor(runId: string) {
    super(`Run ${runId} was not found`);
    this.name = "RunNotFoundError";
  }
}

export class WorkflowConflictError extends Error {
  readonly code = "workflow_conflict";

  constructor(message: string) {
    super(message);
    this.name = "WorkflowConflictError";
  }
}

export class RunCreditLimitExceededError extends Error {
  readonly code = "run_credit_limit_exceeded";

  constructor() {
    super("The run cannot reserve more than its persisted credit limit");
    this.name = "RunCreditLimitExceededError";
  }
}

export class RunAccountingMigrationRequiredError extends Error {
  readonly code = "run_accounting_migration_required";

  constructor() {
    super("This legacy run cannot create a new paid-operation reservation");
    this.name = "RunAccountingMigrationRequiredError";
  }
}

export class WorkflowService {
  private readonly repository: WorkflowPersistenceRepository;
  private readonly gatewayFactory: WorkflowGatewayFactory;
  private readonly mode: EvidenceMode;
  private readonly clock: () => number;
  private readonly runCreditLimit: number;
  private readonly quoteTtlMs: number;
  private readonly operationLeaseMs: number;
  private readonly wordingAgent?: WordingAgent;

  constructor(options: WorkflowServiceOptions) {
    this.repository = options.repository;
    this.gatewayFactory = options.gatewayFactory;
    this.mode = options.mode ?? "fixture";
    this.clock = options.clock ?? Date.now;
    this.runCreditLimit = positiveInteger(
      options.runCreditLimit ?? MAXIMUM_RUN_CREDITS,
      "runCreditLimit"
    );
    if (this.runCreditLimit > MAXIMUM_RUN_CREDITS) {
      throw new TypeError(
        `runCreditLimit must not exceed ${MAXIMUM_RUN_CREDITS}`
      );
    }
    this.quoteTtlMs = positiveInteger(
      options.quoteTtlMs ?? 60 * 60 * 1_000,
      "quoteTtlMs"
    );
    this.operationLeaseMs = positiveInteger(
      options.operationLeaseMs ?? 2 * 60 * 1_000,
      "operationLeaseMs"
    );
    this.wordingAgent = options.wordingAgent;
  }

  async createRun(
    requestedChannel: string,
    idempotencyKey: string
  ): Promise<WorkflowRunResource> {
    const channel = requestedChannel.trim();
    if (!channel) {
      throw new TypeError("requestedChannel must not be empty");
    }
    assertIdempotencyKey(idempotencyKey);
    const runId = runIdFor(idempotencyKey);
    const existing = await this.repository.readRunSnapshot(runId);
    if (existing) {
      const loaded = parseLoadedRun(
        existing.value,
        existing.revision,
        runId,
        existing.valueSchemaVersion
      );
      if (
        loaded.record.requestedChannel !== channel ||
        loaded.record.mode !== this.mode
      ) {
        throw new WorkflowConflictError(
          "Idempotency key was already used for a different channel or mode"
        );
      }
      return this.resource(loaded);
    }

    const gateway = this.gatewayFactory({
      mode: this.mode,
      runId,
      maximumCredits: this.runCreditLimit
    });
    assertGatewayMode(gateway, this.mode);
    await gateway.prepareRun?.(channel);
    const totalCreditCeiling =
      gateway.estimateRunCredits() +
      executionRevalidationCreditCeiling(gateway);
    if (totalCreditCeiling > this.runCreditLimit) {
      throw new RunCreditLimitExceededError();
    }
    const baseResolutionCeiling = composeResolutionCredits((operation) =>
      gateway.estimateCredits(operation)
    );
    const resolutionCreditCeiling =
      totalCreditCeiling === 0
        ? 0
        : Math.min(
            totalCreditCeiling,
            gateway.estimateResolutionCredits?.() ??
              baseResolutionCeiling
          );
    const executionCreditCeiling = Math.max(
      0,
      totalCreditCeiling - resolutionCreditCeiling
    );
    const createdAt = this.nowIso();
    const initial = createRunState(createdAt);
    const planned = transitionRun(initial, {
      to: "planned",
      occurredAt: createdAt,
      actor: "application",
      reason: "Created an immutable research plan with bounded credit ceilings"
    });
    const planInput = {
      channel,
      mode: this.mode,
      resolutionCreditCeiling,
      executionCreditCeiling,
      totalCreditCeiling,
      maxPeers: MAX_PEERS,
      llmCallCeiling: this.wordingAgent ? 2 : 0,
      llmOutputTokenCeiling: this.wordingAgent ? 1_200 : 0,
      llmProvider: this.wordingAgent?.provider ?? "disabled",
      llmModel: this.wordingAgent?.model ?? "disabled",
      policyVersion: this.wordingAgent ? "wording-agent-v1" : "deterministic-v1"
    };
    const plan: WorkflowRunPlan = {
      planId: `plan_${fingerprint(planInput).slice(0, 32)}`,
      resolutionCreditCeiling,
      executionCreditCeiling,
      totalCreditCeiling,
      maxPeers: MAX_PEERS,
      llmCallCeiling: this.wordingAgent ? 2 : 0,
      llmOutputTokenCeiling: this.wordingAgent ? 1_200 : 0,
      operations: [
        "Resolve the requested YouTube channel",
        "Discover and lock up to three reach-comparable peers",
        ...(this.wordingAgent
          ? [
              "Generate a bounded rationale for the locked peers",
              "Generate cited wording for already-qualified leads"
            ]
          : []),
        "Retrieve bounded sponsor evidence",
        "Find evidence-backed same-brand reactivation candidates"
      ]
    };
    const record: WorkflowRunRecord = {
      schemaVersion: RUN_SCHEMA_VERSION,
      runId,
      requestedChannel: channel,
      mode: this.mode,
      state: planned,
      plan,
      accounting: {
        policy: "per_run_v1",
        maximumCredits: this.runCreditLimit
      },
      resolvedCohort: null,
      peerProposal: null,
      approvals: {
        plan: null,
        execution: null
      },
      quota: {
        resolutionReservationId: null,
        executionReservationId: null,
        resolutionCreditsUsed: 0,
        executionCreditsUsed: 0
      },
      wordingAgent: {
        enabled: this.wordingAgent !== undefined,
        provider: this.wordingAgent?.provider ?? "disabled",
        model: this.wordingAgent?.model ?? "disabled",
        peerRationale: {
          status: "not_started",
          inputFingerprint: null
        },
        reportWording: {
          status: "not_started",
          inputFingerprint: null
        }
      },
      report: null,
      error: null,
      auditEvents: []
    };
    let stored;
    try {
      stored = await this.repository.saveRunSnapshot({
        runId,
        valueSchemaVersion: RUN_SCHEMA_VERSION,
        value: toJson(record),
        expectedRevision: null
      });
    } catch (error) {
      if (error instanceof PersistenceConflictError) {
        const winner = await this.loadRun(runId);
        if (
          winner.record.requestedChannel !== channel ||
          winner.record.mode !== this.mode
        ) {
          throw new WorkflowConflictError(
            "Idempotency key was already used for a different channel or mode"
          );
        }
        return this.resource(winner);
      }
      throw error;
    }
    await this.appendWorkflowEvent(record, "run.created", plan.operations[0]);
    return this.resource({
      record,
      revision: stored.revision
    });
  }

  async getRun(runId: string): Promise<WorkflowRunResource> {
    return this.resource(await this.loadRun(runId));
  }

  async approvePlan(
    runId: string,
    input: ApprovePlanInput
  ): Promise<WorkflowRunResource> {
    assertIdempotencyKey(input.idempotencyKey);
    let loaded = await this.loadRun(runId);
    if (loaded.record.plan.planId !== input.planId) {
      throw new WorkflowConflictError("The approved plan is no longer current");
    }
    const priorApproval = await this.repository.readApproval(
      runId,
      input.idempotencyKey
    );
    if (!priorApproval) {
      assertExpectedVersion(loaded.revision, input.expectedVersion);
      if (loaded.record.state.state !== "planned") {
        throw new WorkflowConflictError(
          `Plan approval cannot continue from ${loaded.record.state.state}`
        );
      }
    }

    if (loaded.record.state.state === "planned") {
      await this.assertPlanStillCoversCurrentMisses(loaded.record);
      this.assertCanCreateReservation(loaded.record);
    }

    const approval = await this.repository.recordApproval({
      runId,
      idempotencyKey: input.idempotencyKey,
      action: "approve_plan",
      decision: "approved",
      decidedBy: "local-user",
      details: toJson({
        expectedVersion: input.expectedVersion,
        planId: input.planId
      })
    });

    if (loaded.record.state.state !== "planned") {
      if (!priorApproval) {
        throw new WorkflowConflictError(
          `Plan approval cannot continue from ${loaded.record.state.state}`
        );
      }
      return this.resource(loaded);
    }

    const reservation = await this.reserveQuota(
      loaded.record,
      `${runId}:resolution:v1`,
      loaded.record.plan.resolutionCreditCeiling
    );
    try {
      loaded = await this.transitionAndSave(
        loaded,
        "plan_approved",
        "user",
        "User approved bounded target and peer resolution",
        {
          approvals: {
            ...loaded.record.approvals,
            plan: {
              approvalId: approval.value.approvalId,
              decidedAt: approval.value.decidedAt
            }
          },
          quota: {
            ...loaded.record.quota,
            resolutionReservationId: reservation.reservationId
          }
        }
      );
    } catch (error) {
      return this.compensateClaimConflict(
        runId,
        reservation,
        "resolution",
        input.idempotencyKey,
        error
      );
    }

    try {
      loaded = await this.transitionAndSave(
        loaded,
        "resolving",
        "application",
        "Persisted the resolution claim before starting any evidence operation"
      );
    } catch (error) {
      if (error instanceof PersistenceConflictError) {
        return this.resource(await this.loadRun(runId));
      }
      throw error;
    }
    return this.continueResolution(loaded, reservation, input.idempotencyKey);
  }

  async approveExecution(
    runId: string,
    input: ApproveExecutionInput
  ): Promise<WorkflowRunResource> {
    assertIdempotencyKey(input.idempotencyKey);
    nonNegativeInteger(
      input.approvedCreditCeiling,
      "approvedCreditCeiling"
    );
    let loaded = await this.loadRun(runId);
    const proposal = loaded.record.peerProposal;
    if (
      !proposal ||
      proposal.proposalId !== input.proposalId ||
      proposal.quote.quoteId !== input.quoteId
    ) {
      throw new WorkflowConflictError(
        "The approved peer proposal or credit quote is no longer current"
      );
    }
    if (proposal.identity === null) {
      if (isTerminalState(loaded.record.state.state)) {
        return this.resource(loaded);
      }
      if (loaded.record.state.state !== "peers_proposed") {
        throw new WorkflowConflictError(
          `Execution approval cannot continue from ${loaded.record.state.state}`
        );
      }
      loaded = await this.transitionAndSave(
        loaded,
        "failed",
        "policy",
        "Blocked a legacy proposal that was not bound to verified YouTube identity",
        {
          error: legacyIdentityRestartError()
        }
      );
      return this.resource(loaded);
    }
    const proposalCohortHash = approvedCohortHash(
      proposal.target,
      proposal.peers.map((peer) => ({
        name: peer.name,
        url: peer.url,
        subscriberCount: peer.subscriberCount,
        creatorId: peer.creatorId
      })),
      proposal.identity
    );
    if (proposalCohortHash !== proposal.cohortHash) {
      throw new WorkflowConflictError(
        "The approved peer proposal no longer matches its bound cohort hash"
      );
    }
    if (input.approvedCreditCeiling !== proposal.quote.creditCeiling) {
      throw new WorkflowConflictError(
        "The approved credit ceiling must exactly match the current quote"
      );
    }
    const priorApproval = await this.repository.readApproval(
      runId,
      input.idempotencyKey
    );
    if (!priorApproval) {
      assertExpectedVersion(loaded.revision, input.expectedVersion);
      if (loaded.record.state.state !== "peers_proposed") {
        throw new WorkflowConflictError(
          `Execution approval cannot continue from ${loaded.record.state.state}`
        );
      }
      if (this.clock() >= Date.parse(proposal.quote.expiresAt)) {
        throw new WorkflowConflictError(
          "The credit quote expired; create a new run to refresh it"
        );
      }
    }

    if (loaded.record.state.state === "peers_proposed") {
      await this.assertQuoteStillCoversCurrentMisses(
        loaded.record,
        proposal.quote.creditCeiling
      );
      this.assertCanCreateReservation(loaded.record);
    }

    const approval = await this.repository.recordApproval({
      runId,
      idempotencyKey: input.idempotencyKey,
      action: "approve_execution",
      decision: "approved",
      decidedBy: "local-user",
      details: toJson({
        expectedVersion: input.expectedVersion,
        proposalId: input.proposalId,
        quoteId: input.quoteId,
        approvedCreditCeiling: input.approvedCreditCeiling
      })
    });

    if (loaded.record.state.state !== "peers_proposed") {
      if (!priorApproval) {
        throw new WorkflowConflictError(
          `Execution approval cannot continue from ${loaded.record.state.state}`
        );
      }
      return this.resource(loaded);
    }

    const reservation = await this.reserveQuota(
      loaded.record,
      `${runId}:${proposal.proposalId}:execution:v1`,
      input.approvedCreditCeiling
    );
    try {
      loaded = await this.transitionAndSave(
        loaded,
        "peers_approved",
        "user",
        "User approved the exact locked peer proposal",
        {
          approvals: {
            ...loaded.record.approvals,
            execution: {
              approvalId: approval.value.approvalId,
              decidedAt: approval.value.decidedAt
            }
          },
          quota: {
            ...loaded.record.quota,
            executionReservationId: reservation.reservationId
          }
        }
      );
    } catch (error) {
      return this.compensateClaimConflict(
        runId,
        reservation,
        "execution",
        input.idempotencyKey,
        error
      );
    }
    return this.beginExecution(
      loaded,
      reservation,
      input.idempotencyKey,
      input.approvedCreditCeiling
    );
  }

  async cancelRun(
    runId: string,
    input: MutateRunInput
  ): Promise<WorkflowRunResource> {
    assertIdempotencyKey(input.idempotencyKey);
    let loaded = await this.loadRun(runId);
    const priorApproval = await this.repository.readApproval(
      runId,
      input.idempotencyKey
    );
    if (!priorApproval) {
      assertExpectedVersion(loaded.revision, input.expectedVersion);
    }
    // Only a cancel that legally changes state records an approval. Running the
    // no-op (already-cancelled) and illegal-transition checks first prevents a
    // rejected 409 or a terminal no-op from leaving a ghost approval behind.
    if (loaded.record.state.state === "cancelled") {
      await this.releaseCancelledReservations(
        loaded.record,
        input.idempotencyKey
      );
      return this.resource(loaded);
    }
    if (!isRunCancellable(loaded.record.state.state)) {
      throw new WorkflowConflictError(
        `Run cannot be cancelled from ${loaded.record.state.state}`
      );
    }

    await this.repository.recordApproval({
      runId,
      idempotencyKey: input.idempotencyKey,
      action: "cancel",
      decision: "approved",
      decidedBy: "local-user",
      details: toJson({ expectedVersion: input.expectedVersion })
    });
    const recordBeforeCancellation = loaded.record;
    loaded = await this.transitionAndSave(
      loaded,
      "cancelled",
      "user",
      "User cancelled before execution began"
    );
    await this.releaseCancelledReservations(
      recordBeforeCancellation,
      input.idempotencyKey
    );
    return this.resource(loaded);
  }

  async resumeRun(
    runId: string,
    input: MutateRunInput
  ): Promise<WorkflowRunResource> {
    assertIdempotencyKey(input.idempotencyKey);
    let loaded = await this.loadRun(runId);
    const priorApproval = await this.repository.readApproval(
      runId,
      input.idempotencyKey
    );
    if (!priorApproval) {
      assertExpectedVersion(loaded.revision, input.expectedVersion);
    }
    if (
      loaded.record.state.state === "planned" ||
      loaded.record.state.state === "peers_proposed" ||
      isTerminalState(loaded.record.state.state)
    ) {
      return this.resource(loaded);
    }

    if (
      isPaidOperationCheckpoint(loaded.record.state.state) &&
      !this.operationLeaseExpired(loaded.record)
    ) {
      if (priorApproval) {
        return this.resource(loaded);
      }
      throw new WorkflowConflictError(
        "The workflow operation is still within its active lease"
      );
    }

    // Record the approval only once we know the resume will reclaim or advance
    // real work. No-op resumes (terminal/planned/peers_proposed) and resumes
    // rejected because an operation is still leased return above without
    // leaving a ghost approval behind.
    await this.repository.recordApproval({
      runId,
      idempotencyKey: input.idempotencyKey,
      action: "resume",
      decision: "approved",
      decidedBy: "local-user",
      details: toJson({ expectedVersion: input.expectedVersion })
    });

    if (
      loaded.record.state.state === "plan_approved" &&
      loaded.record.quota.resolutionReservationId
    ) {
      const reservation = await this.findReservation(
        loaded.record,
        loaded.record.quota.resolutionReservationId
      );
      loaded = await this.transitionAndSave(
        loaded,
        "resolving",
        "application",
        "Reclaimed an approved resolution before starting evidence operations"
      );
      return this.continueResolution(
        loaded,
        reservation,
        input.idempotencyKey
      );
    }

    if (
      loaded.record.state.state === "resolving" &&
      loaded.record.quota.resolutionReservationId
    ) {
      const reservation = await this.findReservation(
        loaded.record,
        loaded.record.quota.resolutionReservationId
      );
      if (loaded.record.mode === "live") {
        return this.failAmbiguousLiveStage(
          loaded,
          reservation,
          "resolution"
        );
      }
      return this.continueResolution(
        loaded,
        reservation,
        input.idempotencyKey
      );
    }

    if (loaded.record.state.state === "resolved") {
      return this.continuePeerProposal(loaded);
    }

    if (
      (loaded.record.state.state === "peers_approved" ||
        loaded.record.state.state === "credit_approved") &&
      loaded.record.quota.executionReservationId &&
      loaded.record.peerProposal
    ) {
      const reservation = await this.findReservation(
        loaded.record,
        loaded.record.quota.executionReservationId
      );
      return this.beginExecution(
        loaded,
        reservation,
        input.idempotencyKey,
        loaded.record.peerProposal.quote.creditCeiling
      );
    }

    if (
      loaded.record.state.state === "executing" &&
      loaded.record.quota.executionReservationId
    ) {
      const reservation = await this.findReservation(
        loaded.record,
        loaded.record.quota.executionReservationId
      );
      if (loaded.record.mode === "live") {
        return this.failAmbiguousLiveStage(
          loaded,
          reservation,
          "execution"
        );
      }
      return this.continueExecution(
        loaded,
        reservation,
        input.idempotencyKey,
        loaded.record.peerProposal?.quote.creditCeiling ??
          reservation.requestedUnits
      );
    }

    if (loaded.record.state.state === "verifying") {
      return this.continueReportWording(loaded);
    }

    return this.resource(loaded);
  }

  private async continueResolution(
    loaded: LoadedRun,
    reservation: StoredQuotaReservation,
    idempotencyKey: string
  ): Promise<WorkflowRunResource> {
    const record = loaded.record;
    const phase = phaseFor(record.mode);
    const audit = new AuditRecorder({
      runId: record.runId,
      phase,
      mode: record.mode
    });
    audit.startRun({
      channel: record.requestedChannel,
      workflowStage: "resolution"
    });
    audit.recordPolicy({
      decision: "allow",
      reason: "User approved bounded target and peer resolution",
      estimatedCredits: record.plan.resolutionCreditCeiling,
      maximumCredits: record.plan.resolutionCreditCeiling,
      remainingCredits: 0
    });
    const gateway = this.gatewayFactory({
      mode: record.mode,
      runId: record.runId,
      audit,
      maximumCredits: record.plan.resolutionCreditCeiling
    });
    assertGatewayMode(gateway, record.mode);

    try {
      await gateway.prepareRun?.(record.requestedChannel);
      const currentResolutionCeiling = resolutionCeilingFor(
        gateway,
        gateway.estimateRunCredits()
      );
      if (currentResolutionCeiling > record.plan.resolutionCreditCeiling) {
        throw new WorkflowConflictError(
          "Cached resolution evidence expired after approval; no paid call was made"
        );
      }
      const tools = new EvidenceToolExecutor({
        port: gateway,
        audit,
        stage: "resolution"
      });
      const resolved = await tools.execute(
        "resolve_target",
        { channel: record.requestedChannel },
        {
          reason: "Confirm the exact requested YouTube channel",
          auditInput: { channel: record.requestedChannel }
        }
      );
      const peers = await tools.execute(
        "list_locked_peers",
        {
          targetUrl: resolved.target.url,
          targetSubscriberCount: resolved.target.subscriberCount
        },
        {
          reason: "Discover up to three reach-comparable peers",
          auditInput: {
            publicationUrl: resolved.target.url,
            targetSubscriberCount: resolved.target.subscriberCount
          }
        }
      );
      if (peers.length > MAX_PEERS) {
        throw new Error(
          `Peer discovery exceeded the ${MAX_PEERS}-peer safety limit`
        );
      }
      for (const peer of peers) {
        if (
          !isReachComparable(
            resolved.target.subscriberCount,
            peer.subscriberCount
          )
        ) {
          throw new Error(`${peer.name} falls outside the locked reach window`);
        }
      }
      const creditsUsed = audit.summarize(
        record.plan.resolutionCreditCeiling
      ).resultBasedCreditEstimate;
      await this.finalizeReservation(
        record,
        reservation.reservationId,
        `${idempotencyKey}:settle-resolution`,
        "settled",
        creditsUsed
      );
      const auditEvents = appendAuditEvents(record.auditEvents, audit.getEvents());
      if (peers.length === 0) {
        loaded = await this.transitionAndSave(
          loaded,
          "no_eligible_peers",
          "application",
          "No reach-comparable peers were available; research completed without sponsor execution",
          {
            quota: {
              ...record.quota,
              resolutionCreditsUsed: creditsUsed
            },
            resolvedCohort: {
              target: resolved.target,
              identity: resolved.identity,
              peers: []
            },
            wordingAgent: {
              ...record.wordingAgent,
              peerRationale: {
                status: "not_needed",
                inputFingerprint: null
              },
              reportWording: {
                status: "not_needed",
                inputFingerprint: null
              }
            },
            auditEvents
          }
        );
        return this.resource(loaded);
      }
      loaded = await this.transitionAndSave(
        loaded,
        "resolved",
        "application",
        "Resolved the exact target and validated the discovered peer cohort before sponsor research",
        {
          quota: {
            ...record.quota,
            resolutionCreditsUsed: creditsUsed
          },
          resolvedCohort: {
            target: resolved.target,
            identity: resolved.identity,
            peers
          },
          auditEvents
        }
      );
      return this.continuePeerProposal(loaded);
    } catch (error) {
      const creditsUsed = failedStageCredits(
        record.mode,
        error,
        audit,
        record.plan.resolutionCreditCeiling
      );
      await this
        .finalizeReservation(
          record,
          reservation.reservationId,
          `${idempotencyKey}:fail-resolution`,
          "settled",
          creditsUsed
        )
        .catch(() => undefined);
      loaded = await this.transitionAndSave(
        loaded,
        "failed",
        "application",
        "Target or peer resolution failed closed",
        {
          quota: {
            ...loaded.record.quota,
            resolutionCreditsUsed: creditsUsed
          },
          error: safeWorkflowError(error),
          auditEvents: appendAuditEvents(
            loaded.record.auditEvents,
            audit.getEvents()
          )
        }
      );
      return this.resource(loaded);
    }
  }

  private async continuePeerProposal(
    loaded: LoadedRun
  ): Promise<WorkflowRunResource> {
    const record = loaded.record;
    const cohort = record.resolvedCohort;
    if (!cohort) {
      loaded = await this.transitionAndSave(
        loaded,
        "failed",
        "application",
        "Resolved checkpoint was missing its persisted target and peers",
        {
          error: {
            code: "missing_resolved_cohort",
            message:
              "The run failed safely because its resolved cohort was incomplete.",
            retryable: false
          }
        }
      );
      return this.resource(loaded);
    }
    if (cohort.identity === null) {
      loaded = await this.transitionAndSave(
        loaded,
        "failed",
        "policy",
        "Blocked a legacy resolved cohort that was not bound to verified YouTube identity",
        {
          error: legacyIdentityRestartError()
        }
      );
      return this.resource(loaded);
    }

    try {
      const gateway = this.gatewayFactory({
        mode: record.mode,
        runId: record.runId,
        maximumCredits: record.plan.executionCreditCeiling
      });
      assertGatewayMode(gateway, record.mode);
      await gateway.prepareRun?.(record.requestedChannel);
      const executionCreditCeiling =
        gateway.estimateRunCredits() +
        executionRevalidationCreditCeiling(gateway);
      if (executionCreditCeiling > record.plan.executionCreditCeiling) {
        throw new WorkflowConflictError(
          "The execution estimate increased after plan approval; create a new run"
        );
      }

      const cohortHash = approvedCohortHash(
        cohort.target,
        cohort.peers,
        cohort.identity
      );
      let generated: PeerExplanationResult | null = null;
      let fallbackReason: string | null = null;
      let wordingAuditEvents: readonly AuditEvent[] = [];
      if (record.wordingAgent.enabled) {
        const checkpoint = record.wordingAgent.peerRationale;
        const agent = this.compatibleWordingAgent(record);
        if (!agent) {
          fallbackReason = "configured_wording_agent_unavailable";
        } else if (checkpoint.status === "claimed") {
          fallbackReason = "ambiguous_prior_llm_attempt";
        } else if (
          checkpoint.status === "not_started"
        ) {
          loaded = await this.saveCheckpoint(
            loaded,
            {
              wordingAgent: {
                ...loaded.record.wordingAgent,
                peerRationale: {
                  status: "claimed",
                  inputFingerprint: cohortHash
                }
              }
            },
            "Persisted the peer-rationale claim before the bounded LLM call"
          );
          const audit = new AuditRecorder({
            runId: record.runId,
            phase: phaseFor(record.mode, true),
            mode: record.mode
          });
          try {
            generated = await agent.explainLockedPeers({
              runId: record.runId,
              target: cohort.target,
              peers: cohort.peers,
              audit,
              priorAuditEvents: loaded.record.auditEvents
            });
            assertPeerExplanations(cohort.peers, generated);
          } catch (error) {
            fallbackReason =
              error instanceof Error ? error.name : "UnknownError";
          }
          wordingAuditEvents = audit.getEvents();
        } else if (checkpoint.status !== "completed") {
          fallbackReason = "prior_wording_fallback";
        }
      }

      const proposalPeers = cohort.peers.map((peer) => {
        const explanation = generated?.explanations.find(
          (candidate) => candidate.peerUrl === peer.url
        );
        return {
          ...peer,
          reachRatio:
            Math.round(
              (peer.subscriberCount / cohort.target.subscriberCount) * 100
            ) / 100,
          ...(explanation
            ? {
                rationale: {
                  text: explanation.rationale,
                  evidenceIds: explanation.evidenceIds
                }
              }
            : {})
        };
      });
      const wordingPresentation = record.wordingAgent.enabled
        ? generated
          ? {
              status: "generated" as const,
              provider: generated.provider,
              model: generated.model,
              promptVersion: generated.promptVersion,
              schemaVersion: generated.schemaVersion
            }
          : {
              status: "fallback" as const,
              provider: record.wordingAgent.provider,
              model: record.wordingAgent.model,
              promptVersion: "grounded-wording-v1",
              schemaVersion: "peer-rationale-v2",
              fallbackReason:
                fallbackReason ?? "bounded_generation_unavailable"
            }
        : undefined;
      const proposalInput = {
        target: cohort.target,
        identity: cohort.identity,
        peers: proposalPeers,
        cohortHash,
        wordingAgent: wordingPresentation ?? null,
        policyVersion: record.wordingAgent.enabled
          ? "wording-agent-v1"
          : "deterministic-v1"
      };
      const proposalId = `proposal_${fingerprint(proposalInput).slice(0, 32)}`;
      const quoteId = `quote_${fingerprint({
        proposalId,
        executionCreditCeiling,
        runCreditLimit: record.accounting.maximumCredits
      }).slice(0, 32)}`;
      const peerProposal: WorkflowPeerProposal = {
        proposalId,
        target: cohort.target,
        identity: cohort.identity,
        peers: proposalPeers,
        cohortHash,
        ...(wordingPresentation ? { wordingAgent: wordingPresentation } : {}),
        quote: {
          quoteId,
          creditCeiling: executionCreditCeiling,
          estimateKind: "maximum_reservation",
          expiresAt: new Date(this.clock() + this.quoteTtlMs).toISOString()
        }
      };
      loaded = await this.transitionAndSave(
        loaded,
        "peers_proposed",
        "application",
        "Persisted the exact peer proposal and bounded execution quote",
        {
          peerProposal,
          wordingAgent: {
            ...loaded.record.wordingAgent,
            peerRationale: {
              status: generated ? "completed" : record.wordingAgent.enabled
                ? "fallback"
                : "not_needed",
              inputFingerprint: record.wordingAgent.enabled ? cohortHash : null
            }
          },
          auditEvents: appendAuditEvents(
            loaded.record.auditEvents,
            wordingAuditEvents
          )
        }
      );
      return this.resource(loaded);
    } catch (error) {
      if (error instanceof PersistenceConflictError) {
        return this.resource(await this.loadRun(record.runId));
      }
      loaded = await this.transitionAndSave(
        loaded,
        "failed",
        "policy",
        "Execution pricing changed after the approved resolution stage",
        {
          error: safeWorkflowError(error)
        }
      );
      return this.resource(loaded);
    }
  }

  private async beginExecution(
    loaded: LoadedRun,
    reservation: StoredQuotaReservation,
    idempotencyKey: string,
    approvedCreditCeiling: number
  ): Promise<WorkflowRunResource> {
    if (loaded.record.peerProposal?.identity === null) {
      await this
        .finalizeReservation(
          loaded.record,
          reservation.reservationId,
          `${idempotencyKey}:fail-unverified-identity`,
          "settled",
          0
        )
        .catch(() => undefined);
      loaded = await this.transitionAndSave(
        loaded,
        "failed",
        "policy",
        "Blocked execution because the approved proposal lacked verified YouTube identity",
        {
          quota: {
            ...loaded.record.quota,
            executionCreditsUsed: 0
          },
          error: legacyIdentityRestartError()
        }
      );
      return this.resource(loaded);
    }
    try {
      if (loaded.record.state.state === "peers_approved") {
        loaded = await this.transitionAndSave(
          loaded,
          "credit_approved",
          "user",
          `User approved a ${approvedCreditCeiling}-credit maximum reservation`
        );
      }
      if (loaded.record.state.state === "credit_approved") {
        loaded = await this.transitionAndSave(
          loaded,
          "executing",
          "application",
          "Persisted execution claim before starting any evidence operation"
        );
      }
    } catch (error) {
      if (error instanceof PersistenceConflictError) {
        return this.resource(await this.loadRun(loaded.record.runId));
      }
      throw error;
    }

    if (loaded.record.state.state !== "executing") {
      return this.resource(loaded);
    }
    return this.continueExecution(
      loaded,
      reservation,
      idempotencyKey,
      approvedCreditCeiling
    );
  }

  private async continueExecution(
    loaded: LoadedRun,
    reservation: StoredQuotaReservation,
    idempotencyKey: string,
    approvedCreditCeiling: number
  ): Promise<WorkflowRunResource> {
    const record = loaded.record;
    const proposal = record.peerProposal;
    if (!proposal?.identity) {
      await this
        .finalizeReservation(
          record,
          reservation.reservationId,
          `${idempotencyKey}:fail-unverified-identity`,
          "settled",
          0
        )
        .catch(() => undefined);
      loaded = await this.transitionAndSave(
        loaded,
        "failed",
        "policy",
        "Stopped execution before evidence calls because verified YouTube identity was missing",
        {
          quota: {
            ...record.quota,
            executionCreditsUsed: 0
          },
          error: legacyIdentityRestartError()
        }
      );
      return this.resource(loaded);
    }
    const audit = new AuditRecorder({
      runId: record.runId,
      phase: phaseFor(record.mode, record.wordingAgent.enabled),
      mode: record.mode
    });
    const gateway = this.gatewayFactory({
      mode: record.mode,
      runId: record.runId,
      audit,
      maximumCredits: approvedCreditCeiling
    });
    assertGatewayMode(gateway, record.mode);

    try {
      const result = await runWinbackReport(
        {
          channel: record.requestedChannel,
          maximumCredits: approvedCreditCeiling
        },
        gateway,
        {
          audit,
          phase: phaseFor(record.mode, record.wordingAgent.enabled),
          allowPartialPeerFailure: true,
          executionStage: "execution",
          approvedCohort: {
            target: proposal.target,
            identity: proposal.identity,
            peers: proposal.peers.map((peer) => ({
              name: peer.name,
              url: peer.url,
              subscriberCount: peer.subscriberCount,
              creatorId: peer.creatorId
            })),
            cohortHash: proposal.cohortHash
          }
        }
      );
      verifyCompletedReport(record, result.report);
      const creditsUsed = result.report.audit.resultBasedCreditEstimate;
      await this.finalizeReservation(
        record,
        reservation.reservationId,
        `${idempotencyKey}:settle-execution`,
        "settled",
        creditsUsed
      );
      loaded = await this.transitionAndSave(
        loaded,
        "verifying",
        "application",
        "Persisted the report before its terminal verification decision",
        {
          report: result.report,
          quota: {
            ...record.quota,
            executionCreditsUsed: creditsUsed
          },
          auditEvents: appendAuditEvents(
            record.auditEvents,
            result.events
          )
        }
      );
      return this.continueReportWording(loaded);
    } catch (error) {
      const creditsUsed = failedStageCredits(
        record.mode,
        error,
        audit,
        approvedCreditCeiling
      );
      await this
        .finalizeReservation(
          record,
          reservation.reservationId,
          `${idempotencyKey}:fail-execution`,
          "settled",
          creditsUsed
        )
        .catch(() => undefined);
      loaded = await this.transitionAndSave(
        loaded,
        "failed",
        "application",
        "Execution failed closed without fabricating a report",
        {
          quota: {
            ...record.quota,
            executionCreditsUsed: creditsUsed
          },
          error: safeWorkflowError(error),
          auditEvents: appendAuditEvents(
            record.auditEvents,
            audit.getEvents()
          )
        }
      );
      return this.resource(loaded);
    }
  }

  private async continueReportWording(
    loaded: LoadedRun
  ): Promise<WorkflowRunResource> {
    const record = loaded.record;
    const report = record.report;
    if (
      report &&
      (!record.peerProposal?.identity || !report.targetIdentity)
    ) {
      loaded = await this.transitionAndSave(
        loaded,
        "failed",
        "policy",
        "Blocked report completion because verified YouTube identity was missing",
        {
          error: legacyIdentityRestartError()
        }
      );
      return this.resource(loaded);
    }
    if (!report || !record.wordingAgent.enabled) {
      return this.finishVerification(loaded);
    }
    const checkpoint = record.wordingAgent.reportWording;
    if (
      checkpoint.status === "completed" ||
      checkpoint.status === "fallback" ||
      checkpoint.status === "not_needed"
    ) {
      return this.finishVerification(loaded);
    }
    if (report.leads.length === 0) {
      const nextReport: WinbackReport = {
        ...report,
        wordingAgent: {
          status: "not_needed",
          provider: record.wordingAgent.provider,
          model: record.wordingAgent.model,
          promptVersion: "grounded-wording-v1",
          schemaVersion: "grounded-wording-v2",
          narratives: []
        }
      };
      loaded = await this.saveCheckpoint(
        loaded,
        {
          report: nextReport,
          wordingAgent: {
            ...record.wordingAgent,
            reportWording: {
              status: "not_needed",
              inputFingerprint: fingerprint({
                runId: record.runId,
                leads: []
              })
            }
          }
        },
        "Skipped report wording because the strict gate returned no leads"
      );
      return this.finishVerification(loaded);
    }

    const inputFingerprint = fingerprint({
      runId: record.runId,
      leads: report.leads.map((lead) => ({
        domain: lead.domain,
        peerUrl: lead.peerUrl,
        targetEvidence: lead.targetEvidence.contentUrl,
        peerEvidence: lead.peerEvidence.contentUrl,
        continuity: lead.continuity
      }))
    });
    if (checkpoint.status === "claimed") {
      const fallbackReport = withWordingFallback(
        report,
        record,
        "ambiguous_prior_llm_attempt"
      );
      loaded = await this.saveCheckpoint(
        loaded,
        {
          report: fallbackReport,
          wordingAgent: {
            ...record.wordingAgent,
            reportWording: {
              status: "fallback",
              inputFingerprint
            }
          }
        },
        "Used deterministic wording after an ambiguous prior LLM attempt"
      );
      return this.finishVerification(loaded);
    }

    const agent = this.compatibleWordingAgent(record);
    if (!agent) {
      const fallbackReport = withWordingFallback(
        report,
        record,
        "configured_wording_agent_unavailable"
      );
      loaded = await this.saveCheckpoint(
        loaded,
        {
          report: fallbackReport,
          wordingAgent: {
            ...record.wordingAgent,
            reportWording: {
              status: "fallback",
              inputFingerprint
            }
          }
        },
        "Used deterministic wording because the configured agent is unavailable"
      );
      return this.finishVerification(loaded);
    }

    loaded = await this.saveCheckpoint(
      loaded,
      {
        wordingAgent: {
          ...record.wordingAgent,
          reportWording: {
            status: "claimed",
            inputFingerprint
          }
        }
      },
      "Persisted the report-wording claim before the bounded LLM call"
    );
    const audit = new AuditRecorder({
      runId: record.runId,
      phase: phaseFor(record.mode, true),
      mode: record.mode
    });
    let nextReport: WinbackReport;
    let status: WordingInvocationCheckpoint["status"];
    try {
      const generated = await agent.wordQualifiedReport({
        runId: record.runId,
        report,
        audit,
        priorAuditEvents: loaded.record.auditEvents
      });
      assertReportNarratives(report, generated.narratives);
      nextReport = {
        ...report,
        wordingAgent: {
          status:
            generated.narratives.length === 0
              ? "not_needed"
              : "generated",
          provider: generated.provider,
          model: generated.model,
          promptVersion: generated.promptVersion,
          schemaVersion: generated.schemaVersion,
          narratives: generated.narratives
        }
      };
      status =
        generated.narratives.length === 0 ? "not_needed" : "completed";
    } catch (error) {
      nextReport = withWordingFallback(
        report,
        record,
        error instanceof Error ? error.name : "UnknownError"
      );
      status = "fallback";
    }
    const nextAuditEvents = appendAuditEvents(
      loaded.record.auditEvents,
      audit.getEvents()
    );
    nextReport = {
      ...nextReport,
      audit: summarizeReportAudit(nextReport.audit, nextAuditEvents)
    };
    loaded = await this.saveCheckpoint(
      loaded,
      {
        report: nextReport,
        wordingAgent: {
          ...loaded.record.wordingAgent,
          reportWording: {
            status,
            inputFingerprint
          }
        },
        auditEvents: nextAuditEvents
      },
      status === "completed"
        ? "Persisted validated grounded report wording"
        : "Persisted deterministic report wording fallback"
    );
    return this.finishVerification(loaded);
  }

  private async finishVerification(
    loaded: LoadedRun
  ): Promise<WorkflowRunResource> {
    const report = loaded.record.report;
    if (!report) {
      loaded = await this.transitionAndSave(
        loaded,
        "failed",
        "application",
        "Verification checkpoint did not contain a persisted report",
        {
          error: {
            code: "missing_persisted_report",
            message:
              "The run failed safely because its verification checkpoint was incomplete.",
            retryable: false
          }
        }
      );
      return this.resource(loaded);
    }

    verifyCompletedReport(loaded.record, report);
    const isPartial = report.coverage.some(
      (notice) =>
        notice.code === "peer_research_partial" ||
        notice.code === "upriver_result_cap"
    );
    try {
      loaded = await this.transitionAndSave(
        loaded,
        isPartial ? "partial" : "completed",
        "application",
        isPartial
          ? "Valid evidence was preserved with visibly partial peer coverage"
          : "Verified the completed evidence-backed report"
      );
      return this.resource(loaded);
    } catch (error) {
      if (error instanceof PersistenceConflictError) {
        return this.resource(await this.loadRun(loaded.record.runId));
      }
      throw error;
    }
  }

  private async failAmbiguousLiveStage(
    loaded: LoadedRun,
    reservation: StoredQuotaReservation,
    stage: "resolution" | "execution"
  ): Promise<WorkflowRunResource> {
    if (reservation.status === "released") {
      throw new WorkflowConflictError(
        `The interrupted ${stage} reservation was already released`
      );
    }
    let conservativeCredits =
      reservation.status === "settled"
        ? (reservation.actualUnits ?? reservation.requestedUnits)
        : reservation.requestedUnits;
    if (reservation.status === "active") {
      const finalized = await this.finalizeReservation(
        loaded.record,
        reservation.reservationId,
        `ambiguous:${stage}:${reservation.reservationId}`,
        "settled",
        conservativeCredits
      );
      conservativeCredits =
        finalized.value.actualUnits ?? conservativeCredits;
    }

    const quota =
      stage === "resolution"
        ? {
            ...loaded.record.quota,
            resolutionCreditsUsed: conservativeCredits
          }
        : {
            ...loaded.record.quota,
            executionCreditsUsed: conservativeCredits
          };
    loaded = await this.transitionAndSave(
      loaded,
      "failed",
      "policy",
      `Interrupted live ${stage} was not replayed because provider billing may be ambiguous`,
      {
        quota,
        error: {
          code: `ambiguous_live_${stage}`,
          message:
            `Live ${stage} may have spent credits before interruption. ` +
            "The full reservation was settled conservatively; start a new run only after reviewing provider usage.",
          retryable: false
        }
      }
    );
    return this.resource(loaded);
  }

  private async assertPlanStillCoversCurrentMisses(
    record: WorkflowRunRecord
  ): Promise<void> {
    const gateway = this.gatewayFactory({
      mode: record.mode,
      runId: record.runId,
      maximumCredits: record.plan.totalCreditCeiling
    });
    assertGatewayMode(gateway, record.mode);
    await gateway.prepareRun?.(record.requestedChannel);
    const currentTotal =
      gateway.estimateRunCredits() +
      executionRevalidationCreditCeiling(gateway);
    const currentResolution = resolutionCeilingFor(gateway, currentTotal);
    if (
      currentTotal > record.plan.totalCreditCeiling ||
      currentResolution > record.plan.resolutionCreditCeiling
    ) {
      throw new WorkflowConflictError(
        "Cached evidence changed the credit ceiling; create a new run for a fresh approval"
      );
    }
  }

  private async assertQuoteStillCoversCurrentMisses(
    record: WorkflowRunRecord,
    approvedCreditCeiling: number
  ): Promise<void> {
    const gateway = this.gatewayFactory({
      mode: record.mode,
      runId: record.runId,
      maximumCredits: approvedCreditCeiling
    });
    assertGatewayMode(gateway, record.mode);
    await gateway.prepareRun?.(record.requestedChannel);
    if (
      gateway.estimateRunCredits() +
        executionRevalidationCreditCeiling(gateway) >
      approvedCreditCeiling
    ) {
      throw new WorkflowConflictError(
        "Cached evidence changed the execution ceiling; create a new run for a fresh approval"
      );
    }
  }

  private async compensateClaimConflict(
    runId: string,
    reservation: StoredQuotaReservation,
    stage: "resolution" | "execution",
    idempotencyKey: string,
    error: unknown
  ): Promise<WorkflowRunResource> {
    if (!(error instanceof PersistenceConflictError)) {
      throw error;
    }
    const current = await this.loadRun(runId);
    const referencedReservation =
      stage === "resolution"
        ? current.record.quota.resolutionReservationId
        : current.record.quota.executionReservationId;
    if (referencedReservation === reservation.reservationId) {
      if (current.record.state.state === "cancelled") {
        await this.releaseReservationIfActive(
          current.record,
          reservation.reservationId,
          `${idempotencyKey}:cancelled-${stage}`
        );
      }
      return this.resource(current);
    }
    await this.releaseReservationIfActive(
      current.record,
      reservation.reservationId,
      `${idempotencyKey}:unclaimed-${stage}`
    );
    throw error;
  }

  private async releaseCancelledReservations(
    record: WorkflowRunRecord,
    idempotencyKey: string
  ): Promise<void> {
    const quota = await this.repository.readQuota(quotaKeyForRun(record));
    const activeReservations =
      quota?.reservations.filter(
        (reservation) =>
          reservation.runId === record.runId &&
          reservation.status === "active"
      ) ?? [];
    for (const reservation of activeReservations) {
      await this.releaseReservationIfActive(
        record,
        reservation.reservationId,
        `${idempotencyKey}:release:${reservation.reservationId}`
      );
    }
  }

  private async releaseReservationIfActive(
    record: WorkflowRunRecord,
    reservationId: string,
    idempotencyKey: string
  ): Promise<void> {
    const { quotaKey, reservation } = await this.findReservationLocation(
      record,
      reservationId
    );
    if (reservation.status !== "active") {
      return;
    }
    await this.repository.finalizeQuotaReservation({
      quotaKey,
      reservationId,
      idempotencyKey,
      outcome: "released"
    });
  }

  private operationLeaseExpired(record: WorkflowRunRecord): boolean {
    return (
      this.clock() - Date.parse(record.state.updatedAt) >=
      this.operationLeaseMs
    );
  }

  private compatibleWordingAgent(
    record: WorkflowRunRecord
  ): WordingAgent | undefined {
    const agent = this.wordingAgent;
    if (
      !record.wordingAgent.enabled ||
      !agent ||
      agent.provider !== record.wordingAgent.provider ||
      agent.model !== record.wordingAgent.model
    ) {
      return undefined;
    }
    return agent;
  }

  private async saveCheckpoint(
    loaded: LoadedRun,
    patch: Partial<WorkflowRunRecord>,
    reason: string
  ): Promise<LoadedRun> {
    const record: WorkflowRunRecord = {
      ...loaded.record,
      ...patch
    };
    const stored = await this.repository.saveRunSnapshot({
      runId: record.runId,
      valueSchemaVersion: RUN_SCHEMA_VERSION,
      value: toJson(record),
      expectedRevision: loaded.revision
    });
    await this.appendWorkflowEvent(record, "audit.persisted", reason);
    return { record, revision: stored.revision };
  }

  private async transitionAndSave(
    loaded: LoadedRun,
    to: RunState,
    actor: RunTransitionActor,
    reason: string,
    patch: Partial<WorkflowRunRecord> = {}
  ): Promise<LoadedRun> {
    const state = transitionRun(loaded.record.state, {
      to,
      occurredAt: this.nowIso(),
      actor,
      reason
    });
    const record: WorkflowRunRecord = {
      ...loaded.record,
      ...patch,
      state
    };
    const stored = await this.repository.saveRunSnapshot({
      runId: record.runId,
      valueSchemaVersion: RUN_SCHEMA_VERSION,
      value: toJson(record),
      expectedRevision: loaded.revision
    });
    await this.appendWorkflowEvent(
      record,
      "run.transitioned",
      reason
    );
    return { record, revision: stored.revision };
  }

  private async appendWorkflowEvent(
    record: WorkflowRunRecord,
    type: WorkflowEvent["type"],
    reason: string
  ): Promise<void> {
    await this.repository.appendRunEvent({
      runId: record.runId,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      event: toJson({
        type,
        state: record.state.state,
        stateVersion: record.state.version,
        reason
      })
    });
  }

  private async reserveQuota(
    record: WorkflowRunRecord,
    idempotencyKey: string,
    requestedUnits: number
  ): Promise<StoredQuotaReservation> {
    if (record.accounting.policy !== "per_run_v1") {
      throw new RunAccountingMigrationRequiredError();
    }
    const reservation = await this.repository.reserveQuota({
      quotaKey: quotaKeyForRun(record),
      runId: record.runId,
      idempotencyKey,
      requestedUnits,
      maximumUnits: record.accounting.maximumCredits
    });
    if (reservation.value.decision !== "reserved") {
      throw new RunCreditLimitExceededError();
    }
    return reservation.value;
  }

  private assertCanCreateReservation(record: WorkflowRunRecord): void {
    if (record.accounting.policy !== "per_run_v1") {
      throw new RunAccountingMigrationRequiredError();
    }
  }

  private async findReservation(
    record: WorkflowRunRecord,
    reservationId: string
  ): Promise<StoredQuotaReservation> {
    return (await this.findReservationLocation(record, reservationId))
      .reservation;
  }

  private async findReservationLocation(
    record: WorkflowRunRecord,
    reservationId: string
  ): Promise<{
    quotaKey: string;
    reservation: StoredQuotaReservation;
  }> {
    const quotaKey = quotaKeyForRun(record);
    const quota = await this.repository.readQuota(quotaKey);
    const reservation = quota?.reservations.find(
      (candidate) => candidate.reservationId === reservationId
    );
    if (!reservation) {
      throw new WorkflowConflictError("Persisted quota reservation is missing");
    }
    return { quotaKey, reservation };
  }

  private async finalizeReservation(
    record: WorkflowRunRecord,
    reservationId: string,
    idempotencyKey: string,
    outcome: "settled" | "released",
    actualUnits?: number
  ) {
    const { quotaKey } = await this.findReservationLocation(
      record,
      reservationId
    );
    return this.repository.finalizeQuotaReservation({
      quotaKey,
      reservationId,
      idempotencyKey,
      outcome,
      ...(actualUnits === undefined ? {} : { actualUnits })
    });
  }

  private async loadRun(runId: string): Promise<LoadedRun> {
    const snapshot = await this.repository.readRunSnapshot(runId);
    if (!snapshot) {
      throw new RunNotFoundError(runId);
    }
    return parseLoadedRun(
      snapshot.value,
      snapshot.revision,
      runId,
      snapshot.valueSchemaVersion
    );
  }

  private async resource(loaded: LoadedRun): Promise<WorkflowRunResource> {
    const events = await this.repository.readRunEvents(
      loaded.record.runId
    );
    return {
      ...structuredClone(loaded.record),
      version: loaded.revision,
      status: resourceStatus(loaded.record.state.state),
      outcome: resourceOutcome(loaded.record),
      availableActions: availableActions(
        loaded.record.state.state,
        this.operationLeaseExpired(loaded.record)
      ),
      workflowEvents: events.map((event) => ({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        event: event.event as unknown as WorkflowEvent
      }))
    };
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }
}

function assertGatewayMode(
  gateway: SponsorRadarEvidencePort,
  expectedMode: EvidenceMode
): void {
  if (gateway.mode !== expectedMode) {
    throw new WorkflowConflictError(
      `Persisted ${expectedMode} run cannot use a ${gateway.mode} evidence gateway`
    );
  }
}

function resolutionCeilingFor(
  gateway: SponsorRadarEvidencePort,
  totalCreditCeiling: number
): number {
  if (totalCreditCeiling === 0) {
    return 0;
  }
  return Math.min(
    totalCreditCeiling,
    gateway.estimateResolutionCredits?.() ??
      composeResolutionCredits((operation) =>
        gateway.estimateCredits(operation)
      )
  );
}

function executionRevalidationCreditCeiling(
  gateway: SponsorRadarEvidencePort
): number {
  return gateway.mode === "live" && gateway.resolveTargetFresh
    ? gateway.estimateCredits("resolve_target")
    : 0;
}

function isPaidOperationCheckpoint(state: RunState): boolean {
  return (
    state === "plan_approved" ||
    state === "resolving" ||
    state === "executing"
  );
}

function failedStageCredits(
  mode: EvidenceMode,
  error: unknown,
  audit: AuditRecorder,
  conservativeCeiling: number
): number {
  if (mode === "fixture") {
    return 0;
  }
  if (!(error instanceof YouTubeTargetVerificationError)) {
    return conservativeCeiling;
  }
  return (
    observedVerifiedResolutionCredits(audit) ??
    conservativeCeiling
  );
}

function observedVerifiedResolutionCredits(
  audit: AuditRecorder
): number | null {
  const events = audit.getEvents();
  const innerName = `upriver.http.${auditToolName("live", "resolve_target")}`;
  const matchingHttpEvents = events.filter(
    (event) =>
      (event.eventType === "http.completed" ||
        event.eventType === "http.failed") &&
      event.tool?.name === innerName
  );
  if (
    matchingHttpEvents.some(
      (event) => event.eventType === "http.failed"
    )
  ) {
    return null;
  }

  const completedHttp = matchingHttpEvents.filter(
    (event) => event.eventType === "http.completed"
  );
  if (completedHttp.length > 0) {
    const amounts = completedHttp.map(
      (event) => event.tool?.resultBasedCredits
    );
    if (
      amounts.every(
        (amount): amount is number =>
          typeof amount === "number" &&
          Number.isSafeInteger(amount) &&
          amount >= 0
      )
    ) {
      return amounts.reduce((sum, amount) => sum + amount, 0);
    }
    return null;
  }

  const completedTool = [...events]
    .reverse()
    .find(
      (event) =>
        event.eventType === "tool.completed" &&
        event.tool?.name === auditToolName("live", "resolve_target")
    );
  const amount = completedTool?.tool?.resultBasedCredits;
  return typeof amount === "number" &&
    Number.isSafeInteger(amount) &&
    amount >= 0
    ? amount
    : null;
}

function phaseFor(
  mode: EvidenceMode,
  wordingAgentEnabled = false
): AuditPhase {
  if (wordingAgentEnabled) {
    return mode === "live" ? "workflow_wording_live" : "workflow_wording_fixture";
  }
  return mode === "live" ? "workflow_live" : "workflow_fixture";
}

function appendAuditEvents(
  existing: readonly AuditEvent[],
  next: readonly AuditEvent[]
): AuditEvent[] {
  return [
    ...structuredClone(existing),
    ...next.map((event, index) => ({
      ...structuredClone(event),
      sequence: existing.length + index + 1
    }))
  ];
}

function quotaKeyForRun(record: WorkflowRunRecord): string {
  return record.accounting.policy === "legacy_shared_v1"
    ? LEGACY_SHARED_QUOTA_KEY
    : `${PER_RUN_QUOTA_KEY_PREFIX}:${record.runId}`;
}

function verifyCompletedReport(
  record: WorkflowRunRecord,
  report: WinbackReport
): void {
  const proposal = record.peerProposal;
  if (
    report.runId !== record.runId ||
    report.leads.length > 3 ||
    report.phase !== phaseFor(record.mode, record.wordingAgent.enabled) ||
    !proposal ||
    !completedTargetMatchesProposal(report, proposal)
  ) {
    throw new Error("The completed report violated its approved run contract");
  }
  for (const lead of report.leads) {
    if (
      !lead.targetEvidence.contentUrl ||
      !lead.peerEvidence.contentUrl ||
      !lead.domain
    ) {
      throw new Error("A qualified lead lost required evidence");
    }
  }
}

function completedTargetMatchesProposal(
  report: WinbackReport,
  proposal: WorkflowPeerProposal
): boolean {
  if (
    report.targetIdentity === null ||
    proposal.identity === null
  ) {
    return (
      report.targetIdentity === null &&
      proposal.identity === null &&
      report.target.name === proposal.target.name &&
      report.target.url === proposal.target.url &&
      report.target.subscriberCount ===
        proposal.target.subscriberCount
    );
  }
  return (
    sameVerifiedYouTubeIdentity(
      report.targetIdentity,
      proposal.identity
    ) &&
    report.target.subscriberCount === proposal.target.subscriberCount
  );
}

function assertPeerExplanations(
  peers: readonly LockedPeer[],
  generated: PeerExplanationResult
): void {
  if (
    generated.explanations.length !== peers.length ||
    generated.explanations.some(
      (explanation, index) =>
        explanation.peerUrl !== peers[index].url ||
        !explanation.rationale.trim() ||
        explanation.evidenceIds.length !== 2
    )
  ) {
    throw new Error(
      "Generated peer rationale did not preserve the locked cohort"
    );
  }
}

function assertReportNarratives(
  report: WinbackReport,
  narratives: readonly {
    leadIndex: number;
    sentences: readonly {
      text: string;
      claimIds: readonly string[];
      evidenceIds: readonly string[];
    }[];
  }[]
): void {
  if (narratives.length !== report.leads.length) {
    throw new Error(
      "Generated report wording changed the qualified lead count"
    );
  }
  for (let index = 0; index < narratives.length; index += 1) {
    const narrative = narratives[index];
    if (
      narrative.leadIndex !== index ||
      narrative.sentences.length < 1 ||
      narrative.sentences.length > 3 ||
      narrative.sentences.some(
        (sentence) =>
          !sentence.text.trim() ||
          sentence.claimIds.length === 0 ||
          sentence.evidenceIds.length === 0
      )
    ) {
      throw new Error(
        "Generated report wording violated its presentation-only contract"
      );
    }
  }
}

function withWordingFallback(
  report: WinbackReport,
  record: WorkflowRunRecord,
  fallbackReason: string
): WinbackReport {
  return {
    ...report,
    wordingAgent: {
      status: "fallback",
      provider: record.wordingAgent.provider,
      model: record.wordingAgent.model,
      promptVersion: "grounded-wording-v1",
      schemaVersion: "grounded-wording-v2",
      narratives: [],
      fallbackReason
    }
  };
}

function summarizeReportAudit(
  base: WinbackReport["audit"],
  events: readonly AuditEvent[]
): WinbackReport["audit"] {
  return {
    ...base,
    llmCalls: events.filter(
      (event) => event.eventType === "llm.started"
    ).length,
    skillsLoaded: [
      ...new Set(
        events.flatMap((event) =>
          event.skill ? [event.skill.name] : []
        )
      )
    ]
  };
}

function safeWorkflowError(error: unknown): WorkflowRunError {
  if (error instanceof YouTubeTargetVerificationError) {
    return {
      code: error.code,
      message:
        "That handle or link did not resolve to one exact YouTube channel. Check it and start a new search.",
      retryable: false
    };
  }
  // Never echo a raw internal error message into persisted, publicly readable
  // run state. Internal messages can embed provider-derived names, URLs, or
  // configuration details, and this value is served verbatim by the read API.
  // Classify the failure category from the message but always return a fixed,
  // reviewed message — never the original text.
  const message = error instanceof Error ? error.message : "";
  if (/falls outside the locked reach window/i.test(message)) {
    return {
      code: "peer_reach_window",
      message:
        "A comparable channel fell outside the approved reach window. Start a new search.",
      retryable: false
    };
  }
  if (/unsupported|supports only/i.test(message)) {
    return {
      code: "unsupported_channel_input",
      message:
        "This channel is not supported for research. Enter one YouTube channel and start a new search.",
      retryable: false
    };
  }
  return {
    code: "unknown_failure",
    message: "The run failed safely. Start a new search.",
    retryable: false
  };
}

function legacyIdentityRestartError(): WorkflowRunError {
  return {
    code: "target_not_verified",
    message:
      "This saved search predates verified channel identity. Start a new search.",
    retryable: false
  };
}

function parseLoadedRun(
  value: JsonValue,
  revision: number,
  expectedRunId: string,
  outerSchemaVersion: ValueSchemaVersion
): LoadedRun {
  const state =
    isJsonRecord(value) && isJsonRecord(value.state)
      ? value.state
      : null;
  const plan =
    isJsonRecord(value) && isJsonRecord(value.plan)
      ? value.plan
      : null;
  const approvals =
    isJsonRecord(value) && isJsonRecord(value.approvals)
      ? value.approvals
      : null;
  const quota =
    isJsonRecord(value) && isJsonRecord(value.quota)
      ? value.quota
      : null;
  const accounting =
    isJsonRecord(value) && isJsonRecord(value.accounting)
      ? value.accounting
      : null;
  const persistedSchemaVersion = isJsonRecord(value)
    ? value.schemaVersion
    : null;
  // Backward reader: pre-rename schema-4 snapshots stored the wording block
  // (structurally identical) under the historical top-level `phase4` key. Read
  // it as `wordingAgent` so those runs restore instead of failing closed.
  const wordingAgent =
    isJsonRecord(value) && isJsonRecord(value.wordingAgent)
      ? value.wordingAgent
      : isJsonRecord(value) && isJsonRecord(value.phase4)
        ? value.phase4
        : null;
  if (
    !isJsonRecord(value) ||
    outerSchemaVersion !== persistedSchemaVersion ||
    (persistedSchemaVersion !== 1 &&
      persistedSchemaVersion !== 2 &&
      persistedSchemaVersion !== 3 &&
      persistedSchemaVersion !== RUN_SCHEMA_VERSION) ||
    value.runId !== expectedRunId ||
    typeof value.requestedChannel !== "string" ||
    (value.mode !== "fixture" && value.mode !== "live") ||
    !state ||
    typeof state.state !== "string" ||
    !(RUN_STATES as readonly string[]).includes(state.state) ||
    !Number.isInteger(state.version) ||
    typeof state.createdAt !== "string" ||
    typeof state.updatedAt !== "string" ||
    !Array.isArray(state.history) ||
    !plan ||
    typeof plan.planId !== "string" ||
    !Number.isInteger(plan.resolutionCreditCeiling) ||
    !Number.isInteger(plan.executionCreditCeiling) ||
    !Number.isInteger(plan.totalCreditCeiling) ||
    plan.maxPeers !== MAX_PEERS ||
    !Array.isArray(plan.operations) ||
    !approvals ||
    !("plan" in approvals) ||
    !("execution" in approvals) ||
    !quota ||
    !Number.isInteger(quota.resolutionCreditsUsed) ||
    !Number.isInteger(quota.executionCreditsUsed) ||
    !("resolutionReservationId" in quota) ||
    !("executionReservationId" in quota) ||
    !("peerProposal" in value) ||
    !("report" in value) ||
    (persistedSchemaVersion === RUN_SCHEMA_VERSION &&
      !("resolvedCohort" in value)) ||
    !("error" in value) ||
    !Array.isArray(value.auditEvents) ||
    !validResolvedCohort(
      value.resolvedCohort,
      persistedSchemaVersion
    ) ||
    !validPeerProposal(value.peerProposal, persistedSchemaVersion) ||
    !validReportIdentity(value.report, persistedSchemaVersion)
  ) {
    throw new PersistenceCorruptionError(
      `Persisted workflow run ${expectedRunId} is invalid`
    );
  }
  if (
    (persistedSchemaVersion === 2 ||
      persistedSchemaVersion === 3 ||
      persistedSchemaVersion === RUN_SCHEMA_VERSION) &&
    (!Number.isInteger(plan.llmCallCeiling) ||
      !Number.isInteger(plan.llmOutputTokenCeiling) ||
      !wordingAgent ||
      typeof wordingAgent.enabled !== "boolean" ||
      typeof wordingAgent.provider !== "string" ||
      typeof wordingAgent.model !== "string" ||
      !isJsonRecord(wordingAgent.peerRationale) ||
      !isJsonRecord(wordingAgent.reportWording))
  ) {
    throw new PersistenceCorruptionError(
      `Persisted wording-augmented run ${expectedRunId} is invalid`
    );
  }
  if (
    (persistedSchemaVersion === 3 ||
      persistedSchemaVersion === RUN_SCHEMA_VERSION) &&
    (!accounting ||
      (accounting.policy !== "per_run_v1" &&
        accounting.policy !== "legacy_shared_v1") ||
      !Number.isInteger(accounting.maximumCredits) ||
      (accounting.maximumCredits as number) < 0 ||
      (accounting.policy === "per_run_v1" &&
        ((accounting.maximumCredits as number) === 0 ||
          (accounting.maximumCredits as number) >
            MAXIMUM_RUN_CREDITS)))
  ) {
    throw new PersistenceCorruptionError(
      `Persisted run accounting policy ${expectedRunId} is invalid`
    );
  }
  if (
    state.state === "no_eligible_peers" &&
    (!isJsonRecord(value.resolvedCohort) ||
      !Array.isArray(value.resolvedCohort.peers) ||
      value.resolvedCohort.peers.length !== 0 ||
      value.peerProposal !== null ||
      value.report !== null)
  ) {
    throw new PersistenceCorruptionError(
      `Persisted no-eligible-peers run ${expectedRunId} is invalid`
    );
  }

  const record = structuredClone(
    value
  ) as unknown as WorkflowRunRecord;
  // Normalize a historical top-level `phase4` wording block to the
  // capability-named `wordingAgent` field before any consumer reads it.
  const wordingCarrier = record as unknown as {
    wordingAgent?: WorkflowRunRecord["wordingAgent"];
    phase4?: WorkflowRunRecord["wordingAgent"];
  };
  if (!wordingCarrier.wordingAgent && wordingCarrier.phase4) {
    wordingCarrier.wordingAgent = wordingCarrier.phase4;
    delete wordingCarrier.phase4;
  }
  if (persistedSchemaVersion === 1) {
    record.plan.llmCallCeiling = 0;
    record.plan.llmOutputTokenCeiling = 0;
    record.wordingAgent = {
      enabled: false,
      provider: "disabled",
      model: "disabled",
      peerRationale: {
        status: "not_needed",
        inputFingerprint: null
      },
      reportWording: {
        status: "not_needed",
        inputFingerprint: null
      }
    };
    if (record.peerProposal && !record.peerProposal.cohortHash) {
      record.peerProposal.cohortHash = approvedCohortHash(
        record.peerProposal.target,
        record.peerProposal.peers.map((peer) => ({
          name: peer.name,
          url: peer.url,
          subscriberCount: peer.subscriberCount,
          creatorId: peer.creatorId
        }))
      );
    }
  }
  if (
    persistedSchemaVersion === 1 ||
    persistedSchemaVersion === 2
  ) {
    record.schemaVersion = RUN_SCHEMA_VERSION;
    record.accounting = {
      policy: "legacy_shared_v1",
      maximumCredits: record.plan.totalCreditCeiling
    };
  }
  if (!("resolvedCohort" in value)) {
    record.resolvedCohort = record.peerProposal
      ? {
          target: record.peerProposal.target,
          identity: null,
          peers: record.peerProposal.peers.map((peer) => ({
            name: peer.name,
            url: peer.url,
            subscriberCount: peer.subscriberCount,
            creatorId: peer.creatorId
          }))
        }
      : null;
  }
  if (
    persistedSchemaVersion === 1 ||
    persistedSchemaVersion === 2 ||
    persistedSchemaVersion === 3
  ) {
    record.schemaVersion = RUN_SCHEMA_VERSION;
    if (record.resolvedCohort) {
      record.resolvedCohort.identity = null;
    }
    if (record.peerProposal) {
      record.peerProposal.identity = null;
    }
    if (record.report) {
      record.report.targetIdentity = null;
    }
  }
  if (persistedSchemaVersion === RUN_SCHEMA_VERSION) {
    assertNativeIdentityForState(record, expectedRunId);
  }
  assertConsistentPersistedIdentityCopies(record, expectedRunId);
  return {
    record,
    revision
  };
}

function isJsonRecord(
  value: JsonValue | undefined
): value is { [key: string]: JsonValue } {
  return value !== null && value !== undefined && !Array.isArray(value) &&
    typeof value === "object";
}

function validResolvedCohort(
  value: JsonValue | undefined,
  schemaVersion: JsonValue
): boolean {
  if (value === undefined || value === null) return true;
  if (
    !isJsonRecord(value) ||
    !Array.isArray(value.peers) ||
    value.peers.length > MAX_PEERS ||
    (schemaVersion === RUN_SCHEMA_VERSION &&
      !validTargetSummary(value.target))
  ) {
    return false;
  }
  if (schemaVersion !== RUN_SCHEMA_VERSION) {
    return true;
  }
  return (
    "identity" in value &&
    validNullableVerifiedIdentity(value.identity) &&
    validIdentityTargetPair(value.identity, value.target)
  );
}

function validPeerProposal(
  value: JsonValue | undefined,
  schemaVersion: JsonValue
): boolean {
  if (value === null) return true;
  if (
    !isJsonRecord(value) ||
    !Array.isArray(value.peers) ||
    value.peers.length < 1 ||
    value.peers.length > MAX_PEERS ||
    (schemaVersion === RUN_SCHEMA_VERSION &&
      !validTargetSummary(value.target))
  ) {
    return false;
  }
  if (schemaVersion !== RUN_SCHEMA_VERSION) {
    return true;
  }
  return (
    "identity" in value &&
    validNullableVerifiedIdentity(value.identity) &&
    validIdentityTargetPair(value.identity, value.target)
  );
}

function validNullableVerifiedIdentity(
  value: JsonValue | undefined
): value is VerifiedYouTubeIdentity | null {
  if (value === null) {
    return true;
  }
  if (
    !isJsonRecord(value) ||
    typeof value.verificationBasis !== "string" ||
    typeof value.canonicalUrl !== "string" ||
    typeof value.key !== "string"
  ) {
    return false;
  }

  try {
    const canonical = parseYouTubeChannelReference(value.canonicalUrl);
    if (canonical.lookupUrl !== value.canonicalUrl) {
      return false;
    }
    if (value.verificationBasis === "channel_id") {
      if (
        typeof value.channelId !== "string" ||
        (value.handle !== null && typeof value.handle !== "string") ||
        value.key !== `channel:${value.channelId}`
      ) {
        return false;
      }
      const channelId = parseYouTubeChannelReference(
        `/channel/${value.channelId}`
      );
      if (
        channelId.kind !== "channel_id" ||
        channelId.channelId !== value.channelId
      ) {
        return false;
      }
      if (value.handle === null) {
        return (
          canonical.kind === "channel_id" &&
          canonical.channelId === value.channelId
        );
      }
      if (value.handle.startsWith("@")) {
        return false;
      }
      const handle = parseYouTubeChannelReference(value.handle);
      return (
        handle.kind === "handle" &&
        canonical.kind === "handle" &&
        canonical.requestKey === handle.requestKey
      );
    }
    if (value.verificationBasis === "exact_unique_handle") {
      if (
        value.channelId !== null ||
        typeof value.handle !== "string" ||
        value.handle.startsWith("@")
      ) {
        return false;
      }
      const handle = parseYouTubeChannelReference(value.handle);
      return (
        handle.kind === "handle" &&
        canonical.kind === "handle" &&
        canonical.requestKey === handle.requestKey &&
        value.key === handle.requestKey
      );
    }
  } catch {
    return false;
  }
  return false;
}

function validIdentityTargetPair(
  identity: JsonValue | undefined,
  target: JsonValue | undefined
): boolean {
  if (identity === null) {
    return true;
  }
  return (
    isJsonRecord(target) &&
    typeof target.url === "string" &&
    isJsonRecord(identity) &&
    typeof identity.canonicalUrl === "string" &&
    target.url === identity.canonicalUrl
  );
}

function validTargetSummary(value: JsonValue | undefined): boolean {
  if (
    !isJsonRecord(value) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.url !== "string" ||
    !Number.isSafeInteger(value.subscriberCount) ||
    (value.subscriberCount as number) <= 0
  ) {
    return false;
  }
  try {
    const reference = parseYouTubeChannelReference(value.url);
    return (
      (reference.kind === "handle" ||
        reference.kind === "channel_id") &&
      reference.lookupUrl === value.url
    );
  } catch {
    return false;
  }
}

function validReportIdentity(
  value: JsonValue | undefined,
  schemaVersion: JsonValue
): boolean {
  if (value === null) {
    return true;
  }
  if (!isJsonRecord(value)) {
    return false;
  }
  if (schemaVersion !== RUN_SCHEMA_VERSION) {
    return true;
  }
  return (
    validTargetSummary(value.target) &&
    "targetIdentity" in value &&
    validNullableVerifiedIdentity(value.targetIdentity) &&
    validIdentityTargetPair(value.targetIdentity, value.target)
  );
}

function assertConsistentPersistedIdentityCopies(
  record: WorkflowRunRecord,
  expectedRunId: string
): void {
  const identities = [
    ...(record.resolvedCohort
      ? [record.resolvedCohort.identity]
      : []),
    ...(record.peerProposal ? [record.peerProposal.identity] : []),
    ...(record.report ? [record.report.targetIdentity] : [])
  ];
  const first = identities[0];
  if (first === undefined) {
    return;
  }
  if (
    identities.some(
      (identity) =>
        !nullableVerifiedIdentitiesMatch(first, identity)
    )
  ) {
    throw new PersistenceCorruptionError(
      `Persisted target identity copies for ${expectedRunId} disagree`
    );
  }
}

function assertNativeIdentityForState(
  record: WorkflowRunRecord,
  expectedRunId: string
): void {
  const state = record.state.state;
  const requiresResolved = [
    "no_eligible_peers",
    "resolved",
    "peers_proposed",
    "peers_approved",
    "credit_approved",
    "executing",
    "verifying",
    "completed",
    "partial"
  ].includes(state);
  const requiresProposal = [
    "peers_proposed",
    "peers_approved",
    "credit_approved",
    "executing",
    "verifying",
    "completed",
    "partial"
  ].includes(state);
  const requiresReport = ["verifying", "completed", "partial"].includes(
    state
  );
  if (
    (requiresResolved && !record.resolvedCohort?.identity) ||
    (requiresProposal && !record.peerProposal?.identity) ||
    (requiresReport && !record.report?.targetIdentity)
  ) {
    throw new PersistenceCorruptionError(
      `Persisted run ${expectedRunId} lacks required verified target identity`
    );
  }
}

function nullableVerifiedIdentitiesMatch(
  first: VerifiedYouTubeIdentity | null,
  second: VerifiedYouTubeIdentity | null
): boolean {
  if (first === null || second === null) {
    return first === second;
  }
  return sameVerifiedYouTubeIdentity(first, second);
}

function toJson(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue;
}

export function runIdFor(idempotencyKey: string): string {
  return `run_${createHash("sha256")
    .update(`sponsor-radar-workflow\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function resourceStatus(
  state: RunState
): WorkflowRunResource["status"] {
  switch (state) {
    case "submitted":
    case "planned":
      return "awaiting_plan_approval";
    case "plan_approved":
    case "resolving":
    case "resolved":
      return "resolving_peers";
    case "peers_proposed":
    case "peers_approved":
    case "credit_approved":
      return "awaiting_execution_approval";
    case "executing":
    case "verifying":
      return "executing";
    case "no_eligible_peers":
    case "completed":
      return "completed";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function availableActions(
  state: RunState,
  operationLeaseExpired: boolean
): WorkflowRunAction[] {
  switch (state) {
    case "planned":
      return ["approve_plan", "cancel"];
    case "plan_approved":
      return operationLeaseExpired ? ["resume", "cancel"] : ["cancel"];
    case "resolving":
    case "executing":
      return operationLeaseExpired ? ["resume"] : [];
    case "resolved":
    case "peers_approved":
    case "credit_approved":
      return ["resume"];
    case "peers_proposed":
      return ["approve_execution", "cancel"];
    case "submitted":
      return ["cancel"];
    case "verifying":
      return ["resume"];
    case "no_eligible_peers":
    case "completed":
    case "partial":
    case "failed":
    case "cancelled":
      return [];
  }
}

function isTerminalState(state: RunState): boolean {
  return (
    state === "no_eligible_peers" ||
    state === "completed" ||
    state === "partial" ||
    state === "failed" ||
    state === "cancelled"
  );
}

function resourceOutcome(record: WorkflowRunRecord): WorkflowRunOutcome | null {
  if (record.state.state === "no_eligible_peers") {
    return "no_eligible_peers";
  }
  if (
    (record.state.state === "completed" ||
      record.state.state === "partial") &&
    record.report
  ) {
    return record.report.leads.length > 0
      ? "opportunities_found"
      : "no_qualified_opportunities";
  }
  return null;
}

function assertExpectedVersion(actual: number, expected: number): void {
  nonNegativeInteger(expected, "expectedVersion");
  if (actual !== expected) {
    throw new WorkflowConflictError(
      `Run is at version ${actual}, not expected version ${expected}`
    );
  }
}

function assertIdempotencyKey(value: string): void {
  if (value.trim().length < 8 || value.length > 200) {
    throw new TypeError(
      "idempotencyKey must contain between 8 and 200 characters"
    );
  }
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

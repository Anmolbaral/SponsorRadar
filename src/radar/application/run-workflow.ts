import { createHash } from "node:crypto";
import type { AuditEvent } from "@/src/observability/audit";
import type { AuditRecorder } from "@/src/observability/audit";
import type {
  EvidenceMode,
  LockedPeer,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import type {
  RunState,
  RunStateSnapshot
} from "@/src/radar/domain/run-state";
import type {
  TargetSummary,
  WinbackReport
} from "@/src/radar/domain/types";
import type { VerifiedYouTubeIdentity } from "@/src/radar/domain/youtube";

/**
 * The public run wire contract (ADR 0007/0009). The legacy WorkflowService
 * that once lived here was deleted at the agentic cutover; these shapes are
 * frozen because the UI and persisted records depend on them, including
 * fields the agentic engine only synthesizes (plan, approvals, wordingAgent).
 */

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

/** The seed literal is load-bearing: persisted run IDs derive from it. */
export function runIdFor(idempotencyKey: string): string {
  return `run_${createHash("sha256")
    .update(`sponsor-radar-workflow\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

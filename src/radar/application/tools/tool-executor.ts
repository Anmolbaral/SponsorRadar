import type { AuditRecorder } from "@/src/observability/audit";
import type { VerificationLedger } from "@/src/radar/adapters/upriver/contracts";
import type { NormalizedSponsorEvidenceResult } from "@/src/radar/adapters/upriver/normalize";
import type {
  EvidenceCacheStatus,
  EvidenceMode,
  LockedPeer,
  ResolvedTarget,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import {
  auditToolName,
  isRegisteredOperation,
  TOOL_REGISTRY,
  type EvidenceOperation,
  type EvidenceToolPolicy,
  type ToolExecutionStage
} from "@/src/radar/application/tools/tool-registry";
import { UPRIVER_CREDIT_RATES } from "@/src/radar/domain/credits";

export type { ToolExecutionStage };

/**
 * A registry-policy denial. Raised before any adapter call whenever an
 * operation is unregistered or requested outside its allowed mode, stage,
 * or input contract, and after a call whose output violates the operation's
 * structural contract.
 */
export class ToolPolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPolicyViolationError";
  }
}

export interface EvidenceToolRequests {
  resolve_target: {
    channel: string;
    /**
     * Execution may require a new provider observation even when target
     * resolution is cached; fresh requests bypass only the resolve cache.
     */
    fresh?: boolean;
  };
  list_locked_peers: {
    targetUrl: string;
    targetSubscriberCount: number;
  };
  list_target_sponsors: { targetUrl: string };
  list_peer_sponsors: { peerUrl: string };
  load_verification_ledger: {
    /** Stable cache identity of the manual verification ledger. */
    ledgerKey: string;
  };
}

export interface EvidenceToolResults {
  resolve_target: ResolvedTarget;
  list_locked_peers: LockedPeer[];
  list_target_sponsors: NormalizedSponsorEvidenceResult;
  list_peer_sponsors: NormalizedSponsorEvidenceResult;
  load_verification_ledger: VerificationLedger;
}

export interface EvidenceToolCall {
  /** Human-readable audit reason; callers own the contextual wording. */
  reason: string;
  /** Exact audit input payload; its fingerprint is frozen in audit history. */
  auditInput: unknown;
}

interface OperationHandler<K extends EvidenceOperation> {
  validate(request: EvidenceToolRequests[K]): void;
  cacheInput(request: EvidenceToolRequests[K]): {
    input: string;
    targetSubscriberCount?: number;
  };
  dispatch(
    port: SponsorRadarEvidencePort,
    request: EvidenceToolRequests[K]
  ): Promise<EvidenceToolResults[K]>;
  rows(result: EvidenceToolResults[K]): number;
  outputViolation(result: EvidenceToolResults[K]): string | null;
}

const OPERATION_HANDLERS: {
  [K in EvidenceOperation]: OperationHandler<K>;
} = {
  resolve_target: {
    validate(request) {
      requireNonEmpty("channel", request.channel);
    },
    cacheInput(request) {
      return { input: request.channel };
    },
    dispatch(port, request) {
      if (request.fresh) {
        if (!port.resolveTargetFresh) {
          throw new ToolPolicyViolationError(
            "A fresh target resolution was requested from an adapter without resolveTargetFresh"
          );
        }
        return port.resolveTargetFresh(request.channel);
      }
      return port.resolveTarget(request.channel);
    },
    rows() {
      return 1;
    },
    outputViolation(result) {
      return result?.target && result?.identity && result?.config
        ? null
        : "Resolved target output is missing its target, identity, or config";
    }
  },
  list_locked_peers: {
    validate(request) {
      requireNonEmpty("targetUrl", request.targetUrl);
      requirePositiveInteger(
        "targetSubscriberCount",
        request.targetSubscriberCount
      );
    },
    cacheInput(request) {
      return {
        input: request.targetUrl,
        targetSubscriberCount: request.targetSubscriberCount
      };
    },
    dispatch(port, request) {
      return port.listLockedPeers(
        request.targetUrl,
        request.targetSubscriberCount
      );
    },
    rows(result) {
      return result.length;
    },
    outputViolation(result) {
      return Array.isArray(result)
        ? null
        : "Peer discovery output is not a peer list";
    }
  },
  list_target_sponsors: {
    validate(request) {
      requireNonEmpty("targetUrl", request.targetUrl);
    },
    cacheInput(request) {
      return { input: request.targetUrl };
    },
    dispatch(port, request) {
      return port.listTargetSponsors(request.targetUrl);
    },
    rows(result) {
      return result.rows.length;
    },
    outputViolation(result) {
      return sponsorResultViolation(result);
    }
  },
  list_peer_sponsors: {
    validate(request) {
      requireNonEmpty("peerUrl", request.peerUrl);
    },
    cacheInput(request) {
      return { input: request.peerUrl };
    },
    dispatch(port, request) {
      return port.listPeerSponsors(request.peerUrl);
    },
    rows(result) {
      return result.rows.length;
    },
    outputViolation(result) {
      return sponsorResultViolation(result);
    }
  },
  load_verification_ledger: {
    validate(request) {
      requireNonEmpty("ledgerKey", request.ledgerKey);
    },
    cacheInput(request) {
      return { input: request.ledgerKey };
    },
    dispatch(port) {
      return port.loadVerificationLedger();
    },
    rows(result) {
      return result.peer_inventory.length + result.overlaps.length;
    },
    outputViolation(result) {
      return Array.isArray(result?.peer_inventory) &&
        Array.isArray(result?.overlaps)
        ? null
        : "Verification ledger output is missing its inventory or overlaps";
    }
  }
};

export interface EvidenceToolExecutorOptions {
  port: SponsorRadarEvidencePort;
  audit: AuditRecorder;
  stage: ToolExecutionStage;
}

/**
 * The only path from application code to an evidence adapter (ADR 0004).
 *
 * Pipeline, in order: registered → mode allowed → stage allowed → input
 * contract → cache inspection and cost policy → exactly one adapter call
 * inside the append-only audit lifecycle → output contract → result-based
 * settlement per the registry settlement class. Denials fail closed before
 * any adapter work; nothing here ever retries a paid call.
 */
export class EvidenceToolExecutor {
  private readonly port: SponsorRadarEvidencePort;
  private readonly audit: AuditRecorder;
  private readonly stage: ToolExecutionStage;

  constructor(options: EvidenceToolExecutorOptions) {
    this.port = options.port;
    this.audit = options.audit;
    this.stage = options.stage;
  }

  async execute<K extends EvidenceOperation>(
    operation: K,
    request: EvidenceToolRequests[K],
    call: EvidenceToolCall
  ): Promise<EvidenceToolResults[K]> {
    if (!isRegisteredOperation(operation)) {
      throw new ToolPolicyViolationError(
        `Unregistered provider operation was refused: ${String(operation)}`
      );
    }
    const entry: EvidenceToolPolicy = TOOL_REGISTRY[operation];
    if (!entry.allowedModes.includes(this.port.mode)) {
      throw new ToolPolicyViolationError(
        `Operation ${operation} is not allowed in ${this.port.mode} mode`
      );
    }
    if (!entry.allowedStages.includes(this.stage)) {
      throw new ToolPolicyViolationError(
        `Operation ${operation} is not allowed in the ${this.stage} stage`
      );
    }
    const handler = OPERATION_HANDLERS[operation] as OperationHandler<K>;
    handler.validate(request);

    const policy = await this.callPolicy(operation, handler, request);
    const scope = entry.auditScope === "local" ? "local" : this.port.mode;
    return this.audit.tool(
      {
        name: auditToolName(scope, operation),
        reason: call.reason,
        mode: entry.auditScope === "local" ? "fixture" : this.port.mode,
        input: call.auditInput,
        cacheStatus: policy.cacheStatus,
        estimatedCredits: policy.estimatedCredits
      },
      async () => {
        const result = await handler.dispatch(this.port, request);
        const violation = handler.outputViolation(result);
        if (violation !== null) {
          throw new ToolPolicyViolationError(violation);
        }
        return result;
      },
      (result) => ({
        rows: handler.rows(result),
        ...this.settle(operation, entry, policy, handler.rows(result))
      })
    );
  }

  private async callPolicy<K extends EvidenceOperation>(
    operation: K,
    handler: OperationHandler<K>,
    request: EvidenceToolRequests[K]
  ): Promise<{
    cacheStatus: EvidenceCacheStatus;
    estimatedCredits: number;
  }> {
    if (
      operation === "resolve_target" &&
      (request as EvidenceToolRequests["resolve_target"]).fresh
    ) {
      return {
        cacheStatus: "miss",
        estimatedCredits: this.port.estimateCredits("resolve_target")
      };
    }
    const cacheInput = handler.cacheInput(request);
    const cacheStatus =
      (await this.port.inspectCache?.(
        operation,
        cacheInput.input,
        cacheInput.targetSubscriberCount
      )) ?? (this.port.mode === "fixture" ? "hit" : "not_applicable");
    return {
      cacheStatus,
      estimatedCredits:
        cacheStatus === "hit" ? 0 : this.port.estimateCredits(operation)
    };
  }

  private settle(
    operation: EvidenceOperation,
    entry: EvidenceToolPolicy,
    policy: { cacheStatus: EvidenceCacheStatus; estimatedCredits: number },
    rows: number
  ): { resultBasedCredits?: number | null } {
    switch (entry.settlement) {
      case "free":
        return {};
      case "fixed_per_call":
        return {
          resultBasedCredits: settledCredits(
            this.port.mode,
            policy.cacheStatus,
            UPRIVER_CREDIT_RATES[entry.billing!.rateKind]
          )
        };
      case "rate_times_rows":
        return {
          resultBasedCredits: settledCredits(
            this.port.mode,
            policy.cacheStatus,
            rows * UPRIVER_CREDIT_RATES[entry.billing!.rateKind]
          )
        };
      case "observed_http_rows":
        return {
          resultBasedCredits: settledCredits(
            this.port.mode,
            policy.cacheStatus,
            observedHttpResultCredits(
              this.audit,
              auditToolName("live", operation),
              policy.estimatedCredits
            )
          )
        };
    }
  }
}

function settledCredits(
  mode: EvidenceMode,
  cacheStatus: EvidenceCacheStatus,
  uncachedCredits: number
): number | null {
  if (mode === "fixture") return null;
  return cacheStatus === "hit" ? 0 : uncachedCredits;
}

function observedHttpResultCredits(
  audit: AuditRecorder,
  operation: string,
  conservativeFallback: number
): number {
  const completed = [...audit.getEvents()]
    .reverse()
    .find(
      (event) =>
        event.eventType === "http.completed" &&
        event.tool?.name === `upriver.http.${operation}`
    );
  return completed?.tool?.resultBasedCredits ?? conservativeFallback;
}

function requireNonEmpty(name: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolPolicyViolationError(
      `Operation input ${name} must be a non-empty string`
    );
  }
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ToolPolicyViolationError(
      `Operation input ${name} must be a positive integer`
    );
  }
}

function sponsorResultViolation(
  result: NormalizedSponsorEvidenceResult
): string | null {
  return Array.isArray(result?.rows) &&
    (result.completeness === "complete" || result.completeness === "partial")
    ? null
    : "Sponsor evidence output violates its structural contract";
}

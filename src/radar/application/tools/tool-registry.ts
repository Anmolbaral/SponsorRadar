import { UPRIVER_CREDIT_RATES } from "@/src/radar/domain/credits";

/**
 * Authoritative provider tool registry (ADR 0004).
 *
 * Every provider evidence operation the application may execute is declared
 * here, and only here. The `EvidenceOperation` union is derived from these
 * keys, so an operation that is not registered cannot be named anywhere in
 * the application layer, and the `EvidenceToolExecutor` refuses any
 * operation string outside this set at runtime.
 *
 * Deliberate omissions:
 * - `brand_research` is deferred (Phase 2A decision). It has no registry
 *   entry, so it is structurally unexecutable; a guardrail test pins that it
 *   never appears in audit history.
 * - Skill-section links stay in `agent-context/manifest.json`, whose loader
 *   already owns section integrity by hash. The registry describes provider
 *   operations, not agent context.
 * - Runtime evidence, qualification policy, normalization, HTTP mechanics,
 *   secrets, balances, and persisted run state remain outside registry
 *   metadata (ADR 0004).
 *
 * Zero-retry invariant: the executor performs exactly one adapter call per
 * execution. Paid operations are never replayed after an ambiguous failure
 * (`replayClass: "paid_zero_retry"`); the live HTTP client independently
 * enforces `maxRetries: 0`.
 *
 * The LLM never receives executor or audit-write capability: every entry is
 * `llmExposed: false` at the type level, and the OpenAI adapter pins an
 * empty tool list.
 */

/** Modes an operation may run under. Mirrors `EvidenceMode` in ports.ts. */
type OperationMode = "fixture" | "live";

/**
 * Workflow stages an operation may run in. "resolution" and "execution" are
 * the workflow's persisted-claim checkpoints; "report" is a directly
 * invoked report run whose spend authorization is the caller-supplied
 * credit budget enforced by the report preflight.
 */
export type ToolExecutionStage = "resolution" | "execution" | "report";

interface OperationBilling {
  /** Which single rate in UPRIVER_CREDIT_RATES prices this operation. */
  readonly rateKind: keyof typeof UPRIVER_CREDIT_RATES;
  /**
   * Maximum billable results per call: a fixed count, or the name of a
   * gateway-configured result cap resolved via OperationResultCaps.
   */
  readonly units: number | keyof OperationResultCaps;
  /**
   * Similar Creators is a beta endpoint; its per-result pricing assumption
   * is provisional and revisited whenever Upriver finalizes beta billing.
   */
  readonly provisional?: true;
}

export interface EvidenceToolPolicy {
  /** Deferral is expressed by omission, so registered entries are executable. */
  readonly executable: true;
  /** The SponsorRadarEvidencePort method this operation dispatches to. */
  readonly portMethod:
    | "resolveTarget"
    | "listTargetSponsors"
    | "listLockedPeers"
    | "listPeerSponsors"
    | "loadVerificationLedger";
  /** Upriver endpoint the live adapter calls; null for fixture-only work. */
  readonly upriverEndpoint:
    | "/v1/creators/batch"
    | "/v1/creators/similar"
    | "/v1/sponsors"
    | null;
  readonly allowedModes: readonly OperationMode[];
  readonly allowedStages: readonly ToolExecutionStage[];
  /** Pricing policy; null means the operation never spends credits. */
  readonly billing: OperationBilling | null;
  /** How the executor derives result-based credits after a completed call. */
  readonly settlement:
    | "fixed_per_call"
    | "observed_http_rows"
    | "rate_times_rows"
    | "free";
  readonly replayClass: "paid_zero_retry" | "free_reread";
  /** "mode" prefixes audit names with the gateway mode; "local" is fixed. */
  readonly auditScope: "mode" | "local";
  readonly llmExposed: false;
}

/**
 * Gateway-configured maximum billable results per sponsor call. The live
 * gateway may narrow these per instance; every quote and estimate derives
 * from the same registry math.
 */
export interface OperationResultCaps {
  readonly targetResultCap: number;
  readonly peerResultCap: number;
}

export const DEFAULT_OPERATION_RESULT_CAPS: OperationResultCaps = {
  targetResultCap: 23,
  peerResultCap: 2
};

/** Bounded Similar Creators request size (beta endpoint). */
export const SIMILAR_CREATOR_RESULT_CAP = 10;

/** Maximum locked peer cohort size across discovery, caching, and quoting. */
export const MAX_PEER_COHORT = 3;

export const TOOL_REGISTRY = {
  resolve_target: {
    executable: true,
    portMethod: "resolveTarget",
    upriverEndpoint: "/v1/creators/batch",
    allowedModes: ["fixture", "live"],
    allowedStages: ["resolution", "execution", "report"],
    billing: { rateKind: "creatorResult", units: 1 },
    settlement: "fixed_per_call",
    replayClass: "paid_zero_retry",
    auditScope: "mode",
    llmExposed: false
  },
  list_target_sponsors: {
    executable: true,
    portMethod: "listTargetSponsors",
    upriverEndpoint: "/v1/sponsors",
    allowedModes: ["fixture", "live"],
    allowedStages: ["execution", "report"],
    billing: { rateKind: "groupedSponsorResult", units: "targetResultCap" },
    settlement: "rate_times_rows",
    replayClass: "paid_zero_retry",
    auditScope: "mode",
    llmExposed: false
  },
  list_locked_peers: {
    executable: true,
    portMethod: "listLockedPeers",
    upriverEndpoint: "/v1/creators/similar",
    allowedModes: ["fixture", "live"],
    allowedStages: ["resolution", "report"],
    billing: {
      rateKind: "creatorResult",
      units: SIMILAR_CREATOR_RESULT_CAP,
      provisional: true
    },
    settlement: "observed_http_rows",
    replayClass: "paid_zero_retry",
    auditScope: "mode",
    llmExposed: false
  },
  list_peer_sponsors: {
    executable: true,
    portMethod: "listPeerSponsors",
    upriverEndpoint: "/v1/sponsors",
    allowedModes: ["fixture", "live"],
    allowedStages: ["execution", "report"],
    billing: { rateKind: "groupedSponsorResult", units: "peerResultCap" },
    settlement: "rate_times_rows",
    replayClass: "paid_zero_retry",
    auditScope: "mode",
    llmExposed: false
  },
  load_verification_ledger: {
    executable: true,
    portMethod: "loadVerificationLedger",
    upriverEndpoint: null,
    // The ledger is a local, free read gated by the manual-verification
    // qualification policy, not by gateway mode; the live Upriver adapter
    // itself refuses it, while a cached live-mode port with the manual
    // policy may serve it.
    allowedModes: ["fixture", "live"],
    allowedStages: ["execution", "report"],
    billing: null,
    settlement: "free",
    replayClass: "free_reread",
    auditScope: "local",
    llmExposed: false
  }
} as const satisfies Record<string, EvidenceToolPolicy>;

/**
 * The canonical operation vocabulary. Derived from the registry keys so
 * "registered" and "nameable" cannot drift apart. These exact snake_case
 * names are baked into persisted evidence-cache keys and append-only audit
 * history; they must never change.
 */
export type EvidenceOperation = keyof typeof TOOL_REGISTRY;

export const EVIDENCE_OPERATIONS = Object.keys(
  TOOL_REGISTRY
) as readonly EvidenceOperation[];

export function isRegisteredOperation(
  value: string
): value is EvidenceOperation {
  return Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, value);
}

/**
 * The single per-operation price: rate kind × maximum billable results.
 * The rate card itself stays in credits.ts; this is the only place that
 * says which rate and cap apply to which operation.
 */
export function estimateOperationCredits(
  operation: EvidenceOperation,
  caps: OperationResultCaps = DEFAULT_OPERATION_RESULT_CAPS
): number {
  const billing = TOOL_REGISTRY[operation].billing;
  if (billing === null) {
    return 0;
  }
  const units =
    typeof billing.units === "number" ? billing.units : caps[billing.units];
  return units * UPRIVER_CREDIT_RATES[billing.rateKind];
}

/**
 * Resolution-stage composition: exact target resolution plus bounded peer
 * discovery. Every consumer must derive the stage estimate through this
 * helper so the composition exists exactly once.
 */
export function composeResolutionCredits(
  estimate: (operation: EvidenceOperation) => number
): number {
  return estimate("resolve_target") + estimate("list_locked_peers");
}

/**
 * Full-run ceiling composition: resolution work plus the target sponsor
 * search and up to `peerCount` per-peer sponsor searches.
 */
export function composeRunCeilingCredits(
  estimate: (operation: EvidenceOperation) => number,
  peerCount: number = MAX_PEER_COHORT
): number {
  return (
    composeResolutionCredits(estimate) +
    estimate("list_target_sponsors") +
    peerCount * estimate("list_peer_sponsors")
  );
}

/**
 * Audit tool names have the frozen shape `${scope}.${operation}` and appear
 * in append-only audit history; writers and readers must both derive them
 * here.
 */
export type AuditToolScope = OperationMode | "local";

export function auditToolName<
  S extends AuditToolScope,
  O extends EvidenceOperation
>(scope: S, operation: O): `${S}.${O}` {
  return `${scope}.${operation}`;
}

/**
 * Parses a recorded audit tool name back to its registered operation.
 * Returns null for names outside the registry vocabulary (for example the
 * application-local `local.load_approved_peer_cohort` event or the
 * adapter-level `upriver.http.*` lifecycle events).
 */
export function parseAuditToolName(
  name: string
): { scope: AuditToolScope; operation: EvidenceOperation } | null {
  const separator = name.indexOf(".");
  if (separator === -1) {
    return null;
  }
  const scope = name.slice(0, separator);
  const operation = name.slice(separator + 1);
  if (scope !== "fixture" && scope !== "live" && scope !== "local") {
    return null;
  }
  if (!isRegisteredOperation(operation)) {
    return null;
  }
  return { scope, operation };
}

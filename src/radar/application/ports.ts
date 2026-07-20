import type {
  PilotConfig,
  VerificationLedger
} from "@/src/radar/adapters/upriver/contracts";
import type { NormalizedSponsorEvidenceResult } from "@/src/radar/adapters/upriver/normalize";
import type { TargetSummary } from "@/src/radar/domain/types";
import type { VerifiedYouTubeIdentity } from "@/src/radar/domain/youtube";

export interface LockedPeer {
  name: string;
  url: string;
  subscriberCount: number;
  creatorId: string | null;
}

export type EvidenceMode = "fixture" | "live";
export type EvidenceCacheStatus = "hit" | "miss" | "not_applicable";
export type QualificationPolicy =
  | "verified_product_continuity"
  | "same_brand_reactivation";

export type EvidenceOperation =
  | "resolve_target"
  | "list_target_sponsors"
  | "list_locked_peers"
  | "list_peer_sponsors"
  | "load_verification_ledger";

export interface ResolvedTarget {
  target: TargetSummary;
  identity: VerifiedYouTubeIdentity;
  config: PilotConfig;
}

export interface SponsorRadarEvidencePort {
  readonly mode: EvidenceMode;
  /**
   * Fixtures preserve the manually verified product-continuity regression
   * policy. Dynamic live discovery defaults to the evidence-backed same-brand
   * policy unless an adapter explicitly declares otherwise.
   */
  readonly qualificationPolicy?: QualificationPolicy;
  /**
   * Stable cache boundary for date windows, result caps, and discovery policy.
   * Live adapters must change this key whenever those inputs change.
   */
  readonly cachePolicyKey?: string;
  estimateCredits(operation: EvidenceOperation): number;
  estimateRunCredits(): number;
  /**
   * Cache-aware adapters expose the prepared resolution-stage portion
   * separately; a cache-aware total cannot be split with fixed costs.
   */
  estimateResolutionCredits?(): number;
  /**
   * Cache-aware adapters may preload the keys needed for one run before the
   * conservative credit preflight is calculated.
   */
  prepareRun?(input: string): Promise<void>;
  inspectCache?(
    operation: EvidenceOperation,
    input: string,
    targetSubscriberCount?: number
  ): Promise<EvidenceCacheStatus>;
  resolveTarget(input: string): Promise<ResolvedTarget>;
  /**
   * Execution may require a new provider observation even when target
   * resolution is cached. Cache adapters implement this by bypassing only the
   * resolve-target cache while retaining zero-retry and normal validation.
   */
  resolveTargetFresh?(input: string): Promise<ResolvedTarget>;
  listTargetSponsors(
    targetUrl: string
  ): Promise<NormalizedSponsorEvidenceResult>;
  listLockedPeers(
    targetUrl: string,
    targetSubscriberCount?: number
  ): Promise<LockedPeer[]>;
  listPeerSponsors(peerUrl: string): Promise<NormalizedSponsorEvidenceResult>;
  loadVerificationLedger(): Promise<VerificationLedger>;
}

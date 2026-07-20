import type { VerifiedYouTubeIdentity } from "@/src/radar/domain/youtube";

export type SponsorshipClass = "S3" | "S2" | "S1" | "S0" | "SU";
export type ContinuityGrade = "A" | "B" | "C" | "U";

export interface Evidence {
  contentUrl: string;
  publishedDate: string;
  excerpt: string;
  channel: string;
  videoTitle: string;
  source?: string;
  confidence?: number;
}

export interface StrictCandidate {
  domain: string | null;
  brand: string;
  targetClass: SponsorshipClass;
  peerClass: SponsorshipClass;
  continuity: ContinuityGrade;
  verificationPresent: boolean;
  targetEvidence: Evidence | null;
  peerEvidence: Evidence | null;
}

export type StrictFailure =
  | "missing_domain"
  | "missing_verification"
  | "target_not_confirmed_paid"
  | "peer_not_confirmed_paid"
  | "product_continuity_not_supported"
  | "missing_target_evidence"
  | "missing_peer_evidence";

export interface StrictEvaluation {
  eligible: boolean;
  failures: StrictFailure[];
}

export interface QualifiedLead {
  brand: string;
  domain: string;
  peer: string;
  peerUrl: string;
  peerSubscriberCount: number;
  continuity: Extract<ContinuityGrade, "A" | "B" | "U">;
  targetProductLine: string;
  peerProductLine: string;
  continuityReason: string;
  targetObservedPlacements: number;
  targetFirstObservedDate: string | null;
  peerObservedPlacements: number;
  peerFirstObservedDate: string | null;
  targetDaysSinceLatest: number;
  peerDaysSinceLatest: number;
  targetEvidence: Evidence;
  peerEvidence: Evidence;
  outreachHypothesis: string;
}

export interface CoverageNotice {
  code:
    | "target_domain_coverage"
    | "peer_domain_joinability"
    | "target_tracking_status"
    | "peer_tracking_status"
    | "grouped_summary_limit"
    | "upriver_result_cap"
    | "peer_research_partial";
  severity: "warning" | "info";
  numerator?: number;
  denominator?: number;
  percentage?: number;
  message: string;
}

export interface FunnelCounts {
  targetApiRows: number;
  staleDomainResolvedTargets: number;
  staleExplicitTargetCandidates: number;
  strictPeerApiRows: number;
  manuallyConfirmedS3PeerRows: number;
  joinableS3PeerRows: number;
  rawDomainMatches: number;
  strictProductContinuousPasses: number;
  sameBrandReactivationPasses: number;
}

export type QualificationPolicy =
  | "verified_product_continuity"
  | "same_brand_reactivation";

export interface TargetSummary {
  name: string;
  url: string;
  subscriberCount: number;
}

export interface RunAuditSummary {
  toolCalls: number;
  llmCalls: number;
  skillsLoaded: string[];
  resultBasedCreditEstimate: number;
  projectedLiveCredits: number;
  timeToFirstResultMs: number | null;
  totalDurationMs: number;
}

export interface Phase4NarrativeSentence {
  text: string;
  claimIds: string[];
  evidenceIds: string[];
}

export interface Phase4ReportAugmentation {
  status: "generated" | "fallback" | "not_needed";
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  narratives: Array<{
    leadIndex: number;
    sentences: Phase4NarrativeSentence[];
  }>;
  fallbackReason?: string;
}

export interface WinbackReport {
  schemaVersion: 1;
  runId: string;
  phase:
    | "phase_1_fixture"
    | "phase_2_live"
    | "phase_3_fixture"
    | "phase_3_live"
    | "phase_4_fixture"
    | "phase_4_live";
  generatedAt: string;
  asOf: string;
  target: TargetSummary;
  targetIdentity: VerifiedYouTubeIdentity | null;
  methodology: {
    targetWindow: { since: string; until: string };
    peerWindow: { since: string; until: string };
    staleCutoffExclusive: string;
    strictGate: string;
    qualificationPolicy: QualificationPolicy;
    mode: "fixture" | "live";
  };
  funnel: FunnelCounts;
  leads: QualifiedLead[];
  coverage: CoverageNotice[];
  audit: RunAuditSummary;
  phase4?: Phase4ReportAugmentation;
}

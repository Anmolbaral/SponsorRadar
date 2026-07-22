import type { AuditRecorder } from "@/src/observability/audit";
import type { NormalizedSponsorEvidenceResult } from "@/src/radar/adapters/upriver/normalize";
import type {
  LockedPeer,
  ResolvedTarget,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import {
  buildCoverage,
  qualifySameBrandReactivations,
  sponsorMatchesApprovedIdentity,
  isWithinWindow,
  type DynamicQualification
} from "@/src/radar/application/same-brand-qualification";
import { composeResolutionCredits } from "@/src/radar/application/tools/tool-registry";
import {
  estimateUpriverCredits,
  UPRIVER_CREDIT_RATES
} from "@/src/radar/domain/credits";
import { isBeforeExclusive } from "@/src/radar/domain/dates";
import { latestByKey } from "@/src/radar/domain/latest-by-key";
import type { FunnelCounts, WinbackReport } from "@/src/radar/domain/types";

export class AgentEvidencePreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentEvidencePreconditionError";
  }
}

export interface AgentPeer extends LockedPeer {
  peerRef: string;
}

export interface AgentAnalysis {
  analysisRef: string;
  qualification: DynamicQualification;
  funnel: FunnelCounts;
  targetHistorySearched: boolean;
  targetRowCount: number;
  targetDomainCount: number;
}

/**
 * Server-held evidence accumulator for the agentic engine (ADR 0008). The
 * model only ever sees projections; the full provider results live here, and
 * the assembled report is derived from this state — never from model output.
 */
export class AgentEvidenceState {
  private resolvedTarget: ResolvedTarget | null = null;
  private lockedPeers: AgentPeer[] | null = null;
  private readonly peerSponsors = new Map<
    string,
    NormalizedSponsorEvidenceResult
  >();
  private readonly failedPeerRefs = new Set<string>();
  private targetSponsors: NormalizedSponsorEvidenceResult | null = null;
  private readonly analyses = new Map<string, AgentAnalysis>();
  private channelNotFoundMessage: string | null = null;

  get resolved(): ResolvedTarget | null {
    return this.resolvedTarget;
  }

  /** Set only from a typed provider not-found failure, never by the model. */
  get channelNotFound(): string | null {
    return this.channelNotFoundMessage;
  }

  recordChannelNotFound(providerMessage: string | null): void {
    if (this.resolvedTarget !== null) {
      return;
    }
    this.channelNotFoundMessage =
      providerMessage ?? "The requested channel was not found.";
  }

  requireChannelNotFound(): void {
    if (this.channelNotFoundMessage === null) {
      throw new AgentEvidencePreconditionError(
        "The channel_not_found outcome is only valid after resolve_target reported the channel does not exist"
      );
    }
  }

  get peers(): readonly AgentPeer[] | null {
    return this.lockedPeers;
  }

  get targetSponsorResult(): NormalizedSponsorEvidenceResult | null {
    return this.targetSponsors;
  }

  requireResolved(): ResolvedTarget {
    if (!this.resolvedTarget) {
      throw new AgentEvidencePreconditionError(
        "resolve_target must succeed before this tool"
      );
    }
    return this.resolvedTarget;
  }

  requirePeers(): readonly AgentPeer[] {
    if (!this.lockedPeers) {
      throw new AgentEvidencePreconditionError(
        "list_locked_peers must succeed before this tool"
      );
    }
    return this.lockedPeers;
  }

  peerByRef(peerRef: string): AgentPeer {
    const peer = this.requirePeers().find(
      (candidate) => candidate.peerRef === peerRef
    );
    if (!peer) {
      throw new AgentEvidencePreconditionError(
        `Unknown peerRef ${peerRef}; call list_locked_peers first`
      );
    }
    return peer;
  }

  recordResolvedTarget(resolved: ResolvedTarget): void {
    this.resolvedTarget = resolved;
    this.channelNotFoundMessage = null;
  }

  recordLockedPeers(peers: readonly LockedPeer[]): readonly AgentPeer[] {
    this.lockedPeers = peers.map((peer, index) => ({
      ...peer,
      peerRef: `peer_${index + 1}`
    }));
    return this.lockedPeers;
  }

  recordPeerSponsors(
    peerRef: string,
    result: NormalizedSponsorEvidenceResult
  ): void {
    this.peerByRef(peerRef);
    this.peerSponsors.set(peerRef, result);
    this.failedPeerRefs.delete(peerRef);
  }

  /** Mirrors the legacy partial-peer placeholder so coverage stays honest. */
  recordPeerSponsorFailure(peerRef: string): void {
    const peer = this.peerByRef(peerRef);
    this.failedPeerRefs.add(peerRef);
    this.peerSponsors.set(peerRef, {
      rows: [],
      completeness: "partial",
      trackingStatus: {
        publicationUrl: peer.url,
        channelName: peer.name,
        status: "failed",
        message:
          "Peer sponsor research failed; successful peer evidence was preserved."
      }
    });
  }

  recordTargetSponsors(result: NormalizedSponsorEvidenceResult): void {
    this.targetSponsors = result;
  }

  peerSponsorResult(
    peerRef: string
  ): NormalizedSponsorEvidenceResult | undefined {
    return this.peerSponsors.get(peerRef);
  }

  researchedPeerRefs(): readonly string[] {
    return [...this.peerSponsors.keys()];
  }

  analysis(analysisRef: string): AgentAnalysis | undefined {
    return this.analyses.get(analysisRef);
  }

  /**
   * Deterministic same-brand qualification over the accumulated evidence.
   * The target history is optional: analyzing without it reports honest
   * zero-lead funnels and the target_history_not_searched coverage notice,
   * matching the legacy no-signal early exit.
   */
  analyze(): AgentAnalysis {
    const resolved = this.requireResolved();
    const peers = this.requirePeers();
    const missingPeers = peers.filter(
      (peer) => !this.peerSponsors.has(peer.peerRef)
    );
    if (missingPeers.length > 0) {
      throw new AgentEvidencePreconditionError(
        `analyze_evidence needs list_peer_sponsors for ${missingPeers
          .map((peer) => peer.peerRef)
          .join(", ")} first`
      );
    }

    const targetHistorySearched = this.targetSponsors !== null;
    const targetRows = this.targetSponsors?.rows ?? [];
    const qualificationTargetSponsors = targetRows.filter(
      (sponsor) =>
        sponsorMatchesApprovedIdentity(sponsor, resolved.target.url) &&
        isWithinWindow(
          sponsor.publishedDate,
          resolved.config.target_window
        )
    );
    const latestDomainResolved = latestByKey(
      qualificationTargetSponsors,
      (sponsor) => sponsor.normalizedDomain,
      (sponsor) => sponsor.publishedDate
    );
    const staleDomainResolved = latestDomainResolved.filter((sponsor) =>
      isBeforeExclusive(
        sponsor.publishedDate,
        resolved.config.stale_cutoff_exclusive
      )
    );
    const staleExplicit = staleDomainResolved.filter(
      (sponsor) => sponsor.placementType === "explicit_ad"
    );

    const qualification = qualifySameBrandReactivations({
      target: resolved.target,
      staleExplicitTargets: staleExplicit,
      peers: peers.map((peer) => ({
        name: peer.name,
        url: peer.url,
        subscriberCount: peer.subscriberCount,
        creatorId: peer.creatorId
      })),
      peerSponsorSets: peers.map(
        (peer) => this.peerSponsors.get(peer.peerRef)!.rows
      ),
      peerWindow: resolved.config.peer_window,
      asOf: resolved.config.as_of
    });

    const analysis: AgentAnalysis = {
      analysisRef: `analysis_${this.analyses.size + 1}`,
      qualification,
      funnel: {
        targetApiRows: targetRows.length,
        staleDomainResolvedTargets: staleDomainResolved.length,
        staleExplicitTargetCandidates: staleExplicit.length,
        strictPeerApiRows: qualification.peerRows.length,
        manuallyConfirmedS3PeerRows: 0,
        joinableS3PeerRows: 0,
        rawDomainMatches: qualification.rawMatches.length,
        strictProductContinuousPasses: 0,
        sameBrandReactivationPasses: qualification.leads.length
      },
      targetHistorySearched,
      targetRowCount: targetRows.length,
      targetDomainCount: qualificationTargetSponsors.filter(
        (sponsor) => sponsor.normalizedDomain !== null
      ).length
    };
    this.analyses.set(analysis.analysisRef, analysis);
    return analysis;
  }

  assembleReport(input: {
    analysisRef: string;
    audit: AuditRecorder;
    port: SponsorRadarEvidencePort;
    phase: WinbackReport["phase"];
    now: () => number;
  }): WinbackReport {
    const analysis = this.analyses.get(input.analysisRef);
    if (!analysis) {
      throw new AgentEvidencePreconditionError(
        `Unknown analysisRef ${input.analysisRef}; call analyze_evidence first`
      );
    }
    const resolved = this.requireResolved();
    const peers = this.requirePeers();
    const failedPeers = peers
      .filter((peer) => this.failedPeerRefs.has(peer.peerRef))
      .map((peer) => peer.name);

    const coverage = buildCoverage(
      analysis.targetDomainCount,
      analysis.targetRowCount,
      analysis.qualification.joinableEvidenceBackedPeerRows.length,
      analysis.qualification.evidenceBackedPeerRows.length,
      "Evidence-backed peer sponsors joinable by exact normalized domain",
      this.targetSponsors,
      peers.map((peer) => ({
        label: peer.name,
        result: this.peerSponsors.get(peer.peerRef)!
      })),
      failedPeers,
      analysis.targetHistorySearched
    );

    const projectedCreatorCredits = composeResolutionCredits((operation) =>
      input.port.estimateCredits(operation)
    );
    const projectedLiveCredits = estimateUpriverCredits({
      groupedSponsorResults:
        (this.targetSponsors?.rows ?? []).filter(
          (sponsor) => sponsor.placementType === "explicit_ad"
        ).length + analysis.qualification.peerRows.length,
      creatorResults:
        projectedCreatorCredits / UPRIVER_CREDIT_RATES.creatorResult
    });

    input.audit.reportReady(analysis.qualification.leads.length);

    return {
      schemaVersion: 1,
      runId: input.audit.runId,
      phase: input.phase,
      generatedAt: new Date(input.now()).toISOString(),
      asOf: resolved.config.as_of,
      target: resolved.target,
      targetIdentity: resolved.identity,
      methodology: {
        targetWindow: resolved.config.target_window,
        peerWindow: resolved.config.peer_window,
        staleCutoffExclusive: resolved.config.stale_cutoff_exclusive,
        strictGate:
          "Exact normalized sponsor-domain match across evidence-backed explicit ads; product line, campaign, and buyer are unverified.",
        qualificationPolicy: "same_brand_reactivation",
        mode: input.port.mode
      },
      funnel: analysis.funnel,
      leads: analysis.qualification.leads,
      coverage,
      audit: input.audit.summarize(projectedLiveCredits)
    };
  }
}

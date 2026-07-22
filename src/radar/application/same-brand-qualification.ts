import type { VerificationLedger } from "@/src/radar/adapters/upriver/contracts";
import type {
  NormalizedSponsorEvidence,
  NormalizedSponsorEvidenceResult,
  SponsorTrackingStatus
} from "@/src/radar/adapters/upriver/normalize";
import type { LockedPeer } from "@/src/radar/application/ports";
import { coverageWarning } from "@/src/radar/domain/coverage";
import { daysBetween } from "@/src/radar/domain/dates";
import { normalizeDomain } from "@/src/radar/domain/domains";
import { parseYouTubeIdentity } from "@/src/radar/domain/youtube";
import type {
  CoverageNotice,
  Evidence,
  QualifiedLead,
  TargetSummary
} from "@/src/radar/domain/types";

export interface PeerEvidenceRow {
  peer: LockedPeer;
  sponsor: NormalizedSponsorEvidence;
  verification: VerificationLedger["peer_inventory"][number] | null;
  resolvedDomain: string | null;
}

export interface DynamicQualification {
  peerRows: PeerEvidenceRow[];
  evidenceBackedPeerRows: PeerEvidenceRow[];
  joinableEvidenceBackedPeerRows: PeerEvidenceRow[];
  rawMatches: PeerEvidenceRow[];
  leads: QualifiedLead[];
}

export function qualifySameBrandReactivations(input: {
  target: TargetSummary;
  staleExplicitTargets: NormalizedSponsorEvidence[];
  peers: LockedPeer[];
  peerSponsorSets: NormalizedSponsorEvidence[][];
  peerWindow: { since: string; until: string };
  asOf: string;
}): DynamicQualification {
  const peerRows = joinPeerEvidence(input.peers, input.peerSponsorSets);
  const eligibleTargets = input.staleExplicitTargets.filter(
    (sponsor) =>
      sponsor.normalizedDomain !== null &&
      sponsorMatchesApprovedIdentity(sponsor, input.target.url) &&
      hasExplicitApiEvidence(sponsor)
  );
  const targetByDomain = new Map(
    eligibleTargets.map((sponsor) => [
      sponsor.normalizedDomain!,
      sponsor
    ])
  );
  const evidenceBackedPeerRows = peerRows.filter(
    (row) =>
      sponsorMatchesApprovedIdentity(row.sponsor, row.peer.url) &&
      hasExplicitApiEvidence(row.sponsor) &&
      isWithinWindow(row.sponsor.publishedDate, input.peerWindow)
  );
  const joinableEvidenceBackedPeerRows = evidenceBackedPeerRows.filter(
    (row) => row.resolvedDomain !== null
  );
  const rawMatches = joinableEvidenceBackedPeerRows.filter(
    (row) =>
      row.resolvedDomain !== null &&
      targetByDomain.has(row.resolvedDomain)
  );
  const ranked = rawMatches
    .map((peerRow) => ({
      peerRow,
      targetSponsor: targetByDomain.get(peerRow.resolvedDomain!)!
    }))
    .sort(
      (left, right) =>
        right.peerRow.sponsor.publishedDate.localeCompare(
          left.peerRow.sponsor.publishedDate
        ) ||
        left.targetSponsor.publishedDate.localeCompare(
          right.targetSponsor.publishedDate
        ) ||
        left.peerRow.resolvedDomain!.localeCompare(
          right.peerRow.resolvedDomain!
        ) ||
        left.peerRow.peer.url.localeCompare(right.peerRow.peer.url) ||
        left.peerRow.sponsor.contentUrl.localeCompare(
          right.peerRow.sponsor.contentUrl
        )
    );
  const selectedDomains = new Set<string>();
  const leads: QualifiedLead[] = [];

  for (const candidate of ranked) {
    const domain = candidate.peerRow.resolvedDomain!;
    if (selectedDomains.has(domain)) continue;
    selectedDomains.add(domain);
    leads.push(
      toSameBrandReactivationLead(
        candidate.targetSponsor,
        candidate.peerRow,
        input.target,
        input.asOf
      )
    );
    if (leads.length === 3) break;
  }

  return {
    peerRows,
    evidenceBackedPeerRows,
    joinableEvidenceBackedPeerRows,
    rawMatches,
    leads
  };
}

export function joinPeerEvidence(
  peers: LockedPeer[],
  peerSponsorSets: NormalizedSponsorEvidence[][]
): PeerEvidenceRow[] {
  return peers.flatMap((peer, peerIndex) =>
    peerSponsorSets[peerIndex].map((sponsor) => ({
      peer,
      sponsor,
      verification: null,
      resolvedDomain: normalizeDomain(sponsor.normalizedDomain)
    }))
  );
}

export function sponsorMatchesApprovedIdentity(
  sponsor: NormalizedSponsorEvidence,
  approvedUrl: string
): boolean {
  return sameYouTubeIdentity(sponsor.publicationUrl, approvedUrl);
}

function sameYouTubeIdentity(
  firstUrl: string,
  secondUrl: string
): boolean {
  try {
    return (
      parseYouTubeIdentity(firstUrl).key ===
      parseYouTubeIdentity(secondUrl).key
    );
  } catch {
    return false;
  }
}

export function hasExplicitApiEvidence(
  sponsor: NormalizedSponsorEvidence
): boolean {
  return (
    sponsor.placementType === "explicit_ad" &&
    sponsor.evidenceSource !== null &&
    sponsor.excerpt !== null &&
    sponsor.evidenceConfidence !== null &&
    sponsor.evidenceConfidence > 0
  );
}

export function isWithinWindow(
  date: string,
  window: { since: string; until: string }
): boolean {
  return (
    daysBetween(window.since, date) >= 0 &&
    daysBetween(date, window.until) >= 0
  );
}

function toSameBrandReactivationLead(
  targetSponsor: NormalizedSponsorEvidence,
  peerRow: PeerEvidenceRow,
  target: TargetSummary,
  asOf: string
): QualifiedLead {
  const domain = targetSponsor.normalizedDomain;
  if (
    !domain ||
    domain !== peerRow.resolvedDomain ||
    !hasExplicitApiEvidence(targetSponsor) ||
    !hasExplicitApiEvidence(peerRow.sponsor)
  ) {
    throw new Error(
      "A same-brand reactivation candidate lost its required API evidence"
    );
  }

  return {
    brand: targetSponsor.sponsorName,
    domain,
    peer: peerRow.peer.name,
    peerUrl: peerRow.peer.url,
    peerSubscriberCount: peerRow.peer.subscriberCount,
    continuity: "U",
    targetProductLine: "Unverified",
    peerProductLine: "Unverified",
    continuityReason: `Exact normalized sponsor-domain match (${domain}) between evidence-backed explicit placements. This is a domain-level brand match only; product line, campaign continuity, and buyer identity are unverified.`,
    targetObservedPlacements: targetSponsor.totalAdsFound,
    targetFirstObservedDate:
      targetSponsor.totalAdsFound === 1
        ? targetSponsor.publishedDate
        : null,
    peerObservedPlacements: peerRow.sponsor.totalAdsFound,
    peerFirstObservedDate:
      peerRow.sponsor.totalAdsFound === 1
        ? peerRow.sponsor.publishedDate
        : null,
    targetDaysSinceLatest: daysSinceEvidence(
      targetSponsor.publishedDate,
      asOf
    ),
    peerDaysSinceLatest: daysSinceEvidence(
      peerRow.sponsor.publishedDate,
      asOf
    ),
    targetEvidence: toApiEvidence(targetSponsor, target.name),
    peerEvidence: toApiEvidence(peerRow.sponsor, peerRow.peer.name),
    outreachHypothesis: `${targetSponsor.sponsorName} has an older evidence-backed explicit placement on ${target.name}, while ${peerRow.peer.name} has a more recent explicit placement matched by exact normalized sponsor domain. This is worth researching as a possible same-brand reactivation opportunity; the available evidence does not verify the same product line, campaign, or buyer.`
  };
}

function toApiEvidence(
  sponsor: NormalizedSponsorEvidence,
  approvedChannelName: string
): Evidence {
  if (
    sponsor.excerpt === null ||
    sponsor.evidenceSource === null ||
    sponsor.evidenceConfidence === null ||
    sponsor.evidenceConfidence <= 0
  ) {
    throw new Error("API evidence is incomplete");
  }
  return {
    contentUrl: sponsor.contentUrl,
    publishedDate: sponsor.publishedDate,
    excerpt: sponsor.excerpt,
    channel: approvedChannelName,
    videoTitle: "Not provided by Upriver /v1/sponsors",
    source: sponsor.evidenceSource,
    confidence: sponsor.evidenceConfidence
  };
}

export function daysSinceEvidence(observedDate: string, asOf: string): number {
  const elapsedDays = daysBetween(observedDate, asOf);
  if (elapsedDays < 0) {
    throw new Error("Verified evidence cannot be later than the pilot as-of date");
  }
  return elapsedDays;
}

export function buildCoverage(
  targetDomains: number,
  targetRows: number,
  joinablePeers: number,
  verifiedPeers: number,
  peerCoverageSubject: string,
  targetResult: NormalizedSponsorEvidenceResult | null,
  peerResults: Array<{
    label: string;
    result: NormalizedSponsorEvidenceResult;
  }>,
  failedPeers: readonly string[] = [],
  targetHistorySearched = true
): CoverageNotice[] {
  const resultCapReached =
    targetResult?.completeness === "partial" ||
    peerResults.some(
      ({ label, result }) =>
        result.completeness === "partial" && !failedPeers.includes(label)
    );

  return [
    targetHistorySearched && targetResult
      ? coverageWarning({
          code: "target_domain_coverage",
          numerator: targetDomains,
          denominator: targetRows,
          subject: "Target sponsor rows with a usable domain"
        })
      : ({
          code: "target_history_not_searched",
          severity: "info",
          message:
            "Target sponsor history was not searched because no evidence-backed peer sponsorship signal was found in the selected window."
        } satisfies CoverageNotice),
    coverageWarning({
      code: "peer_domain_joinability",
      numerator: joinablePeers,
      denominator: verifiedPeers,
      subject: peerCoverageSubject
    }),
    targetHistorySearched && targetResult
      ? trackingCoverageWarning(
          "target_tracking_status",
          [{ label: "target channel", status: targetResult.trackingStatus }],
          "target sponsorship response"
        )
      : null,
    trackingCoverageWarning(
      "peer_tracking_status",
      peerResults.map(({ label, result }) => ({
        label,
        status: result.trackingStatus
      })),
      "peer sponsorship responses"
    ),
    {
      code: "grouped_summary_limit",
      severity: "info",
      message:
        "Upriver /v1/sponsors returns each brand’s latest example plus a count, not evidence for every historical placement."
    } satisfies CoverageNotice,
    resultCapReached
      ? ({
          code: "upriver_result_cap",
          severity: "warning",
          message:
            "The live Upriver result or credit cap was reached, so this report may omit qualifying sponsors."
        } satisfies CoverageNotice)
      : null,
    failedPeers.length > 0
      ? ({
          code: "peer_research_partial",
          severity: "warning",
          message: `Sponsor research failed for ${failedPeers.join(
            ", "
          )}. Valid evidence from the remaining peers was preserved, but coverage is partial.`
        } satisfies CoverageNotice)
      : null
  ].filter((notice): notice is CoverageNotice => notice !== null);
}

function trackingCoverageWarning(
  code: Extract<
    CoverageNotice["code"],
    "target_tracking_status" | "peer_tracking_status"
  >,
  sources: Array<{
    label: string;
    status: SponsorTrackingStatus | null;
  }>,
  subject: string
): CoverageNotice | null {
  const missing = sources
    .filter(({ status }) => status === null)
    .map(({ label }) => label);
  const nonActive = sources.filter(
    ({ status }) => status !== null && status.status.toLowerCase() !== "active"
  );
  if (missing.length === 0 && nonActive.length === 0) return null;

  const details = [
    missing.length > 0
      ? `missing for ${missing.join(", ")}`
      : null,
    nonActive.length > 0
      ? `non-active for ${nonActive
          .map(({ label, status }) => `${label} (${status?.status})`)
          .join(", ")}`
      : null
  ].filter((detail): detail is string => detail !== null);

  return {
    code,
    severity: "warning",
    message: `Upriver tracking status is ${details.join(
      "; "
    )} in the ${subject}. The searched window's completeness cannot be confirmed, and zero rows must not be read as proof that no sponsorships exist.`
  };
}

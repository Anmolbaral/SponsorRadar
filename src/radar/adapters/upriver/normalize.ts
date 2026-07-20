import { normalizeDomain } from "@/src/radar/domain/domains";
import type {
  CreatorBatchResponseWire,
  SponsorSummaryWire,
  SponsorsPageWire
} from "./contracts";

export type EvidenceWarning =
  | "missing_domain"
  | "missing_evidence"
  | "zero_confidence"
  | "non_explicit_placement"
  | "coverage_unknown"
  | "coverage_incomplete";

export interface NormalizedSponsorEvidence {
  provider: "upriver";
  sourceEndpoint: "sponsors";
  sponsorName: string;
  rawSponsorDomain: string | null;
  normalizedDomain: string | null;
  totalAdsFound: number;
  publicationName: string;
  publicationUrl: string;
  contentUrl: string;
  publishedDate: string;
  placementType: string;
  evidenceSource: string | null;
  excerpt: string | null;
  evidenceConfidence: number | null;
  coverage: "active" | "unknown" | "other" | "partial";
  warnings: EvidenceWarning[];
}

export interface SponsorTrackingStatus {
  publicationUrl: string;
  channelName: string;
  status: string;
  message: string;
}

export interface NormalizedSponsorEvidenceResult {
  rows: NormalizedSponsorEvidence[];
  completeness: "complete" | "partial";
  trackingStatus: SponsorTrackingStatus | null;
}

export interface NormalizedCreator {
  creatorId: string | null;
  requestedUrl: string | null;
  channels: Array<{
    platform: string;
    handle: string;
    url: string;
    displayName: string;
    subscriberCount: number | null;
    platformId: string | null;
  }>;
}

export function normalizeSponsorsPage(
  page: SponsorsPageWire,
  options: { incomplete?: boolean } = {}
): NormalizedSponsorEvidence[] {
  return normalizeSponsorEvidenceResult(page, options).rows;
}

export function normalizeSponsorEvidenceResult(
  page: SponsorsPageWire,
  options: { incomplete?: boolean } = {}
): NormalizedSponsorEvidenceResult {
  const coverage = options.incomplete
    ? ("partial" as const)
    : inferSponsorsCoverage(page);

  return {
    rows: page.results.map((row) => normalizeSponsor(row, coverage)),
    completeness: options.incomplete ? "partial" : "complete",
    trackingStatus: page.tracking_status
      ? {
          publicationUrl: page.tracking_status.publication_url,
          channelName: page.tracking_status.channel_name,
          status: page.tracking_status.status,
          message: page.tracking_status.message
        }
      : null
  };
}

export function inferSponsorsCoverage(
  page: SponsorsPageWire
): NormalizedSponsorEvidence["coverage"] {
  if (page.results.length === 0) return "unknown";
  if (page.tracking_status?.status === "active") return "active";
  return "other";
}

export function normalizeCreatorBatch(
  response: CreatorBatchResponseWire
): NormalizedCreator[] {
  return response.results.map((creator) => ({
    creatorId: creator.creator_id ?? null,
    requestedUrl: creator.url ?? null,
    channels: creator.channels.map((channel) => ({
      platform: channel.platform,
      handle: channel.handle,
      url: channel.url,
      displayName: channel.display_name,
      subscriberCount: channel.subscriber_count ?? null,
      platformId: channel.platform_id ?? null
    }))
  }));
}

function normalizeSponsor(
  row: SponsorSummaryWire,
  coverage: NormalizedSponsorEvidence["coverage"]
): NormalizedSponsorEvidence {
  const rawDomain = row.sponsor_domain ?? null;
  const normalizedDomain = normalizeDomain(rawDomain);
  const evidence = row.most_recent_ad.evidence;
  const evidenceSource = normalizeEvidenceText(evidence?.source);
  const excerpt = normalizeEvidenceText(evidence?.excerpt);
  const evidenceConfidence = evidence?.confidence ?? null;
  const warnings: EvidenceWarning[] = [];

  if (!normalizedDomain) warnings.push("missing_domain");
  if (
    evidenceSource === null ||
    excerpt === null ||
    evidenceConfidence === null
  ) {
    warnings.push("missing_evidence");
  }
  if (evidenceConfidence === 0) warnings.push("zero_confidence");
  if (row.most_recent_ad.sponsor_type !== "explicit_ad") {
    warnings.push("non_explicit_placement");
  }
  if (coverage === "unknown") warnings.push("coverage_unknown");
  if (coverage === "partial") warnings.push("coverage_incomplete");

  return {
    provider: "upriver",
    sourceEndpoint: "sponsors",
    sponsorName: row.partner_name,
    rawSponsorDomain: rawDomain,
    normalizedDomain,
    totalAdsFound: row.total_ads_found,
    publicationName: row.most_recent_ad.publication_name,
    publicationUrl: row.most_recent_ad.publication_url,
    contentUrl: row.most_recent_ad.content_url,
    publishedDate: row.most_recent_ad.published_date,
    placementType: row.most_recent_ad.sponsor_type,
    evidenceSource,
    excerpt,
    evidenceConfidence,
    coverage,
    warnings
  };
}

function normalizeEvidenceText(
  value: string | null | undefined
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

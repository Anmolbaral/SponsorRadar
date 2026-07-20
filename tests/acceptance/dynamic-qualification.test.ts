import { describe, expect, it } from "vitest";
import type {
  NormalizedSponsorEvidence,
  NormalizedSponsorEvidenceResult
} from "@/src/radar/adapters/upriver/normalize";
import type {
  EvidenceOperation,
  LockedPeer,
  ResolvedTarget,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import {
  approvedCohortHash,
  runWinbackReport
} from "@/src/radar/application/run-winback-report";

const TARGET_URL = "https://www.youtube.com/@DynamicTarget";
const RENAMED_TARGET_URL = "https://www.youtube.com/@RenamedTarget";
const PEER_ONE_URL = "https://www.youtube.com/@PeerOne";
const PEER_TWO_URL = "https://www.youtube.com/@PeerTwo";

describe("dynamic same-brand reactivation qualification", () => {
  it("uses exact API evidence without claiming product continuity or loading a ledger", async () => {
    const gateway = new DynamicEvidencePort();
    const { report, events } = await runWinbackReport(
      { channel: "@DynamicTarget" },
      gateway
    );

    expect(gateway.ledgerCalls).toBe(0);
    expect(
      events.some(
        (event) => event.tool?.name === "local.load_verification_ledger"
      )
    ).toBe(false);
    expect(report.methodology).toMatchObject({
      qualificationPolicy: "same_brand_reactivation",
      strictGate: expect.stringContaining(
        "product line, campaign, and buyer are unverified"
      )
    });
    expect(report.funnel).toMatchObject({
      strictPeerApiRows: 4,
      manuallyConfirmedS3PeerRows: 0,
      joinableS3PeerRows: 0,
      rawDomainMatches: 1,
      strictProductContinuousPasses: 0,
      sameBrandReactivationPasses: 1
    });
    expect(report.audit.projectedLiveCredits).toBe(51);
    expect(report.leads).toHaveLength(1);
    expect(report.leads[0]).toMatchObject({
      brand: "Acme",
      domain: "acme.example",
      peer: "Peer One",
      peerUrl: PEER_ONE_URL,
      continuity: "U",
      targetProductLine: "Unverified",
      peerProductLine: "Unverified",
      targetDaysSinceLatest: 291,
      peerDaysSinceLatest: 29,
      targetEvidence: {
        contentUrl: "https://www.youtube.com/watch?v=target-acme",
        publishedDate: "2025-10-01",
        excerpt: "Target said Acme sponsored this video.",
        channel: "Dynamic Target",
        source: "description",
        confidence: 0.91
      },
      peerEvidence: {
        contentUrl: "https://www.youtube.com/watch?v=peer-acme",
        publishedDate: "2026-06-20",
        excerpt: "Peer thanked Acme for sponsoring this video.",
        channel: "Peer One",
        source: "transcript",
        confidence: 0.93
      }
    });
    expect(report.leads[0].continuityReason).toContain(
      "domain-level brand match only"
    );
    expect(report.leads[0].continuityReason).toContain(
      "product line, campaign continuity, and buyer identity are unverified"
    );
    expect(report.leads[0].continuityReason).not.toContain(
      "same product family"
    );
    expect(report.leads[0].outreachHypothesis).toContain(
      "possible same-brand reactivation opportunity"
    );
    expect(report.leads[0].outreachHypothesis).toContain(
      "does not verify the same product line, campaign, or buyer"
    );
    expect(report.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "peer_domain_joinability",
          numerator: 2,
          denominator: 3,
          percentage: 66.7,
          message: expect.stringContaining("Evidence-backed peer sponsors")
        })
      ])
    );
  });

  it("returns the same honest zero-result outcome when no stale target evidence exists", async () => {
    const firstGateway = new DynamicEvidencePort([]);
    const secondGateway = new DynamicEvidencePort([]);

    const first = await runWinbackReport(
      { channel: "@DynamicTarget" },
      firstGateway
    );
    const second = await runWinbackReport(
      { channel: "@DynamicTarget" },
      secondGateway
    );

    expect(firstGateway.ledgerCalls).toBe(0);
    expect(secondGateway.ledgerCalls).toBe(0);
    expect(first.report.leads).toEqual([]);
    expect(second.report.leads).toEqual(first.report.leads);
    expect(first.report.funnel).toMatchObject({
      rawDomainMatches: 0,
      strictProductContinuousPasses: 0,
      sameBrandReactivationPasses: 0
    });
    expect(first.report.methodology.qualificationPolicy).toBe(
      "same_brand_reactivation"
    );
  });

  it("excludes target evidence outside the approved target window", async () => {
    const gateway = new DynamicEvidencePort([
      sponsor({
        sponsorName: "Acme",
        normalizedDomain: "acme.example",
        rawSponsorDomain: "acme.example",
        publicationName: "Dynamic Target",
        publicationUrl: TARGET_URL,
        contentUrl:
          "https://www.youtube.com/watch?v=target-acme-too-old",
        publishedDate: "2025-07-18",
        evidenceSource: "description",
        excerpt: "Target said Acme sponsored this video.",
        evidenceConfidence: 0.91
      })
    ]);

    const { report } = await runWinbackReport(
      { channel: "@DynamicTarget" },
      gateway
    );

    expect(report.funnel).toMatchObject({
      targetApiRows: 1,
      staleDomainResolvedTargets: 0,
      rawDomainMatches: 0,
      sameBrandReactivationPasses: 0
    });
    expect(report.leads).toEqual([]);
  });

  it("accepts equivalent approved YouTube URL forms as one target identity", async () => {
    const gateway = new DynamicEvidencePort();
    const target = {
      name: "Dynamic Target",
      url: "https://youtube.com/@DynamicTarget?view_as=subscriber",
      subscriberCount: 1_000_000
    };
    const identity = (await gateway.resolveTarget()).identity;
    const peers = await gateway.listLockedPeers(TARGET_URL, 1_000_000);

    const { report } = await runWinbackReport(
      { channel: "@DynamicTarget" },
      gateway,
      {
        approvedCohort: {
          target,
          identity,
          peers,
          cohortHash: approvedCohortHash(target, peers, identity)
        }
      }
    );

    expect(report.target.url).toBe(TARGET_URL);
    expect(report.leads.map((lead) => lead.brand)).toEqual(["Acme"]);
  });

  it("accepts a renamed handle and display name when the verified channel ID is unchanged", async () => {
    const gateway = new SameIdPresentationDriftPort();
    const approvedTarget = {
      name: "Old Target Name",
      url: "https://www.youtube.com/@OldTargetHandle",
      subscriberCount: 1_000_000
    };
    const approvedIdentity = {
      verificationBasis: "channel_id" as const,
      channelId: "UCDynamicTarget123",
      handle: "OldTargetHandle",
      canonicalUrl: approvedTarget.url,
      key: "channel:UCDynamicTarget123"
    };
    const peers = await gateway.listLockedPeers(
      approvedTarget.url,
      approvedTarget.subscriberCount
    );

    const { report } = await runWinbackReport(
      { channel: "@OldTargetHandle" },
      gateway,
      {
        approvedCohort: {
          target: approvedTarget,
          identity: approvedIdentity,
          peers,
          cohortHash: approvedCohortHash(
            approvedTarget,
            peers,
            approvedIdentity
          )
        }
      }
    );

    expect(report.target).toEqual({
      name: "Renamed Target",
      url: RENAMED_TARGET_URL,
      subscriberCount: 1_000_000
    });
    expect(report.targetIdentity).toMatchObject({
      verificationBasis: "channel_id",
      channelId: "UCDynamicTarget123",
      handle: "RenamedTarget"
    });
    expect(report.leads.map((lead) => lead.brand)).toEqual(["Acme"]);
  });
});

class DynamicEvidencePort implements SponsorRadarEvidencePort {
  readonly mode = "live" as const;
  readonly qualificationPolicy = "same_brand_reactivation" as const;
  ledgerCalls = 0;

  constructor(
    private readonly targetRows: NormalizedSponsorEvidence[] =
      defaultTargetRows()
  ) {}

  estimateCredits(operation: EvidenceOperation): number {
    switch (operation) {
      case "resolve_target":
        return 1;
      case "list_locked_peers":
        return 10;
      case "list_target_sponsors":
      case "list_peer_sponsors":
      case "load_verification_ledger":
        return 0;
    }
  }

  estimateRunCredits(): number {
    return 11;
  }

  async resolveTarget(): Promise<ResolvedTarget> {
    return {
      target: {
        name: "Dynamic Target",
        url: TARGET_URL,
        subscriberCount: 1_000_000
      },
      identity: {
        verificationBasis: "exact_unique_handle" as const,
        channelId: null,
        handle: "DynamicTarget",
        canonicalUrl: TARGET_URL,
        key: "handle:dynamictarget"
      },
      config: {
        as_of: "2026-07-19",
        target_window: {
          since: "2025-07-19",
          until: "2026-07-19"
        },
        stale_cutoff_exclusive: "2026-04-20",
        peer_window: {
          since: "2026-04-20",
          until: "2026-07-19"
        },
        target: {
          name: "Dynamic Target",
          url: TARGET_URL,
          subscriber_count: 1_000_000,
          cached_raw_file: "unused.json"
        },
        peers: [],
        sponsor_types: ["explicit_ad"],
        brand_research_domains: []
      }
    };
  }

  async listTargetSponsors(): Promise<NormalizedSponsorEvidenceResult> {
    return result(this.targetRows);
  }

  async listLockedPeers(
    targetUrl: string,
    targetSubscriberCount?: number
  ): Promise<LockedPeer[]> {
    void targetUrl;
    void targetSubscriberCount;
    return [
      {
        name: "Peer One",
        url: PEER_ONE_URL,
        subscriberCount: 900_000,
        creatorId: "peer-1"
      },
      {
        name: "Peer Two",
        url: PEER_TWO_URL,
        subscriberCount: 1_100_000,
        creatorId: "peer-2"
      }
    ];
  }

  async listPeerSponsors(
    peerUrl: string
  ): Promise<NormalizedSponsorEvidenceResult> {
    if (peerUrl === PEER_TWO_URL) return result([]);
    return result(defaultPeerRows());
  }

  async loadVerificationLedger(): Promise<never> {
    this.ledgerCalls += 1;
    throw new Error("Dynamic qualification must not load a manual ledger");
  }
}

class SameIdPresentationDriftPort extends DynamicEvidencePort {
  override async resolveTarget() {
    const base = await super.resolveTarget();
    return {
      ...base,
      target: {
        name: "Renamed Target",
        url: RENAMED_TARGET_URL,
        subscriberCount: 1_000_000
      },
      identity: {
        verificationBasis: "channel_id" as const,
        channelId: "UCDynamicTarget123",
        handle: "RenamedTarget",
        canonicalUrl: RENAMED_TARGET_URL,
        key: "channel:UCDynamicTarget123"
      },
      config: {
        ...base.config,
        target: {
          ...base.config.target,
          name: "Renamed Target",
          url: RENAMED_TARGET_URL
        }
      }
    };
  }

  override async listTargetSponsors() {
    return result(
      defaultTargetRows().map((row) =>
        row.publicationUrl === TARGET_URL
          ? {
              ...row,
              publicationName: "Renamed Target",
              publicationUrl: RENAMED_TARGET_URL
            }
          : row
      )
    );
  }
}

function result(
  rows: NormalizedSponsorEvidence[]
): NormalizedSponsorEvidenceResult {
  return {
    rows,
    completeness: "complete",
    trackingStatus: null
  };
}

function defaultTargetRows(): NormalizedSponsorEvidence[] {
  return [
    sponsor({
      sponsorName: "Acme",
      normalizedDomain: "acme.example",
      rawSponsorDomain: "acme.example",
      publicationName: "Dynamic Target",
      publicationUrl: TARGET_URL,
      contentUrl: "https://www.youtube.com/watch?v=target-acme",
      publishedDate: "2025-10-01",
      totalAdsFound: 2,
      evidenceSource: "description",
      excerpt: "Target said Acme sponsored this video.",
      evidenceConfidence: 0.91
    }),
    sponsor({
      sponsorName: "Beta",
      normalizedDomain: "beta.example",
      rawSponsorDomain: "beta.example",
      publicationName: "Dynamic Target",
      publicationUrl: TARGET_URL,
      contentUrl: "https://www.youtube.com/watch?v=target-beta-old",
      publishedDate: "2025-09-01"
    }),
    sponsor({
      sponsorName: "Beta",
      normalizedDomain: "beta.example",
      rawSponsorDomain: "beta.example",
      publicationName: "Dynamic Target",
      publicationUrl: TARGET_URL,
      contentUrl: "https://www.youtube.com/watch?v=target-beta-new",
      publishedDate: "2026-06-01"
    }),
    sponsor({
      sponsorName: "Acme",
      normalizedDomain: "acme.example",
      rawSponsorDomain: "acme.example",
      publicationName: "Unapproved Channel",
      publicationUrl: "https://www.youtube.com/@UnapprovedChannel",
      contentUrl: "https://www.youtube.com/watch?v=foreign-acme",
      publishedDate: "2026-07-01"
    })
  ];
}

function defaultPeerRows(): NormalizedSponsorEvidence[] {
  return [
    sponsor({
      sponsorName: "Acme Incorporated",
      normalizedDomain: "acme.example",
      rawSponsorDomain: "acme.example",
      publicationName: "Peer One",
      publicationUrl: PEER_ONE_URL,
      contentUrl: "https://www.youtube.com/watch?v=peer-acme",
      publishedDate: "2026-06-20",
      evidenceSource: "transcript",
      excerpt: "Peer thanked Acme for sponsoring this video.",
      evidenceConfidence: 0.93
    }),
    sponsor({
      sponsorName: "Beta",
      normalizedDomain: "beta.example",
      rawSponsorDomain: "beta.example",
      publicationName: "Peer One",
      publicationUrl: PEER_ONE_URL,
      contentUrl: "https://www.youtube.com/watch?v=peer-beta",
      publishedDate: "2026-06-22"
    }),
    sponsor({
      sponsorName: "No Domain",
      normalizedDomain: null,
      rawSponsorDomain: null,
      publicationName: "Peer One",
      publicationUrl: PEER_ONE_URL,
      contentUrl: "https://www.youtube.com/watch?v=peer-no-domain",
      publishedDate: "2026-06-23"
    }),
    sponsor({
      sponsorName: "Acme",
      normalizedDomain: "acme.example",
      rawSponsorDomain: "acme.example",
      publicationName: "Unapproved Peer",
      publicationUrl: "https://www.youtube.com/@UnapprovedPeer",
      contentUrl: "https://www.youtube.com/watch?v=foreign-peer-acme",
      publishedDate: "2026-06-25"
    })
  ];
}

function sponsor(
  overrides: Partial<NormalizedSponsorEvidence>
): NormalizedSponsorEvidence {
  return {
    provider: "upriver",
    sourceEndpoint: "sponsors",
    sponsorName: "Sponsor",
    rawSponsorDomain: "sponsor.example",
    normalizedDomain: "sponsor.example",
    totalAdsFound: 1,
    publicationName: "Publication",
    publicationUrl: TARGET_URL,
    contentUrl: "https://www.youtube.com/watch?v=evidence",
    publishedDate: "2025-10-01",
    placementType: "explicit_ad",
    evidenceSource: "description",
    excerpt: "Sponsor evidence.",
    evidenceConfidence: 0.9,
    coverage: "active",
    warnings: [],
    ...overrides
  };
}

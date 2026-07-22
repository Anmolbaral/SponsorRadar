import { describe, expect, it } from "vitest";
import { PilotConfigSchema } from "@/src/radar/adapters/upriver/contracts";
import type { NormalizedSponsorEvidence } from "@/src/radar/adapters/upriver/normalize";
import type { ResolvedTarget } from "@/src/radar/application/ports";
import {
  agentToolDefinitions,
  isAgentToolName,
  projectAnalysis,
  projectLockedPeers,
  projectSponsorResult,
  serializeEnvelope
} from "@/src/radar/application/agentic/agent-tools";
import {
  AgentEvidencePreconditionError,
  AgentEvidenceState
} from "@/src/radar/application/agentic/evidence-state";

const TARGET_URL = "https://www.youtube.com/@Target";
const PEER_URL = "https://www.youtube.com/@PeerOne";

function syntheticResolvedTarget(): ResolvedTarget {
  return {
    target: {
      name: "Target",
      url: TARGET_URL,
      subscriberCount: 1_000_000
    },
    identity: {
      verificationBasis: "channel_id",
      channelId: "UC0000000000000000000000",
      handle: "Target",
      canonicalUrl: TARGET_URL,
      key: "channel:UC0000000000000000000000"
    },
    config: PilotConfigSchema.parse({
      as_of: "2026-07-22",
      target_window: { since: "2025-07-22", until: "2026-07-22" },
      stale_cutoff_exclusive: "2026-04-23",
      peer_window: { since: "2026-04-23", until: "2026-07-22" },
      target: {
        name: "Target",
        url: TARGET_URL,
        subscriber_count: 1_000_000,
        cached_raw_file: "raw/target.json"
      },
      peers: [
        {
          name: "PeerOne",
          url: PEER_URL,
          subscriber_count: 900_000,
          raw_file: "raw/peer-one.json"
        }
      ],
      sponsor_types: ["explicit_ad"],
      brand_research_domains: []
    })
  };
}

function sponsorRow(
  overrides: Partial<NormalizedSponsorEvidence> = {}
): NormalizedSponsorEvidence {
  return {
    provider: "upriver",
    sourceEndpoint: "sponsors",
    sponsorName: "Acme",
    rawSponsorDomain: "acme.com",
    normalizedDomain: "acme.com",
    totalAdsFound: 2,
    publicationName: "Target",
    publicationUrl: TARGET_URL,
    contentUrl: "https://www.youtube.com/watch?v=target-video",
    publishedDate: "2026-01-10",
    placementType: "explicit_ad",
    evidenceSource: "transcript",
    excerpt: "This video is sponsored by Acme.",
    evidenceConfidence: 0.9,
    coverage: "active",
    warnings: [],
    ...overrides
  };
}

function stateWithCohort(): AgentEvidenceState {
  const state = new AgentEvidenceState();
  state.recordResolvedTarget(syntheticResolvedTarget());
  state.recordLockedPeers([
    {
      name: "PeerOne",
      url: PEER_URL,
      subscriberCount: 900_000,
      creatorId: "creator-1"
    }
  ]);
  return state;
}

describe("agent tool catalog", () => {
  it("exposes exactly the six agent tools with strict JSON schemas", () => {
    const definitions = agentToolDefinitions();
    expect(definitions.map((tool) => tool.name)).toEqual([
      "resolve_target",
      "list_locked_peers",
      "list_target_sponsors",
      "list_peer_sponsors",
      "analyze_evidence",
      "submit_report"
    ]);
    for (const definition of definitions) {
      expect(definition.inputSchema.additionalProperties).toBe(false);
      expect(definition.description.length).toBeGreaterThan(20);
    }
    const resolveSchema = definitions[0].inputSchema as {
      required?: string[];
    };
    expect(resolveSchema.required).toEqual(["channel"]);
  });

  it("recognizes only catalog names", () => {
    expect(isAgentToolName("resolve_target")).toBe(true);
    expect(isAgentToolName("load_verification_ledger")).toBe(false);
    expect(isAgentToolName("delete_everything")).toBe(false);
  });
});

describe("evidence projections", () => {
  it("caps sponsor rows and never leaks excerpts or content urls", () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      sponsorRow({ sponsorName: `Sponsor ${index}` })
    );
    const projection = projectSponsorResult(
      { rows, completeness: "complete", trackingStatus: null },
      { peerRef: "peer_1" }
    ) as { rows: unknown[]; rowCount: number; truncatedRows: number };

    expect(projection.rowCount).toBe(60);
    expect(projection.rows).toHaveLength(40);
    expect(projection.truncatedRows).toBe(20);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("sponsored by Acme");
    expect(serialized).not.toContain("watch?v=");
  });

  it("truncates long strings and strips control characters", () => {
    const projection = projectSponsorResult(
      {
        rows: [
          sponsorRow({
            sponsorName: `Evil${"x".repeat(400)}`
          })
        ],
        completeness: "complete",
        trackingStatus: null
      },
      {}
    ) as { rows: Array<{ sponsorName: string }> };
    expect(projection.rows[0].sponsorName).not.toContain("");
    expect(projection.rows[0].sponsorName.length).toBeLessThanOrEqual(120);
  });

  it("hard-caps the serialized envelope size", () => {
    const envelope = serializeEnvelope({
      data: "y".repeat(50_000)
    });
    expect(Buffer.byteLength(envelope, "utf8")).toBeLessThanOrEqual(8_000);
    expect(envelope).toContain("truncated");
  });

  it("projects peers with refs and reach ratios", () => {
    const state = stateWithCohort();
    const projection = projectLockedPeers(
      state.requireResolved().target,
      state.requirePeers()
    ) as { peers: Array<{ peerRef: string; reachRatio: number }> };
    expect(projection.peers[0].peerRef).toBe("peer_1");
    expect(projection.peers[0].reachRatio).toBe(0.9);
  });
});

describe("AgentEvidenceState", () => {
  it("fails closed on unknown peer refs and unmet preconditions", () => {
    const state = new AgentEvidenceState();
    expect(() => state.requireResolved()).toThrow(
      AgentEvidencePreconditionError
    );
    state.recordResolvedTarget(syntheticResolvedTarget());
    expect(() => state.peerByRef("peer_9")).toThrow(
      AgentEvidencePreconditionError
    );
    state.recordLockedPeers([
      {
        name: "PeerOne",
        url: PEER_URL,
        subscriberCount: 900_000,
        creatorId: null
      }
    ]);
    expect(() => state.analyze()).toThrow(/list_peer_sponsors/);
  });

  it("analyzes to zero leads without target history and reports it honestly", () => {
    const state = stateWithCohort();
    state.recordPeerSponsors("peer_1", {
      rows: [
        sponsorRow({
          publicationUrl: PEER_URL,
          publicationName: "PeerOne",
          publishedDate: "2026-06-01"
        })
      ],
      completeness: "complete",
      trackingStatus: null
    });

    const analysis = state.analyze();
    expect(analysis.targetHistorySearched).toBe(false);
    expect(analysis.qualification.leads).toHaveLength(0);
    expect(analysis.funnel.targetApiRows).toBe(0);
    expect(analysis.funnel.strictPeerApiRows).toBe(1);

    const projection = projectAnalysis(analysis) as { leadCount: number };
    expect(projection.leadCount).toBe(0);
  });

  it("qualifies a same-brand reactivation lead from stale target + recent peer evidence", () => {
    const state = stateWithCohort();
    state.recordPeerSponsors("peer_1", {
      rows: [
        sponsorRow({
          publicationUrl: PEER_URL,
          publicationName: "PeerOne",
          publishedDate: "2026-06-01"
        })
      ],
      completeness: "complete",
      trackingStatus: null
    });
    state.recordTargetSponsors({
      rows: [sponsorRow({ publishedDate: "2025-11-01" })],
      completeness: "complete",
      trackingStatus: null
    });

    const analysis = state.analyze();
    expect(analysis.targetHistorySearched).toBe(true);
    expect(analysis.qualification.leads).toHaveLength(1);
    expect(analysis.qualification.leads[0].domain).toBe("acme.com");
    expect(analysis.qualification.leads[0].peer).toBe("PeerOne");
    expect(analysis.funnel.sameBrandReactivationPasses).toBe(1);
    expect(analysis.funnel.strictProductContinuousPasses).toBe(0);
  });

  it("mirrors the legacy partial placeholder for failed peers", () => {
    const state = stateWithCohort();
    state.recordPeerSponsorFailure("peer_1");
    const result = state.peerSponsorResult("peer_1");
    expect(result?.completeness).toBe("partial");
    expect(result?.trackingStatus?.status).toBe("failed");
    expect(state.analyze().qualification.leads).toHaveLength(0);
  });
});

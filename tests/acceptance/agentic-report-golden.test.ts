import { describe, expect, it } from "vitest";
import { FixtureResearchPlanner } from "@/src/agent/llm/fixture-research-planner";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import type { SponsorRadarEvidencePort } from "@/src/radar/application/ports";
import { runAgenticReport } from "@/src/radar/application/agentic/run-agentic-report";

const FIXTURE_CHANNEL = "@UrAvgConsumer";

// Fixture evidence port declaring the same-brand reactivation policy.
function sameBrandFixturePort(): SponsorRadarEvidencePort {
  const fixture = new FixtureEvidenceGateway(process.cwd());
  return {
    mode: "fixture",
    qualificationPolicy: "same_brand_reactivation",
    cachePolicyKey: fixture.cachePolicyKey,
    estimateCredits: () => 0,
    estimateRunCredits: () => 0,
    resolveTarget: (input) => fixture.resolveTarget(input),
    listTargetSponsors: (url) => fixture.listTargetSponsors(url),
    listLockedPeers: (url, count) => fixture.listLockedPeers(url, count),
    listPeerSponsors: (url) => fixture.listPeerSponsors(url),
    loadVerificationLedger: () => fixture.loadVerificationLedger()
  };
}

describe("agentic report golden pin", () => {
  it("pins the fixture golden output: one Dell reactivation via Dave2D", async () => {
    const { report } = await runAgenticReport(
      { channel: FIXTURE_CHANNEL },
      sameBrandFixturePort(),
      new FixtureResearchPlanner()
    );

    expect(
      report.leads.map((lead) => `${lead.domain}|${lead.peer}`)
    ).toEqual(["dell.com|Dave2D"]);
    expect(report.leads[0].brand).toBe("Dell");
    expect(report.leads[0].continuity).toBe("U");
    expect(report.funnel).toEqual({
      targetApiRows: 89,
      staleDomainResolvedTargets: 36,
      staleExplicitTargetCandidates: 11,
      strictPeerApiRows: 3,
      manuallyConfirmedS3PeerRows: 0,
      joinableS3PeerRows: 0,
      rawDomainMatches: 1,
      strictProductContinuousPasses: 0,
      sameBrandReactivationPasses: 1
    });
    expect(new Set(report.coverage.map((notice) => notice.code))).toEqual(
      new Set([
        "target_domain_coverage",
        "peer_domain_joinability",
        "target_tracking_status",
        "peer_tracking_status",
        "grouped_summary_limit"
      ])
    );
  });
});

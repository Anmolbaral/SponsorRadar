import { describe, expect, it } from "vitest";
import { FixtureResearchPlanner } from "@/src/agent/llm/fixture-research-planner";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import type { SponsorRadarEvidencePort } from "@/src/radar/application/ports";
import { runAgenticReport } from "@/src/radar/application/agentic/run-agentic-report";
import { evaluateReportQuality } from "@/src/evals/report-quality";

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

describe("golden report quality eval — agentic engine", () => {
  it("passes the same quality gates as the legacy engine on the golden cohort", async () => {
    const { report } = await runAgenticReport(
      { channel: "@UrAvgConsumer" },
      sameBrandFixturePort(),
      new FixtureResearchPlanner()
    );

    expect(
      report.leads.map((lead) => `${lead.domain}|${lead.peer}`)
    ).toEqual(["dell.com|Dave2D"]);

    const score = evaluateReportQuality(report, {
      expectedQualifiedLeads: 1,
      allowedLeadKeys: ["dell.com|Dave2D"]
    });

    expect(score).toEqual({
      evidenceAttributionRate: 1,
      knownFalsePositiveLeads: 0,
      missingExpectedLeads: 0,
      paddedResults: 0,
      cautiousLanguageViolations: 0,
      coverageWarningsVisible: true,
      passed: true
    });
  });
});

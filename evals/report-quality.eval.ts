import { describe, expect, it } from "vitest";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import { runWinbackReport } from "@/src/radar/application/run-winback-report";
import { evaluateReportQuality } from "@/src/evals/report-quality";

describe("golden report quality eval", () => {
  it("has full attribution, no false positives, no padding, and cautious language", async () => {
    const { report } = await runWinbackReport(
      { channel: "@UrAvgConsumer" },
      new FixtureEvidenceGateway(process.cwd())
    );
    const score = evaluateReportQuality(report, {
      expectedQualifiedLeads: 1,
      allowedLeadKeys: ["dell.com|Dave2D"]
    });

    expect(score).toEqual({
      evidenceAttributionRate: 1,
      knownFalsePositiveLeads: 0,
      paddedResults: 0,
      cautiousLanguageViolations: 0,
      coverageWarningsVisible: true,
      passed: true
    });
  });
});

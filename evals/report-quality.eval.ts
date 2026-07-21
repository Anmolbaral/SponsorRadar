import { describe, expect, it } from "vitest";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import { runWinbackReport } from "@/src/radar/application/run-winback-report";
import { evaluateReportQuality } from "@/src/evals/report-quality";
import type { WinbackReport } from "@/src/radar/domain/types";

describe("golden report quality eval", () => {
  it("has full attribution, the expected lead present, no false positives, no padding, and cautious language", async () => {
    const { report } = await runWinbackReport(
      { channel: "@UrAvgConsumer" },
      new FixtureEvidenceGateway(process.cwd())
    );

    // Pin the positive case: the golden lead must actually be present. Without
    // this, a pipeline regression that silently drops the lead would still
    // score a perfect card (zero leads trivially satisfies every other metric).
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

  it("fails a report that silently drops the expected lead", () => {
    // Guard against vacuous success: an empty report used to score a perfect
    // card because every metric is trivially satisfied by zero leads.
    const droppedLeadReport = {
      leads: [],
      coverage: [
        {
          code: "target_domain_coverage",
          severity: "warning",
          message: "coverage warning is present"
        }
      ]
    } as unknown as WinbackReport;

    const score = evaluateReportQuality(droppedLeadReport, {
      expectedQualifiedLeads: 1,
      allowedLeadKeys: ["dell.com|Dave2D"]
    });

    expect(score.missingExpectedLeads).toBe(1);
    expect(score.evidenceAttributionRate).toBe(0);
    expect(score.passed).toBe(false);
  });

  it("counts unique allowed lead keys instead of duplicate rows", async () => {
    const { report } = await runWinbackReport(
      { channel: "@UrAvgConsumer" },
      new FixtureEvidenceGateway(process.cwd())
    );
    const lead = report.leads[0];
    if (!lead) throw new Error("Expected the golden Dell lead");
    const duplicatedLeadReport: WinbackReport = {
      ...report,
      leads: [structuredClone(lead), structuredClone(lead)]
    };

    const score = evaluateReportQuality(duplicatedLeadReport, {
      expectedQualifiedLeads: 2,
      allowedLeadKeys: ["dell.com|Dave2D", "hp.com|AnotherPeer"]
    });

    expect(score.knownFalsePositiveLeads).toBe(0);
    expect(score.missingExpectedLeads).toBe(1);
    expect(score.paddedResults).toBe(0);
    expect(score.passed).toBe(false);
  });
});

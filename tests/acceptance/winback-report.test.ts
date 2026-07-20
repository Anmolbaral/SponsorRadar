import { describe, expect, it } from "vitest";
import {
  FixtureEvidenceGateway,
  UnsupportedFixtureChannelError
} from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import { runWinbackReport } from "@/src/radar/application/run-winback-report";

describe("Phase 1 sponsor winback acceptance", () => {
  it("turns one channel handle into exactly one verified Dell/XPS lead", async () => {
    const gateway = new FixtureEvidenceGateway(process.cwd());
    const { report, events } = await runWinbackReport(
      { channel: "@UrAvgConsumer" },
      gateway
    );

    expect(report.phase).toBe("phase_1_fixture");
    expect(report.target.name).toBe("UrAvgConsumer");
    expect(report.funnel).toEqual({
      targetApiRows: 89,
      staleDomainResolvedTargets: 36,
      staleExplicitTargetCandidates: 11,
      strictPeerApiRows: 3,
      manuallyConfirmedS3PeerRows: 3,
      joinableS3PeerRows: 2,
      rawDomainMatches: 1,
      strictProductContinuousPasses: 1,
      sameBrandReactivationPasses: 0
    });
    expect(report.leads).toHaveLength(1);
    expect(report.leads[0]).toMatchObject({
      brand: "Dell",
      domain: "dell.com",
      peer: "Dave2D",
      peerUrl: "https://www.youtube.com/@Dave2D",
      peerSubscriberCount: 3690000,
      continuity: "A",
      targetProductLine: "Dell XPS 14 / XPS laptops",
      peerProductLine: "Dell XPS 13 / XPS laptops",
      targetObservedPlacements: 2,
      targetFirstObservedDate: null,
      peerObservedPlacements: 1,
      peerFirstObservedDate: "2026-06-16",
      targetDaysSinceLatest: 191,
      peerDaysSinceLatest: 33
    });
    expect(report.leads[0].targetEvidence.contentUrl).toContain(
      "youtube.com/shorts/"
    );
    expect(report.leads[0].peerEvidence.contentUrl).toContain(
      "youtube.com/watch"
    );
    expect(report.leads[0].outreachHypothesis).toContain(
      "worth researching for outreach"
    );
    expect(report.leads[0].outreachHypothesis).not.toMatch(
      /stopped sponsoring|same buyer is active/i
    );
    expect(report.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "target_domain_coverage",
          numerator: 49,
          denominator: 89,
          percentage: 55.1
        }),
        expect.objectContaining({
          code: "peer_domain_joinability",
          numerator: 2,
          denominator: 3,
          percentage: 66.7
        }),
        expect.objectContaining({ code: "grouped_summary_limit" })
      ])
    );

    expect(report.audit).toMatchObject({
      toolCalls: 7,
      llmCalls: 0,
      skillsLoaded: [],
      resultBasedCreditEstimate: 0,
      projectedLiveCredits: 129,
      timeToFirstResultMs: expect.any(Number),
      totalDurationMs: expect.any(Number)
    });
    const completed = events.filter(
      (event) => event.eventType === "tool.completed"
    );
    const started = events.filter(
      (event) => event.eventType === "tool.started"
    );
    expect(started).toHaveLength(7);
    expect(completed).toHaveLength(7);
    expect(
      completed.every(
        (event) =>
          event.tool?.mode === "fixture" &&
          event.tool.estimatedCredits === 0 &&
          event.tool.resultBasedCredits === null &&
          event.tool.outcome === "success"
      )
    ).toBe(true);
    expect(events.some((event) => event.eventType.startsWith("llm."))).toBe(
      false
    );
  });

  it("accepts the canonical channel URL as the same identity", async () => {
    const gateway = new FixtureEvidenceGateway(process.cwd());
    const { report } = await runWinbackReport(
      {
        channel:
          "https://www.youtube.com/@UrAvgConsumer?sub_confirmation=1"
      },
      gateway
    );
    expect(report.leads.map((lead) => lead.brand)).toEqual(["Dell"]);
  });

  it("fails honestly for a channel outside the verified fixture", async () => {
    const gateway = new FixtureEvidenceGateway(process.cwd());
    await expect(
      runWinbackReport({ channel: "@SomeOtherCreator" }, gateway)
    ).rejects.toBeInstanceOf(UnsupportedFixtureChannelError);
  });
});

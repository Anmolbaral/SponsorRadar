import { describe, expect, it } from "vitest";
import { FixtureResearchPlanner } from "@/src/agent/llm/fixture-research-planner";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import { AgentIterationLimitError } from "@/src/radar/application/agentic/agent-loop";
import { runAgenticReport } from "@/src/radar/application/agentic/run-agentic-report";

// Acceptance harness for the agentic engine: the scripted fixture planner
// drives the full research journey against the captured fixture cohort.
function runFixtureWinback(channel: string) {
  return runAgenticReport(
    { channel },
    new FixtureEvidenceGateway(process.cwd()),
    new FixtureResearchPlanner()
  );
}

describe("Sponsor winback acceptance", () => {
  it("turns one channel handle into exactly one Dell same-brand reactivation lead", async () => {
    const { report, events } = await runFixtureWinback("@UrAvgConsumer");

    expect(report.phase).toBe("workflow_fixture");
    expect(report.target.name).toBe("UrAvgConsumer");
    expect(report.methodology.qualificationPolicy).toBe(
      "same_brand_reactivation"
    );
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
    expect(report.leads).toHaveLength(1);
    expect(report.leads[0]).toMatchObject({
      brand: "Dell",
      domain: "dell.com",
      peer: "Dave2D",
      peerUrl: "https://www.youtube.com/@Dave2D",
      peerSubscriberCount: 3690000,
      continuity: "U",
      targetProductLine: "Unverified",
      peerProductLine: "Unverified",
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
    expect(report.leads[0].outreachHypothesis).toContain("worth researching");
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
          numerator: 1,
          denominator: 3,
          percentage: 33.3
        }),
        expect.objectContaining({ code: "grouped_summary_limit" })
      ])
    );

    // submit_report is still in flight when the summary is taken, so the
    // summary counts the seven prior completed tool calls.
    expect(report.audit).toMatchObject({
      toolCalls: 7,
      llmCalls: 8,
      skillsLoaded: [],
      resultBasedCreditEstimate: 0,
      projectedLiveCredits: 125,
      timeToFirstResultMs: expect.any(Number),
      totalDurationMs: expect.any(Number)
    });
    const started = events.filter(
      (event) => event.eventType === "tool.started"
    );
    const completed = events.filter(
      (event) => event.eventType === "tool.completed"
    );
    expect(started).toHaveLength(8);
    expect(completed).toHaveLength(8);
    expect(
      completed.every(
        (event) =>
          event.tool?.mode === "fixture" &&
          event.tool.estimatedCredits === 0 &&
          event.tool.resultBasedCredits === null &&
          event.tool.outcome === "success"
      )
    ).toBe(true);
    const llmCompleted = events.filter(
      (event) => event.eventType === "llm.completed"
    );
    expect(llmCompleted).toHaveLength(8);
    expect(
      llmCompleted.every((event) => event.llm?.purpose === "agent_loop")
    ).toBe(true);
  });

  it("accepts the canonical channel URL as the same identity", async () => {
    const { report } = await runFixtureWinback(
      "https://www.youtube.com/@UrAvgConsumer?sub_confirmation=1"
    );
    expect(report.leads.map((lead) => lead.brand)).toEqual(["Dell"]);
  });

  it("fails honestly for a channel outside the verified fixture", async () => {
    // resolve_target keeps failing for unsupported channels, so the run can
    // never finalize a report and fails closed at the iteration ceiling.
    await expect(runFixtureWinback("@SomeOtherCreator")).rejects.toThrow(
      AgentIterationLimitError
    );
  });
});

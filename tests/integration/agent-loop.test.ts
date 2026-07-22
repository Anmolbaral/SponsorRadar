import { describe, expect, it } from "vitest";
import {
  FixtureAgentLlm,
  fixtureAssistantText,
  fixtureAssistantToolUse,
  type FixtureAgentStep
} from "@/src/agent/llm/fixture-agent-llm";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import type { NormalizedSponsorEvidenceResult } from "@/src/radar/adapters/upriver/normalize";
import type { SponsorRadarEvidencePort } from "@/src/radar/application/ports";
import {
  AgentDidNotFinalizeError,
  AgentIterationLimitError,
  AgentRefusalError
} from "@/src/radar/application/agentic/agent-loop";
import { runAgenticReport } from "@/src/radar/application/agentic/run-agentic-report";
import type { AgentTranscriptEvent } from "@/src/radar/application/agentic/transcript";

const FIXTURE_CHANNEL = "@UrAvgConsumer";

function happyPathSteps(includeTargetHistory: boolean): FixtureAgentStep[] {
  return [
    {
      respond: fixtureAssistantToolUse("resolve_target", {
        channel: FIXTURE_CHANNEL
      })
    },
    { respond: fixtureAssistantToolUse("list_locked_peers", {}) },
    {
      respond: fixtureAssistantToolUse("list_peer_sponsors", {
        peerRef: "peer_1"
      })
    },
    {
      respond: fixtureAssistantToolUse("list_peer_sponsors", {
        peerRef: "peer_2"
      })
    },
    {
      respond: fixtureAssistantToolUse("list_peer_sponsors", {
        peerRef: "peer_3"
      })
    },
    ...(includeTargetHistory
      ? [{ respond: fixtureAssistantToolUse("list_target_sponsors", {}) }]
      : []),
    { respond: fixtureAssistantToolUse("analyze_evidence", {}) },
    {
      respond: fixtureAssistantToolUse("submit_report", {
        analysisRef: "analysis_1"
      })
    }
  ];
}

describe("agent loop against the fixture cohort", () => {
  it("completes the full research journey and assembles a report", async () => {
    const llm = new FixtureAgentLlm(happyPathSteps(true));
    const transcriptEvents: AgentTranscriptEvent[] = [];

    const { report, events } = await runAgenticReport(
      { channel: FIXTURE_CHANNEL },
      new FixtureEvidenceGateway(process.cwd()),
      llm,
      {
        now: () => Date.parse("2026-07-22T00:00:00.000Z"),
        transcriptSink: (event) => {
          transcriptEvents.push(event);
        }
      }
    );

    expect(report.schemaVersion).toBe(1);
    expect(report.phase).toBe("workflow_fixture");
    expect(report.methodology.qualificationPolicy).toBe(
      "same_brand_reactivation"
    );
    expect(report.funnel.targetApiRows).toBeGreaterThan(0);
    expect(report.audit.llmCalls).toBe(llm.consumedSteps);
    // submit_report is still in flight when the report summary is taken, so
    // the summary counts the seven prior completed tool calls.
    expect(report.audit.toolCalls).toBe(7);

    const terminal = transcriptEvents.find(
      (event) => event.kind === "terminal"
    );
    expect(terminal).toMatchObject({ status: "completed" });
    expect(
      events.some(
        (event) =>
          event.eventType === "llm.completed" &&
          event.llm?.purpose === "agent_loop"
      )
    ).toBe(true);
  });

  it("finishes honestly when the planner skips the expensive target history", async () => {
    const llm = new FixtureAgentLlm(happyPathSteps(false));
    const { report } = await runAgenticReport(
      { channel: FIXTURE_CHANNEL },
      new FixtureEvidenceGateway(process.cwd()),
      llm
    );

    expect(report.leads).toHaveLength(0);
    expect(report.funnel.targetApiRows).toBe(0);
    expect(
      report.coverage.some(
        (notice) => notice.code === "target_history_not_searched"
      )
    ).toBe(true);
  });

  it("nudges a prose-only turn back to tools once, then continues", async () => {
    const llm = new FixtureAgentLlm([
      { respond: fixtureAssistantText("Let me think about this out loud.") },
      ...happyPathSteps(false)
    ]);
    const { report } = await runAgenticReport(
      { channel: FIXTURE_CHANNEL },
      new FixtureEvidenceGateway(process.cwd()),
      llm
    );
    expect(report.schemaVersion).toBe(1);
    expect(llm.consumedSteps).toBe(8);
  });

  it("fails closed when the planner never returns to tools", async () => {
    const llm = new FixtureAgentLlm([
      { respond: fixtureAssistantText("thinking") },
      { respond: fixtureAssistantText("still thinking") }
    ]);
    await expect(
      runAgenticReport(
        { channel: FIXTURE_CHANNEL },
        new FixtureEvidenceGateway(process.cwd()),
        llm
      )
    ).rejects.toThrow(AgentDidNotFinalizeError);
  });

  it("fails closed on planner refusal", async () => {
    const llm = new FixtureAgentLlm([
      { respond: fixtureAssistantText(""), stopReason: "refusal" }
    ]);
    await expect(
      runAgenticReport(
        { channel: FIXTURE_CHANNEL },
        new FixtureEvidenceGateway(process.cwd()),
        llm
      )
    ).rejects.toThrow(AgentRefusalError);
  });

  it("terminates at the iteration cap without a finalize", async () => {
    const llm = new FixtureAgentLlm([
      {
        respond: fixtureAssistantToolUse("resolve_target", {
          channel: FIXTURE_CHANNEL
        })
      },
      { respond: fixtureAssistantToolUse("list_locked_peers", {}) }
    ]);
    await expect(
      runAgenticReport(
        { channel: FIXTURE_CHANNEL },
        new FixtureEvidenceGateway(process.cwd()),
        llm,
        { maxIterations: 2 }
      )
    ).rejects.toThrow(AgentIterationLimitError);
  });

  it("feeds a rogue tool proposal back as a structured refusal, never executing it", async () => {
    const rogueThenRecover: FixtureAgentStep[] = [
      {
        respond: fixtureAssistantToolUse("load_verification_ledger", {
          ledgerKey: "../../etc/passwd"
        })
      },
      {
        expect: (messages) => {
          const lastToolResult = [...messages]
            .reverse()
            .find((message) => message.role === "tool_result");
          if (
            !lastToolResult ||
            lastToolResult.role !== "tool_result" ||
            !lastToolResult.isError ||
            !lastToolResult.content.includes("unknown_tool")
          ) {
            throw new Error(
              "The rogue proposal must come back as an unknown_tool error envelope"
            );
          }
        },
        respond: fixtureAssistantToolUse("resolve_target", {
          channel: FIXTURE_CHANNEL
        })
      },
      ...happyPathSteps(false).slice(1)
    ];
    const { report, events } = await runAgenticReport(
      { channel: FIXTURE_CHANNEL },
      new FixtureEvidenceGateway(process.cwd()),
      new FixtureAgentLlm(rogueThenRecover)
    );
    expect(report.schemaVersion).toBe(1);
    expect(
      events.some((event) =>
        event.tool?.name?.includes("load_verification_ledger")
      )
    ).toBe(false);
  });

  it("adapts to a budget denial and still finishes within budget", async () => {
    const fixture = new FixtureEvidenceGateway(process.cwd());
    const pricedPort: SponsorRadarEvidencePort = {
      mode: "fixture",
      qualificationPolicy: "same_brand_reactivation",
      estimateCredits: (operation) =>
        operation === "list_target_sponsors" ? 115 : 1,
      estimateRunCredits: () => 156,
      resolveTarget: (input) => fixture.resolveTarget(input),
      listTargetSponsors: (url) => fixture.listTargetSponsors(url),
      listLockedPeers: (url, count) => fixture.listLockedPeers(url, count),
      listPeerSponsors: (url): Promise<NormalizedSponsorEvidenceResult> =>
        fixture.listPeerSponsors(url),
      loadVerificationLedger: () => fixture.loadVerificationLedger()
    };

    const steps: FixtureAgentStep[] = [
      ...happyPathSteps(true).slice(0, 5),
      { respond: fixtureAssistantToolUse("list_target_sponsors", {}) },
      {
        expect: (messages) => {
          const lastToolResult = [...messages]
            .reverse()
            .find((message) => message.role === "tool_result");
          if (
            !lastToolResult ||
            lastToolResult.role !== "tool_result" ||
            !lastToolResult.content.includes("budget_exceeded")
          ) {
            throw new Error("Expected a budget_exceeded envelope");
          }
        },
        respond: fixtureAssistantToolUse("analyze_evidence", {})
      },
      {
        respond: fixtureAssistantToolUse("submit_report", {
          analysisRef: "analysis_1"
        })
      }
    ];

    const { report } = await runAgenticReport(
      { channel: FIXTURE_CHANNEL, maximumCredits: 20 },
      pricedPort,
      new FixtureAgentLlm(steps)
    );
    expect(report.leads).toHaveLength(0);
    expect(
      report.coverage.some(
        (notice) => notice.code === "target_history_not_searched"
      )
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  FixtureAgentLlm,
  fixtureAssistantToolUse
} from "@/src/agent/llm/fixture-agent-llm";
import { FixtureResearchPlanner } from "@/src/agent/llm/fixture-research-planner";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import type { SponsorRadarEvidencePort } from "@/src/radar/application/ports";
import { runAgenticReport } from "@/src/radar/application/agentic/run-agentic-report";
import {
  parseAuditToolName,
  TOOL_REGISTRY
} from "@/src/radar/application/tools/tool-registry";

const FIXTURE_CHANNEL = "@UrAvgConsumer";

/**
 * Broker-local agent tools that are not provider operations: they call no
 * evidence adapter and spend no credits, so they live outside the registry
 * vocabulary on purpose.
 */
const LOCAL_APPLICATION_TOOLS = new Set([
  "local.analyze_evidence",
  "local.submit_report"
]);

async function runFixtureAgenticReport() {
  return runAgenticReport(
    { channel: FIXTURE_CHANNEL },
    new FixtureEvidenceGateway(process.cwd()),
    new FixtureResearchPlanner()
  );
}

describe("audit history stays inside the registry vocabulary", () => {
  it("records only registered operations (or known local tools) in a full fixture run", async () => {
    const { events } = await runFixtureAgenticReport();

    const toolNames = events
      .filter(
        (event) =>
          event.eventType === "tool.started" ||
          event.eventType === "tool.completed" ||
          event.eventType === "tool.failed"
      )
      .map((event) => event.tool?.name ?? "");

    expect(toolNames.length).toBeGreaterThan(0);
    for (const name of toolNames) {
      if (LOCAL_APPLICATION_TOOLS.has(name)) continue;
      const parsed = parseAuditToolName(name);
      expect(parsed, `unregistered audit tool name: ${name}`).not.toBeNull();
      expect(TOOL_REGISTRY[parsed!.operation].executable).toBe(true);
    }
  });

  it("keeps every registered operation unexposed to the LLM executor", () => {
    for (const [operation, policy] of Object.entries(TOOL_REGISTRY)) {
      expect(policy.llmExposed, `llmExposed leaked for ${operation}`).toBe(
        false
      );
    }
  });

  it("never audits the deferred brand research capability", async () => {
    const { events } = await runFixtureAgenticReport();
    for (const event of events) {
      expect(event.tool?.name ?? "").not.toContain("brand_research");
      expect(event.reason).not.toContain("brand_research");
    }
  });

  it("audits a budget denial as a policy decision, never as an executed tool", async () => {
    const fixture = new FixtureEvidenceGateway(process.cwd());
    // Price the target history above the run ceiling so its proposal is denied.
    const port: SponsorRadarEvidencePort = {
      mode: "fixture",
      qualificationPolicy: fixture.qualificationPolicy,
      cachePolicyKey: fixture.cachePolicyKey,
      estimateCredits: (operation) =>
        operation === "list_target_sponsors" ? 999 : 0,
      estimateRunCredits: () => 0,
      resolveTarget: (input) => fixture.resolveTarget(input),
      listTargetSponsors: (url) => fixture.listTargetSponsors(url),
      listLockedPeers: (url, count) => fixture.listLockedPeers(url, count),
      listPeerSponsors: (url) => fixture.listPeerSponsors(url),
      loadVerificationLedger: () => fixture.loadVerificationLedger()
    };
    const llm = new FixtureAgentLlm([
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
      { respond: fixtureAssistantToolUse("list_target_sponsors", {}) },
      { respond: fixtureAssistantToolUse("analyze_evidence", {}) },
      {
        respond: fixtureAssistantToolUse("submit_report", {
          analysisRef: "analysis_1"
        })
      }
    ]);

    const { report, events } = await runAgenticReport(
      { channel: FIXTURE_CHANNEL },
      port,
      llm
    );

    expect(
      events.some(
        (event) =>
          event.eventType === "policy.decided" &&
          event.policy?.decision === "deny"
      )
    ).toBe(true);
    // A denied proposal never reaches the executor, so no tool event exists.
    const targetSponsorToolEvents = events.filter(
      (event) =>
        event.tool?.name !== undefined &&
        parseAuditToolName(event.tool.name)?.operation ===
          "list_target_sponsors"
    );
    expect(targetSponsorToolEvents).toEqual([]);
    // The run still finishes honestly after the denial.
    expect(report.funnel.targetApiRows).toBe(0);
  });
});

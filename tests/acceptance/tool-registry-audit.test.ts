import { describe, expect, it } from "vitest";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import { runWinbackReport } from "@/src/radar/application/run-winback-report";
import {
  parseAuditToolName,
  TOOL_REGISTRY
} from "@/src/radar/application/tools/tool-registry";

/**
 * Application-local audit tools that are not provider operations: they call
 * no evidence adapter and spend no credits, so they live outside the
 * registry vocabulary on purpose.
 */
const LOCAL_APPLICATION_TOOLS = new Set(["local.load_approved_peer_cohort"]);

describe("audit history stays inside the registry vocabulary", () => {
  it("records only registered operations (or known local tools) in a full fixture run", async () => {
    const { events } = await runWinbackReport(
      { channel: "@UrAvgConsumer" },
      new FixtureEvidenceGateway(process.cwd())
    );

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

  it("never audits the deferred brand research capability", async () => {
    const { events } = await runWinbackReport(
      { channel: "@UrAvgConsumer" },
      new FixtureEvidenceGateway(process.cwd())
    );
    for (const event of events) {
      expect(event.tool?.name ?? "").not.toContain("brand_research");
      expect(event.reason).not.toContain("brand_research");
    }
  });
});

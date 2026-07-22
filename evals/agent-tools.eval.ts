import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentToolCall } from "@/src/agent/llm/agent-llm-port";
import { AuditRecorder } from "@/src/observability/audit";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import {
  AGENT_TOOL_CATALOG,
  isAgentToolName
} from "@/src/radar/application/agentic/agent-tools";
import { AgentEvidenceState } from "@/src/radar/application/agentic/evidence-state";
import { AgentToolBroker } from "@/src/radar/application/agentic/tool-broker";
import { EvidenceToolExecutor } from "@/src/radar/application/tools/tool-executor";
import { CreditBudget } from "@/src/radar/domain/credits";

interface ToolContract {
  tool: string;
  kind: "evidence" | "local";
  purpose: string;
  deliverable: {
    requiredFields: string[];
    forbiddenSubstrings: string[];
  };
  creditCost: string;
  failureEnvelopes: string[];
}

async function loadContracts(): Promise<ToolContract[]> {
  const manifest = JSON.parse(
    await readFile(
      path.join(process.cwd(), "tests/fixtures/agent/tool-contracts.json"),
      "utf8"
    )
  ) as { contracts: ToolContract[] };
  return manifest.contracts;
}

function fieldPresent(envelope: unknown, fieldPath: string): boolean {
  let current: unknown = envelope;
  for (const segment of fieldPath.split(".")) {
    if (current === null || typeof current !== "object") {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}

function toolCall(
  name: string,
  callArguments: Record<string, unknown> = {}
): AgentToolCall {
  return {
    id: `call_${name}`,
    name,
    arguments: callArguments,
    rawArguments: JSON.stringify(callArguments)
  };
}

describe("agent tool capability contracts", () => {
  it("documents every catalog tool with a deliverable contract, and nothing else", async () => {
    const contracts = await loadContracts();
    expect(new Set(contracts.map((contract) => contract.tool))).toEqual(
      new Set(Object.keys(AGENT_TOOL_CATALOG))
    );
    for (const contract of contracts) {
      if (!isAgentToolName(contract.tool)) {
        throw new Error(`Contract for unknown tool: ${contract.tool}`);
      }
      expect(contract.kind).toBe(AGENT_TOOL_CATALOG[contract.tool].kind);
      expect(contract.purpose.length).toBeGreaterThan(20);
      expect(contract.creditCost.length).toBeGreaterThan(4);
      expect(contract.deliverable.requiredFields.length).toBeGreaterThan(0);
    }
  });

  it("delivers each contract's required fields and never the forbidden ones on the fixture cohort", async () => {
    const contracts = await loadContracts();
    const port = new FixtureEvidenceGateway(process.cwd());
    const audit = new AuditRecorder({ phase: "workflow_fixture" });
    const broker = new AgentToolBroker({
      executor: new EvidenceToolExecutor({ port, audit, stage: "report" }),
      port,
      budget: new CreditBudget(160),
      audit,
      state: new AgentEvidenceState(),
      phase: "workflow_fixture",
      now: () => Date.parse("2026-07-22T00:00:00.000Z"),
      requestedChannel: "@UrAvgConsumer"
    });

    const journey: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: "resolve_target", args: { channel: "@UrAvgConsumer" } },
      { tool: "list_locked_peers", args: {} },
      { tool: "list_peer_sponsors", args: { peerRef: "peer_1" } },
      { tool: "list_peer_sponsors", args: { peerRef: "peer_2" } },
      { tool: "list_peer_sponsors", args: { peerRef: "peer_3" } },
      { tool: "list_target_sponsors", args: {} },
      { tool: "analyze_evidence", args: {} },
      { tool: "submit_report", args: { analysisRef: "analysis_1" } }
    ];
    const observedEnvelopes = new Map<string, string>();
    for (const step of journey) {
      const outcome = await broker.dispatch(toolCall(step.tool, step.args));
      expect(outcome.isError).toBe(false);
      observedEnvelopes.set(step.tool, outcome.content);
    }

    for (const contract of contracts) {
      const serialized = observedEnvelopes.get(contract.tool);
      expect(serialized, `${contract.tool} was never exercised`).toBeDefined();
      const envelope = JSON.parse(serialized!) as Record<string, unknown>;
      expect(envelope.ok).toBe(true);
      expect(fieldPresent(envelope, "credits.remainingCredits")).toBe(true);
      for (const field of contract.deliverable.requiredFields) {
        expect(
          fieldPresent(envelope, field),
          `${contract.tool} deliverable is missing ${field}`
        ).toBe(true);
      }
      for (const forbidden of contract.deliverable.forbiddenSubstrings) {
        expect(
          serialized!.includes(forbidden),
          `${contract.tool} leaked forbidden content ${forbidden}`
        ).toBe(false);
      }
    }
  });

  it("keeps the failure envelopes structured and within each contract's declared codes", async () => {
    const contracts = await loadContracts();
    const declaredCodes = new Map(
      contracts.map((contract) => [contract.tool, contract.failureEnvelopes])
    );
    const port = new FixtureEvidenceGateway(process.cwd());
    const audit = new AuditRecorder({ phase: "workflow_fixture" });
    const broker = new AgentToolBroker({
      executor: new EvidenceToolExecutor({ port, audit, stage: "report" }),
      port,
      budget: new CreditBudget(160),
      audit,
      state: new AgentEvidenceState(),
      phase: "workflow_fixture",
      now: Date.now,
      requestedChannel: "@UrAvgConsumer"
    });

    const failureProbes: Array<{
      tool: string;
      args: Record<string, unknown>;
      expectedCode: string;
    }> = [
      {
        tool: "resolve_target",
        args: { channel: "" },
        expectedCode: "invalid_arguments"
      },
      {
        tool: "list_locked_peers",
        args: {},
        expectedCode: "missing_prerequisite"
      },
      {
        tool: "list_target_sponsors",
        args: {},
        expectedCode: "missing_prerequisite"
      },
      {
        tool: "list_peer_sponsors",
        args: { peerRef: "peer_1" },
        expectedCode: "missing_prerequisite"
      },
      {
        tool: "analyze_evidence",
        args: {},
        expectedCode: "missing_prerequisite"
      },
      {
        tool: "submit_report",
        args: { analysisRef: "analysis_9" },
        expectedCode: "missing_prerequisite"
      }
    ];
    for (const probe of failureProbes) {
      const outcome = await broker.dispatch(toolCall(probe.tool, probe.args));
      expect(outcome.isError).toBe(true);
      const envelope = JSON.parse(outcome.content) as { code: string };
      expect(envelope.code).toBe(probe.expectedCode);
      expect(declaredCodes.get(probe.tool)).toContain(probe.expectedCode);
    }
  });
});

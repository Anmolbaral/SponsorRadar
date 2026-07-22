import { describe, expect, it } from "vitest";
import type { AgentToolCall } from "@/src/agent/llm/agent-llm-port";
import { AuditRecorder } from "@/src/observability/audit";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import type { SponsorRadarEvidencePort } from "@/src/radar/application/ports";
import { AgentEvidenceState } from "@/src/radar/application/agentic/evidence-state";
import {
  AgentToolBroker,
  type ToolDispatchOutcome
} from "@/src/radar/application/agentic/tool-broker";
import { EvidenceToolExecutor } from "@/src/radar/application/tools/tool-executor";
import { CreditBudget } from "@/src/radar/domain/credits";

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

function parseEnvelope(outcome: ToolDispatchOutcome): Record<string, unknown> {
  return JSON.parse(outcome.content) as Record<string, unknown>;
}

function fixtureBroker(maximumCredits = 160): {
  broker: AgentToolBroker;
  state: AgentEvidenceState;
  audit: AuditRecorder;
  budget: CreditBudget;
} {
  const port = new FixtureEvidenceGateway(process.cwd());
  const audit = new AuditRecorder({ phase: "workflow_fixture" });
  const state = new AgentEvidenceState();
  const budget = new CreditBudget(maximumCredits);
  const broker = new AgentToolBroker({
    executor: new EvidenceToolExecutor({ port, audit, stage: "report" }),
    port,
    budget,
    audit,
    state,
    phase: "workflow_fixture",
    now: () => Date.parse("2026-07-22T00:00:00.000Z")
  });
  return { broker, state, audit, budget };
}

describe("AgentToolBroker", () => {
  it("refuses unknown tools with the allowlist", async () => {
    const { broker } = fixtureBroker();
    const outcome = await broker.dispatch(toolCall("load_verification_ledger"));
    expect(outcome.isError).toBe(true);
    const envelope = parseEnvelope(outcome);
    expect(envelope.code).toBe("unknown_tool");
    expect(envelope.allowedTools).toContain("resolve_target");
    expect(envelope.allowedTools).not.toContain("load_verification_ledger");
  });

  it("refuses invalid arguments with bounded issues", async () => {
    const { broker } = fixtureBroker();
    const outcome = await broker.dispatch(
      toolCall("resolve_target", { channel: "", extra: "nope" })
    );
    expect(outcome.isError).toBe(true);
    const envelope = parseEnvelope(outcome);
    expect(envelope.code).toBe("invalid_arguments");
    expect((envelope.issues as string[]).length).toBeGreaterThan(0);
  });

  it("returns missing_prerequisite instead of crashing on out-of-order calls", async () => {
    const { broker } = fixtureBroker();
    const outcome = await broker.dispatch(toolCall("list_locked_peers"));
    expect(outcome.isError).toBe(true);
    expect(parseEnvelope(outcome).code).toBe("missing_prerequisite");
  });

  it("denies over-budget paid calls as information, records the policy decision, and keeps the run alive", async () => {
    const port: SponsorRadarEvidencePort = {
      mode: "live",
      estimateCredits: () => 115,
      estimateRunCredits: () => 156,
      resolveTarget: () => Promise.reject(new Error("must not be called")),
      listTargetSponsors: () =>
        Promise.reject(new Error("must not be called")),
      listLockedPeers: () => Promise.reject(new Error("must not be called")),
      listPeerSponsors: () => Promise.reject(new Error("must not be called")),
      loadVerificationLedger: () =>
        Promise.reject(new Error("must not be called"))
    };
    const audit = new AuditRecorder({ phase: "workflow_live", mode: "live" });
    const budget = new CreditBudget(10);
    const broker = new AgentToolBroker({
      executor: new EvidenceToolExecutor({ port, audit, stage: "report" }),
      port,
      budget,
      audit,
      state: new AgentEvidenceState(),
      phase: "workflow_live",
      now: Date.now
    });

    const outcome = await broker.dispatch(
      toolCall("resolve_target", { channel: "@Whatever" })
    );
    expect(outcome.isError).toBe(true);
    const envelope = parseEnvelope(outcome);
    expect(envelope.code).toBe("budget_exceeded");
    expect(envelope.shortfallCredits).toBe(105);
    expect(budget.snapshot().remainingCredits).toBe(10);

    const denial = audit
      .getEvents()
      .find(
        (event) =>
          event.eventType === "policy.decided" &&
          event.policy?.decision === "deny"
      );
    expect(denial).toBeDefined();
  });

  it("runs the full fixture journey to a terminal report through the six tools", async () => {
    const { broker, budget } = fixtureBroker();

    const resolved = await broker.dispatch(
      toolCall("resolve_target", { channel: "@UrAvgConsumer" })
    );
    expect(resolved.isError).toBe(false);
    const resolvedEnvelope = parseEnvelope(resolved) as {
      data: { windows: { staleCutoffExclusive: string } };
    };
    expect(resolvedEnvelope.data.windows.staleCutoffExclusive).toBeDefined();

    const peers = await broker.dispatch(toolCall("list_locked_peers"));
    expect(peers.isError).toBe(false);
    const peersEnvelope = parseEnvelope(peers) as {
      data: { peers: Array<{ peerRef: string }> };
    };
    expect(peersEnvelope.data.peers.length).toBeGreaterThan(0);

    for (const peer of peersEnvelope.data.peers) {
      const sponsors = await broker.dispatch(
        toolCall("list_peer_sponsors", { peerRef: peer.peerRef })
      );
      expect(sponsors.isError).toBe(false);
    }

    const targetSponsors = await broker.dispatch(
      toolCall("list_target_sponsors")
    );
    expect(targetSponsors.isError).toBe(false);

    const analysis = await broker.dispatch(toolCall("analyze_evidence"));
    expect(analysis.isError).toBe(false);
    const analysisEnvelope = parseEnvelope(analysis) as {
      data: { analysisRef: string; leadCount: number };
    };
    expect(analysisEnvelope.data.analysisRef).toBe("analysis_1");

    const submitted = await broker.dispatch(
      toolCall("submit_report", {
        analysisRef: analysisEnvelope.data.analysisRef
      })
    );
    expect(submitted.isError).toBe(false);
    expect(submitted.terminal).toBeDefined();
    const report = submitted.terminal!.report;
    expect(report.schemaVersion).toBe(1);
    expect(report.methodology.qualificationPolicy).toBe(
      "same_brand_reactivation"
    );
    expect(report.funnel.targetApiRows).toBeGreaterThan(0);
    expect(budget.snapshot().resultBasedCredits).toBe(0);
  });

  it("rejects submit_report with an unknown analysisRef", async () => {
    const { broker } = fixtureBroker();
    await broker.dispatch(toolCall("resolve_target", { channel: "@UrAvgConsumer" }));
    const outcome = await broker.dispatch(
      toolCall("submit_report", { analysisRef: "analysis_99" })
    );
    expect(outcome.isError).toBe(true);
    expect(parseEnvelope(outcome).code).toBe("missing_prerequisite");
  });
});

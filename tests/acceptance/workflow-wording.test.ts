import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureLlmPort } from "@/src/agent/llm/fixture-llm-port";
import type {
  LlmPort,
  LlmProviderRequest,
  LlmProviderResponse
} from "@/src/agent/llm/llm-port";
import { BoundedWordingAgent } from "@/src/agent/orchestrator/wording-agent";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import {
  FileSystemWorkflowRepository,
  type JsonValue
} from "@/src/radar/adapters/persistence";
import type {
  EvidenceCacheStatus,
  EvidenceMode,
  EvidenceOperation,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import { WorkflowService } from "@/src/radar/application/run-workflow";
import { transitionRun } from "@/src/radar/domain/run-state";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Wording-augmented workflow", () => {
  it("falls back without mutating canonical leads when generated wording is invalid", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const llm = new InvalidReportLlmPort();
    let lockedPeerCalls = 0;
    const service = new WorkflowService({
      repository,
      mode: "fixture",
      wordingAgent: new BoundedWordingAgent(process.cwd(), llm),
      gatewayFactory: () =>
        new CountingFixtureGateway(() => {
          lockedPeerCalls += 1;
        })
    });

    const created = await service.createRun(
      "@UrAvgConsumer",
      "wordingAgent-invalid-report"
    );
    const proposed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "wordingAgent-approve-plan"
    });
    const completed = await service.approveExecution(proposed.runId, {
      expectedVersion: proposed.version,
      proposalId: proposed.peerProposal!.proposalId,
      quoteId: proposed.peerProposal!.quote.quoteId,
      approvedCreditCeiling: 0,
      idempotencyKey: "wordingAgent-approve-execution"
    });

    expect(proposed.peerProposal?.wordingAgent?.status).toBe("generated");
    expect(proposed.peerProposal?.cohortHash).toMatch(/^[a-f0-9]{64}$/);
    expect(completed.status).toBe("completed");
    expect(completed.report?.wordingAgent).toMatchObject({
      status: "fallback",
      fallbackReason: "LlmGroundingError",
      narratives: []
    });
    expect(completed.report?.leads).toHaveLength(1);
    expect(completed.report?.leads[0]).toMatchObject({
      brand: "Dell",
      domain: "dell.com",
      peer: "Dave2D",
      continuity: "A"
    });
    expect(completed.report?.leads[0].outreachHypothesis).toContain(
      "worth researching for outreach"
    );
    expect(completed.report?.audit.llmCalls).toBe(2);
    expect(
      completed.auditEvents.filter(
        (event) => event.eventType === "llm.failed"
      )
    ).toHaveLength(1);
    expect(llm.calls).toBe(2);
    expect(llm.requests).toHaveLength(2);
    const serializedSchemas = llm.requests.map((request) =>
      JSON.stringify(request.outputSchema)
    );
    expect(serializedSchemas[0]).toMatch(
      /"enum":\["peer_[a-f0-9]{20}"\]/
    );
    expect(serializedSchemas[1]).toMatch(
      /"enum":\["lead_[a-f0-9]{20}"\]/
    );
    expect(serializedSchemas.join("\n")).not.toMatch(
      /UrAvgConsumer|Dave2D|Dell|dell\.com|https?:\/\//
    );
    expect(lockedPeerCalls).toBe(1);
  });

  it("blocks a schema-v3 resolved cohort before any wording-agent or evidence call", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const llm = new InvalidReportLlmPort();
    let lockedPeerCalls = 0;
    const service = new WorkflowService({
      repository,
      mode: "fixture",
      wordingAgent: new BoundedWordingAgent(process.cwd(), llm),
      gatewayFactory: () =>
        new CountingFixtureGateway(() => {
          lockedPeerCalls += 1;
        })
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "wordingAgent-legacy-resolved"
    );
    const fixture = new FixtureEvidenceGateway(process.cwd());
    const resolved = await fixture.resolveTarget("@UrAvgConsumer");
    const peers = await fixture.listLockedPeers(
      resolved.target.url,
      resolved.target.subscriberCount
    );
    const snapshot = await repository.readRunSnapshot(created.runId);
    if (!snapshot) throw new Error("Expected a persisted run");
    const legacyValue = structuredClone(snapshot.value) as {
      [key: string]: JsonValue;
    };
    let state = created.state;
    state = transitionRun(state, {
      to: "plan_approved",
      occurredAt: state.updatedAt,
      actor: "user",
      reason: "Legacy plan approval"
    });
    state = transitionRun(state, {
      to: "resolving",
      occurredAt: state.updatedAt,
      actor: "application",
      reason: "Legacy resolution claim"
    });
    state = transitionRun(state, {
      to: "resolved",
      occurredAt: state.updatedAt,
      actor: "application",
      reason: "Legacy resolved cohort"
    });
    legacyValue.schemaVersion = 3;
    legacyValue.state = structuredClone(state) as unknown as JsonValue;
    legacyValue.resolvedCohort = {
      target: resolved.target,
      peers
    } as unknown as JsonValue;
    const stored = await repository.saveRunSnapshot({
      runId: created.runId,
      valueSchemaVersion: 3,
      value: legacyValue,
      expectedRevision: snapshot.revision
    });

    const failed = await service.resumeRun(created.runId, {
      expectedVersion: stored.revision,
      idempotencyKey: "resume-wordingAgent-legacy-resolved"
    });

    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("target_not_verified");
    expect(llm.calls).toBe(0);
    expect(lockedPeerCalls).toBe(0);
    expect(failed.auditEvents).toEqual([]);
  });

  it("blocks a migrated verifying checkpoint before another wording-agent call", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const llm = new InvalidReportLlmPort();
    let lockedPeerCalls = 0;
    const service = new WorkflowService({
      repository,
      mode: "fixture",
      wordingAgent: new BoundedWordingAgent(process.cwd(), llm),
      gatewayFactory: () =>
        new CountingFixtureGateway(() => {
          lockedPeerCalls += 1;
        })
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "wordingAgent-legacy-verifying"
    );
    const proposed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "wordingAgent-legacy-verifying-plan"
    });
    await service.approveExecution(created.runId, {
      expectedVersion: proposed.version,
      proposalId: proposed.peerProposal!.proposalId,
      quoteId: proposed.peerProposal!.quote.quoteId,
      approvedCreditCeiling: 0,
      idempotencyKey: "wordingAgent-legacy-verifying-execution"
    });
    const snapshot = await repository.readRunSnapshot(created.runId);
    if (!snapshot) throw new Error("Expected a persisted run");
    const legacyValue = structuredClone(snapshot.value) as {
      [key: string]: JsonValue;
    };
    legacyValue.schemaVersion = 3;
    for (const key of ["resolvedCohort", "peerProposal"] as const) {
      const container = legacyValue[key];
      if (
        container === null ||
        Array.isArray(container) ||
        typeof container !== "object"
      ) {
        throw new Error(`Expected persisted ${key}`);
      }
      delete container.identity;
    }
    const report = legacyValue.report;
    const state = legacyValue.state;
    const wordingAgent = legacyValue.wordingAgent;
    if (
      report === null ||
      Array.isArray(report) ||
      typeof report !== "object" ||
      state === null ||
      Array.isArray(state) ||
      typeof state !== "object" ||
      wordingAgent === null ||
      Array.isArray(wordingAgent) ||
      typeof wordingAgent !== "object" ||
      !Array.isArray(state.history)
    ) {
      throw new Error("Expected persisted report, state, and wording data");
    }
    delete report.targetIdentity;
    state.history.pop();
    const latest = state.history.at(-1);
    if (
      latest === null ||
      latest === undefined ||
      Array.isArray(latest) ||
      typeof latest !== "object" ||
      typeof latest.sequence !== "number" ||
      typeof latest.occurredAt !== "string"
    ) {
      throw new Error("Expected a verifying transition");
    }
    state.state = "verifying";
    state.version = latest.sequence;
    state.updatedAt = latest.occurredAt;
    wordingAgent.reportWording = {
      status: "not_started",
      inputFingerprint: null
    };
    const stored = await repository.saveRunSnapshot({
      runId: created.runId,
      valueSchemaVersion: 3,
      value: legacyValue,
      expectedRevision: snapshot.revision
    });
    const llmCallsBeforeResume = llm.calls;
    const peerCallsBeforeResume = lockedPeerCalls;

    const failed = await service.resumeRun(created.runId, {
      expectedVersion: stored.revision,
      idempotencyKey: "resume-wordingAgent-legacy-verifying"
    });

    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("target_not_verified");
    expect(llm.calls).toBe(llmCallsBeforeResume);
    expect(lockedPeerCalls).toBe(peerCallsBeforeResume);
  });
});

class InvalidReportLlmPort implements LlmPort {
  readonly provider = "malicious-fixture";
  readonly model = "malicious-fixture-v1";
  private readonly validFixture = new FixtureLlmPort();
  calls = 0;
  readonly requests: LlmProviderRequest[] = [];

  async generateStructured(
    request: LlmProviderRequest
  ): Promise<LlmProviderResponse> {
    this.calls += 1;
    this.requests.push(structuredClone(request));
    if (request.purpose === "peer_rationale") {
      const response =
        await this.validFixture.generateStructured(request);
      return { ...response, providerRequestId: "peer-valid" };
    }
    return {
      output: {
        narratives: [
          {
            leadId: "lead_invented",
            sentences: [
              {
                text:
                  "The same buyer has a large budget and an active campaign.",
                claimIds: ["lead_invented_budget"],
                evidenceIds: ["lead_invented:peer"]
              }
            ]
          }
        ]
      },
      providerRequestId: "report-invalid",
      inputTokens: 20,
      outputTokens: 20,
      finishReason: "completed",
      refusal: null,
      toolCalls: 0
    };
  }
}

class CountingFixtureGateway implements SponsorRadarEvidencePort {
  readonly mode: EvidenceMode = "fixture";
  private readonly fixture = new FixtureEvidenceGateway(process.cwd());

  constructor(private readonly onLockedPeers: () => void) {}

  estimateCredits(operation: EvidenceOperation): number {
    void operation;
    return this.fixture.estimateCredits();
  }

  estimateRunCredits(): number {
    return this.fixture.estimateRunCredits();
  }

  async prepareRun(input: string): Promise<void> {
    void input;
  }

  async inspectCache(): Promise<EvidenceCacheStatus> {
    return "not_applicable";
  }

  async resolveTarget(input: string) {
    return this.fixture.resolveTarget(input);
  }

  async listTargetSponsors(targetUrl: string) {
    return this.fixture.listTargetSponsors(targetUrl);
  }

  async listLockedPeers(targetUrl: string) {
    this.onLockedPeers();
    return this.fixture.listLockedPeers(targetUrl);
  }

  async listPeerSponsors(peerUrl: string) {
    return this.fixture.listPeerSponsors(peerUrl);
  }

  async loadVerificationLedger() {
    return this.fixture.loadVerificationLedger();
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "sponsor-radar-wordingAgent-")
  );
  temporaryDirectories.push(directory);
  return directory;
}

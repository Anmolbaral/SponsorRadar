import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureLlmPort } from "@/src/agent/llm/fixture-llm-port";
import type { LlmProviderRequest } from "@/src/agent/llm/llm-port";
import { BoundedWordingAgent } from "@/src/agent/orchestrator/wording-agent";
import type { AuditRecorder } from "@/src/observability/audit";
import { CachedEvidenceGateway } from "@/src/radar/adapters/cache/cached-evidence-gateway";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import {
  FileSystemWorkflowRepository,
  PersistenceCorruptionError,
  type JsonValue,
  type SaveRunSnapshotInput,
  type WorkflowPersistenceRepository
} from "@/src/radar/adapters/persistence";
import type {
  EvidenceMode,
  EvidenceOperation,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import {
  WorkflowService,
  RunAccountingMigrationRequiredError,
  RunCreditLimitExceededError,
  WorkflowConflictError
} from "@/src/radar/application/run-workflow";
import { approvedCohortHash } from "@/src/radar/application/run-winback-report";
import { transitionRun } from "@/src/radar/domain/run-state";
import {
  parseYouTubeIdentity,
  YouTubeTargetVerificationError,
  type YouTubeTargetVerificationCode
} from "@/src/radar/domain/youtube";

const temporaryDirectories: string[] = [];
const fixedNow = Date.parse("2026-07-19T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Controlled workflow", () => {
  it("preserves the legacy cohort hash and binds channel ID into v2 hashes", () => {
    const target = {
      name: "Target",
      url: "https://www.youtube.com/@Target",
      subscriberCount: 1_000
    };
    const peers = [
      {
        name: "Peer",
        url: "https://www.youtube.com/@Peer",
        subscriberCount: 900,
        creatorId: "peer-1"
      }
    ];
    const firstIdentity = {
      verificationBasis: "channel_id" as const,
      channelId: "UCTargetA123",
      handle: "Target",
      canonicalUrl: target.url,
      key: "channel:UCTargetA123"
    };
    const secondIdentity = {
      ...firstIdentity,
      channelId: "UCTargetB456",
      key: "channel:UCTargetB456"
    };

    expect(approvedCohortHash(target, peers)).toBe(
      "e33c3e555b5405726477f5603514e94bc8df0c4bc78988ebcc5e753019ae54f6"
    );
    expect(
      approvedCohortHash(target, peers, firstIdentity)
    ).not.toBe(approvedCohortHash(target, peers, secondIdentity));
  });

  it("persists plan and peer approvals before one idempotent execution", async () => {
    const harness = await workflowHarness();
    const created = await harness.service.createRun(
      "@UrAvgConsumer",
      "create-run-one"
    );

    expect(created.status).toBe("awaiting_plan_approval");
    expect(created.state.state).toBe("planned");
    expect(created.plan.totalCreditCeiling).toBe(0);
    expect(created.availableActions).toEqual(["approve_plan", "cancel"]);
    expect(harness.calls.total()).toBe(0);

    const proposed = await harness.service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "approve-plan-one"
    });

    expect(proposed.status).toBe("awaiting_execution_approval");
    expect(proposed.state.state).toBe("peers_proposed");
    expect(proposed.peerProposal?.peers).toHaveLength(3);
    expect(proposed.peerProposal?.quote.creditCeiling).toBe(0);
    expect(proposed.schemaVersion).toBe(4);
    expect(proposed.resolvedCohort?.identity).not.toBeNull();
    expect(proposed.peerProposal?.identity).toEqual(
      proposed.resolvedCohort?.identity
    );
    expect(harness.calls.total()).toBe(2);

    const completed = await harness.service.approveExecution(proposed.runId, {
      expectedVersion: proposed.version,
      proposalId: proposed.peerProposal!.proposalId,
      quoteId: proposed.peerProposal!.quote.quoteId,
      approvedCreditCeiling: 0,
      idempotencyKey: "approve-execution-one"
    });

    expect(completed.status).toBe("completed");
    expect(completed.outcome).toBe("opportunities_found");
    expect(completed.state.state).toBe("completed");
    expect(completed.report?.leads.map((lead) => lead.brand)).toEqual(["Dell"]);
    expect(completed.report?.phase).toBe("workflow_fixture");
    expect(completed.report?.targetIdentity).toEqual(
      proposed.peerProposal?.identity
    );
    expect(completed.approvals.plan).not.toBeNull();
    expect(completed.approvals.execution).not.toBeNull();
    expect(completed.workflowEvents.map(({ event }) => event.state)).toEqual([
      "planned",
      "plan_approved",
      "resolving",
      "resolved",
      "peers_proposed",
      "peers_approved",
      "credit_approved",
      "executing",
      "verifying",
      "completed"
    ]);
    expect(harness.calls.total()).toBe(7);

    const replay = await harness.service.approveExecution(proposed.runId, {
      expectedVersion: proposed.version,
      proposalId: proposed.peerProposal!.proposalId,
      quoteId: proposed.peerProposal!.quote.quoteId,
      approvedCreditCeiling: 0,
      idempotencyKey: "approve-execution-one"
    });
    expect(replay.version).toBe(completed.version);
    expect(replay.report).toEqual(completed.report);
    expect(harness.calls.total()).toBe(7);
  });

  it("cancels before approval with zero evidence calls and zero credits", async () => {
    const harness = await workflowHarness();
    const created = await harness.service.createRun(
      "@UrAvgConsumer",
      "create-cancelled-run"
    );
    const cancelled = await harness.service.cancelRun(created.runId, {
      expectedVersion: created.version,
      idempotencyKey: "cancel-before-approval"
    });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.outcome).toBeNull();
    expect(cancelled.state.state).toBe("cancelled");
    expect(cancelled.auditEvents).toEqual([]);
    expect(cancelled.quota).toMatchObject({
      resolutionCreditsUsed: 0,
      executionCreditsUsed: 0
    });
    expect(harness.calls.total()).toBe(0);
  });

  it("does not record ghost approvals for no-op or rejected cancel/resume actions", async () => {
    const directory = await temporaryDirectory();
    const calls = callCounter();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const service = new WorkflowService({
      repository,
      mode: "fixture",
      clock: () => fixedNow,
      gatewayFactory: () =>
        new CachedEvidenceGateway(
          new CountingFixtureGateway(process.cwd(), calls, false),
          repository
        )
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "ghost-approval-run"
    );

    // A no-op resume of a still-planned run must not persist an approval.
    const resumed = await service.resumeRun(created.runId, {
      expectedVersion: created.version,
      idempotencyKey: "resume-noop-planned"
    });
    expect(resumed.status).toBe("awaiting_plan_approval");
    expect(await repository.listApprovals(created.runId)).toHaveLength(0);

    // The legal cancel records exactly one approval.
    const cancelled = await service.cancelRun(created.runId, {
      expectedVersion: resumed.version,
      idempotencyKey: "cancel-legal"
    });
    expect(cancelled.status).toBe("cancelled");
    expect(await repository.listApprovals(created.runId)).toHaveLength(1);

    // A second cancel with a fresh key is a terminal no-op and must not add
    // another approval.
    const cancelledAgain = await service.cancelRun(created.runId, {
      expectedVersion: cancelled.version,
      idempotencyKey: "cancel-noop-second"
    });
    expect(cancelledAgain.status).toBe("cancelled");
    expect(await repository.listApprovals(created.runId)).toHaveLength(1);
  });

  it("completes cleanly with no eligible peers and never enters sponsor execution", async () => {
    const directory = await temporaryDirectory();
    const calls = callCounter();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const service = new WorkflowService({
      repository,
      mode: "fixture",
      clock: () => fixedNow,
      gatewayFactory: () =>
        new CachedEvidenceGateway(
          new NoEligiblePeersGateway(
            process.cwd(),
            calls,
            false
          ),
          repository
        )
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "no-eligible-peers-run"
    );
    const completed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "approve-no-eligible-peers"
    });

    expect(completed.status).toBe("completed");
    expect(completed.state.state).toBe("no_eligible_peers");
    expect(completed.outcome).toBe("no_eligible_peers");
    expect(completed.resolvedCohort?.peers).toEqual([]);
    expect(completed.peerProposal).toBeNull();
    expect(completed.report).toBeNull();
    expect(completed.approvals.plan).not.toBeNull();
    expect(completed.approvals.execution).toBeNull();
    expect(completed.availableActions).toEqual([]);
    expect(completed.workflowEvents.map(({ event }) => event.state)).toEqual([
      "planned",
      "plan_approved",
      "resolving",
      "no_eligible_peers"
    ]);
    expect(calls.values).toMatchObject({
      resolve_target: 1,
      list_locked_peers: 1,
      list_target_sponsors: 0,
      list_peer_sponsors: 0,
      load_verification_ledger: 0
    });
  });

  it("quotes only the exact sponsor work for a one-peer discovered cohort", async () => {
    const directory = await temporaryDirectory();
    const calls = callCounter();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const service = new WorkflowService({
      repository,
      mode: "live",
      clock: () => fixedNow,
      gatewayFactory: () =>
        new CachedEvidenceGateway(
          new OnePeerLiveGateway(process.cwd(), calls),
          repository
        )
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "one-peer-exact-quote"
    );
    const proposed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "approve-one-peer-plan"
    });

    expect(proposed.peerProposal?.peers).toHaveLength(1);
    expect(proposed.peerProposal?.quote.creditCeiling).toBe(126);
    expect(proposed.outcome).toBeNull();
    expect(calls.values.list_target_sponsors).toBe(0);
    expect(calls.values.list_peer_sponsors).toBe(0);
  });

  it.each([
    { estimate: 160, accepted: true },
    { estimate: 161, accepted: false }
  ])(
    "enforces the persisted 160-credit run boundary for a $estimate-credit plan",
    async ({ estimate, accepted }) => {
      const directory = await temporaryDirectory();
      const repository = new FileSystemWorkflowRepository({
        directory,
        clock: () => fixedNow
      });
      const calls = callCounter();
      const service = new WorkflowService({
        repository,
        mode: "live",
        clock: () => fixedNow,
        runCreditLimit: 160,
        gatewayFactory: () =>
          new CeilingOnlyLiveGateway(
            process.cwd(),
            calls,
            estimate
          )
      });
      const idempotencyKey = `run-boundary-${estimate}`;

      if (accepted) {
        const created = await service.createRun(
          "@UrAvgConsumer",
          idempotencyKey
        );
        expect(created.plan.totalCreditCeiling).toBe(160);
        expect(created.accounting).toEqual({
          policy: "per_run_v1",
          maximumCredits: 160
        });
        expect(calls.total()).toBe(0);
        expect(
          await repository.readQuota(runCreditLedgerKey(created.runId))
        ).toBeNull();
        return;
      }

      await expect(
        service.createRun("@UrAvgConsumer", idempotencyKey)
      ).rejects.toBeInstanceOf(RunCreditLimitExceededError);
      const runId = testRunId(idempotencyKey);
      expect(await repository.readRunSnapshot(runId)).toBeNull();
      expect(
        await repository.readQuota(runCreditLedgerKey(runId))
      ).toBeNull();
      expect(calls.total()).toBe(0);
    }
  );

  it("admits repeated cold live runs independently of exhausted lifetime history", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const legacy = await repository.reserveQuota({
      quotaKey: "upriver-shared-credits",
      runId: "historical-live-run",
      idempotencyKey: "historical-live-reservation",
      requestedUnits: 200,
      maximumUnits: 200
    });
    await repository.finalizeQuotaReservation({
      quotaKey: "upriver-shared-credits",
      reservationId: legacy.value.reservationId,
      idempotencyKey: "historical-live-settlement",
      outcome: "settled",
      actualUnits: 200
    });
    const legacyBefore = await repository.readQuota(
      "upriver-shared-credits"
    );
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      mode: "live",
      clock: () => fixedNow,
      runCreditLimit: 160,
      gatewayFactory: ({ maximumCredits }) =>
        new StageBoundedLiveGateway(
          process.cwd(),
          calls,
          maximumCredits ?? 160
        )
    });
    const completedRuns: Array<{
      runId: string;
      settledCredits: number;
    }> = [];

    for (const suffix of ["one", "two"]) {
      const created = await service.createRun(
        "@UrAvgConsumer",
        `independent-live-create-${suffix}`
      );
      expect(created.plan.totalCreditCeiling).toBe(156);
      const proposed = await service.approvePlan(created.runId, {
        expectedVersion: created.version,
        planId: created.plan.planId,
        idempotencyKey: `independent-live-plan-${suffix}`
      });
      const completed = await service.approveExecution(created.runId, {
        expectedVersion: proposed.version,
        proposalId: proposed.peerProposal!.proposalId,
        quoteId: proposed.peerProposal!.quote.quoteId,
        approvedCreditCeiling:
          proposed.peerProposal!.quote.creditCeiling,
        idempotencyKey: `independent-live-execution-${suffix}`
      });
      expect(completed.status).toBe("completed");
      completedRuns.push({
        runId: completed.runId,
        settledCredits:
          completed.quota.resolutionCreditsUsed +
          completed.quota.executionCreditsUsed
      });
    }

    expect(
      await repository.readQuota("upriver-shared-credits")
    ).toEqual(legacyBefore);
    for (const { runId, settledCredits } of completedRuns) {
      expect(
        await repository.readQuota(runCreditLedgerKey(runId))
      ).toMatchObject({
        maximumUnits: 160,
        activeUnits: 0,
        consumedUnits: settledCredits,
        reservations: [
          expect.objectContaining({
            requestedUnits: 11,
            status: "settled"
          }),
          expect.objectContaining({
            requestedUnits: 145,
            status: "settled"
          })
        ]
      });
    }
    expect(calls.values.resolve_target).toBe(4);
    expect(calls.values.list_target_sponsors).toBe(2);
  });

  it("atomically refuses execution that would push one run above 160 credits", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      mode: "live",
      clock: () => fixedNow,
      runCreditLimit: 160,
      gatewayFactory: ({ maximumCredits }) =>
        new StageBoundedLiveGateway(
          process.cwd(),
          calls,
          maximumCredits ?? 160
        )
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "single-run-overage-create"
    );
    const externalClaim = await repository.reserveQuota({
      quotaKey: runCreditLedgerKey(created.runId),
      runId: created.runId,
      idempotencyKey: "recorded-prior-run-spend",
      requestedUnits: 5,
      maximumUnits: 160
    });
    await repository.finalizeQuotaReservation({
      quotaKey: runCreditLedgerKey(created.runId),
      reservationId: externalClaim.value.reservationId,
      idempotencyKey: "settle-recorded-prior-run-spend",
      outcome: "settled",
      actualUnits: 5
    });
    const proposed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "single-run-overage-plan"
    });

    await expect(
      service.approveExecution(created.runId, {
        expectedVersion: proposed.version,
        proposalId: proposed.peerProposal!.proposalId,
        quoteId: proposed.peerProposal!.quote.quoteId,
        approvedCreditCeiling:
          proposed.peerProposal!.quote.creditCeiling,
        idempotencyKey: "single-run-overage-execution"
      })
    ).rejects.toBeInstanceOf(RunCreditLimitExceededError);

    expect(calls.values.list_target_sponsors).toBe(0);
    expect(calls.values.list_peer_sponsors).toBe(0);
    expect(
      await repository.readQuota(runCreditLedgerKey(created.runId))
    ).toMatchObject({
      maximumUnits: 160,
      activeUnits: 0,
      consumedUnits: 16,
      reservedUnits: 16
    });
  });

  it("uses the persisted 160-credit policy after a restart with a lower new-run limit", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const calls = callCounter();
    const gatewayFactory = ({ maximumCredits }: {
      maximumCredits?: number;
    }) =>
      new StageBoundedLiveGateway(
        process.cwd(),
        calls,
        maximumCredits ?? 160
      );
    const firstService = new WorkflowService({
      repository,
      mode: "live",
      clock: () => fixedNow,
      runCreditLimit: 160,
      gatewayFactory
    });
    const created = await firstService.createRun(
      "@UrAvgConsumer",
      "persisted-run-limit-create"
    );

    const restartedService = new WorkflowService({
      repository,
      mode: "live",
      clock: () => fixedNow,
      runCreditLimit: 100,
      gatewayFactory
    });
    const restored = await restartedService.getRun(created.runId);
    expect(restored.accounting.maximumCredits).toBe(160);
    const proposed = await restartedService.approvePlan(created.runId, {
      expectedVersion: restored.version,
      planId: restored.plan.planId,
      idempotencyKey: "persisted-run-limit-plan"
    });
    const completed = await restartedService.approveExecution(
      created.runId,
      {
        expectedVersion: proposed.version,
        proposalId: proposed.peerProposal!.proposalId,
        quoteId: proposed.peerProposal!.quote.quoteId,
        approvedCreditCeiling:
          proposed.peerProposal!.quote.creditCeiling,
        idempotencyKey: "persisted-run-limit-execution"
      }
    );

    expect(completed.status).toBe("completed");
    expect(
      await repository.readQuota(runCreditLedgerKey(created.runId))
    ).toMatchObject({
      maximumUnits: 160,
      activeUnits: 0
    });
  });

  it("loads schema-v2 runs as legacy and blocks new claims before provider work", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      clock: () => fixedNow,
      gatewayFactory: () =>
        new CountingFixtureGateway(process.cwd(), calls, false)
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "legacy-schema-two-create"
    );
    const snapshot = await repository.readRunSnapshot(created.runId);
    if (!snapshot) throw new Error("Expected a persisted run");
    const legacyValue = structuredClone(snapshot.value) as {
      [key: string]: JsonValue;
    };
    legacyValue.schemaVersion = 2;
    delete legacyValue.accounting;
    await repository.saveRunSnapshot({
      runId: created.runId,
      valueSchemaVersion: 2,
      value: legacyValue,
      expectedRevision: snapshot.revision
    });

    const restored = await service.getRun(created.runId);
    expect(restored.accounting).toEqual({
      policy: "legacy_shared_v1",
      maximumCredits: 0
    });
    await expect(
      service.approvePlan(created.runId, {
        expectedVersion: restored.version,
        planId: restored.plan.planId,
        idempotencyKey: "legacy-schema-two-plan"
      })
    ).rejects.toBeInstanceOf(
      RunAccountingMigrationRequiredError
    );
    expect(calls.total()).toBe(0);
    expect(await repository.listApprovals(created.runId)).toEqual([]);
    expect(
      await repository.readQuota(runCreditLedgerKey(created.runId))
    ).toBeNull();
    expect(
      await repository.readQuota("upriver-shared-credits")
    ).toBeNull();
  });

  it("restores a schema-4 run that persisted the wording block under the historical phase4 key", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      clock: () => fixedNow,
      gatewayFactory: () =>
        new CountingFixtureGateway(process.cwd(), calls, false)
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "phase4-legacy-shape"
    );

    // Rewrite the current schema-4 snapshot into the pre-rename shape: the
    // structurally identical wording block stored under a top-level `phase4`.
    const snapshot = await repository.readRunSnapshot(created.runId);
    if (!snapshot) throw new Error("Expected a persisted run");
    const legacyValue = structuredClone(snapshot.value) as {
      [key: string]: JsonValue;
    };
    const wordingBlock = legacyValue.wordingAgent;
    delete legacyValue.wordingAgent;
    legacyValue.phase4 = wordingBlock;
    await repository.saveRunSnapshot({
      runId: created.runId,
      valueSchemaVersion: 4,
      value: legacyValue,
      expectedRevision: snapshot.revision
    });

    const restored = await service.getRun(created.runId);
    expect(restored.schemaVersion).toBe(4);
    expect(restored.status).toBe("awaiting_plan_approval");
    expect(restored.wordingAgent).toEqual(wordingBlock);
    expect(
      (restored as unknown as { phase4?: unknown }).phase4
    ).toBeUndefined();
  });

  it("migrates a schema-v3 proposal without inventing identity and blocks execution before approval or research", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      clock: () => fixedNow,
      gatewayFactory: () =>
        new CountingFixtureGateway(process.cwd(), calls, false)
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "schema-three-proposal-create"
    );
    const proposed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "schema-three-proposal-plan"
    });
    const snapshot = await repository.readRunSnapshot(created.runId);
    if (!snapshot) throw new Error("Expected a persisted run");
    const legacyValue = structuredClone(snapshot.value) as {
      [key: string]: JsonValue;
    };
    const resolvedCohort = legacyValue.resolvedCohort;
    const peerProposal = legacyValue.peerProposal;
    if (
      resolvedCohort === null ||
      Array.isArray(resolvedCohort) ||
      typeof resolvedCohort !== "object" ||
      peerProposal === null ||
      Array.isArray(peerProposal) ||
      typeof peerProposal !== "object"
    ) {
      throw new Error("Expected a persisted resolved proposal");
    }
    const proposalPeers = proposed.peerProposal!.peers.map((peer) => ({
      name: peer.name,
      url: peer.url,
      subscriberCount: peer.subscriberCount,
      creatorId: peer.creatorId
    }));
    legacyValue.schemaVersion = 3;
    delete resolvedCohort.identity;
    delete peerProposal.identity;
    peerProposal.cohortHash = approvedCohortHash(
      proposed.peerProposal!.target,
      proposalPeers
    );
    await repository.saveRunSnapshot({
      runId: created.runId,
      valueSchemaVersion: 3,
      value: legacyValue,
      expectedRevision: snapshot.revision
    });

    const restored = await service.getRun(created.runId);
    expect(restored.schemaVersion).toBe(4);
    expect(restored.accounting).toEqual({
      policy: "per_run_v1",
      maximumCredits: 160
    });
    expect(restored.resolvedCohort?.identity).toBeNull();
    expect(restored.peerProposal?.identity).toBeNull();
    const approvalsBefore = await repository.listApprovals(created.runId);
    const callsBefore = calls.total();

    const failed = await service.approveExecution(created.runId, {
      expectedVersion: restored.version,
      proposalId: restored.peerProposal!.proposalId,
      quoteId: restored.peerProposal!.quote.quoteId,
      approvedCreditCeiling:
        restored.peerProposal!.quote.creditCeiling,
      idempotencyKey: "schema-three-proposal-execution"
    });

    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({
      code: "target_not_verified",
      message:
        "This saved search predates verified channel identity. Start a new search.",
      retryable: false
    });
    expect(calls.total()).toBe(callsBefore);
    expect(await repository.listApprovals(created.runId)).toEqual(
      approvalsBefore
    );
    expect(
      (await repository.readQuota(runCreditLedgerKey(created.runId)))
        ?.reservations
    ).toHaveLength(1);
  });

  it.each([
    {
      checkpoint: "peers_approved",
      expectedCredits: 0,
      expectedError: "target_not_verified"
    },
    {
      checkpoint: "credit_approved",
      expectedCredits: 0,
      expectedError: "target_not_verified"
    },
    {
      checkpoint: "executing",
      expectedCredits: 145,
      expectedError: "ambiguous_live_execution"
    }
  ] as const)(
    "migrates a schema-v3 $checkpoint claim without replaying paid or LLM work",
    async ({ checkpoint, expectedCredits, expectedError }) => {
      const directory = await temporaryDirectory();
      let now = fixedNow;
      const repository = new FileSystemWorkflowRepository({
        directory,
        clock: () => now
      });
      const calls = callCounter();
      const llm = new CountingFixtureLlmPort();
      const service = new WorkflowService({
        repository,
        mode: "live",
        clock: () => now,
        operationLeaseMs: 1,
        wordingAgent: new BoundedWordingAgent(process.cwd(), llm),
        gatewayFactory: ({ maximumCredits }) =>
          new StageBoundedLiveGateway(
            process.cwd(),
            calls,
            maximumCredits ?? 160
          )
      });
      const created = await service.createRun(
        "@UrAvgConsumer",
        `schema-three-${checkpoint}-create`
      );
      const proposed = await service.approvePlan(created.runId, {
        expectedVersion: created.version,
        planId: created.plan.planId,
        idempotencyKey: `schema-three-${checkpoint}-plan`
      });
      expect(proposed.state.state).toBe("peers_proposed");
      expect(proposed.peerProposal?.quote.creditCeiling).toBe(145);
      expect(llm.calls).toBe(1);

      const executionApproval = await repository.recordApproval({
        runId: created.runId,
        idempotencyKey: `schema-three-${checkpoint}-persisted-approval`,
        action: "approve_execution",
        decision: "approved",
        decidedBy: "local-user",
        details: {
          proposalId: proposed.peerProposal!.proposalId,
          quoteId: proposed.peerProposal!.quote.quoteId,
          approvedCreditCeiling:
            proposed.peerProposal!.quote.creditCeiling
        }
      });
      const executionReservation = await repository.reserveQuota({
        quotaKey: runCreditLedgerKey(created.runId),
        runId: created.runId,
        idempotencyKey: `schema-three-${checkpoint}-reservation`,
        requestedUnits: proposed.peerProposal!.quote.creditCeiling,
        maximumUnits: 160
      });
      const snapshot = await repository.readRunSnapshot(created.runId);
      if (!snapshot) throw new Error("Expected a persisted run");
      const legacyValue = structuredClone(snapshot.value) as {
        [key: string]: JsonValue;
      };
      const resolvedCohort = legacyValue.resolvedCohort;
      const peerProposal = legacyValue.peerProposal;
      const quota = legacyValue.quota;
      const approvals = legacyValue.approvals;
      if (
        resolvedCohort === null ||
        Array.isArray(resolvedCohort) ||
        typeof resolvedCohort !== "object" ||
        peerProposal === null ||
        Array.isArray(peerProposal) ||
        typeof peerProposal !== "object" ||
        quota === null ||
        Array.isArray(quota) ||
        typeof quota !== "object" ||
        approvals === null ||
        Array.isArray(approvals) ||
        typeof approvals !== "object"
      ) {
        throw new Error("Expected a persisted proposal claim");
      }

      let migratedState = proposed.state;
      for (const to of [
        "peers_approved",
        "credit_approved",
        "executing"
      ] as const) {
        migratedState = transitionRun(migratedState, {
          to,
          occurredAt: migratedState.updatedAt,
          actor: to === "peers_approved" ? "user" : "application",
          reason: `Persisted schema-v3 ${to} checkpoint`
        });
        if (to === checkpoint) break;
      }

      legacyValue.schemaVersion = 3;
      legacyValue.state = structuredClone(
        migratedState
      ) as unknown as JsonValue;
      delete resolvedCohort.identity;
      delete peerProposal.identity;
      peerProposal.cohortHash = approvedCohortHash(
        proposed.peerProposal!.target,
        proposed.peerProposal!.peers.map((peer) => ({
          name: peer.name,
          url: peer.url,
          subscriberCount: peer.subscriberCount,
          creatorId: peer.creatorId
        }))
      );
      quota.executionReservationId =
        executionReservation.value.reservationId;
      approvals.execution = {
        approvalId: executionApproval.value.approvalId,
        decidedAt: executionApproval.value.decidedAt
      };
      const stored = await repository.saveRunSnapshot({
        runId: created.runId,
        valueSchemaVersion: 3,
        value: legacyValue,
        expectedRevision: snapshot.revision
      });
      now += 10;
      const callsBeforeResume = structuredClone(calls.values);
      const llmCallsBeforeResume = llm.calls;
      const auditEventsBeforeResume = proposed.auditEvents.length;
      const resumeKey = `schema-three-${checkpoint}-resume`;

      const failed = await service.resumeRun(created.runId, {
        expectedVersion: stored.revision,
        idempotencyKey: resumeKey
      });

      expect(failed.status).toBe("failed");
      expect(failed.error?.code).toBe(expectedError);
      expect(failed.quota.executionCreditsUsed).toBe(expectedCredits);
      expect(calls.values).toEqual(callsBeforeResume);
      expect(calls.values).toEqual({
        resolve_target: 1,
        list_target_sponsors: 0,
        list_locked_peers: 1,
        list_peer_sponsors: 0,
        load_verification_ledger: 0
      });
      expect(llm.calls).toBe(llmCallsBeforeResume);
      expect(failed.auditEvents).toHaveLength(auditEventsBeforeResume);

      const ledger = await repository.readQuota(
        runCreditLedgerKey(created.runId)
      );
      expect(ledger).toMatchObject({
        activeUnits: 0,
        consumedUnits: 11 + expectedCredits,
        reservedUnits: 11 + expectedCredits
      });
      expect(
        ledger?.reservations.find(
          (reservation) =>
            reservation.reservationId ===
            executionReservation.value.reservationId
        )
      ).toMatchObject({
        requestedUnits: 145,
        actualUnits: expectedCredits,
        status: "settled"
      });

      const replay = await service.resumeRun(created.runId, {
        expectedVersion: stored.revision,
        idempotencyKey: resumeKey
      });
      expect(replay.version).toBe(failed.version);
      expect(calls.values).toEqual(callsBeforeResume);
      expect(llm.calls).toBe(llmCallsBeforeResume);
      expect(
        await repository.readQuota(runCreditLedgerKey(created.runId))
      ).toEqual(ledger);
    }
  );

  it("restores a terminal schema-v3 report with null legacy proof and performs no new work", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      clock: () => fixedNow,
      gatewayFactory: () =>
        new CountingFixtureGateway(process.cwd(), calls, false)
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "schema-three-terminal-create"
    );
    const proposed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "schema-three-terminal-plan"
    });
    const completed = await service.approveExecution(created.runId, {
      expectedVersion: proposed.version,
      proposalId: proposed.peerProposal!.proposalId,
      quoteId: proposed.peerProposal!.quote.quoteId,
      approvedCreditCeiling: 0,
      idempotencyKey: "schema-three-terminal-execution"
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
    if (
      report === null ||
      Array.isArray(report) ||
      typeof report !== "object"
    ) {
      throw new Error("Expected a persisted report");
    }
    delete report.targetIdentity;
    const proposal = legacyValue.peerProposal;
    if (
      proposal === null ||
      Array.isArray(proposal) ||
      typeof proposal !== "object"
    ) {
      throw new Error("Expected a persisted proposal");
    }
    proposal.cohortHash = approvedCohortHash(
      completed.peerProposal!.target,
      completed.peerProposal!.peers.map((peer) => ({
        name: peer.name,
        url: peer.url,
        subscriberCount: peer.subscriberCount,
        creatorId: peer.creatorId
      }))
    );
    await repository.saveRunSnapshot({
      runId: created.runId,
      valueSchemaVersion: 3,
      value: legacyValue,
      expectedRevision: snapshot.revision
    });
    const callsBeforeRestore = calls.total();

    const restored = await service.getRun(created.runId);

    expect(restored.status).toBe("completed");
    expect(restored.schemaVersion).toBe(4);
    expect(restored.resolvedCohort?.identity).toBeNull();
    expect(restored.peerProposal?.identity).toBeNull();
    expect(restored.report?.targetIdentity).toBeNull();
    expect(calls.total()).toBe(callsBeforeRestore);
  });

  it("rejects v4 identity corruption and outer/embedded schema disagreement", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      clock: () => fixedNow,
      gatewayFactory: () =>
        new CountingFixtureGateway(process.cwd(), calls, false)
    });

    const schemaMismatch = await service.createRun(
      "@UrAvgConsumer",
      "schema-envelope-mismatch"
    );
    const mismatchSnapshot = await repository.readRunSnapshot(
      schemaMismatch.runId
    );
    if (!mismatchSnapshot) throw new Error("Expected a persisted run");
    await repository.saveRunSnapshot({
      runId: schemaMismatch.runId,
      valueSchemaVersion: 3,
      value: mismatchSnapshot.value,
      expectedRevision: mismatchSnapshot.revision
    });
    await expect(
      service.getRun(schemaMismatch.runId)
    ).rejects.toBeInstanceOf(PersistenceCorruptionError);

    const badAccounting = await service.createRun(
      "@UrAvgConsumer",
      "schema-three-accounting-invalid"
    );
    const accountingSnapshot = await repository.readRunSnapshot(
      badAccounting.runId
    );
    if (!accountingSnapshot) throw new Error("Expected a persisted run");
    const accountingValue = structuredClone(accountingSnapshot.value) as {
      [key: string]: JsonValue;
    };
    const accounting = accountingValue.accounting;
    if (
      accounting === null ||
      Array.isArray(accounting) ||
      typeof accounting !== "object"
    ) {
      throw new Error("Expected persisted accounting");
    }
    accountingValue.schemaVersion = 3;
    accounting.maximumCredits = 0;
    await repository.saveRunSnapshot({
      runId: badAccounting.runId,
      valueSchemaVersion: 3,
      value: accountingValue,
      expectedRevision: accountingSnapshot.revision
    });
    await expect(
      service.getRun(badAccounting.runId)
    ).rejects.toBeInstanceOf(PersistenceCorruptionError);

    const missingCreated = await service.createRun(
      "@UrAvgConsumer",
      "schema-identity-missing"
    );
    await service.approvePlan(missingCreated.runId, {
      expectedVersion: missingCreated.version,
      planId: missingCreated.plan.planId,
      idempotencyKey: "schema-identity-missing-plan"
    });
    const missingSnapshot = await repository.readRunSnapshot(
      missingCreated.runId
    );
    if (!missingSnapshot) throw new Error("Expected a persisted run");
    const missingValue = structuredClone(missingSnapshot.value) as {
      [key: string]: JsonValue;
    };
    const missingProposal = missingValue.peerProposal;
    if (
      missingProposal === null ||
      Array.isArray(missingProposal) ||
      typeof missingProposal !== "object"
    ) {
      throw new Error("Expected a persisted peer proposal");
    }
    delete missingProposal.identity;
    await repository.saveRunSnapshot({
      runId: missingCreated.runId,
      valueSchemaVersion: 4,
      value: missingValue,
      expectedRevision: missingSnapshot.revision
    });
    await expect(
      service.getRun(missingCreated.runId)
    ).rejects.toBeInstanceOf(PersistenceCorruptionError);

    const invalidCreated = await service.createRun(
      "@UrAvgConsumer",
      "schema-identity-invalid"
    );
    await service.approvePlan(invalidCreated.runId, {
      expectedVersion: invalidCreated.version,
      planId: invalidCreated.plan.planId,
      idempotencyKey: "schema-identity-invalid-plan"
    });
    const invalidSnapshot = await repository.readRunSnapshot(
      invalidCreated.runId
    );
    if (!invalidSnapshot) throw new Error("Expected a persisted run");
    const invalidValue = structuredClone(invalidSnapshot.value) as {
      [key: string]: JsonValue;
    };
    for (const key of ["resolvedCohort", "peerProposal"] as const) {
      const container = invalidValue[key];
      if (
        container === null ||
        Array.isArray(container) ||
        typeof container !== "object"
      ) {
        throw new Error(`Expected persisted ${key}`);
      }
      container.identity = {
        verificationBasis: "channel_id",
        channelId: "not-a-channel-id",
        handle: "UrAvgConsumer",
        canonicalUrl: "https://www.youtube.com/@UrAvgConsumer",
        key: "channel:not-a-channel-id"
      };
    }
    await repository.saveRunSnapshot({
      runId: invalidCreated.runId,
      valueSchemaVersion: 4,
      value: invalidValue,
      expectedRevision: invalidSnapshot.revision
    });
    await expect(
      service.getRun(invalidCreated.runId)
    ).rejects.toBeInstanceOf(PersistenceCorruptionError);

    const nullCreated = await service.createRun(
      "@UrAvgConsumer",
      "schema-identity-null-downgrade"
    );
    const nullProposed = await service.approvePlan(nullCreated.runId, {
      expectedVersion: nullCreated.version,
      planId: nullCreated.plan.planId,
      idempotencyKey: "schema-identity-null-plan"
    });
    await service.approveExecution(nullCreated.runId, {
      expectedVersion: nullProposed.version,
      proposalId: nullProposed.peerProposal!.proposalId,
      quoteId: nullProposed.peerProposal!.quote.quoteId,
      approvedCreditCeiling: 0,
      idempotencyKey: "schema-identity-null-execution"
    });
    const nullSnapshot = await repository.readRunSnapshot(
      nullCreated.runId
    );
    if (!nullSnapshot) throw new Error("Expected a persisted run");
    const nullValue = structuredClone(nullSnapshot.value) as {
      [key: string]: JsonValue;
    };
    for (const key of ["resolvedCohort", "peerProposal"] as const) {
      const container = nullValue[key];
      if (
        container === null ||
        Array.isArray(container) ||
        typeof container !== "object"
      ) {
        throw new Error(`Expected persisted ${key}`);
      }
      container.identity = null;
    }
    const nullReport = nullValue.report;
    if (
      nullReport === null ||
      Array.isArray(nullReport) ||
      typeof nullReport !== "object"
    ) {
      throw new Error("Expected a persisted report");
    }
    nullReport.targetIdentity = null;
    await repository.saveRunSnapshot({
      runId: nullCreated.runId,
      valueSchemaVersion: 4,
      value: nullValue,
      expectedRevision: nullSnapshot.revision
    });
    await expect(
      service.getRun(nullCreated.runId)
    ).rejects.toBeInstanceOf(PersistenceCorruptionError);

    const conflictCreated = await service.createRun(
      "@UrAvgConsumer",
      "schema-identity-copy-conflict"
    );
    await service.approvePlan(conflictCreated.runId, {
      expectedVersion: conflictCreated.version,
      planId: conflictCreated.plan.planId,
      idempotencyKey: "schema-identity-conflict-plan"
    });
    const conflictSnapshot = await repository.readRunSnapshot(
      conflictCreated.runId
    );
    if (!conflictSnapshot) throw new Error("Expected a persisted run");
    const conflictValue = structuredClone(conflictSnapshot.value) as {
      [key: string]: JsonValue;
    };
    const conflictProposal = conflictValue.peerProposal;
    if (
      conflictProposal === null ||
      Array.isArray(conflictProposal) ||
      typeof conflictProposal !== "object"
    ) {
      throw new Error("Expected a persisted proposal");
    }
    conflictProposal.identity = {
      verificationBasis: "channel_id",
      channelId: "UCConflictingIdentity456",
      handle: "UrAvgConsumer",
      canonicalUrl: "https://www.youtube.com/@UrAvgConsumer",
      key: "channel:UCConflictingIdentity456"
    };
    await repository.saveRunSnapshot({
      runId: conflictCreated.runId,
      valueSchemaVersion: 4,
      value: conflictValue,
      expectedRevision: conflictSnapshot.revision
    });
    await expect(
      service.getRun(conflictCreated.runId)
    ).rejects.toBeInstanceOf(PersistenceCorruptionError);
  });

  it("settles a legacy active live claim once without replaying provider work", async () => {
    const directory = await temporaryDirectory();
    let now = fixedNow;
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => now
    });
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      mode: "live",
      clock: () => now,
      operationLeaseMs: 1,
      gatewayFactory: ({ maximumCredits }) =>
        new StageBoundedLiveGateway(
          process.cwd(),
          calls,
          maximumCredits ?? 160
        )
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "legacy-active-claim-create"
    );
    const legacyReservation = await repository.reserveQuota({
      quotaKey: "upriver-shared-credits",
      runId: created.runId,
      idempotencyKey: "legacy-active-resolution-reservation",
      requestedUnits: 11,
      maximumUnits: 200
    });
    const snapshot = await repository.readRunSnapshot(created.runId);
    if (!snapshot) throw new Error("Expected a persisted run");
    const legacyValue = structuredClone(
      snapshot.value
    ) as { [key: string]: JsonValue };
    const legacyQuota = legacyValue.quota;
    const legacyState = legacyValue.state;
    const legacyHistory =
      legacyState !== null &&
      !Array.isArray(legacyState) &&
      typeof legacyState === "object"
        ? legacyState.history
        : null;
    if (
      legacyQuota === null ||
      Array.isArray(legacyQuota) ||
      typeof legacyQuota !== "object" ||
      legacyState === null ||
      Array.isArray(legacyState) ||
      typeof legacyState !== "object" ||
      !Array.isArray(legacyHistory)
    ) {
      throw new Error("Expected quota and state records");
    }
    legacyValue.schemaVersion = 2;
    delete legacyValue.accounting;
    legacyQuota.resolutionReservationId =
      legacyReservation.value.reservationId;
    const occurredAt = new Date(fixedNow).toISOString();
    legacyHistory.push(
      {
        sequence: 2,
        from: "planned",
        to: "plan_approved",
        occurredAt,
        actor: "user",
        reason: "Legacy plan approval"
      },
      {
        sequence: 3,
        from: "plan_approved",
        to: "resolving",
        occurredAt,
        actor: "application",
        reason: "Legacy persisted resolution claim"
      }
    );
    legacyState.state = "resolving";
    legacyState.version = 3;
    legacyState.updatedAt = occurredAt;
    await repository.saveRunSnapshot({
      runId: created.runId,
      valueSchemaVersion: 2,
      value: legacyValue,
      expectedRevision: snapshot.revision
    });

    now += 10;
    const resumable = await service.getRun(created.runId);
    expect(resumable.accounting.policy).toBe("legacy_shared_v1");
    expect(resumable.availableActions).toEqual(["resume"]);
    const failed = await service.resumeRun(created.runId, {
      expectedVersion: resumable.version,
      idempotencyKey: "settle-legacy-active-resolution"
    });

    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("ambiguous_live_resolution");
    expect(failed.quota.resolutionCreditsUsed).toBe(11);
    expect(calls.total()).toBe(0);
    expect(
      await repository.readQuota("upriver-shared-credits")
    ).toMatchObject({
      activeUnits: 0,
      consumedUnits: 11,
      reservations: [
        expect.objectContaining({
          reservationId: legacyReservation.value.reservationId,
          status: "settled",
          actualUnits: 11
        })
      ]
    });
    expect(
      await repository.readQuota(runCreditLedgerKey(created.runId))
    ).toBeNull();
  });

  it("quotes zero resolution and 146 execution credits when only sponsor caches expire", async () => {
    const directory = await temporaryDirectory();
    let now = fixedNow;
    const clock = () => now;
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock
    });
    const calls = callCounter();
    const provider = new CountingFixtureGateway(
      process.cwd(),
      calls,
      false,
      "live"
    );
    const cacheOptions = {
      creatorTtlMs: 1_000,
      sponsorTtlMs: 10,
      verificationTtlMs: 1_000
    };
    const warm = new CachedEvidenceGateway(
      provider,
      repository,
      cacheOptions
    );
    const resolved = await warm.resolveTarget("@UrAvgConsumer");
    const peers = await warm.listLockedPeers(
      resolved.target.url,
      resolved.target.subscriberCount
    );
    await warm.listTargetSponsors(resolved.target.url);
    await Promise.all(
      peers.map((peer) => warm.listPeerSponsors(peer.url))
    );
    expect(calls.total()).toBe(6);

    now += 11;
    const service = new WorkflowService({
      repository,
      mode: "live",
      clock,
      runCreditLimit: 160,
      gatewayFactory: () =>
        new CachedEvidenceGateway(
          provider,
          repository,
          cacheOptions
        )
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "mixed-cache-quote"
    );

    expect(created.plan).toMatchObject({
      resolutionCreditCeiling: 0,
      executionCreditCeiling: 146,
      totalCreditCeiling: 146
    });

    const proposed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "approve-mixed-cache-plan"
    });

    expect(proposed.quota.resolutionCreditsUsed).toBe(0);
    expect(proposed.peerProposal?.quote.creditCeiling).toBe(146);
    expect(calls.total()).toBe(6);
  });

  it.each([0, 1, 3])(
    "settles all 10 Similar result credits when %i peers survive selection",
    async (selectedPeerCount) => {
      const directory = await temporaryDirectory();
      const repository = new FileSystemWorkflowRepository({
        directory,
        clock: () => fixedNow
      });
      const calls = callCounter();
      const service = new WorkflowService({
        repository,
        mode: "live",
        clock: () => fixedNow,
        runCreditLimit: 160,
        gatewayFactory: ({ audit }) =>
          new CachedEvidenceGateway(
            new SimilarUsageLiveGateway(
              process.cwd(),
              calls,
              selectedPeerCount,
              audit
            ),
            repository
          )
      });
      const created = await service.createRun(
        "@UrAvgConsumer",
        `similar-usage-${selectedPeerCount}`
      );
      expect(created.plan).toMatchObject({
        resolutionCreditCeiling: 11,
        executionCreditCeiling: 146,
        totalCreditCeiling: 157
      });

      const resolved = await service.approvePlan(created.runId, {
        expectedVersion: created.version,
        planId: created.plan.planId,
        idempotencyKey: `approve-similar-usage-${selectedPeerCount}`
      });

      expect(resolved.quota.resolutionCreditsUsed).toBe(11);
      expect(
        resolved.auditEvents.find(
          (event) =>
            event.eventType === "tool.completed" &&
            event.tool?.name === "live.list_locked_peers"
        )?.tool
      ).toMatchObject({
        rows: selectedPeerCount,
        resultBasedCredits: 10
      });
      expect(
        await repository.readQuota(runCreditLedgerKey(created.runId))
      ).toMatchObject({
        activeUnits: 0,
        consumedUnits: 11,
        reservedUnits: 11
      });
    }
  );

  it.each([
    "target_not_verified",
    "target_identity_mismatch",
    "target_identity_ambiguous"
  ] as const)(
    "settles one observed credit and persists safe %s identity failure details",
    async (verificationCode) => {
      const directory = await temporaryDirectory();
      const repository = new FileSystemWorkflowRepository({
        directory,
        clock: () => fixedNow
      });
      const calls = callCounter();
      const service = new WorkflowService({
        repository,
        mode: "live",
        clock: () => fixedNow,
        gatewayFactory: ({ audit, maximumCredits }) =>
          new VerificationFailureLiveGateway(
            process.cwd(),
            calls,
            maximumCredits ?? 160,
            audit,
            verificationCode,
            1
          )
      });
      const created = await service.createRun(
        "@UrAvgConsumer",
        `verification-failure-${verificationCode}`
      );
      const approval = {
        expectedVersion: created.version,
        planId: created.plan.planId,
        idempotencyKey: `approve-${verificationCode}`
      };

      const failed = await service.approvePlan(
        created.runId,
        approval
      );

      expect(failed.status).toBe("failed");
      expect(failed.error).toEqual({
        code: verificationCode,
        message:
          "That handle or link did not resolve to one exact YouTube channel. Check it and start a new search.",
        retryable: false
      });
      expect(failed.quota.resolutionCreditsUsed).toBe(1);
      expect(calls.values).toEqual({
        resolve_target: 1,
        list_target_sponsors: 0,
        list_locked_peers: 0,
        list_peer_sponsors: 0,
        load_verification_ledger: 0
      });
      expect(
        failed.auditEvents.find(
          (event) =>
            event.eventType === "http.completed" &&
            event.tool?.name ===
              "upriver.http.live.resolve_target"
        )?.tool
      ).toMatchObject({
        requestId: `request-${verificationCode}-1`,
        providerRequestId: `provider-${verificationCode}-1`,
        retryCount: 0,
        rows: 1,
        resultBasedCredits: 1,
        outcome: "success"
      });
      expect(
        failed.auditEvents.some(
          (event) => event.eventType === "llm.started"
        )
      ).toBe(false);
      expect(
        await repository.readQuota(runCreditLedgerKey(created.runId))
      ).toMatchObject({
        activeUnits: 0,
        consumedUnits: 1,
        reservedUnits: 1,
        reservations: [
          expect.objectContaining({
            requestedUnits: 11,
            actualUnits: 1,
            status: "settled"
          })
        ]
      });

      const restored = await service.getRun(created.runId);
      expect(restored.error).toEqual(failed.error);
      const replay = await service.approvePlan(
        created.runId,
        approval
      );
      expect(replay.version).toBe(failed.version);
      expect(replay.error).toEqual(failed.error);
      expect(calls.values.resolve_target).toBe(1);
    }
  );

  it("never persists a raw internal error message in a failed run", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      mode: "live",
      clock: () => fixedNow,
      gatewayFactory: ({ audit, maximumCredits }) =>
        new LeakyResolutionGateway(
          process.cwd(),
          calls,
          maximumCredits ?? 160,
          audit
        )
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "leaky-resolution-failure"
    );

    const failed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "approve-leaky-resolution"
    });

    expect(failed.status).toBe("failed");
    // The read API serialises run.error verbatim, so the persisted value must
    // never carry provider text, secrets, URLs, or other internal detail.
    const serialized = JSON.stringify(failed.error);
    for (const forbidden of [
      "sk-live-SECRET-9f83",
      "token=",
      "api.upriver.test",
      "youtube",
      "upstream",
      "500"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(failed.error).toEqual({
      code: "unknown_failure",
      message: "The run failed safely. Start a new search.",
      retryable: false
    });
  });

  it("keeps the full resolution reservation for an ambiguous network failure", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      mode: "live",
      clock: () => fixedNow,
      gatewayFactory: ({ audit, maximumCredits }) =>
        new NetworkFailureLiveGateway(
          process.cwd(),
          calls,
          maximumCredits ?? 160,
          audit
        )
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "network-verification-failure"
    );
    const failed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "approve-network-verification-failure"
    });

    expect(failed.status).toBe("failed");
    expect(failed.quota.resolutionCreditsUsed).toBe(11);
    expect(calls.values.resolve_target).toBe(1);
    expect(calls.values.list_locked_peers).toBe(0);
    expect(
      failed.auditEvents.some(
        (event) => event.eventType === "http.completed"
      )
    ).toBe(false);
    expect(
      failed.auditEvents.find(
        (event) => event.eventType === "http.failed"
      )?.tool
    ).toMatchObject({
      errorType: "network_failure",
      outcome: "failure"
    });
    expect(
      await repository.readQuota(runCreditLedgerKey(created.runId))
    ).toMatchObject({
      activeUnits: 0,
      consumedUnits: 11,
      reservedUnits: 11
    });
  });

  it("records observed provider overage instead of hiding it behind the reservation", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      mode: "live",
      clock: () => fixedNow,
      gatewayFactory: ({ audit, maximumCredits }) =>
        new VerificationFailureLiveGateway(
          process.cwd(),
          calls,
          maximumCredits ?? 160,
          audit,
          "target_identity_ambiguous",
          161
        )
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "provider-overage-verification-failure"
    );
    const failed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "approve-provider-overage"
    });

    expect(failed.quota.resolutionCreditsUsed).toBe(161);
    expect(
      await repository.readQuota(runCreditLedgerKey(created.runId))
    ).toMatchObject({
      maximumUnits: 160,
      activeUnits: 0,
      consumedUnits: 161,
      reservedUnits: 161,
      exceededUnits: 1,
      reservations: [
        expect.objectContaining({
          requestedUnits: 11,
          actualUnits: 161,
          status: "settled"
        })
      ]
    });
  });

  it("settles the full execution ceiling after an ambiguous re-resolution failure and never starts sponsors", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      mode: "live",
      clock: () => fixedNow,
      gatewayFactory: ({ audit, maximumCredits }) =>
        new ExecutionNetworkFailureLiveGateway(
          process.cwd(),
          calls,
          maximumCredits ?? 160,
          audit
        )
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "execution-network-failure"
    );
    const proposed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "execution-network-failure-plan"
    });
    const approval = {
      expectedVersion: proposed.version,
      proposalId: proposed.peerProposal!.proposalId,
      quoteId: proposed.peerProposal!.quote.quoteId,
      approvedCreditCeiling:
        proposed.peerProposal!.quote.creditCeiling,
      idempotencyKey: "execution-network-failure-approval"
    };

    const failed = await service.approveExecution(
      created.runId,
      approval
    );

    expect(failed.status).toBe("failed");
    expect(failed.quota).toMatchObject({
      resolutionCreditsUsed: 11,
      executionCreditsUsed: 145
    });
    expect(calls.values).toEqual({
      resolve_target: 2,
      list_target_sponsors: 0,
      list_locked_peers: 1,
      list_peer_sponsors: 0,
      load_verification_ledger: 0
    });
    expect(
      failed.auditEvents.some(
        (event) => event.eventType === "llm.started"
      )
    ).toBe(false);
    expect(
      failed.auditEvents.find(
        (event) =>
          event.eventType === "http.failed" &&
          event.tool?.name === "upriver.http.live.resolve_target"
      )?.tool
    ).toMatchObject({
      errorType: "network_failure",
      outcome: "failure"
    });
    expect(
      await repository.readQuota(runCreditLedgerKey(created.runId))
    ).toMatchObject({
      activeUnits: 0,
      consumedUnits: 156,
      reservedUnits: 156
    });

    const replay = await service.approveExecution(
      created.runId,
      approval
    );
    expect(replay.version).toBe(failed.version);
    expect(calls.values.resolve_target).toBe(2);
  });

  it.each([
    { cacheHit: false, executionCredits: 1 },
    { cacheHit: true, executionCredits: 0 }
  ])(
    "stops ID drift before sponsors and settles $executionCredits execution credits when cacheHit=$cacheHit",
    async ({ cacheHit, executionCredits }) => {
      const directory = await temporaryDirectory();
      const repository = new FileSystemWorkflowRepository({
        directory,
        clock: () => fixedNow
      });
      const calls = callCounter();
      const service = new WorkflowService({
        repository,
        mode: "live",
        clock: () => fixedNow,
        gatewayFactory: ({ audit, maximumCredits }) =>
          new IdentityDriftLiveGateway(
            process.cwd(),
            calls,
            maximumCredits ?? 160,
            audit,
            cacheHit
          )
      });
      const created = await service.createRun(
        "@UrAvgConsumer",
        `identity-drift-${cacheHit ? "cached" : "paid"}`
      );
      const proposed = await service.approvePlan(created.runId, {
        expectedVersion: created.version,
        planId: created.plan.planId,
        idempotencyKey: `identity-drift-plan-${cacheHit}`
      });
      expect(proposed.peerProposal?.identity).toMatchObject({
        verificationBasis: "channel_id",
        channelId: "UCIdentityBefore123"
      });
      const approval = {
        expectedVersion: proposed.version,
        proposalId: proposed.peerProposal!.proposalId,
        quoteId: proposed.peerProposal!.quote.quoteId,
        approvedCreditCeiling:
          proposed.peerProposal!.quote.creditCeiling,
        idempotencyKey: `identity-drift-execution-${cacheHit}`
      };

      const failed = await service.approveExecution(
        created.runId,
        approval
      );

      expect(failed.status).toBe("failed");
      expect(failed.error).toEqual({
        code: "target_identity_mismatch",
        message:
          "That handle or link did not resolve to one exact YouTube channel. Check it and start a new search.",
        retryable: false
      });
      expect(failed.quota).toMatchObject({
        resolutionCreditsUsed: 11,
        executionCreditsUsed: executionCredits
      });
      expect(calls.values).toEqual({
        resolve_target: 2,
        list_target_sponsors: 0,
        list_locked_peers: 1,
        list_peer_sponsors: 0,
        load_verification_ledger: 0
      });
      expect(
        failed.auditEvents.some(
          (event) => event.eventType === "llm.started"
        )
      ).toBe(false);
      expect(
        await repository.readQuota(runCreditLedgerKey(created.runId))
      ).toMatchObject({
        activeUnits: 0,
        consumedUnits: 11 + executionCredits,
        reservedUnits: 11 + executionCredits,
        reservations: [
          expect.objectContaining({
            requestedUnits: 11,
            actualUnits: 11,
            status: "settled"
          }),
          expect.objectContaining({
            requestedUnits: 145,
            actualUnits: executionCredits,
            status: "settled"
          })
        ]
      });

      const replay = await service.approveExecution(
        created.runId,
        approval
      );
      expect(replay.version).toBe(failed.version);
      expect(calls.values.resolve_target).toBe(2);
    }
  );

  it("bypasses the production creator cache for paid execution revalidation", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const calls = callCounter();
    const service = new WorkflowService({
      repository,
      mode: "live",
      clock: () => fixedNow,
      gatewayFactory: ({ audit, maximumCredits }) =>
        new CachedEvidenceGateway(
          new IdentityDriftLiveGateway(
            process.cwd(),
            calls,
            maximumCredits ?? 160,
            audit,
            false
          ),
          repository
        )
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "production-cache-identity-drift"
    );
    expect(created.plan).toMatchObject({
      resolutionCreditCeiling: 11,
      executionCreditCeiling: 146,
      totalCreditCeiling: 157
    });
    const proposed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "production-cache-identity-plan"
    });
    expect(proposed.peerProposal?.quote.creditCeiling).toBe(146);

    const failed = await service.approveExecution(created.runId, {
      expectedVersion: proposed.version,
      proposalId: proposed.peerProposal!.proposalId,
      quoteId: proposed.peerProposal!.quote.quoteId,
      approvedCreditCeiling: 146,
      idempotencyKey: "production-cache-identity-execution"
    });

    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("target_identity_mismatch");
    expect(failed.quota).toMatchObject({
      resolutionCreditsUsed: 11,
      executionCreditsUsed: 1
    });
    expect(calls.values).toEqual({
      resolve_target: 2,
      list_target_sponsors: 0,
      list_locked_peers: 1,
      list_peer_sponsors: 0,
      load_verification_ledger: 0
    });
    expect(
      failed.auditEvents.filter(
        (event) =>
          event.eventType === "http.completed" &&
          event.tool?.name === "upriver.http.live.resolve_target"
      )
    ).toHaveLength(2);
  });

  it("resumes across service instances and serves a second run entirely warm", async () => {
    const directory = await temporaryDirectory();
    const calls = callCounter();
    let service = serviceFor(directory, calls);
    const first = await service.createRun(
      "@UrAvgConsumer",
      "first-persisted-run"
    );
    const proposed = await service.approvePlan(first.runId, {
      expectedVersion: first.version,
      planId: first.plan.planId,
      idempotencyKey: "first-plan-approval"
    });

    service = serviceFor(directory, calls);
    const refreshed = await service.getRun(first.runId);
    expect(refreshed.version).toBe(proposed.version);
    const completed = await service.approveExecution(first.runId, {
      expectedVersion: refreshed.version,
      proposalId: refreshed.peerProposal!.proposalId,
      quoteId: refreshed.peerProposal!.quote.quoteId,
      approvedCreditCeiling: 0,
      idempotencyKey: "first-execution-approval"
    });
    expect(completed.status).toBe("completed");
    expect(calls.total()).toBe(7);

    service = serviceFor(directory, calls);
    const warm = await service.createRun(
      "https://youtube.com/@UrAvgConsumer",
      "second-warm-run"
    );
    expect(warm.plan.totalCreditCeiling).toBe(0);
    const warmProposal = await service.approvePlan(warm.runId, {
      expectedVersion: warm.version,
      planId: warm.plan.planId,
      idempotencyKey: "second-plan-approval"
    });
    const warmCompleted = await service.approveExecution(warm.runId, {
      expectedVersion: warmProposal.version,
      proposalId: warmProposal.peerProposal!.proposalId,
      quoteId: warmProposal.peerProposal!.quote.quoteId,
      approvedCreditCeiling: 0,
      idempotencyKey: "second-execution-approval"
    });

    expect(warmCompleted.status).toBe("completed");
    expect(warmCompleted.report?.audit.resultBasedCreditEstimate).toBe(0);
    expect(
      warmCompleted.auditEvents
        .filter((event) => event.eventType === "tool.completed")
        .every((event) => event.tool?.cacheStatus === "hit")
    ).toBe(true);
    expect(calls.total()).toBe(7);
  });

  it("rejects stale mutations before recording another approval", async () => {
    const harness = await workflowHarness();
    const created = await harness.service.createRun(
      "@UrAvgConsumer",
      "stale-version-run"
    );

    await expect(
      harness.service.approvePlan(created.runId, {
        expectedVersion: created.version + 1,
        planId: created.plan.planId,
        idempotencyKey: "stale-plan-approval"
      })
    ).rejects.toBeInstanceOf(WorkflowConflictError);
    expect(harness.calls.total()).toBe(0);
  });

  it("replays a persisted execution approval after its quote expires", async () => {
    const directory = await temporaryDirectory();
    const calls = callCounter();
    let now = fixedNow;
    const service = serviceFor(directory, calls, false, () => now);
    const created = await service.createRun(
      "@UrAvgConsumer",
      "expiry-replay-run"
    );
    const proposed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "expiry-plan-approval"
    });
    const approval = {
      expectedVersion: proposed.version,
      proposalId: proposed.peerProposal!.proposalId,
      quoteId: proposed.peerProposal!.quote.quoteId,
      approvedCreditCeiling: 0,
      idempotencyKey: "expiry-execution-approval"
    };
    const completed = await service.approveExecution(created.runId, approval);

    now += 2 * 60 * 60 * 1_000;
    const replay = await service.approveExecution(created.runId, approval);

    expect(replay.version).toBe(completed.version);
    expect(replay.status).toBe("completed");
    expect(calls.total()).toBe(7);
  });

  it("rejects an expired one-credit revalidation plan before any paid evidence call", async () => {
    const directory = await temporaryDirectory();
    let now = fixedNow;
    const clock = () => now;
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock
    });
    const calls = callCounter();
    const provider = new CountingFixtureGateway(
      process.cwd(),
      calls,
      false,
      "live"
    );
    const cacheOptions = {
      creatorTtlMs: 1_000,
      sponsorTtlMs: 1_000,
      verificationTtlMs: 1_000
    };
    const warm = new CachedEvidenceGateway(
      provider,
      repository,
      cacheOptions
    );
    const resolved = await warm.resolveTarget("@UrAvgConsumer");
    const peers = await warm.listLockedPeers(
      resolved.target.url,
      resolved.target.subscriberCount
    );
    await warm.listTargetSponsors(resolved.target.url);
    await Promise.all(
      peers.map((peer) => warm.listPeerSponsors(peer.url))
    );
    expect(calls.total()).toBe(6);

    const stageCaps: number[] = [];
    const service = new WorkflowService({
      repository,
      mode: "live",
      clock,
      gatewayFactory: ({ maximumCredits }) => {
        stageCaps.push(maximumCredits ?? -1);
        return new CachedEvidenceGateway(
          provider,
          repository,
          cacheOptions
        );
      }
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "expired-zero-credit-plan"
    );
    expect(created.plan.totalCreditCeiling).toBe(1);

    now += 2_000;
    await expect(
      service.approvePlan(created.runId, {
        expectedVersion: created.version,
        planId: created.plan.planId,
        idempotencyKey: "reject-expired-plan"
      })
    ).rejects.toThrow(/Cached evidence changed the credit ceiling/);

    expect(calls.total()).toBe(6);
    expect(stageCaps).toEqual([160, 1]);
    expect(await repository.listApprovals(created.runId)).toEqual([]);
    expect(
      await repository.readQuota(runCreditLedgerKey(created.runId))
    ).toBeNull();
  });

  it("never replays an interrupted live resolution and settles its full reservation", async () => {
    const directory = await temporaryDirectory();
    let now = fixedNow;
    const clock = () => now;
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock
    });
    const calls = callCounter();
    const stageCaps: number[] = [];
    const service = new WorkflowService({
      repository,
      mode: "live",
      clock,
      operationLeaseMs: 1_000,
      gatewayFactory: ({ maximumCredits }) => {
        stageCaps.push(maximumCredits ?? -1);
        return new HangingLiveGateway(process.cwd(), calls);
      }
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "ambiguous-resolution-run"
    );
    const originalApproval = service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "ambiguous-plan-approval"
    });
    void originalApproval.catch(() => undefined);

    const resolving = await waitForState(
      service,
      created.runId,
      "resolving"
    );
    expect(resolving.availableActions).toEqual([]);
    expect(calls.values.resolve_target).toBe(1);

    now += 1_001;
    const resumable = await service.getRun(created.runId);
    expect(resumable.availableActions).toEqual(["resume"]);
    const failed = await service.resumeRun(created.runId, {
      expectedVersion: resumable.version,
      idempotencyKey: "resume-ambiguous-resolution"
    });

    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("ambiguous_live_resolution");
    expect(failed.quota.resolutionCreditsUsed).toBe(4);
    expect(calls.values.resolve_target).toBe(1);
    expect(stageCaps).toEqual([160, 149, 4]);
    expect(
      await repository.readQuota(runCreditLedgerKey(created.runId))
    ).toMatchObject({
      activeUnits: 0,
      consumedUnits: 4,
      reservedUnits: 4
    });
  });

  it("lets cancellation win before the durable resolution claim and releases quota", async () => {
    const directory = await temporaryDirectory();
    const baseRepository = new FileSystemWorkflowRepository({
      directory,
      clock: () => fixedNow
    });
    const checkpoint = pauseBeforeSnapshotState(
      baseRepository,
      "resolving"
    );
    const calls = callCounter();
    const service = new WorkflowService({
      repository: checkpoint.repository,
      mode: "fixture",
      clock: () => fixedNow,
      gatewayFactory: () =>
        new CachedEvidenceGateway(
          new CountingFixtureGateway(
            process.cwd(),
            calls,
            false
          ),
          checkpoint.repository
        )
    });
    const created = await service.createRun(
      "@UrAvgConsumer",
      "cancel-before-resolution-claim"
    );
    const approval = service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "approve-before-cancel-race"
    });

    await checkpoint.reached;
    const approved = await service.getRun(created.runId);
    expect(approved.state.state).toBe("plan_approved");
    const cancelled = await service.cancelRun(created.runId, {
      expectedVersion: approved.version,
      idempotencyKey: "cancel-wins-resolution-race"
    });
    checkpoint.release();
    const approvalResult = await approval;

    expect(cancelled.state.state).toBe("cancelled");
    expect(approvalResult.state.state).toBe("cancelled");
    expect(calls.total()).toBe(0);
    expect(
      await baseRepository.readQuota(runCreditLedgerKey(created.runId))
    ).toMatchObject({
      activeUnits: 0,
      consumedUnits: 0,
      reservedUnits: 0
    });
  });

  it("preserves valid Dell evidence when one peer research call fails", async () => {
    const directory = await temporaryDirectory();
    const calls = callCounter();
    const service = serviceFor(directory, calls, true);
    const created = await service.createRun(
      "@UrAvgConsumer",
      "partial-peer-run"
    );
    const proposed = await service.approvePlan(created.runId, {
      expectedVersion: created.version,
      planId: created.plan.planId,
      idempotencyKey: "partial-plan-approval"
    });
    const partial = await service.approveExecution(created.runId, {
      expectedVersion: proposed.version,
      proposalId: proposed.peerProposal!.proposalId,
      quoteId: proposed.peerProposal!.quote.quoteId,
      approvedCreditCeiling: 0,
      idempotencyKey: "partial-execution-approval"
    });

    expect(partial.status).toBe("partial");
    expect(partial.report?.leads.map((lead) => lead.brand)).toEqual(["Dell"]);
    expect(partial.report?.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "peer_research_partial",
          severity: "warning",
          message: expect.stringContaining("Hayls World")
        })
      ])
    );
  });
});

interface CallCounter {
  values: Record<EvidenceOperation, number>;
  total(): number;
}

async function workflowHarness() {
  const directory = await temporaryDirectory();
  const calls = callCounter();
  return {
    calls,
    service: serviceFor(directory, calls)
  };
}

function serviceFor(
  directory: string,
  calls: CallCounter,
  failHaylsWorld = false,
  clock: () => number = () => fixedNow
): WorkflowService {
  const repository = new FileSystemWorkflowRepository({
    directory,
    clock
  });
  return new WorkflowService({
    repository,
    mode: "fixture",
    clock,
    gatewayFactory: () =>
      new CachedEvidenceGateway(
        new CountingFixtureGateway(
          process.cwd(),
          calls,
          failHaylsWorld
        ),
        repository
      )
  });
}

class CountingFixtureLlmPort extends FixtureLlmPort {
  calls = 0;

  override async generateStructured(request: LlmProviderRequest) {
    this.calls += 1;
    return super.generateStructured(request);
  }
}

class CountingFixtureGateway implements SponsorRadarEvidencePort {
  readonly qualificationPolicy = "verified_product_continuity" as const;
  private readonly fixture: FixtureEvidenceGateway;

  constructor(
    repositoryRoot: string,
    protected readonly counter: CallCounter,
    private readonly failHaylsWorld: boolean,
    readonly mode: EvidenceMode = "fixture"
  ) {
    this.fixture = new FixtureEvidenceGateway(repositoryRoot);
  }

  estimateCredits(operation: EvidenceOperation): number {
    if (this.mode === "fixture") return 0;
    switch (operation) {
      case "resolve_target":
        return 1;
      case "list_target_sponsors":
        return 115;
      case "list_locked_peers":
        return 3;
      case "list_peer_sponsors":
        return 10;
      case "load_verification_ledger":
        return 0;
    }
  }

  estimateRunCredits(): number {
    return this.mode === "fixture" ? 0 : 149;
  }

  resolveTarget(input: string) {
    this.counter.values.resolve_target += 1;
    return this.fixture.resolveTarget(input);
  }

  listTargetSponsors(targetUrl: string) {
    this.counter.values.list_target_sponsors += 1;
    return this.fixture.listTargetSponsors(targetUrl);
  }

  listLockedPeers(targetUrl: string, targetSubscriberCount?: number) {
    this.counter.values.list_locked_peers += 1;
    return this.fixture.listLockedPeers(
      targetUrl,
      targetSubscriberCount
    );
  }

  listPeerSponsors(peerUrl: string) {
    this.counter.values.list_peer_sponsors += 1;
    if (
      this.failHaylsWorld &&
      parseYouTubeIdentity(peerUrl).key ===
        parseYouTubeIdentity("@HaylsWorld").key
    ) {
      throw new Error("Recorded peer failure");
    }
    return this.fixture.listPeerSponsors(peerUrl);
  }

  loadVerificationLedger() {
    this.counter.values.load_verification_ledger += 1;
    return this.fixture.loadVerificationLedger();
  }
}

class NoEligiblePeersGateway extends CountingFixtureGateway {
  override async listLockedPeers(
    targetUrl: string,
    targetSubscriberCount?: number
  ) {
    void targetUrl;
    void targetSubscriberCount;
    this.counter.values.list_locked_peers += 1;
    return [];
  }
}

class OnePeerLiveGateway extends CountingFixtureGateway {
  constructor(repositoryRoot: string, counter: CallCounter) {
    super(repositoryRoot, counter, false, "live");
  }

  override async listLockedPeers(
    targetUrl: string,
    targetSubscriberCount?: number
  ) {
    const peers = await super.listLockedPeers(
      targetUrl,
      targetSubscriberCount
    );
    return peers.slice(0, 1);
  }
}

class CeilingOnlyLiveGateway extends CountingFixtureGateway {
  constructor(
    repositoryRoot: string,
    counter: CallCounter,
    private readonly totalCreditCeiling: number
  ) {
    super(repositoryRoot, counter, false, "live");
  }

  override estimateRunCredits(): number {
    return this.totalCreditCeiling;
  }
}

class StageBoundedLiveGateway extends CountingFixtureGateway {
  constructor(
    repositoryRoot: string,
    counter: CallCounter,
    private readonly maximumCredits: number
  ) {
    super(repositoryRoot, counter, false, "live");
  }

  override estimateCredits(operation: EvidenceOperation): number {
    return operation === "list_locked_peers"
      ? 10
      : super.estimateCredits(operation);
  }

  override estimateRunCredits(): number {
    return Math.min(156, this.maximumCredits);
  }

  estimateResolutionCredits(): number {
    return Math.min(11, this.maximumCredits);
  }
}

class MeteredLiveGateway extends CountingFixtureGateway {
  constructor(
    repositoryRoot: string,
    counter: CallCounter,
    protected readonly maximumCredits: number,
    protected readonly audit: AuditRecorder | undefined
  ) {
    super(repositoryRoot, counter, false, "live");
  }

  override estimateCredits(operation: EvidenceOperation): number {
    return operation === "list_locked_peers"
      ? 10
      : super.estimateCredits(operation);
  }

  override estimateRunCredits(): number {
    return Math.min(156, this.maximumCredits);
  }

  estimateResolutionCredits(): number {
    return Math.min(11, this.maximumCredits);
  }
}

class VerificationFailureLiveGateway extends MeteredLiveGateway {
  constructor(
    repositoryRoot: string,
    counter: CallCounter,
    maximumCredits: number,
    audit: AuditRecorder | undefined,
    private readonly verificationCode: YouTubeTargetVerificationCode,
    private readonly observedCredits: number
  ) {
    super(repositoryRoot, counter, maximumCredits, audit);
  }

  override async resolveTarget(): Promise<never> {
    this.counter.values.resolve_target += 1;
    const call = this.counter.values.resolve_target;
    this.audit?.recordHttpLifecycle({
      phase: "completed",
      method: "POST",
      path: "/v1/creators/batch",
      requestId: `request-${this.verificationCode}-${call}`,
      audit: {
        operation: "live.resolve_target",
        reason: "Test a metered semantic target-verification failure",
        estimatedCredits: 1
      },
      meta: {
        providerRequestId: `provider-${this.verificationCode}-${call}`,
        latencyMs: 1,
        attempts: [{}]
      },
      usage: {
        rows: this.observedCredits,
        resultBasedCredits: this.observedCredits
      }
    });
    throw new YouTubeTargetVerificationError(
      this.verificationCode,
      "Provider detail that must not be shown to the user"
    );
  }
}

class LeakyResolutionGateway extends MeteredLiveGateway {
  override async resolveTarget(): Promise<never> {
    this.counter.values.resolve_target += 1;
    throw new Error(
      "youtube upstream 500 from https://api.upriver.test/v1/creators?token=sk-live-SECRET-9f83 within the reach window"
    );
  }
}

class NetworkFailureLiveGateway extends MeteredLiveGateway {
  override async resolveTarget(): Promise<never> {
    this.counter.values.resolve_target += 1;
    this.audit?.recordHttpLifecycle({
      phase: "failed",
      method: "POST",
      path: "/v1/creators/batch",
      requestId: "network-failure-request",
      audit: {
        operation: "live.resolve_target",
        reason: "Test ambiguous provider failure accounting",
        estimatedCredits: 1
      },
      code: "network_failure",
      status: null,
      meta: {
        providerRequestId: null,
        latencyMs: 1,
        attempts: [{}]
      }
    });
    throw new Error("Simulated ambiguous network failure");
  }
}

class ExecutionNetworkFailureLiveGateway extends MeteredLiveGateway {
  override async resolveTarget(input: string) {
    if (this.counter.values.resolve_target === 0) {
      const resolved = await super.resolveTarget(input);
      this.audit?.recordHttpLifecycle({
        phase: "completed",
        method: "POST",
        path: "/v1/creators/batch",
        requestId: "execution-network-initial-resolution",
        audit: {
          operation: "live.resolve_target",
          reason: "Establish the initially approved target identity",
          estimatedCredits: 1
        },
        meta: {
          providerRequestId: "execution-network-initial-provider",
          latencyMs: 1,
          attempts: [{}]
        },
        usage: {
          rows: 1,
          resultBasedCredits: 1
        }
      });
      return resolved;
    }

    this.counter.values.resolve_target += 1;
    this.audit?.recordHttpLifecycle({
      phase: "failed",
      method: "POST",
      path: "/v1/creators/batch",
      requestId: "execution-network-failed-resolution",
      audit: {
        operation: "live.resolve_target",
        reason: "Test ambiguous execution-stage provider accounting",
        estimatedCredits: 1
      },
      code: "network_failure",
      status: null,
      meta: {
        providerRequestId: null,
        latencyMs: 1,
        attempts: [{}]
      }
    });
    throw new Error("Simulated execution-stage network failure");
  }
}

class IdentityDriftLiveGateway extends MeteredLiveGateway {
  constructor(
    repositoryRoot: string,
    counter: CallCounter,
    maximumCredits: number,
    audit: AuditRecorder | undefined,
    private readonly executionCacheHit: boolean
  ) {
    super(repositoryRoot, counter, maximumCredits, audit);
  }

  async inspectCache(operation: EvidenceOperation) {
    return operation === "resolve_target" &&
      this.executionCacheHit &&
      this.counter.values.resolve_target >= 1
      ? ("hit" as const)
      : ("miss" as const);
  }

  override async resolveTarget(input: string) {
    const resolved = await super.resolveTarget(input);
    const call = this.counter.values.resolve_target;
    const isExecutionCacheHit =
      this.executionCacheHit && call > 1;
    if (!isExecutionCacheHit) {
      this.audit?.recordHttpLifecycle({
        phase: "completed",
        method: "POST",
        path: "/v1/creators/batch",
        requestId: `identity-drift-request-${call}`,
        audit: {
          operation: "live.resolve_target",
          reason: "Test execution-time verified channel drift",
          estimatedCredits: 1
        },
        meta: {
          providerRequestId: `identity-drift-provider-${call}`,
          latencyMs: 1,
          attempts: [{}]
        },
        usage: {
          rows: 1,
          resultBasedCredits: 1
        }
      });
    }
    const channelId =
      call === 1 ? "UCIdentityBefore123" : "UCIdentityAfter456";
    return {
      ...resolved,
      identity: {
        verificationBasis: "channel_id" as const,
        channelId,
        handle: "UrAvgConsumer",
        canonicalUrl: resolved.target.url,
        key: `channel:${channelId}`
      }
    };
  }
}

class SimilarUsageLiveGateway extends CountingFixtureGateway {
  constructor(
    repositoryRoot: string,
    counter: CallCounter,
    private readonly selectedPeerCount: number,
    private readonly audit: AuditRecorder | undefined
  ) {
    super(repositoryRoot, counter, false, "live");
  }

  override estimateCredits(operation: EvidenceOperation): number {
    return operation === "list_locked_peers"
      ? 10
      : super.estimateCredits(operation);
  }

  override estimateRunCredits(): number {
    return 156;
  }

  estimateResolutionCredits(): number {
    return 11;
  }

  override async listLockedPeers(
    targetUrl: string,
    targetSubscriberCount?: number
  ) {
    const peers = await super.listLockedPeers(
      targetUrl,
      targetSubscriberCount
    );
    this.audit?.recordHttpLifecycle({
      phase: "completed",
      method: "POST",
      path: "/v1/creators/similar",
      requestId: `similar-request-${this.selectedPeerCount}`,
      audit: {
        operation: "live.list_locked_peers",
        reason: "Test the provider result count independently of selection",
        estimatedCredits: 10
      },
      meta: {
        providerRequestId: `provider-similar-${this.selectedPeerCount}`,
        latencyMs: 1,
        attempts: [{}]
      },
      usage: {
        rows: 10,
        resultBasedCredits: 10
      }
    });
    return peers.slice(0, this.selectedPeerCount);
  }
}

class HangingLiveGateway extends CountingFixtureGateway {
  constructor(repositoryRoot: string, counter: CallCounter) {
    super(repositoryRoot, counter, false, "live");
  }

  override resolveTarget(): Promise<never> {
    this.counter.values.resolve_target += 1;
    return new Promise<never>(() => undefined);
  }
}

function callCounter(): CallCounter {
  const values: Record<EvidenceOperation, number> = {
    resolve_target: 0,
    list_target_sponsors: 0,
    list_locked_peers: 0,
    list_peer_sponsors: 0,
    load_verification_ledger: 0
  };
  return {
    values,
    total: () =>
      Object.values(values).reduce((sum, count) => sum + count, 0)
  };
}

function runCreditLedgerKey(runId: string): string {
  return `upriver-run-credits-v1:${runId}`;
}

function testRunId(idempotencyKey: string): string {
  return `run_${createHash("sha256")
    .update(`sponsor-radar-workflow\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "sponsor-radar-workflow-")
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForState(
  service: WorkflowService,
  runId: string,
  state: string
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await service.getRun(runId);
    if (run.state.state === state) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not reach ${state}`);
}

function pauseBeforeSnapshotState(
  repository: WorkflowPersistenceRepository,
  state: string
): {
  repository: WorkflowPersistenceRepository;
  reached: Promise<void>;
  release(): void;
} {
  let signalReached = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;

  const proxied = new Proxy(repository, {
    get(target, property) {
      if (property === "saveRunSnapshot") {
        return async (input: SaveRunSnapshotInput<JsonValue>) => {
          const value = input.value;
          const snapshotState =
            value !== null &&
            !Array.isArray(value) &&
            typeof value === "object" &&
            value.state !== null &&
            !Array.isArray(value.state) &&
            typeof value.state === "object"
              ? value.state.state
              : null;
          if (!paused && snapshotState === state) {
            paused = true;
            signalReached();
            await gate;
          }
          return repository.saveRunSnapshot(input);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as WorkflowPersistenceRepository;

  return {
    repository: proxied,
    reached,
    release
  };
}

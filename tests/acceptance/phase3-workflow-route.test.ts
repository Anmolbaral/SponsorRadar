import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as createRun } from "@/app/api/runs/route";
import { GET as getRun } from "@/app/api/runs/[runId]/route";
import { POST as mutateRun } from "@/app/api/runs/[runId]/actions/route";
import { FileSystemWorkflowRepository } from "@/src/radar/adapters/persistence";
import type { Phase3RunResource } from "@/src/radar/application/run-workflow";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("Phase 3 workflow HTTP boundary", () => {
  it("runs the persisted fixture approval journey and resumes it by run ID", async () => {
    await configureFixtureDataDirectory();
    const createdResponse = await createRun(
      request("/api/runs", "create-route-run", {
        channel: "@UrAvgConsumer"
      })
    );
    const created = (await createdResponse.json()) as Phase3RunResource;

    expect(createdResponse.status).toBe(201);
    expect(created.status).toBe("awaiting_plan_approval");
    expect(created.plan).toMatchObject({
      llmCallCeiling: 2,
      llmOutputTokenCeiling: 1200
    });

    const proposalResponse = await action(
      created,
      "approve-plan-route",
      {
        action: "approve_plan",
        expectedVersion: created.version,
        planId: created.plan.planId
      }
    );
    const proposal = (await proposalResponse.json()) as Phase3RunResource;
    expect(proposalResponse.status).toBe(200);
    expect(proposal.status).toBe("awaiting_execution_approval");
    expect(proposal.peerProposal?.peers).toHaveLength(3);
    expect(proposal.peerProposal?.phase4?.status).toBe("generated");
    expect(
      proposal.peerProposal?.peers.every(
        (peer) => peer.rationale?.evidenceIds.length === 2
      )
    ).toBe(true);
    expect(
      proposal.auditEvents.filter(
        (event) => event.eventType === "llm.started"
      )
    ).toHaveLength(1);

    const refreshResponse = await getRun(
      new Request(`http://localhost/api/runs/${created.runId}`),
      context(created.runId)
    );
    const refreshed = (await refreshResponse.json()) as Phase3RunResource;
    expect(refreshResponse.status).toBe(200);
    expect(refreshed.version).toBe(proposal.version);

    const executionBody = {
      action: "approve_execution" as const,
      expectedVersion: refreshed.version,
      proposalId: refreshed.peerProposal!.proposalId,
      quoteId: refreshed.peerProposal!.quote.quoteId,
      approvedCreditCeiling: 0
    };
    const completedResponse = await action(
      refreshed,
      "approve-execution-route",
      executionBody
    );
    const completed = (await completedResponse.json()) as Phase3RunResource;
    expect(completed.status).toBe("completed");
    expect(completed.report?.leads.map((lead) => lead.brand)).toEqual(["Dell"]);
    expect(completed.report?.phase).toBe("phase_4_fixture");
    expect(completed.report?.phase4?.status).toBe("generated");
    expect(completed.report?.phase4?.narratives).toHaveLength(1);
    expect(completed.report?.audit.llmCalls).toBe(2);
    expect(
      completed.auditEvents.filter(
        (event) => event.eventType === "llm.started"
      )
    ).toHaveLength(2);
    expect(
      completed.auditEvents.filter(
        (event) => event.eventType === "llm.failed"
      )
    ).toHaveLength(0);

    const replayResponse = await action(
      refreshed,
      "approve-execution-route",
      executionBody
    );
    const replay = (await replayResponse.json()) as Phase3RunResource;
    expect(replayResponse.status).toBe(200);
    expect(replay.version).toBe(completed.version);
    expect(replay.report).toEqual(completed.report);
  });

  it("keeps an exhausted legacy ledger unchanged while admitting a new per-run ledger", async () => {
    const directory = await configureFixtureDataDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const legacy = await repository.reserveQuota({
      quotaKey: "upriver-phase3-shared-credits",
      runId: "run-before-per-run-accounting",
      idempotencyKey: "legacy-quota-reservation",
      requestedUnits: 200,
      maximumUnits: 200
    });
    await repository.finalizeQuotaReservation({
      quotaKey: "upriver-phase3-shared-credits",
      reservationId: legacy.value.reservationId,
      idempotencyKey: "legacy-quota-settlement",
      outcome: "settled",
      actualUnits: 200
    });
    const legacyBefore = await repository.readQuota(
      "upriver-phase3-shared-credits"
    );
    vi.stubEnv("SPONSOR_RADAR_RUN_CREDIT_LIMIT", "160");

    const createdResponse = await createRun(
      request("/api/runs", "migration-create-run", {
        channel: "@UrAvgConsumer"
      })
    );
    const created = (await createdResponse.json()) as Phase3RunResource;
    const proposalResponse = await action(
      created,
      "migration-approve-plan",
      {
        action: "approve_plan",
        expectedVersion: created.version,
        planId: created.plan.planId
      }
    );

    expect(proposalResponse.status).toBe(200);
    expect(
      ((await proposalResponse.json()) as Phase3RunResource).status
    ).toBe("awaiting_execution_approval");
    expect(
      await repository.readQuota(
        "upriver-phase3-shared-credits"
      )
    ).toEqual(legacyBefore);
    expect(
      await repository.readQuota(
        `upriver-phase3-run-credits-v1:${created.runId}`
      )
    ).toMatchObject({
      maximumUnits: 160,
      activeUnits: 0,
      consumedUnits: 0,
      reservedUnits: 0
    });
    const unchangedLegacy = await repository.readQuota(
      "upriver-phase3-shared-credits"
    );
    expect(unchangedLegacy).toMatchObject({
      maximumUnits: 200,
      activeUnits: 0,
      consumedUnits: 200,
      reservedUnits: 200
    });
    expect(unchangedLegacy?.reservations[0]).toMatchObject({
      reservationId: legacy.value.reservationId,
      maximumUnits: 200,
      status: "settled",
      actualUnits: 200,
      requestFingerprint: legacy.value.requestFingerprint
    });
  });

  it("keeps mode, API keys, and credit policy out of browser-controlled input", async () => {
    await configureFixtureDataDirectory();
    const response = await createRun(
      request("/api/runs", "strict-browser-input", {
        channel: "@UrAvgConsumer",
        mode: "live",
        apiKey: "browser-secret",
        llmMode: "openai",
        openAiApiKey: "browser-openai-secret",
        approvedCreditCeiling: 10_000
      })
    );

    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("browser-secret");
    expect(body).not.toContain(
      "browser-openai-secret"
    );
  });

  it("requires an explicit server-side paid LLM flag with zero fetches", async () => {
    await configureFixtureDataDirectory();
    vi.stubEnv("SPONSOR_RADAR_LLM_MODE", "openai");
    vi.stubEnv("SPONSOR_RADAR_LIVE_LLM", "false");
    vi.stubEnv("OPENAI_API_KEY", "server-openai-secret");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await createRun(
      request("/api/runs", "disabled-openai-run", {
        channel: "@UrAvgConsumer"
      })
    );

    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(
      "server-openai-secret"
    );
  });

  it("requires an explicit server-side live workflow flag with zero fetches", async () => {
    await configureFixtureDataDirectory();
    vi.stubEnv("UPRIVER_MODE", "live");
    vi.stubEnv("UPRIVER_LIVE_WORKFLOW", "false");
    vi.stubEnv("UPRIVER_API_KEY", "server-secret");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await createRun(
      request("/api/runs", "disabled-live-run", {
        channel: "@UrAvgConsumer"
      })
    );

    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(
      "server-secret"
    );
  });

  it("rejects a server run limit above 160 before creating a run", async () => {
    const directory = await configureFixtureDataDirectory();
    vi.stubEnv("SPONSOR_RADAR_RUN_CREDIT_LIMIT", "161");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await createRun(
      request("/api/runs", "invalid-run-credit-limit", {
        channel: "@UrAvgConsumer"
      })
    );

    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error:
        "We couldn’t complete this research right now. Start a new search or try again later.",
      code: "research_unavailable",
      retryable: false
    });
    expect(
      await new FileSystemWorkflowRepository({
        directory
      }).readRunSnapshot(
        `run_${createHash("sha256")
          .update(
            "sponsor-radar-phase3\u0000invalid-run-credit-limit"
          )
          .digest("hex")
          .slice(0, 32)}`
      )
    ).toBeNull();
  });

  it("refuses to continue a persisted run after the server mode changes", async () => {
    await configureFixtureDataDirectory();
    const createdResponse = await createRun(
      request("/api/runs", "mode-drift-run", {
        channel: "@UrAvgConsumer"
      })
    );
    const created = (await createdResponse.json()) as Phase3RunResource;

    vi.stubEnv("UPRIVER_MODE", "live");
    vi.stubEnv("UPRIVER_LIVE_WORKFLOW", "true");
    vi.stubEnv("UPRIVER_API_KEY", "server-secret");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await action(created, "mode-drift-approval", {
      action: "approve_plan",
      expectedVersion: created.version,
      planId: created.plan.planId
    });

    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body).toEqual({
      error:
        "We couldn’t complete this research right now. Start a new search or try again later.",
      code: "research_unavailable",
      retryable: false
    });
    expect(JSON.stringify(body)).not.toMatch(
      /UPRIVER_MODE|fixture|live|API[_ -]?key/i
    );
  });

  it("returns a conflict for a stale action version", async () => {
    await configureFixtureDataDirectory();
    const createdResponse = await createRun(
      request("/api/runs", "stale-route-run", {
        channel: "@UrAvgConsumer"
      })
    );
    const created = (await createdResponse.json()) as Phase3RunResource;

    const response = await action(created, "stale-route-action", {
      action: "approve_plan",
      expectedVersion: created.version + 1,
      planId: created.plan.planId
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "This research changed while it was running. Refresh and try again.",
      code: "run_conflict",
      retryable: true
    });
  });

  it("cancels before approval without creating a report or audit tool events", async () => {
    await configureFixtureDataDirectory();
    const createdResponse = await createRun(
      request("/api/runs", "cancel-route-run", {
        channel: "@UrAvgConsumer"
      })
    );
    const created = (await createdResponse.json()) as Phase3RunResource;
    const response = await action(created, "cancel-route-action", {
      action: "cancel",
      expectedVersion: created.version
    });
    const cancelled = (await response.json()) as Phase3RunResource;

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.report).toBeNull();
    expect(cancelled.auditEvents).toEqual([]);
  });
});

async function action(
  run: Pick<Phase3RunResource, "runId">,
  key: string,
  body: unknown
) {
  return mutateRun(
    request(`/api/runs/${run.runId}/actions`, key, body),
    context(run.runId)
  );
}

function request(pathname: string, key: string, body: unknown): Request {
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify(body)
  });
}

function context(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

async function configureFixtureDataDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "sponsor-radar-phase3-route-")
  );
  temporaryDirectories.push(directory);
  vi.stubEnv("SPONSOR_RADAR_DATA_DIR", directory);
  vi.stubEnv("UPRIVER_MODE", "fixture");
  vi.stubEnv("SPONSOR_RADAR_LLM_MODE", "fixture");
  return directory;
}

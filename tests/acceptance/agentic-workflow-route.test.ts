import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as createRun } from "@/app/api/runs/route";
import { GET as getRun } from "@/app/api/runs/[runId]/route";
import { POST as mutateRun } from "@/app/api/runs/[runId]/actions/route";
import { FileSystemWorkflowRepository } from "@/src/radar/adapters/persistence";
import {
  AGENTIC_RUN_SCHEMA_VERSION,
  type AgenticRunRecord
} from "@/src/radar/application/agentic/agentic-run-service";
import type { WorkflowRunResource } from "@/src/radar/application/run-workflow";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

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

async function configureAgenticFixtureEnvironment(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "sponsor-radar-agentic-route-")
  );
  temporaryDirectories.push(directory);
  vi.stubEnv("SPONSOR_RADAR_DATA_DIR", directory);
  vi.stubEnv("UPRIVER_MODE", "fixture");
  vi.stubEnv("SPONSOR_RADAR_LLM_MODE", "fixture");
  vi.stubEnv("SPONSOR_RADAR_ENGINE", "agentic");
  return directory;
}

describe("Agentic workflow HTTP boundary", () => {
  it("runs one autonomous fixture journey to a terminal report in a single POST", async () => {
    await configureAgenticFixtureEnvironment();

    const created = await createRun(
      request("/api/runs", "agentic-route-journey", {
        channel: "@UrAvgConsumer"
      })
    );
    expect(created.status).toBe(201);
    const run = (await created.json()) as WorkflowRunResource;

    expect(["completed", "partial"]).toContain(run.status);
    expect(run.availableActions).toEqual([]);
    expect(run.peerProposal).toBeNull();
    expect(run.approvals).toEqual({ plan: null, execution: null });
    expect(run.plan.planId.startsWith("plan_agentic_")).toBe(true);
    expect(run.plan.totalCreditCeiling).toBeLessThanOrEqual(160);
    expect(run.accounting).toEqual({
      policy: "per_run_v1",
      maximumCredits: 160
    });
    expect(run.resolvedCohort?.peers.length).toBe(3);
    expect(run.report).not.toBeNull();
    expect(run.report?.methodology.qualificationPolicy).toBe(
      "same_brand_reactivation"
    );
    expect(run.report?.funnel.targetApiRows).toBeGreaterThan(0);
    expect(run.quota.executionCreditsUsed).toBe(0);
    expect(run.workflowEvents.length).toBeGreaterThan(0);

    const fetched = await getRun(
      new Request(`http://localhost/api/runs/${run.runId}`),
      context(run.runId)
    );
    expect(fetched.status).toBe(200);
    const fetchedRun = (await fetched.json()) as WorkflowRunResource;
    expect(fetchedRun.status).toBe(run.status);
    expect(fetchedRun.report?.leads).toEqual(run.report?.leads);
  });

  it("returns the same run for a repeated idempotency key without duplicate work", async () => {
    await configureAgenticFixtureEnvironment();

    const first = (await (
      await createRun(
        request("/api/runs", "agentic-idempotent-key", {
          channel: "@UrAvgConsumer"
        })
      )
    ).json()) as WorkflowRunResource;
    const second = (await (
      await createRun(
        request("/api/runs", "agentic-idempotent-key", {
          channel: "@UrAvgConsumer"
        })
      )
    ).json()) as WorkflowRunResource;

    expect(second.runId).toBe(first.runId);
    expect(second.report?.generatedAt).toBe(first.report?.generatedAt);
  });

  it("refuses approval actions on autonomous runs as conflicts", async () => {
    await configureAgenticFixtureEnvironment();
    const run = (await (
      await createRun(
        request("/api/runs", "agentic-no-approvals", {
          channel: "@UrAvgConsumer"
        })
      )
    ).json()) as WorkflowRunResource;

    const response = await mutateRun(
      request(`/api/runs/${run.runId}/actions`, "agentic-approve-attempt", {
        action: "approve_plan",
        expectedVersion: run.version,
        planId: run.plan.planId
      }),
      context(run.runId)
    );
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { code: string };
    expect(payload.code).toBe("run_conflict");
  });

  it("keeps legacy runs fully readable and actionable while the agentic flag is on", async () => {
    const directory = await configureAgenticFixtureEnvironment();
    vi.stubEnv("SPONSOR_RADAR_ENGINE", "legacy");

    const legacyRun = (await (
      await createRun(
        request("/api/runs", "legacy-before-flip", {
          channel: "@UrAvgConsumer"
        })
      )
    ).json()) as WorkflowRunResource;
    expect(legacyRun.status).toBe("awaiting_plan_approval");

    vi.stubEnv("SPONSOR_RADAR_ENGINE", "agentic");
    vi.stubEnv("SPONSOR_RADAR_DATA_DIR", directory);

    const fetched = await getRun(
      new Request(`http://localhost/api/runs/${legacyRun.runId}`),
      context(legacyRun.runId)
    );
    expect(fetched.status).toBe(200);
    const fetchedRun = (await fetched.json()) as WorkflowRunResource;
    expect(fetchedRun.status).toBe("awaiting_plan_approval");

    const approved = await mutateRun(
      request(
        `/api/runs/${legacyRun.runId}/actions`,
        "legacy-approve-after-flip",
        {
          action: "approve_plan",
          expectedVersion: legacyRun.version,
          planId: legacyRun.plan.planId
        }
      ),
      context(legacyRun.runId)
    );
    expect(approved.status).toBe(200);

    const replayed = (await (
      await createRun(
        request("/api/runs", "legacy-before-flip", {
          channel: "@UrAvgConsumer"
        })
      )
    ).json()) as WorkflowRunResource;
    expect(replayed.runId).toBe(legacyRun.runId);
  });

  it("keeps agentic runs readable after rolling the flag back to legacy", async () => {
    await configureAgenticFixtureEnvironment();
    const agenticRun = (await (
      await createRun(
        request("/api/runs", "agentic-before-rollback", {
          channel: "@UrAvgConsumer"
        })
      )
    ).json()) as WorkflowRunResource;

    vi.stubEnv("SPONSOR_RADAR_ENGINE", "legacy");
    const fetched = await getRun(
      new Request(`http://localhost/api/runs/${agenticRun.runId}`),
      context(agenticRun.runId)
    );
    expect(fetched.status).toBe(200);

    const replayed = (await (
      await createRun(
        request("/api/runs", "agentic-before-rollback", {
          channel: "@UrAvgConsumer"
        })
      )
    ).json()) as WorkflowRunResource;
    expect(replayed.runId).toBe(agenticRun.runId);
  });

  it("fails closed on invalid engine and planner combinations", async () => {
    await configureAgenticFixtureEnvironment();

    vi.stubEnv("SPONSOR_RADAR_LLM_MODE", "disabled");
    let response = await createRun(
      request("/api/runs", "agentic-disabled-llm", {
        channel: "@UrAvgConsumer"
      })
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe(
      "research_unavailable"
    );

    vi.stubEnv("SPONSOR_RADAR_LLM_MODE", "fixture");
    vi.stubEnv("UPRIVER_MODE", "live");
    vi.stubEnv("UPRIVER_LIVE_WORKFLOW", "true");
    vi.stubEnv("UPRIVER_API_KEY", "server-secret");
    response = await createRun(
      request("/api/runs", "agentic-fixture-planner-live", {
        channel: "@UrAvgConsumer"
      })
    );
    expect(response.status).toBe(503);
  });

  it("offers resume on a stale interrupted run and recovers it fail-closed", async () => {
    const directory = await configureAgenticFixtureEnvironment();
    const repository = new FileSystemWorkflowRepository({
      directory: path.join(directory, "agentic")
    });
    const staleIso = new Date(Date.now() - 10 * 60_000).toISOString();
    const runId = `run_${"c".repeat(32)}`;
    const record: AgenticRunRecord = {
      schemaVersion: AGENTIC_RUN_SCHEMA_VERSION,
      engine: "agentic",
      runId,
      requestedChannel: "@UrAvgConsumer",
      mode: "fixture",
      state: {
        state: "gathering_evidence",
        createdAt: staleIso,
        updatedAt: staleIso
      },
      budget: {
        maximumCredits: 160,
        settledCredits: 12,
        iterationsUsed: 4,
        maxIterations: 12
      },
      reservationId: null,
      resolvedCohort: null,
      report: null,
      error: null,
      auditEvents: [],
      llm: { provider: "fixture", model: "agent-planner-fixture-v1" }
    };
    const saved = await repository.saveRunSnapshot({
      runId,
      valueSchemaVersion: AGENTIC_RUN_SCHEMA_VERSION,
      value: structuredClone(record) as never,
      expectedRevision: null
    });

    const fetched = await getRun(
      new Request(`http://localhost/api/runs/${runId}`),
      context(runId)
    );
    const fetchedRun = (await fetched.json()) as WorkflowRunResource;
    expect(fetchedRun.status).toBe("executing");
    expect(fetchedRun.availableActions).toEqual(["resume"]);

    const resumed = await mutateRun(
      request(`/api/runs/${runId}/actions`, "agentic-recover-run", {
        action: "resume",
        expectedVersion: saved.revision
      }),
      context(runId)
    );
    expect(resumed.status).toBe(200);
    const resumedRun = (await resumed.json()) as WorkflowRunResource;
    expect(resumedRun.status).toBe("failed");
    expect(resumedRun.error?.message).toBe(
      "This research was interrupted. Start a new search."
    );
    expect(resumedRun.quota.executionCreditsUsed).toBe(160);
  });
});

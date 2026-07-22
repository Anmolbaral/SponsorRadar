import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunEngineFromEnvironment,
  LiveWorkflowDisabledError
} from "@/src/radar/adapters/run-engine-runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function stubIsolatedDataDirectory(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "run-engine-test-"));
  temporaryDirectories.push(directory);
  vi.stubEnv("SPONSOR_RADAR_DATA_DIR", directory);
}

describe("run engine composition", () => {
  it("composes the agentic engine unconditionally in fixture mode", async () => {
    await stubIsolatedDataDirectory();
    vi.stubEnv("UPRIVER_MODE", "fixture");
    vi.stubEnv("SPONSOR_RADAR_LLM_MODE", "fixture");
    expect(createRunEngineFromEnvironment()).toBeDefined();
  });

  it("fails closed when the run credit limit exceeds the hard ceiling", async () => {
    await stubIsolatedDataDirectory();
    vi.stubEnv("SPONSOR_RADAR_RUN_CREDIT_LIMIT", "161");
    expect(() => createRunEngineFromEnvironment()).toThrow(
      LiveWorkflowDisabledError
    );
  });

  it("fails closed when the planner LLM is disabled", async () => {
    await stubIsolatedDataDirectory();
    vi.stubEnv("SPONSOR_RADAR_LLM_MODE", "disabled");
    expect(() => createRunEngineFromEnvironment()).toThrow(
      LiveWorkflowDisabledError
    );
  });

  it("refuses a scripted fixture planner over live paid evidence", async () => {
    await stubIsolatedDataDirectory();
    vi.stubEnv("UPRIVER_MODE", "live");
    vi.stubEnv("UPRIVER_LIVE_WORKFLOW", "true");
    vi.stubEnv("UPRIVER_API_KEY", "server-secret");
    vi.stubEnv("SPONSOR_RADAR_LLM_MODE", "fixture");
    expect(() => createRunEngineFromEnvironment()).toThrow(
      LiveWorkflowDisabledError
    );
  });
});

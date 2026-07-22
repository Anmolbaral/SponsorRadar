import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunEngineFromEnvironment,
  runEngineKind
} from "@/src/radar/adapters/run-engine-runtime";
import { LiveWorkflowDisabledError } from "@/src/radar/adapters/workflow-runtime";

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

describe("run engine selection", () => {
  it("defaults to the legacy engine when the flag is unset", async () => {
    await stubIsolatedDataDirectory();
    expect(runEngineKind()).toBe("legacy");
    expect(createRunEngineFromEnvironment()).toBeDefined();
  });

  it("selects the legacy engine explicitly", () => {
    vi.stubEnv("SPONSOR_RADAR_ENGINE", "legacy");
    expect(runEngineKind()).toBe("legacy");
  });

  it("fails closed on unknown engine values", () => {
    vi.stubEnv("SPONSOR_RADAR_ENGINE", "experimental");
    expect(() => createRunEngineFromEnvironment()).toThrow(
      LiveWorkflowDisabledError
    );
  });

  it("fails closed on browser-cased values instead of coercing", () => {
    vi.stubEnv("SPONSOR_RADAR_ENGINE", "Agentic");
    expect(() => createRunEngineFromEnvironment()).toThrow(
      LiveWorkflowDisabledError
    );
  });
});

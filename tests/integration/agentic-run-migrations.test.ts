import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemWorkflowRepository } from "@/src/radar/adapters/persistence";
import {
  AGENTIC_RUN_SCHEMA_VERSION,
  AgenticRunCorruptionError,
  mapAgenticRunToResource,
  parseAgenticRun
} from "@/src/radar/application/agentic/agentic-run-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function loadSanitizedRecord(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(
        process.cwd(),
        "tests/fixtures/persistence/agentic-v1-sanitized.json"
      ),
      "utf8"
    )
  );
}

describe("agentic-v1 persisted records", () => {
  it("parses the sanitized checked-in record and maps it to the wire shape", async () => {
    const record = parseAgenticRun(await loadSanitizedRecord());
    expect(record.schemaVersion).toBe(AGENTIC_RUN_SCHEMA_VERSION);

    const resource = mapAgenticRunToResource(record, 3, {
      leaseExpired: false,
      storedEvents: []
    });
    expect(resource.schemaVersion).toBe(4);
    expect(resource.status).toBe("completed");
    expect(resource.state.state).toBe("completed");
    expect(resource.availableActions).toEqual([]);
    expect(resource.plan.planId.startsWith("plan_agentic_")).toBe(true);
    expect(resource.peerProposal).toBeNull();
    expect(resource.version).toBe(3);
  });

  it("fails closed on unknown schema versions and mutated states", async () => {
    const record = (await loadSanitizedRecord()) as Record<string, unknown>;
    expect(() =>
      parseAgenticRun({ ...record, schemaVersion: "agentic-v2" })
    ).toThrow(AgenticRunCorruptionError);
    expect(() =>
      parseAgenticRun({
        ...record,
        state: {
          state: "definitely_not_a_state",
          createdAt: "2026-07-22T00:00:00.000Z",
          updatedAt: "2026-07-22T00:00:00.000Z"
        }
      })
    ).toThrow(AgenticRunCorruptionError);
    expect(() => parseAgenticRun(null)).toThrow(AgenticRunCorruptionError);
  });

  it("stores agentic records in a directory the legacy store never reads", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "sponsor-radar-agentic-store-")
    );
    temporaryDirectories.push(directory);
    const agenticRepository = new FileSystemWorkflowRepository({
      directory: path.join(directory, "agentic")
    });
    const legacyRepository = new FileSystemWorkflowRepository({ directory });

    const record = await loadSanitizedRecord();
    const runId = (record as { runId: string }).runId;
    await agenticRepository.saveRunSnapshot({
      runId,
      valueSchemaVersion: AGENTIC_RUN_SCHEMA_VERSION,
      value: structuredClone(record) as never,
      expectedRevision: null
    });

    expect(await legacyRepository.readRunSnapshot(runId)).toBeNull();
    expect(await agenticRepository.readRunSnapshot(runId)).not.toBeNull();
  });
});

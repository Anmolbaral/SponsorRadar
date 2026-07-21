import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemWorkflowRepository } from "@/src/radar/adapters/persistence";
import { WorkflowService } from "@/src/radar/application/run-workflow";

const fixtureDirectory = path.join(
  process.cwd(),
  "tests/fixtures/persistence"
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("persisted workflow migration fixtures", () => {
  it.each([
    {
      fixture: "schema-v1-planned-sanitized.json",
      expectedStatus: "awaiting_plan_approval",
      expectedState: "planned",
      expectedOutcome: null,
      expectedReport: false
    },
    {
      fixture: "schema-v1-completed-sanitized.json",
      expectedStatus: "completed",
      expectedState: "completed",
      expectedOutcome: "opportunities_found",
      expectedReport: true
    }
  ] as const)(
    "restores $fixture read-only without provider construction",
    async ({
      fixture,
      expectedStatus,
      expectedState,
      expectedOutcome,
      expectedReport
    }) => {
      const source = path.join(fixtureDirectory, fixture);
      const sourceBytes = await readFile(source);
      const persisted = JSON.parse(sourceBytes.toString("utf8")) as {
        runId: string;
      };
      const directory = await mkdtemp(
        path.join(tmpdir(), "sponsor-radar-schema-v1-")
      );
      temporaryDirectories.push(directory);
      const runDirectory = path.join(directory, "runs");
      await mkdir(runDirectory, { recursive: true });
      const storedPath = path.join(
        runDirectory,
        `${sha256(persisted.runId)}.json`
      );
      await copyFile(source, storedPath);

      const repository = new FileSystemWorkflowRepository({ directory });
      let gatewayConstructions = 0;
      const service = new WorkflowService({
        repository,
        gatewayFactory: () => {
          gatewayConstructions += 1;
          throw new Error("Migration reads must not construct a gateway");
        }
      });

      const restored = await service.getRun(persisted.runId);

      expect(restored.schemaVersion).toBe(4);
      expect(restored.accounting).toEqual({
        policy: "legacy_shared_v1",
        maximumCredits: 0
      });
      expect(restored.wordingAgent).toEqual({
        enabled: false,
        provider: "disabled",
        model: "disabled",
        peerRationale: {
          status: "not_needed",
          inputFingerprint: null
        },
        reportWording: {
          status: "not_needed",
          inputFingerprint: null
        }
      });
      expect(restored.status).toBe(expectedStatus);
      expect(restored.state.state).toBe(expectedState);
      expect(restored.outcome).toBe(expectedOutcome);
      expect(Boolean(restored.report)).toBe(expectedReport);
      if (restored.report) {
        expect(restored.report.targetIdentity).toBeNull();
        expect(restored.peerProposal?.identity).toBeNull();
      }
      expect(gatewayConstructions).toBe(0);
      expect(await readFile(storedPath)).toEqual(sourceBytes);
    }
  );
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

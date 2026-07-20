import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileSystemWorkflowRepository,
  PersistenceConflictError,
  SensitivePersistenceValueError
} from "@/src/radar/adapters/persistence";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    )
  );
});

describe("FileSystemWorkflowRepository", () => {
  it("persists versioned run snapshots across repository restarts", async () => {
    const root = await temporaryRoot();
    let now = Date.parse("2026-07-19T12:00:00.000Z");
    const firstProcess = repository(root, () => now);

    const initial = await firstProcess.saveRunSnapshot({
      runId: "run-restart",
      valueSchemaVersion: 3,
      expectedRevision: null,
      value: {
        status: "submitted",
        target: "@UrAvgConsumer"
      }
    });

    expect(initial).toMatchObject({
      revision: 1,
      valueSchemaVersion: 3,
      savedAt: "2026-07-19T12:00:00.000Z"
    });

    now += 1_000;
    const restartedProcess = repository(root, () => now);
    expect(await restartedProcess.readRunSnapshot("run-restart")).toEqual(
      initial
    );

    const updated = await restartedProcess.saveRunSnapshot({
      runId: "run-restart",
      valueSchemaVersion: 3,
      expectedRevision: 1,
      value: {
        status: "planned",
        target: "@UrAvgConsumer"
      }
    });
    expect(updated).toMatchObject({
      revision: 2,
      savedAt: "2026-07-19T12:00:01.000Z",
      value: { status: "planned" }
    });
    await expect(
      firstProcess.saveRunSnapshot({
        runId: "run-restart",
        valueSchemaVersion: 3,
        expectedRevision: 1,
        value: { status: "stale-writer" }
      })
    ).rejects.toBeInstanceOf(PersistenceConflictError);
  });

  it("keeps events append-only, ordered, and durable across restarts", async () => {
    const root = await temporaryRoot();
    let now = Date.parse("2026-07-19T13:00:00.000Z");
    const firstProcess = repository(root, () => now);

    const first = await firstProcess.appendRunEvent({
      runId: "run-events",
      eventSchemaVersion: 1,
      event: { type: "run.submitted" }
    });
    const firstEventPath = (await jsonFilesUnder(join(root, "events")))[0];
    const originalBytes = await readFile(firstEventPath, "utf8");

    now += 10;
    const restartedProcess = repository(root, () => now);
    const second = await restartedProcess.appendRunEvent({
      runId: "run-events",
      eventSchemaVersion: 1,
      event: { type: "run.planned" }
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(await readFile(firstEventPath, "utf8")).toBe(originalBytes);
    expect(await jsonFilesUnder(join(root, "events"))).toHaveLength(2);
    expect(await firstProcess.readRunEvents("run-events")).toEqual([
      first,
      second
    ]);
  });

  it("reports cache miss, hit, schema mismatch, expiry, and corruption", async () => {
    const root = await temporaryRoot();
    let now = Date.parse("2026-07-19T14:00:00.000Z");
    const cache = repository(root, () => now);
    const lookup = {
      namespace: "upriver.peer-sponsors",
      key: "youtube:@Dave2D:90-days",
      valueSchemaVersion: "sponsors-v1"
    };

    expect(await cache.getCache(lookup)).toEqual({
      status: "miss",
      value: null,
      metadata: null
    });

    await cache.putCache({
      ...lookup,
      ttlMs: 100,
      value: { sponsors: ["Dell"] }
    });
    expect(await repository(root, () => now).getCache(lookup)).toMatchObject({
      status: "hit",
      value: { sponsors: ["Dell"] }
    });
    expect(
      await cache.getCache({ ...lookup, valueSchemaVersion: "sponsors-v2" })
    ).toMatchObject({
      status: "schema_mismatch",
      value: null
    });

    now += 100;
    expect(await cache.getCache(lookup)).toMatchObject({
      status: "expired",
      value: null
    });

    now += 1;
    await cache.putCache({
      ...lookup,
      ttlMs: 500,
      value: { sponsors: ["Dell", "Framework"] }
    });
    const cacheFiles = await jsonFilesUnder(join(root, "cache"));
    expect(cacheFiles).toHaveLength(1);
    await writeFile(cacheFiles[0], "{broken-json", "utf8");
    expect(await cache.getCache(lookup)).toEqual({
      status: "corrupt",
      value: null,
      metadata: null
    });
  });

  it("records approvals and quota reservations idempotently", async () => {
    const root = await temporaryRoot();
    let now = Date.parse("2026-07-19T15:00:00.000Z");
    const firstProcess = repository(root, () => now);
    const approvalInput = {
      runId: "run-idempotent",
      idempotencyKey: "approve-peers-command-1",
      action: "approve_peer_cohort",
      decision: "approved" as const,
      decidedBy: "user-1",
      details: { peers: ["@Dave2D"] }
    };

    const firstApproval =
      await firstProcess.recordApproval(approvalInput);
    now += 1;
    const restartedProcess = repository(root, () => now);
    const duplicateApproval =
      await restartedProcess.recordApproval(approvalInput);

    expect(firstApproval.created).toBe(true);
    expect(duplicateApproval).toEqual({
      created: false,
      value: firstApproval.value
    });
    expect(await restartedProcess.listApprovals("run-idempotent")).toEqual([
      firstApproval.value
    ]);
    await expect(
      restartedProcess.recordApproval({
        ...approvalInput,
        decision: "denied"
      })
    ).rejects.toBeInstanceOf(PersistenceConflictError);

    const reservationInput = {
      quotaKey: "upriver:2026-07",
      runId: "run-idempotent",
      idempotencyKey: "quota-command-1",
      requestedUnits: 8,
      maximumUnits: 10
    };
    const firstReservation =
      await firstProcess.reserveQuota(reservationInput);
    const duplicateReservation =
      await restartedProcess.reserveQuota(reservationInput);
    expect(firstReservation.created).toBe(true);
    expect(firstReservation.value).toMatchObject({
      decision: "reserved",
      status: "active",
      actualUnits: null
    });
    expect(duplicateReservation).toEqual({
      created: false,
      value: firstReservation.value
    });
    expect(await restartedProcess.readQuota("upriver:2026-07")).toMatchObject({
      activeUnits: 8,
      consumedUnits: 0,
      reservedUnits: 8,
      remainingUnits: 2,
      exceededUnits: 0
    });

    const denied = await restartedProcess.reserveQuota({
      quotaKey: "upriver:2026-07",
      runId: "run-other",
      idempotencyKey: "quota-command-2",
      requestedUnits: 3,
      maximumUnits: 10
    });
    expect(denied.value).toMatchObject({
      decision: "denied",
      status: "released",
      actualUnits: 0
    });
    expect(
      (await restartedProcess.readQuota("upriver:2026-07"))?.reservedUnits
    ).toBe(8);
  });

  it("settles or releases quota exactly once under concurrent retries", async () => {
    const root = await temporaryRoot();
    let now = Date.parse("2026-07-19T16:00:00.000Z");
    const firstProcess = repository(root, () => now);
    const secondProcess = repository(root, () => now);
    const reservation = await firstProcess.reserveQuota({
      quotaKey: "upriver:shared",
      runId: "run-settle",
      idempotencyKey: "reserve-settle",
      requestedUnits: 9,
      maximumUnits: 12
    });
    const settleInput = {
      quotaKey: "upriver:shared",
      reservationId: reservation.value.reservationId,
      idempotencyKey: "settle-command",
      outcome: "settled" as const,
      actualUnits: 4
    };

    now += 10;
    const settledRetries = await Promise.all([
      firstProcess.finalizeQuotaReservation(settleInput),
      secondProcess.finalizeQuotaReservation(settleInput)
    ]);
    expect(settledRetries.map((result) => result.created).sort()).toEqual([
      false,
      true
    ]);
    expect(settledRetries[0].value).toMatchObject({
      status: "settled",
      actualUnits: 4
    });
    expect(await firstProcess.readQuota("upriver:shared")).toMatchObject({
      activeUnits: 0,
      consumedUnits: 4,
      reservedUnits: 4,
      remainingUnits: 8
    });
    await expect(
      firstProcess.finalizeQuotaReservation({
        ...settleInput,
        actualUnits: 5
      })
    ).rejects.toBeInstanceOf(PersistenceConflictError);

    const cancellation = await secondProcess.reserveQuota({
      quotaKey: "upriver:shared",
      runId: "run-cancel",
      idempotencyKey: "reserve-cancel",
      requestedUnits: 7,
      maximumUnits: 12
    });
    const releaseInput = {
      quotaKey: "upriver:shared",
      reservationId: cancellation.value.reservationId,
      idempotencyKey: "release-command",
      outcome: "released" as const
    };
    const releaseRetries = await Promise.all([
      secondProcess.finalizeQuotaReservation(releaseInput),
      firstProcess.finalizeQuotaReservation(releaseInput)
    ]);
    expect(releaseRetries.map((result) => result.created).sort()).toEqual([
      false,
      true
    ]);
    expect(await repository(root, () => now).readQuota("upriver:shared")).toMatchObject({
      activeUnits: 0,
      consumedUnits: 4,
      reservedUnits: 4,
      remainingUnits: 8
    });
  });

  it("safely increases an idle quota while preserving historical accounting", async () => {
    const root = await temporaryRoot();
    let now = Date.parse("2026-07-19T16:30:00.000Z");
    const persistence = repository(root, () => now);
    const originalInput = {
      quotaKey: "upriver:policy-increase",
      runId: "run-before-increase",
      idempotencyKey: "reserve-before-increase",
      requestedUnits: 8,
      maximumUnits: 10
    };
    const original = await persistence.reserveQuota(originalInput);
    now += 1;
    await persistence.finalizeQuotaReservation({
      quotaKey: originalInput.quotaKey,
      reservationId: original.value.reservationId,
      idempotencyKey: "settle-before-increase",
      outcome: "settled",
      actualUnits: 4
    });
    const originalFingerprint = original.value.requestFingerprint;

    now += 1;
    const afterIncrease = await persistence.reserveQuota({
      quotaKey: originalInput.quotaKey,
      runId: "run-after-increase",
      idempotencyKey: "reserve-after-increase",
      requestedUnits: 5,
      maximumUnits: 20
    });

    expect(afterIncrease.value).toMatchObject({
      maximumUnits: 20,
      decision: "reserved",
      status: "active"
    });
    const migrated = await persistence.readQuota(originalInput.quotaKey);
    expect(migrated).toMatchObject({
      maximumUnits: 20,
      activeUnits: 5,
      consumedUnits: 4,
      reservedUnits: 9,
      remainingUnits: 11,
      exceededUnits: 0
    });
    expect(migrated?.reservations).toHaveLength(2);
    expect(migrated?.reservations[0]).toMatchObject({
      reservationId: original.value.reservationId,
      maximumUnits: 10,
      requestedUnits: 8,
      actualUnits: 4,
      status: "settled",
      requestFingerprint: originalFingerprint
    });

    // An exact historical replay remains idempotent after migration even
    // though its request used the earlier policy ceiling.
    expect(await persistence.reserveQuota(originalInput)).toEqual({
      created: false,
      value: migrated?.reservations[0]
    });

    const quotaFiles = await jsonFilesUnder(join(root, "quota"));
    const rawLedger = JSON.parse(
      await readFile(quotaFiles[0], "utf8")
    ) as {
      maximumUnits: number;
      reservations: Array<{
        maximumUnits: number;
        requestFingerprint: string;
      }>;
    };
    expect(rawLedger.maximumUnits).toBe(20);
    expect(rawLedger.reservations[0]).toMatchObject({
      maximumUnits: 10,
      requestFingerprint: originalFingerprint
    });
  });

  it("fails closed on a quota increase while a reservation is active", async () => {
    const root = await temporaryRoot();
    let now = Date.parse("2026-07-19T16:40:00.000Z");
    const persistence = repository(root, () => now);
    const active = await persistence.reserveQuota({
      quotaKey: "upriver:active-policy",
      runId: "run-active",
      idempotencyKey: "reserve-active",
      requestedUnits: 8,
      maximumUnits: 10
    });
    const increasedInput = {
      quotaKey: "upriver:active-policy",
      runId: "run-after-active",
      idempotencyKey: "reserve-after-active",
      requestedUnits: 5,
      maximumUnits: 20
    };

    await expect(
      persistence.reserveQuota(increasedInput)
    ).rejects.toThrow("while reservations are active");
    expect(await persistence.readQuota("upriver:active-policy")).toMatchObject({
      maximumUnits: 10,
      activeUnits: 8,
      reservedUnits: 8,
      remainingUnits: 2
    });

    now += 1;
    await persistence.finalizeQuotaReservation({
      quotaKey: "upriver:active-policy",
      reservationId: active.value.reservationId,
      idempotencyKey: "release-active",
      outcome: "released"
    });
    now += 1;
    await expect(
      persistence.reserveQuota(increasedInput)
    ).resolves.toMatchObject({
      created: true,
      value: {
        maximumUnits: 20,
        decision: "reserved",
        status: "active"
      }
    });
  });

  it("never decreases a persisted quota ceiling", async () => {
    const root = await temporaryRoot();
    const persistence = repository(
      root,
      () => Date.parse("2026-07-19T16:50:00.000Z")
    );
    await persistence.reserveQuota({
      quotaKey: "upriver:no-decrease",
      runId: "run-current-policy",
      idempotencyKey: "reserve-current-policy",
      requestedUnits: 3,
      maximumUnits: 20
    });
    const before = await persistence.readQuota("upriver:no-decrease");

    await expect(
      persistence.reserveQuota({
        quotaKey: "upriver:no-decrease",
        runId: "run-stale-policy",
        idempotencyKey: "reserve-stale-policy",
        requestedUnits: 1,
        maximumUnits: 10
      })
    ).rejects.toThrow("maximumUnits cannot decrease from 20 to 10");
    expect(await persistence.readQuota("upriver:no-decrease")).toEqual(before);
  });

  it("serializes concurrent event and snapshot writes across instances", async () => {
    const root = await temporaryRoot();
    let now = Date.parse("2026-07-19T17:00:00.000Z");
    const firstProcess = repository(root, () => now++);
    const secondProcess = repository(root, () => now++);

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? firstProcess : secondProcess).appendRunEvent({
          runId: "run-concurrent",
          eventSchemaVersion: 1,
          event: { index }
        })
      )
    );
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? firstProcess : secondProcess).saveRunSnapshot({
          runId: "run-concurrent",
          valueSchemaVersion: 1,
          value: { writer: index }
        })
      )
    );

    const events = await firstProcess.readRunEvents<{ index: number }>(
      "run-concurrent"
    );
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1)
    );
    expect(
      events.map((event) => event.event.index).sort((left, right) => left - right)
    ).toEqual(Array.from({ length: 40 }, (_, index) => index));
    expect(
      (await secondProcess.readRunSnapshot("run-concurrent"))?.revision
    ).toBe(20);
    expect(await jsonFilesUnder(join(root, "events"))).toHaveLength(40);
    expect(await jsonFilesUnder(join(root, "runs"))).toHaveLength(1);
  });

  it(
    "never steals an old live lock and recovers after its child owner dies",
    async () => {
      const root = await temporaryRoot();
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", CHILD_LOCK_HOLDER, root],
        { stdio: ["ignore", "pipe", "pipe"] }
      );

      try {
        await waitForChildReady(child);
        const persistence = repository(root, Date.now);
        let settled = false;
        const write = persistence
          .saveRunSnapshot({
            runId: "run-child-lock",
            valueSchemaVersion: 1,
            expectedRevision: null,
            value: { status: "submitted" }
          })
          .finally(() => {
            settled = true;
          });

        // The child deliberately backdates the lock by two minutes. Age must
        // never be sufficient to steal it while its PID is still alive.
        await testDelay(150);
        expect(settled).toBe(false);
        expect(child.exitCode).toBeNull();

        // Simulate an unclean owner crash. The waiting writer should prove the
        // PID is gone, recover the abandoned lock, and complete.
        await stopChild(child);
        await expect(write).resolves.toMatchObject({
          runId: "run-child-lock",
          revision: 1
        });
        await expect(
          stat(join(root, ".workflow.lock"))
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          stat(join(root, ".workflow.lock.recovery"))
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await stopChild(child);
      }
    },
    10_000
  );

  it("rejects credential-like fields before durable storage", async () => {
    const root = await temporaryRoot();
    const persistence = repository(root, Date.now);

    await expect(
      persistence.saveRunSnapshot({
        runId: "run-secret",
        valueSchemaVersion: 1,
        value: { apiKey: "do-not-persist" }
      })
    ).rejects.toBeInstanceOf(SensitivePersistenceValueError);
    await expect(
      persistence.appendRunEvent({
        runId: "run-secret",
        eventSchemaVersion: 1,
        event: {
          headers: { authorization: "Bearer do-not-persist" }
        }
      })
    ).rejects.toBeInstanceOf(SensitivePersistenceValueError);
    await expect(
      persistence.putCache({
        namespace: "unsafe",
        key: "unsafe",
        valueSchemaVersion: 1,
        ttlMs: 100,
        value: { refresh_token: "do-not-persist" }
      })
    ).rejects.toBeInstanceOf(SensitivePersistenceValueError);

    const files = await jsonFilesUnder(root);
    const contents = await Promise.all(
      files.map((path) => readFile(path, "utf8"))
    );
    expect(contents.join("")).not.toContain("do-not-persist");
  });
});

function repository(root: string, clock: () => number) {
  return new FileSystemWorkflowRepository({ directory: root, clock });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sponsor-radar-persistence-"));
  temporaryRoots.push(root);
  return root;
}

async function jsonFilesUnder(root: string): Promise<string[]> {
  try {
    if (!(await stat(root)).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await jsonFilesUnder(path)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      output.push(path);
    }
  }
  return output.sort();
}

const CHILD_LOCK_HOLDER = `
  import { mkdir, open, utimes } from "node:fs/promises";
  import { join } from "node:path";

  const root = process.argv[1];
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, ".workflow.lock");
  const handle = await open(lockPath, "wx", 0o600);
  await handle.writeFile(
    JSON.stringify({
      lockVersion: 1,
      pid: process.pid,
      token: "child-owner-" + process.pid,
      createdAt: new Date().toISOString()
    }) + "\\n",
    "utf8"
  );
  await handle.sync();
  const old = new Date(Date.now() - 120_000);
  await utimes(lockPath, old, old);
  process.stdout.write("ready\\n");
  setInterval(() => undefined, 1_000);
`;

async function waitForChildReady(
  child: ReturnType<typeof spawn>
): Promise<void> {
  if (!child.stdout || !child.stderr) {
    throw new Error("Child lock holder requires piped output");
  }
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  await Promise.race([
    once(child.stdout, "data").then(([chunk]) => {
      if (!String(chunk).includes("ready")) {
        throw new Error(`Unexpected child output: ${String(chunk)}`);
      }
    }),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(
        `Child lock holder exited before ready (${String(code)}, ${String(
          signal
        )}): ${stderr}`
      );
    })
  ]);
}

async function stopChild(
  child: ReturnType<typeof spawn>
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

function testDelay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

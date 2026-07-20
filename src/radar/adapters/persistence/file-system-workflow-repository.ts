import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  AppendRunEventInput,
  CacheEntryMetadata,
  CacheLookup,
  FinalizeQuotaReservationInput,
  GetCacheInput,
  IdempotentWriteResult,
  JsonValue,
  PutCacheInput,
  QuotaSnapshot,
  RecordApprovalInput,
  ReserveQuotaInput,
  SaveRunSnapshotInput,
  StoredApproval,
  StoredCacheEntry,
  StoredQuotaReservation,
  StoredRunEvent,
  StoredRunSnapshot,
  ValueSchemaVersion,
  WorkflowPersistenceRepository
} from "./types";

const STORAGE_VERSION = 1 as const;
const IDENTIFIER_LIMIT = 2_048;
const EVENT_SEQUENCE_WIDTH = 12;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const WORKFLOW_LOCK_VERSION = 1 as const;

const rootTails = new Map<string, Promise<void>>();

export interface FileSystemWorkflowRepositoryOptions {
  directory: string;
  clock?: () => number;
}

interface StoredQuotaLedger {
  storageVersion: 1;
  quotaKeyHash: string;
  maximumUnits: number;
  updatedAt: string;
  reservations: StoredQuotaReservation[];
}

interface ParsedFile<T> {
  found: boolean;
  value: T | null;
}

interface WorkflowLockOwner {
  lockVersion: 1;
  pid: number;
  token: string;
  createdAt: string;
}

type WorkflowLockRead =
  | {
      status: "valid";
      pid: number;
      token: string | null;
      contents: string;
    }
  | { status: "missing" }
  | { status: "invalid" };

export class PersistenceConflictError extends Error {
  readonly code = "persistence_conflict";

  constructor(message: string) {
    super(message);
    this.name = "PersistenceConflictError";
  }
}

export class PersistenceCorruptionError extends Error {
  readonly code = "persistence_corruption";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersistenceCorruptionError";
  }
}

export class SensitivePersistenceValueError extends Error {
  readonly code = "sensitive_persistence_value";

  constructor(path: string) {
    super(`Refusing to persist a credential-like field at ${path}`);
    this.name = "SensitivePersistenceValueError";
  }
}

/**
 * Server-only workflow persistence for one Node.js process.
 *
 * Mutable documents use write-fsync-rename replacement. Events use immutable
 * write-fsync-link creation, so an existing event is never overwritten.
 * Operations for the same resolved root share a process-wide queue and a
 * filesystem lock, including operations made through separate Node processes.
 *
 * Generic payloads must already be safe for durable storage. As a defensive
 * boundary, the repository rejects non-JSON data and credential-like field
 * names. Cache keys and idempotency keys are persisted only as SHA-256 hashes.
 */
export class FileSystemWorkflowRepository
  implements WorkflowPersistenceRepository
{
  readonly directory: string;
  private readonly clock: () => number;

  constructor(options: FileSystemWorkflowRepositoryOptions) {
    assertServerRuntime();
    assertText("directory", options.directory);
    this.directory = resolve(
      /*turbopackIgnore: true*/
      options.directory
    );
    this.clock = options.clock ?? Date.now;
  }

  async saveRunSnapshot<T extends JsonValue>(
    input: SaveRunSnapshotInput<T>
  ): Promise<StoredRunSnapshot<T>> {
    assertIdentifier("runId", input.runId);
    assertSchemaVersion(input.valueSchemaVersion);
    const value = safeJsonClone(input.value, "$.value") as T;
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== null
    ) {
      assertNonNegativeInteger("expectedRevision", input.expectedRevision);
    }

    return this.serialized(async () => {
      const path = this.runPath(input.runId);
      const parsed = await readJsonFile(path);
      const current = parsed.found
        ? parseRunSnapshot<JsonValue>(parsed.value, path, input.runId)
        : null;
      const currentRevision = current?.revision ?? null;

      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== currentRevision
      ) {
        throw new PersistenceConflictError(
          `Run ${input.runId} is at revision ${String(currentRevision)}, ` +
            `not ${String(input.expectedRevision)}`
        );
      }

      const snapshot: StoredRunSnapshot<T> = {
        storageVersion: STORAGE_VERSION,
        runId: input.runId,
        revision: (current?.revision ?? 0) + 1,
        valueSchemaVersion: input.valueSchemaVersion,
        savedAt: this.nowIso(),
        value
      };
      await atomicReplace(path, canonicalJson(snapshot));
      return snapshot;
    });
  }

  async readRunSnapshot<T extends JsonValue = JsonValue>(
    runId: string
  ): Promise<StoredRunSnapshot<T> | null> {
    assertIdentifier("runId", runId);
    return this.serialized(async () => {
      const path = this.runPath(runId);
      const parsed = await readJsonFile(path);
      return parsed.found ? parseRunSnapshot<T>(parsed.value, path, runId) : null;
    });
  }

  async appendRunEvent<T extends JsonValue>(
    input: AppendRunEventInput<T>
  ): Promise<StoredRunEvent<T>> {
    assertIdentifier("runId", input.runId);
    assertSchemaVersion(input.eventSchemaVersion);
    const eventValue = safeJsonClone(input.event, "$.event") as T;

    return this.serialized(async () => {
      const existing = await this.readRunEventsUnlocked<JsonValue>(input.runId);
      const sequence = (existing.at(-1)?.sequence ?? 0) + 1;
      const event: StoredRunEvent<T> = {
        storageVersion: STORAGE_VERSION,
        runId: input.runId,
        sequence,
        eventSchemaVersion: input.eventSchemaVersion,
        occurredAt: this.nowIso(),
        event: eventValue
      };
      const path = join(
        this.eventDirectory(input.runId),
        `${String(sequence).padStart(EVENT_SEQUENCE_WIDTH, "0")}.json`
      );
      await atomicCreate(path, canonicalJson(event));
      return event;
    });
  }

  async readRunEvents<T extends JsonValue = JsonValue>(
    runId: string
  ): Promise<StoredRunEvent<T>[]> {
    assertIdentifier("runId", runId);
    return this.serialized(() => this.readRunEventsUnlocked<T>(runId));
  }

  async recordApproval<T extends JsonValue>(
    input: RecordApprovalInput<T>
  ): Promise<IdempotentWriteResult<StoredApproval<T>>> {
    assertIdentifier("runId", input.runId);
    assertIdentifier("idempotencyKey", input.idempotencyKey);
    assertText("action", input.action);
    assertText("decidedBy", input.decidedBy);
    if (input.decision !== "approved" && input.decision !== "denied") {
      throw new TypeError("decision must be approved or denied");
    }
    const details =
      input.details === undefined
        ? undefined
        : (safeJsonClone(input.details, "$.details") as T);
    const idempotencyKeyHash = digest(input.idempotencyKey);
    const requestFingerprint = digest(
      canonicalJson({
        runId: input.runId,
        action: input.action,
        decision: input.decision,
        decidedBy: input.decidedBy,
        details: details ?? null
      })
    );

    return this.serialized(async () => {
      const path = this.approvalPath(input.runId, input.idempotencyKey);
      const parsed = await readJsonFile(path);
      if (parsed.found) {
        const existing = parseApproval<T>(parsed.value, path, input.runId);
        assertIdempotentRequest(
          "approval",
          existing.requestFingerprint,
          requestFingerprint
        );
        return { created: false, value: existing };
      }

      const approval: StoredApproval<T> = {
        storageVersion: STORAGE_VERSION,
        approvalId: `approval_${digest(
          `${input.runId}\0${input.idempotencyKey}`
        ).slice(0, 32)}`,
        runId: input.runId,
        action: input.action,
        decision: input.decision,
        decidedBy: input.decidedBy,
        decidedAt: this.nowIso(),
        idempotencyKeyHash,
        requestFingerprint,
        ...(details === undefined ? {} : { details })
      };
      await atomicCreate(path, canonicalJson(approval));
      return { created: true, value: approval };
    });
  }

  async readApproval<T extends JsonValue = JsonValue>(
    runId: string,
    idempotencyKey: string
  ): Promise<StoredApproval<T> | null> {
    assertIdentifier("runId", runId);
    assertIdentifier("idempotencyKey", idempotencyKey);
    return this.serialized(async () => {
      const path = this.approvalPath(runId, idempotencyKey);
      const parsed = await readJsonFile(path);
      return parsed.found ? parseApproval<T>(parsed.value, path, runId) : null;
    });
  }

  async listApprovals<T extends JsonValue = JsonValue>(
    runId: string
  ): Promise<StoredApproval<T>[]> {
    assertIdentifier("runId", runId);
    return this.serialized(async () => {
      const directory = this.approvalDirectory(runId);
      const names = await listJsonFiles(directory);
      const approvals: StoredApproval<T>[] = [];
      for (const name of names) {
        const path = join(directory, name);
        const parsed = await readJsonFile(path);
        if (!parsed.found) {
          continue;
        }
        approvals.push(parseApproval<T>(parsed.value, path, runId));
      }
      return approvals.sort((left, right) =>
        left.decidedAt.localeCompare(right.decidedAt)
      );
    });
  }

  async reserveQuota(
    input: ReserveQuotaInput
  ): Promise<IdempotentWriteResult<StoredQuotaReservation>> {
    assertIdentifier("quotaKey", input.quotaKey);
    assertIdentifier("runId", input.runId);
    assertIdentifier("idempotencyKey", input.idempotencyKey);
    assertNonNegativeInteger("requestedUnits", input.requestedUnits);
    assertNonNegativeInteger("maximumUnits", input.maximumUnits);
    const quotaKeyHash = digest(input.quotaKey);
    const idempotencyKeyHash = digest(input.idempotencyKey);
    const reservationId = `quota_${digest(
      `${input.quotaKey}\0${input.idempotencyKey}`
    ).slice(0, 32)}`;
    const requestFingerprint = digest(
      canonicalJson({
        quotaKeyHash,
        runId: input.runId,
        requestedUnits: input.requestedUnits,
        maximumUnits: input.maximumUnits
      })
    );

    return this.serialized(async () => {
      const path = this.quotaPath(input.quotaKey);
      const parsed = await readJsonFile(path);
      const existingLedger = parsed.found
        ? parseQuotaLedger(parsed.value, path, quotaKeyHash)
        : null;

      const existing = existingLedger?.reservations.find(
        (reservation) => reservation.reservationId === reservationId
      );
      if (existing) {
        // Exact replays are read-only and remain valid after a later policy
        // increase. Because maximumUnits is in the fingerprint, a caller
        // cannot use this path to reinterpret an old decision under a new
        // ceiling.
        assertIdempotentRequest(
          "quota reservation",
          existing.requestFingerprint,
          requestFingerprint
        );
        return { created: false, value: existing };
      }

      const reservations = existingLedger?.reservations ?? [];
      if (existingLedger?.maximumUnits !== undefined) {
        if (input.maximumUnits < existingLedger.maximumUnits) {
          throw new PersistenceConflictError(
            `Quota ${quotaKeyHash} maximumUnits cannot decrease from ` +
              `${existingLedger.maximumUnits} to ${input.maximumUnits}`
          );
        }
        if (
          input.maximumUnits > existingLedger.maximumUnits &&
          reservations.some(
            (reservation) =>
              reservation.decision === "reserved" &&
              reservation.status === "active"
          )
        ) {
          throw new PersistenceConflictError(
            `Quota ${quotaKeyHash} maximumUnits cannot increase from ` +
              `${existingLedger.maximumUnits} to ${input.maximumUnits} ` +
              "while reservations are active"
          );
        }
      }

      const reservedUnits = sumReservedUnits(reservations);
      const decision =
        reservedUnits + input.requestedUnits <= input.maximumUnits
          ? "reserved"
          : "denied";
      const createdAt = this.nowIso();
      const reservation: StoredQuotaReservation = {
        storageVersion: STORAGE_VERSION,
        reservationId,
        quotaKeyHash,
        runId: input.runId,
        requestedUnits: input.requestedUnits,
        maximumUnits: input.maximumUnits,
        decision,
        status: decision === "reserved" ? "active" : "released",
        actualUnits: decision === "reserved" ? null : 0,
        createdAt,
        idempotencyKeyHash,
        requestFingerprint
      };
      const ledger: StoredQuotaLedger = {
        storageVersion: STORAGE_VERSION,
        quotaKeyHash,
        maximumUnits: input.maximumUnits,
        updatedAt: createdAt,
        reservations: [...reservations, reservation]
      };
      await atomicReplace(path, canonicalJson(ledger));
      return { created: true, value: reservation };
    });
  }

  async finalizeQuotaReservation(
    input: FinalizeQuotaReservationInput
  ): Promise<IdempotentWriteResult<StoredQuotaReservation>> {
    assertIdentifier("quotaKey", input.quotaKey);
    assertIdentifier("reservationId", input.reservationId);
    assertIdentifier("idempotencyKey", input.idempotencyKey);
    if (input.outcome !== "settled" && input.outcome !== "released") {
      throw new TypeError("outcome must be settled or released");
    }
    if (input.outcome === "settled" && input.actualUnits === undefined) {
      throw new TypeError("actualUnits is required when settling quota");
    }
    const actualUnits =
      input.outcome === "released" ? 0 : (input.actualUnits as number);
    assertNonNegativeInteger("actualUnits", actualUnits);
    if (
      input.outcome === "released" &&
      input.actualUnits !== undefined &&
      input.actualUnits !== 0
    ) {
      throw new TypeError("released quota must have zero actualUnits");
    }
    const quotaKeyHash = digest(input.quotaKey);
    const finalizationIdempotencyKeyHash = digest(input.idempotencyKey);
    const finalizationRequestFingerprint = digest(
      canonicalJson({
        reservationId: input.reservationId,
        outcome: input.outcome,
        actualUnits
      })
    );

    return this.serialized(async () => {
      const path = this.quotaPath(input.quotaKey);
      const parsed = await readJsonFile(path);
      if (!parsed.found) {
        throw new PersistenceConflictError(
          `Quota ${quotaKeyHash} does not exist`
        );
      }
      const ledger = parseQuotaLedger(parsed.value, path, quotaKeyHash);
      const index = ledger.reservations.findIndex(
        (reservation) => reservation.reservationId === input.reservationId
      );
      if (index < 0) {
        throw new PersistenceConflictError(
          `Unknown quota reservation ${input.reservationId}`
        );
      }
      const existing = ledger.reservations[index];
      if (existing.decision !== "reserved") {
        throw new PersistenceConflictError(
          `Denied quota reservation ${input.reservationId} cannot be finalized`
        );
      }
      if (existing.status !== "active") {
        assertIdempotentRequest(
          "quota finalization",
          existing.finalizationIdempotencyKeyHash ?? "",
          finalizationIdempotencyKeyHash
        );
        assertIdempotentRequest(
          "quota finalization",
          existing.finalizationRequestFingerprint ?? "",
          finalizationRequestFingerprint
        );
        return { created: false, value: existing };
      }

      const finalizedAt = this.nowIso();
      const finalized: StoredQuotaReservation = {
        ...existing,
        status: input.outcome,
        actualUnits,
        finalizedAt,
        finalizationIdempotencyKeyHash,
        finalizationRequestFingerprint
      };
      const reservations = [...ledger.reservations];
      reservations[index] = finalized;
      const updated: StoredQuotaLedger = {
        ...ledger,
        updatedAt: finalizedAt,
        reservations
      };
      await atomicReplace(path, canonicalJson(updated));
      return { created: true, value: finalized };
    });
  }

  async readQuota(quotaKey: string): Promise<QuotaSnapshot | null> {
    assertIdentifier("quotaKey", quotaKey);
    return this.serialized(async () => {
      const path = this.quotaPath(quotaKey);
      const parsed = await readJsonFile(path);
      if (!parsed.found) {
        return null;
      }
      const ledger = parseQuotaLedger(parsed.value, path, digest(quotaKey));
      return quotaSnapshot(ledger);
    });
  }

  async putCache<T extends JsonValue>(
    input: PutCacheInput<T>
  ): Promise<StoredCacheEntry<T>> {
    assertIdentifier("namespace", input.namespace);
    assertIdentifier("key", input.key);
    assertSchemaVersion(input.valueSchemaVersion);
    assertPositiveInteger("ttlMs", input.ttlMs);
    const value = safeJsonClone(input.value, "$.value") as T;
    const namespaceHash = digest(input.namespace);
    const keyHash = digest(input.key);

    return this.serialized(async () => {
      const createdAtMs = this.now();
      const entry: StoredCacheEntry<T> = {
        storageVersion: STORAGE_VERSION,
        namespaceHash,
        keyHash,
        valueSchemaVersion: input.valueSchemaVersion,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(createdAtMs + input.ttlMs).toISOString(),
        value
      };
      await atomicReplace(
        this.cachePath(input.namespace, input.key),
        canonicalJson(entry)
      );
      return entry;
    });
  }

  async getCache<T extends JsonValue = JsonValue>(
    input: GetCacheInput
  ): Promise<CacheLookup<T>> {
    assertIdentifier("namespace", input.namespace);
    assertIdentifier("key", input.key);
    assertSchemaVersion(input.valueSchemaVersion);
    return this.serialized(async () => {
      const path = this.cachePath(input.namespace, input.key);
      const parsed = await readJsonFile(path, true);
      if (!parsed.found) {
        return { status: "miss", value: null, metadata: null };
      }

      let entry: StoredCacheEntry<T>;
      try {
        entry = parseCacheEntry<T>(
          parsed.value,
          path,
          digest(input.namespace),
          digest(input.key)
        );
      } catch {
        return { status: "corrupt", value: null, metadata: null };
      }

      const metadata = cacheMetadata(entry);
      if (entry.valueSchemaVersion !== input.valueSchemaVersion) {
        return {
          status: "schema_mismatch",
          value: null,
          metadata
        };
      }
      if (this.now() >= Date.parse(entry.expiresAt)) {
        return { status: "expired", value: null, metadata };
      }
      return { status: "hit", value: entry.value, metadata };
    });
  }

  private async readRunEventsUnlocked<T extends JsonValue>(
    runId: string
  ): Promise<StoredRunEvent<T>[]> {
    const directory = this.eventDirectory(runId);
    const names = await listJsonFiles(directory);
    const events: StoredRunEvent<T>[] = [];
    for (const name of names) {
      const path = join(directory, name);
      const parsed = await readJsonFile(path);
      if (!parsed.found) {
        continue;
      }
      events.push(parseRunEvent<T>(parsed.value, path, runId));
    }
    events.sort((left, right) => left.sequence - right.sequence);
    for (const [index, event] of events.entries()) {
      if (event.sequence !== index + 1) {
        throw new PersistenceCorruptionError(
          `Event sequence is not contiguous for run ${runId}`
        );
      }
    }
    return events;
  }

  private runPath(runId: string): string {
    return join(this.directory, "runs", `${digest(runId)}.json`);
  }

  private eventDirectory(runId: string): string {
    return join(this.directory, "events", digest(runId));
  }

  private approvalDirectory(runId: string): string {
    return join(this.directory, "approvals", digest(runId));
  }

  private approvalPath(runId: string, idempotencyKey: string): string {
    return join(
      this.approvalDirectory(runId),
      `${digest(idempotencyKey)}.json`
    );
  }

  private quotaPath(quotaKey: string): string {
    return join(this.directory, "quota", `${digest(quotaKey)}.json`);
  }

  private cachePath(namespace: string, key: string): string {
    return join(
      this.directory,
      "cache",
      digest(namespace),
      `${digest(key)}.json`
    );
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    return serializeForRoot(this.directory, () =>
      withRootFileLock(this.directory, operation)
    );
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isFinite(now)) {
      throw new TypeError("clock must return a finite epoch millisecond value");
    }
    return now;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}

async function serializeForRoot<T>(
  root: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = rootTails.get(root) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  rootTails.set(root, current);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (rootTails.get(root) === current) {
      rootTails.delete(root);
    }
  }
}

async function withRootFileLock<T>(
  root: string,
  operation: () => Promise<T>
): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, ".workflow.lock");
  const recoveryPath = `${lockPath}.recovery`;
  const startedAt = Date.now();
  const owner = workflowLockOwner();
  let acquired = false;

  while (!acquired) {
    if (await pathExists(recoveryPath)) {
      await waitForWorkflowLock(root, startedAt);
      continue;
    }
    try {
      await atomicCreate(lockPath, canonicalJson(owner));

      // A recovery owner may have appeared after the preflight check but
      // before this lock became visible. Do not enter the critical section
      // until that recovery turn finishes.
      if (await pathExists(recoveryPath)) {
        const released = await unlinkWorkflowLockIfOwned(
          lockPath,
          owner.token
        );
        if (!released) {
          throw new PersistenceConflictError(
            `Workflow lock ownership changed unexpectedly in ${root}`
          );
        }
        await waitForWorkflowLock(root, startedAt);
        continue;
      }
      acquired = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
      if (
        await recoverDeadWorkflowLock(
          lockPath,
          recoveryPath
        )
      ) {
        continue;
      }
      await waitForWorkflowLock(root, startedAt);
    }
  }

  try {
    return await operation();
  } finally {
    const released = await unlinkWorkflowLockIfOwned(
      lockPath,
      owner.token
    );
    if (!released) {
      throw new PersistenceConflictError(
        `Refusing to remove a workflow lock owned by a successor in ${root}`
      );
    }
  }
}

async function recoverDeadWorkflowLock(
  lockPath: string,
  recoveryPath: string
): Promise<boolean> {
  const recoveryOwner = workflowLockOwner();
  try {
    await atomicCreate(recoveryPath, canonicalJson(recoveryOwner));
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      return false;
    }
    throw error;
  }

  try {
    const observed = await readWorkflowLock(lockPath);
    if (observed.status === "missing") {
      return true;
    }
    if (
      observed.status === "invalid" ||
      workflowLockProcessIsAlive(observed.pid)
    ) {
      return false;
    }

    // Recovery is serialized, and new acquirers check recoveryPath both
    // before and after creating the main lock. Re-read the exact bytes anyway
    // so a dead owner's path is never confused with a replacement.
    const current = await readWorkflowLock(lockPath);
    if (
      current.status !== "valid" ||
      current.contents !== observed.contents
    ) {
      return current.status === "missing";
    }
    try {
      await unlink(lockPath);
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return true;
      }
      throw error;
    }
  } finally {
    const released = await unlinkWorkflowLockIfOwned(
      recoveryPath,
      recoveryOwner.token
    );
    if (!released) {
      throw new PersistenceConflictError(
        `Refusing to remove a workflow recovery lock owned by a successor`
      );
    }
  }
}

async function unlinkWorkflowLockIfOwned(
  path: string,
  token: string
): Promise<boolean> {
  const current = await readWorkflowLock(path);
  if (current.status === "missing") {
    return true;
  }
  if (current.status !== "valid" || current.token !== token) {
    return false;
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

async function readWorkflowLock(path: string): Promise<WorkflowLockRead> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { status: "missing" };
    }
    throw error;
  }

  const legacyPid = contents.trim();
  if (/^[1-9]\d*$/.test(legacyPid)) {
    const pid = Number(legacyPid);
    return Number.isSafeInteger(pid)
      ? { status: "valid", pid, token: null, contents }
      : { status: "invalid" };
  }

  try {
    const parsed = JSON.parse(contents) as unknown;
    if (
      !isPlainRecord(parsed) ||
      parsed.lockVersion !== WORKFLOW_LOCK_VERSION ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0 ||
      typeof parsed.token !== "string" ||
      parsed.token.length < 8 ||
      parsed.token.length > 200
    ) {
      return { status: "invalid" };
    }
    return {
      status: "valid",
      pid: parsed.pid as number,
      token: parsed.token,
      contents
    };
  } catch {
    return { status: "invalid" };
  }
}

function workflowLockOwner(): WorkflowLockOwner {
  return {
    lockVersion: WORKFLOW_LOCK_VERSION,
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString()
  };
}

function workflowLockProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission denial still proves that a process owns the PID. Only ESRCH
    // is sufficient evidence to recover; every other outcome fails closed.
    return !isNodeError(error, "ESRCH");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function waitForWorkflowLock(
  root: string,
  startedAt: number
): Promise<void> {
  if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
    throw new PersistenceConflictError(
      `Timed out waiting for workflow lock in ${root}`
    );
  }
  await delay(LOCK_RETRY_MS);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

async function atomicReplace(path: string, contents: string): Promise<void> {
  const temporaryPath = await writeTemporaryFile(path, contents);
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function atomicCreate(path: string, contents: string): Promise<void> {
  const temporaryPath = await writeTemporaryFile(path, contents);
  try {
    await link(temporaryPath, path);
    await unlink(temporaryPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeTemporaryFile(
  targetPath: string,
  contents: string
): Promise<string> {
  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directory,
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  return temporaryPath;
}

async function readJsonFile(
  path: string,
  tolerateInvalidJson = false
): Promise<ParsedFile<unknown>> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { found: false, value: null };
    }
    throw error;
  }

  try {
    return { found: true, value: JSON.parse(contents) as unknown };
  } catch (error) {
    if (tolerateInvalidJson) {
      return { found: true, value: null };
    }
    throw new PersistenceCorruptionError(`Invalid JSON in ${path}`, {
      cause: error
    });
  }
}

async function listJsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

function parseRunSnapshot<T extends JsonValue>(
  input: unknown,
  path: string,
  expectedRunId: string
): StoredRunSnapshot<T> {
  const record = requireRecord(input, path);
  requireStorageVersion(record, path);
  requireExactText(record.runId, expectedRunId, "runId", path);
  requirePositiveInteger(record.revision, "revision", path);
  requireSchemaVersion(record.valueSchemaVersion, path);
  requireIsoDate(record.savedAt, "savedAt", path);
  const value = safeJsonClone(record.value, "$.value") as T;
  return {
    storageVersion: STORAGE_VERSION,
    runId: expectedRunId,
    revision: record.revision as number,
    valueSchemaVersion: record.valueSchemaVersion as ValueSchemaVersion,
    savedAt: record.savedAt as string,
    value
  };
}

function parseRunEvent<T extends JsonValue>(
  input: unknown,
  path: string,
  expectedRunId: string
): StoredRunEvent<T> {
  const record = requireRecord(input, path);
  requireStorageVersion(record, path);
  requireExactText(record.runId, expectedRunId, "runId", path);
  requirePositiveInteger(record.sequence, "sequence", path);
  requireSchemaVersion(record.eventSchemaVersion, path);
  requireIsoDate(record.occurredAt, "occurredAt", path);
  const event = safeJsonClone(record.event, "$.event") as T;
  return {
    storageVersion: STORAGE_VERSION,
    runId: expectedRunId,
    sequence: record.sequence as number,
    eventSchemaVersion: record.eventSchemaVersion as ValueSchemaVersion,
    occurredAt: record.occurredAt as string,
    event
  };
}

function parseApproval<T extends JsonValue>(
  input: unknown,
  path: string,
  expectedRunId: string
): StoredApproval<T> {
  const record = requireRecord(input, path);
  requireStorageVersion(record, path);
  requireExactText(record.runId, expectedRunId, "runId", path);
  const approvalId = requireText(record.approvalId, "approvalId", path);
  const action = requireText(record.action, "action", path);
  const decision = record.decision;
  if (decision !== "approved" && decision !== "denied") {
    throw corrupt(path, "decision");
  }
  const decidedBy = requireText(record.decidedBy, "decidedBy", path);
  requireIsoDate(record.decidedAt, "decidedAt", path);
  const idempotencyKeyHash = requireHash(
    record.idempotencyKeyHash,
    "idempotencyKeyHash",
    path
  );
  const requestFingerprint = requireHash(
    record.requestFingerprint,
    "requestFingerprint",
    path
  );
  const details =
    record.details === undefined
      ? undefined
      : (safeJsonClone(record.details, "$.details") as T);
  return {
    storageVersion: STORAGE_VERSION,
    approvalId,
    runId: expectedRunId,
    action,
    decision,
    decidedBy,
    decidedAt: record.decidedAt as string,
    idempotencyKeyHash,
    requestFingerprint,
    ...(details === undefined ? {} : { details })
  };
}

function parseQuotaLedger(
  input: unknown,
  path: string,
  expectedQuotaKeyHash: string
): StoredQuotaLedger {
  const record = requireRecord(input, path);
  requireStorageVersion(record, path);
  requireExactText(
    record.quotaKeyHash,
    expectedQuotaKeyHash,
    "quotaKeyHash",
    path
  );
  requireNonNegativeInteger(record.maximumUnits, "maximumUnits", path);
  requireIsoDate(record.updatedAt, "updatedAt", path);
  if (!Array.isArray(record.reservations)) {
    throw corrupt(path, "reservations");
  }
  const reservations = record.reservations.map((reservation, index) =>
    parseQuotaReservation(
      reservation,
      `${path}#reservations[${index}]`,
      expectedQuotaKeyHash
    )
  );
  const ids = new Set(reservations.map((reservation) => reservation.reservationId));
  if (ids.size !== reservations.length) {
    throw corrupt(path, "duplicate reservationId");
  }
  if (
    reservations.some(
      (reservation) =>
        reservation.maximumUnits > (record.maximumUnits as number)
    )
  ) {
    throw corrupt(path, "reservation maximumUnits exceeds ledger maximumUnits");
  }
  return {
    storageVersion: STORAGE_VERSION,
    quotaKeyHash: expectedQuotaKeyHash,
    maximumUnits: record.maximumUnits as number,
    updatedAt: record.updatedAt as string,
    reservations
  };
}

function parseQuotaReservation(
  input: unknown,
  path: string,
  expectedQuotaKeyHash: string
): StoredQuotaReservation {
  const record = requireRecord(input, path);
  requireStorageVersion(record, path);
  requireExactText(
    record.quotaKeyHash,
    expectedQuotaKeyHash,
    "quotaKeyHash",
    path
  );
  requireNonNegativeInteger(record.maximumUnits, "maximumUnits", path);
  const decision = record.decision;
  if (decision !== "reserved" && decision !== "denied") {
    throw corrupt(path, "decision");
  }
  requireNonNegativeInteger(record.requestedUnits, "requestedUnits", path);
  requireIsoDate(record.createdAt, "createdAt", path);
  const status = record.status;
  if (
    status !== "active" &&
    status !== "settled" &&
    status !== "released"
  ) {
    throw corrupt(path, "status");
  }
  const actualUnits = record.actualUnits;
  if (status === "active") {
    if (decision !== "reserved" || actualUnits !== null) {
      throw corrupt(path, "active reservation");
    }
  } else if (decision === "denied") {
    if (status !== "released" || actualUnits !== 0) {
      throw corrupt(path, "denied reservation");
    }
  } else {
    requireNonNegativeInteger(actualUnits, "actualUnits", path);
    requireIsoDate(record.finalizedAt, "finalizedAt", path);
    if (status === "released" && actualUnits !== 0) {
      throw corrupt(path, "released actualUnits");
    }
  }
  const finalizedAt =
    record.finalizedAt === undefined
      ? undefined
      : (record.finalizedAt as string);
  const finalizationIdempotencyKeyHash =
    record.finalizationIdempotencyKeyHash === undefined
      ? undefined
      : requireHash(
          record.finalizationIdempotencyKeyHash,
          "finalizationIdempotencyKeyHash",
          path
        );
  const finalizationRequestFingerprint =
    record.finalizationRequestFingerprint === undefined
      ? undefined
      : requireHash(
          record.finalizationRequestFingerprint,
          "finalizationRequestFingerprint",
          path
        );
  if (
    decision === "reserved" &&
    status !== "active" &&
    (!finalizationIdempotencyKeyHash || !finalizationRequestFingerprint)
  ) {
    throw corrupt(path, "finalization metadata");
  }
  return {
    storageVersion: STORAGE_VERSION,
    reservationId: requireText(record.reservationId, "reservationId", path),
    quotaKeyHash: expectedQuotaKeyHash,
    runId: requireText(record.runId, "runId", path),
    requestedUnits: record.requestedUnits as number,
    maximumUnits: record.maximumUnits as number,
    decision,
    status,
    actualUnits: actualUnits as number | null,
    createdAt: record.createdAt as string,
    ...(finalizedAt === undefined ? {} : { finalizedAt }),
    idempotencyKeyHash: requireHash(
      record.idempotencyKeyHash,
      "idempotencyKeyHash",
      path
    ),
    requestFingerprint: requireHash(
      record.requestFingerprint,
      "requestFingerprint",
      path
    ),
    ...(finalizationIdempotencyKeyHash === undefined
      ? {}
      : { finalizationIdempotencyKeyHash }),
    ...(finalizationRequestFingerprint === undefined
      ? {}
      : { finalizationRequestFingerprint })
  };
}

function parseCacheEntry<T extends JsonValue>(
  input: unknown,
  path: string,
  expectedNamespaceHash: string,
  expectedKeyHash: string
): StoredCacheEntry<T> {
  const record = requireRecord(input, path);
  requireStorageVersion(record, path);
  requireExactText(
    record.namespaceHash,
    expectedNamespaceHash,
    "namespaceHash",
    path
  );
  requireExactText(record.keyHash, expectedKeyHash, "keyHash", path);
  requireSchemaVersion(record.valueSchemaVersion, path);
  requireIsoDate(record.createdAt, "createdAt", path);
  requireIsoDate(record.expiresAt, "expiresAt", path);
  if (
    Date.parse(record.expiresAt as string) <
    Date.parse(record.createdAt as string)
  ) {
    throw corrupt(path, "expiresAt");
  }
  return {
    storageVersion: STORAGE_VERSION,
    namespaceHash: expectedNamespaceHash,
    keyHash: expectedKeyHash,
    valueSchemaVersion: record.valueSchemaVersion as ValueSchemaVersion,
    createdAt: record.createdAt as string,
    expiresAt: record.expiresAt as string,
    value: safeJsonClone(record.value, "$.value") as T
  };
}

function cacheMetadata(entry: StoredCacheEntry): CacheEntryMetadata {
  return {
    storageVersion: STORAGE_VERSION,
    namespaceHash: entry.namespaceHash,
    keyHash: entry.keyHash,
    valueSchemaVersion: entry.valueSchemaVersion,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt
  };
}

function quotaSnapshot(ledger: StoredQuotaLedger): QuotaSnapshot {
  const activeUnits = ledger.reservations.reduce(
    (total, reservation) =>
      total +
      (reservation.decision === "reserved" &&
      reservation.status === "active"
        ? reservation.requestedUnits
        : 0),
    0
  );
  const consumedUnits = ledger.reservations.reduce(
    (total, reservation) =>
      total +
      (reservation.decision === "reserved" &&
      reservation.status === "settled"
        ? (reservation.actualUnits ?? 0)
        : 0),
    0
  );
  const reservedUnits = sumReservedUnits(ledger.reservations);
  const unallocated = ledger.maximumUnits - reservedUnits;
  return {
    storageVersion: STORAGE_VERSION,
    quotaKeyHash: ledger.quotaKeyHash,
    maximumUnits: ledger.maximumUnits,
    activeUnits,
    consumedUnits,
    reservedUnits,
    remainingUnits: Math.max(0, unallocated),
    exceededUnits: Math.max(0, -unallocated),
    updatedAt: ledger.updatedAt,
    reservations: ledger.reservations
  };
}

function sumReservedUnits(
  reservations: readonly StoredQuotaReservation[]
): number {
  return reservations.reduce(
    (total, reservation) =>
      total +
      (reservation.decision !== "reserved"
        ? 0
        : reservation.status === "active"
          ? reservation.requestedUnits
          : reservation.status === "settled"
            ? (reservation.actualUnits ?? 0)
            : 0),
    0
  );
}

function assertIdempotentRequest(
  kind: string,
  existingFingerprint: string,
  requestedFingerprint: string
): void {
  if (existingFingerprint !== requestedFingerprint) {
    throw new PersistenceConflictError(
      `Idempotency key was already used for a different ${kind}`
    );
  }
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function safeJsonClone(value: unknown, path: string): JsonValue {
  const seen = new Set<object>();
  return clone(value, path, seen);
}

function clone(value: unknown, path: string, seen: Set<object>): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite numbers`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must be JSON-serializable`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${path} must not contain circular references`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => clone(entry, `${path}[${index}]`, seen));
    }
    if (!isPlainRecord(value)) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      if (isCredentialLikeKey(key)) {
        throw new SensitivePersistenceValueError(`${path}.${key}`);
      }
      output[key] = clone(value[key], `${path}.${key}`, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function isCredentialLikeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "password" ||
    normalized === "passwd" ||
    normalized === "apikey" ||
    normalized === "xapikey" ||
    normalized === "clientsecret" ||
    normalized === "privatekey" ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken")
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(
  value: unknown,
  path: string
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new PersistenceCorruptionError(`Expected an object in ${path}`);
  }
  return value;
}

function requireStorageVersion(
  record: Record<string, unknown>,
  path: string
): void {
  requireExactNumber(
    record.storageVersion,
    STORAGE_VERSION,
    "storageVersion",
    path
  );
}

function requireText(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw corrupt(path, field);
  }
  return value;
}

function requireHash(value: unknown, field: string, path: string): string {
  const text = requireText(value, field, path);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw corrupt(path, field);
  }
  return text;
}

function requireExactText(
  value: unknown,
  expected: string,
  field: string,
  path: string
): void {
  if (value !== expected) {
    throw corrupt(path, field);
  }
}

function requireExactNumber(
  value: unknown,
  expected: number,
  field: string,
  path: string
): void {
  if (value !== expected) {
    throw corrupt(path, field);
  }
}

function requirePositiveInteger(
  value: unknown,
  field: string,
  path: string
): void {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw corrupt(path, field);
  }
}

function requireNonNegativeInteger(
  value: unknown,
  field: string,
  path: string
): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw corrupt(path, field);
  }
}

function requireSchemaVersion(value: unknown, path: string): void {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && value.length === 0) ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw corrupt(path, "schema version");
  }
}

function requireIsoDate(value: unknown, field: string, path: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw corrupt(path, field);
  }
}

function corrupt(path: string, field: string): PersistenceCorruptionError {
  return new PersistenceCorruptionError(
    `Invalid persisted ${field} field in ${path}`
  );
}

function assertServerRuntime(): void {
  if (
    typeof process === "undefined" ||
    typeof process.versions?.node !== "string"
  ) {
    throw new Error(
      "FileSystemWorkflowRepository is available only in a Node.js server runtime"
    );
  }
}

function assertIdentifier(name: string, value: string): void {
  assertText(name, value);
  if (value.length > IDENTIFIER_LIMIT || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(
      `${name} must be at most ${IDENTIFIER_LIMIT} characters without controls`
    );
  }
}

function assertText(name: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function assertSchemaVersion(value: ValueSchemaVersion): void {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && value.length === 0) ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new TypeError("schema version must be a non-empty string or number");
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

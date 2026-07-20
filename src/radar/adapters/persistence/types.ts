export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ValueSchemaVersion = number | string;

export interface StoredRunSnapshot<T extends JsonValue = JsonValue> {
  storageVersion: 1;
  runId: string;
  revision: number;
  valueSchemaVersion: ValueSchemaVersion;
  savedAt: string;
  value: T;
}

export interface SaveRunSnapshotInput<T extends JsonValue = JsonValue> {
  runId: string;
  valueSchemaVersion: ValueSchemaVersion;
  value: T;
  /**
   * Omit for an unconditional next revision, pass null to require a new run,
   * or pass a revision number for optimistic concurrency.
   */
  expectedRevision?: number | null;
}

export interface StoredRunEvent<T extends JsonValue = JsonValue> {
  storageVersion: 1;
  runId: string;
  sequence: number;
  eventSchemaVersion: ValueSchemaVersion;
  occurredAt: string;
  event: T;
}

export interface AppendRunEventInput<T extends JsonValue = JsonValue> {
  runId: string;
  eventSchemaVersion: ValueSchemaVersion;
  event: T;
}

export type ApprovalDecision = "approved" | "denied";

export interface RecordApprovalInput<T extends JsonValue = JsonValue> {
  runId: string;
  idempotencyKey: string;
  action: string;
  decision: ApprovalDecision;
  decidedBy: string;
  details?: T;
}

export interface StoredApproval<T extends JsonValue = JsonValue> {
  storageVersion: 1;
  approvalId: string;
  runId: string;
  action: string;
  decision: ApprovalDecision;
  decidedBy: string;
  decidedAt: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  details?: T;
}

export interface IdempotentWriteResult<T> {
  created: boolean;
  value: T;
}

export type QuotaReservationDecision = "reserved" | "denied";
export type QuotaReservationStatus = "active" | "settled" | "released";
export type QuotaFinalizationOutcome = "settled" | "released";

export interface ReserveQuotaInput {
  quotaKey: string;
  runId: string;
  idempotencyKey: string;
  requestedUnits: number;
  maximumUnits: number;
}

export interface StoredQuotaReservation {
  storageVersion: 1;
  reservationId: string;
  quotaKeyHash: string;
  runId: string;
  requestedUnits: number;
  /**
   * Quota ceiling in force when this reservation was decided. This is
   * historical request data and is not rewritten when the ledger ceiling is
   * safely increased later.
   */
  maximumUnits: number;
  decision: QuotaReservationDecision;
  status: QuotaReservationStatus;
  actualUnits: number | null;
  createdAt: string;
  finalizedAt?: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  finalizationIdempotencyKeyHash?: string;
  finalizationRequestFingerprint?: string;
}

export interface FinalizeQuotaReservationInput {
  quotaKey: string;
  reservationId: string;
  idempotencyKey: string;
  outcome: QuotaFinalizationOutcome;
  /**
   * Required for settlement. Omit or pass zero for release/cancellation.
   * Actual usage may exceed the reservation because provider billing can be
   * ambiguous; QuotaSnapshot.exceededUnits reports any resulting overage.
   */
  actualUnits?: number;
}

export interface QuotaSnapshot {
  storageVersion: 1;
  quotaKeyHash: string;
  maximumUnits: number;
  activeUnits: number;
  consumedUnits: number;
  reservedUnits: number;
  remainingUnits: number;
  exceededUnits: number;
  updatedAt: string;
  reservations: StoredQuotaReservation[];
}

export interface PutCacheInput<T extends JsonValue = JsonValue> {
  namespace: string;
  key: string;
  valueSchemaVersion: ValueSchemaVersion;
  ttlMs: number;
  value: T;
}

export interface CacheEntryMetadata {
  storageVersion: 1;
  namespaceHash: string;
  keyHash: string;
  valueSchemaVersion: ValueSchemaVersion;
  createdAt: string;
  expiresAt: string;
}

export interface StoredCacheEntry<T extends JsonValue = JsonValue>
  extends CacheEntryMetadata {
  value: T;
}

export type CacheLookupStatus =
  | "hit"
  | "miss"
  | "expired"
  | "schema_mismatch"
  | "corrupt";

export type CacheLookup<T extends JsonValue = JsonValue> =
  | {
      status: "hit";
      value: T;
      metadata: CacheEntryMetadata;
    }
  | {
      status: Exclude<CacheLookupStatus, "hit">;
      value: null;
      metadata: CacheEntryMetadata | null;
    };

export interface GetCacheInput {
  namespace: string;
  key: string;
  valueSchemaVersion: ValueSchemaVersion;
}

export interface WorkflowPersistenceRepository {
  saveRunSnapshot<T extends JsonValue>(
    input: SaveRunSnapshotInput<T>
  ): Promise<StoredRunSnapshot<T>>;
  readRunSnapshot<T extends JsonValue = JsonValue>(
    runId: string
  ): Promise<StoredRunSnapshot<T> | null>;
  appendRunEvent<T extends JsonValue>(
    input: AppendRunEventInput<T>
  ): Promise<StoredRunEvent<T>>;
  readRunEvents<T extends JsonValue = JsonValue>(
    runId: string
  ): Promise<StoredRunEvent<T>[]>;
  recordApproval<T extends JsonValue>(
    input: RecordApprovalInput<T>
  ): Promise<IdempotentWriteResult<StoredApproval<T>>>;
  readApproval<T extends JsonValue = JsonValue>(
    runId: string,
    idempotencyKey: string
  ): Promise<StoredApproval<T> | null>;
  listApprovals<T extends JsonValue = JsonValue>(
    runId: string
  ): Promise<StoredApproval<T>[]>;
  reserveQuota(
    input: ReserveQuotaInput
  ): Promise<IdempotentWriteResult<StoredQuotaReservation>>;
  finalizeQuotaReservation(
    input: FinalizeQuotaReservationInput
  ): Promise<IdempotentWriteResult<StoredQuotaReservation>>;
  readQuota(quotaKey: string): Promise<QuotaSnapshot | null>;
  putCache<T extends JsonValue>(
    input: PutCacheInput<T>
  ): Promise<StoredCacheEntry<T>>;
  getCache<T extends JsonValue = JsonValue>(
    input: GetCacheInput
  ): Promise<CacheLookup<T>>;
}

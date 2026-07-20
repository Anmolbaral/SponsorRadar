import { createHash, randomUUID } from "node:crypto";
import type { RunAuditSummary } from "@/src/radar/domain/types";

export type AuditActor =
  | "user"
  | "application"
  | "policy"
  | "tool"
  | "llm";

export type AuditPhase =
  | "phase_1_fixture"
  | "phase_2_live"
  | "phase_3_fixture"
  | "phase_3_live"
  | "phase_4_fixture"
  | "phase_4_live";
export type AuditMode = "fixture" | "live";
export type CreditReconciliationStatus =
  | "not_applicable"
  | "pending"
  | "matched"
  | "mismatch";

export type AuditEventType =
  | "run.started"
  | "policy.decided"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "http.started"
  | "http.completed"
  | "http.failed"
  | "skill.loaded"
  | "llm.started"
  | "llm.completed"
  | "llm.failed"
  | "report.ready";

export interface AuditEvent {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  occurredAt: string;
  phase: AuditPhase;
  actor: AuditActor;
  eventType: AuditEventType;
  reason: string;
  tool?: {
    name: string;
    mode: AuditMode;
    inputFingerprint: string;
    cacheStatus: "hit" | "miss" | "not_applicable";
    estimatedCredits: number;
    resultBasedCredits: number | null;
    reconciliation: CreditReconciliationStatus;
    durationMs?: number;
    rows?: number;
    retryCount: number;
    requestId: string | null;
    providerRequestId: string | null;
    outcome?: "success" | "failure";
    errorType?: string;
  };
  skill?: {
    name: string;
    version: string;
    sha256: string;
    section: string;
    manifestId?: string;
    authority?: "system_policy" | "untrusted_reference";
  };
  llm?: {
    provider: string;
    model: string;
    purpose: string;
    requestId: string;
    providerRequestId: string | null;
    providerResponseId: string | null;
    promptVersion: string;
    schemaVersion: string;
    inputFingerprint: string;
    contextFingerprint: string;
    evidenceFingerprint: string;
    outputFingerprint?: string;
    maxOutputTokens: number;
    attemptCount: number;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    structuredOutputValid?: boolean;
    finishReason?: string;
    outcome?: "success" | "failure";
    errorType?: string;
    httpStatus?: number;
    providerErrorType?: string;
    providerErrorCode?: string;
  };
  policy?: {
    decision: "allow" | "deny";
    estimatedCredits: number;
    resultBasedCredits: number;
    maximumCredits: number;
    remainingCredits: number;
  };
}

export interface ToolAuditMetadata {
  name: string;
  reason: string;
  mode?: AuditMode;
  input: unknown;
  cacheStatus: AuditEvent["tool"] extends infer T
    ? T extends { cacheStatus: infer C }
      ? C
      : never
    : never;
  estimatedCredits: number;
}

export interface ToolResultMetadata {
  rows: number;
  resultBasedCredits?: number | null;
  reconciliation?: NonNullable<AuditEvent["tool"]>["reconciliation"];
  requestId?: string | null;
  providerRequestId?: string | null;
  retryCount?: number;
  durationMs?: number;
}

export type HttpLifecycleAuditInput =
  | {
      phase: "started";
      method: "GET" | "POST";
      path: `/${string}`;
      requestId: string;
      audit?: HttpAuditContext;
    }
  | {
      phase: "completed";
      method: "GET" | "POST";
      path: `/${string}`;
      requestId: string;
      audit?: HttpAuditContext;
      meta: HttpLifecycleMetadata;
      usage?: HttpUsageMetadata;
    }
  | {
      phase: "failed";
      method: "GET" | "POST";
      path: `/${string}`;
      requestId: string;
      audit?: HttpAuditContext;
      code: string;
      status: number | null;
      meta: HttpLifecycleMetadata;
    };

interface HttpAuditContext {
  operation: string;
  reason: string;
  estimatedCredits: number;
}

interface HttpUsageMetadata {
  rows: number;
  resultBasedCredits: number;
}

interface HttpLifecycleMetadata {
  providerRequestId: string | null;
  latencyMs: number;
  attempts: readonly unknown[];
}

export interface PolicyAuditMetadata {
  decision: "allow" | "deny";
  reason: string;
  estimatedCredits: number;
  resultBasedCredits?: number;
  maximumCredits: number;
  remainingCredits: number;
}

export interface SkillAuditMetadata {
  name: string;
  version: string;
  sha256: string;
  section: string;
  manifestId?: string;
  authority?: "system_policy" | "untrusted_reference";
  reason: string;
}

export interface LlmAuditMetadata {
  provider: string;
  model: string;
  purpose: string;
  reason: string;
  requestId: string;
  promptVersion: string;
  schemaVersion: string;
  input: unknown;
  context: unknown;
  evidence: unknown;
  maxOutputTokens: number;
}

export interface LlmAuditResult {
  value: unknown;
  providerRequestId?: string | null;
  providerResponseId?: string | null;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  structuredOutputValid: boolean;
}

export interface LlmProviderAuditObservation {
  providerRequestId?: string | null;
  providerResponseId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  httpStatus?: number | null;
  providerErrorType?: string | null;
  providerErrorCode?: string | null;
}

interface SanitizedLlmProviderAuditObservation {
  providerRequestId?: string;
  providerResponseId?: string;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  httpStatus?: number;
  providerErrorType?: string;
  providerErrorCode?: string;
}

export interface AuditRecorderOptions {
  runId?: string;
  clock?: () => number;
  phase?: AuditPhase;
  mode?: AuditMode;
  sink?: (event: AuditEvent) => void;
}

export class AuditRecorder {
  readonly runId: string;
  private readonly clock: () => number;
  private readonly phase: AuditPhase;
  private readonly mode: AuditMode;
  private readonly sink?: (event: AuditEvent) => void;
  private readonly events: AuditEvent[] = [];
  private sequence = 0;
  private startedAt: number | null = null;
  private firstResultAt: number | null = null;

  constructor(options: AuditRecorderOptions = {}) {
    this.runId = options.runId ?? randomUUID();
    this.clock = options.clock ?? Date.now;
    this.phase = options.phase ?? "phase_1_fixture";
    this.mode = options.mode ?? "fixture";
    this.sink = options.sink;
  }

  startRun(input: unknown): void {
    this.startedAt = this.clock();
    this.record({
      actor: "user",
      eventType: "run.started",
      reason: `Accepted report request ${fingerprint(input)}`
    });
  }

  recordPolicy(maximumCredits: number): void;
  recordPolicy(metadata: PolicyAuditMetadata): void;
  recordPolicy(input: number | PolicyAuditMetadata): void {
    const metadata: PolicyAuditMetadata =
      typeof input === "number"
        ? {
            decision: "allow",
            reason: "Fixture mode is network-disabled and spends zero credits",
            estimatedCredits: 0,
            resultBasedCredits: 0,
            maximumCredits: input,
            remainingCredits: input
          }
        : input;
    this.record({
      actor: "policy",
      eventType: "policy.decided",
      reason: metadata.reason,
      policy: {
        decision: metadata.decision,
        estimatedCredits: metadata.estimatedCredits,
        resultBasedCredits: metadata.resultBasedCredits ?? 0,
        maximumCredits: metadata.maximumCredits,
        remainingCredits: metadata.remainingCredits
      }
    });
  }

  recordSkillLoaded(metadata: SkillAuditMetadata): void {
    this.record({
      actor: "application",
      eventType: "skill.loaded",
      reason: metadata.reason,
      skill: {
        name: metadata.name,
        version: metadata.version,
        sha256: metadata.sha256,
        section: metadata.section,
        ...(metadata.manifestId
          ? { manifestId: metadata.manifestId }
          : {}),
        ...(metadata.authority
          ? { authority: metadata.authority }
          : {})
      }
    });
  }

  async llm<T extends LlmAuditResult>(
    metadata: LlmAuditMetadata,
    operation: (
      observeProvider: (
        observation: LlmProviderAuditObservation
      ) => void
    ) => Promise<T>
  ): Promise<T> {
    const startedAt = this.clock();
    let providerObservation: SanitizedLlmProviderAuditObservation = {};
    const baseLlm: NonNullable<AuditEvent["llm"]> = {
      provider: metadata.provider,
      model: metadata.model,
      purpose: metadata.purpose,
      requestId: metadata.requestId,
      providerRequestId: null,
      providerResponseId: null,
      promptVersion: metadata.promptVersion,
      schemaVersion: metadata.schemaVersion,
      inputFingerprint: fingerprint(metadata.input),
      contextFingerprint: fingerprint(metadata.context),
      evidenceFingerprint: fingerprint(metadata.evidence),
      maxOutputTokens: metadata.maxOutputTokens,
      attemptCount: 1
    };
    this.record({
      actor: "llm",
      eventType: "llm.started",
      reason: metadata.reason,
      llm: baseLlm
    });
    try {
      const result = await operation((observation) => {
        providerObservation =
          sanitizeLlmProviderObservation(observation);
      });
      this.record({
        actor: "llm",
        eventType: "llm.completed",
        reason: metadata.reason,
        llm: {
          ...baseLlm,
          providerRequestId: result.providerRequestId ?? null,
          providerResponseId: result.providerResponseId ?? null,
          outputFingerprint: fingerprint(result.value),
          durationMs: Math.max(0, this.clock() - startedAt),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          structuredOutputValid: result.structuredOutputValid,
          finishReason: result.finishReason,
          outcome: "success"
        }
      });
      return result;
    } catch (error) {
      this.record({
        actor: "llm",
        eventType: "llm.failed",
        reason: metadata.reason,
        llm: {
          ...baseLlm,
          ...providerObservation,
          providerRequestId:
            providerObservation.providerRequestId ?? null,
          providerResponseId:
            providerObservation.providerResponseId ?? null,
          durationMs: Math.max(0, this.clock() - startedAt),
          structuredOutputValid: false,
          finishReason:
            providerObservation.finishReason ?? "error",
          outcome: "failure",
          errorType: error instanceof Error ? error.name : "UnknownError"
        }
      });
      throw error;
    }
  }

  async tool<T>(
    metadata: ToolAuditMetadata,
    operation: () => Promise<T>,
    describe: (result: T) => ToolResultMetadata
  ): Promise<T> {
    const startedAt = this.clock();
    const mode = metadata.mode ?? this.mode;
    const baseTool: NonNullable<AuditEvent["tool"]> = {
      name: metadata.name,
      mode,
      inputFingerprint: fingerprint(metadata.input),
      cacheStatus: metadata.cacheStatus,
      estimatedCredits: metadata.estimatedCredits,
      resultBasedCredits: null,
      reconciliation:
        mode === "live" && metadata.estimatedCredits > 0
          ? "pending"
          : "not_applicable",
      retryCount: 0,
      requestId: null,
      providerRequestId: null
    };

    this.record({
      actor: "tool",
      eventType: "tool.started",
      reason: metadata.reason,
      tool: baseTool
    });

    try {
      const result = await operation();
      const resultMetadata = describe(result);
      const resultBasedCredits = resultMetadata.resultBasedCredits ?? null;
      this.record({
        actor: "tool",
        eventType: "tool.completed",
        reason: metadata.reason,
        tool: {
          ...baseTool,
          durationMs: resultMetadata.durationMs ?? this.clock() - startedAt,
          rows: resultMetadata.rows,
          resultBasedCredits,
          reconciliation:
            resultMetadata.reconciliation ??
            deriveReconciliation(
              mode,
              metadata.estimatedCredits,
              resultBasedCredits
            ),
          retryCount: resultMetadata.retryCount ?? 0,
          requestId: resultMetadata.requestId ?? null,
          providerRequestId: resultMetadata.providerRequestId ?? null,
          outcome: "success"
        }
      });
      return result;
    } catch (error) {
      this.record({
        actor: "tool",
        eventType: "tool.failed",
        reason: metadata.reason,
        tool: {
          ...baseTool,
          durationMs: this.clock() - startedAt,
          rows: 0,
          outcome: "failure",
          errorType: error instanceof Error ? error.name : "UnknownError"
        }
      });
      throw error;
    }
  }

  recordHttpLifecycle(event: HttpLifecycleAuditInput): void {
    const reason =
      event.audit?.reason ??
      `Authenticated Upriver ${event.method} ${event.path}`;
    const baseTool: NonNullable<AuditEvent["tool"]> = {
      name: event.audit
        ? `upriver.http.${event.audit.operation}`
        : `upriver.http.${event.method.toLowerCase()}`,
      mode: "live",
      inputFingerprint: fingerprint({
        method: event.method,
        path: event.path,
        operation: event.audit?.operation ?? null
      }),
      cacheStatus: "not_applicable",
      estimatedCredits: event.audit?.estimatedCredits ?? 0,
      resultBasedCredits: null,
      reconciliation: event.audit ? "pending" : "not_applicable",
      retryCount: 0,
      requestId: event.requestId,
      providerRequestId: null
    };

    if (event.phase === "started") {
      this.record({
        actor: "tool",
        eventType: "http.started",
        reason,
        tool: baseTool
      });
      return;
    }

    const completedTool = {
      ...baseTool,
      durationMs: event.meta.latencyMs,
      retryCount: Math.max(0, event.meta.attempts.length - 1),
      providerRequestId: event.meta.providerRequestId,
      ...(event.phase === "completed" && event.usage
        ? {
            rows: event.usage.rows,
            resultBasedCredits: event.usage.resultBasedCredits,
            reconciliation: deriveReconciliation(
              "live",
              baseTool.estimatedCredits,
              event.usage.resultBasedCredits
            )
          }
        : {})
    };
    this.record({
      actor: "tool",
      eventType:
        event.phase === "completed" ? "http.completed" : "http.failed",
      reason,
      tool:
        event.phase === "completed"
          ? {
              ...completedTool,
              outcome: "success"
            }
          : {
              ...completedTool,
              outcome: "failure",
              errorType: event.code
            }
    });
  }

  reportReady(resultCount: number): void {
    if (resultCount > 0 && this.firstResultAt === null) {
      this.firstResultAt = this.clock();
    }
    this.record({
      actor: "application",
      eventType: "report.ready",
      reason: `Strict gate produced ${resultCount} qualified lead(s)`
    });
  }

  getEvents(): readonly AuditEvent[] {
    return structuredClone(this.events);
  }

  summarize(projectedLiveCredits: number): RunAuditSummary {
    const completedTools = this.events.filter(
      (event) => event.eventType === "tool.completed"
    );
    const resultBasedCredits = completedTools.reduce(
      (sum, event) => sum + (event.tool?.resultBasedCredits ?? 0),
      0
    );
    const skillNames = this.events.flatMap((event) =>
      event.skill ? [event.skill.name] : []
    );
    const now = this.clock();

    return {
      toolCalls: completedTools.length,
      llmCalls: this.events.filter(
        (event) => event.eventType === "llm.started"
      ).length,
      skillsLoaded: [...new Set(skillNames)],
      resultBasedCreditEstimate: resultBasedCredits,
      projectedLiveCredits,
      timeToFirstResultMs:
        this.startedAt === null || this.firstResultAt === null
          ? null
          : Math.max(0, this.firstResultAt - this.startedAt),
      totalDurationMs:
        this.startedAt === null ? 0 : Math.max(0, now - this.startedAt)
    };
  }

  private record(
    event: Omit<
      AuditEvent,
      "schemaVersion" | "runId" | "sequence" | "occurredAt" | "phase"
    >
  ): void {
    const completedEvent: AuditEvent = {
      schemaVersion: 1,
      runId: this.runId,
      sequence: ++this.sequence,
      occurredAt: new Date(this.clock()).toISOString(),
      phase: this.phase,
      ...event
    };
    this.events.push(completedEvent);
    try {
      this.sink?.(structuredClone(completedEvent));
    } catch {
      // Observability must not change the report result.
    }
  }
}

function deriveReconciliation(
  mode: AuditMode,
  estimatedCredits: number,
  resultBasedCredits: number | null
): CreditReconciliationStatus {
  if (mode === "fixture" && resultBasedCredits === null) {
    return "not_applicable";
  }
  if (resultBasedCredits === null) {
    return "pending";
  }
  return resultBasedCredits === estimatedCredits ? "matched" : "mismatch";
}

export function fingerprint(input: unknown): string {
  const safe = redactSensitive(input);
  const canonical = JSON.stringify(sortObject(safe));
  return createHash("sha256").update(canonical).digest("hex");
}

function sanitizeLlmProviderObservation(
  observation: LlmProviderAuditObservation
): SanitizedLlmProviderAuditObservation {
  return {
    ...(isSafeAuditToken(observation.providerRequestId)
      ? { providerRequestId: observation.providerRequestId }
      : {}),
    ...(isSafeAuditToken(observation.providerResponseId)
      ? { providerResponseId: observation.providerResponseId }
      : {}),
    ...(isNonnegativeInteger(observation.inputTokens)
      ? { inputTokens: observation.inputTokens }
      : {}),
    ...(isNonnegativeInteger(observation.outputTokens)
      ? { outputTokens: observation.outputTokens }
      : {}),
    ...(isSafeAuditToken(observation.finishReason)
      ? { finishReason: observation.finishReason }
      : {}),
    ...(Number.isInteger(observation.httpStatus) &&
    (observation.httpStatus ?? 0) >= 100 &&
    (observation.httpStatus ?? 0) <= 599
      ? { httpStatus: observation.httpStatus as number }
      : {}),
    ...(isSafeAuditToken(observation.providerErrorType)
      ? { providerErrorType: observation.providerErrorType }
      : {}),
    ...(isSafeAuditToken(observation.providerErrorCode)
      ? { providerErrorCode: observation.providerErrorCode }
      : {})
  };
}

function isSafeAuditToken(
  value: string | null | undefined
): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9._:-]{1,200}$/.test(value)
  );
}

function isNonnegativeInteger(
  value: number | undefined
): value is number {
  return Number.isInteger(value) && (value ?? -1) >= 0;
}

export function redactSensitive(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(redactSensitive);
  }
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : redactSensitive(value)
      ])
    );
  }
  return input;
}

function isSensitiveKey(key: string): boolean {
  return /^(authorization|x-api-key|api_?key|token|secret|email)$/i.test(key);
}

function sortObject(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(sortObject);
  }
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, sortObject(value)])
    );
  }
  return input;
}

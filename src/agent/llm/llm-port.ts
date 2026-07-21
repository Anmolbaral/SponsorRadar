import type {
  AuditRecorder,
  LlmProviderAuditObservation
} from "@/src/observability/audit";

export type LlmPurpose =
  | "peer_rationale"
  | "grounded_report_wording";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface LlmProviderRequest {
  requestId: string;
  idempotencyKey: string;
  purpose: LlmPurpose;
  instructions: string;
  input: string;
  schemaName: string;
  outputSchema: JsonSchema;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface LlmProviderResponse {
  output: unknown;
  providerRequestId: string | null;
  providerResponseId?: string | null;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  refusal: string | null;
  toolCalls: number;
}

/**
 * The provider boundary deliberately returns `unknown`. Only
 * `BoundedLlmSession` may turn provider output into a trusted application type.
 */
export interface LlmPort {
  readonly provider: string;
  readonly model: string;
  generateStructured(
    request: LlmProviderRequest
  ): Promise<LlmProviderResponse>;
}

export interface StructuredLlmTask<TOutput> {
  requestId: string;
  idempotencyKey: string;
  purpose: LlmPurpose;
  promptVersion: string;
  schemaVersion: string;
  schemaName: string;
  instructions: string;
  context: unknown;
  evidence: unknown;
  input: string;
  outputSchema: JsonSchema;
  parseOutput: (value: unknown) => TOutput;
}

export interface StructuredLlmResponse<T> {
  value: T;
  provider: string;
  model: string;
  providerRequestId: string | null;
  providerResponseId: string | null;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
}

interface PurposePolicy {
  maxInputBytes: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

export const LLM_PURPOSE_POLICIES: Readonly<
  Record<LlmPurpose, PurposePolicy>
> = {
  peer_rationale: {
    maxInputBytes: 16_000,
    maxOutputTokens: 500,
    timeoutMs: 15_000
  },
  grounded_report_wording: {
    maxInputBytes: 24_000,
    maxOutputTokens: 700,
    timeoutMs: 20_000
  }
};

export interface BoundedLlmSessionOptions {
  maxCalls?: number;
  maxTotalOutputTokens?: number;
  alreadyAttemptedPurposes?: readonly LlmPurpose[];
}

export class BoundedLlmSession {
  private readonly attemptedPurposes: Set<LlmPurpose>;
  private readonly maxCalls: number;
  private readonly maxTotalOutputTokens: number;
  private attemptedCalls: number;
  private outputTokens = 0;

  constructor(
    private readonly port: LlmPort,
    private readonly audit: AuditRecorder,
    options: BoundedLlmSessionOptions = {}
  ) {
    this.maxCalls = positiveInteger(options.maxCalls ?? 2, "maxCalls");
    this.maxTotalOutputTokens = positiveInteger(
      options.maxTotalOutputTokens ?? 1_200,
      "maxTotalOutputTokens"
    );
    this.attemptedPurposes = new Set(
      options.alreadyAttemptedPurposes ?? []
    );
    this.attemptedCalls = this.attemptedPurposes.size;
    this.outputTokens = [...this.attemptedPurposes].reduce(
      (total, purpose) =>
        total + LLM_PURPOSE_POLICIES[purpose].maxOutputTokens,
      0
    );
  }

  async execute<TOutput>(
    task: StructuredLlmTask<TOutput>
  ): Promise<StructuredLlmResponse<TOutput>> {
    const policy = LLM_PURPOSE_POLICIES[task.purpose];
    if (this.attemptedPurposes.has(task.purpose)) {
      throw new LlmBudgetError(
        `LLM purpose ${task.purpose} has already been attempted for this run`
      );
    }
    if (this.attemptedCalls >= this.maxCalls) {
      throw new LlmBudgetError("The run has reached its LLM call limit");
    }
    if (
      this.outputTokens + policy.maxOutputTokens >
      this.maxTotalOutputTokens
    ) {
      throw new LlmBudgetError(
        "The run has reached its LLM output-token reservation"
      );
    }
    const inputBytes =
      Buffer.byteLength(task.instructions, "utf8") +
      Buffer.byteLength(task.input, "utf8");
    if (inputBytes > policy.maxInputBytes) {
      throw new LlmBoundaryError(
        `${task.purpose} input exceeds its ${policy.maxInputBytes}-byte limit`
      );
    }
    assertSafeIdentifier(task.requestId, "requestId");
    assertSafeIdentifier(task.idempotencyKey, "idempotencyKey");
    assertSafeIdentifier(task.schemaName, "schemaName");
    assertSafeVersion(task.promptVersion, "promptVersion");
    assertSafeVersion(task.schemaVersion, "schemaVersion");

    this.attemptedPurposes.add(task.purpose);
    this.attemptedCalls += 1;
    const result = await this.audit.llm(
      {
        provider: this.port.provider,
        model: this.port.model,
        purpose: task.purpose,
        reason:
          task.purpose === "peer_rationale"
            ? "Explain the already-locked peer cohort without changing it"
            : "Draft wording from already-qualified, cited facts",
        requestId: task.requestId,
        promptVersion: task.promptVersion,
        schemaVersion: task.schemaVersion,
        input: task.input,
        context: task.context,
        evidence: task.evidence,
        maxOutputTokens: policy.maxOutputTokens
      },
      async (observeProvider) => {
        let response: LlmProviderResponse;
        try {
          response = await this.port.generateStructured({
            requestId: task.requestId,
            idempotencyKey: task.idempotencyKey,
            purpose: task.purpose,
            instructions: task.instructions,
            input: task.input,
            schemaName: task.schemaName,
            outputSchema: task.outputSchema,
            maxOutputTokens: policy.maxOutputTokens,
            timeoutMs: policy.timeoutMs
          });
        } catch (error) {
          observeProvider(providerFailureObservation(error));
          throw error;
        }
        observeProvider({
          providerRequestId: response.providerRequestId,
          providerResponseId: response.providerResponseId,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          finishReason: response.finishReason
        });
        if (response.refusal) {
          throw new LlmRefusalError("The model refused the bounded task");
        }
        if (response.toolCalls !== 0) {
          throw new LlmBoundaryError(
            "The model attempted a tool call in a tool-free task"
          );
        }
        if (
          !Number.isInteger(response.inputTokens) ||
          response.inputTokens < 0 ||
          !Number.isInteger(response.outputTokens) ||
          response.outputTokens < 0 ||
          response.outputTokens > policy.maxOutputTokens
        ) {
          throw new LlmBoundaryError(
            "The provider returned invalid or over-budget token usage"
          );
        }
        const value = task.parseOutput(response.output);
        return {
          value,
          providerRequestId: response.providerRequestId,
          providerResponseId: response.providerResponseId,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          finishReason: response.finishReason,
          structuredOutputValid: true
        };
      }
    );
    this.outputTokens += result.outputTokens;
    return {
      value: result.value as TOutput,
      provider: this.port.provider,
      model: this.port.model,
      providerRequestId: result.providerRequestId ?? null,
      providerResponseId: result.providerResponseId ?? null,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      finishReason: result.finishReason
    };
  }
}

export class DisabledLlmPort implements LlmPort {
  readonly provider = "disabled";
  readonly model = "disabled";

  async generateStructured(): Promise<never> {
    throw new LlmDisabledError(
      "LLM calls are disabled until the wording-agent runtime flag is enabled"
    );
  }
}

export class LlmBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmBoundaryError";
  }
}

export class LlmBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmBudgetError";
  }
}

export class LlmDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmDisabledError";
  }
}

export class LlmRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmRefusalError";
  }
}

function providerFailureObservation(
  error: unknown
): LlmProviderAuditObservation {
  if (!error || typeof error !== "object") return {};
  const failure = error as {
    providerRequestId?: unknown;
    providerResponseId?: unknown;
    status?: unknown;
    providerErrorType?: unknown;
    providerErrorCode?: unknown;
  };
  return {
    ...(typeof failure.providerRequestId === "string"
      ? { providerRequestId: failure.providerRequestId }
      : {}),
    ...(typeof failure.providerResponseId === "string"
      ? { providerResponseId: failure.providerResponseId }
      : {}),
    ...(typeof failure.status === "number"
      ? { httpStatus: failure.status }
      : {}),
    ...(typeof failure.providerErrorType === "string"
      ? { providerErrorType: failure.providerErrorType }
      : {}),
    ...(typeof failure.providerErrorCode === "string"
      ? { providerErrorCode: failure.providerErrorCode }
      : {})
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(value)) {
    throw new LlmBoundaryError(`${label} is not a safe bounded identifier`);
  }
}

function assertSafeVersion(value: string, label: string): void {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(value)) {
    throw new LlmBoundaryError(`${label} is not a safe version`);
  }
}

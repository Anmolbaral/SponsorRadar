import { z } from "zod";
import {
  LlmBoundaryError,
  type LlmPort,
  type LlmProviderRequest,
  type LlmProviderResponse
} from "@/src/agent/llm/llm-port";

const UsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative()
  })
  .passthrough();
const ResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    model: z.string().optional(),
    output: z.array(z.record(z.string(), z.unknown())),
    usage: UsageSchema,
    incomplete_details: z
      .object({ reason: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional()
  })
  .passthrough();
const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        type: z.string().optional(),
        code: z.string().nullable().optional()
      })
      .passthrough()
  })
  .passthrough();

export interface OpenAiResponsesLlmPortOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: "none" | "low";
  fetch?: typeof globalThis.fetch;
}

/**
 * A zero-retry OpenAI Responses API adapter. It requests strict JSON Schema
 * output, exposes no tools, stores no response, and never repairs malformed
 * output.
 */
export class OpenAiResponsesLlmPort implements LlmPort {
  readonly provider = "openai";
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly reasoningEffort: "none" | "low";
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: OpenAiResponsesLlmPortOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) {
      throw new TypeError("OpenAI API key must not be empty");
    }
    this.model = options.model?.trim() || "gpt-5.6-terra";
    if (!/^gpt-5\.6-(?:terra|sol)$/.test(this.model)) {
      throw new TypeError(
        "Phase 4 OpenAI model must be gpt-5.6-terra or gpt-5.6-sol"
      );
    }
    const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/+$/,
      ""
    );
    this.endpoint = `${baseUrl}/responses`;
    this.reasoningEffort = options.reasoningEffort ?? "low";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async generateStructured(
    request: LlmProviderRequest
  ): Promise<LlmProviderResponse> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": request.idempotencyKey,
        "X-Client-Request-Id": request.requestId
      },
      body: JSON.stringify({
        model: this.model,
        instructions: request.instructions,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: request.input }]
          }
        ],
        reasoning: { effort: this.reasoningEffort },
        tools: [],
        max_output_tokens: request.maxOutputTokens,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: request.schemaName,
            strict: true,
            schema: request.outputSchema
          }
        }
      }),
      signal: AbortSignal.timeout(request.timeoutMs)
    });
    if (!response.ok) {
      const providerRequestId = safeProviderIdentifier(
        response.headers.get("x-request-id")
      );
      let providerErrorType: string | null = null;
      let providerErrorCode: string | null = null;
      try {
        const errorBody = ErrorResponseSchema.safeParse(
          (await response.json()) as unknown
        );
        if (errorBody.success) {
          providerErrorType = errorBody.data.error.type ?? null;
          providerErrorCode = errorBody.data.error.code ?? null;
        }
      } catch {
        // A non-JSON provider error still maps to the same safe status error.
      }
      throw new OpenAiLlmError(
        `OpenAI Responses request failed with status ${response.status}`,
        response.status,
        providerRequestId,
        providerErrorType,
        providerErrorCode
      );
    }
    const parsed = ResponseSchema.parse(
      (await response.json()) as unknown
    );
    const providerResponseId = safeProviderIdentifier(parsed.id);
    if (!providerResponseId) {
      throw new LlmBoundaryError(
        "OpenAI returned an invalid response object ID"
      );
    }
    if (
      parsed.model &&
      parsed.model !== this.model &&
      !parsed.model.startsWith(`${this.model}-`)
    ) {
      throw new LlmBoundaryError(
        "OpenAI returned a model outside the configured model pin"
      );
    }

    const contentItems = parsed.output.flatMap((item) => {
      if (item.type !== "message") return [];
      return Array.isArray(item.content)
        ? item.content.filter(
            (content): content is Record<string, unknown> =>
              typeof content === "object" &&
              content !== null &&
              !Array.isArray(content)
          )
        : [];
    });
    const refusals = contentItems.filter(
      (content) => content.type === "refusal"
    );
    const outputTexts = contentItems.filter(
      (content) => content.type === "output_text"
    );
    const toolCalls = parsed.output.filter((item) =>
      typeof item.type === "string" &&
      /(?:function|tool|computer|web)_?call/i.test(item.type)
    ).length;
    let output: unknown = null;
    if (outputTexts.length === 1) {
      const text = outputTexts[0].text;
      if (typeof text !== "string" || Buffer.byteLength(text) > 32_000) {
        throw new LlmBoundaryError(
          "OpenAI returned an invalid or oversized output text"
        );
      }
      try {
        output = JSON.parse(text) as unknown;
      } catch {
        throw new LlmBoundaryError(
          "OpenAI returned malformed structured JSON"
        );
      }
    } else if (refusals.length === 0) {
      throw new LlmBoundaryError(
        "OpenAI returned an unexpected structured-output shape"
      );
    }

    return {
      output,
      providerRequestId: safeProviderIdentifier(
        response.headers.get("x-request-id")
      ),
      providerResponseId,
      inputTokens: parsed.usage.input_tokens,
      outputTokens: parsed.usage.output_tokens,
      finishReason:
        parsed.incomplete_details?.reason ?? parsed.status,
      refusal:
        refusals.length > 0
          ? String(refusals[0].refusal ?? "refused")
          : null,
      toolCalls
    };
  }
}

export class OpenAiLlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly providerRequestId: string | null = null,
    readonly providerErrorType: string | null = null,
    readonly providerErrorCode: string | null = null
  ) {
    super(message);
    this.name = "OpenAiLlmError";
  }
}

function safeProviderIdentifier(
  value: string | null
): string | null {
  return value && /^[a-zA-Z0-9._:-]{1,200}$/.test(value)
    ? value
    : null;
}

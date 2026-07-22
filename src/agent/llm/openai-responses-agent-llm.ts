import { z } from "zod";
import {
  AgentLlmBoundaryError,
  type AgentAssistantMessage,
  type AgentLlmPort,
  type AgentLlmRequest,
  type AgentLlmResponse,
  type AgentMessage,
  type AgentToolCall
} from "@/src/agent/llm/agent-llm-port";
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

const MAX_OUTPUT_TEXT_BYTES = 32_000;
const MAX_TOOL_ARGUMENT_BYTES = 8_000;

export interface OpenAiResponsesAgentLlmOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Zero-retry OpenAI Responses adapter for the agent loop (ADR 0008). Unlike
 * the wording adapter it exposes the agent tool catalog as strict function
 * tools; like the wording adapter it stores no response, never repairs
 * malformed output, and pins the model. Serial tool calls only in v1 —
 * per-call credit preflight is only sound when calls settle in order.
 */
export class OpenAiResponsesAgentLlm implements AgentLlmPort {
  readonly provider = "openai";
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: OpenAiResponsesAgentLlmOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) {
      throw new TypeError("OpenAI API key must not be empty");
    }
    this.model = options.model?.trim() || "gpt-5.6-terra";
    if (!/^gpt-5\.6-(?:terra|sol)$/.test(this.model)) {
      throw new TypeError(
        "Agent planner OpenAI model must be gpt-5.6-terra or gpt-5.6-sol"
      );
    }
    const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/+$/,
      ""
    );
    this.endpoint = `${baseUrl}/responses`;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async complete(request: AgentLlmRequest): Promise<AgentLlmResponse> {
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
        instructions: firstSystemMessage(request.messages),
        input: toProviderInput(request.messages),
        tools: request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: true
        })),
        tool_choice: request.toolChoice,
        parallel_tool_calls: false,
        max_output_tokens: request.maxOutputTokens,
        store: false
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

    const parsed = ResponseSchema.parse((await response.json()) as unknown);
    if (
      parsed.model &&
      parsed.model !== this.model &&
      !parsed.model.startsWith(`${this.model}-`)
    ) {
      throw new AgentLlmBoundaryError(
        "OpenAI returned a model outside the configured model pin"
      );
    }

    const toolCalls = parsed.output
      .filter((item) => item.type === "function_call")
      .map(toAgentToolCall);
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
    const refused = contentItems.some(
      (content) => content.type === "refusal"
    );
    const outputText = contentItems
      .filter((content) => content.type === "output_text")
      .map((content) => {
        if (
          typeof content.text !== "string" ||
          Buffer.byteLength(content.text, "utf8") > MAX_OUTPUT_TEXT_BYTES
        ) {
          throw new AgentLlmBoundaryError(
            "OpenAI returned an invalid or oversized output text"
          );
        }
        return content.text;
      })
      .join("\n");

    const message: AgentAssistantMessage = {
      role: "assistant",
      content: outputText.length > 0 ? outputText : null,
      toolCalls
    };
    return {
      message,
      stopReason: stopReasonFor(parsed, refused, toolCalls.length),
      usage: {
        inputTokens: parsed.usage.input_tokens,
        outputTokens: parsed.usage.output_tokens
      },
      providerRequestId: safeProviderIdentifier(
        response.headers.get("x-request-id")
      ),
      providerResponseId: safeProviderIdentifier(parsed.id)
    };
  }
}

function firstSystemMessage(messages: readonly AgentMessage[]): string {
  const system = messages.find((message) => message.role === "system");
  if (!system || system.role !== "system") {
    throw new AgentLlmBoundaryError(
      "The agent transcript must start with a system message"
    );
  }
  return system.content;
}

function toProviderInput(messages: readonly AgentMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        break;
      case "user":
        items.push({
          role: "user",
          content: [{ type: "input_text", text: message.content }]
        });
        break;
      case "assistant":
        if (message.content !== null && message.content.length > 0) {
          items.push({
            role: "assistant",
            content: [{ type: "output_text", text: message.content }]
          });
        }
        for (const call of message.toolCalls) {
          items.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: call.rawArguments
          });
        }
        break;
      case "tool_result":
        items.push({
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.content
        });
        break;
    }
  }
  return items;
}

function toAgentToolCall(item: Record<string, unknown>): AgentToolCall {
  const callId = item.call_id;
  const name = item.name;
  const rawArguments = item.arguments;
  if (
    typeof callId !== "string" ||
    callId.length === 0 ||
    typeof name !== "string" ||
    name.length === 0 ||
    typeof rawArguments !== "string"
  ) {
    throw new AgentLlmBoundaryError(
      "OpenAI returned a malformed function call item"
    );
  }
  if (Buffer.byteLength(rawArguments, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
    throw new AgentLlmBoundaryError(
      "OpenAI returned oversized function call arguments"
    );
  }
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(rawArguments) as unknown;
  } catch {
    throw new AgentLlmBoundaryError(
      "OpenAI returned malformed function call arguments"
    );
  }
  return {
    id: callId,
    name,
    arguments: parsedArguments,
    rawArguments
  };
}

function stopReasonFor(
  parsed: z.infer<typeof ResponseSchema>,
  refused: boolean,
  toolCallCount: number
): AgentLlmResponse["stopReason"] {
  if (refused) {
    return "refusal";
  }
  if (parsed.incomplete_details?.reason === "max_output_tokens") {
    return "max_tokens";
  }
  return toolCallCount > 0 ? "tool_use" : "end_turn";
}

function safeProviderIdentifier(value: string | null): string | null {
  return value && /^[a-zA-Z0-9._:-]{1,200}$/.test(value) ? value : null;
}

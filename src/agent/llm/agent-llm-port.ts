/**
 * Provider-agnostic chat + tool-call boundary for the agentic engine
 * (ADR 0008). The message format is owned by this port; adapters translate
 * to and from provider wire shapes. This port is separate from `LlmPort`
 * (the bounded wording boundary), which stays tool-free.
 */

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface AgentToolCall {
  /** Provider call id, echoed back on the matching tool_result message. */
  id: string;
  name: string;
  /** Adapter-parsed JSON arguments; the broker re-validates with Zod. */
  arguments: unknown;
  /** Exact provider argument string, kept for audit fingerprints. */
  rawArguments: string;
}

export type AgentAssistantMessage = {
  role: "assistant";
  content: string | null;
  toolCalls: readonly AgentToolCall[];
};

export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AgentAssistantMessage
  | {
      role: "tool_result";
      toolCallId: string;
      toolName: string;
      /** Sanitized JSON envelope; never raw provider payloads. */
      content: string;
      isError: boolean;
    };

export interface AgentToolDefinition {
  name: string;
  description: string;
  /** Strict JSON Schema (additionalProperties: false everywhere). */
  inputSchema: JsonSchema;
}

export interface AgentLlmRequest {
  requestId: string;
  idempotencyKey: string;
  messages: readonly AgentMessage[];
  tools: readonly AgentToolDefinition[];
  toolChoice: "auto" | "required";
  maxOutputTokens: number;
  timeoutMs: number;
}

export type AgentLlmStopReason =
  | "tool_use"
  | "end_turn"
  | "max_tokens"
  | "refusal";

export interface AgentLlmResponse {
  message: AgentAssistantMessage;
  stopReason: AgentLlmStopReason;
  usage: { inputTokens: number; outputTokens: number };
  providerRequestId: string | null;
  providerResponseId: string | null;
}

export interface AgentLlmPort {
  readonly provider: string;
  readonly model: string;
  complete(request: AgentLlmRequest): Promise<AgentLlmResponse>;
}

export class AgentLlmBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLlmBoundaryError";
  }
}

export function approximateAgentTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

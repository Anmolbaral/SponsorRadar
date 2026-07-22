import {
  AgentLlmBoundaryError,
  approximateAgentTokens,
  type AgentAssistantMessage,
  type AgentLlmPort,
  type AgentLlmRequest,
  type AgentLlmResponse,
  type AgentLlmStopReason,
  type AgentMessage
} from "@/src/agent/llm/agent-llm-port";

export interface FixtureAgentStep {
  /** Throws to fail the test when the observed transcript is unexpected. */
  expect?: (messages: readonly AgentMessage[]) => void;
  respond: AgentAssistantMessage;
  stopReason?: AgentLlmStopReason;
}

/**
 * Deterministic scripted adapter for the agent loop. Steps are consumed in
 * order; requesting more turns than scripted fails closed so a test can
 * never silently loop.
 */
export class FixtureAgentLlm implements AgentLlmPort {
  readonly provider = "fixture";
  readonly model = "agent-fixture-v1";

  private nextStep = 0;

  constructor(private readonly steps: readonly FixtureAgentStep[]) {}

  get consumedSteps(): number {
    return this.nextStep;
  }

  async complete(request: AgentLlmRequest): Promise<AgentLlmResponse> {
    const step = this.steps[this.nextStep];
    if (!step) {
      throw new AgentLlmBoundaryError(
        `FixtureAgentLlm has no step ${this.nextStep + 1}; scripted ${this.steps.length}`
      );
    }
    this.nextStep += 1;
    step.expect?.(request.messages);

    const outputText = `${step.respond.content ?? ""}${step.respond.toolCalls
      .map((call) => call.rawArguments)
      .join("")}`;
    return {
      message: step.respond,
      stopReason:
        step.stopReason ??
        (step.respond.toolCalls.length > 0 ? "tool_use" : "end_turn"),
      usage: {
        inputTokens: approximateAgentTokens(JSON.stringify(request.messages)),
        outputTokens: approximateAgentTokens(outputText)
      },
      providerRequestId: `fixture_${request.requestId}`,
      providerResponseId: null
    };
  }
}

export function fixtureToolCall(
  name: string,
  callArguments: Record<string, unknown>,
  id?: string
): AgentAssistantMessage["toolCalls"][number] {
  const rawArguments = JSON.stringify(callArguments);
  return {
    id: id ?? `call_${name}`,
    name,
    arguments: callArguments,
    rawArguments
  };
}

export function fixtureAssistantToolUse(
  name: string,
  callArguments: Record<string, unknown>,
  id?: string
): AgentAssistantMessage {
  return {
    role: "assistant",
    content: null,
    toolCalls: [fixtureToolCall(name, callArguments, id)]
  };
}

export function fixtureAssistantText(content: string): AgentAssistantMessage {
  return { role: "assistant", content, toolCalls: [] };
}

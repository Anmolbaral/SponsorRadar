import type {
  AgentLlmPort,
  AgentLlmResponse
} from "@/src/agent/llm/agent-llm-port";
import type { AuditRecorder } from "@/src/observability/audit";
import type { CreditBudget } from "@/src/radar/domain/credits";
import type { WinbackReport } from "@/src/radar/domain/types";
import { agentToolDefinitions } from "@/src/radar/application/agentic/agent-tools";
import {
  AGENT_PROMPT_VERSION,
  AGENT_TOOL_SCHEMA_VERSION,
  buildAgentSystemPrompt,
  buildAgentUserMessage
} from "@/src/radar/application/agentic/prompts";
import type { AgentToolBroker } from "@/src/radar/application/agentic/tool-broker";
import {
  AgentTranscript,
  DEFAULT_TRANSCRIPT_CEILINGS,
  type AgentTranscriptSink
} from "@/src/radar/application/agentic/transcript";

export const DEFAULT_MAX_ITERATIONS = 12;
const MAX_OUTPUT_TOKENS_PER_CALL = 2_000;
const LLM_CALL_TIMEOUT_MS = 60_000;

export class AgentRefusalError extends Error {
  constructor() {
    super("The planner refused the research request");
    this.name = "AgentRefusalError";
  }
}

export class AgentDidNotFinalizeError extends Error {
  constructor() {
    super(
      "The planner stopped proposing tools without calling submit_report"
    );
    this.name = "AgentDidNotFinalizeError";
  }
}

export class AgentIterationLimitError extends Error {
  constructor(iterations: number) {
    super(
      `The planner used all ${iterations} turns without calling submit_report`
    );
    this.name = "AgentIterationLimitError";
  }
}

export interface AgentLoopDependencies {
  runId: string;
  channel: string;
  llm: AgentLlmPort;
  broker: AgentToolBroker;
  audit: AuditRecorder;
  budget: CreditBudget;
  maxIterations?: number;
  transcriptSink?: AgentTranscriptSink;
}

/**
 * The hand-rolled agent loop (ADR 0008): the model proposes, the broker
 * disposes, and only a submit_report tool call ends the run successfully.
 * Every ceiling — iterations, planner calls, output tokens, transcript
 * bytes, credits — is enforced in code, never by the model.
 */
export async function runAgentLoop(
  deps: AgentLoopDependencies
): Promise<WinbackReport> {
  const maxIterations = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const transcript = new AgentTranscript(
    { ...DEFAULT_TRANSCRIPT_CEILINGS, maxLlmCalls: maxIterations },
    deps.transcriptSink
  );

  await transcript.append(
    {
      role: "system",
      content: buildAgentSystemPrompt({
        maximumCredits: deps.budget.maximumCredits,
        maxIterations
      })
    },
    0
  );
  await transcript.append(
    {
      role: "user",
      content: buildAgentUserMessage({
        channel: deps.channel,
        maximumCredits: deps.budget.maximumCredits
      })
    },
    0
  );

  let nudged = false;
  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      transcript.assertBeforeLlmCall();
      const response = await completePlannerTurn(
        deps,
        transcript,
        iteration
      );
      transcript.recordLlmUsage(response.usage.outputTokens);
      await transcript.append(response.message, iteration);

      if (response.stopReason === "refusal") {
        throw new AgentRefusalError();
      }
      if (response.message.toolCalls.length === 0) {
        if (nudged) {
          throw new AgentDidNotFinalizeError();
        }
        nudged = true;
        await transcript.append(
          {
            role: "user",
            content:
              "Respond only by calling tools. Call submit_report to finish."
          },
          iteration
        );
        continue;
      }

      for (const call of response.message.toolCalls) {
        const outcome = await deps.broker.dispatch(call);
        await transcript.append(
          {
            role: "tool_result",
            toolCallId: call.id,
            toolName: call.name,
            content: outcome.content,
            isError: outcome.isError
          },
          iteration
        );
        await transcript.recordBudget(deps.budget.snapshot(), iteration);
        if (outcome.terminal) {
          await transcript.recordTerminal(
            "completed",
            `submit_report accepted with ${outcome.terminal.report.leads.length} lead(s)`,
            iteration
          );
          return outcome.terminal.report;
        }
      }
    }
    throw new AgentIterationLimitError(maxIterations);
  } catch (error) {
    await transcript.recordTerminal(
      "failed",
      error instanceof Error ? error.message : "Unknown planner failure",
      maxIterations
    );
    throw error;
  }
}

function completePlannerTurn(
  deps: AgentLoopDependencies,
  transcript: AgentTranscript,
  iteration: number
): Promise<AgentLlmResponse> {
  const requestId = `${deps.runId}:turn-${iteration}`;
  return deps.audit
    .llm(
      {
        provider: deps.llm.provider,
        model: deps.llm.model,
        purpose: "agent_loop",
        reason: `Plan research turn ${iteration}`,
        requestId,
        promptVersion: AGENT_PROMPT_VERSION,
        schemaVersion: AGENT_TOOL_SCHEMA_VERSION,
        input: { iteration, channel: deps.channel },
        context: { messageCount: transcript.messages.length },
        evidence: { budget: deps.budget.snapshot() },
        maxOutputTokens: MAX_OUTPUT_TOKENS_PER_CALL
      },
      async () => {
        const response = await deps.llm.complete({
          requestId,
          idempotencyKey: requestId,
          messages: transcript.messages,
          tools: agentToolDefinitions(),
          toolChoice: "auto",
          maxOutputTokens: MAX_OUTPUT_TOKENS_PER_CALL,
          timeoutMs: LLM_CALL_TIMEOUT_MS
        });
        return {
          value: response.message,
          providerRequestId: response.providerRequestId,
          providerResponseId: response.providerResponseId,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          finishReason: response.stopReason,
          structuredOutputValid: response.stopReason !== "refusal",
          response
        };
      }
    )
    .then((result) => (result as { response: AgentLlmResponse }).response);
}

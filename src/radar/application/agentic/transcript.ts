import type { AgentMessage } from "@/src/agent/llm/agent-llm-port";
import type { CreditBudgetSnapshot } from "@/src/radar/domain/credits";

export const AGENT_TRANSCRIPT_SCHEMA_VERSION = "agentic-transcript-v1";

export type AgentTranscriptEvent =
  | { kind: "message"; iteration: number; message: AgentMessage }
  | { kind: "budget"; iteration: number; snapshot: CreditBudgetSnapshot }
  | {
      kind: "terminal";
      iteration: number;
      status: "completed" | "failed";
      reason: string;
    };

export type AgentTranscriptSink = (
  event: AgentTranscriptEvent
) => Promise<void> | void;

export class AgentTranscriptBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTranscriptBudgetError";
  }
}

export interface AgentTranscriptCeilings {
  maxTranscriptBytes: number;
  maxLlmCalls: number;
  maxTotalOutputTokens: number;
}

export const DEFAULT_TRANSCRIPT_CEILINGS: AgentTranscriptCeilings = {
  maxTranscriptBytes: 120_000,
  maxLlmCalls: 12,
  maxTotalOutputTokens: 20_000
};

/**
 * The loop's working transcript with fail-closed size accounting. Every
 * ceiling breach throws before the next provider call is made — the loop
 * never sends an unbounded transcript.
 */
export class AgentTranscript {
  private readonly transcriptMessages: AgentMessage[] = [];
  private transcriptBytes = 0;
  private llmCalls = 0;
  private totalOutputTokens = 0;

  constructor(
    private readonly ceilings: AgentTranscriptCeilings = DEFAULT_TRANSCRIPT_CEILINGS,
    private readonly sink?: AgentTranscriptSink
  ) {}

  get messages(): readonly AgentMessage[] {
    return this.transcriptMessages;
  }

  async append(message: AgentMessage, iteration: number): Promise<void> {
    this.transcriptMessages.push(message);
    this.transcriptBytes += Buffer.byteLength(
      JSON.stringify(message),
      "utf8"
    );
    await this.sink?.({ kind: "message", iteration, message });
  }

  async recordBudget(
    snapshot: CreditBudgetSnapshot,
    iteration: number
  ): Promise<void> {
    await this.sink?.({ kind: "budget", iteration, snapshot });
  }

  async recordTerminal(
    status: "completed" | "failed",
    reason: string,
    iteration: number
  ): Promise<void> {
    await this.sink?.({ kind: "terminal", iteration, status, reason });
  }

  recordLlmUsage(outputTokens: number): void {
    this.llmCalls += 1;
    this.totalOutputTokens += outputTokens;
  }

  assertBeforeLlmCall(): void {
    if (this.transcriptBytes > this.ceilings.maxTranscriptBytes) {
      throw new AgentTranscriptBudgetError(
        `Transcript grew to ${this.transcriptBytes} bytes, above the ${this.ceilings.maxTranscriptBytes}-byte ceiling`
      );
    }
    if (this.llmCalls >= this.ceilings.maxLlmCalls) {
      throw new AgentTranscriptBudgetError(
        `The run already made ${this.llmCalls} planner calls, the ceiling`
      );
    }
    if (this.totalOutputTokens > this.ceilings.maxTotalOutputTokens) {
      throw new AgentTranscriptBudgetError(
        `Planner output reached ${this.totalOutputTokens} tokens, above the ${this.ceilings.maxTotalOutputTokens}-token ceiling`
      );
    }
  }
}

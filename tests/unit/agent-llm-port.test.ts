import { describe, expect, it } from "vitest";
import {
  AgentLlmBoundaryError,
  type AgentLlmRequest
} from "@/src/agent/llm/agent-llm-port";
import {
  FixtureAgentLlm,
  fixtureAssistantText,
  fixtureAssistantToolUse
} from "@/src/agent/llm/fixture-agent-llm";

function request(overrides: Partial<AgentLlmRequest> = {}): AgentLlmRequest {
  return {
    requestId: "run_test:turn-1",
    idempotencyKey: "run_test:turn-1",
    messages: [
      { role: "system", content: "policy" },
      { role: "user", content: "research @Example" }
    ],
    tools: [],
    toolChoice: "auto",
    maxOutputTokens: 2_000,
    timeoutMs: 30_000,
    ...overrides
  };
}

describe("FixtureAgentLlm", () => {
  it("consumes scripted steps in order and reports tool_use stop reasons", async () => {
    const llm = new FixtureAgentLlm([
      { respond: fixtureAssistantToolUse("resolve_target", { channel: "@Example" }) },
      { respond: fixtureAssistantText("done") }
    ]);

    const first = await llm.complete(request());
    expect(first.stopReason).toBe("tool_use");
    expect(first.message.toolCalls).toHaveLength(1);
    expect(first.message.toolCalls[0].name).toBe("resolve_target");
    expect(first.message.toolCalls[0].rawArguments).toBe(
      JSON.stringify({ channel: "@Example" })
    );

    const second = await llm.complete(request());
    expect(second.stopReason).toBe("end_turn");
    expect(llm.consumedSteps).toBe(2);
  });

  it("fails closed when the loop requests more turns than scripted", async () => {
    const llm = new FixtureAgentLlm([
      { respond: fixtureAssistantText("only turn") }
    ]);
    await llm.complete(request());
    await expect(llm.complete(request())).rejects.toThrow(
      AgentLlmBoundaryError
    );
  });

  it("runs step expectations against the observed transcript", async () => {
    const llm = new FixtureAgentLlm([
      {
        expect: (messages) => {
          if (messages[0].role !== "system") {
            throw new Error("expected the system prompt first");
          }
        },
        respond: fixtureAssistantText("ok")
      },
      {
        expect: () => {
          throw new Error("scripted expectation failure");
        },
        respond: fixtureAssistantText("never reached")
      }
    ]);

    await expect(llm.complete(request())).resolves.toBeDefined();
    await expect(llm.complete(request())).rejects.toThrow(
      "scripted expectation failure"
    );
  });

  it("reports deterministic non-zero token usage", async () => {
    const llm = new FixtureAgentLlm([
      { respond: fixtureAssistantText("short") }
    ]);
    const response = await llm.complete(request());
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
  });

  it("honours an explicit stop reason override", async () => {
    const llm = new FixtureAgentLlm([
      { respond: fixtureAssistantText(""), stopReason: "refusal" }
    ]);
    const response = await llm.complete(request());
    expect(response.stopReason).toBe("refusal");
  });
});

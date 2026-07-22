import { describe, expect, it } from "vitest";
import {
  AgentLlmBoundaryError,
  type AgentLlmRequest
} from "@/src/agent/llm/agent-llm-port";
import { OpenAiResponsesAgentLlm } from "@/src/agent/llm/openai-responses-agent-llm";
import { OpenAiLlmError } from "@/src/agent/llm/openai-responses-agent-llm";

function providerResponse(output: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_agent_test",
    status: "completed",
    model: "gpt-5.6-terra",
    output,
    usage: { input_tokens: 120, output_tokens: 24 },
    ...overrides
  };
}

function stubFetch(
  body: unknown,
  options: { status?: number; capture?: { body?: unknown } } = {}
): typeof globalThis.fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (options.capture) {
      options.capture.body = JSON.parse(String(init?.body));
    }
    return new Response(JSON.stringify(body), {
      status: options.status ?? 200,
      headers: { "x-request-id": "req_agent_test" }
    });
  }) as typeof globalThis.fetch;
}

function agentRequest(): AgentLlmRequest {
  return {
    requestId: "run_x:turn-1",
    idempotencyKey: "run_x:turn-1",
    messages: [
      { role: "system", content: "You plan sponsor research." },
      { role: "user", content: '{"channel":"@Example"}' },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_1",
            name: "resolve_target",
            arguments: { channel: "@Example" },
            rawArguments: '{"channel":"@Example"}'
          }
        ]
      },
      {
        role: "tool_result",
        toolCallId: "call_1",
        toolName: "resolve_target",
        content: '{"ok":true}',
        isError: false
      }
    ],
    tools: [
      {
        name: "resolve_target",
        description: "Resolve the channel",
        inputSchema: {
          type: "object",
          properties: { channel: { type: "string" } },
          required: ["channel"],
          additionalProperties: false
        }
      }
    ],
    toolChoice: "auto",
    maxOutputTokens: 2_000,
    timeoutMs: 5_000
  };
}

describe("OpenAiResponsesAgentLlm", () => {
  it("encodes the transcript as Responses input with strict serial tools", async () => {
    const capture: { body?: unknown } = {};
    const adapter = new OpenAiResponsesAgentLlm({
      apiKey: "test-key",
      fetch: stubFetch(
        providerResponse([
          {
            type: "function_call",
            call_id: "call_2",
            name: "list_locked_peers",
            arguments: "{}"
          }
        ]),
        { capture }
      )
    });

    const response = await adapter.complete(agentRequest());
    const body = capture.body as {
      instructions: string;
      input: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
      parallel_tool_calls: boolean;
      store: boolean;
    };

    expect(body.instructions).toBe("You plan sponsor research.");
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.store).toBe(false);
    expect(body.tools[0]).toMatchObject({
      type: "function",
      name: "resolve_target",
      strict: true
    });
    expect(body.input.map((item) => item.type ?? item.role)).toEqual([
      "user",
      "function_call",
      "function_call_output"
    ]);

    expect(response.stopReason).toBe("tool_use");
    expect(response.message.toolCalls[0]).toMatchObject({
      id: "call_2",
      name: "list_locked_peers",
      arguments: {}
    });
  });

  it("maps a text-only answer to end_turn and a refusal item to refusal", async () => {
    const textAdapter = new OpenAiResponsesAgentLlm({
      apiKey: "test-key",
      fetch: stubFetch(
        providerResponse([
          {
            type: "message",
            content: [{ type: "output_text", text: "done" }]
          }
        ])
      )
    });
    const textResponse = await textAdapter.complete(agentRequest());
    expect(textResponse.stopReason).toBe("end_turn");
    expect(textResponse.message.content).toBe("done");

    const refusalAdapter = new OpenAiResponsesAgentLlm({
      apiKey: "test-key",
      fetch: stubFetch(
        providerResponse([
          {
            type: "message",
            content: [{ type: "refusal", refusal: "cannot help" }]
          }
        ])
      )
    });
    const refusalResponse = await refusalAdapter.complete(agentRequest());
    expect(refusalResponse.stopReason).toBe("refusal");
  });

  it("fails closed on malformed tool-call arguments and model pin violations", async () => {
    const malformed = new OpenAiResponsesAgentLlm({
      apiKey: "test-key",
      fetch: stubFetch(
        providerResponse([
          {
            type: "function_call",
            call_id: "call_3",
            name: "resolve_target",
            arguments: "{not json"
          }
        ])
      )
    });
    await expect(malformed.complete(agentRequest())).rejects.toThrow(
      AgentLlmBoundaryError
    );

    const wrongModel = new OpenAiResponsesAgentLlm({
      apiKey: "test-key",
      fetch: stubFetch(
        providerResponse([], { model: "gpt-other" })
      )
    });
    await expect(wrongModel.complete(agentRequest())).rejects.toThrow(
      "model pin"
    );
  });

  it("surfaces provider errors with status and identifiers, without retrying", async () => {
    let calls = 0;
    const adapter = new OpenAiResponsesAgentLlm({
      apiKey: "test-key",
      fetch: (async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ error: { type: "rate_limit", code: "429" } }),
          { status: 429, headers: { "x-request-id": "req_err" } }
        );
      }) as typeof globalThis.fetch
    });
    await expect(adapter.complete(agentRequest())).rejects.toThrow(
      OpenAiLlmError
    );
    expect(calls).toBe(1);
  });

  it("rejects models outside the pin at construction", () => {
    expect(
      () => new OpenAiResponsesAgentLlm({ apiKey: "k", model: "gpt-4o" })
    ).toThrow(TypeError);
  });
});

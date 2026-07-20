import { describe, expect, it, vi } from "vitest";
import {
  BoundedLlmSession,
  LlmBudgetError,
  type LlmPort,
  type LlmProviderRequest,
  type LlmProviderResponse,
  type StructuredLlmTask
} from "@/src/agent/llm/llm-port";
import { OpenAiResponsesLlmPort } from "@/src/agent/llm/openai-responses-llm-port";
import { AuditRecorder } from "@/src/observability/audit";

interface Output {
  result: string;
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["result"],
  properties: {
    result: { type: "string" }
  }
};

describe("bounded provider-neutral LLM boundary", () => {
  it("runtime-validates output and emits paired safe audit events", async () => {
    const port = new ScriptedPort({
      output: { result: "grounded" },
      providerRequestId: "provider-request",
      inputTokens: 12,
      outputTokens: 4,
      finishReason: "completed",
      refusal: null,
      toolCalls: 0
    });
    const audit = auditRecorder();
    const result = await new BoundedLlmSession(port, audit).execute(
      task("peer_rationale")
    );

    expect(result.value).toEqual({ result: "grounded" });
    expect(port.requests).toHaveLength(1);
    expect(audit.getEvents().map((event) => event.eventType)).toEqual([
      "llm.started",
      "llm.completed"
    ]);
    expect(audit.getEvents()[1].llm).toMatchObject({
      providerRequestId: "provider-request",
      structuredOutputValid: true,
      inputTokens: 12,
      outputTokens: 4,
      attemptCount: 1
    });
    expect(JSON.stringify(audit.getEvents())).not.toContain(
      "untrusted evidence body"
    );
  });

  it("records invalid output as a failure and never repairs it", async () => {
    const audit = auditRecorder();
    const port = new ScriptedPort(response({ unexpected: true }));

    await expect(
      new BoundedLlmSession(port, audit).execute(
        task("peer_rationale")
      )
    ).rejects.toThrow(/invalid output/);
    expect(audit.getEvents().map((event) => event.eventType)).toEqual([
      "llm.started",
      "llm.failed"
    ]);
    expect(audit.getEvents()[1].llm).toMatchObject({
      providerRequestId: "provider-request",
      inputTokens: 10,
      outputTokens: 3,
      finishReason: "completed",
      structuredOutputValid: false,
      errorType: "Error"
    });
    expect(audit.summarize(0).llmCalls).toBe(1);
  });

  it("records safe provider failure diagnostics without retaining its message", async () => {
    const audit = auditRecorder();
    const providerError = Object.assign(
      new Error("provider message must not enter the audit"),
      {
        name: "OpenAiLlmError",
        status: 429,
        providerRequestId: "req_quota_test",
        providerErrorType: "insufficient_quota",
        providerErrorCode: "insufficient_quota"
      }
    );

    await expect(
      new BoundedLlmSession(
        new FailingPort(providerError),
        audit
      ).execute(task("peer_rationale"))
    ).rejects.toBe(providerError);
    expect(audit.getEvents().at(-1)?.llm).toMatchObject({
      providerRequestId: "req_quota_test",
      httpStatus: 429,
      providerErrorType: "insufficient_quota",
      providerErrorCode: "insufficient_quota",
      errorType: "OpenAiLlmError",
      outcome: "failure"
    });
    expect(JSON.stringify(audit.getEvents())).not.toContain(
      "provider message must not enter the audit"
    );
  });

  it("rejects tool calls and duplicate purposes", async () => {
    const toolAudit = auditRecorder();
    await expect(
      new BoundedLlmSession(
        new ScriptedPort({ ...response({ result: "ok" }), toolCalls: 1 }),
        toolAudit
      ).execute(task("peer_rationale"))
    ).rejects.toThrow(/tool call/);

    const session = new BoundedLlmSession(
      new ScriptedPort(response({ result: "ok" })),
      auditRecorder()
    );
    await session.execute(task("peer_rationale"));
    await expect(
      session.execute(task("peer_rationale"))
    ).rejects.toBeInstanceOf(LlmBudgetError);
  });

  it("reserves output tokens across purposes before calling a provider", async () => {
    const port = new ScriptedPort(response({ result: "ok" }));
    const session = new BoundedLlmSession(port, auditRecorder(), {
      maxTotalOutputTokens: 500
    });
    await session.execute(task("peer_rationale"));
    await expect(
      session.execute(task("grounded_report_wording"))
    ).rejects.toBeInstanceOf(LlmBudgetError);
    expect(port.requests).toHaveLength(1);
  });
});

describe("OpenAI Responses structured-output adapter", () => {
  it("sends a tool-free, non-stored, strict-schema request and parses output", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "gpt-5.6-terra",
        tools: [],
        store: false,
        max_output_tokens: 500,
        reasoning: { effort: "low" },
        text: {
          format: {
            type: "json_schema",
            name: "test_schema",
            strict: true,
            schema
          }
        }
      });
      expect(init?.headers).toMatchObject({
        "Idempotency-Key": "sponsor-radar:test-request"
      });
      return Response.json(
        {
          id: "resp_test",
          status: "completed",
          model: "gpt-5.6-terra",
          output: [
            { type: "reasoning", id: "reasoning_test" },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ result: "grounded" })
                }
              ]
            }
          ],
          usage: { input_tokens: 20, output_tokens: 5 }
        },
        { headers: { "x-request-id": "req_test" } }
      );
    });
    const adapter = new OpenAiResponsesLlmPort({
      apiKey: "test-secret",
      fetch
    });

    const result = await adapter.generateStructured(providerRequest());

    expect(result).toEqual({
      output: { result: "grounded" },
      providerRequestId: "req_test",
      providerResponseId: "resp_test",
      inputTokens: 20,
      outputTokens: 5,
      finishReason: "completed",
      refusal: null,
      toolCalls: 0
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces refusals without a retry", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        id: "resp_refusal",
        status: "completed",
        model: "gpt-5.6-terra",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "Cannot comply" }]
          }
        ],
        usage: { input_tokens: 10, output_tokens: 2 }
      })
    );
    const adapter = new OpenAiResponsesLlmPort({
      apiKey: "test-secret",
      fetch
    });

    const result = await adapter.generateStructured(providerRequest());

    expect(result.refusal).toBe("Cannot comply");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains safe provider diagnostics for a non-success response", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            type: "insufficient_quota",
            code: "insufficient_quota",
            message: "sensitive provider detail is not retained"
          }
        },
        {
          status: 429,
          headers: { "x-request-id": "req_quota_test" }
        }
      )
    );
    const adapter = new OpenAiResponsesLlmPort({
      apiKey: "test-secret",
      fetch
    });

    await expect(
      adapter.generateStructured(providerRequest())
    ).rejects.toMatchObject({
      name: "OpenAiLlmError",
      status: 429,
      providerRequestId: "req_quota_test",
      providerErrorType: "insufficient_quota",
      providerErrorCode: "insufficient_quota"
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

class ScriptedPort implements LlmPort {
  readonly provider = "scripted";
  readonly model = "scripted-v1";
  readonly requests: LlmProviderRequest[] = [];

  constructor(private readonly next: LlmProviderResponse) {}

  async generateStructured(
    request: LlmProviderRequest
  ): Promise<LlmProviderResponse> {
    this.requests.push(request);
    return structuredClone(this.next);
  }
}

class FailingPort implements LlmPort {
  readonly provider = "scripted";
  readonly model = "scripted-v1";

  constructor(private readonly error: Error) {}

  async generateStructured(): Promise<never> {
    throw this.error;
  }
}

function task(
  purpose: "peer_rationale" | "grounded_report_wording"
): StructuredLlmTask<Output> {
  return {
    requestId: `request_${purpose}`,
    idempotencyKey: `idempotency:${purpose}`,
    purpose,
    promptVersion: "prompt-v1",
    schemaVersion: "schema-v1",
    schemaName: "test_schema",
    instructions: "Code-owned instructions.",
    context: { manifest: "hash-only" },
    evidence: "untrusted evidence body",
    input: JSON.stringify({ evidence: "bounded" }),
    outputSchema: schema,
    parseOutput(value) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        typeof (value as { result?: unknown }).result !== "string"
      ) {
        throw new Error("invalid output");
      }
      return { result: (value as { result: string }).result };
    }
  };
}

function response(output: unknown): LlmProviderResponse {
  return {
    output,
    providerRequestId: "provider-request",
    inputTokens: 10,
    outputTokens: 3,
    finishReason: "completed",
    refusal: null,
    toolCalls: 0
  };
}

function providerRequest(): LlmProviderRequest {
  return {
    requestId: "test-request",
    idempotencyKey: "sponsor-radar:test-request",
    purpose: "peer_rationale",
    instructions: "Return strict JSON.",
    input: "{}",
    schemaName: "test_schema",
    outputSchema: schema,
    maxOutputTokens: 500,
    timeoutMs: 1_000
  };
}

function auditRecorder(): AuditRecorder {
  let now = 0;
  return new AuditRecorder({
    runId: "run_test",
    phase: "phase_4_fixture",
    mode: "fixture",
    clock: () => ++now
  });
}

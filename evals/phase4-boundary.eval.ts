import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BoundedLlmSession,
  type LlmPort,
  type LlmProviderResponse,
  type LlmPurpose
} from "@/src/agent/llm/llm-port";
import { AuditRecorder } from "@/src/observability/audit";

interface BoundaryCase {
  id: string;
  scenario: string;
}

describe("Phase 4 frozen policy and budget boundary eval", () => {
  it("passes every call, tool, validation, and budget invariant", async () => {
    const cases = JSON.parse(
      await readFile(
        path.join(process.cwd(), "evals/cases/phase4-boundary.json"),
        "utf8"
      )
    ) as BoundaryCase[];
    const results = [];
    for (const evalCase of cases) {
      results.push({
        id: evalCase.id,
        compliant: await runScenario(evalCase.scenario)
      });
    }

    expect(
      results.filter((result) => !result.compliant)
    ).toEqual([]);
  });
});

async function runScenario(scenario: string): Promise<boolean> {
  const port = new EvalPort();
  const audit = new AuditRecorder({
    runId: "run_phase4_eval",
    phase: "phase_4_fixture",
    mode: "fixture"
  });
  let session = new BoundedLlmSession(port, audit);
  let purpose: LlmPurpose = "peer_rationale";
  let input = "{}";
  let expectSuccess = false;

  switch (scenario) {
    case "valid":
      expectSuccess = true;
      break;
    case "duplicate_purpose":
      await session.execute(task("peer_rationale", input));
      break;
    case "call_cap":
      session = new BoundedLlmSession(port, audit, {
        alreadyAttemptedPurposes: [
          "peer_rationale",
          "grounded_report_wording"
        ]
      });
      break;
    case "token_reservation":
      purpose = "grounded_report_wording";
      session = new BoundedLlmSession(port, audit, {
        alreadyAttemptedPurposes: ["peer_rationale"],
        maxTotalOutputTokens: 1_000
      });
      break;
    case "input_overflow":
      input = "x".repeat(16_001);
      break;
    case "tool_call":
      port.next = { ...port.next, toolCalls: 1 };
      break;
    case "refusal":
      port.next = { ...port.next, refusal: "refused" };
      break;
    case "token_overrun":
      port.next = { ...port.next, outputTokens: 501 };
      break;
    case "invalid_output":
      port.next = { ...port.next, output: { unexpected: true } };
      break;
    case "provider_error":
      port.error = new Error("provider unavailable");
      break;
    default:
      throw new Error(`Unknown boundary scenario ${scenario}`);
  }

  let succeeded = false;
  try {
    await session.execute(task(purpose, input));
    succeeded = true;
  } catch {
    succeeded = false;
  }
  const events = audit.getEvents();
  const attempts = events.filter(
    (event) => event.eventType === "llm.started"
  ).length;
  const terminalEvents = events.filter(
    (event) =>
      event.eventType === "llm.completed" ||
      event.eventType === "llm.failed"
  ).length;

  if (expectSuccess) {
    return (
      succeeded &&
      port.calls === 1 &&
      attempts === 1 &&
      terminalEvents === 1
    );
  }
  if (
    scenario === "duplicate_purpose"
  ) {
    return !succeeded && port.calls === 1 && attempts === 1;
  }
  if (
    scenario === "call_cap" ||
    scenario === "token_reservation" ||
    scenario === "input_overflow"
  ) {
    return !succeeded && port.calls === 0 && attempts === 0;
  }
  return (
    !succeeded &&
    port.calls === 1 &&
    attempts === 1 &&
    terminalEvents === 1 &&
    events.at(-1)?.eventType === "llm.failed"
  );
}

class EvalPort implements LlmPort {
  readonly provider = "eval";
  readonly model = "eval-v1";
  calls = 0;
  error: Error | null = null;
  next: LlmProviderResponse = {
    output: { ok: true },
    providerRequestId: "eval-request",
    inputTokens: 4,
    outputTokens: 2,
    finishReason: "completed",
    refusal: null,
    toolCalls: 0
  };

  async generateStructured(): Promise<LlmProviderResponse> {
    this.calls += 1;
    if (this.error) throw this.error;
    return structuredClone(this.next);
  }
}

function task(purpose: LlmPurpose, input: string) {
  return {
    requestId: `eval_${purpose}`,
    idempotencyKey: `eval:${purpose}`,
    purpose,
    promptVersion: "eval-v1",
    schemaVersion: "eval-v1",
    schemaName: "eval_output",
    instructions: "Return the bounded eval output.",
    context: { manifest: "frozen" },
    evidence: { case: "frozen" },
    input,
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } }
    },
    parseOutput(value: unknown): { ok: true } {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        (value as { ok?: unknown }).ok !== true
      ) {
        throw new Error("invalid output");
      }
      return { ok: true };
    }
  };
}

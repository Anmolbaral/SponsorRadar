import { describe, expect, it } from "vitest";
import { loadEnvFile } from "node:process";
import {
  parsePeerRationaleOutput,
  peerRationaleJsonSchema
} from "@/src/agent/llm/contracts";
import { BoundedLlmSession } from "@/src/agent/llm/llm-port";
import { OpenAiResponsesLlmPort } from "@/src/agent/llm/openai-responses-llm-port";
import { AuditRecorder } from "@/src/observability/audit";

const enabled =
  process.env.SPONSOR_RADAR_LIVE_LLM_SMOKE === "true";

if (enabled && !process.env.OPENAI_API_KEY?.trim()) {
  try {
    loadEnvFile(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

describe.skipIf(!enabled)("paid OpenAI Phase 4 smoke", () => {
  it("returns one strict, tool-free peer rationale within the fixed cap", async () => {
    const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
    if (!apiKey) {
      throw new Error(
        "SPONSOR_RADAR_LIVE_LLM_SMOKE requires OPENAI_API_KEY"
      );
    }
    const audit = new AuditRecorder({
      runId: "run_paid_openai_smoke",
      phase: "phase_4_live",
      mode: "live"
    });
    const session = new BoundedLlmSession(
      new OpenAiResponsesLlmPort({
        apiKey,
        model: process.env.SPONSOR_RADAR_OPENAI_MODEL
      }),
      audit
    );
    const peers = [
      {
        peerId: "peer_synthetic",
        evidenceIds: [
          "target:subscriber_count",
          "peer_synthetic:subscriber_count"
        ] as const
      }
    ];

    const result = await session.execute({
      requestId: "llm_paid_openai_smoke",
      idempotencyKey: "sponsor-radar:paid-openai-smoke-v4",
      purpose: "peer_rationale",
      promptVersion: "synthetic-live-smoke-v1",
      schemaVersion: "peer-rationale-v2",
      schemaName: "sponsor_radar_peer_rationale_smoke",
      instructions: [
        "This is a synthetic API contract test with no private data.",
        "Return strict JSON matching the supplied schema.",
        "Return the supplied opaque peer ID exactly once.",
        "The rationale must mention subscriber reach, contain no numbers or URLs, and make no other claims.",
        "Do not call tools."
      ].join(" "),
      context: { kind: "synthetic_public_smoke" },
      evidence: {
        target: { reachBand: "reference" },
        peer: { reachBand: "comparable" }
      },
      input: JSON.stringify({
        task: "Explain synthetic reach comparability only.",
        peers: peers.map((peer) => ({
          peerId: peer.peerId,
          evidenceIds: peer.evidenceIds
        }))
      }),
      outputSchema: peerRationaleJsonSchema(peers),
      parseOutput: (value) =>
        parsePeerRationaleOutput(value, peers)
    });

    expect(result.value).toHaveLength(1);
    expect(
      audit.getEvents().filter(
        (event) => event.eventType === "llm.started"
      )
    ).toHaveLength(1);
    expect(
      audit.getEvents().filter(
        (event) => event.eventType === "llm.completed"
      )
    ).toHaveLength(1);
    expect(
      audit.getEvents().find(
        (event) => event.eventType === "llm.completed"
      )?.llm
    ).toMatchObject({
      attemptCount: 1,
      structuredOutputValid: true,
      outcome: "success"
    });
    process.stdout.write(
      `${JSON.stringify({
        type: "openai_live_smoke_summary",
        model: result.model,
        calls: 1,
        providerRequestId: result.providerRequestId,
        providerResponseId: result.providerResponseId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        retries: 0,
        syntheticDataOnly: true
      })}\n`
    );
  }, 30_000);
});

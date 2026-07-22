import { loadEnvFile } from "node:process";
import { describe, expect, it } from "vitest";
import { OpenAiResponsesAgentLlm } from "@/src/agent/llm/openai-responses-agent-llm";
import { AuditRecorder } from "@/src/observability/audit";
import { UpriverHttpClient } from "@/src/radar/adapters/upriver/http-client";
import { LiveUpriverGateway } from "@/src/radar/adapters/upriver/live-evidence-gateway";
import { runAgenticReport } from "@/src/radar/application/agentic/run-agentic-report";
import { MAXIMUM_RUN_CREDITS } from "@/src/radar/application/run-workflow";

/**
 * Paid, manually authorized smoke for the full agentic engine: a real
 * OpenAI planner drives real Upriver evidence tools for one bounded run.
 * Requires SPONSOR_RADAR_AGENTIC_LIVE_SMOKE=true plus both provider
 * interlocks; never part of verify or CI.
 */
const enabled = process.env.SPONSOR_RADAR_AGENTIC_LIVE_SMOKE === "true";

if (
  enabled &&
  (!process.env.UPRIVER_API_KEY?.trim() ||
    !process.env.OPENAI_API_KEY?.trim())
) {
  try {
    loadEnvFile(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

const channel = process.env.SPONSOR_RADAR_AGENTIC_SMOKE_CHANNEL ?? "@Dave2D";

describe("manually approved agentic live smoke", () => {
  it.runIf(enabled)(
    "completes one autonomous live run within the per-run credit ceiling",
    async () => {
      const upriverKey = process.env.UPRIVER_API_KEY?.trim() ?? "";
      const openAiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
      if (!upriverKey || !openAiKey) {
        throw new Error(
          "UPRIVER_API_KEY and OPENAI_API_KEY are required for the agentic live smoke"
        );
      }
      if (process.env.UPRIVER_LIVE_WORKFLOW !== "true") {
        throw new Error(
          "The agentic live smoke requires UPRIVER_LIVE_WORKFLOW=true"
        );
      }
      if (process.env.SPONSOR_RADAR_LIVE_LLM !== "true") {
        throw new Error(
          "The agentic live smoke requires SPONSOR_RADAR_LIVE_LLM=true"
        );
      }

      const audit = new AuditRecorder({
        phase: "workflow_live",
        mode: "live",
        sink: (event) => {
          process.stdout.write(
            `${JSON.stringify({ type: "agentic_live_smoke_audit", event })}\n`
          );
        }
      });
      const gateway = new LiveUpriverGateway(
        process.cwd(),
        new UpriverHttpClient({
          apiKey: upriverKey,
          maxRetries: 0,
          attemptTimeoutMs: 10_000,
          observer: (event) => audit.recordHttpLifecycle(event)
        }),
        { maximumCredits: MAXIMUM_RUN_CREDITS }
      );
      const planner = new OpenAiResponsesAgentLlm({
        apiKey: openAiKey,
        model: process.env.SPONSOR_RADAR_OPENAI_MODEL
      });

      const { report, events } = await runAgenticReport(
        { channel },
        gateway,
        planner,
        { audit }
      );

      expect(report.schemaVersion).toBe(1);
      expect(report.phase).toBe("workflow_live");
      expect(report.methodology.qualificationPolicy).toBe(
        "same_brand_reactivation"
      );
      expect(report.audit.resultBasedCreditEstimate).toBeLessThanOrEqual(
        MAXIMUM_RUN_CREDITS
      );
      for (const lead of report.leads) {
        expect(lead.domain.length).toBeGreaterThan(0);
        expect(lead.targetEvidence.contentUrl.length).toBeGreaterThan(0);
        expect(lead.peerEvidence.contentUrl.length).toBeGreaterThan(0);
      }
      expect(
        events.filter((event) => event.eventType === "llm.completed").length
      ).toBeGreaterThan(0);

      process.stdout.write(
        `${JSON.stringify({
          type: "agentic_live_smoke_summary",
          channel,
          leads: report.leads.map((lead) => `${lead.domain}|${lead.peer}`),
          credits: report.audit.resultBasedCreditEstimate,
          llmCalls: report.audit.llmCalls,
          toolCalls: report.audit.toolCalls,
          coverage: report.coverage.map((notice) => notice.code)
        })}\n`
      );
    },
    300_000
  );
});

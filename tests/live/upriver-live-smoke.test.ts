import { describe, expect, it } from "vitest";
import { loadEnvFile } from "node:process";
import { AuditRecorder } from "@/src/observability/audit";
import {
  CreatorBatchResponseWireSchema,
  SponsorsPageWireSchema
} from "@/src/radar/adapters/upriver/contracts";
import { UpriverHttpClient } from "@/src/radar/adapters/upriver/http-client";
import { normalizeCreatorBatch } from "@/src/radar/adapters/upriver/normalize";
import { CreditBudget } from "@/src/radar/domain/credits";
import { selectRequestedYouTubeChannel } from "@/src/radar/domain/youtube";

const enabled = process.env.UPRIVER_LIVE_SMOKE === "true";

if (enabled && !process.env.UPRIVER_API_KEY?.trim()) {
  try {
    loadEnvFile(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

const apiKey = process.env.UPRIVER_API_KEY?.trim() ?? "";

describe("manually approved six-credit Upriver smoke", () => {
  it.runIf(enabled)(
    "validates the creator and sponsor contracts within six credits",
    async () => {
      if (!apiKey) {
        throw new Error("UPRIVER_API_KEY is required for the live smoke");
      }

      const audit = new AuditRecorder({
        phase: "phase_2_live",
        mode: "live",
        sink: (event) => {
          process.stdout.write(
            `${JSON.stringify({
              type: "upriver_live_smoke_audit",
              event
            })}\n`
          );
        }
      });
      audit.startRun({ smoke: "six-credit-contract" });
      audit.recordPolicy({
        decision: "allow",
        reason: "Manually enabled six-credit Upriver contract smoke",
        estimatedCredits: 6,
        resultBasedCredits: 0,
        maximumCredits: 6,
        remainingCredits: 0
      });
      const client = new UpriverHttpClient({
        apiKey,
        maxRetries: 0,
        attemptTimeoutMs: 10_000,
        observer: (event) => audit.recordHttpLifecycle(event)
      });
      const budget = new CreditBudget(6);
      const allocation = budget.preflight({
        estimatedCredits: 1,
        reason: "Resolve one known creator in the manual live smoke"
      });
      if (allocation.decision !== "allow") {
        throw new Error(allocation.reason);
      }

      const response = await audit.tool(
        {
          name: "live_smoke.resolve_target",
          reason: "Resolve one known creator in the manual live smoke",
          mode: "live",
          input: { channel: "@UrAvgConsumer" },
          cacheStatus: "not_applicable",
          estimatedCredits: 1
        },
        async () => {
          const result = await client.request({
            method: "POST",
            path: "/v1/creators/batch",
            body: { urls: ["https://www.youtube.com/@UrAvgConsumer"] },
            audit: {
              operation: "live_smoke.resolve_target",
              reason: "Resolve one known creator in the manual live smoke",
              estimatedCredits: 1,
              creditsPerResult: 1,
              resultRows: (data) => data.results.length
            },
            validate: CreatorBatchResponseWireSchema.parse
          });
          budget.reconcile(
            allocation.allocationId,
            result.data.results.length
          );
          if (
            result.data.successful_count !== 1 ||
            result.data.failed_count !== 0
          ) {
            throw new Error("The live smoke did not resolve one creator");
          }
          const [creator] = normalizeCreatorBatch(result.data);
          selectRequestedYouTubeChannel(
            creator.channels,
            "@UrAvgConsumer"
          );
          return result;
        },
        (result) => ({
          rows: result.data.results.length,
          resultBasedCredits: result.data.results.length,
          requestId: result.meta.requestId,
          providerRequestId: result.meta.providerRequestId,
          retryCount: result.meta.attempts.length - 1,
          durationMs: result.meta.latencyMs
        })
      );

      const sponsorAllocation = budget.preflight({
        estimatedCredits: 5,
        reason:
          "Validate one result and the documented singular sponsor_type parameter"
      });
      if (sponsorAllocation.decision !== "allow") {
        throw new Error(sponsorAllocation.reason);
      }
      const sponsors = await audit.tool(
        {
          name: "live_smoke.list_peer_sponsors",
          reason:
            "Validate one result and the documented singular sponsor_type parameter",
          mode: "live",
          input: {
            publicationUrl: "https://www.youtube.com/@Dave2D",
            limit: 1
          },
          cacheStatus: "not_applicable",
          estimatedCredits: 5
        },
        async () => {
          const result = await client.request({
            method: "GET",
            path: "/v1/sponsors",
            query: {
              publication_url: "https://www.youtube.com/@Dave2D",
              platforms: "youtube",
              sponsor_type: "explicit_ad",
              include_evidence: true,
              since: "2026-04-20",
              until: "2026-07-19",
              limit: 1
            },
            audit: {
              operation: "live_smoke.list_peer_sponsors",
              reason:
                "Validate one result and the documented singular sponsor_type parameter",
              estimatedCredits: 5,
              creditsPerResult: 5,
              resultRows: (data) => data.results.length
            },
            validate: SponsorsPageWireSchema.parse
          });
          budget.reconcile(
            sponsorAllocation.allocationId,
            result.data.results.length * 5
          );
          if (
            result.data.results.length !== 1 ||
            result.data.results.some(
              (row) => row.most_recent_ad.sponsor_type !== "explicit_ad"
            )
          ) {
            throw new Error(
              "The live smoke did not return one explicit sponsorship"
            );
          }
          return result;
        },
        (result) => ({
          rows: result.data.results.length,
          resultBasedCredits: result.data.results.length * 5,
          requestId: result.meta.requestId,
          providerRequestId: result.meta.providerRequestId,
          retryCount: result.meta.attempts.length - 1,
          durationMs: result.meta.latencyMs
        })
      );

      expect(budget.snapshot()).toMatchObject({
        maximumCredits: 6,
        resultBasedCredits: 6,
        exceededCredits: 0
      });
      expect(response.meta.latencyMs).toBeGreaterThanOrEqual(0);
      expect(sponsors.meta.latencyMs).toBeGreaterThanOrEqual(0);
      expect(audit.summarize(6)).toMatchObject({
        toolCalls: 2,
        resultBasedCreditEstimate: 6,
        projectedLiveCredits: 6
      });
      expect(
        audit
          .getEvents()
          .filter((event) => event.eventType === "http.completed")
      ).toHaveLength(2);
    }
  );

  it.runIf(!enabled)(
    "stays disabled unless UPRIVER_LIVE_SMOKE=true is supplied manually",
    () => {
      expect(enabled).toBe(false);
    }
  );
});

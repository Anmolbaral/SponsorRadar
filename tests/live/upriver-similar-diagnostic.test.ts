import { loadEnvFile } from "node:process";
import { describe, expect, it } from "vitest";
import { CreatorBatchResponseWireSchema } from "@/src/radar/adapters/upriver/contracts";
import { normalizeCreatorBatch } from "@/src/radar/adapters/upriver/normalize";
import { selectRequestedYouTubeChannel } from "@/src/radar/domain/youtube";

const enabled =
  process.env.UPRIVER_LIVE_SIMILAR_DIAGNOSTIC === "true";

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
const diagnosticCase =
  process.env.UPRIVER_SIMILAR_DIAGNOSTIC_CASE ?? "minimal";

describe("manually approved Upriver Similar conflict diagnostic", () => {
  it.runIf(enabled)(
    "makes a bounded no-retry request and records the safe provider detail",
    async () => {
      if (!apiKey) {
        throw new Error(
          "UPRIVER_API_KEY is required for the Similar diagnostic"
        );
      }

      const channelUrl =
        "https://www.youtube.com/@dwarkeshPatel";
      let requestBody: Record<string, unknown> = {
        channel_url: channelUrl,
        limit: 1
      };
      if (diagnosticCase === "filtered") {
        const targetResponse = await fetch(
          "https://api.upriver.ai/v1/creators/batch",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey
            },
            body: JSON.stringify({ urls: [channelUrl] }),
            signal: AbortSignal.timeout(15_000)
          }
        );
        const targetPayload = CreatorBatchResponseWireSchema.parse(
          await targetResponse.json()
        );
        const [target] = normalizeCreatorBatch(targetPayload);
        const targetChannel = selectRequestedYouTubeChannel(
          target.channels,
          channelUrl
        );
        if (
          !targetResponse.ok ||
          targetChannel.subscriberCount === null ||
          targetChannel.subscriberCount <= 0
        ) {
          throw new Error(
            "The filtered diagnostic could not resolve target reach"
          );
        }
        process.stdout.write(
          `${JSON.stringify({
            type: "upriver_similar_diagnostic_target",
            status: targetResponse.status,
            providerRequestId:
              targetResponse.headers.get("x-request-id") ??
              targetResponse.headers.get("x-correlation-id") ??
              targetResponse.headers.get("request-id"),
            subscriberCount: targetChannel.subscriberCount,
            automaticRetries: 0
          })}\n`
        );
        requestBody = {
          channel_url: channelUrl,
          limit: 10,
          platforms: ["youtube"],
          min_followers: Math.ceil(
            targetChannel.subscriberCount * 0.75
          ),
          max_followers: Math.floor(
            targetChannel.subscriberCount * 1.25
          ),
          match_content_language: true
        };
      } else if (diagnosticCase !== "minimal") {
        throw new Error(
          "UPRIVER_SIMILAR_DIAGNOSTIC_CASE must be minimal or filtered"
        );
      }

      const response = await fetch(
        "https://api.upriver.ai/v1/creators/similar",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(15_000)
        }
      );
      const providerRequestId =
        response.headers.get("x-request-id") ??
        response.headers.get("x-correlation-id") ??
        response.headers.get("request-id");
      const contentType = response.headers.get("content-type") ?? "";
      const payload = contentType.includes("application/json")
        ? ((await response.json()) as unknown)
        : { detail: (await response.text()).slice(0, 500) };

      process.stdout.write(
        `${JSON.stringify({
          type: "upriver_similar_diagnostic",
          testCase: diagnosticCase,
          status: response.status,
          providerRequestId,
          payload,
          automaticRetries: 0
        })}\n`
      );

      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(500);
    }
  );

  it.runIf(!enabled)(
    "stays disabled unless UPRIVER_LIVE_SIMILAR_DIAGNOSTIC=true is supplied manually",
    () => {
      expect(enabled).toBe(false);
    }
  );
});

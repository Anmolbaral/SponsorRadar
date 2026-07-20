import { loadEnvFile } from "node:process";
import { describe, expect, it } from "vitest";
import {
  UpriverHttpClient,
  type UpriverLifecycleEvent
} from "@/src/radar/adapters/upriver/http-client";
import { LiveUpriverGateway } from "@/src/radar/adapters/upriver/live-evidence-gateway";
import { isReachComparable } from "@/src/radar/domain/reach";

const enabled = process.env.UPRIVER_LIVE_DYNAMIC_SMOKE === "true";

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

describe("manually approved dynamic Upriver discovery smoke", () => {
  it.runIf(enabled)(
    "resolves an arbitrary target and validates one bounded Similar response",
    async () => {
      if (!apiKey) {
        throw new Error(
          "UPRIVER_API_KEY is required for the dynamic discovery smoke"
        );
      }

      const lifecycle: UpriverLifecycleEvent[] = [];
      const gateway = new LiveUpriverGateway(
        process.cwd(),
        new UpriverHttpClient({
          apiKey,
          maxRetries: 0,
          attemptTimeoutMs: 15_000,
          observer: (event) => {
            lifecycle.push(event);
            process.stdout.write(
              `${JSON.stringify({
                type: "upriver_dynamic_discovery",
                phase: event.phase,
                operation: event.audit?.operation ?? null,
                requestId: event.requestId,
                providerRequestId:
                  event.phase === "completed" ||
                  event.phase === "failed"
                    ? event.meta.providerRequestId
                    : null,
                status:
                  event.phase === "failed" ? event.status : null,
                attempts:
                  event.phase === "completed" ||
                  event.phase === "failed"
                    ? event.meta.attempts.length
                    : null,
                usage:
                  event.phase === "completed"
                    ? (event.usage ?? null)
                    : null
              })}\n`
            );
          }
        }),
        {
          maximumCredits: 11
        }
      );

      const resolved = await gateway.resolveTarget("@dwarkeshPatel");
      const peers = await gateway.listLockedPeers(
        resolved.target.url,
        resolved.target.subscriberCount
      );

      expect(resolved.target.url).toMatch(
        /^https:\/\/www\.youtube\.com\/@/i
      );
      expect(resolved.target.subscriberCount).toBeGreaterThan(0);
      expect(peers.length).toBeLessThanOrEqual(3);
      expect(new Set(peers.map((peer) => peer.url)).size).toBe(peers.length);
      for (const peer of peers) {
        expect(
          isReachComparable(
            resolved.target.subscriberCount,
            peer.subscriberCount
          )
        ).toBe(true);
      }
      expect(
        lifecycle.filter((event) => event.phase === "started")
      ).toHaveLength(2);
      expect(
        lifecycle.filter((event) => event.phase === "failed")
      ).toHaveLength(0);
      expect(
        lifecycle
          .filter((event) => event.phase === "completed")
          .every((event) => event.meta.attempts.length === 1)
      ).toBe(true);
      expect(gateway.creditSnapshot()).toMatchObject({
        maximumCredits: 11,
        reservedCredits: 0,
        exceededCredits: 0
      });

      process.stdout.write(
        `${JSON.stringify({
          type: "upriver_dynamic_discovery_result",
          target: {
            name: resolved.target.name,
            url: resolved.target.url,
            subscriberCount: resolved.target.subscriberCount
          },
          peers,
          provisionalResultBasedCredits:
            gateway.creditSnapshot().resultBasedCredits,
          automaticRetries: 0
        })}\n`
      );
    }
  );

  it.runIf(!enabled)(
    "stays disabled unless UPRIVER_LIVE_DYNAMIC_SMOKE=true is supplied manually",
    () => {
      expect(enabled).toBe(false);
    }
  );
});

import { loadEnvFile } from "node:process";
import { describe, expect, it } from "vitest";
import {
  UpriverHttpClient,
  type UpriverLifecycleEvent
} from "@/src/radar/adapters/upriver/http-client";
import { LiveUpriverGateway } from "@/src/radar/adapters/upriver/live-evidence-gateway";
import { parseYouTubeChannelReference } from "@/src/radar/domain/youtube";

const enabled =
  process.env.UPRIVER_LIVE_LEGACY_MATRIX === "true";

if (enabled && !process.env.UPRIVER_API_KEY?.trim()) {
  try {
    loadEnvFile(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

const LEGACY_MATRIX_CREDIT_LIMIT = 2;

interface LegacyMatrixCase {
  name: "legacy_user" | "legacy_custom";
  input: string;
  expectedChannelId: string;
}

describe("manually approved Upriver legacy YouTube locator compatibility matrix", () => {
  it.runIf(enabled)(
    "resolves one /user and one /c URL to preverified channel IDs with two no-retry calls",
    async () => {
      const apiKey = process.env.UPRIVER_API_KEY?.trim() ?? "";
      if (!apiKey) {
        throw new Error(
          "The legacy compatibility matrix requires UPRIVER_API_KEY"
        );
      }

      const cases = legacyMatrixCases();
      const lifecycle: UpriverLifecycleEvent[] = [];
      const gateway = new LiveUpriverGateway(
        process.cwd(),
        new UpriverHttpClient({
          apiKey,
          maxRetries: 0,
          attemptTimeoutMs: 20_000,
          observer: (event) => {
            lifecycle.push(event);
            if (
              event.phase === "completed" ||
              event.phase === "failed"
            ) {
              process.stdout.write(
                `${JSON.stringify({
                  type: "upriver_legacy_compatibility_http",
                  locatorKind:
                    cases[
                      lifecycle.filter(
                        (candidate) => candidate.phase === "started"
                      ).length - 1
                    ]?.name ?? null,
                  operation: event.audit?.operation ?? null,
                  requestId: event.requestId,
                  providerRequestId: event.meta.providerRequestId,
                  status:
                    event.meta.attempts.at(-1)?.status ?? null,
                  latencyMs: event.meta.latencyMs,
                  attempts: event.meta.attempts.length,
                  retryCount: Math.max(
                    0,
                    event.meta.attempts.length - 1
                  ),
                  rows:
                    event.phase === "completed"
                      ? (event.usage?.rows ?? null)
                      : null,
                  provisionalCredits:
                    event.phase === "completed"
                      ? (event.usage?.resultBasedCredits ?? null)
                      : null,
                  outcome:
                    event.phase === "completed" ? "success" : "failure",
                  providerIssue:
                    event.phase === "failed"
                      ? { code: event.code, status: event.status }
                      : null
                })}\n`
              );
            }
          }
        }),
        { maximumCredits: LEGACY_MATRIX_CREDIT_LIMIT }
      );

      const results = [];
      for (const testCase of cases) {
        const resolved = await gateway.resolveTarget(testCase.input);
        results.push({
          locatorKind: testCase.name,
          expectedChannelId: testCase.expectedChannelId,
          resolvedChannelId: resolved.identity.channelId,
          canonicalUrl: resolved.identity.canonicalUrl,
          verificationBasis: resolved.identity.verificationBasis
        });
        expect(resolved.identity.channelId).toBe(
          testCase.expectedChannelId
        );
        expect(resolved.target.url).toBe(
          resolved.identity.canonicalUrl
        );
      }

      const terminalEvents = lifecycle.filter(
        (event) =>
          event.phase === "completed" || event.phase === "failed"
      );
      const completedEvents = terminalEvents.filter(
        (event) => event.phase === "completed"
      );
      const automaticRetries = terminalEvents.reduce(
        (total, event) =>
          total + Math.max(0, event.meta.attempts.length - 1),
        0
      );

      process.stdout.write(
        `${JSON.stringify({
          type: "upriver_legacy_compatibility_result",
          results,
          requestCount: terminalEvents.length,
          provisionalCredits:
            gateway.creditSnapshot().resultBasedCredits,
          automaticRetries
        })}\n`
      );

      expect(
        lifecycle.filter((event) => event.phase === "started")
      ).toHaveLength(2);
      expect(
        lifecycle.filter((event) => event.phase === "failed")
      ).toHaveLength(0);
      expect(completedEvents).toHaveLength(2);
      expect(
        new Set(terminalEvents.map((event) => event.requestId)).size
      ).toBe(2);
      expect(
        terminalEvents.every(
          (event) => event.requestId.trim().length > 0
        )
      ).toBe(true);
      expect(
        completedEvents.every(
          (event) =>
            event.audit?.operation === "live.resolve_target" &&
            event.meta.attempts.length === 1 &&
            event.usage?.rows === 1 &&
            event.usage.resultBasedCredits === 1
        )
      ).toBe(true);
      expect(automaticRetries).toBe(0);
      expect(gateway.creditSnapshot()).toMatchObject({
        maximumCredits: LEGACY_MATRIX_CREDIT_LIMIT,
        resultBasedCredits: LEGACY_MATRIX_CREDIT_LIMIT,
        reservedCredits: 0,
        exceededCredits: 0
      });
    },
    60_000
  );

  it.runIf(!enabled)(
    "stays disabled unless UPRIVER_LIVE_LEGACY_MATRIX=true is supplied manually",
    () => {
      expect(enabled).toBe(false);
    }
  );
});

function legacyMatrixCases(): [LegacyMatrixCase, LegacyMatrixCase] {
  return [
    legacyMatrixCase(
      "legacy_user",
      "UPRIVER_LIVE_LEGACY_USER_URL",
      "UPRIVER_LIVE_LEGACY_USER_CHANNEL_ID"
    ),
    legacyMatrixCase(
      "legacy_custom",
      "UPRIVER_LIVE_LEGACY_CUSTOM_URL",
      "UPRIVER_LIVE_LEGACY_CUSTOM_CHANNEL_ID"
    )
  ];
}

function legacyMatrixCase(
  name: LegacyMatrixCase["name"],
  inputVariable: string,
  channelIdVariable: string
): LegacyMatrixCase {
  const input = requiredEnvironmentValue(inputVariable);
  const expectedChannelId = requiredEnvironmentValue(
    channelIdVariable
  );
  const reference = parseYouTubeChannelReference(input);
  if (reference.kind !== name) {
    throw new Error(
      `${inputVariable} must contain an exact YouTube ${
        name === "legacy_user" ? "/user/name" : "/c/name"
      } reference`
    );
  }
  const expectedIdentity = parseYouTubeChannelReference(
    `/channel/${expectedChannelId}`
  );
  if (expectedIdentity.kind !== "channel_id") {
    throw new Error(
      `${channelIdVariable} must contain a YouTube channel ID`
    );
  }
  return {
    name,
    input: reference.lookupUrl,
    expectedChannelId: expectedIdentity.channelId
  };
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the legacy live matrix`);
  }
  return value;
}

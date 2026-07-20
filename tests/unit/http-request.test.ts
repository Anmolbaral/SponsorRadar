import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertExactYouTubeChannel,
  enforceMutationRateLimit,
  readBoundedJson,
  RequestGuardError,
  resetRequestRateLimitsForTesting
} from "@/src/security/http-request";

afterEach(() => {
  resetRequestRateLimitsForTesting();
  vi.restoreAllMocks();
});

describe("HTTP mutation safeguards", () => {
  it("accepts bounded same-origin JSON", async () => {
    const request = jsonRequest(
      { channel: "@UrAvgConsumer" },
      {
        origin: "https://radar.example",
        "sec-fetch-site": "same-origin"
      }
    );

    await expect(readBoundedJson(request)).resolves.toEqual({
      channel: "@UrAvgConsumer"
    });
  });

  it("rejects cross-origin mutations before reading the body", async () => {
    const request = jsonRequest(
      { channel: "@UrAvgConsumer" },
      { origin: "https://attacker.example" }
    );

    await expect(readBoundedJson(request)).rejects.toMatchObject({
      status: 403
    });
  });

  it("rejects non-JSON and oversized bodies", async () => {
    await expect(
      readBoundedJson(
        new Request("https://radar.example/api/runs", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}"
        })
      )
    ).rejects.toMatchObject({ status: 415 });

    await expect(
      readBoundedJson(
        jsonRequest({
          channel: "x".repeat(4_100)
        })
      )
    ).rejects.toMatchObject({ status: 413 });
  });

  it("accepts supported exact YouTube channel references", () => {
    expect(() => assertExactYouTubeChannel("@UrAvgConsumer")).not.toThrow();
    expect(() => assertExactYouTubeChannel("UrAvgConsumer")).not.toThrow();
    expect(() => assertExactYouTubeChannel("/@UrAvgConsumer")).not.toThrow();
    expect(() =>
      assertExactYouTubeChannel("https://youtube.com/@UrAvgConsumer")
    ).not.toThrow();
    expect(() =>
      assertExactYouTubeChannel("youtube.com/@UrAvgConsumer")
    ).not.toThrow();
    expect(() => assertExactYouTubeChannel("@MKBHD")).not.toThrow();
    expect(() => assertExactYouTubeChannel("@तकनीक")).not.toThrow();
    expect(() =>
      assertExactYouTubeChannel(
        "https://youtube.com/channel/UCExact123"
      )
    ).not.toThrow();
    expect(() =>
      assertExactYouTubeChannel("/user/LegacyUser")
    ).not.toThrow();
    expect(() =>
      assertExactYouTubeChannel("youtube.com/c/LegacyAlias")
    ).not.toThrow();
  });

  it("rejects non-channel, ambiguous, and fake YouTube references", () => {
    expect(() =>
      assertExactYouTubeChannel("https://example.com/@MKBHD")
    ).toThrowError(RequestGuardError);
    expect(() =>
      assertExactYouTubeChannel("https://youtube.com.evil.test/@MKBHD")
    ).toThrowError(RequestGuardError);
    expect(() =>
      assertExactYouTubeChannel("https://youtube.com/watch?v=abc")
    ).toThrowError(RequestGuardError);
    expect(() =>
      assertExactYouTubeChannel("https://youtube.com/@MKBHD/videos")
    ).toThrowError(RequestGuardError);
    expect(() =>
      assertExactYouTubeChannel("ftp://youtube.com/@MKBHD")
    ).toThrowError(RequestGuardError);
  });

  it("rate-limits repeated create attempts per forwarded client", () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-07-20T12:00:00.000Z")
    );
    const request = jsonRequest(
      { channel: "@UrAvgConsumer" },
      { "x-forwarded-for": "203.0.113.8" }
    );

    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect(() =>
        enforceMutationRateLimit(request, "create_run")
      ).not.toThrow();
    }
    expect(() =>
      enforceMutationRateLimit(request, "create_run")
    ).toThrowError(
      expect.objectContaining({
        status: 429,
        retryAfterSeconds: 300
      })
    );
  });
});

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {}
): Request {
  return new Request("https://radar.example/api/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

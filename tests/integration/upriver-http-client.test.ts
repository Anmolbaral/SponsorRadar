import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  UPRIVER_BASE_URL,
  UpriverHttpClient,
  UpriverHttpError,
  type UpriverFetch,
  type UpriverLifecycleEvent,
  type UpriverTimer
} from "@/src/radar/adapters/upriver/http-client";

describe("UpriverHttpClient", () => {
  it("uses the Upriver origin, authenticates server-side, validates JSON, and returns audit metadata", async () => {
    const time = controlledTime(1_000);
    const fetch = queuedFetch([
      () => {
        time.advance(37);
        return jsonResponse(
          { value: "validated" },
          200,
          { "x-request-id": "provider-123" }
        );
      }
    ]);
    const client = new UpriverHttpClient({
      apiKey: "server-secret",
      fetch: fetch.run,
      clock: time.clock,
      sleep: time.sleep,
      requestId: () => "local-123"
    });

    const response = await client.request({
      method: "GET",
      path: "/v1/sponsors",
      query: {
        publication_url: "https://youtube.com/@creator",
        platforms: ["youtube"],
        include_evidence: true,
        omitted: undefined
      },
      validate: z.object({ value: z.literal("validated") }).parse
    });

    expect(response.data).toEqual({ value: "validated" });
    expect(response.meta).toMatchObject({
      requestId: "local-123",
      providerRequestId: "provider-123",
      latencyMs: 37,
      attempts: [
        {
          attempt: 1,
          status: 200,
          outcome: "success",
          latencyMs: 37,
          retryDelayMs: null,
          providerRequestId: "provider-123"
        }
      ]
    });

    const call = fetch.calls[0];
    const url = new URL(String(call.input));
    const headers = new Headers(call.init?.headers);
    expect(url.origin).toBe(UPRIVER_BASE_URL);
    expect(url.pathname).toBe("/v1/sponsors");
    expect(url.searchParams.get("publication_url")).toBe(
      "https://youtube.com/@creator"
    );
    expect(url.searchParams.get("platforms")).toBe("youtube");
    expect(url.searchParams.get("include_evidence")).toBe("true");
    expect(url.searchParams.has("omitted")).toBe(false);
    expect(headers.get("X-API-Key")).toBe("server-secret");
    expect(headers.get("X-Request-ID")).toBe("local-123");
  });

  it.each([
    [400, "bad_request"],
    [401, "authentication_failed"],
    [403, "permission_denied"]
  ] as const)(
    "treats HTTP %i as terminal and redacts the provider body",
    async (status, code) => {
      const fetch = queuedFetch([
        jsonResponse(
          { detail: "raw-provider-detail server-secret" },
          status,
          { "x-request-id": `provider-${status}` }
        )
      ]);
      const sleeps: number[] = [];
      const client = new UpriverHttpClient({
        apiKey: "server-secret",
        fetch: fetch.run,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        requestId: () => `local-${status}`
      });

      const error = await captureError(() =>
        client.request({
          method: "GET",
          path: "/v1/sponsors",
          validate: (input) => input
        })
      );

      expect(error).toBeInstanceOf(UpriverHttpError);
      expect(error).toMatchObject({
        code,
        status,
        meta: {
          requestId: `local-${status}`,
          providerRequestId: `provider-${status}`,
          attempts: [{ attempt: 1, status }]
        }
      });
      expect(fetch.calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expect(JSON.stringify(error)).not.toContain("server-secret");
      expect(JSON.stringify(error)).not.toContain("raw-provider-detail");
    }
  );

  it("treats HTTP 404 as terminal not_found and keeps the structured provider detail", async () => {
    const fetch = queuedFetch([
      jsonResponse(
        {
          detail: {
            code: "channel_not_found",
            message: "The requested channel was not found."
          }
        },
        404,
        { "x-request-id": "provider-404" }
      )
    ]);
    const client = new UpriverHttpClient({
      apiKey: "server-secret",
      fetch: fetch.run,
      requestId: () => "local-404"
    });

    const error = await captureError(() =>
      client.request({
        method: "GET",
        path: "/v1/creators/resolve",
        validate: (input) => input
      })
    );

    expect(error).toBeInstanceOf(UpriverHttpError);
    expect(error).toMatchObject({
      code: "not_found",
      status: 404,
      providerCode: "channel_not_found",
      providerMessage: "The requested channel was not found."
    });
    expect(fetch.calls).toHaveLength(1);
    expect(JSON.stringify(error)).not.toContain("server-secret");
  });

  it("abandons oversized error bodies instead of buffering them", async () => {
    const hugeMessage = "x".repeat(64_000);
    const fetch = queuedFetch([
      jsonResponse(
        { detail: { code: "channel_not_found", message: hugeMessage } },
        404
      )
    ]);
    const client = new UpriverHttpClient({
      apiKey: "server-secret",
      fetch: fetch.run
    });
    const error = await captureError(() =>
      client.request({
        method: "GET",
        path: "/v1/creators/resolve",
        validate: (input) => input
      })
    );
    expect(error).toMatchObject({
      code: "not_found",
      providerCode: null,
      providerMessage: null
    });
  });

  it("redacts unstructured 404 details and non-slug provider codes", async () => {
    for (const detail of [
      "free text server-secret",
      [{ msg: "loc-style server-secret" }],
      { code: "spaced out code", message: "server-secret echoed" }
    ]) {
      const fetch = queuedFetch([jsonResponse({ detail }, 404)]);
      const client = new UpriverHttpClient({
        apiKey: "server-secret",
        fetch: fetch.run
      });
      const error = await captureError(() =>
        client.request({
          method: "GET",
          path: "/v1/creators/resolve",
          validate: (input) => input
        })
      );
      expect(error).toBeInstanceOf(UpriverHttpError);
      expect(error).toMatchObject({
        code: "not_found",
        providerCode: null,
        providerMessage: null
      });
      expect(JSON.stringify(error)).not.toContain("server-secret");
    }
  });

  it("retries a network failure and 5xx at most twice with bounded exponential backoff", async () => {
    const time = controlledTime(0);
    const fetch = queuedFetch([
      () => {
        time.advance(5);
        throw new Error("socket failed with server-secret");
      },
      () => {
        time.advance(7);
        return jsonResponse({ detail: "temporary server-secret" }, 503);
      },
      () => {
        time.advance(11);
        return jsonResponse({ ok: true }, 200);
      }
    ]);
    const client = new UpriverHttpClient({
      apiKey: "server-secret",
      fetch: fetch.run,
      sleep: time.sleep,
      clock: time.clock,
      requestId: () => "retry-request",
      baseBackoffMs: 100,
      maxRetryDelayMs: 150
    });

    const response = await client.request({
      method: "GET",
      path: "/v1/sponsors",
      validate: z.object({ ok: z.literal(true) }).parse
    });

    expect(fetch.calls).toHaveLength(3);
    expect(time.sleeps).toEqual([100, 150]);
    expect(response.meta.latencyMs).toBe(273);
    expect(response.meta.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: null,
        outcome: "network_error",
        latencyMs: 5,
        retryDelayMs: 100
      }),
      expect.objectContaining({
        attempt: 2,
        status: 503,
        outcome: "http_error",
        latencyMs: 7,
        retryDelayMs: 150
      }),
      expect.objectContaining({
        attempt: 3,
        status: 200,
        outcome: "success",
        latencyMs: 11,
        retryDelayMs: null
      })
    ]);
  });

  it("fails safely after exactly two network retries", async () => {
    const fetch = queuedFetch([
      new Error("first server-secret"),
      new Error("second server-secret"),
      new Error("third server-secret")
    ]);
    const client = new UpriverHttpClient({
      apiKey: "server-secret",
      fetch: fetch.run,
      sleep: async () => undefined,
      requestId: () => "network-request"
    });

    const error = await captureError(() =>
      client.request({
        method: "GET",
        path: "/v1/sponsors",
        validate: (input) => input
      })
    );

    expect(fetch.calls).toHaveLength(3);
    expect(error).toMatchObject({
      code: "network_failure",
      status: null,
      meta: { requestId: "network-request" }
    });
    expect(error.meta.attempts).toHaveLength(3);
    expect(JSON.stringify(error)).not.toContain("server-secret");
  });

  it("aborts each timed-out attempt at 10 seconds and stops after two retries", async () => {
    const timer = firingTimer();
    let fetchCalls = 0;
    const fetch: UpriverFetch = async (_input, init) => {
      fetchCalls += 1;
      expect(init?.signal?.aborted).toBe(true);
      throw new Error("abort exposed server-secret");
    };
    const client = new UpriverHttpClient({
      apiKey: "server-secret",
      fetch,
      sleep: async () => undefined,
      timer: timer.adapter,
      requestId: () => "timeout-request"
    });

    const error = await captureError(() =>
      client.request({
        method: "GET",
        path: "/v1/sponsors",
        validate: (input) => input
      })
    );

    expect(fetchCalls).toBe(3);
    expect(timer.delays).toEqual([10_000, 10_000, 10_000]);
    expect(timer.cleared).toEqual([1, 2, 3]);
    expect(error).toMatchObject({
      code: "timeout",
      status: null,
      meta: { requestId: "timeout-request" }
    });
    expect(error.meta.attempts).toHaveLength(3);
    expect(
      error.meta.attempts.every((attempt) => attempt.outcome === "timeout")
    ).toBe(true);
    expect(JSON.stringify(error)).not.toContain("server-secret");

    const configuredTimer = passiveTimer();
    const configuredClient = new UpriverHttpClient({
      apiKey: "secret",
      fetch: async () => jsonResponse({ ok: true }),
      timer: configuredTimer.adapter,
      attemptTimeoutMs: 17,
      requestId: () => "configured-timeout"
    });
    await configuredClient.request({
      method: "GET",
      path: "/v1/sponsors",
      validate: (input) => input
    });
    expect(configuredTimer.delays).toEqual([17]);
  });

  it("keeps the timeout active until the response body is read", async () => {
    let fireTimeout: (() => void) | null = null;
    const timer: UpriverTimer = {
      set(callback) {
        fireTimeout = callback;
        return 1;
      },
      clear() {
        return;
      }
    };
    const fetch: UpriverFetch = async (_input, init) =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("body aborted"));
            });
            fireTimeout?.();
          })
      }) as Response;
    const client = new UpriverHttpClient({
      apiKey: "server-secret",
      fetch,
      timer,
      maxRetries: 0,
      requestId: () => "body-timeout-request"
    });

    const error = await captureError(() =>
      client.request({
        method: "GET",
        path: "/v1/sponsors",
        validate: (input) => input
      })
    );

    expect(error).toMatchObject({
      code: "timeout",
      status: 200,
      meta: {
        requestId: "body-timeout-request",
        attempts: [{ outcome: "timeout", status: 200 }]
      }
    });
  });

  it("respects Retry-After for 429 responses", async () => {
    const time = controlledTime(Date.parse("2026-07-19T12:00:00Z"));
    const fetch = queuedFetch([
      jsonResponse(
        { detail: "slow down" },
        429,
        { "retry-after": "2" }
      ),
      jsonResponse({ ok: true })
    ]);
    const client = new UpriverHttpClient({
      apiKey: "secret",
      fetch: fetch.run,
      sleep: time.sleep,
      clock: time.clock,
      requestId: () => "rate-limit-request",
      maxRetryDelayMs: 5_000
    });

    const response = await client.request({
      method: "GET",
      path: "/v1/sponsors",
      validate: z.object({ ok: z.literal(true) }).parse
    });

    expect(time.sleeps).toEqual([2_000]);
    expect(response.meta.attempts[0]).toMatchObject({
      status: 429,
      retryDelayMs: 2_000
    });
  });

  it("emits safe lifecycle events for every page and includes failure metadata", async () => {
    const events: UpriverLifecycleEvent[] = [];
    let requestNumber = 0;
    const fetch = queuedFetch([
      jsonResponse({
        results: ["a"],
        has_more: true,
        next_cursor: "cursor-1"
      }),
      jsonResponse({
        results: ["b"],
        has_more: false,
        next_cursor: null
      }),
      jsonResponse({ detail: "private provider body" }, 401)
    ]);
    const client = new UpriverHttpClient({
      apiKey: "server-secret",
      fetch: fetch.run,
      sleep: async () => undefined,
      requestId: () => `request-${++requestNumber}`,
      observer: (event) => {
        events.push(event);
      }
    });

    await client.paginateCursor({
      path: "/v1/sponsors",
      query: { publication_url: "sensitive-channel-query" },
      validatePage: cursorPage,
      boundaries: {
        pageSize: 1,
        maxPages: 2,
        maxResults: 3,
        maxCredits: 10
      }
    });

    const failure = await captureError(() =>
      client.request({
        method: "POST",
        path: "/v1/creators/batch",
        body: { urls: ["sensitive-request-body"] },
        validate: (input) => input
      })
    );

    expect(failure.code).toBe("authentication_failed");
    expect(events.map((event) => event.phase)).toEqual([
      "started",
      "completed",
      "started",
      "completed",
      "started",
      "failed"
    ]);
    expect(events[0]).toEqual({
      phase: "started",
      method: "GET",
      path: "/v1/sponsors",
      requestId: "request-1"
    });
    expect(events[1]).toMatchObject({
      phase: "completed",
      method: "GET",
      path: "/v1/sponsors",
      requestId: "request-1",
      meta: { attempts: [{ status: 200 }] }
    });
    expect(events[5]).toMatchObject({
      phase: "failed",
      method: "POST",
      path: "/v1/creators/batch",
      requestId: "request-3",
      code: "authentication_failed",
      status: 401,
      meta: { attempts: [{ status: 401 }] }
    });

    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain("server-secret");
    expect(serializedEvents).not.toContain("sensitive-channel-query");
    expect(serializedEvents).not.toContain("sensitive-request-body");
    expect(serializedEvents).not.toContain("private provider body");
  });

  it("does not retry malformed or schema-invalid successful responses", async () => {
    const malformedFetch = queuedFetch([
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    ]);
    const malformedClient = new UpriverHttpClient({
      apiKey: "secret",
      fetch: malformedFetch.run,
      sleep: async () => undefined
    });

    const malformedError = await captureError(() =>
      malformedClient.request({
        method: "GET",
        path: "/v1/sponsors",
        validate: (input) => input
      })
    );

    expect(malformedError.code).toBe("invalid_response");
    expect(malformedFetch.calls).toHaveLength(1);

    const schemaFetch = queuedFetch([jsonResponse({ results: "wrong" })]);
    const schemaClient = new UpriverHttpClient({
      apiKey: "secret",
      fetch: schemaFetch.run,
      sleep: async () => undefined
    });
    const schemaError = await captureError(() =>
      schemaClient.request({
        method: "GET",
        path: "/v1/sponsors",
        validate: z.object({ results: z.array(z.string()) }).parse
      })
    );

    expect(schemaError.code).toBe("invalid_response");
    expect(schemaFetch.calls).toHaveLength(1);
  });

  it("owns cursor and limit while enforcing the result boundary", async () => {
    const fetch = queuedFetch([
      jsonResponse({
        results: ["a", "b"],
        has_more: true,
        next_cursor: "cursor-1"
      }),
      jsonResponse({
        results: ["c"],
        has_more: true,
        next_cursor: "cursor-2"
      })
    ]);
    const client = new UpriverHttpClient({
      apiKey: "secret",
      fetch: fetch.run,
      sleep: async () => undefined
    });

    const result = await client.paginateCursor({
      path: "/v1/sponsors",
      query: {
        platforms: "youtube",
        cursor: "caller-must-not-control-this",
        limit: 999
      },
      validatePage: cursorPage,
      boundaries: {
        pageSize: 2,
        maxPages: 5,
        maxResults: 3,
        maxCredits: 100
      }
    });

    expect(result).toMatchObject({
      results: ["a", "b", "c"],
      pages: 2,
      estimatedCredits: 0,
      stopReason: "max_results"
    });
    expect(new URL(String(fetch.calls[0].input)).searchParams.get("limit")).toBe(
      "2"
    );
    const secondUrl = new URL(String(fetch.calls[1].input));
    expect(secondUrl.searchParams.get("cursor")).toBe("cursor-1");
    expect(secondUrl.searchParams.get("limit")).toBe("1");
  });

  it("treats an exact-cap final page as complete", async () => {
    const fetch = queuedFetch([
      jsonResponse({
        results: ["a", "b"],
        has_more: false,
        next_cursor: null
      })
    ]);
    const client = new UpriverHttpClient({
      apiKey: "secret",
      fetch: fetch.run,
      sleep: async () => undefined
    });

    const result = await client.paginateCursor({
      path: "/v1/sponsors",
      validatePage: cursorPage,
      boundaries: {
        pageSize: 2,
        maxPages: 1,
        maxResults: 2,
        maxCredits: 10
      }
    });

    expect(result.stopReason).toBe("end");
    expect(result.results).toEqual(["a", "b"]);
  });

  it("stops before a page that could exceed the credit boundary", async () => {
    const fetch = queuedFetch([
      jsonResponse({
        results: ["a"],
        has_more: true,
        next_cursor: "cursor-1"
      })
    ]);
    const client = new UpriverHttpClient({
      apiKey: "secret",
      fetch: fetch.run,
      sleep: async () => undefined
    });

    const result = await client.paginateCursor({
      path: "/v1/sponsors",
      validatePage: cursorPage,
      boundaries: {
        pageSize: 2,
        maxPages: 5,
        maxResults: 10,
        maxCredits: 5,
        creditsPerRequest: 1,
        creditsPerResult: 2
      }
    });

    expect(result).toMatchObject({
      results: ["a"],
      pages: 1,
      estimatedCredits: 3,
      stopReason: "max_credits"
    });
    expect(fetch.calls).toHaveLength(1);
  });

  it("stops at the page boundary even when the provider has another cursor", async () => {
    const fetch = queuedFetch([
      jsonResponse({
        results: ["a"],
        has_more: true,
        next_cursor: "cursor-1"
      })
    ]);
    const client = new UpriverHttpClient({
      apiKey: "secret",
      fetch: fetch.run,
      sleep: async () => undefined
    });

    const result = await client.paginateCursor({
      path: "/v1/sponsors",
      validatePage: cursorPage,
      boundaries: {
        pageSize: 10,
        maxPages: 1,
        maxResults: 10,
        maxCredits: 10
      }
    });

    expect(result.stopReason).toBe("max_pages");
    expect(fetch.calls).toHaveLength(1);
  });
});

const CursorPageSchema = z.object({
  results: z.array(z.string()),
  next_cursor: z.string().nullable().optional(),
  has_more: z.boolean().optional()
});

function cursorPage(input: unknown) {
  return CursorPageSchema.parse(input);
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers).entries())
    }
  });
}

function queuedFetch(
  queue: readonly (
    | Response
    | Error
    | (() => Response | Promise<Response>)
  )[]
): {
  run: UpriverFetch;
  calls: Array<{ input: RequestInfo | URL; init?: RequestInit }>;
} {
  const remaining = [...queue];
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  return {
    calls,
    run: async (input, init) => {
      calls.push({ input, init });
      const next = remaining.shift();
      if (!next) {
        throw new Error("Unexpected mock fetch call");
      }
      if (next instanceof Error) {
        throw next;
      }
      return typeof next === "function" ? await next() : next;
    }
  };
}

function controlledTime(start: number): {
  clock: () => number;
  advance: (milliseconds: number) => void;
  sleep: (milliseconds: number) => Promise<void>;
  sleeps: number[];
} {
  let now = start;
  const sleeps: number[] = [];
  return {
    clock: () => now,
    advance: (milliseconds) => {
      now += milliseconds;
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    sleeps
  };
}

function firingTimer(): {
  adapter: UpriverTimer;
  delays: number[];
  cleared: unknown[];
} {
  let nextHandle = 0;
  const delays: number[] = [];
  const cleared: unknown[] = [];
  return {
    adapter: {
      set(callback, milliseconds) {
        delays.push(milliseconds);
        const handle = ++nextHandle;
        callback();
        return handle;
      },
      clear(handle) {
        cleared.push(handle);
      }
    },
    delays,
    cleared
  };
}

function passiveTimer(): {
  adapter: UpriverTimer;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    adapter: {
      set(_callback, milliseconds) {
        delays.push(milliseconds);
        return delays.length;
      },
      clear() {
        return;
      }
    },
    delays
  };
}

async function captureError(
  operation: () => Promise<unknown>
): Promise<UpriverHttpError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof UpriverHttpError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected UpriverHttpError");
}

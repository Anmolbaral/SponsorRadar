import { describe, expect, it } from "vitest";
import {
  AuditRecorder,
  fingerprint,
  redactSensitive
} from "@/src/observability/audit";

describe("audit recorder", () => {
  it("redacts secrets and personal account fields before fingerprinting", () => {
    const input = {
      channel: "@creator",
      email: "person@example.com",
      nested: {
        authorization: "Bearer secret",
        api_key: "secret-key",
        name: "Creator name"
      }
    };
    expect(redactSensitive(input)).toEqual({
      channel: "@creator",
      email: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        api_key: "[REDACTED]",
        name: "Creator name"
      }
    });
    expect(fingerprint(input)).not.toContain("secret");
  });

  it("produces the same fingerprint regardless of object key order", () => {
    expect(fingerprint({ a: 1, b: { c: 2 } })).toBe(
      fingerprint({ b: { c: 2 }, a: 1 })
    );
  });

  it("records paired tool events, latency, rows, and zero fixture credits", async () => {
    let time = Date.parse("2026-07-19T00:00:00.000Z");
    const audit = new AuditRecorder({
      runId: "run-test",
      clock: () => (time += 5)
    });
    audit.startRun({ channel: "@creator" });
    audit.recordPolicy(150);
    const value = await audit.tool(
      {
        name: "fixture.example",
        reason: "Test an observable fixture call",
        mode: "fixture",
        input: { email: "hidden@example.com" },
        cacheStatus: "hit",
        estimatedCredits: 0
      },
      async () => ["row"],
      (rows) => ({ rows: rows.length })
    );
    audit.reportReady(1);

    expect(value).toEqual(["row"]);
    const events = audit.getEvents();
    expect(events.map((event) => event.eventType)).toEqual([
      "run.started",
      "policy.decided",
      "tool.started",
      "tool.completed",
      "report.ready"
    ]);
    expect(events[3].tool).toMatchObject({
      durationMs: 10,
      rows: 1,
      estimatedCredits: 0,
      resultBasedCredits: null,
      outcome: "success"
    });
    expect(audit.summarize(21)).toMatchObject({
      toolCalls: 1,
      llmCalls: 0,
      resultBasedCreditEstimate: 0,
      projectedLiveCredits: 21,
      timeToFirstResultMs: 35
    });
  });

  it("records a failed tool without leaking the error message", async () => {
    const emitted: unknown[] = [];
    const audit = new AuditRecorder({
      runId: "failed",
      sink: (event) => emitted.push(event)
    });
    audit.startRun({});
    await expect(
      audit.tool(
        {
          name: "fixture.failure",
          reason: "Exercise failure telemetry",
          mode: "fixture",
          input: {},
          cacheStatus: "not_applicable",
          estimatedCredits: 0
        },
        async () => {
          throw new TypeError("secret payload");
        },
        () => ({ rows: 0 })
      )
    ).rejects.toThrow(TypeError);

    expect(audit.getEvents().at(-1)).toMatchObject({
      eventType: "tool.failed",
      tool: { errorType: "TypeError", outcome: "failure" }
    });
    expect(JSON.stringify(audit.getEvents())).not.toContain("secret payload");
    expect(emitted).toEqual(audit.getEvents());
  });

  it("records a live policy estimate and reconciled tool metadata", async () => {
    let time = Date.parse("2026-07-19T00:00:00.000Z");
    const audit = new AuditRecorder({
      runId: "live-run",
      phase: "phase_2_live",
      mode: "live",
      clock: () => (time += 10)
    });
    audit.startRun({ channel: "@creator" });
    audit.recordPolicy({
      decision: "allow",
      reason: "The 25-credit estimate fits within the run budget",
      estimatedCredits: 25,
      maximumCredits: 40,
      remainingCredits: 15
    });

    await audit.tool(
      {
        name: "upriver.list_sponsors",
        reason: "Fetch a bounded sponsor result page",
        input: { channel: "@creator", "x-api-key": "secret" },
        cacheStatus: "not_applicable",
        estimatedCredits: 25
      },
      async () => ["one", "two", "three"],
      (rows) => ({
        rows: rows.length,
        resultBasedCredits: 15,
        requestId: "request-123",
        retryCount: 1,
        durationMs: 82
      })
    );

    const events = audit.getEvents();
    expect(events[1]).toMatchObject({
      phase: "phase_2_live",
      eventType: "policy.decided",
      reason: "The 25-credit estimate fits within the run budget",
      policy: {
        decision: "allow",
        estimatedCredits: 25,
        resultBasedCredits: 0,
        maximumCredits: 40,
        remainingCredits: 15
      }
    });
    expect(events[2].tool).toMatchObject({
      mode: "live",
      estimatedCredits: 25,
      resultBasedCredits: null,
      reconciliation: "pending"
    });
    expect(events[3].tool).toMatchObject({
      mode: "live",
      durationMs: 82,
      rows: 3,
      estimatedCredits: 25,
      resultBasedCredits: 15,
      reconciliation: "mismatch",
      requestId: "request-123",
      retryCount: 1,
      outcome: "success"
    });
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("records a denied live preflight without starting a tool", () => {
    const audit = new AuditRecorder({
      runId: "denied-live-run",
      phase: "phase_2_live",
      mode: "live"
    });
    audit.startRun({ channel: "@creator" });
    audit.recordPolicy({
      decision: "deny",
      reason: "The estimate exceeds the remaining allocation",
      estimatedCredits: 25,
      maximumCredits: 20,
      remainingCredits: 20
    });

    expect(audit.getEvents().at(-1)).toMatchObject({
      eventType: "policy.decided",
      phase: "phase_2_live",
      policy: {
        decision: "deny",
        estimatedCredits: 25,
        maximumCredits: 20,
        remainingCredits: 20
      }
    });
    expect(audit.summarize(25).toolCalls).toBe(0);
  });

  it("records safe per-request lifecycle metadata without query or body data", () => {
    const audit = new AuditRecorder({
      runId: "live-http",
      phase: "phase_2_live",
      mode: "live"
    });
    audit.recordHttpLifecycle({
      phase: "started",
      method: "GET",
      path: "/v1/sponsors",
      requestId: "local-request",
      audit: {
        operation: "live.list_peer_sponsors",
        reason: "Retrieve sponsors for locked peer Dave2D",
        estimatedCredits: 10
      }
    });
    audit.recordHttpLifecycle({
      phase: "completed",
      method: "GET",
      path: "/v1/sponsors",
      requestId: "local-request",
      audit: {
        operation: "live.list_peer_sponsors",
        reason: "Retrieve sponsors for locked peer Dave2D",
        estimatedCredits: 10
      },
      usage: {
        rows: 1,
        resultBasedCredits: 5
      },
      meta: {
        providerRequestId: "provider-request",
        latencyMs: 42,
        attempts: [{}, {}]
      }
    });

    expect(audit.getEvents()).toEqual([
      expect.objectContaining({
        phase: "phase_2_live",
        eventType: "http.started",
        reason: "Retrieve sponsors for locked peer Dave2D",
        tool: expect.objectContaining({
          name: "upriver.http.live.list_peer_sponsors",
          requestId: "local-request",
          cacheStatus: "not_applicable",
          estimatedCredits: 10
        })
      }),
      expect.objectContaining({
        eventType: "http.completed",
        tool: expect.objectContaining({
          providerRequestId: "provider-request",
          durationMs: 42,
          retryCount: 1,
          rows: 1,
          resultBasedCredits: 5,
          outcome: "success"
        })
      })
    ]);
    expect(JSON.stringify(audit.getEvents())).not.toContain("publication_url");
  });
});

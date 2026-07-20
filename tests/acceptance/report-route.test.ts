import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/report/route";

describe("report HTTP boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns the verified report from one channel input", async () => {
    const response = await POST(
      new Request("http://localhost/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "@UrAvgConsumer" })
      })
    );
    const payload = (await response.json()) as {
      report: { leads: Array<{ brand: string }> };
    };

    expect(response.status).toBe(200);
    expect(payload.report.leads).toEqual([
      expect.objectContaining({ brand: "Dell" })
    ]);
  });

  it("returns an actionable validation error without research calls", async () => {
    const response = await POST(
      new Request("http://localhost/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "" })
      })
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/YouTube/);
  });

  it("returns an honest sample-state response for an unsupported channel", async () => {
    const response = await POST(
      new Request("http://localhost/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "@MKBHD" })
      })
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(422);
    expect(payload.error).toBe(
      "This channel is not available for research. Try a different YouTube channel."
    );
    expect(JSON.stringify(payload)).not.toMatch(/demo|pilot|fixture|phase/i);
  });

  it("cannot enable live mode from the browser request", async () => {
    const response = await POST(
      new Request("http://localhost/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channel: "@UrAvgConsumer",
          mode: "live",
          apiKey: "browser-secret"
        })
      })
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("browser-secret");
    expect(body).not.toHaveProperty("details");
  });

  it("keeps full paid live reports off the public route", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("UPRIVER_MODE", "live");
    vi.stubEnv("UPRIVER_LIVE_SMOKE", "true");
    vi.stubEnv("UPRIVER_API_KEY", "server-secret");

    const response = await POST(
      new Request("http://localhost/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "@UrAvgConsumer" })
      })
    );

    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps malformed JSON to a client error", async () => {
    const response = await POST(
      new Request("http://localhost/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/valid JSON/)
    });
  });
});

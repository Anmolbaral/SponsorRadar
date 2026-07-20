import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("production access gate", () => {
  it("fails closed in production when credentials are absent", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SPONSOR_RADAR_BASIC_AUTH_USER", "");
    vi.stubEnv("SPONSOR_RADAR_BASIC_AUTH_PASSWORD", "");

    const response = proxy(
      new NextRequest("https://radar.example/")
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("challenges missing or incorrect credentials", () => {
    configureCredentials();

    const missing = proxy(
      new NextRequest("https://radar.example/")
    );
    const incorrect = proxy(
      new NextRequest("https://radar.example/", {
        headers: {
          authorization: basicAuthorization("reviewer", "wrong")
        }
      })
    );

    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain(
      "Sponsor Winback Radar"
    );
  });

  it("allows the configured reviewer credentials", () => {
    configureCredentials();

    const response = proxy(
      new NextRequest("https://radar.example/", {
        headers: {
          authorization: basicAuthorization(
            "reviewer",
            "correct horse battery staple"
          )
        }
      })
    );

    expect(response.status).toBe(200);
  });
});

function configureCredentials(): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SPONSOR_RADAR_BASIC_AUTH_USER", "reviewer");
  vi.stubEnv(
    "SPONSOR_RADAR_BASIC_AUTH_PASSWORD",
    "correct horse battery staple"
  );
}

function basicAuthorization(
  username: string,
  password: string
): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "@/next.config";

describe("content security policy", () => {
  it("relaxes script-src with unsafe-eval only in development", () => {
    const development = contentSecurityPolicy(true);
    expect(development).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    );
  });

  it("never allows unsafe-eval in production or test builds", () => {
    for (const csp of [contentSecurityPolicy(false)]) {
      expect(csp).not.toContain("unsafe-eval");
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    }
  });

  it("keeps the rest of the policy locked down regardless of environment", () => {
    for (const csp of [contentSecurityPolicy(true), contentSecurityPolicy(false)]) {
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'self'");
    }
  });
});

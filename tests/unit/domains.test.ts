import { describe, expect, it } from "vitest";
import { normalizeDomain } from "@/src/radar/domain/domains";

describe("normalizeDomain", () => {
  it.each([
    ["dell.com", "dell.com"],
    ["HTTPS://WWW.DELL.COM/xps?campaign=1", "dell.com"],
    ["www.dell.com.", "dell.com"],
    [" https://sub.example.com/path ", "sub.example.com"],
    ["mañana.com", "xn--maana-pta.com"]
  ])("normalizes %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([null, undefined, "", "   ", "not a domain", "localhost", "https://"])(
    "returns null for unusable input %s",
    (input) => {
      expect(normalizeDomain(input)).toBeNull();
    }
  );

  it("does not strip lookalike www prefixes", () => {
    expect(normalizeDomain("www2.example.com")).toBe("www2.example.com");
  });
});

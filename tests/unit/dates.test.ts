import { describe, expect, it } from "vitest";
import {
  assertIsoDate,
  daysBetween,
  isBeforeExclusive,
  isIsoDate
} from "@/src/radar/domain/dates";

describe("ISO date rules", () => {
  it.each(["2026-07-19", "2024-02-29", "2000-01-01"])(
    "accepts a real date %s",
    (value) => expect(isIsoDate(value)).toBe(true)
  );

  it.each([
    "2026-7-19",
    "2026-02-29",
    "2026-04-31",
    "not-a-date",
    ""
  ])("rejects an invalid date %s", (value) => {
    expect(isIsoDate(value)).toBe(false);
  });

  it("keeps the stale cutoff exclusive", () => {
    expect(isBeforeExclusive("2026-04-19", "2026-04-20")).toBe(true);
    expect(isBeforeExclusive("2026-04-20", "2026-04-20")).toBe(false);
    expect(isBeforeExclusive("2026-04-21", "2026-04-20")).toBe(false);
  });

  it("fails closed on an invalid compared date", () => {
    expect(() => isBeforeExclusive("2026-02-30", "2026-04-20")).toThrow(
      /real calendar date/
    );
    expect(() => isBeforeExclusive("2026-04-19", "bad")).toThrow(
      /real calendar date/
    );
    expect(() => assertIsoDate("July 19", "pilot date")).toThrow(/pilot date/);
  });

  it("calculates whole UTC calendar days", () => {
    expect(daysBetween("2026-01-09", "2026-07-19")).toBe(191);
    expect(daysBetween("2026-07-19", "2026-07-19")).toBe(0);
  });
});

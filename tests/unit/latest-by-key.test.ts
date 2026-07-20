import { describe, expect, it } from "vitest";
import { latestByKey } from "@/src/radar/domain/latest-by-key";

describe("latestByKey", () => {
  it("uses the newest placement when a normalized domain appears twice", () => {
    const rows = latestByKey(
      [
        { domain: "brand.com", date: "2026-01-01", id: "old" },
        { domain: "other.com", date: "2026-02-01", id: "other" },
        { domain: "brand.com", date: "2026-06-01", id: "new" }
      ],
      (row) => row.domain,
      (row) => row.date
    );
    expect(rows.map((row) => row.id)).toEqual(["new", "other"]);
  });

  it("ignores rows without a join key and keeps the first on a date tie", () => {
    const rows = latestByKey(
      [
        { domain: null, date: "2026-07-01", id: "missing" },
        { domain: "brand.com", date: "2026-06-01", id: "first" },
        { domain: "brand.com", date: "2026-06-01", id: "tie" }
      ],
      (row) => row.domain,
      (row) => row.date
    );
    expect(rows).toEqual([
      { domain: "brand.com", date: "2026-06-01", id: "first" }
    ]);
  });

  it("fails closed on an invalid placement date", () => {
    expect(() =>
      latestByKey(
        [{ domain: "brand.com", date: "not-a-date" }],
        (row) => row.domain,
        (row) => row.date
      )
    ).toThrow(/placement date/);
  });
});

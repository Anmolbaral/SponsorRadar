import { describe, expect, it } from "vitest";
import {
  coveragePercentage,
  coverageWarning
} from "@/src/radar/domain/coverage";
import {
  CreditBudget,
  estimateUpriverCredits,
  reconcileCreditUsage
} from "@/src/radar/domain/credits";

describe("coverage reporting", () => {
  it("rounds coverage to one decimal place", () => {
    expect(coveragePercentage(49, 89)).toBe(55.1);
    expect(coveragePercentage(2, 3)).toBe(66.7);
  });

  it("creates a warning below the threshold", () => {
    expect(
      coverageWarning({
        code: "target_domain_coverage",
        numerator: 49,
        denominator: 89,
        subject: "Target rows"
      })
    ).toMatchObject({
      severity: "warning",
      percentage: 55.1,
      numerator: 49,
      denominator: 89
    });
  });

  it("omits warnings at or above the threshold", () => {
    expect(
      coverageWarning({
        code: "peer_domain_joinability",
        numerator: 9,
        denominator: 10,
        subject: "Peers"
      })
    ).toBeNull();
    expect(
      coverageWarning({
        code: "peer_domain_joinability",
        numerator: 8,
        denominator: 10,
        subject: "Peers",
        threshold: 80
      })
    ).toBeNull();
  });

  it("reports zero available rows as unknown coverage instead of dividing 0/0", () => {
    expect(
      coverageWarning({
        code: "target_domain_coverage",
        numerator: 0,
        denominator: 0,
        subject: "Target rows"
      })
    ).toEqual({
      code: "target_domain_coverage",
      severity: "warning",
      numerator: 0,
      denominator: 0,
      message:
        "Target rows: no rows were available, so coverage cannot be calculated. Missing data may hide valid matches."
    });
  });

  it.each([
    [-1, 10],
    [11, 10],
    [1, 0],
    [Number.NaN, 10],
    [1, Number.POSITIVE_INFINITY]
  ])("rejects invalid coverage %s/%s", (numerator, denominator) => {
    expect(() => coveragePercentage(numerator, denominator)).toThrow();
  });
});

describe("Upriver credit estimates", () => {
  it("prices returned results rather than request count", () => {
    expect(
      estimateUpriverCredits({
        groupedSponsorResults: 3,
        creatorResults: 3,
        brandResearchReports: 1
      })
    ).toBe(21);
  });

  it("supports every exposed relevant rate", () => {
    expect(
      estimateUpriverCredits({
        groupedSponsorResults: 1,
        sponsorshipPlacements: 1,
        creatorResults: 1,
        creatorEnrichments: 1,
        brandResearchReports: 1
      })
    ).toBe(13);
    expect(estimateUpriverCredits({})).toBe(0);
  });

  it.each([-1, 1.25])("rejects an invalid quantity %s", (quantity) => {
    expect(() =>
      estimateUpriverCredits({ creatorResults: quantity })
    ).toThrow(/non-negative integer/);
  });

  it("reserves estimates so concurrent calls cannot over-allocate the budget", () => {
    const budget = new CreditBudget(10);
    const first = budget.preflight({
      estimatedCredits: 6,
      reason: "fetch the target sponsor page"
    });
    const denied = budget.preflight({
      estimatedCredits: 5,
      reason: "fetch a peer sponsor page"
    });

    expect(first).toMatchObject({
      decision: "allow",
      allocationId: "credit-allocation-1",
      reservedCredits: 6,
      remainingCredits: 4
    });
    expect(denied).toMatchObject({
      decision: "deny",
      allocationId: null,
      estimatedCredits: 5,
      reservedCredits: 6,
      remainingCredits: 4,
      shortfallCredits: 1
    });
    expect(budget.snapshot()).toMatchObject({
      maximumCredits: 10,
      resultBasedCredits: 0,
      reservedCredits: 6,
      remainingCredits: 4
    });
  });

  it("releases unused reservation after the result-based estimate is known", () => {
    const budget = new CreditBudget(10);
    const preflight = budget.preflight({
      estimatedCredits: 6,
      reason: "fetch at most two sponsorship placements"
    });
    if (preflight.decision !== "allow") {
      throw new Error("expected the preflight to be allowed");
    }

    const reconciliation = budget.reconcile(preflight.allocationId, 3);

    expect(reconciliation).toMatchObject({
      estimatedCredits: 6,
      resultBasedCreditsForCall: 3,
      varianceCredits: -3,
      reconciliation: "mismatch",
      resultBasedCredits: 3,
      reservedCredits: 0,
      remainingCredits: 7,
      exceededCredits: 0
    });
    expect(
      budget.preflight({
        estimatedCredits: 7,
        reason: "use the released allocation"
      }).decision
    ).toBe("allow");
  });

  it("surfaces a result-based overage and prevents double reconciliation", () => {
    const budget = new CreditBudget(5);
    const preflight = budget.preflight({
      estimatedCredits: 5,
      reason: "fetch one bounded page"
    });
    if (preflight.decision !== "allow") {
      throw new Error("expected the preflight to be allowed");
    }

    expect(budget.reconcile(preflight.allocationId, 7)).toMatchObject({
      resultBasedCredits: 7,
      remainingCredits: 0,
      exceededCredits: 2,
      varianceCredits: 2,
      reconciliation: "mismatch"
    });
    expect(() => budget.reconcile(preflight.allocationId, 7)).toThrow(
      /already reconciled/
    );
  });

  it("reconciles an exact per-result estimate as matched", () => {
    expect(reconcileCreditUsage(15, 15)).toEqual({
      estimatedCredits: 15,
      resultBasedCreditsForCall: 15,
      varianceCredits: 0,
      reconciliation: "matched"
    });
  });

  it.each([
    () => new CreditBudget(-1),
    () =>
      new CreditBudget(10).preflight({
        estimatedCredits: 1.5,
        reason: "invalid estimate"
      }),
    () =>
      new CreditBudget(10).preflight({
        estimatedCredits: 1,
        reason: " "
      }),
    () => reconcileCreditUsage(1, Number.NaN)
  ])("rejects invalid budget input", (operation) => {
    expect(operation).toThrow();
  });
});

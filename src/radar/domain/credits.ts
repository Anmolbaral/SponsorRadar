export const UPRIVER_CREDIT_RATES = {
  groupedSponsorResult: 5,
  sponsorshipPlacement: 3,
  creatorResult: 1,
  creatorEnrichment: 1,
  brandResearchReport: 3
} as const;

export interface CreditEstimateInput {
  groupedSponsorResults?: number;
  sponsorshipPlacements?: number;
  creatorResults?: number;
  creatorEnrichments?: number;
  brandResearchReports?: number;
}

export interface CreditBudgetSnapshot {
  maximumCredits: number;
  reservedCredits: number;
  resultBasedCredits: number;
  remainingCredits: number;
  exceededCredits: number;
}

export interface CreditPreflightInput {
  estimatedCredits: number;
  reason: string;
}

interface CreditPreflightBase extends CreditBudgetSnapshot {
  estimatedCredits: number;
  reason: string;
}

export type CreditPreflightDecision =
  | (CreditPreflightBase & {
      decision: "allow";
      allocationId: string;
      shortfallCredits: 0;
    })
  | (CreditPreflightBase & {
      decision: "deny";
      allocationId: null;
      shortfallCredits: number;
    });

export interface CreditReconciliation extends CreditBudgetSnapshot {
  allocationId: string;
  estimatedCredits: number;
  resultBasedCreditsForCall: number;
  varianceCredits: number;
  reconciliation: "matched" | "mismatch";
}

export function estimateUpriverCredits(input: CreditEstimateInput): number {
  const quantities = {
    groupedSponsorResults: input.groupedSponsorResults ?? 0,
    sponsorshipPlacements: input.sponsorshipPlacements ?? 0,
    creatorResults: input.creatorResults ?? 0,
    creatorEnrichments: input.creatorEnrichments ?? 0,
    brandResearchReports: input.brandResearchReports ?? 0
  };

  for (const [name, value] of Object.entries(quantities)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }

  return (
    quantities.groupedSponsorResults *
      UPRIVER_CREDIT_RATES.groupedSponsorResult +
    quantities.sponsorshipPlacements *
      UPRIVER_CREDIT_RATES.sponsorshipPlacement +
    quantities.creatorResults * UPRIVER_CREDIT_RATES.creatorResult +
    quantities.creatorEnrichments *
      UPRIVER_CREDIT_RATES.creatorEnrichment +
    quantities.brandResearchReports *
      UPRIVER_CREDIT_RATES.brandResearchReport
  );
}

/**
 * Reserves the maximum expected cost before a call and replaces the reservation
 * with a result-count-based estimate after the call completes.
 */
export class CreditBudget {
  readonly maximumCredits: number;
  private reservedCredits = 0;
  private resultBasedCredits = 0;
  private nextAllocation = 1;
  private readonly allocations = new Map<string, number>();

  constructor(maximumCredits: number) {
    assertCreditQuantity("maximumCredits", maximumCredits);
    this.maximumCredits = maximumCredits;
  }

  preflight(input: CreditPreflightInput): CreditPreflightDecision {
    assertCreditQuantity("estimatedCredits", input.estimatedCredits);
    if (input.reason.trim().length === 0) {
      throw new Error("reason must not be empty");
    }

    const before = this.snapshot();
    if (input.estimatedCredits > before.remainingCredits) {
      return {
        ...before,
        decision: "deny",
        allocationId: null,
        estimatedCredits: input.estimatedCredits,
        shortfallCredits: input.estimatedCredits - before.remainingCredits,
        reason:
          `Denied ${input.reason}: estimated ${input.estimatedCredits} credits ` +
          `exceeds ${before.remainingCredits} remaining`
      };
    }

    const allocationId = `credit-allocation-${this.nextAllocation++}`;
    this.allocations.set(allocationId, input.estimatedCredits);
    this.reservedCredits += input.estimatedCredits;

    return {
      ...this.snapshot(),
      decision: "allow",
      allocationId,
      estimatedCredits: input.estimatedCredits,
      shortfallCredits: 0,
      reason:
        `Allowed ${input.reason}: reserved ${input.estimatedCredits} credits ` +
        `with ${this.remainingCredits()} remaining`
    };
  }

  reconcile(
    allocationId: string,
    resultBasedCreditsForCall: number
  ): CreditReconciliation {
    assertCreditQuantity("resultBasedCredits", resultBasedCreditsForCall);
    const estimatedCredits = this.allocations.get(allocationId);
    if (estimatedCredits === undefined) {
      throw new Error(`Unknown or already reconciled allocation: ${allocationId}`);
    }

    this.allocations.delete(allocationId);
    this.reservedCredits -= estimatedCredits;
    this.resultBasedCredits += resultBasedCreditsForCall;

    return {
      ...this.snapshot(),
      allocationId,
      estimatedCredits,
      resultBasedCreditsForCall,
      varianceCredits: resultBasedCreditsForCall - estimatedCredits,
      reconciliation:
        resultBasedCreditsForCall === estimatedCredits ? "matched" : "mismatch"
    };
  }

  snapshot(): CreditBudgetSnapshot {
    const unallocated =
      this.maximumCredits - this.reservedCredits - this.resultBasedCredits;
    return {
      maximumCredits: this.maximumCredits,
      reservedCredits: this.reservedCredits,
      resultBasedCredits: this.resultBasedCredits,
      remainingCredits: Math.max(0, unallocated),
      exceededCredits: Math.max(0, -unallocated)
    };
  }

  private remainingCredits(): number {
    return this.snapshot().remainingCredits;
  }
}

export function reconcileCreditUsage(
  estimatedCredits: number,
  resultBasedCredits: number
): Pick<
  CreditReconciliation,
  "estimatedCredits" | "resultBasedCreditsForCall" | "varianceCredits" | "reconciliation"
> {
  assertCreditQuantity("estimatedCredits", estimatedCredits);
  assertCreditQuantity("resultBasedCredits", resultBasedCredits);
  return {
    estimatedCredits,
    resultBasedCreditsForCall: resultBasedCredits,
    varianceCredits: resultBasedCredits - estimatedCredits,
    reconciliation:
      resultBasedCredits === estimatedCredits ? "matched" : "mismatch"
  };
}

function assertCreditQuantity(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

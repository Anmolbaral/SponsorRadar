import type { CoverageNotice } from "./types";

export function coveragePercentage(
  numerator: number,
  denominator: number
): number {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator < 0 ||
    denominator <= 0 ||
    numerator > denominator
  ) {
    throw new Error("coverage requires 0 <= numerator <= denominator");
  }

  return Math.round((numerator / denominator) * 1000) / 10;
}

export function coverageWarning(input: {
  code: Extract<
    CoverageNotice["code"],
    "target_domain_coverage" | "peer_domain_joinability"
  >;
  numerator: number;
  denominator: number;
  subject: string;
  threshold?: number;
}): CoverageNotice | null {
  if (input.numerator === 0 && input.denominator === 0) {
    return {
      code: input.code,
      severity: "warning",
      numerator: 0,
      denominator: 0,
      message: `${input.subject}: no rows were available, so coverage cannot be calculated. Missing data may hide valid matches.`
    };
  }

  const percentage = coveragePercentage(input.numerator, input.denominator);
  const threshold = input.threshold ?? 90;
  if (percentage >= threshold) {
    return null;
  }

  return {
    code: input.code,
    severity: "warning",
    numerator: input.numerator,
    denominator: input.denominator,
    percentage,
    message: `${input.subject}: ${input.numerator}/${input.denominator} (${percentage}%). Missing data may hide valid matches.`
  };
}

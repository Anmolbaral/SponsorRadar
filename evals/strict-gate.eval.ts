import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateStrictCandidate } from "@/src/radar/domain/eligibility";
import type {
  ContinuityGrade,
  Evidence,
  SponsorshipClass,
  StrictCandidate
} from "@/src/radar/domain/types";

interface EvalCase {
  id: string;
  domain: string | null;
  brand: string;
  targetClass: SponsorshipClass;
  peerClass: SponsorshipClass;
  continuity: ContinuityGrade;
  verificationPresent: boolean;
  targetEvidence: boolean;
  peerEvidence: boolean;
  expectedEligible: boolean;
  reason: string;
}

const evidence: Evidence = {
  channel: "Verified creator",
  contentUrl: "https://youtube.com/watch?v=verified",
  publishedDate: "2026-06-16",
  excerpt: "Public sponsorship evidence was manually verified.",
  videoTitle: "Verified placement"
};

describe("strict gate frozen product eval", () => {
  it("achieves 100% compliance and macro-F1 >= 0.90 on 25+ labeled cases", async () => {
    const cases = JSON.parse(
      await readFile(
        path.join(process.cwd(), "evals/cases/strict-gate.json"),
        "utf8"
      )
    ) as EvalCase[];

    const results = cases.map((evalCase) => {
      const candidate: StrictCandidate = {
        domain: evalCase.domain,
        brand: evalCase.brand,
        targetClass: evalCase.targetClass,
        peerClass: evalCase.peerClass,
        continuity: evalCase.continuity,
        verificationPresent: evalCase.verificationPresent,
        targetEvidence: evalCase.targetEvidence ? evidence : null,
        peerEvidence: evalCase.peerEvidence ? evidence : null
      };
      return {
        id: evalCase.id,
        actual: evaluateStrictCandidate(candidate).eligible,
        expected: evalCase.expectedEligible
      };
    });

    expect(results.filter((result) => result.actual !== result.expected)).toEqual(
      []
    );
    expect(results.length).toBeGreaterThanOrEqual(25);
    expect(macroF1(results)).toBeGreaterThanOrEqual(0.9);
  });
});

function macroF1(
  results: Array<{ actual: boolean; expected: boolean }>
): number {
  const f1 = [true, false].map((label) => {
    const truePositive = results.filter(
      (result) => result.actual === label && result.expected === label
    ).length;
    const falsePositive = results.filter(
      (result) => result.actual === label && result.expected !== label
    ).length;
    const falseNegative = results.filter(
      (result) => result.actual !== label && result.expected === label
    ).length;
    const precision = truePositive / (truePositive + falsePositive);
    const recall = truePositive / (truePositive + falseNegative);
    return (2 * precision * recall) / (precision + recall);
  });
  return f1.reduce((sum, value) => sum + value, 0) / f1.length;
}

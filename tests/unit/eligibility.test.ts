import { describe, expect, it } from "vitest";
import {
  evaluateStrictCandidate,
  selectStrictCandidates
} from "@/src/radar/domain/eligibility";
import type { Evidence, StrictCandidate } from "@/src/radar/domain/types";

const evidence: Evidence = {
  channel: "A channel",
  contentUrl: "https://youtube.com/watch?v=evidence",
  publishedDate: "2026-06-16",
  excerpt: "The description explicitly says the brand sponsored this video.",
  videoTitle: "Verified video"
};

const passing: StrictCandidate = {
  domain: "dell.com",
  brand: "Dell",
  targetClass: "S3",
  peerClass: "S3",
  continuity: "A",
  verificationPresent: true,
  targetEvidence: evidence,
  peerEvidence: evidence
};

describe("strict sponsorship gate", () => {
  it.each(["A", "B"] as const)("passes S3/S3 continuity %s", (continuity) => {
    expect(
      evaluateStrictCandidate({ ...passing, continuity })
    ).toEqual({ eligible: true, failures: [] });
  });

  it("reports every reason a weak overlap fails", () => {
    const evaluation = evaluateStrictCandidate({
      domain: null,
      brand: "Weak overlap",
      targetClass: "S1",
      peerClass: "S2",
      continuity: "C",
      verificationPresent: false,
      targetEvidence: null,
      peerEvidence: null
    });

    expect(evaluation.eligible).toBe(false);
    expect(evaluation.failures).toEqual([
      "missing_domain",
      "missing_verification",
      "target_not_confirmed_paid",
      "peer_not_confirmed_paid",
      "product_continuity_not_supported",
      "missing_target_evidence",
      "missing_peer_evidence"
    ]);
  });

  it.each([
    ["target S1", { targetClass: "S1" as const }],
    ["peer S2", { peerClass: "S2" as const }],
    ["continuity U", { continuity: "U" as const }],
    ["continuity C", { continuity: "C" as const }],
    ["missing domain", { domain: null }],
    ["missing verification", { verificationPresent: false }]
  ])("rejects %s", (_name, override) => {
    expect(
      evaluateStrictCandidate({ ...passing, ...override }).eligible
    ).toBe(false);
  });

  it("returns only real passes and never pads to the requested limit", () => {
    const selected = selectStrictCandidates(
      [
        passing,
        { ...passing, brand: "Affiliate", targetClass: "S1" },
        { ...passing, brand: "Mismatch", continuity: "C" }
      ],
      3
    );
    expect(selected.map((candidate) => candidate.brand)).toEqual(["Dell"]);
  });

  it("supports a zero limit and rejects invalid limits", () => {
    expect(selectStrictCandidates([passing], 0)).toEqual([]);
    expect(() => selectStrictCandidates([passing], -1)).toThrow(
      /non-negative integer/
    );
    expect(() => selectStrictCandidates([passing], 1.5)).toThrow(
      /non-negative integer/
    );
  });
});

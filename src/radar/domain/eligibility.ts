import type {
  StrictCandidate,
  StrictEvaluation,
  StrictFailure
} from "./types";

export function evaluateStrictCandidate(
  candidate: StrictCandidate
): StrictEvaluation {
  const failures: StrictFailure[] = [];

  if (!candidate.domain) {
    failures.push("missing_domain");
  }
  if (!candidate.verificationPresent) {
    failures.push("missing_verification");
  }
  if (candidate.targetClass !== "S3") {
    failures.push("target_not_confirmed_paid");
  }
  if (candidate.peerClass !== "S3") {
    failures.push("peer_not_confirmed_paid");
  }
  if (candidate.continuity !== "A" && candidate.continuity !== "B") {
    failures.push("product_continuity_not_supported");
  }
  if (!candidate.targetEvidence) {
    failures.push("missing_target_evidence");
  }
  if (!candidate.peerEvidence) {
    failures.push("missing_peer_evidence");
  }

  return { eligible: failures.length === 0, failures };
}

export function selectStrictCandidates<T extends StrictCandidate>(
  candidates: T[],
  limit = 3
): T[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("result limit must be a non-negative integer");
  }

  return candidates
    .filter((candidate) => evaluateStrictCandidate(candidate).eligible)
    .slice(0, limit);
}

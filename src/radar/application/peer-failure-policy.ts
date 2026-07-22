import type { UpriverErrorCode } from "@/src/radar/adapters/upriver/http-client";
import { UpriverHttpError } from "@/src/radar/adapters/upriver/http-client";
import type { SponsorRadarEvidencePort } from "@/src/radar/application/ports";

const NO_SPEND_TERMINAL_UPRIVER_ERRORS = new Map<
  UpriverErrorCode,
  number | null
>([
  ["invalid_request", null],
  ["bad_request", 400],
  ["authentication_failed", 401],
  ["permission_denied", 403]
]);

/**
 * A peer sponsor failure may be recorded as partial evidence only when the
 * provider provably spent nothing; anything ambiguous terminates the run.
 */
export function canTreatPeerFailureAsPartial(
  mode: SponsorRadarEvidencePort["mode"],
  error: unknown
): boolean {
  if (mode === "fixture") {
    return true;
  }
  if (!(error instanceof UpriverHttpError)) {
    return false;
  }
  const expectedStatus = NO_SPEND_TERMINAL_UPRIVER_ERRORS.get(error.code);
  if (
    expectedStatus === undefined ||
    error.status !== expectedStatus
  ) {
    return false;
  }
  if (error.code === "invalid_request") {
    return error.meta.attempts.length === 0;
  }
  return (
    error.meta.attempts.length > 0 &&
    error.meta.attempts.every(
      (attempt) =>
        attempt.outcome === "http_error" &&
        attempt.status === expectedStatus
    )
  );
}

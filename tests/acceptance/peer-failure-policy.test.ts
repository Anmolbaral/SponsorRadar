import { describe, expect, it } from "vitest";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import {
  UpriverHttpError,
  type UpriverAttemptMetadata,
  type UpriverErrorCode
} from "@/src/radar/adapters/upriver/http-client";
import type {
  EvidenceMode,
  EvidenceOperation,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import { runWinbackReport } from "@/src/radar/application/run-winback-report";
import { parseYouTubeIdentity } from "@/src/radar/domain/youtube";

describe("peer failure policy", () => {
  it("preserves successful fixture evidence as a partial report", async () => {
    const gateway = new FailingPeerGateway(
      "fixture",
      new Error("Recorded fixture peer failure")
    );

    const { report } = await runWinbackReport(
      { channel: "@UrAvgConsumer" },
      gateway,
      { allowPartialPeerFailure: true }
    );

    expect(report.leads.map((lead) => lead.brand)).toEqual(["Dell"]);
    expect(report.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "peer_research_partial",
          message: expect.stringContaining("Hayls World")
        })
      ])
    );
  });

  it.each([
    ["network_failure", null, "network_error"],
    ["timeout", null, "timeout"],
    ["rate_limited", 429, "http_error"],
    ["upstream_error", 503, "http_error"],
    ["invalid_response", 200, "success"]
  ] as const)(
    "propagates ambiguous live %s failures",
    async (code, status, outcome) => {
      const failure = upriverFailure(code, status, outcome);
      const gateway = new FailingPeerGateway("live", failure);

      await expect(
        runWinbackReport(
          { channel: "@UrAvgConsumer", maximumCredits: 150 },
          gateway,
          { allowPartialPeerFailure: true, phase: "workflow_live" }
        )
      ).rejects.toBe(failure);
    }
  );

  it("propagates unclassified live provider errors", async () => {
    const failure = new Error("Unknown provider failure");
    const gateway = new FailingPeerGateway("live", failure);

    await expect(
      runWinbackReport(
        { channel: "@UrAvgConsumer", maximumCredits: 150 },
        gateway,
        { allowPartialPeerFailure: true, phase: "workflow_live" }
      )
    ).rejects.toBe(failure);
  });

  it.each([
    ["invalid_request", null, null],
    ["bad_request", 400, "http_error"],
    ["authentication_failed", 401, "http_error"],
    ["permission_denied", 403, "http_error"]
  ] as const)(
    "permits explicitly no-spend terminal live %s failures to remain partial",
    async (code, status, outcome) => {
      const failure = upriverFailure(code, status, outcome);
      const gateway = new FailingPeerGateway("live", failure);

      const { report } = await runWinbackReport(
        { channel: "@UrAvgConsumer", maximumCredits: 150 },
        gateway,
        { allowPartialPeerFailure: true, phase: "workflow_live" }
      );

      expect(report.leads.map((lead) => lead.brand)).toEqual(["Dell"]);
      expect(report.coverage).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "peer_research_partial" })
        ])
      );
    }
  );
});

class FailingPeerGateway implements SponsorRadarEvidencePort {
  readonly mode: EvidenceMode;
  private readonly fixture = new FixtureEvidenceGateway(process.cwd());

  constructor(
    mode: EvidenceMode,
    private readonly failure: Error
  ) {
    this.mode = mode;
  }

  estimateCredits(operation: EvidenceOperation): number {
    if (this.mode === "fixture") return 0;
    switch (operation) {
      case "resolve_target":
        return 1;
      case "list_locked_peers":
        return 3;
      case "list_target_sponsors":
        return 115;
      case "list_peer_sponsors":
        return 10;
      case "load_verification_ledger":
        return 0;
    }
  }

  estimateRunCredits(): number {
    return this.mode === "fixture" ? 0 : 149;
  }

  resolveTarget(input: string) {
    return this.fixture.resolveTarget(input);
  }

  listTargetSponsors(targetUrl: string) {
    return this.fixture.listTargetSponsors(targetUrl);
  }

  listLockedPeers(targetUrl: string) {
    return this.fixture.listLockedPeers(targetUrl);
  }

  listPeerSponsors(peerUrl: string) {
    if (
      parseYouTubeIdentity(peerUrl).key ===
      parseYouTubeIdentity("@HaylsWorld").key
    ) {
      return Promise.reject(this.failure);
    }
    return this.fixture.listPeerSponsors(peerUrl);
  }

  loadVerificationLedger() {
    return this.fixture.loadVerificationLedger();
  }
}

function upriverFailure(
  code: UpriverErrorCode,
  status: number | null,
  outcome: UpriverAttemptMetadata["outcome"] | null
): UpriverHttpError {
  const attempts: UpriverAttemptMetadata[] =
    outcome === null
      ? []
      : [
          {
            attempt: 1,
            status,
            outcome,
            latencyMs: 1,
            retryDelayMs: null,
            providerRequestId: "provider-test"
          }
        ];
  return new UpriverHttpError(
    "Classified test failure",
    code,
    status,
    {
      requestId: "request-test",
      providerRequestId: "provider-test",
      latencyMs: 1,
      attempts
    }
  );
}

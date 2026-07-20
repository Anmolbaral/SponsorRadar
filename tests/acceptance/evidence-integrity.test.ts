import { describe, expect, it } from "vitest";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import type { VerificationLedger } from "@/src/radar/adapters/upriver/contracts";
import type { NormalizedSponsorEvidenceResult } from "@/src/radar/adapters/upriver/normalize";
import { runWinbackReport } from "@/src/radar/application/run-winback-report";
import { parseYouTubeIdentity } from "@/src/radar/domain/youtube";

const root = process.cwd();
const dave2dKey = parseYouTubeIdentity("@Dave2D").key;

describe("verified evidence integrity", () => {
  it("fails closed when only a different same-domain peer video and date remain", async () => {
    const gateway = new DifferentDaveEvidenceGateway(root, "replace");
    const { report } = await runWinbackReport(
      { channel: "@UrAvgConsumer" },
      gateway
    );

    expect(report.leads).toEqual([]);
  });

  it("never substitutes a different same-domain row for the exact peer evidence", async () => {
    const gateway = new DifferentDaveEvidenceGateway(root, "prepend");
    const { report } = await runWinbackReport(
      { channel: "@UrAvgConsumer" },
      gateway
    );

    expect(report.leads).toHaveLength(1);
    expect(report.leads[0]).toMatchObject({
      peer: "Dave2D",
      peerObservedPlacements: 1,
      peerFirstObservedDate: "2026-06-16",
      peerDaysSinceLatest: 33
    });
  });

  it("derives elapsed days from the as-of date and exact evidence dates", async () => {
    const gateway = new MisleadingLedgerDaysGateway(root);
    const { report } = await runWinbackReport(
      { channel: "@UrAvgConsumer" },
      gateway
    );

    expect(report.leads[0]).toMatchObject({
      targetDaysSinceLatest: 191,
      peerDaysSinceLatest: 33
    });
  });
});

class DifferentDaveEvidenceGateway extends FixtureEvidenceGateway {
  constructor(
    repositoryRoot: string,
    private readonly mutation: "replace" | "prepend"
  ) {
    super(repositoryRoot);
  }

  override async listPeerSponsors(
    peerUrl: string
  ): Promise<NormalizedSponsorEvidenceResult> {
    const result = await super.listPeerSponsors(peerUrl);
    if (parseYouTubeIdentity(peerUrl).key !== dave2dKey) return result;

    const exact = result.rows.find((row) => row.normalizedDomain === "dell.com");
    if (!exact) throw new Error("The Dell fixture row is missing");

    const different = {
      ...exact,
      totalAdsFound: 99,
      publishedDate: "2026-07-10",
      contentUrl:
        "https://www.youtube.com/watch?v=different-unverified-dell-video"
    };

    return {
      ...result,
      rows:
        this.mutation === "replace"
          ? result.rows.map((row) => (row === exact ? different : row))
          : [different, ...result.rows]
    };
  }
}

class MisleadingLedgerDaysGateway extends FixtureEvidenceGateway {
  override async loadVerificationLedger(): Promise<VerificationLedger> {
    const ledger = structuredClone(await super.loadVerificationLedger());
    for (const overlap of ledger.overlaps) {
      overlap.target_days_since_latest = 0;
      overlap.peer_days_since_latest = 0;
    }
    return ledger;
  }
}

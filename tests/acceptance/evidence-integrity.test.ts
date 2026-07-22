import { describe, expect, it } from "vitest";
import { FixtureResearchPlanner } from "@/src/agent/llm/fixture-research-planner";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import type { VerificationLedger } from "@/src/radar/adapters/upriver/contracts";
import type { NormalizedSponsorEvidenceResult } from "@/src/radar/adapters/upriver/normalize";
import { runAgenticReport } from "@/src/radar/application/agentic/run-agentic-report";
import { parseYouTubeIdentity } from "@/src/radar/domain/youtube";

const root = process.cwd();
const dave2dKey = parseYouTubeIdentity("@Dave2D").key;

// The exact Dave2D dell.com fixture row a qualified lead must attribute.
const EXACT_DELL_CONTENT_URL = "https://www.youtube.com/watch?v=eix1m_BY3Ts";
const EXACT_DELL_EXCERPT =
  "Thanks again to Dell for sponsoring this video. Learn more about XPS 13 here: https://del.ly/Dave2D";

function runReport(gateway: FixtureEvidenceGateway) {
  return runAgenticReport(
    { channel: "@UrAvgConsumer" },
    gateway,
    new FixtureResearchPlanner()
  );
}

describe("verified evidence integrity", () => {
  it("fails closed when only a same-domain peer video and date remain without attributable evidence", async () => {
    const gateway = new DifferentDaveEvidenceGateway(root, "replace");
    const { report } = await runReport(gateway);

    expect(report.leads).toEqual([]);
  });

  it("never substitutes a different same-domain row for the exact peer evidence", async () => {
    const gateway = new DifferentDaveEvidenceGateway(root, "prepend");
    const { report } = await runReport(gateway);

    expect(report.leads).toHaveLength(1);
    expect(report.leads[0]).toMatchObject({
      peer: "Dave2D",
      peerObservedPlacements: 1,
      peerFirstObservedDate: "2026-06-16",
      peerDaysSinceLatest: 33
    });
    expect(report.leads[0].peerEvidence).toMatchObject({
      contentUrl: EXACT_DELL_CONTENT_URL,
      publishedDate: "2026-06-16",
      excerpt: EXACT_DELL_EXCERPT
    });
  });

  it("derives elapsed days from the as-of date and exact evidence dates", async () => {
    const gateway = new MisleadingLedgerDaysGateway(root);
    const { report } = await runReport(gateway);

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

    // "replace": only a video URL and date remain — no excerpt, source, or
    // confidence — so the domain match alone must never become a lead.
    // "prepend": a fully evidenced same-domain decoy competes with the exact row.
    const different =
      this.mutation === "replace"
        ? {
            ...exact,
            totalAdsFound: 99,
            publishedDate: "2026-07-10",
            contentUrl:
              "https://www.youtube.com/watch?v=different-unverified-dell-video",
            evidenceSource: null,
            excerpt: null,
            evidenceConfidence: null
          }
        : {
            ...exact,
            totalAdsFound: 99,
            publishedDate: "2026-06-01",
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

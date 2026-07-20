import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertVerificationLedgerMatchesPilotConfig,
  CreatorBatchResponseWireSchema,
  PilotConfigSchema,
  SimilarCreatorsResponseWireSchema,
  VerificationLedgerSchema,
  SponsorsPageWireSchema
} from "@/src/radar/adapters/upriver/contracts";
import {
  inferSponsorsCoverage,
  normalizeCreatorBatch,
  normalizeSponsorsPage
} from "@/src/radar/adapters/upriver/normalize";
import { parseCreditSnapshot } from "@/src/radar/adapters/upriver/usage";
import { selectRequestedYouTubeChannel } from "@/src/radar/domain/youtube";

const root = process.cwd();

describe("captured Upriver contracts", () => {
  it("parses the 89-row target response without inventing optional domains", async () => {
    const wire = SponsorsPageWireSchema.parse(
      await json(
        "experiments/tech-product-reviewers-2026-07-19/raw/target-uravgconsumer-sponsors-365.json"
      )
    );
    const normalized = normalizeSponsorsPage(wire);

    expect(normalized).toHaveLength(89);
    expect(
      normalized.filter((row) => row.normalizedDomain === null)
    ).toHaveLength(40);
    expect(
      normalized.filter((row) => row.normalizedDomain !== null)
    ).toHaveLength(49);
    expect(
      normalized.some((row) => row.evidenceConfidence === 0)
    ).toBe(true);
    expect(
      normalized.find((row) => row.evidenceConfidence === 0)?.warnings
    ).toContain("zero_confidence");
  });

  it("treats HTTP-200 empty data as unknown coverage even when tracking says active", async () => {
    const wire = SponsorsPageWireSchema.parse(
      await json("spike-results/raw/placements-dwarkesh-diagnostic.json")
    );
    expect(wire.results).toEqual([]);
    expect(wire.tracking_status?.status).toBe("active");
    expect(inferSponsorsCoverage(wire)).toBe("unknown");
  });

  it("preserves evidence fields and reports non-explicit placement warnings", async () => {
    const wire = SponsorsPageWireSchema.parse(
      await json("spike-results/raw/sponsors-dwarkesh-canonical.json")
    );
    const normalized = normalizeSponsorsPage(wire);
    const crusoe = normalized.find((row) => row.sponsorName === "Crusoe");

    expect(crusoe).toMatchObject({
      provider: "upriver",
      sourceEndpoint: "sponsors",
      normalizedDomain: "crusoe.ai",
      evidenceSource: expect.any(String),
      contentUrl: expect.stringContaining("youtube.com")
    });
  });

  it("parses nullable or incomplete evidence without rejecting the paid page", () => {
    const wire = SponsorsPageWireSchema.parse({
      results: [
        sponsorWireRow("Null evidence", null),
        sponsorWireRow("Incomplete evidence", {
          source: null,
          excerpt: " ",
          confidence: null
        })
      ],
      total_count: 2,
      has_more: false
    });
    const normalized = normalizeSponsorsPage(wire);

    expect(normalized).toHaveLength(2);
    expect(normalized).toEqual([
      expect.objectContaining({
        sponsorName: "Null evidence",
        evidenceSource: null,
        excerpt: null,
        evidenceConfidence: null,
        warnings: expect.arrayContaining(["missing_evidence"])
      }),
      expect.objectContaining({
        sponsorName: "Incomplete evidence",
        evidenceSource: null,
        excerpt: null,
        evidenceConfidence: null,
        warnings: expect.arrayContaining(["missing_evidence"])
      })
    ]);
  });

  it("selects the exact requested channel from multi-channel creator results", async () => {
    const wire = CreatorBatchResponseWireSchema.parse(
      await json(
        "experiments/tech-product-reviewers-reach-matched-2026-07-19/raw/creator-profiles.json"
      )
    );
    const creators = normalizeCreatorBatch(wire);
    const sarah = creators.find(
      (creator) =>
        creator.requestedUrl === "https://www.youtube.com/@TheSarahGrace"
    );
    expect(sarah).toBeDefined();

    const selected = selectRequestedYouTubeChannel(
      sarah?.channels ?? [],
      "@TheSarahGrace"
    );
    expect(selected.displayName).toBe("SarahGrace");
    expect(selected.url).not.toContain("vlogs");
  });

  it("derives credit usage while stripping personal account fields", async () => {
    const usage = await json(
      "tests/fixtures/provider/upriver-usage-sanitized.json"
    );
    const snapshot = parseCreditSnapshot(usage, "7d");

    expect(snapshot).toMatchObject({
      range: "7d",
      reportedUsage: 0,
      balance: 10000,
      derivedUsage: 103,
      countersConsistent: false
    });
    expect(snapshot.rates.sponsors_search_per_sponsor).toBe(5);
    expect(snapshot).not.toHaveProperty("name");
    expect(snapshot).not.toHaveProperty("email");
  });

  it("rejects malformed provider dates at the adapter boundary", () => {
    expect(() =>
      SponsorsPageWireSchema.parse({
        results: [
          {
            partner_name: "Brand",
            total_ads_found: 1,
            most_recent_ad: {
              publication_name: "Creator",
              publication_url: "https://youtube.com/@creator",
              publication_categories: [],
              publication_platform: "youtube",
              content_url: "https://youtube.com/watch?v=1",
              sponsor_type: "explicit_ad",
              published_date: "2026-02-30"
            }
          }
        ],
        total_count: 1,
        has_more: false
      })
    ).toThrow();
  });

  it("validates the complete similar-creators beta response boundary", () => {
    const response = SimilarCreatorsResponseWireSchema.parse({
      anchor: {
        scope: "channel",
        requested_creator_id: null,
        creator_id: "anchor-creator",
        requested_channel_url:
          "https://www.youtube.com/@dwarkeshPatel",
        channel_url: "https://www.youtube.com/@dwarkeshPatel"
      },
      ranking_version: "creator-peer-2026-07-13.7",
      results: [
        {
          creator_id: "peer-creator",
          name: "Acquired",
          channel_count: 1,
          channels: [
            {
              platform: "youtube",
              url: "https://www.youtube.com/@AcquiredFM",
              handle: "@AcquiredFM",
              subscriber_count: 782_000
            }
          ],
          similarity: {
            reasons: [
              {
                code: "shared_subject",
                values: ["technology", "business"]
              }
            ]
          },
          labels: ["Technology", "Business"]
        }
      ],
      beta:
        "Beta: this endpoint is unlisted and its response shape may change."
    });

    expect(response.anchor.creator_id).toBe("anchor-creator");
    expect(response.results[0]).toMatchObject({
      creator_id: "peer-creator",
      channels: [
        expect.objectContaining({
          subscriber_count: 782_000
        })
      ],
      similarity: {
        reasons: [
          {
            code: "shared_subject",
            values: ["technology", "business"]
          }
        ]
      },
      labels: ["Technology", "Business"]
    });
  });

  it.each([
    ["anchor", { ranking_version: "v1", results: [], beta: "Beta" }],
    [
      "ranking version",
      {
        anchor: {
          scope: "channel",
          creator_id: "anchor",
          requested_channel_url: "https://www.youtube.com/@anchor",
          channel_url: "https://www.youtube.com/@anchor"
        },
        results: [],
        beta: "Beta"
      }
    ],
    [
      "channel anchor scope",
      {
        anchor: {
          creator_id: "anchor",
          requested_channel_url: "https://www.youtube.com/@anchor",
          channel_url: "https://www.youtube.com/@anchor"
        },
        ranking_version: "v1",
        results: []
      }
    ],
    [
      "requested channel URL",
      {
        anchor: {
          scope: "channel",
          creator_id: "anchor",
          channel_url: "https://www.youtube.com/@anchor"
        },
        ranking_version: "v1",
        results: []
      }
    ],
    [
      "positive channel count",
      {
        anchor: {
          scope: "channel",
          creator_id: "anchor",
          requested_channel_url: "https://www.youtube.com/@anchor",
          channel_url: "https://www.youtube.com/@anchor"
        },
        ranking_version: "v1",
        results: [
          {
            creator_id: "peer",
            name: "Peer",
            channel_count: 0,
            channels: [],
            similarity: { reasons: [] },
            labels: []
          }
        ],
        beta: "Beta"
      }
    ],
    [
      "similarity reasons",
      {
        anchor: {
          scope: "channel",
          creator_id: "anchor",
          requested_channel_url: "https://www.youtube.com/@anchor",
          channel_url: "https://www.youtube.com/@anchor"
        },
        ranking_version: "v1",
        results: [
          {
            creator_id: "peer",
            name: "Peer",
            channel_count: 1,
            channels: [
              {
                platform: "youtube",
                url: "https://www.youtube.com/@peer",
                handle: "@peer",
                subscriber_count: 100
              }
            ],
            labels: []
          }
        ],
        beta: "Beta"
      }
    ],
    [
      "nonempty similarity reasons",
      {
        anchor: {
          scope: "channel",
          creator_id: "anchor",
          requested_channel_url: "https://www.youtube.com/@anchor",
          channel_url: "https://www.youtube.com/@anchor"
        },
        ranking_version: "v1",
        results: [
          {
            creator_id: "peer",
            name: "Peer",
            channel_count: 1,
            channels: [
              {
                platform: "youtube",
                url: "https://www.youtube.com/@peer",
                handle: "@peer",
                subscriber_count: 100
              }
            ],
            similarity: { reasons: [] },
            labels: []
          }
        ],
        beta: "Beta"
      }
    ],
    [
      "channel platform",
      {
        anchor: {
          scope: "channel",
          creator_id: "anchor",
          requested_channel_url: "https://www.youtube.com/@anchor",
          channel_url: "https://www.youtube.com/@anchor"
        },
        ranking_version: "v1",
        results: [
          {
            creator_id: "peer",
            name: "Peer",
            channel_count: 1,
            channels: [
              {
                url: "https://www.youtube.com/@peer",
                subscriber_count: 100
              }
            ],
            similarity: {
              reasons: [{ code: "shared_topic", values: [] }]
            }
          }
        ]
      }
    ]
  ])("rejects a similar-creators response missing %s", (_field, input) => {
    expect(() => SimilarCreatorsResponseWireSchema.parse(input)).toThrow();
  });

  it("accepts optional beta, labels, handle, and subscriber count fields", () => {
    const response = SimilarCreatorsResponseWireSchema.parse({
      anchor: {
        scope: "channel",
        creator_id: "anchor",
        requested_channel_url: "https://www.youtube.com/@anchor",
        channel_url: "https://www.youtube.com/@anchor"
      },
      ranking_version: "v1",
      results: [
        {
          creator_id: "peer",
          name: "Peer",
          channel_count: 1,
          channels: [
            {
              platform: "youtube",
              url: "https://www.youtube.com/@peer",
              handle: null,
              subscriber_count: null
            }
          ],
          similarity: {
            reasons: [{ code: "shared_topic", values: [] }]
          }
        }
      ]
    });

    expect(response.beta).toBeUndefined();
    expect(response.results[0]?.labels).toEqual([]);
    expect(response.results[0]?.channels[0]).toMatchObject({
      handle: null,
      subscriber_count: null
    });
  });

  it("binds the manual verification ledger to the configured pilot", async () => {
    const config = PilotConfigSchema.parse(
      await json(
        "experiments/tech-product-reviewers-reach-matched-2026-07-19/config.json"
      )
    );
    const ledger = VerificationLedgerSchema.parse(
      await json(
        "experiments/tech-product-reviewers-reach-matched-2026-07-19/verification.json"
      )
    );

    expect(assertVerificationLedgerMatchesPilotConfig(ledger, config)).toBe(
      ledger
    );

    const wrongWindow = structuredClone(ledger);
    wrongWindow.scope.peer_window.since = "2026-04-21";
    expect(() =>
      assertVerificationLedgerMatchesPilotConfig(wrongWindow, config)
    ).toThrow(/does not match the configured pilot/);

    const wrongCohort = structuredClone(ledger);
    wrongCohort.peer_inventory[0].channel = "UnreviewedCreator";
    expect(() =>
      assertVerificationLedgerMatchesPilotConfig(wrongCohort, config)
    ).toThrow(/does not match the configured pilot/);
  });
});

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(root, relativePath), "utf8")
  ) as unknown;
}

function sponsorWireRow(
  partnerName: string,
  evidence: unknown
): Record<string, unknown> {
  return {
    partner_name: partnerName,
    sponsor_domain: "example.com",
    total_ads_found: 1,
    most_recent_ad: {
      publication_name: "Creator",
      publication_url: "https://www.youtube.com/@creator",
      publication_categories: [],
      publication_platform: "youtube",
      content_url: "https://www.youtube.com/watch?v=example",
      sponsor_type: "explicit_ad",
      published_date: "2026-07-01",
      evidence
    }
  };
}

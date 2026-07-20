import { describe, expect, it } from "vitest";
import {
  LiveUpriverGateway,
  UpriverCreditPreflightError
} from "@/src/radar/adapters/upriver/live-evidence-gateway";
import {
  UpriverHttpClient,
  type UpriverFetch,
  type UpriverLifecycleEvent
} from "@/src/radar/adapters/upriver/http-client";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const TARGET_URL = "https://www.youtube.com/@dwarkeshPatel";
const TARGET_CHANNEL_ID = "UCTarget123";
const TARGET_SUBSCRIBERS = 1_000_000;

describe("dynamic live Upriver evidence gateway", () => {
  it("resolves an arbitrary exact channel and creates rolling research windows", async () => {
    const api = mockApi();
    const lifecycle: UpriverLifecycleEvent[] = [];
    const gateway = createGateway(api.fetch, {
      observer: (event) => lifecycle.push(event)
    });

    const resolved = await gateway.resolveTarget("@dwarkeshPatel");

    expect(resolved).toEqual({
      target: {
        name: "Dwarkesh Patel",
        url: TARGET_URL,
        subscriberCount: TARGET_SUBSCRIBERS
      },
      identity: {
        verificationBasis: "channel_id",
        channelId: TARGET_CHANNEL_ID,
        handle: "dwarkeshPatel",
        canonicalUrl: TARGET_URL,
        key: `channel:${TARGET_CHANNEL_ID}`
      },
      config: expect.objectContaining({
        as_of: "2026-07-20",
        target_window: {
          since: "2025-07-20",
          until: "2026-07-20"
        },
        stale_cutoff_exclusive: "2026-04-21",
        peer_window: {
          since: "2026-04-21",
          until: "2026-07-20"
        },
        peers: [],
        sponsor_types: ["explicit_ad"]
      })
    });
    expect(api.calls).toEqual([
      expect.objectContaining({
        method: "POST",
        pathname: "/v1/creators/batch",
        body: { urls: [TARGET_URL] }
      })
    ]);
    expect(
      lifecycle
        .filter((event) => event.phase === "started")
        .map((event) => event.audit)
    ).toEqual([
      expect.objectContaining({
        operation: "live.resolve_target",
        estimatedCredits: 1
      })
    ]);
    expect(gateway.creditSnapshot()).toMatchObject({
      resultBasedCredits: 1,
      reservedCredits: 0
    });
  });

  it.each([
    {
      name: "empty result",
      expectedCode: "target_not_verified",
      response: {
        results: [],
        successful_count: 0,
        failed_count: 1
      }
    },
    {
      name: "partial failure counters",
      expectedCode: "target_not_verified",
      response: {
        results: [targetProfile()],
        successful_count: 0,
        failed_count: 1
      }
    },
    {
      name: "result error",
      expectedCode: "target_not_verified",
      response: {
        results: [{ ...targetProfile(), error: "creator unavailable" }],
        successful_count: 1,
        failed_count: 0
      }
    },
    {
      name: "multiple creator records",
      expectedCode: "target_identity_ambiguous",
      response: {
        results: [targetProfile(), targetProfile()],
        successful_count: 2,
        failed_count: 0
      }
    }
  ])("fails closed for a target $name", async ({
    response,
    expectedCode
  }) => {
    const api = mockApi({ targetResponse: response });
    const lifecycle: UpriverLifecycleEvent[] = [];
    const gateway = createGateway(api.fetch, {
      observer: (event) => lifecycle.push(event)
    });

    await expect(
      gateway.resolveTarget("@dwarkeshPatel")
    ).rejects.toMatchObject({
      code: expectedCode
    });
    expect(api.calls).toHaveLength(1);
    expect(
      lifecycle.find((event) => event.phase === "completed")
    ).toMatchObject({
      phase: "completed",
      usage: {
        rows: response.results.length,
        resultBasedCredits: response.results.length
      }
    });
  });

  it("classifies a metered target with no positive subscriber count as unverified", async () => {
    const api = mockApi({
      targetResponse: {
        results: [targetProfile({ subscriberCount: 0 })],
        successful_count: 1,
        failed_count: 0
      }
    });
    const lifecycle: UpriverLifecycleEvent[] = [];
    const gateway = createGateway(api.fetch, {
      observer: (event) => lifecycle.push(event)
    });

    await expect(
      gateway.resolveTarget("@dwarkeshPatel")
    ).rejects.toMatchObject({
      code: "target_not_verified"
    });
    expect(api.calls).toHaveLength(1);
    expect(
      lifecycle.find((event) => event.phase === "completed")
    ).toMatchObject({
      usage: {
        rows: 1,
        resultBasedCredits: 1
      }
    });
  });

  it("rejects a provider response for a different exact target", async () => {
    const mismatched = targetProfile({
      requestedUrl: "https://www.youtube.com/@DifferentCreator",
      channelUrl: "https://www.youtube.com/@DifferentCreator",
      handle: "@DifferentCreator",
      name: "Different Creator"
    });
    const api = mockApi({
      targetResponse: {
        results: [mismatched],
        successful_count: 1,
        failed_count: 0
      }
    });
    const gateway = createGateway(api.fetch);

    await expect(gateway.resolveTarget("@dwarkeshPatel")).rejects.toThrow(
      /exact requested.*channel/
    );
    expect(api.calls).toHaveLength(1);
  });

  it("rejects conflicting requestedUrl metadata even when the channel matches", async () => {
    const api = mockApi({
      targetResponse: {
        results: [
          targetProfile({
            requestedUrl: "https://www.youtube.com/@DifferentCreator"
          })
        ],
        successful_count: 1,
        failed_count: 0
      }
    });
    const gateway = createGateway(api.fetch);

    await expect(
      gateway.resolveTarget("@dwarkeshPatel")
    ).rejects.toMatchObject({
      code: "target_identity_mismatch"
    });
    expect(api.calls).toHaveLength(1);
  });

  it("resolves a /channel/{id} request against the returned platform_id", async () => {
    const channelIdUrl =
      "https://www.youtube.com/channel/UCExactTarget123";
    const api = mockApi({
      targetResponse: {
        results: [
          targetProfile({
            // Upriver may canonicalize the request URL to the @handle even
            // though the exact platform_id still binds the requested channel.
            requestedUrl: TARGET_URL,
            channelUrl: TARGET_URL,
            platformId: "UCExactTarget123"
          })
        ],
        successful_count: 1,
        failed_count: 0
      }
    });
    const gateway = createGateway(api.fetch);

    const resolved = await gateway.resolveTarget(channelIdUrl);

    expect(resolved.target.url).toBe(TARGET_URL);
    expect(api.calls[0]?.body).toEqual({ urls: [channelIdUrl] });
  });

  it.each([
    {
      input: "youtube.com/c/LegacyDwarkesh",
      lookupUrl: "https://www.youtube.com/c/LegacyDwarkesh",
      responseUrl: TARGET_URL
    },
    {
      input: "/user/LegacyDwarkesh",
      lookupUrl: "https://www.youtube.com/user/LegacyDwarkesh",
      responseUrl: "https://www.youtube.com/user/LegacyDwarkesh"
    }
  ])(
    "resolves legacy input $input without guessing its slug",
    async ({ input, lookupUrl, responseUrl }) => {
      const api = mockApi({
        targetResponse: {
          results: [
            targetProfile({
              requestedUrl: responseUrl
            })
          ],
          successful_count: 1,
          failed_count: 0
        }
      });
      const gateway = createGateway(api.fetch);

      const resolved = await gateway.resolveTarget(input);

      expect(api.calls).toHaveLength(1);
      expect(api.calls[0]?.body).toEqual({ urls: [lookupUrl] });
      expect(resolved.identity).toMatchObject({
        verificationBasis: "channel_id",
        channelId: TARGET_CHANNEL_ID,
        handle: "dwarkeshPatel"
      });
      expect(resolved.target.url).toBe(TARGET_URL);
    }
  );

  it("stops after one batch call when a legacy mapping has no ID proof", async () => {
    const legacyUrl = "https://www.youtube.com/c/LegacyDwarkesh";
    const api = mockApi({
      targetResponse: {
        results: [
          targetProfile({
            requestedUrl: legacyUrl,
            platformId: null
          })
        ],
        successful_count: 1,
        failed_count: 0
      }
    });
    const gateway = createGateway(api.fetch);

    await expect(
      gateway.resolveTarget("/c/LegacyDwarkesh")
    ).rejects.toMatchObject({
      code: "target_not_verified"
    });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.pathname).toBe("/v1/creators/batch");
  });

  it("deduplicates consistent returned channels with the same ID", async () => {
    const api = mockApi({
      targetResponse: {
        results: [
          {
            ...targetProfile(),
            channels: [
              targetChannel(),
              targetChannel({
                channelUrl: `https://www.youtube.com/channel/${TARGET_CHANNEL_ID}`
              })
            ]
          }
        ],
        successful_count: 1,
        failed_count: 0
      }
    });
    const gateway = createGateway(api.fetch);

    const resolved = await gateway.resolveTarget("@dwarkeshPatel");

    expect(resolved.identity.channelId).toBe(TARGET_CHANNEL_ID);
    expect(resolved.target.url).toBe(TARGET_URL);
    expect(api.calls).toHaveLength(1);
  });

  it("rejects different IDs claiming the requested handle", async () => {
    const api = mockApi({
      targetResponse: {
        results: [
          {
            ...targetProfile(),
            channels: [
              targetChannel(),
              targetChannel({ platformId: "UCConflicting123" })
            ]
          }
        ],
        successful_count: 1,
        failed_count: 0
      }
    });
    const gateway = createGateway(api.fetch);

    await expect(
      gateway.resolveTarget("@dwarkeshPatel")
    ).rejects.toMatchObject({
      code: "target_identity_ambiguous"
    });
    expect(api.calls).toHaveLength(1);
  });

  it("discovers and deterministically selects at most three dynamic peers", async () => {
    const results = [
      similarResult("creator-a", "Creator A", "@creatorA", 760_000),
      similarResult("creator-b", "Creator B", "@creatorB", 980_000),
      similarResult("creator-c", "Creator C", "@creatorC", 1_240_000),
      similarResult("creator-d", "Creator D", "@creatorD", 1_100_000)
    ];
    const api = mockApi({ similarResults: results });
    const lifecycle: UpriverLifecycleEvent[] = [];
    const gateway = createGateway(api.fetch, {
      observer: (event) => lifecycle.push(event)
    });
    const resolved = await gateway.resolveTarget("@dwarkeshPatel");

    const peers = await gateway.listLockedPeers(
      resolved.target.url,
      resolved.target.subscriberCount
    );

    expect(peers).toEqual([
      {
        name: "Creator A",
        url: "https://www.youtube.com/@creatorA",
        subscriberCount: 760_000,
        creatorId: "creator-a"
      },
      {
        name: "Creator B",
        url: "https://www.youtube.com/@creatorB",
        subscriberCount: 980_000,
        creatorId: "creator-b"
      },
      {
        name: "Creator C",
        url: "https://www.youtube.com/@creatorC",
        subscriberCount: 1_240_000,
        creatorId: "creator-c"
      }
    ]);
    expect(api.calls[1]).toEqual({
      method: "POST",
      pathname: "/v1/creators/similar",
      query: "",
      body: {
        channel_url: TARGET_URL,
        limit: 10,
        platforms: ["youtube"],
        min_followers: 750_000,
        max_followers: 1_250_000
      }
    });
    expect(
      lifecycle.find(
        (event) =>
          event.phase === "completed" &&
          event.audit?.operation === "live.list_locked_peers"
      )
    ).toMatchObject({
      usage: {
        rows: 4,
        resultBasedCredits: 4
      }
    });
    expect(gateway.creditSnapshot()).toMatchObject({
      resultBasedCredits: 5,
      reservedCredits: 0
    });
  });

  it("filters target echoes, duplicate identities, non-YouTube channels, and reach drift", async () => {
    const results = [
      similarResult("target-creator", "Target Echo", "@dwarkeshPatel", 1_000_000),
      similarResult("creator-a", "Creator A", "@creatorA", 900_000),
      similarResult("creator-a", "Creator A duplicate", "@creatorA2", 950_000),
      similarResult("creator-b", "Duplicate URL", "@creatorA", 900_000),
      similarResult("creator-c", "Too Small", "@tooSmall", 749_999),
      similarResult(
        "creator-d",
        "Not YouTube",
        "@not-youtube",
        1_000_000,
        "https://vimeo.com/not-youtube"
      ),
      similarResult("creator-e", "Creator E", "@creatorE", 1_250_000)
    ];
    const api = mockApi({ similarResults: results });
    const gateway = createGateway(api.fetch);
    const resolved = await gateway.resolveTarget(TARGET_URL);

    const peers = await gateway.listLockedPeers(
      TARGET_URL,
      resolved.target.subscriberCount
    );

    expect(peers).toEqual([
      expect.objectContaining({
        name: "Creator A",
        creatorId: "creator-a",
        subscriberCount: 900_000
      }),
      expect.objectContaining({
        name: "Creator E",
        creatorId: "creator-e",
        subscriberCount: 1_250_000
      })
    ]);
  });

  it("always excludes the response anchor creator when target context came from cache", async () => {
    const api = mockApi({
      similarResults: [
        similarResult(
          "target-creator",
          "Target secondary channel",
          "@targetSecondary",
          900_000
        ),
        similarResult("creator-a", "Creator A", "@creatorA", 950_000)
      ]
    });
    const gateway = createGateway(api.fetch);

    const peers = await gateway.listLockedPeers(
      TARGET_URL,
      TARGET_SUBSCRIBERS
    );

    expect(peers).toEqual([
      expect.objectContaining({
        name: "Creator A",
        creatorId: "creator-a"
      })
    ]);
    expect(api.calls.map((call) => call.pathname)).toEqual([
      "/v1/creators/similar"
    ]);
  });

  it("skips candidates whose qualifying first channel is unusable", async () => {
    const api = mockApi({
      similarResults: [
        {
          ...similarResult(
            "creator-a",
            "Wrong platform",
            "@creatorA",
            900_000
          ),
          channels: [
            {
              platform: "instagram",
              url: "https://www.youtube.com/@creatorA",
              handle: "@creatorA",
              subscriber_count: 900_000
            }
          ]
        },
        {
          ...similarResult(
            "creator-b",
            "Missing count",
            "@creatorB",
            900_000
          ),
          channels: [
            {
              platform: "youtube",
              url: "https://www.youtube.com/@creatorB",
              handle: null,
              subscriber_count: null
            }
          ]
        },
        {
          ...similarResult(
            "creator-c",
            "Unusable first channel",
            "@creatorC",
            900_000
          ),
          channel_count: 2,
          channels: [
            {
              platform: "instagram",
              url: "https://www.youtube.com/@creatorC-alt",
              handle: null,
              subscriber_count: null
            },
            {
              platform: "youtube",
              url: "https://www.youtube.com/@creatorC",
              handle: "@creatorC",
              subscriber_count: 900_000
            }
          ]
        },
        similarResult("creator-d", "Creator D", "@creatorD", 1_100_000)
      ]
    });
    const gateway = createGateway(api.fetch);

    const peers = await gateway.listLockedPeers(
      TARGET_URL,
      TARGET_SUBSCRIBERS
    );

    expect(peers).toEqual([
      expect.objectContaining({
        name: "Creator D",
        subscriberCount: 1_100_000
      })
    ]);
  });

  it("returns an honest empty cohort without a search fallback", async () => {
    const api = mockApi({ similarResults: [] });
    const gateway = createGateway(api.fetch);
    const resolved = await gateway.resolveTarget(TARGET_URL);

    await expect(
      gateway.listLockedPeers(
        resolved.target.url,
        resolved.target.subscriberCount
      )
    ).resolves.toEqual([]);
    expect(api.calls.map((call) => call.pathname)).toEqual([
      "/v1/creators/batch",
      "/v1/creators/similar"
    ]);
    expect(gateway.creditSnapshot()).toMatchObject({
      resultBasedCredits: 1,
      reservedCredits: 0
    });
  });

  it("rejects a changed beta response shape without retry or fallback", async () => {
    const api = mockApi({
      similarResponse: {
        anchor: similarAnchor(),
        ranking_version: "creator-peer-test",
        results: [
          {
            creator_id: "creator-a",
            name: "Creator A",
            channel_count: 1,
            channels: [
              {
                platform: "youtube",
                url: "https://www.youtube.com/@creatorA",
                handle: "@creatorA",
                subscriber_count: 900_000
              }
            ],
            labels: []
          }
        ],
        beta: "Beta response"
      }
    });
    const gateway = createGateway(api.fetch);
    const resolved = await gateway.resolveTarget(TARGET_URL);

    await expect(
      gateway.listLockedPeers(
        resolved.target.url,
        resolved.target.subscriberCount
      )
    ).rejects.toThrow();
    expect(api.calls.map((call) => call.pathname)).toEqual([
      "/v1/creators/batch",
      "/v1/creators/similar"
    ]);
  });

  it("rejects a similar-creators response for another anchor", async () => {
    const api = mockApi({
      similarAnchor: {
        scope: "channel",
        requested_creator_id: null,
        creator_id: "other-anchor",
        requested_channel_url:
          "https://www.youtube.com/@DifferentCreator",
        channel_url: "https://www.youtube.com/@DifferentCreator"
      }
    });
    const gateway = createGateway(api.fetch);
    const resolved = await gateway.resolveTarget(TARGET_URL);

    await expect(
      gateway.listLockedPeers(
        resolved.target.url,
        resolved.target.subscriberCount
      )
    ).rejects.toThrow(/requested anchor/);
  });

  it("rejects an anchor creator-id change after exact target resolution", async () => {
    const api = mockApi({
      similarAnchor: {
        ...similarAnchor(),
        creator_id: "changed-target-creator"
      }
    });
    const gateway = createGateway(api.fetch);
    const resolved = await gateway.resolveTarget(TARGET_URL);

    await expect(
      gateway.listLockedPeers(
        resolved.target.url,
        resolved.target.subscriberCount
      )
    ).rejects.toThrow(/creator identity changed/);
  });

  it("queries arbitrary approved peer URLs with a rolling 90-day window", async () => {
    const peerUrl = "https://www.youtube.com/@AcquiredFM";
    const api = mockApi({
      sponsorPages: new Map([
        [youtubeKey(peerUrl), sponsorPage(peerUrl, "Pilot")]
      ])
    });
    const gateway = createGateway(api.fetch, { maximumCredits: 10 });

    const result = await gateway.listPeerSponsors("@AcquiredFM");

    expect(result.rows).toEqual([
      expect.objectContaining({
        sponsorName: "Pilot",
        publicationUrl: peerUrl,
        normalizedDomain: "pilot.com"
      })
    ]);
    expect(api.calls).toEqual([
      {
        method: "GET",
        pathname: "/v1/sponsors",
        query:
          "?publication_url=https%3A%2F%2Fwww.youtube.com%2F%40AcquiredFM" +
          "&platforms=youtube&sponsor_type=explicit_ad&include_evidence=true" +
          "&since=2026-04-21&until=2026-07-20&limit=2",
        body: null
      }
    ]);
  });

  it("queries arbitrary target URLs with a rolling 365-day window", async () => {
    const api = mockApi({
      sponsorPages: new Map([
        [youtubeKey(TARGET_URL), sponsorPage(TARGET_URL, "Crusoe")]
      ])
    });
    const gateway = createGateway(api.fetch, {
      maximumCredits: 5,
      targetResultCap: 1
    });

    await gateway.listTargetSponsors("@dwarkeshPatel");

    const request = api.calls[0];
    expect(request.pathname).toBe("/v1/sponsors");
    const query = new URLSearchParams(request.query);
    expect(query.get("publication_url")).toBe(TARGET_URL);
    expect(query.get("since")).toBe("2025-07-20");
    expect(query.get("until")).toBe("2026-07-20");
    expect(query.get("sponsor_type")).toBe("explicit_ad");
    expect(query.get("include_evidence")).toBe("true");
  });

  it("preserves incomplete sponsor evidence as an explicitly unusable row", async () => {
    const api = mockApi({
      sponsorPages: new Map([
        [
          youtubeKey(TARGET_URL),
          sponsorPage(TARGET_URL, "Crusoe", { evidence: null })
        ]
      ])
    });
    const gateway = createGateway(api.fetch, {
      maximumCredits: 5,
      targetResultCap: 1
    });

    const result = await gateway.listTargetSponsors(TARGET_URL);

    expect(result.rows).toEqual([
      expect.objectContaining({
        sponsorName: "Crusoe",
        evidenceSource: null,
        excerpt: null,
        evidenceConfidence: null,
        warnings: expect.arrayContaining(["missing_evidence"])
      })
    ]);
  });

  it.each([
    {
      kind: "target",
      url: TARGET_URL,
      publishedDate: "2025-07-19"
    },
    {
      kind: "peer",
      url: "https://www.youtube.com/@AcquiredFM",
      publishedDate: "2026-04-20"
    }
  ] as const)(
    "rejects $kind sponsor evidence outside its requested date window",
    async ({ kind, url, publishedDate }) => {
      const api = mockApi({
        sponsorPages: new Map([
          [
            youtubeKey(url),
            sponsorPage(url, "Outside", { publishedDate })
          ]
        ])
      });
      const gateway = createGateway(api.fetch);

      const request =
        kind === "target"
          ? gateway.listTargetSponsors(url)
          : gateway.listPeerSponsors(url);

      await expect(request).rejects.toThrow(/requested date window/);
      expect(api.calls).toHaveLength(1);
    }
  );

  it("does not expose the fixture verification ledger in live mode", async () => {
    const api = mockApi();
    const gateway = createGateway(api.fetch);

    await expect(gateway.loadVerificationLedger()).rejects.toThrow(
      /does not use a manual verification ledger/
    );
    expect(api.calls).toEqual([]);
  });

  it("requires target context before a paid peer-discovery request", async () => {
    const api = mockApi();
    const gateway = createGateway(api.fetch);

    await expect(
      gateway.listLockedPeers("@dwarkeshPatel")
    ).rejects.toThrow(/Resolve the target/);
    expect(api.calls).toEqual([]);
  });

  it("denies peer discovery at preflight and keeps retries disabled", async () => {
    const api = mockApi();
    const gateway = createGateway(api.fetch, { maximumCredits: 10 });
    const resolved = await gateway.resolveTarget(TARGET_URL);

    await expect(
      gateway.listLockedPeers(
        resolved.target.url,
        resolved.target.subscriberCount
      )
    ).rejects.toBeInstanceOf(UpriverCreditPreflightError);
    expect(api.calls).toHaveLength(1);

    expect(
      () =>
        new LiveUpriverGateway(
          process.cwd(),
          new UpriverHttpClient({
            apiKey: "server-only-test-key",
            fetch: api.fetch
          })
        )
    ).toThrow(/maxRetries: 0/);
  });
});

interface MockCall {
  method: string;
  pathname: string;
  query: string;
  body: unknown;
}

interface MockApiOptions {
  targetResponse?: unknown;
  similarResponse?: unknown;
  similarResults?: unknown[];
  similarAnchor?: unknown;
  sponsorPages?: Map<string, unknown>;
}

function mockApi(options: MockApiOptions = {}): {
  fetch: UpriverFetch;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const fetch: UpriverFetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    calls.push({
      method,
      pathname: url.pathname,
      query: url.search,
      body
    });

    if (url.pathname === "/v1/creators/batch" && method === "POST") {
      return jsonResponse(
        options.targetResponse ?? {
          results: [targetProfile()],
          successful_count: 1,
          failed_count: 0
        }
      );
    }

    if (url.pathname === "/v1/creators/similar" && method === "POST") {
      return jsonResponse(
        options.similarResponse ?? {
          anchor: options.similarAnchor ?? similarAnchor(),
          ranking_version: "creator-peer-test",
          results: options.similarResults ?? [
            similarResult("creator-a", "Creator A", "@creatorA", 900_000)
          ],
          beta: "Beta response shape may change."
        }
      );
    }

    if (url.pathname === "/v1/sponsors" && method === "GET") {
      const publicationUrl = url.searchParams.get("publication_url") ?? "";
      return jsonResponse(
        options.sponsorPages?.get(youtubeKey(publicationUrl)) ?? {
          results: [],
          total_count: 0,
          has_more: false,
          next_cursor: null
        }
      );
    }

    throw new Error(`Unexpected mocked request: ${method} ${url.pathname}`);
  };

  return { fetch, calls };
}

function createGateway(
  fetch: UpriverFetch,
  options: {
    maximumCredits?: number;
    targetResultCap?: number;
    observer?: (event: UpriverLifecycleEvent) => void;
  } = {}
): LiveUpriverGateway {
  return new LiveUpriverGateway(
    process.cwd(),
    new UpriverHttpClient({
      apiKey: "server-only-test-key",
      fetch,
      maxRetries: 0,
      observer: options.observer
    }),
    {
      maximumCredits: options.maximumCredits ?? 200,
      targetResultCap: options.targetResultCap,
      clock: () => NOW
    }
  );
}

function targetProfile(
  options: {
    requestedUrl?: string;
    channelUrl?: string;
    handle?: string;
    name?: string;
    subscriberCount?: number;
    platformId?: string | null;
  } = {}
): Record<string, unknown> {
  const requestedUrl = options.requestedUrl ?? TARGET_URL;
  return {
    url: requestedUrl,
    creator_id: "target-creator",
    error: null,
    channels: [targetChannel(options)],
    associated_creators: [],
    labels: [],
    tags: []
  };
}

function targetChannel(
  options: {
    channelUrl?: string;
    handle?: string;
    name?: string;
    subscriberCount?: number;
    platformId?: string | null;
  } = {}
): Record<string, unknown> {
  return {
    platform: "youtube",
    handle: options.handle ?? "@dwarkeshPatel",
    url: options.channelUrl ?? TARGET_URL,
    display_name: options.name ?? "Dwarkesh Patel",
    platform_id:
      options.platformId === undefined
        ? TARGET_CHANNEL_ID
        : options.platformId,
    subscriber_count:
      options.subscriberCount ?? TARGET_SUBSCRIBERS
  };
}

function similarAnchor(): Record<string, unknown> {
  return {
    scope: "channel",
    requested_creator_id: null,
    creator_id: "target-creator",
    requested_channel_url: TARGET_URL,
    channel_url: TARGET_URL
  };
}

function similarResult(
  creatorId: string,
  name: string,
  handle: string,
  subscriberCount: number,
  channelUrl = `https://www.youtube.com/${handle}`
): Record<string, unknown> {
  return {
    creator_id: creatorId,
    name,
    channel_count: 1,
    channels: [
      {
        platform: "youtube",
        url: channelUrl,
        handle,
        subscriber_count: subscriberCount
      }
    ],
    similarity: {
      reasons: [
        {
          code: "shared_topic",
          values: ["technology"]
        }
      ]
    },
    labels: ["Technology"]
  };
}

function sponsorPage(
  publicationUrl: string,
  sponsorName: string,
  options: {
    publishedDate?: string;
    evidence?: unknown;
  } = {}
): Record<string, unknown> {
  const evidence = Object.prototype.hasOwnProperty.call(options, "evidence")
    ? options.evidence
    : {
        source: "description",
        excerpt: `Sponsored by ${sponsorName}.`,
        confidence: 1
      };
  return {
    results: [
      {
        partner_name: sponsorName,
        sponsor_domain: `${sponsorName.toLowerCase()}.com`,
        sponsor_description: null,
        sponsor_linkedin_url: null,
        total_ads_found: 1,
        most_recent_ad: {
          publication_name: "Creator",
          publication_url: publicationUrl,
          publication_categories: ["Technology"],
          publication_platform: "youtube",
          content_url: "https://www.youtube.com/watch?v=example",
          sponsor_type: "explicit_ad",
          published_date: options.publishedDate ?? "2026-07-01",
          evidence
        }
      }
    ],
    total_count: 1,
    has_more: false,
    next_cursor: null,
    tracking_status: {
      publication_url: publicationUrl,
      channel_name: "Creator",
      status: "active",
      message: "Tracking is active"
    }
  };
}

function youtubeKey(value: string): string {
  const parsed = new URL(value);
  return parsed.pathname.toLowerCase();
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": "mock-provider-request"
    }
  });
}

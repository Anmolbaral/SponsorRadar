import { describe, expect, it } from "vitest";
import {
  parseYouTubeChannelReference,
  parseYouTubeIdentity,
  sameVerifiedYouTubeIdentity,
  selectRequestedYouTubeChannel,
  selectVerifiedYouTubeChannel,
  YouTubeTargetVerificationError,
  type CreatorChannel,
  type YouTubeTargetVerificationCode
} from "@/src/radar/domain/youtube";
import {
  isReachComparable,
  reachRatio
} from "@/src/radar/domain/reach";

const channels: CreatorChannel[] = [
  {
    platform: "youtube",
    handle: "@TheSarahGrace",
    url: "https://www.youtube.com/@TheSarahGrace",
    displayName: "SarahGrace",
    subscriberCount: 3_710_000
  },
  {
    platform: "youtube",
    handle: "@sarahgracevlogs",
    url: "https://www.youtube.com/@sarahgracevlogs",
    displayName: "Sarah Grace Vlogs",
    subscriberCount: 243_000
  },
  {
    platform: "instagram",
    handle: "@itssarahgrace",
    url: "https://instagram.com/itssarahgrace",
    displayName: "Sarah Grace",
    subscriberCount: 270_000
  }
];

describe("YouTube identity", () => {
  it.each([
    [
      "@UrAvgConsumer",
      "handle",
      "handle:uravgconsumer",
      "https://www.youtube.com/@UrAvgConsumer"
    ],
    [
      "UrAvgConsumer",
      "handle",
      "handle:uravgconsumer",
      "https://www.youtube.com/@UrAvgConsumer"
    ],
    [
      "/@UrAvgConsumer",
      "handle",
      "handle:uravgconsumer",
      "https://www.youtube.com/@UrAvgConsumer"
    ],
    [
      "https://www.youtube.com/@UrAvgConsumer?sub_confirmation=1",
      "handle",
      "handle:uravgconsumer",
      "https://www.youtube.com/@UrAvgConsumer"
    ],
    [
      "http://m.youtube.com/@UrAvgConsumer/",
      "handle",
      "handle:uravgconsumer",
      "https://www.youtube.com/@UrAvgConsumer"
    ],
    [
      "youtube.com/@UrAvgConsumer",
      "handle",
      "handle:uravgconsumer",
      "https://www.youtube.com/@UrAvgConsumer"
    ],
    [
      "www.youtube.com/@UrAvgConsumer",
      "handle",
      "handle:uravgconsumer",
      "https://www.youtube.com/@UrAvgConsumer"
    ],
    [
      "//youtube.com/@UrAvgConsumer",
      "handle",
      "handle:uravgconsumer",
      "https://www.youtube.com/@UrAvgConsumer"
    ],
    [
      "https://youtube.com/channel/UC123",
      "channel_id",
      "channel:UC123",
      "https://www.youtube.com/channel/UC123"
    ],
    [
      "/channel/UCAbC_-123",
      "channel_id",
      "channel:UCAbC_-123",
      "https://www.youtube.com/channel/UCAbC_-123"
    ],
    [
      "youtube.com/user/LegacyName",
      "legacy_user",
      "legacy_user:LegacyName",
      "https://www.youtube.com/user/LegacyName"
    ],
    [
      "/c/CustomName",
      "legacy_custom",
      "legacy_custom:CustomName",
      "https://www.youtube.com/c/CustomName"
    ],
    [
      "https://m.youtube.com/c/CustomName?view_as=subscriber",
      "legacy_custom",
      "legacy_custom:CustomName",
      "https://www.youtube.com/c/CustomName"
    ],
    [
      "@तकनीक",
      "handle",
      "handle:तकनीक",
      "https://www.youtube.com/@तकनीक"
    ],
    [
      "https://www.youtube.com/@caf%C3%A9",
      "handle",
      "handle:café",
      "https://www.youtube.com/@café"
    ]
  ])(
    "normalizes %s as an HTTPS channel reference",
    (input, kind, requestKey, lookupUrl) => {
      expect(parseYouTubeChannelReference(input)).toMatchObject({
        kind,
        requestKey,
        lookupUrl,
        key: requestKey,
        canonicalUrl: lookupUrl
      });
    }
  );

  it("normalizes Unicode handles to NFC", () => {
    const reference = parseYouTubeChannelReference("@cafe\u0301");

    expect(reference).toMatchObject({
      kind: "handle",
      handle: "café",
      requestKey: "handle:café",
      lookupUrl: "https://www.youtube.com/@café"
    });
  });

  it("keeps equivalent handle forms together without conflating aliases", () => {
    const handleKeys = [
      "@UrAvgConsumer",
      "uravgconsumer",
      "/@URAVGCONSUMER",
      "youtube.com/@UrAvgConsumer"
    ].map((input) => parseYouTubeChannelReference(input).requestKey);

    expect(new Set(handleKeys)).toEqual(
      new Set(["handle:uravgconsumer"])
    );
    expect(
      parseYouTubeChannelReference("/user/UrAvgConsumer").requestKey
    ).toBe("legacy_user:UrAvgConsumer");
    expect(
      parseYouTubeChannelReference("/c/UrAvgConsumer").requestKey
    ).toBe("legacy_custom:UrAvgConsumer");
  });

  it("preserves case-sensitive channel IDs", () => {
    const upper = parseYouTubeChannelReference("/channel/UCAbC123");
    const lower = parseYouTubeChannelReference("/channel/UCabc123");

    expect(upper.requestKey).toBe("channel:UCAbC123");
    expect(lower.requestKey).toBe("channel:UCabc123");
    expect(upper.requestKey).not.toBe(lower.requestKey);
  });

  it.each([
    "",
    "channel with spaces",
    "https://example.com/@creator",
    "https://youtube.com.evil.test/@creator",
    "https://evil.youtube.com/@creator",
    "https://youtu.be/creator",
    "https://youtube.com",
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "https://youtube.com/watch?v=abc",
    "https://youtube.com/shorts/abc",
    "https://youtube.com/live/abc",
    "https://youtube.com/embed/abc",
    "https://youtube.com/playlist?list=abc",
    "https://youtube.com/@creator/videos",
    "https://youtube.com/channel/UCExact/videos",
    "https://youtube.com/user/LegacyUser/videos",
    "https://youtube.com/c/LegacyName/videos",
    "ftp://youtube.com/@creator",
    "javascript://youtube.com/@creator",
    "https:/youtube.com/@creator",
    "https:///youtube.com/@creator",
    "///youtube.com/@creator",
    "https://youtube.com\\@creator",
    "https://you\ntube.com/@creator",
    "https://youtube.com/@crea\ttor",
    "https://person@youtube.com/@creator",
    "https://youtube.com:8443/@creator",
    "https://youtube.com/%E0%A4%A",
    "https://[",
    "https://youtube.com/./@creator",
    "https://youtube.com/%2e/@creator",
    "https://youtube.com/@creator/..",
    "https://youtube.com/@creator/%2e",
    "https://youtube.com/channel/not%2Fa%2Fchannel",
    "https://youtube.com/@creator%2Fother",
    "https://youtube.com/channel/UCExact%2Fother",
    "/channel/not-a-channel-id",
    "/channel/ucLowercasePrefix",
    "/user/name/extra",
    "/c/name/extra",
    "/c/name%20with%20spaces",
    "/@creator//",
    "not a url with spaces"
  ])("rejects unsafe or non-channel input %s", (input) => {
    expect(() => parseYouTubeChannelReference(input)).toThrow();
  });

  it("still accepts a dotted bare handle that is not a YouTube host", () => {
    expect(parseYouTubeChannelReference("creator.name")).toMatchObject({
      kind: "handle",
      requestKey: "handle:creator.name"
    });
  });

  it("keeps the compatibility parser aligned with the reference parser", () => {
    expect(parseYouTubeIdentity("/c/LegacyName")).toEqual(
      parseYouTubeChannelReference("/c/LegacyName")
    );
  });

  it("selects the exact main channel rather than the first similar channel", () => {
    const selected = selectRequestedYouTubeChannel(
      channels,
      "@TheSarahGrace"
    );
    expect(selected.displayName).toBe("SarahGrace");
    expect(selected.subscriberCount).toBe(3_710_000);
  });

  it("fails when the exact channel is absent or duplicated", () => {
    expect(() =>
      selectRequestedYouTubeChannel(channels, "@missing")
    ).toThrow(/exact requested/);
    expect(() =>
      selectRequestedYouTubeChannel(
        [channels[0], { ...channels[0] }],
        "@TheSarahGrace"
      )
    ).toThrow(/ambiguous/);
  });

  it("binds a /channel/{id} request to a canonical handle using platform_id", () => {
    const selected = selectRequestedYouTubeChannel(
      [
        {
          ...channels[0],
          platformId: "UCExact123"
        }
      ],
      "https://youtube.com/channel/UCExact123"
    );

    expect(selected.url).toBe(
      "https://www.youtube.com/@TheSarahGrace"
    );
  });

  it("does not use a mismatched platform_id to bind a channel", () => {
    expect(() =>
      selectRequestedYouTubeChannel(
        [
          {
            ...channels[0],
            platformId: "UCDifferent"
          }
        ],
        "https://youtube.com/channel/UCExact123"
      )
    ).toThrow(/exact requested/);
  });

  it("fails closed for legacy aliases until provider verification is used", () => {
    expectVerificationError(
      () =>
        selectRequestedYouTubeChannel(channels, "/c/TheSarahGrace"),
      "target_not_verified"
    );
  });
});

describe("verified YouTube channel selection", () => {
  it("compares verified IDs case-sensitively and handle fallback keys exactly", () => {
    const channelIdentity = {
      verificationBasis: "channel_id" as const,
      channelId: "UCExact123",
      handle: "ExactCreator",
      canonicalUrl: "https://www.youtube.com/@ExactCreator",
      key: "channel:UCExact123"
    };
    const handleIdentity = {
      verificationBasis: "exact_unique_handle" as const,
      channelId: null,
      handle: "ExactCreator",
      canonicalUrl: "https://www.youtube.com/@ExactCreator",
      key: "handle:exactcreator"
    };

    expect(
      sameVerifiedYouTubeIdentity(channelIdentity, {
        ...channelIdentity
      })
    ).toBe(true);
    expect(
      sameVerifiedYouTubeIdentity(channelIdentity, {
        ...channelIdentity,
        channelId: "ucexact123",
        key: "channel:ucexact123"
      })
    ).toBe(false);
    expect(
      sameVerifiedYouTubeIdentity(handleIdentity, {
        ...handleIdentity
      })
    ).toBe(true);
    expect(
      sameVerifiedYouTubeIdentity(handleIdentity, {
        ...handleIdentity,
        handle: "OtherCreator",
        canonicalUrl: "https://www.youtube.com/@OtherCreator",
        key: "handle:othercreator"
      })
    ).toBe(false);
    expect(
      sameVerifiedYouTubeIdentity(channelIdentity, handleIdentity)
    ).toBe(false);
  });

  it("prefers an ID-backed exact handle match", () => {
    const selected = selectVerifiedYouTubeChannel(
      [
        selectorChannel({
          platformId: "UCExact123"
        })
      ],
      "@ExactCreator"
    );

    expect(selected.identity).toEqual({
      verificationBasis: "channel_id",
      channelId: "UCExact123",
      handle: "ExactCreator",
      canonicalUrl: "https://www.youtube.com/@ExactCreator",
      key: "channel:UCExact123"
    });
  });

  it("uses an exact handle field with a canonical /channel/ID URL", () => {
    const selected = selectVerifiedYouTubeChannel(
      [
        selectorChannel({
          url: "https://www.youtube.com/channel/UCExact123",
          platformId: "UCExact123"
        })
      ],
      "@ExactCreator"
    );

    expect(selected.identity).toMatchObject({
      verificationBasis: "channel_id",
      channelId: "UCExact123",
      handle: "ExactCreator"
    });
  });

  it("allows one explicit exact-handle fallback only when URL and handle agree", () => {
    const selected = selectVerifiedYouTubeChannel(
      [selectorChannel()],
      "@exactcreator"
    );

    expect(selected.identity).toEqual({
      verificationBasis: "exact_unique_handle",
      channelId: null,
      handle: "ExactCreator",
      canonicalUrl: "https://www.youtube.com/@ExactCreator",
      key: "handle:exactcreator"
    });

    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [selectorChannel({ handle: "" })],
          "@ExactCreator"
        ),
      "target_not_verified"
    );
  });

  it("deduplicates consistent records with the same channel ID", () => {
    const selected = selectVerifiedYouTubeChannel(
      [
        selectorChannel({ platformId: "UCSame123" }),
        selectorChannel({
          platformId: "UCSame123",
          url: "https://www.youtube.com/channel/UCSame123"
        })
      ],
      "@ExactCreator"
    );

    expect(selected.identity).toMatchObject({
      verificationBasis: "channel_id",
      channelId: "UCSame123",
      handle: "ExactCreator"
    });
    expect(selected.channel.url).toBe(
      "https://www.youtube.com/@ExactCreator"
    );
  });

  it("rejects exact-handle records backed by different IDs", () => {
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [
            selectorChannel({ platformId: "UCFirst123" }),
            selectorChannel({ platformId: "UCSecond123" })
          ],
          "@ExactCreator"
        ),
      "target_identity_ambiguous"
    );
  });

  it("rejects conflicting material data on same-ID duplicates", () => {
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [
            selectorChannel({ platformId: "UCSame123" }),
            selectorChannel({
              platformId: "UCSame123",
              subscriberCount: 999
            })
          ],
          "@ExactCreator"
        ),
      "target_identity_mismatch"
    );

    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [
            selectorChannel({ platformId: "UCSame123" }),
            selectorChannel({
              handle: "@ConflictingCreator",
              url: "https://www.youtube.com/@ConflictingCreator",
              displayName: "Exact creator",
              platformId: "UCSame123"
            })
          ],
          "@ExactCreator"
        ),
      "target_identity_mismatch"
    );
  });

  it("binds direct channel-ID references case-sensitively", () => {
    const selected = selectVerifiedYouTubeChannel(
      [
        selectorChannel({ platformId: "UCAbC123" })
      ],
      "/channel/UCAbC123"
    );

    expect(selected.identity.channelId).toBe("UCAbC123");
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [selectorChannel({ platformId: "UCabc123" })],
          "/channel/UCAbC123"
        ),
      "target_identity_mismatch"
    );
  });

  it("selects an exact direct ID among unrelated associated channels", () => {
    const selected = selectVerifiedYouTubeChannel(
      [
        selectorChannel({ platformId: "UCExact123" }),
        selectorChannel({
          handle: "@OtherCreator",
          url: "https://www.youtube.com/@OtherCreator",
          displayName: "Other creator",
          platformId: "UCDifferent123"
        })
      ],
      "/channel/UCExact123"
    );

    expect(selected.identity.channelId).toBe("UCExact123");
  });

  it("rejects different IDs claiming the same direct-ID handle", () => {
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [
            selectorChannel({ platformId: "UCExact123" }),
            selectorChannel({ platformId: "UCDifferent123" })
          ],
          "/channel/UCExact123"
        ),
      "target_identity_ambiguous"
    );
  });

  it("accepts an exact channel-ID URL without a redundant platform ID", () => {
    const selected = selectVerifiedYouTubeChannel(
      [
        selectorChannel({
          url: "https://www.youtube.com/channel/UCExact123",
          platformId: null
        })
      ],
      "/channel/UCExact123"
    );

    expect(selected.identity).toMatchObject({
      verificationBasis: "channel_id",
      channelId: "UCExact123"
    });
  });

  it("rejects contradictory URL and platform channel IDs", () => {
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [
            selectorChannel({
              url: "https://www.youtube.com/channel/UCUrl123",
              platformId: "UCField123"
            })
          ],
          "/channel/UCUrl123"
        ),
      "target_identity_mismatch"
    );
  });

  it.each([
    "UCExact123?ignored=true",
    "UCExact123#ignored",
    "UCExact123/other",
    "UCExact123%2Fother",
    "UCExact123\nother"
  ])("rejects malformed raw platform ID proof %s", (platformId) => {
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [selectorChannel({ platformId })],
          "@ExactCreator"
        ),
      "target_identity_mismatch"
    );
  });

  it("never matches a display name", () => {
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [
            selectorChannel({
              handle: "@DifferentCreator",
              url: "https://www.youtube.com/@DifferentCreator",
              displayName: "ExactCreator"
            })
          ],
          "@ExactCreator"
        ),
      "target_not_verified"
    );
  });

  it("ignores non-YouTube and invalid channel URL candidates", () => {
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [
            selectorChannel({
              platform: "instagram",
              url: "https://instagram.com/ExactCreator"
            }),
            selectorChannel({
              url: "https://youtube.com/watch?v=abc"
            }),
            selectorChannel({
              url: "@ExactCreator",
              platformId: "UCUnsafeBareUrl"
            })
          ],
          "@ExactCreator"
        ),
      "target_not_verified"
    );
  });

  it("resolves a legacy alias when Upriver canonicalizes it to a handle", () => {
    const selected = selectVerifiedYouTubeChannel(
      [selectorChannel({ platformId: "UCLegacy123" })],
      "/c/OldCreatorName",
      "https://www.youtube.com/@ExactCreator"
    );

    expect(selected.identity).toMatchObject({
      verificationBasis: "channel_id",
      channelId: "UCLegacy123",
      handle: "ExactCreator"
    });
  });

  it("resolves an exact legacy echo only through one unique channel ID", () => {
    const selected = selectVerifiedYouTubeChannel(
      [
        selectorChannel({ platformId: "UCLegacy123" }),
        selectorChannel({
          platformId: "UCLegacy123",
          url: "https://www.youtube.com/channel/UCLegacy123"
        })
      ],
      "/user/OldCreatorName",
      "https://youtube.com/user/OldCreatorName"
    );

    expect(selected.identity.channelId).toBe("UCLegacy123");
  });

  it("rejects ambiguous or unverified legacy mappings", () => {
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [
            selectorChannel({ platformId: "UCFirst123" }),
            selectorChannel({
              handle: "@OtherCreator",
              url: "https://www.youtube.com/@OtherCreator",
              displayName: "Other creator",
              platformId: "UCSecond123"
            })
          ],
          "/c/OldCreatorName",
          "https://youtube.com/c/OldCreatorName"
        ),
      "target_identity_ambiguous"
    );
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [selectorChannel()],
          "/c/OldCreatorName",
          "https://youtube.com/c/OldCreatorName"
        ),
      "target_not_verified"
    );
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [selectorChannel({ platformId: "UCLegacy123" })],
          "/c/OldCreatorName"
        ),
      "target_not_verified"
    );
  });

  it("uses a canonicalized legacy ID among unrelated associated channels", () => {
    const selected = selectVerifiedYouTubeChannel(
      [
        selectorChannel({ platformId: "UCLegacy123" }),
        selectorChannel({
          handle: "@OtherCreator",
          url: "https://www.youtube.com/@OtherCreator",
          displayName: "Other creator",
          platformId: "UCOther123"
        })
      ],
      "/user/OldCreatorName",
      "https://youtube.com/channel/UCLegacy123"
    );

    expect(selected.identity.channelId).toBe("UCLegacy123");
  });

  it("rejects a different echoed legacy alias", () => {
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [selectorChannel({ platformId: "UCLegacy123" })],
          "/c/OldCreatorName",
          "https://youtube.com/c/DifferentName"
        ),
      "target_identity_mismatch"
    );
  });

  it("rejects conflicting declared and URL handles", () => {
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [
            selectorChannel({
              handle: "@DifferentCreator"
            })
          ],
          "@ExactCreator"
        ),
      "target_identity_mismatch"
    );

    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [
            selectorChannel({
              handle: "https://www.youtube.com/@ExactCreator",
              platformId: "UCExact123"
            })
          ],
          "@ExactCreator"
        ),
      "target_identity_mismatch"
    );
  });

  it("accepts equivalent direct requestedUrl mappings", () => {
    expect(
      selectVerifiedYouTubeChannel(
        [selectorChannel({ platformId: "UCExact123" })],
        "@ExactCreator",
        "https://www.youtube.com/@EXACTCREATOR"
      ).identity.channelId
    ).toBe("UCExact123");
    expect(
      selectVerifiedYouTubeChannel(
        [selectorChannel({ platformId: "UCExact123" })],
        "@ExactCreator",
        "https://www.youtube.com/channel/UCExact123"
      ).identity.channelId
    ).toBe("UCExact123");
    expect(
      selectVerifiedYouTubeChannel(
        [selectorChannel({ platformId: "UCExact123" })],
        "/channel/UCExact123",
        "https://www.youtube.com/@ExactCreator"
      ).identity.channelId
    ).toBe("UCExact123");
  });

  it("rejects missing, invalid, legacy, and mismatched direct requestedUrl evidence", () => {
    const channelsWithId = [
      selectorChannel({ platformId: "UCExact123" })
    ];
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          channelsWithId,
          "@ExactCreator",
          null
        ),
      "target_not_verified"
    );
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          channelsWithId,
          "@ExactCreator",
          "/@ExactCreator"
        ),
      "target_not_verified"
    );
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          channelsWithId,
          "@ExactCreator",
          "https://www.youtube.com/c/OldAlias"
        ),
      "target_identity_mismatch"
    );
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          channelsWithId,
          "@ExactCreator",
          "https://www.youtube.com/@DifferentCreator"
        ),
      "target_identity_mismatch"
    );
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [
            selectorChannel({
              handle: "",
              url: "https://www.youtube.com/channel/UCExact123",
              platformId: "UCExact123"
            })
          ],
          "/channel/UCExact123",
          "https://www.youtube.com/@DifferentCreator"
        ),
      "target_identity_mismatch"
    );
  });

  it("treats blank platform IDs as missing and rejects legacy provider channel URLs", () => {
    expect(
      selectVerifiedYouTubeChannel(
        [selectorChannel({ platformId: " " })],
        "@ExactCreator"
      ).identity.verificationBasis
    ).toBe("exact_unique_handle");
    expectVerificationError(
      () =>
        selectVerifiedYouTubeChannel(
          [
            selectorChannel({
              url: "https://www.youtube.com/c/ExactCreator",
              platformId: "UCExact123"
            })
          ],
          "@ExactCreator"
        ),
      "target_not_verified"
    );
  });
});

describe("reach comparability", () => {
  it("accepts the inclusive 0.75–1.25 window", () => {
    expect(isReachComparable(1_000_000, 750_000)).toBe(true);
    expect(isReachComparable(1_000_000, 1_250_000)).toBe(true);
    expect(isReachComparable(3_450_000, 3_690_000)).toBe(true);
  });

  it("rejects large first-pilot peers and invalid counts", () => {
    expect(isReachComparable(3_450_000, 16_800_000)).toBe(false);
    expect(isReachComparable(0, 100)).toBe(false);
    expect(isReachComparable(100, -1)).toBe(false);
    expect(reachRatio(Number.POSITIVE_INFINITY, 100)).toBeNull();
  });

  it("supports an explicit cohort window", () => {
    expect(
      isReachComparable(100, 140, {
        minimumRatio: 0.5,
        maximumRatio: 1.5
      })
    ).toBe(true);
    expect(reachRatio(100, 40)).toBe(0.4);
  });
});

function selectorChannel(
  overrides: Partial<CreatorChannel> = {}
): CreatorChannel {
  return {
    platform: "youtube",
    handle: "@ExactCreator",
    url: "https://www.youtube.com/@ExactCreator",
    displayName: "Exact creator",
    subscriberCount: 1_000_000,
    ...overrides
  };
}

function expectVerificationError(
  action: () => unknown,
  code: YouTubeTargetVerificationCode
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(YouTubeTargetVerificationError);
    expect((error as YouTubeTargetVerificationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected YouTube verification error ${code}`);
}

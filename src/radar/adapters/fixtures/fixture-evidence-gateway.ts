import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertVerificationLedgerMatchesPilotConfig,
  CreatorBatchResponseWireSchema,
  PilotConfigSchema,
  SponsorsPageWireSchema,
  VerificationLedgerSchema,
  type PilotConfig
} from "@/src/radar/adapters/upriver/contracts";
import {
  normalizeCreatorBatch,
  normalizeSponsorEvidenceResult,
  type NormalizedCreator,
  type NormalizedSponsorEvidenceResult
} from "@/src/radar/adapters/upriver/normalize";
import type {
  LockedPeer,
  ResolvedTarget,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import {
  parseYouTubeChannelReference,
  parseYouTubeIdentity,
  selectRequestedYouTubeChannel,
  selectVerifiedYouTubeChannel,
  YouTubeTargetVerificationError
} from "@/src/radar/domain/youtube";

const PILOT_DIRECTORY =
  "experiments/tech-product-reviewers-reach-matched-2026-07-19";
const TARGET_PROFILE_PATH =
  "../tech-product-reviewers-2026-07-19/raw/creator-profiles.json";

export class UnsupportedFixtureChannelError extends Error {
  constructor() {
    super(
      "This demo supports only @UrAvgConsumer right now. Search for other channels is not enabled yet."
    );
    this.name = "UnsupportedFixtureChannelError";
  }
}

export class FixtureEvidenceGateway implements SponsorRadarEvidencePort {
  readonly mode = "fixture" as const;
  readonly qualificationPolicy = "verified_product_continuity" as const;
  readonly cachePolicyKey = "fixture:uravgconsumer-2026-07-19-v1";
  private readonly pilotDirectory: string;
  private configPromise: Promise<PilotConfig> | null = null;
  private targetProfilePromise: Promise<NormalizedCreator> | null = null;

  constructor(repositoryRoot: string) {
    this.pilotDirectory = path.join(repositoryRoot, PILOT_DIRECTORY);
  }

  estimateCredits(): number {
    return 0;
  }

  estimateRunCredits(): number {
    return 0;
  }

  async resolveTarget(input: string): Promise<ResolvedTarget> {
    const config = await this.loadConfig();
    const requested = parseYouTubeChannelReference(input);
    if (
      requested.kind === "legacy_user" ||
      requested.kind === "legacy_custom"
    ) {
      throw new UnsupportedFixtureChannelError();
    }
    const profile = await this.loadTargetProfile(config);
    let selected;
    try {
      selected = selectVerifiedYouTubeChannel(
        profile.channels,
        requested,
        profile.requestedUrl
      );
    } catch (error) {
      if (error instanceof YouTubeTargetVerificationError) {
        throw new UnsupportedFixtureChannelError();
      }
      throw error;
    }
    if (
      selected.channel.subscriberCount !== config.target.subscriber_count
    ) {
      throw new Error(
        "Captured target identity no longer matches the fixture subscriber count"
      );
    }

    return {
      target: {
        name: config.target.name,
        url: selected.identity.canonicalUrl,
        subscriberCount: config.target.subscriber_count
      },
      identity: selected.identity,
      config
    };
  }

  async listTargetSponsors(
    targetUrl: string
  ): Promise<NormalizedSponsorEvidenceResult> {
    const config = await this.assertSupportedTarget(targetUrl);
    const rawPath = path.resolve(
      this.pilotDirectory,
      config.target.cached_raw_file
    );
    const wire = SponsorsPageWireSchema.parse(await readJson(rawPath));
    return normalizeSponsorEvidenceResult(wire);
  }

  async listLockedPeers(
    targetUrl: string,
    targetSubscriberCount?: number
  ): Promise<LockedPeer[]> {
    void targetSubscriberCount;
    const config = await this.assertSupportedTarget(targetUrl);
    const profilesPath = path.join(
      this.pilotDirectory,
      "raw/creator-profiles.json"
    );
    const wire = CreatorBatchResponseWireSchema.parse(
      await readJson(profilesPath)
    );
    const profiles = normalizeCreatorBatch(wire);

    return config.peers.map((configuredPeer) => {
      const profile = profiles.find(
        (candidate) =>
          candidate.requestedUrl &&
          parseYouTubeIdentity(candidate.requestedUrl).key ===
            parseYouTubeIdentity(configuredPeer.url).key
      );
      if (!profile) {
        throw new Error(`Missing fixture profile for ${configuredPeer.name}`);
      }

      const channel = selectRequestedYouTubeChannel(
        profile.channels,
        configuredPeer.url
      );
      if (channel.subscriberCount === null) {
        throw new Error(
          `Missing subscriber count for locked peer ${configuredPeer.name}`
        );
      }

      return {
        name: configuredPeer.name,
        url: channel.url,
        subscriberCount: channel.subscriberCount,
        creatorId: profile.creatorId
      };
    });
  }

  async listPeerSponsors(
    peerUrl: string
  ): Promise<NormalizedSponsorEvidenceResult> {
    const config = await this.loadConfig();
    const requested = parseYouTubeIdentity(peerUrl);
    const peer = config.peers.find(
      (candidate) =>
        parseYouTubeIdentity(candidate.url).key === requested.key
    );
    if (!peer) {
      throw new Error("Peer was not in the locked, pre-approved fixture cohort");
    }

    const rawPath = path.resolve(this.pilotDirectory, peer.raw_file);
    const wire = SponsorsPageWireSchema.parse(await readJson(rawPath));
    return normalizeSponsorEvidenceResult(wire);
  }

  async loadVerificationLedger() {
    const config = await this.loadConfig();
    const rawPath = path.join(this.pilotDirectory, "verification.json");
    return assertVerificationLedgerMatchesPilotConfig(
      VerificationLedgerSchema.parse(await readJson(rawPath)),
      config
    );
  }

  private async assertSupportedTarget(targetUrl: string): Promise<PilotConfig> {
    const config = await this.loadConfig();
    if (
      parseYouTubeIdentity(targetUrl).key !==
      parseYouTubeIdentity(config.target.url).key
    ) {
      throw new UnsupportedFixtureChannelError();
    }
    return config;
  }

  private loadConfig(): Promise<PilotConfig> {
    this.configPromise ??= readJson(
      path.join(this.pilotDirectory, "config.json")
    ).then((value) => PilotConfigSchema.parse(value));
    return this.configPromise;
  }

  private loadTargetProfile(
    config: PilotConfig
  ): Promise<NormalizedCreator> {
    this.targetProfilePromise ??= readJson(
      path.resolve(this.pilotDirectory, TARGET_PROFILE_PATH)
    ).then((value) => {
      const profiles = normalizeCreatorBatch(
        CreatorBatchResponseWireSchema.parse(value)
      );
      const supportedKey = parseYouTubeIdentity(config.target.url).key;
      const profile = profiles.find((candidate) => {
        if (candidate.requestedUrl === null) return false;
        try {
          return (
            parseYouTubeIdentity(candidate.requestedUrl).key ===
            supportedKey
          );
        } catch {
          return false;
        }
      });
      if (!profile) {
        throw new Error("Missing captured target identity profile");
      }
      return profile;
    });
    return this.targetProfilePromise;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

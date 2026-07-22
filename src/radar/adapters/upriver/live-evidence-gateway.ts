import {
  CreatorBatchResponseWireSchema,
  SimilarCreatorsResponseWireSchema,
  SponsorsPageWireSchema,
  TrackingStatusWireSchema,
  type PilotConfig,
  type SimilarCreatorsResponseWire,
  type SponsorSummaryWire,
  type VerificationLedger
} from "@/src/radar/adapters/upriver/contracts";
import {
  UpriverHttpClient,
  UpriverHttpError,
  type CursorPaginationStopReason
} from "@/src/radar/adapters/upriver/http-client";
import {
  normalizeCreatorBatch,
  normalizeSponsorEvidenceResult,
  type NormalizedSponsorEvidenceResult
} from "@/src/radar/adapters/upriver/normalize";
import type {
  EvidenceOperation,
  LockedPeer,
  ResolvedTarget,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import {
  auditToolName,
  composeResolutionCredits,
  composeRunCeilingCredits,
  DEFAULT_OPERATION_RESULT_CAPS,
  estimateOperationCredits,
  MAX_PEER_COHORT,
  SIMILAR_CREATOR_RESULT_CAP,
  TOOL_REGISTRY
} from "@/src/radar/application/tools/tool-registry";
import {
  CreditBudget,
  UPRIVER_CREDIT_RATES,
  type CreditBudgetSnapshot
} from "@/src/radar/domain/credits";
import { isReachComparable } from "@/src/radar/domain/reach";
import {
  parseYouTubeChannelReference,
  parseYouTubeIdentity,
  selectVerifiedYouTubeChannel,
  YouTubeTargetVerificationError
} from "@/src/radar/domain/youtube";

const MINIMUM_REACH_RATIO = 0.75;
const MAXIMUM_REACH_RATIO = 1.25;
const DEFAULT_MAXIMUM_CREDITS = 200;
const MAX_SPONSOR_RESULT_CAP = 50;
const TARGET_LOOKBACK_DAYS = 365;
const PEER_LOOKBACK_DAYS = 90;

type TrackingStatus = ReturnType<typeof TrackingStatusWireSchema.parse>;

interface ResolvedTargetContext {
  subscriberCount: number;
  creatorId: string | null;
}

export interface LiveUpriverGatewayOptions {
  maximumCredits?: number;
  targetResultCap?: number;
  peerResultCap?: number;
  clock?: () => Date;
}

export class UpriverCreditPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpriverCreditPreflightError";
  }
}

/**
 * Paid live Upriver adapter.
 *
 * Target resolution is exact and peer discovery is a single bounded beta
 * similarity request. There is intentionally no search fallback and the
 * underlying HTTP client must have retries disabled.
 */
export class LiveUpriverGateway implements SponsorRadarEvidencePort {
  readonly mode = "live" as const;
  readonly qualificationPolicy = "same_brand_reactivation" as const;
  readonly cachePolicyKey: string;
  private readonly client: UpriverHttpClient;
  private readonly budget: CreditBudget;
  private readonly targetResultCap: number;
  private readonly peerResultCap: number;
  private readonly asOf: string;
  private readonly resolvedTargets = new Map<string, ResolvedTargetContext>();

  constructor(
    _repositoryRoot: string,
    client: UpriverHttpClient,
    options: LiveUpriverGatewayOptions = {}
  ) {
    if (client.maxRetries !== 0) {
      throw new Error(
        "Live Upriver paid requests require maxRetries: 0 to avoid ambiguous duplicate credit spend"
      );
    }
    this.client = client;
    this.budget = new CreditBudget(
      options.maximumCredits ?? DEFAULT_MAXIMUM_CREDITS
    );
    this.targetResultCap = boundedPositiveInteger(
      options.targetResultCap ??
        DEFAULT_OPERATION_RESULT_CAPS.targetResultCap,
      "targetResultCap",
      MAX_SPONSOR_RESULT_CAP
    );
    this.peerResultCap = boundedPositiveInteger(
      options.peerResultCap ?? DEFAULT_OPERATION_RESULT_CAPS.peerResultCap,
      "peerResultCap",
      MAX_SPONSOR_RESULT_CAP
    );
    this.asOf = toIsoDate((options.clock ?? (() => new Date()))());
    this.cachePolicyKey = [
      "live-dynamic-v2",
      this.asOf,
      `target-cap:${this.targetResultCap}`,
      `peer-cap:${this.peerResultCap}`,
      `similar-cap:${SIMILAR_CREATOR_RESULT_CAP}`,
      `reach:${MINIMUM_REACH_RATIO}-${MAXIMUM_REACH_RATIO}`,
      "language:any"
    ].join("|");
  }

  estimateCredits(operation: EvidenceOperation): number {
    return estimateOperationCredits(operation, {
      targetResultCap: this.targetResultCap,
      peerResultCap: this.peerResultCap
    });
  }

  estimateRunCredits(): number {
    return composeRunCeilingCredits((operation) =>
      this.estimateCredits(operation)
    );
  }

  estimateResolutionCredits(): number {
    return composeResolutionCredits((operation) =>
      this.estimateCredits(operation)
    );
  }

  creditSnapshot(): CreditBudgetSnapshot {
    return this.budget.snapshot();
  }

  async resolveTarget(input: string): Promise<ResolvedTarget> {
    const requested = parseYouTubeChannelReference(input);
    const allocation = this.reserve(
      "resolve_target",
      "Resolve the exact requested YouTube creator"
    );
    let response;
    try {
      response = await this.client.request({
        method: "POST",
        path: TOOL_REGISTRY.resolve_target.upriverEndpoint,
        body: { urls: [requested.lookupUrl] },
        audit: {
          operation: auditToolName("live", "resolve_target"),
          reason: "Confirm the exact requested YouTube channel before research",
          estimatedCredits: this.estimateCredits("resolve_target"),
          creditsPerResult: UPRIVER_CREDIT_RATES.creatorResult,
          resultRows: (data) => data.results.length
        },
        validate: CreatorBatchResponseWireSchema.parse
      });
    } catch (error) {
      throw await this.disambiguateResolveFailure(error, requested.lookupUrl);
    }
    this.budget.reconcile(
      allocation,
      response.data.results.length * UPRIVER_CREDIT_RATES.creatorResult
    );

    if (response.data.results.length > 1) {
      throw new YouTubeTargetVerificationError(
        "target_identity_ambiguous",
        "Upriver returned multiple target creator records"
      );
    }
    if (
      response.data.results.length !== 1 ||
      response.data.successful_count !== 1 ||
      response.data.failed_count !== 0 ||
      response.data.results[0]?.error
    ) {
      throw new YouTubeTargetVerificationError(
        "target_not_verified",
        "Upriver did not resolve exactly one target creator"
      );
    }

    const [profile] = normalizeCreatorBatch(response.data);
    const selected = selectVerifiedYouTubeChannel(
      profile.channels,
      requested,
      profile.requestedUrl
    );
    const channel = selected.channel;
    if (
      channel.subscriberCount === null ||
      channel.subscriberCount <= 0
    ) {
      throw new YouTubeTargetVerificationError(
        "target_not_verified",
        "Upriver target profile is missing a positive subscriber count"
      );
    }

    const canonicalTarget = parseYouTubeIdentity(
      selected.identity.canonicalUrl
    );
    this.resolvedTargets.set(canonicalTarget.key, {
      subscriberCount: channel.subscriberCount,
      creatorId: profile.creatorId
    });

    return {
      target: {
        name: channel.displayName,
        url: selected.identity.canonicalUrl,
        subscriberCount: channel.subscriberCount
      },
      identity: selected.identity,
      config: rollingConfig({
        asOf: this.asOf,
        name: channel.displayName,
        url: selected.identity.canonicalUrl,
        subscriberCount: channel.subscriberCount
      })
    };
  }

  async listTargetSponsors(
    targetUrl: string
  ): Promise<NormalizedSponsorEvidenceResult> {
    const target = parseYouTubeIdentity(targetUrl);
    return this.fetchSponsors(
      target.canonicalUrl,
      rollingWindow(this.asOf, TARGET_LOOKBACK_DAYS),
      this.targetResultCap,
      "list_target_sponsors",
      "Retrieve explicit target sponsorships from the rolling 365-day window"
    );
  }

  async listLockedPeers(
    targetUrl: string,
    targetSubscriberCount?: number
  ): Promise<LockedPeer[]> {
    const target = parseYouTubeIdentity(targetUrl);
    const remembered = this.resolvedTargets.get(target.key);
    const subscriberCount =
      targetSubscriberCount ?? remembered?.subscriberCount;
    if (
      subscriberCount === undefined ||
      !Number.isInteger(subscriberCount) ||
      subscriberCount <= 0
    ) {
      throw new Error(
        "Resolve the target before discovering peers or provide its subscriber count"
      );
    }

    const allocation = this.reserve(
      "list_locked_peers",
      "Discover a bounded reach-comparable YouTube peer cohort"
    );
    const response = await this.client.request({
      method: "POST",
      path: TOOL_REGISTRY.list_locked_peers.upriverEndpoint,
      body: {
        channel_url: target.canonicalUrl,
        limit: SIMILAR_CREATOR_RESULT_CAP,
        platforms: ["youtube"],
        // The beta endpoint returns HTTP 409 anchor_language_not_ready for
        // otherwise valid creators without a materialized language profile.
        // Reach is deterministic and the user approves the frozen suggestions,
        // so language matching remains an explicit future enhancement.
        min_followers: Math.ceil(
          subscriberCount * MINIMUM_REACH_RATIO
        ),
        max_followers: Math.floor(
          subscriberCount * MAXIMUM_REACH_RATIO
        )
      },
      audit: {
        operation: auditToolName("live", "list_locked_peers"),
        reason:
          "Discover and lock up to three reach-comparable YouTube peers before sponsor review",
        estimatedCredits: this.estimateCredits("list_locked_peers"),
        creditsPerResult: UPRIVER_CREDIT_RATES.creatorResult,
        resultRows: (data) => data.results.length
      },
      validate: SimilarCreatorsResponseWireSchema.parse
    });
    this.budget.reconcile(
      allocation,
      response.data.results.length * UPRIVER_CREDIT_RATES.creatorResult
    );
    assertSimilarAnchorMatchesTarget(
      response.data.anchor,
      target.key,
      remembered?.creatorId
    );

    const peers: LockedPeer[] = [];
    const seenCreatorIds = new Set<string>();
    const seenChannelKeys = new Set<string>();
    for (const result of response.data.results) {
      if (peers.length === MAX_PEER_COHORT) break;
      if (
        result.creator_id === response.data.anchor.creator_id ||
        seenCreatorIds.has(result.creator_id)
      ) {
        continue;
      }

      // Upriver documents the first returned channel as the channel that
      // qualified the creator for this similarity result.
      const channel = result.channels[0];
      const peerSubscriberCount = channel.subscriber_count;
      if (
        channel.platform.toLowerCase() !== "youtube" ||
        peerSubscriberCount === null ||
        peerSubscriberCount === undefined ||
        !Number.isInteger(peerSubscriberCount) ||
        peerSubscriberCount <= 0
      ) {
        continue;
      }
      let channelIdentity;
      try {
        channelIdentity = parseYouTubeIdentity(channel.url);
      } catch {
        continue;
      }
      if (
        channelIdentity.key === target.key ||
        seenChannelKeys.has(channelIdentity.key) ||
        !isReachComparable(subscriberCount, peerSubscriberCount)
      ) {
        continue;
      }

      seenCreatorIds.add(result.creator_id);
      seenChannelKeys.add(channelIdentity.key);
      peers.push({
        name: result.name,
        url: channelIdentity.canonicalUrl,
        subscriberCount: peerSubscriberCount,
        creatorId: result.creator_id
      });
    }

    return peers;
  }

  async listPeerSponsors(
    peerUrl: string
  ): Promise<NormalizedSponsorEvidenceResult> {
    const peer = parseYouTubeIdentity(peerUrl);
    return this.fetchSponsors(
      peer.canonicalUrl,
      rollingWindow(this.asOf, PEER_LOOKBACK_DAYS),
      this.peerResultCap,
      "list_peer_sponsors",
      "Retrieve recent explicit sponsorships for an approved peer"
    );
  }

  async loadVerificationLedger(): Promise<VerificationLedger> {
    throw new Error(
      "Live dynamic qualification does not use a manual verification ledger"
    );
  }

  private async fetchSponsors(
    publicationUrl: string,
    window: { since: string; until: string },
    maxResults: number,
    operation: Extract<
      EvidenceOperation,
      "list_target_sponsors" | "list_peer_sponsors"
    >,
    reason: string
  ): Promise<NormalizedSponsorEvidenceResult> {
    const estimatedCredits = this.estimateCredits(operation);
    const allocation = this.reserve(operation, reason);
    let trackingStatus: TrackingStatus | null = null;
    const response = await this.client.paginateCursor({
      path: TOOL_REGISTRY[operation].upriverEndpoint,
      query: {
        publication_url: publicationUrl,
        platforms: "youtube",
        sponsor_type: "explicit_ad",
        include_evidence: true,
        since: window.since,
        until: window.until
      },
      audit: {
        operation: auditToolName("live", operation),
        reason
      },
      validatePage: (input) => {
        const page = SponsorsPageWireSchema.parse(input);
        trackingStatus ??= page.tracking_status ?? null;
        return page;
      },
      boundaries: {
        // One bounded paid request avoids ambiguous partial spend if a later
        // page were to fail.
        pageSize: maxResults,
        maxPages: 1,
        maxResults,
        maxCredits: estimatedCredits,
        creditsPerResult: UPRIVER_CREDIT_RATES.groupedSponsorResult
      }
    });
    const resultBasedCredits =
      response.results.length * UPRIVER_CREDIT_RATES.groupedSponsorResult;
    this.budget.reconcile(allocation, resultBasedCredits);
    assertSponsorResponseMatchesPublication(
      response.results,
      trackingStatus,
      publicationUrl,
      window
    );

    const incomplete = isIncomplete(response.stopReason);
    return normalizeSponsorEvidenceResult(
      {
        results: [...response.results],
        total_count: response.results.length,
        has_more: incomplete,
        next_cursor: null,
        tracking_status: trackingStatus
      },
      { incomplete }
    );
  }

  private reserve(operation: EvidenceOperation, reason: string): string {
    const decision = this.budget.preflight({
      estimatedCredits: this.estimateCredits(operation),
      reason
    });
    if (decision.decision === "deny") {
      throw new UpriverCreditPreflightError(decision.reason);
    }
    return decision.allocationId;
  }

  /**
   * The batch resolve endpoint reports a nonexistent channel as a 5xx, while
   * /v1/creators/similar reports it as a structured channel_not_found 404.
   * After a batch 5xx, one bounded probe disambiguates; anything but a clear
   * not-found verdict rethrows the original error unchanged.
   */
  private async disambiguateResolveFailure(
    batchError: unknown,
    lookupUrl: string
  ): Promise<unknown> {
    if (
      !(batchError instanceof UpriverHttpError) ||
      batchError.status === null ||
      batchError.status < 500
    ) {
      return batchError;
    }
    try {
      const reason =
        "Disambiguate a failed resolve: probe whether the channel exists";
      const allocation = this.reserve("resolve_target", reason);
      const validateProbe = (input: unknown): { results?: unknown[] } =>
        input as { results?: unknown[] };
      const probe = await this.client.request({
        method: "POST",
        path: "/v1/creators/similar",
        body: {
          channel_url: lookupUrl,
          limit: 1,
          platforms: ["youtube"],
          min_followers: 1_000,
          max_followers: 100_000
        },
        audit: {
          operation: auditToolName("live", "resolve_target"),
          reason,
          estimatedCredits: this.estimateCredits("resolve_target"),
          creditsPerResult: UPRIVER_CREDIT_RATES.creatorResult,
          resultRows: (data) => data.results?.length ?? 0
        },
        validate: validateProbe
      });
      this.budget.reconcile(
        allocation,
        (probe.data.results?.length ?? 0) * UPRIVER_CREDIT_RATES.creatorResult
      );
      return batchError;
    } catch (probeError) {
      if (
        probeError instanceof UpriverHttpError &&
        probeError.code === "not_found" &&
        probeError.providerCode === "channel_not_found"
      ) {
        return probeError;
      }
      return batchError;
    }
  }
}

function rollingConfig(input: {
  asOf: string;
  name: string;
  url: string;
  subscriberCount: number;
}): PilotConfig {
  const targetWindow = rollingWindow(input.asOf, TARGET_LOOKBACK_DAYS);
  const peerWindow = rollingWindow(input.asOf, PEER_LOOKBACK_DAYS);
  return {
    as_of: input.asOf,
    target_window: targetWindow,
    stale_cutoff_exclusive: peerWindow.since,
    peer_window: peerWindow,
    target: {
      name: input.name,
      url: input.url,
      subscriber_count: input.subscriberCount,
      cached_raw_file: "not_applicable_live"
    },
    peers: [],
    sponsor_types: ["explicit_ad"],
    brand_research_domains: []
  };
}

function rollingWindow(
  until: string,
  lookbackDays: number
): { since: string; until: string } {
  const instant = new Date(`${until}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() - lookbackDays);
  return {
    since: instant.toISOString().slice(0, 10),
    until
  };
}

function toIsoDate(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("clock must return a valid Date");
  }
  return value.toISOString().slice(0, 10);
}

function assertSimilarAnchorMatchesTarget(
  anchor: SimilarCreatorsResponseWire["anchor"],
  requestedTargetKey: string,
  rememberedCreatorId: string | null | undefined
): void {
  const matchesTarget = (candidate: string): boolean => {
    try {
      return parseYouTubeIdentity(candidate).key === requestedTargetKey;
    } catch {
      return false;
    }
  };
  if (
    anchor.scope !== "channel" ||
    !matchesTarget(anchor.channel_url) ||
    !matchesTarget(anchor.requested_channel_url)
  ) {
    throw new Error(
      "Upriver similar-creators response did not identify the requested anchor"
    );
  }
  if (
    rememberedCreatorId !== null &&
    rememberedCreatorId !== undefined &&
    anchor.creator_id !== rememberedCreatorId
  ) {
    throw new Error(
      "Upriver similar-creators anchor creator identity changed after target resolution"
    );
  }
}

function isIncomplete(stopReason: CursorPaginationStopReason): boolean {
  return stopReason !== "end";
}

function assertSponsorResponseMatchesPublication(
  results: readonly SponsorSummaryWire[],
  trackingStatus: TrackingStatus | null,
  requestedPublicationUrl: string,
  window: { since: string; until: string }
): void {
  const requestedKey = parseYouTubeIdentity(requestedPublicationUrl).key;
  const sponsorHasMismatch = results.some((result) => {
    try {
      return (
        parseYouTubeIdentity(result.most_recent_ad.publication_url).key !==
        requestedKey
      );
    } catch {
      return true;
    }
  });
  let trackingHasMismatch = false;
  if (trackingStatus !== null) {
    try {
      trackingHasMismatch =
        parseYouTubeIdentity(trackingStatus.publication_url).key !==
        requestedKey;
    } catch {
      trackingHasMismatch = true;
    }
  }

  if (sponsorHasMismatch || trackingHasMismatch) {
    throw new Error(
      "Upriver sponsor response did not identify the requested publication"
    );
  }

  if (
    results.some(
      (result) =>
        result.most_recent_ad.published_date < window.since ||
        result.most_recent_ad.published_date > window.until
    )
  ) {
    throw new Error(
      "Upriver sponsor response included evidence outside the requested date window"
    );
  }
}

function boundedPositiveInteger(
  value: number,
  name: string,
  maximum: number
): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `${name} must be a positive integer no greater than ${maximum}`
    );
  }
  return value;
}

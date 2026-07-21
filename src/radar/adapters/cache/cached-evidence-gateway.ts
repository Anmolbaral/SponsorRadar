import { z } from "zod";
import {
  PilotConfigSchema,
  VerificationLedgerSchema,
  type VerificationLedger
} from "@/src/radar/adapters/upriver/contracts";
import type { NormalizedSponsorEvidenceResult } from "@/src/radar/adapters/upriver/normalize";
import type {
  EvidenceCacheStatus,
  EvidenceMode,
  EvidenceOperation,
  LockedPeer,
  QualificationPolicy,
  ResolvedTarget,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import type {
  JsonValue,
  WorkflowPersistenceRepository
} from "@/src/radar/adapters/persistence";
import {
  composeResolutionCredits,
  MAX_PEER_COHORT
} from "@/src/radar/application/tools/tool-registry";
import {
  parseYouTubeChannelReference,
  parseYouTubeIdentity
} from "@/src/radar/domain/youtube";

const CACHE_NAMESPACE = "sponsor-radar-upriver-evidence";
const CACHE_SCHEMA_VERSION = 3;

const TargetSummarySchema = z
  .object({
    name: z.string(),
    url: z.string().url(),
    subscriberCount: z.number().int().nonnegative()
  })
  .strict();

const VerifiedYouTubeIdentitySchema = z
  .discriminatedUnion("verificationBasis", [
    z
      .object({
        verificationBasis: z.literal("channel_id"),
        channelId: z.string().regex(/^UC[A-Za-z0-9_-]+$/),
        handle: z.string().min(1).nullable(),
        canonicalUrl: z.url(),
        key: z.string().min(1)
      })
      .strict(),
    z
      .object({
        verificationBasis: z.literal("exact_unique_handle"),
        channelId: z.null(),
        handle: z.string().min(1),
        canonicalUrl: z.url(),
        key: z.string().min(1)
      })
      .strict()
  ])
  .superRefine((identity, context) => {
    if (!cachedIdentityFieldsAgree(identity)) {
      context.addIssue({
        code: "custom",
        message: "Cached YouTube identity fields do not agree"
      });
    }
  });

const ResolvedTargetSchema = z
  .object({
    target: TargetSummarySchema,
    identity: VerifiedYouTubeIdentitySchema,
    config: PilotConfigSchema
  })
  .strict()
  .superRefine((resolved, context) => {
    const configTarget = resolved.config.target;
    if (resolved.target.url !== resolved.identity.canonicalUrl) {
      context.addIssue({
        code: "custom",
        path: ["target", "url"],
        message: "Cached target URL is not the verified canonical URL"
      });
    }
    if (
      configTarget.name !== resolved.target.name ||
      configTarget.url !== resolved.target.url ||
      configTarget.subscriber_count !== resolved.target.subscriberCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["config", "target"],
        message: "Cached target and pilot configuration do not agree"
      });
    }
  });

const LockedPeerSchema = z
  .object({
    name: z.string(),
    url: z.string().url(),
    subscriberCount: z.number().int().nonnegative(),
    creatorId: z.string().nullable()
  })
  .strict();

const SponsorTrackingStatusSchema = z
  .object({
    publicationUrl: z.string().url(),
    channelName: z.string(),
    status: z.string(),
    message: z.string()
  })
  .strict();

const SponsorEvidenceSchema = z
  .object({
    provider: z.literal("upriver"),
    sourceEndpoint: z.literal("sponsors"),
    sponsorName: z.string(),
    rawSponsorDomain: z.string().nullable(),
    normalizedDomain: z.string().nullable(),
    totalAdsFound: z.number().int().nonnegative(),
    publicationName: z.string(),
    publicationUrl: z.string().url(),
    contentUrl: z.string().url(),
    publishedDate: z.iso.date(),
    placementType: z.string(),
    evidenceSource: z.string().nullable(),
    excerpt: z.string().nullable(),
    evidenceConfidence: z.number().nullable(),
    coverage: z.enum(["active", "unknown", "other", "partial"]),
    warnings: z.array(
      z.enum([
        "missing_domain",
        "missing_evidence",
        "zero_confidence",
        "non_explicit_placement",
        "coverage_unknown",
        "coverage_incomplete"
      ])
    )
  })
  .strict();

const SponsorEvidenceResultSchema = z
  .object({
    rows: z.array(SponsorEvidenceSchema),
    completeness: z.enum(["complete", "partial"]),
    trackingStatus: SponsorTrackingStatusSchema.nullable()
  })
  .strict();

export interface CachedEvidenceGatewayOptions {
  creatorTtlMs?: number;
  sponsorTtlMs?: number;
  verificationTtlMs?: number;
}

type CacheableEvidenceOperation = EvidenceOperation;

/**
 * Adds a deterministic server-side read-through cache without weakening the
 * underlying gateway's validation, credit budget, or live zero-retry policy.
 */
export class CachedEvidenceGateway implements SponsorRadarEvidencePort {
  readonly mode;
  readonly qualificationPolicy: QualificationPolicy;
  readonly cachePolicyKey: string;
  private readonly creatorTtlMs: number;
  private readonly sponsorTtlMs: number;
  private readonly verificationTtlMs: number;
  private readonly verifiedIdentityKeys = new Map<string, string>();
  private hasVerifiedTarget = false;
  private preparedRunCredits: number | null = null;
  private preparedResolutionCredits: number | null = null;

  constructor(
    private readonly underlying: SponsorRadarEvidencePort,
    private readonly repository: WorkflowPersistenceRepository,
    options: CachedEvidenceGatewayOptions = {}
  ) {
    this.mode = underlying.mode;
    this.qualificationPolicy =
      underlying.qualificationPolicy ??
      (underlying.mode === "fixture"
        ? "verified_product_continuity"
        : "same_brand_reactivation");
    this.cachePolicyKey =
      underlying.cachePolicyKey ??
      `${underlying.mode}:default-evidence-policy-v1`;
    this.creatorTtlMs = positiveInteger(
      options.creatorTtlMs ?? 24 * 60 * 60 * 1_000,
      "creatorTtlMs"
    );
    this.sponsorTtlMs = positiveInteger(
      options.sponsorTtlMs ?? 6 * 60 * 60 * 1_000,
      "sponsorTtlMs"
    );
    this.verificationTtlMs = positiveInteger(
      options.verificationTtlMs ?? 30 * 24 * 60 * 60 * 1_000,
      "verificationTtlMs"
    );
  }

  estimateCredits(operation: EvidenceOperation): number {
    return this.underlying.estimateCredits(operation);
  }

  estimateRunCredits(): number {
    return this.preparedRunCredits ?? this.underlying.estimateRunCredits();
  }

  estimateResolutionCredits(): number {
    return (
      this.preparedResolutionCredits ??
      this.underlying.estimateResolutionCredits?.() ??
      composeResolutionCredits((operation) =>
        this.underlying.estimateCredits(operation)
      )
    );
  }

  async prepareRun(input: string): Promise<void> {
    const resolvedLookup = await this.lookup(
      "resolve_target",
      input,
      ResolvedTargetSchema
    );
    if (resolvedLookup.status !== "hit") {
      this.preparedRunCredits = this.underlying.estimateRunCredits();
      this.preparedResolutionCredits =
        this.underlying.estimateResolutionCredits?.() ??
        composeResolutionCredits((operation) =>
          this.underlying.estimateCredits(operation)
        );
      return;
    }

    const resolved = resolvedLookup.value;
    this.rememberResolvedTarget(resolved);
    const peerLookup = await this.lookup(
      "list_locked_peers",
      resolved.target.url,
      z.array(LockedPeerSchema),
      resolved.target.subscriberCount
    );
    let estimate = 0;
    let resolutionEstimate = 0;
    if (
      (await this.inspectCache("resolve_target", input)) !== "hit"
    ) {
      const resolveCredits =
        this.underlying.estimateCredits("resolve_target");
      estimate += resolveCredits;
      resolutionEstimate += resolveCredits;
    }
    if (peerLookup.status !== "hit") {
      const peerDiscoveryCredits =
        this.underlying.estimateCredits("list_locked_peers");
      estimate += peerDiscoveryCredits;
      resolutionEstimate += peerDiscoveryCredits;
    }
    if (
      (await this.inspectCache(
        "list_target_sponsors",
        resolved.target.url
      )) !== "hit"
    ) {
      estimate += this.underlying.estimateCredits("list_target_sponsors");
    }

    if (peerLookup.status === "hit") {
      for (const peer of peerLookup.value) {
        if (
          (await this.inspectCache("list_peer_sponsors", peer.url)) !== "hit"
        ) {
          estimate += this.underlying.estimateCredits("list_peer_sponsors");
        }
      }
    } else {
      // A cached target no longer implies a fixed peer cohort. Until Similar
      // Creators is resolved, reserve enough for the maximum allowed cohort.
      estimate +=
        MAX_PEER_COHORT *
        this.underlying.estimateCredits("list_peer_sponsors");
    }
    this.preparedRunCredits = estimate;
    this.preparedResolutionCredits = resolutionEstimate;
  }

  async inspectCache(
    operation: EvidenceOperation,
    input: string,
    targetSubscriberCount?: number
  ): Promise<EvidenceCacheStatus> {
    const lookup = await this.lookupForOperation(
      operation,
      input,
      targetSubscriberCount
    );
    return lookup.status === "hit" ? "hit" : "miss";
  }

  async resolveTarget(input: string): Promise<ResolvedTarget> {
    const resolved = await this.readThrough(
      "resolve_target",
      input,
      this.creatorTtlMs,
      ResolvedTargetSchema,
      () => this.underlying.resolveTarget(input)
    );
    this.rememberResolvedTarget(resolved);
    return resolved;
  }

  async resolveTargetFresh(input: string): Promise<ResolvedTarget> {
    const resolved = ResolvedTargetSchema.parse(
      await this.underlying.resolveTarget(input)
    );
    await this.repository.putCache({
      namespace: cacheNamespace(this.mode),
      key: this.cacheKey("resolve_target", input),
      valueSchemaVersion: CACHE_SCHEMA_VERSION,
      ttlMs: this.creatorTtlMs,
      value: resolved as unknown as JsonValue
    });
    this.rememberResolvedTarget(resolved);
    return structuredClone(resolved);
  }

  listTargetSponsors(
    targetUrl: string
  ): Promise<NormalizedSponsorEvidenceResult> {
    return this.readThrough(
      "list_target_sponsors",
      targetUrl,
      this.sponsorTtlMs,
      SponsorEvidenceResultSchema,
      () => this.underlying.listTargetSponsors(targetUrl)
    );
  }

  listLockedPeers(
    targetUrl: string,
    targetSubscriberCount?: number
  ): Promise<LockedPeer[]> {
    return this.readThrough(
      "list_locked_peers",
      targetUrl,
      this.creatorTtlMs,
      z.array(LockedPeerSchema),
      () =>
        this.underlying.listLockedPeers(
          targetUrl,
          targetSubscriberCount
        ),
      targetSubscriberCount
    );
  }

  listPeerSponsors(
    peerUrl: string
  ): Promise<NormalizedSponsorEvidenceResult> {
    return this.readThrough(
      "list_peer_sponsors",
      peerUrl,
      this.sponsorTtlMs,
      SponsorEvidenceResultSchema,
      () => this.underlying.listPeerSponsors(peerUrl)
    );
  }

  loadVerificationLedger(): Promise<VerificationLedger> {
    return this.readThrough(
      "load_verification_ledger",
      "reach-matched-pilot-2026-07-19",
      this.verificationTtlMs,
      VerificationLedgerSchema,
      () => this.underlying.loadVerificationLedger()
    );
  }

  private async readThrough<T>(
    operation: CacheableEvidenceOperation,
    input: string,
    ttlMs: number,
    schema: z.ZodType<T>,
    loader: () => Promise<T>,
    targetSubscriberCount?: number
  ): Promise<T> {
    const lookup = await this.lookup(
      operation,
      input,
      schema,
      targetSubscriberCount
    );
    if (lookup.status === "hit") {
      return structuredClone(lookup.value);
    }

    const value = schema.parse(await loader());
    await this.repository.putCache({
      namespace: cacheNamespace(this.mode),
      key: this.cacheKey(
        operation,
        input,
        targetSubscriberCount
      ),
      valueSchemaVersion: CACHE_SCHEMA_VERSION,
      ttlMs,
      value: value as unknown as JsonValue
    });
    return structuredClone(value);
  }

  private lookupForOperation(
    operation: CacheableEvidenceOperation,
    input: string,
    targetSubscriberCount?: number
  ) {
    switch (operation) {
      case "resolve_target":
        return this.lookup(operation, input, ResolvedTargetSchema);
      case "list_locked_peers":
        return this.lookup(
          operation,
          input,
          z.array(LockedPeerSchema),
          targetSubscriberCount
        );
      case "list_target_sponsors":
      case "list_peer_sponsors":
        return this.lookup(operation, input, SponsorEvidenceResultSchema);
      case "load_verification_ledger":
        return this.lookup(operation, input, VerificationLedgerSchema);
    }
  }

  private async lookup<T>(
    operation: CacheableEvidenceOperation,
    input: string,
    schema: z.ZodType<T>,
    targetSubscriberCount?: number
  ): Promise<
    | { status: "hit"; value: T }
    | { status: "miss"; value: null }
  > {
    const lookup = await this.repository.getCache({
      namespace: cacheNamespace(this.mode),
      key: this.cacheKey(
        operation,
        input,
        targetSubscriberCount
      ),
      valueSchemaVersion: CACHE_SCHEMA_VERSION
    });
    if (lookup.status !== "hit") {
      return { status: "miss", value: null };
    }
    const parsed = schema.safeParse(lookup.value);
    return parsed.success
      ? { status: "hit", value: parsed.data }
      : { status: "miss", value: null };
  }

  private cacheKey(
    operation: CacheableEvidenceOperation,
    input: string,
    targetSubscriberCount?: number
  ): string {
    const referenceKey =
      operation === "load_verification_ledger"
        ? null
        : parseYouTubeChannelReference(input).requestKey;
    const targetIdentityRequired =
      operation === "list_target_sponsors" ||
      operation === "list_locked_peers";
    if (operation === "list_peer_sponsors" && !this.hasVerifiedTarget) {
      throw new Error(
        "Resolve and verify the target before sponsor evidence operations"
      );
    }
    const verifiedIdentityKey =
      targetIdentityRequired && referenceKey !== null
        ? this.verifiedIdentityKeys.get(referenceKey)
        : undefined;
    if (targetIdentityRequired && verifiedIdentityKey === undefined) {
      throw new Error(
        "Resolve and verify the target before target evidence operations"
      );
    }
    return cacheKey(
      operation,
      input,
      targetSubscriberCount,
      this.cachePolicyKey,
      verifiedIdentityKey
    );
  }

  private rememberResolvedTarget(resolved: ResolvedTarget): void {
    this.hasVerifiedTarget = true;
    const referenceKeys = new Set<string>();
    for (const candidate of [
      resolved.target.url,
      resolved.identity.canonicalUrl,
      resolved.identity.handle === null
        ? null
        : `@${resolved.identity.handle}`,
      resolved.identity.channelId === null
        ? null
        : `/channel/${resolved.identity.channelId}`
    ]) {
      if (candidate === null) continue;
      referenceKeys.add(
        parseYouTubeChannelReference(candidate).requestKey
      );
    }
    for (const referenceKey of referenceKeys) {
      this.verifiedIdentityKeys.set(referenceKey, resolved.identity.key);
    }
  }
}

function cacheNamespace(mode: EvidenceMode): string {
  return `${CACHE_NAMESPACE}:${mode}`;
}

function cacheKey(
  operation: CacheableEvidenceOperation,
  input: string,
  targetSubscriberCount: number | undefined,
  cachePolicyKey: string,
  verifiedIdentityKey?: string
): string {
  const normalizedInput =
    operation === "load_verification_ledger"
      ? input.trim().toLowerCase()
      : (verifiedIdentityKey ??
        parseYouTubeChannelReference(input).requestKey);
  return JSON.stringify({
    operation,
    normalizedInput,
    cachePolicyKey,
    ...(operation === "list_locked_peers"
      ? {
          targetSubscriberCount:
            optionalNonNegativeInteger(targetSubscriberCount)
        }
      : {}),
    policyVersion: "dynamic-cohort-v3"
  });
}

function cachedIdentityFieldsAgree(
  identity: z.infer<typeof VerifiedYouTubeIdentitySchema>
): boolean {
  try {
    const canonical = parseYouTubeChannelReference(
      identity.canonicalUrl
    );
    if (identity.verificationBasis === "channel_id") {
      if (identity.key !== `channel:${identity.channelId}`) {
        return false;
      }
      if (canonical.kind === "channel_id") {
        return canonical.channelId === identity.channelId;
      }
      return (
        canonical.kind === "handle" &&
        identity.handle !== null &&
        canonical.requestKey ===
          parseYouTubeIdentity(identity.handle).key
      );
    }
    return (
      canonical.kind === "handle" &&
      identity.key === canonical.requestKey &&
      canonical.requestKey ===
        parseYouTubeIdentity(identity.handle).key
    );
  } catch {
    return false;
  }
}

function optionalNonNegativeInteger(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(
      "targetSubscriberCount must be a non-negative integer"
    );
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

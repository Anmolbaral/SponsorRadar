import { z } from "zod";
import { isIsoDate } from "@/src/radar/domain/dates";

export const ApiErrorSchema = z
  .object({
    detail: z.union([
      z.string(),
      z
        .object({
          code: z.string().optional(),
          message: z.string().optional()
        })
        .passthrough(),
      z.array(
        z
          .object({
            loc: z.array(z.union([z.string(), z.number()])).optional(),
            msg: z.string().optional(),
            type: z.string().optional()
          })
          .passthrough()
      )
    ])
  })
  .passthrough();

export const EvidenceWireSchema = z
  .object({
    source: z.string().nullable().optional(),
    excerpt: z.string().nullable().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    offset_seconds: z.number().nonnegative().nullable().optional()
  })
  .passthrough();

export const PlacementWireSchema = z
  .object({
    publication_name: z.string(),
    publication_url: z.string(),
    publication_categories: z.array(z.string()),
    publication_platform: z.string(),
    content_url: z.string().url(),
    sponsor_type: z.string(),
    published_date: z
      .string()
      .refine(isIsoDate, "published_date must be a real YYYY-MM-DD date"),
    evidence: EvidenceWireSchema.nullable().optional()
  })
  .passthrough();

export const SponsorSummaryWireSchema = z
  .object({
    partner_name: z.string().min(1),
    sponsor_domain: z.string().nullable().optional(),
    sponsor_description: z.string().nullable().optional(),
    sponsor_linkedin_url: z.string().nullable().optional(),
    total_ads_found: z.number().int().nonnegative(),
    most_recent_ad: PlacementWireSchema
  })
  .passthrough();

export const TrackingStatusWireSchema = z
  .object({
    publication_url: z.string(),
    channel_name: z.string(),
    status: z.string(),
    message: z.string()
  })
  .passthrough();

export const SponsorsPageWireSchema = z
  .object({
    results: z.array(SponsorSummaryWireSchema),
    total_count: z.number().int().nonnegative(),
    has_more: z.boolean(),
    next_cursor: z.string().nullable().optional(),
    tracking_status: TrackingStatusWireSchema.nullable().optional()
  })
  .passthrough();

export const FollowerBucketWireSchema = z
  .object({
    id: z.string(),
    display: z.string(),
    min_followers: z.number().int().nonnegative(),
    max_followers: z.number().int().nonnegative().optional()
  })
  .passthrough();

export const ChannelWireSchema = z
  .object({
    platform: z.string(),
    handle: z.string(),
    url: z.string().url(),
    display_name: z.string(),
    platform_id: z.string().nullable().optional(),
    profile_pic_url: z.string().optional(),
    subscriber_count: z.number().int().nonnegative().nullable().optional(),
    subscriber_count_text: z.string().nullable().optional(),
    follower_bucket: FollowerBucketWireSchema.optional()
  })
  .passthrough();

const AssociatedCreatorWireSchema = z
  .object({
    creator_id: z.string(),
    creator_role: z.string().optional()
  })
  .passthrough();

const LabelWireSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    level: z.number().optional(),
    parent_id: z.string().optional()
  })
  .passthrough();

export const CreatorWireSchema = z
  .object({
    url: z.string().url().optional(),
    creator_id: z.string().optional(),
    error: z.string().nullable().optional(),
    channels: z.array(ChannelWireSchema).default([]),
    associated_creators: z.array(AssociatedCreatorWireSchema).default([]),
    labels: z.array(LabelWireSchema).default([]),
    tags: z
      .array(z.object({ id: z.string(), name: z.string() }).passthrough())
      .default([])
  })
  .passthrough();

export const CreatorBatchResponseWireSchema = z
  .object({
    results: z.array(CreatorWireSchema),
    successful_count: z.number().int().nonnegative(),
    failed_count: z.number().int().nonnegative()
  })
  .passthrough();

export const SimilarCreatorAnchorWireSchema = z
  .object({
    scope: z.literal("channel"),
    requested_creator_id: z.string().min(1).nullable().optional(),
    creator_id: z.string().min(1),
    requested_channel_url: z.string().url(),
    channel_url: z.string().url()
  })
  .passthrough();

export const SimilarCreatorChannelWireSchema = z
  .object({
    platform: z.string().min(1),
    url: z.string().url(),
    handle: z.string().min(1).nullable().optional(),
    subscriber_count: z.number().int().nonnegative().nullable().optional()
  })
  .passthrough();

export const SimilarityReasonWireSchema = z
  .object({
    code: z.string().min(1),
    values: z.array(z.string())
  })
  .passthrough();

export const SimilarCreatorResultWireSchema = z
  .object({
    creator_id: z.string().min(1),
    name: z.string().min(1),
    channel_count: z.number().int().positive(),
    channels: z.array(SimilarCreatorChannelWireSchema).min(1),
    similarity: z
      .object({
        reasons: z.array(SimilarityReasonWireSchema).min(1)
      })
      .passthrough(),
    labels: z.array(z.string()).default([])
  })
  .passthrough();

export const SimilarCreatorsResponseWireSchema = z
  .object({
    anchor: SimilarCreatorAnchorWireSchema,
    ranking_version: z.string().min(1),
    results: z.array(SimilarCreatorResultWireSchema).max(50),
    beta: z.string().min(1).optional()
  })
  .passthrough();

export const PilotConfigSchema = z
  .object({
    as_of: z.string().refine(isIsoDate),
    target_window: z.object({
      since: z.string().refine(isIsoDate),
      until: z.string().refine(isIsoDate)
    }),
    stale_cutoff_exclusive: z.string().refine(isIsoDate),
    peer_window: z.object({
      since: z.string().refine(isIsoDate),
      until: z.string().refine(isIsoDate)
    }),
    target: z.object({
      name: z.string(),
      url: z.string().url(),
      subscriber_count: z.number().int().positive(),
      cached_raw_file: z.string()
    }),
    peers: z.array(
      z.object({
        name: z.string(),
        url: z.string().url(),
        subscriber_count: z.number().int().positive(),
        raw_file: z.string()
      })
    ),
    sponsor_types: z.array(z.string()),
    brand_research_domains: z.array(z.string())
  })
  .passthrough();

const PlacementClassSchema = z.enum(["S3", "S2", "S1", "S0", "SU"]);
const ContinuitySchema = z.enum(["A", "B", "C", "U"]);

export const PeerInventorySchema = z
  .object({
    channel: z.string(),
    api_partner_name: z.string(),
    api_domain: z.string().nullable(),
    manually_resolved_domain: z.string().nullable(),
    strict_classification: PlacementClassSchema,
    join_status: z.string(),
    video_url: z.string().url(),
    video_title: z.string(),
    api_observed_date: z.string().refine(isIsoDate),
    public_page_date: z.string().refine(isIsoDate),
    paid_promotion_declaration: z.boolean(),
    public_evidence: z.string(),
    outbound_url: z.string().url().nullable(),
    resolved_destination: z.string().nullable(),
    product_line: z.string(),
    verdict: z.string()
  })
  .passthrough();

const VerifiedEvidenceSchema = z
  .object({
    channel: z.string(),
    video_url: z.string().url(),
    video_title: z.string(),
    api_observed_date: z.string().refine(isIsoDate),
    public_page_date: z.string().refine(isIsoDate),
    public_evidence: z.string(),
    outbound_url: z.string().url().nullable(),
    resolved_destination: z.string().nullable(),
    verdict: z.string()
  })
  .passthrough();

export const StrictOverlapSchema = z
  .object({
    domain: z.string(),
    brand: z.string(),
    target_classification: PlacementClassSchema,
    peer_classification: PlacementClassSchema,
    product_line_continuity_grade: ContinuitySchema,
    gate_result: z.string(),
    business_unit: z.string(),
    target_product_line: z.string(),
    peer_product_line: z.string(),
    continuity_reason: z.string(),
    target_latest_api_date: z.string().refine(isIsoDate),
    target_days_since_latest: z.number().int().nonnegative(),
    peer_latest_api_date: z.string().refine(isIsoDate),
    peer_days_since_latest: z.number().int().nonnegative(),
    target_evidence: VerifiedEvidenceSchema,
    peer_evidence: VerifiedEvidenceSchema
  })
  .passthrough();

export const VerificationLedgerSchema = z
  .object({
    verified_at: z.string().refine(isIsoDate),
    scope: z.object({
      target: z.string(),
      target_history_reused: z.boolean(),
      peer_window: z.object({
        since: z.string().refine(isIsoDate),
        until: z.string().refine(isIsoDate)
      }),
      manual_review: z.string()
    }),
    rubric: z.object({
      strict_pass_gate: z.string()
    }).passthrough(),
    peer_inventory: z.array(PeerInventorySchema),
    overlaps: z.array(StrictOverlapSchema),
    first_pilot_reclassification: z
      .object({
        raw_overlaps: z.number().int().nonnegative(),
        inclusive_accepted: z.number().int().nonnegative(),
        strict_passes: z.number().int().nonnegative(),
        results: z.array(
          z.object({
            domain: z.string(),
            strict_result: z.string(),
            reason: z.string()
          })
        )
      })
      .optional()
  })
  .passthrough();

export type SponsorsPageWire = z.infer<typeof SponsorsPageWireSchema>;
export type SponsorSummaryWire = z.infer<typeof SponsorSummaryWireSchema>;
export type CreatorWire = z.infer<typeof CreatorWireSchema>;
export type CreatorBatchResponseWire = z.infer<
  typeof CreatorBatchResponseWireSchema
>;
export type SimilarCreatorsResponseWire = z.infer<
  typeof SimilarCreatorsResponseWireSchema
>;
export type PilotConfig = z.infer<typeof PilotConfigSchema>;
export type PeerInventory = z.infer<typeof PeerInventorySchema>;
export type VerificationLedger = z.infer<typeof VerificationLedgerSchema>;

export function assertVerificationLedgerMatchesPilotConfig(
  ledger: VerificationLedger,
  config: PilotConfig
): VerificationLedger {
  const configuredPeers = new Set(config.peers.map((peer) => peer.name));
  const reviewedPeers = new Set(
    ledger.peer_inventory.map((row) => row.channel)
  );
  const samePeerCohort =
    configuredPeers.size === reviewedPeers.size &&
    [...configuredPeers].every((peer) => reviewedPeers.has(peer));
  const overlapsBelongToCohort = ledger.overlaps.every(
    (overlap) =>
      overlap.target_evidence.channel === config.target.name &&
      configuredPeers.has(overlap.peer_evidence.channel)
  );
  const samePeerWindow =
    ledger.scope.peer_window.since === config.peer_window.since &&
    ledger.scope.peer_window.until === config.peer_window.until;

  if (
    ledger.scope.target !== config.target.name ||
    !samePeerWindow ||
    !samePeerCohort ||
    !overlapsBelongToCohort
  ) {
    throw new Error(
      "Verification ledger does not match the configured pilot target, peer window, and cohort"
    );
  }

  return ledger;
}

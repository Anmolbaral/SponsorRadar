import type { AuditEvent, AuditPhase } from "@/src/observability/audit";
import { AuditRecorder, fingerprint } from "@/src/observability/audit";
import type { VerificationLedger } from "@/src/radar/adapters/upriver/contracts";
import type {
  NormalizedSponsorEvidence,
  NormalizedSponsorEvidenceResult,
  SponsorTrackingStatus
} from "@/src/radar/adapters/upriver/normalize";
import {
  UpriverHttpError,
  type UpriverErrorCode
} from "@/src/radar/adapters/upriver/http-client";
import type {
  LockedPeer,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import {
  EvidenceToolExecutor,
  type ToolExecutionStage
} from "@/src/radar/application/tools/tool-executor";
import { composeResolutionCredits } from "@/src/radar/application/tools/tool-registry";
import { coverageWarning } from "@/src/radar/domain/coverage";
import {
  estimateUpriverCredits,
  UPRIVER_CREDIT_RATES
} from "@/src/radar/domain/credits";
import { daysBetween, isBeforeExclusive } from "@/src/radar/domain/dates";
import { normalizeDomain } from "@/src/radar/domain/domains";
import {
  selectStrictCandidates
} from "@/src/radar/domain/eligibility";
import { latestByKey } from "@/src/radar/domain/latest-by-key";
import { isReachComparable } from "@/src/radar/domain/reach";
import {
  parseYouTubeIdentity,
  sameVerifiedYouTubeIdentity,
  YouTubeTargetVerificationError,
  type VerifiedYouTubeIdentity
} from "@/src/radar/domain/youtube";
import type {
  CoverageNotice,
  Evidence,
  QualificationPolicy,
  QualifiedLead,
  StrictCandidate,
  TargetSummary,
  WinbackReport
} from "@/src/radar/domain/types";

export interface RunWinbackReportInput {
  channel: string;
  maximumCredits?: number;
}

export interface RunWinbackReportOptions {
  audit?: AuditRecorder;
  now?: () => number;
  phase?: AuditPhase;
  allowPartialPeerFailure?: boolean;
  /**
   * Which registry stage authorizes this run's evidence operations. The
   * workflow's execution checkpoint passes "execution"; a directly invoked
   * report runs as "report", whose spend authorization is the credit
   * preflight below.
   */
  executionStage?: Extract<ToolExecutionStage, "execution" | "report">;
  approvedCohort?: {
    target: TargetSummary;
    identity: VerifiedYouTubeIdentity;
    peers: readonly LockedPeer[];
    cohortHash: string;
  };
}

export interface RunWinbackReportResult {
  report: WinbackReport;
  events: readonly AuditEvent[];
}

export class RunCreditBudgetExceededError extends Error {
  constructor(
    readonly estimatedCredits: number,
    readonly maximumCredits: number
  ) {
    super(
      `The live report can reserve up to ${estimatedCredits} credits, above the ${maximumCredits}-credit run limit`
    );
    this.name = "RunCreditBudgetExceededError";
  }
}

interface PeerEvidenceRow {
  peer: LockedPeer;
  sponsor: NormalizedSponsorEvidence;
  verification: VerificationLedger["peer_inventory"][number] | null;
  resolvedDomain: string | null;
}

interface DynamicQualification {
  peerRows: PeerEvidenceRow[];
  evidenceBackedPeerRows: PeerEvidenceRow[];
  joinableEvidenceBackedPeerRows: PeerEvidenceRow[];
  rawMatches: PeerEvidenceRow[];
  leads: QualifiedLead[];
}

export async function runWinbackReport(
  input: RunWinbackReportInput,
  evidencePort: SponsorRadarEvidencePort,
  options: RunWinbackReportOptions = {}
): Promise<RunWinbackReportResult> {
  const now = options.now ?? Date.now;
  const mode = evidencePort.mode;
  const phase =
    options.phase ??
    (mode === "live" ? ("report_live" as const) : ("report_fixture" as const));
  const audit =
    options.audit ?? new AuditRecorder({ clock: now, mode, phase });
  const maximumCredits = input.maximumCredits ?? 150;
  const qualificationPolicy = evidenceQualificationPolicy(evidencePort);
  await evidencePort.prepareRun?.(input.channel);
  const useFreshApprovedTarget =
    mode === "live" &&
    options.approvedCohort !== undefined &&
    evidencePort.resolveTargetFresh !== undefined;
  const estimatedRunCredits =
    evidencePort.estimateRunCredits() +
    (useFreshApprovedTarget
      ? evidencePort.estimateCredits("resolve_target")
      : 0);

  audit.startRun({ channel: input.channel });
  const allowed = estimatedRunCredits <= maximumCredits;
  audit.recordPolicy({
    decision: allowed ? "allow" : "deny",
    reason:
      mode === "fixture"
        ? "Fixture mode is network-disabled and spends zero credits"
        : allowed
          ? "Live mode passed the conservative cache-aware credit preflight"
          : "Live mode was denied before any Upriver request because its reservation exceeds the run limit",
    estimatedCredits: estimatedRunCredits,
    resultBasedCredits: 0,
    maximumCredits,
    remainingCredits: Math.max(0, maximumCredits - estimatedRunCredits)
  });
  if (!allowed) {
    throw new RunCreditBudgetExceededError(
      estimatedRunCredits,
      maximumCredits
    );
  }

  const tools = new EvidenceToolExecutor({
    port: evidencePort,
    audit,
    stage: options.executionStage ?? "report"
  });
  const resolved = await tools.execute(
    "resolve_target",
    { channel: input.channel, fresh: useFreshApprovedTarget },
    {
      reason: "Confirm the exact requested YouTube channel before research",
      auditInput: { channel: input.channel }
    }
  );
  assertResolvedTargetContract(resolved);
  if (options.approvedCohort) {
    assertApprovedTarget(
      options.approvedCohort.target,
      options.approvedCohort.identity,
      resolved.target,
      resolved.identity
    );
  }

  let ledger: VerificationLedger | null = null;
  if (qualificationPolicy === "verified_product_continuity") {
    ledger = await tools.execute(
      "load_verification_ledger",
      { ledgerKey: "reach-matched-pilot-2026-07-19" },
      {
        reason: "Load manual S3 and product-continuity verification",
        auditInput: { pilot: "reach_matched_2026_07_19" }
      }
    );
  }

  const peers = options.approvedCohort
    ? await audit.tool(
        {
          name: "local.load_approved_peer_cohort",
          reason:
            "Use the exact persisted peer cohort bound to execution approval",
          mode: "fixture",
          input: {
            cohortHash: options.approvedCohort.cohortHash
          },
          cacheStatus: "hit",
          estimatedCredits: 0
        },
        async () => {
          assertApprovedCohort(options.approvedCohort!);
          return options.approvedCohort!.peers.map((peer) => ({
            ...peer
          }));
        },
        (rows) => ({ rows: rows.length })
      )
    : await loadLockedPeers(
        tools,
        mode,
        resolved.target.url,
        resolved.target.subscriberCount
      );

  // Validate the cheap creator responses and local verification before any
  // sponsor search can consume the much larger per-result credit allocation.
  for (const peer of peers) {
    if (
      !isReachComparable(
        resolved.target.subscriberCount,
        peer.subscriberCount
      )
    ) {
      throw new Error(`${peer.name} falls outside the locked reach window`);
    }
  }

  const peerSponsorResults: NormalizedSponsorEvidenceResult[] = [];
  const failedPeers: string[] = [];

  const researchTargetSponsors =
    (): Promise<NormalizedSponsorEvidenceResult> =>
      tools.execute(
        "list_target_sponsors",
        { targetUrl: resolved.target.url },
        {
          reason:
            mode === "live"
              ? "Retrieve explicit sponsorships from the verified 365-day target window"
              : "Load the captured 365-day target sponsor history",
          auditInput: {
            publicationUrl: resolved.target.url,
            window: resolved.config.target_window
          }
        }
      );

  const researchPeerSponsors = async (): Promise<void> => {
    for (const peer of peers) {
      // Paid peer searches are intentionally serial: after each response the
      // gateway reconciles the result-based estimate before the next reservation.
      try {
        peerSponsorResults.push(
          await tools.execute(
            "list_peer_sponsors",
            { peerUrl: peer.url },
            {
              reason: `${
                mode === "live" ? "Retrieve" : "Load captured"
              } recent explicit sponsorships for approved peer ${peer.name}`,
              auditInput: {
                publicationUrl: peer.url,
                window: resolved.config.peer_window,
                sponsorTypes: resolved.config.sponsor_types
              }
            }
          )
        );
      } catch (error) {
        if (
          !options.allowPartialPeerFailure ||
          !canTreatPeerFailureAsPartial(mode, error)
        ) {
          throw error;
        }
        failedPeers.push(peer.name);
        peerSponsorResults.push({
          rows: [],
          completeness: "partial",
          trackingStatus: {
            publicationUrl: peer.url,
            channelName: peer.name,
            status: "failed",
            message:
              "Peer sponsor research failed; successful peer evidence was preserved."
          }
        });
      }
    }
  };

  // Research ordering by qualification policy:
  // - verified_product_continuity keeps target-first: its strict gate joins the
  //   target's stale sponsors against the manual verification ledger.
  // - same_brand_reactivation researches peers first and exits before the paid
  //   target-history search when no evidence-backed peer signal qualifies, so a
  //   no-signal run settles only the work it actually performed.
  let targetSponsorResult: NormalizedSponsorEvidenceResult | null;
  let targetHistorySearched: boolean;
  if (qualificationPolicy === "same_brand_reactivation") {
    await researchPeerSponsors();
    const qualifyingPeerSignal = joinPeerEvidence(
      peers,
      peerSponsorResults.map((result) => result.rows)
    ).filter(
      (row) =>
        sponsorMatchesApprovedIdentity(row.sponsor, row.peer.url) &&
        hasExplicitApiEvidence(row.sponsor) &&
        isWithinWindow(
          row.sponsor.publishedDate,
          resolved.config.peer_window
        ) &&
        row.resolvedDomain !== null
    );
    if (qualifyingPeerSignal.length === 0) {
      targetSponsorResult = null;
      targetHistorySearched = false;
    } else {
      targetSponsorResult = await researchTargetSponsors();
      targetHistorySearched = true;
    }
  } else {
    targetSponsorResult = await researchTargetSponsors();
    targetHistorySearched = true;
    await researchPeerSponsors();
  }

  const targetSponsors = targetSponsorResult?.rows ?? [];
  const peerSponsorSets = peerSponsorResults.map((result) => result.rows);

  const qualificationTargetSponsors =
    qualificationPolicy === "same_brand_reactivation"
      ? targetSponsors.filter(
          (sponsor) =>
            sponsorMatchesApprovedIdentity(
              sponsor,
              resolved.target.url
            ) &&
            isWithinWindow(
              sponsor.publishedDate,
              resolved.config.target_window
            )
        )
      : targetSponsors;
  const latestDomainResolved = latestByKey(
    qualificationTargetSponsors,
    (sponsor) => sponsor.normalizedDomain,
    (sponsor) => sponsor.publishedDate
  );
  const staleDomainResolved = latestDomainResolved.filter(
    (sponsor) =>
      isBeforeExclusive(
        sponsor.publishedDate,
        resolved.config.stale_cutoff_exclusive
      )
  );
  const staleExplicit = staleDomainResolved.filter(
    (sponsor) => sponsor.placementType === "explicit_ad"
  );
  let peerRows: PeerEvidenceRow[];
  let verifiedS3: PeerEvidenceRow[];
  let joinableS3: PeerEvidenceRow[];
  let rawMatches: PeerEvidenceRow[];
  let leads: QualifiedLead[];
  let peerCoverageNumerator: number;
  let peerCoverageDenominator: number;
  let peerCoverageSubject: string;

  if (qualificationPolicy === "same_brand_reactivation") {
    const dynamic = qualifySameBrandReactivations({
      target: resolved.target,
      staleExplicitTargets: staleExplicit,
      peers,
      peerSponsorSets,
      peerWindow: resolved.config.peer_window,
      asOf: resolved.config.as_of
    });
    peerRows = dynamic.peerRows;
    verifiedS3 = [];
    joinableS3 = [];
    rawMatches = dynamic.rawMatches;
    leads = dynamic.leads;
    peerCoverageNumerator =
      dynamic.joinableEvidenceBackedPeerRows.length;
    peerCoverageDenominator = dynamic.evidenceBackedPeerRows.length;
    peerCoverageSubject =
      "Evidence-backed peer sponsors joinable by exact normalized domain";
  } else {
    if (!ledger) {
      throw new Error("Strict qualification requires a verification ledger");
    }
    peerRows = joinPeerVerification(peers, peerSponsorSets, ledger);
    verifiedS3 = peerRows.filter(
      (row) => row.verification?.strict_classification === "S3"
    );
    joinableS3 = verifiedS3.filter(
      (row) => row.resolvedDomain !== null
    );
    const staleDomains = new Set(
      staleExplicit.flatMap((row) =>
        row.normalizedDomain ? [row.normalizedDomain] : []
      )
    );
    rawMatches = joinableS3.filter(
      (row) => row.resolvedDomain && staleDomains.has(row.resolvedDomain)
    );
    const rawMatchDomains = new Set(
      rawMatches.flatMap((row) =>
        row.resolvedDomain ? [row.resolvedDomain] : []
      )
    );

    const strictCandidates = ledger.overlaps
      .filter(
        (overlap) =>
          rawMatchDomains.has(normalizeDomain(overlap.domain) ?? "") &&
          targetSponsors.some((sponsor) =>
            sponsorMatchesVerifiedEvidence(
              sponsor,
              overlap.domain,
              overlap.target_evidence
            )
          ) &&
          rawMatches.some((row) =>
            peerRowMatchesVerifiedEvidence(
              row,
              overlap.domain,
              overlap.peer_evidence
            )
          )
      )
      .map(toStrictCandidate);
    const selectedCandidates = selectStrictCandidates(strictCandidates, 3);
    leads = selectedCandidates.map((candidate) =>
      toQualifiedLead(
        candidate,
        ledger,
        targetSponsors,
        peerRows,
        resolved.config.as_of
      )
    );
    peerCoverageNumerator = joinableS3.length;
    peerCoverageDenominator = verifiedS3.length;
    peerCoverageSubject = "Verified peer sponsors joinable by domain";
  }

  const targetDomains = qualificationTargetSponsors.filter(
    (sponsor) => sponsor.normalizedDomain !== null
  ).length;
  const coverage = buildCoverage(
    targetDomains,
    targetSponsors.length,
    peerCoverageNumerator,
    peerCoverageDenominator,
    peerCoverageSubject,
    targetSponsorResult,
    peers.map((peer, index) => ({
      label: peer.name,
      result: peerSponsorResults[index]
    })),
    failedPeers,
    targetHistorySearched
  );
  const projectedLiveCredits = estimateUpriverCredits({
    groupedSponsorResults:
      targetSponsors.filter(
        (sponsor) => sponsor.placementType === "explicit_ad"
      ).length + peerRows.length,
    creatorResults: projectedCreatorResults(
      evidencePort,
      qualificationPolicy,
      peers.length
    )
  });

  audit.reportReady(leads.length);

  const report: WinbackReport = {
    schemaVersion: 1,
    runId: audit.runId,
    phase,
    generatedAt: new Date(now()).toISOString(),
    asOf: resolved.config.as_of,
    target: resolved.target,
    targetIdentity: resolved.identity,
    methodology: {
      targetWindow: resolved.config.target_window,
      peerWindow: resolved.config.peer_window,
      staleCutoffExclusive: resolved.config.stale_cutoff_exclusive,
      strictGate:
        qualificationPolicy === "verified_product_continuity"
          ? ledger!.rubric.strict_pass_gate
          : "Exact normalized sponsor-domain match across evidence-backed explicit ads; product line, campaign, and buyer are unverified.",
      qualificationPolicy,
      mode
    },
    funnel: {
      targetApiRows: targetSponsors.length,
      staleDomainResolvedTargets: staleDomainResolved.length,
      staleExplicitTargetCandidates: staleExplicit.length,
      strictPeerApiRows: peerRows.length,
      manuallyConfirmedS3PeerRows: verifiedS3.length,
      joinableS3PeerRows: joinableS3.length,
      rawDomainMatches: rawMatches.length,
      strictProductContinuousPasses:
        qualificationPolicy === "verified_product_continuity"
          ? leads.length
          : 0,
      sameBrandReactivationPasses:
        qualificationPolicy === "same_brand_reactivation"
          ? leads.length
          : 0
    },
    leads,
    coverage,
    audit: audit.summarize(projectedLiveCredits)
  };

  return { report, events: audit.getEvents() };
}

export function approvedCohortHash(
  target: TargetSummary,
  peers: readonly LockedPeer[],
  identity: VerifiedYouTubeIdentity | null = null
): string {
  if (identity === null) {
    return fingerprint({
      policyVersion: "approved-cohort-v1",
      target: {
        name: target.name,
        url: target.url,
        subscriberCount: target.subscriberCount
      },
      peers: peers.map((peer) => ({
        name: peer.name,
        url: peer.url,
        subscriberCount: peer.subscriberCount,
        creatorId: peer.creatorId
      }))
    });
  }
  return fingerprint({
    policyVersion: "approved-cohort-v2",
    target: {
      name: target.name,
      url: target.url,
      subscriberCount: target.subscriberCount
    },
    identity,
    peers: peers.map((peer) => ({
      name: peer.name,
      url: peer.url,
      subscriberCount: peer.subscriberCount,
      creatorId: peer.creatorId
    }))
  });
}

function loadLockedPeers(
  tools: EvidenceToolExecutor,
  mode: SponsorRadarEvidencePort["mode"],
  targetUrl: string,
  targetSubscriberCount: number
): Promise<LockedPeer[]> {
  return tools.execute(
    "list_locked_peers",
    { targetUrl, targetSubscriberCount },
    {
      reason:
        mode === "live"
          ? "Resolve the reach-matched peer cohort fixed before overlap review"
          : "Load the reach-matched peer cohort fixed before overlap review",
      auditInput: { publicationUrl: targetUrl }
    }
  );
}

function assertApprovedTarget(
  approved: TargetSummary,
  approvedIdentity: VerifiedYouTubeIdentity,
  resolved: TargetSummary,
  resolvedIdentity: VerifiedYouTubeIdentity
): void {
  if (
    !sameVerifiedYouTubeIdentity(approvedIdentity, resolvedIdentity) ||
    approved.subscriberCount !== resolved.subscriberCount
  ) {
    throw new YouTubeTargetVerificationError(
      "target_identity_mismatch",
      "Resolved target differs from the target bound to execution approval"
    );
  }
}

function assertResolvedTargetContract(
  resolved: Awaited<
    ReturnType<SponsorRadarEvidencePort["resolveTarget"]>
  >
): void {
  try {
    const canonical = parseYouTubeIdentity(
      resolved.identity.canonicalUrl
    );
    const identityCanonicalValid =
      resolved.identity.verificationBasis === "channel_id"
        ? resolved.identity.key ===
            `channel:${resolved.identity.channelId}` &&
          (canonical.kind === "channel_id"
            ? resolved.identity.handle === null &&
              canonical.channelId === resolved.identity.channelId
            : canonical.kind === "handle" &&
              resolved.identity.handle !== null &&
              canonical.requestKey ===
                parseYouTubeIdentity(
                  resolved.identity.handle
                ).requestKey)
        : canonical.kind === "handle" &&
          resolved.identity.channelId === null &&
          canonical.requestKey === resolved.identity.key &&
          canonical.requestKey ===
            parseYouTubeIdentity(
              resolved.identity.handle
            ).requestKey;
    if (
      canonical.lookupUrl !== resolved.identity.canonicalUrl ||
      resolved.target.url !== resolved.identity.canonicalUrl ||
      !resolved.target.name.trim() ||
      !Number.isSafeInteger(resolved.target.subscriberCount) ||
      resolved.target.subscriberCount <= 0 ||
      !identityCanonicalValid
    ) {
      throw new Error("Resolved target fields disagree");
    }
  } catch {
    throw new YouTubeTargetVerificationError(
      "target_not_verified",
      "Resolved target evidence was internally inconsistent"
    );
  }
}

function assertApprovedCohort(cohort: {
  target: TargetSummary;
  identity: VerifiedYouTubeIdentity;
  peers: readonly LockedPeer[];
  cohortHash: string;
}): void {
  const peerIdentityKeys = cohort.peers.map((peer) =>
    parseYouTubeIdentity(peer.url).key
  );
  if (
    cohort.peers.length < 1 ||
    cohort.peers.length > 3 ||
    new Set(peerIdentityKeys).size !== cohort.peers.length ||
    new Set(
      cohort.peers.map(
        (peer, index) =>
          peer.creatorId ?? `youtube:${peerIdentityKeys[index]}`
      )
    ).size !== cohort.peers.length
  ) {
    throw new Error(
      "Approved peer cohort has invalid cardinality or duplicate identities"
    );
  }
  if (
    approvedCohortHash(
      cohort.target,
      cohort.peers,
      cohort.identity
    ) !== cohort.cohortHash
  ) {
    throw new Error("Approved peer cohort hash does not match its contents");
  }
  for (const peer of cohort.peers) {
    if (
      !isReachComparable(
        cohort.target.subscriberCount,
        peer.subscriberCount
      )
    ) {
      throw new Error(
        `${peer.name} falls outside the approved reach window`
      );
    }
  }
}

const NO_SPEND_TERMINAL_UPRIVER_ERRORS = new Map<
  UpriverErrorCode,
  number | null
>([
  ["invalid_request", null],
  ["bad_request", 400],
  ["authentication_failed", 401],
  ["permission_denied", 403]
]);

function canTreatPeerFailureAsPartial(
  mode: SponsorRadarEvidencePort["mode"],
  error: unknown
): boolean {
  if (mode === "fixture") {
    return true;
  }
  if (!(error instanceof UpriverHttpError)) {
    return false;
  }
  const expectedStatus = NO_SPEND_TERMINAL_UPRIVER_ERRORS.get(error.code);
  if (
    expectedStatus === undefined ||
    error.status !== expectedStatus
  ) {
    return false;
  }
  if (error.code === "invalid_request") {
    return error.meta.attempts.length === 0;
  }
  return (
    error.meta.attempts.length > 0 &&
    error.meta.attempts.every(
      (attempt) =>
        attempt.outcome === "http_error" &&
        attempt.status === expectedStatus
    )
  );
}

function evidenceQualificationPolicy(
  evidencePort: SponsorRadarEvidencePort
): QualificationPolicy {
  const policy = (
    evidencePort as SponsorRadarEvidencePort & {
      readonly qualificationPolicy?: QualificationPolicy;
    }
  ).qualificationPolicy;

  if (policy === undefined) {
    return "verified_product_continuity";
  }
  if (
    policy !== "verified_product_continuity" &&
    policy !== "same_brand_reactivation"
  ) {
    throw new Error(`Unsupported evidence qualification policy: ${policy}`);
  }
  return policy;
}

function qualifySameBrandReactivations(input: {
  target: TargetSummary;
  staleExplicitTargets: NormalizedSponsorEvidence[];
  peers: LockedPeer[];
  peerSponsorSets: NormalizedSponsorEvidence[][];
  peerWindow: { since: string; until: string };
  asOf: string;
}): DynamicQualification {
  const peerRows = joinPeerEvidence(input.peers, input.peerSponsorSets);
  const eligibleTargets = input.staleExplicitTargets.filter(
    (sponsor) =>
      sponsor.normalizedDomain !== null &&
      sponsorMatchesApprovedIdentity(sponsor, input.target.url) &&
      hasExplicitApiEvidence(sponsor)
  );
  const targetByDomain = new Map(
    eligibleTargets.map((sponsor) => [
      sponsor.normalizedDomain!,
      sponsor
    ])
  );
  const evidenceBackedPeerRows = peerRows.filter(
    (row) =>
      sponsorMatchesApprovedIdentity(row.sponsor, row.peer.url) &&
      hasExplicitApiEvidence(row.sponsor) &&
      isWithinWindow(row.sponsor.publishedDate, input.peerWindow)
  );
  const joinableEvidenceBackedPeerRows = evidenceBackedPeerRows.filter(
    (row) => row.resolvedDomain !== null
  );
  const rawMatches = joinableEvidenceBackedPeerRows.filter(
    (row) =>
      row.resolvedDomain !== null &&
      targetByDomain.has(row.resolvedDomain)
  );
  const ranked = rawMatches
    .map((peerRow) => ({
      peerRow,
      targetSponsor: targetByDomain.get(peerRow.resolvedDomain!)!
    }))
    .sort(
      (left, right) =>
        right.peerRow.sponsor.publishedDate.localeCompare(
          left.peerRow.sponsor.publishedDate
        ) ||
        left.targetSponsor.publishedDate.localeCompare(
          right.targetSponsor.publishedDate
        ) ||
        left.peerRow.resolvedDomain!.localeCompare(
          right.peerRow.resolvedDomain!
        ) ||
        left.peerRow.peer.url.localeCompare(right.peerRow.peer.url) ||
        left.peerRow.sponsor.contentUrl.localeCompare(
          right.peerRow.sponsor.contentUrl
        )
    );
  const selectedDomains = new Set<string>();
  const leads: QualifiedLead[] = [];

  for (const candidate of ranked) {
    const domain = candidate.peerRow.resolvedDomain!;
    if (selectedDomains.has(domain)) continue;
    selectedDomains.add(domain);
    leads.push(
      toSameBrandReactivationLead(
        candidate.targetSponsor,
        candidate.peerRow,
        input.target,
        input.asOf
      )
    );
    if (leads.length === 3) break;
  }

  return {
    peerRows,
    evidenceBackedPeerRows,
    joinableEvidenceBackedPeerRows,
    rawMatches,
    leads
  };
}

function joinPeerEvidence(
  peers: LockedPeer[],
  peerSponsorSets: NormalizedSponsorEvidence[][]
): PeerEvidenceRow[] {
  return peers.flatMap((peer, peerIndex) =>
    peerSponsorSets[peerIndex].map((sponsor) => ({
      peer,
      sponsor,
      verification: null,
      resolvedDomain: normalizeDomain(sponsor.normalizedDomain)
    }))
  );
}

function sponsorMatchesApprovedIdentity(
  sponsor: NormalizedSponsorEvidence,
  approvedUrl: string
): boolean {
  return sameYouTubeIdentity(sponsor.publicationUrl, approvedUrl);
}

function sameYouTubeIdentity(
  firstUrl: string,
  secondUrl: string
): boolean {
  try {
    return (
      parseYouTubeIdentity(firstUrl).key ===
      parseYouTubeIdentity(secondUrl).key
    );
  } catch {
    return false;
  }
}

function projectedCreatorResults(
  evidencePort: SponsorRadarEvidencePort,
  qualificationPolicy: QualificationPolicy,
  selectedPeerCount: number
): number {
  if (qualificationPolicy !== "same_brand_reactivation") {
    return selectedPeerCount + 1;
  }
  const projectedCreatorCredits = composeResolutionCredits((operation) =>
    evidencePort.estimateCredits(operation)
  );
  if (
    !Number.isInteger(projectedCreatorCredits) ||
    projectedCreatorCredits < 0 ||
    projectedCreatorCredits % UPRIVER_CREDIT_RATES.creatorResult !== 0
  ) {
    throw new Error(
      "Dynamic creator credit projection must map to a whole number of creator results"
    );
  }
  return (
    projectedCreatorCredits / UPRIVER_CREDIT_RATES.creatorResult
  );
}

function hasExplicitApiEvidence(
  sponsor: NormalizedSponsorEvidence
): boolean {
  return (
    sponsor.placementType === "explicit_ad" &&
    sponsor.evidenceSource !== null &&
    sponsor.excerpt !== null &&
    sponsor.evidenceConfidence !== null &&
    sponsor.evidenceConfidence > 0
  );
}

function isWithinWindow(
  date: string,
  window: { since: string; until: string }
): boolean {
  return (
    daysBetween(window.since, date) >= 0 &&
    daysBetween(date, window.until) >= 0
  );
}

function toSameBrandReactivationLead(
  targetSponsor: NormalizedSponsorEvidence,
  peerRow: PeerEvidenceRow,
  target: TargetSummary,
  asOf: string
): QualifiedLead {
  const domain = targetSponsor.normalizedDomain;
  if (
    !domain ||
    domain !== peerRow.resolvedDomain ||
    !hasExplicitApiEvidence(targetSponsor) ||
    !hasExplicitApiEvidence(peerRow.sponsor)
  ) {
    throw new Error(
      "A same-brand reactivation candidate lost its required API evidence"
    );
  }

  return {
    brand: targetSponsor.sponsorName,
    domain,
    peer: peerRow.peer.name,
    peerUrl: peerRow.peer.url,
    peerSubscriberCount: peerRow.peer.subscriberCount,
    continuity: "U",
    targetProductLine: "Unverified",
    peerProductLine: "Unverified",
    continuityReason: `Exact normalized sponsor-domain match (${domain}) between evidence-backed explicit placements. This is a domain-level brand match only; product line, campaign continuity, and buyer identity are unverified.`,
    targetObservedPlacements: targetSponsor.totalAdsFound,
    targetFirstObservedDate:
      targetSponsor.totalAdsFound === 1
        ? targetSponsor.publishedDate
        : null,
    peerObservedPlacements: peerRow.sponsor.totalAdsFound,
    peerFirstObservedDate:
      peerRow.sponsor.totalAdsFound === 1
        ? peerRow.sponsor.publishedDate
        : null,
    targetDaysSinceLatest: daysSinceEvidence(
      targetSponsor.publishedDate,
      asOf
    ),
    peerDaysSinceLatest: daysSinceEvidence(
      peerRow.sponsor.publishedDate,
      asOf
    ),
    targetEvidence: toApiEvidence(targetSponsor, target.name),
    peerEvidence: toApiEvidence(peerRow.sponsor, peerRow.peer.name),
    outreachHypothesis: `${targetSponsor.sponsorName} has an older evidence-backed explicit placement on ${target.name}, while ${peerRow.peer.name} has a more recent explicit placement matched by exact normalized sponsor domain. This is worth researching as a possible same-brand reactivation opportunity; the available evidence does not verify the same product line, campaign, or buyer.`
  };
}

function toApiEvidence(
  sponsor: NormalizedSponsorEvidence,
  approvedChannelName: string
): Evidence {
  if (
    sponsor.excerpt === null ||
    sponsor.evidenceSource === null ||
    sponsor.evidenceConfidence === null ||
    sponsor.evidenceConfidence <= 0
  ) {
    throw new Error("API evidence is incomplete");
  }
  return {
    contentUrl: sponsor.contentUrl,
    publishedDate: sponsor.publishedDate,
    excerpt: sponsor.excerpt,
    channel: approvedChannelName,
    videoTitle: "Not provided by Upriver /v1/sponsors",
    source: sponsor.evidenceSource,
    confidence: sponsor.evidenceConfidence
  };
}

function joinPeerVerification(
  peers: LockedPeer[],
  peerSponsorSets: NormalizedSponsorEvidence[][],
  ledger: VerificationLedger
): PeerEvidenceRow[] {
  return peers.flatMap((peer, peerIndex) =>
    peerSponsorSets[peerIndex].map((sponsor) => {
      const verification =
        ledger.peer_inventory.find(
          (candidate) =>
            candidate.channel === peer.name &&
            candidate.api_partner_name === sponsor.sponsorName &&
            candidate.api_observed_date === sponsor.publishedDate &&
            candidate.video_url === sponsor.contentUrl
        ) ?? null;
      return {
        peer,
        sponsor,
        verification,
        resolvedDomain: normalizeDomain(
          verification?.manually_resolved_domain ??
            sponsor.normalizedDomain
        )
      };
    })
  );
}

function toStrictCandidate(
  overlap: VerificationLedger["overlaps"][number]
): StrictCandidate {
  return {
    domain: normalizeDomain(overlap.domain),
    brand: overlap.brand,
    targetClass: overlap.target_classification,
    peerClass: overlap.peer_classification,
    continuity: overlap.product_line_continuity_grade,
    verificationPresent: true,
    targetEvidence: toEvidence(overlap.target_evidence),
    peerEvidence: toEvidence(overlap.peer_evidence)
  };
}

function toEvidence(
  input: VerificationLedger["overlaps"][number]["target_evidence"]
): Evidence {
  return {
    contentUrl: input.video_url,
    publishedDate: input.api_observed_date,
    excerpt: input.public_evidence,
    channel: input.channel,
    videoTitle: input.video_title
  };
}

function toQualifiedLead(
  candidate: StrictCandidate,
  ledger: VerificationLedger,
  targetSponsors: NormalizedSponsorEvidence[],
  peerRows: PeerEvidenceRow[],
  asOf: string
): QualifiedLead {
  const overlap = ledger.overlaps.find(
    (item) =>
      normalizeDomain(item.domain) === candidate.domain &&
      verifiedEvidenceMatchesCandidate(
        item.target_evidence,
        candidate.targetEvidence
      ) &&
      verifiedEvidenceMatchesCandidate(
        item.peer_evidence,
        candidate.peerEvidence
      )
  );
  const targetSponsor = targetSponsors.find(
    (sponsor) =>
      overlap !== undefined &&
      sponsorMatchesVerifiedEvidence(
        sponsor,
        overlap.domain,
        overlap.target_evidence
      )
  );
  const peerRow = peerRows.find(
    (row) =>
      overlap !== undefined &&
      peerRowMatchesVerifiedEvidence(
        row,
        overlap.domain,
        overlap.peer_evidence
      )
  );
  if (
    !overlap ||
    !targetSponsor ||
    !peerRow ||
    !candidate.domain ||
    !candidate.targetEvidence ||
    !candidate.peerEvidence ||
    (candidate.continuity !== "A" && candidate.continuity !== "B")
  ) {
    throw new Error("A selected strict candidate lost verified evidence");
  }

  return {
    brand: candidate.brand,
    domain: candidate.domain,
    peer: overlap.peer_evidence.channel,
    peerUrl: peerRow.peer.url,
    peerSubscriberCount: peerRow.peer.subscriberCount,
    continuity: candidate.continuity,
    targetProductLine: overlap.target_product_line,
    peerProductLine: overlap.peer_product_line,
    continuityReason: overlap.continuity_reason,
    targetObservedPlacements: targetSponsor.totalAdsFound,
    targetFirstObservedDate:
      targetSponsor.totalAdsFound === 1 ? targetSponsor.publishedDate : null,
    peerObservedPlacements: peerRow.sponsor.totalAdsFound,
    peerFirstObservedDate:
      peerRow.sponsor.totalAdsFound === 1
        ? peerRow.sponsor.publishedDate
        : null,
    targetDaysSinceLatest: daysSinceEvidence(
      overlap.target_evidence.api_observed_date,
      asOf
    ),
    peerDaysSinceLatest: daysSinceEvidence(
      overlap.peer_evidence.api_observed_date,
      asOf
    ),
    targetEvidence: candidate.targetEvidence,
    peerEvidence: candidate.peerEvidence,
    outreachHypothesis: `${candidate.brand} sponsored ${overlap.peer_evidence.channel} for ${overlap.peer_product_line} after the latest ${candidate.brand} sponsorship we found on ${overlap.target_evidence.channel}. Both placements promoted the same product family. This makes ${candidate.brand} worth researching for outreach, but it does not prove that the same campaign or buyer is still active.`
  };
}

function sponsorMatchesVerifiedEvidence(
  sponsor: NormalizedSponsorEvidence,
  domain: string,
  evidence: VerificationLedger["overlaps"][number]["target_evidence"]
): boolean {
  return (
    sponsor.normalizedDomain === normalizeDomain(domain) &&
    sponsor.publishedDate === evidence.api_observed_date &&
    sponsor.contentUrl === evidence.video_url
  );
}

function peerRowMatchesVerifiedEvidence(
  row: PeerEvidenceRow,
  domain: string,
  evidence: VerificationLedger["overlaps"][number]["peer_evidence"]
): boolean {
  return (
    row.verification !== null &&
    row.resolvedDomain === normalizeDomain(domain) &&
    row.peer.name === evidence.channel &&
    row.sponsor.contentUrl === evidence.video_url &&
    row.sponsor.publishedDate === evidence.api_observed_date &&
    row.verification.channel === evidence.channel &&
    row.verification.video_url === evidence.video_url &&
    row.verification.api_observed_date === evidence.api_observed_date
  );
}

function verifiedEvidenceMatchesCandidate(
  evidence: VerificationLedger["overlaps"][number]["target_evidence"],
  candidate: Evidence | null
): boolean {
  return (
    candidate !== null &&
    evidence.channel === candidate.channel &&
    evidence.video_url === candidate.contentUrl &&
    evidence.api_observed_date === candidate.publishedDate
  );
}

function daysSinceEvidence(observedDate: string, asOf: string): number {
  const elapsedDays = daysBetween(observedDate, asOf);
  if (elapsedDays < 0) {
    throw new Error("Verified evidence cannot be later than the pilot as-of date");
  }
  return elapsedDays;
}

function buildCoverage(
  targetDomains: number,
  targetRows: number,
  joinablePeers: number,
  verifiedPeers: number,
  peerCoverageSubject: string,
  targetResult: NormalizedSponsorEvidenceResult | null,
  peerResults: Array<{
    label: string;
    result: NormalizedSponsorEvidenceResult;
  }>,
  failedPeers: readonly string[] = [],
  targetHistorySearched = true
): CoverageNotice[] {
  const resultCapReached =
    targetResult?.completeness === "partial" ||
    peerResults.some(
      ({ label, result }) =>
        result.completeness === "partial" && !failedPeers.includes(label)
    );

  return [
    targetHistorySearched && targetResult
      ? coverageWarning({
          code: "target_domain_coverage",
          numerator: targetDomains,
          denominator: targetRows,
          subject: "Target sponsor rows with a usable domain"
        })
      : ({
          code: "target_history_not_searched",
          severity: "info",
          message:
            "Target sponsor history was not searched because no evidence-backed peer sponsorship signal was found in the selected window."
        } satisfies CoverageNotice),
    coverageWarning({
      code: "peer_domain_joinability",
      numerator: joinablePeers,
      denominator: verifiedPeers,
      subject: peerCoverageSubject
    }),
    targetHistorySearched && targetResult
      ? trackingCoverageWarning(
          "target_tracking_status",
          [{ label: "target channel", status: targetResult.trackingStatus }],
          "target sponsorship response"
        )
      : null,
    trackingCoverageWarning(
      "peer_tracking_status",
      peerResults.map(({ label, result }) => ({
        label,
        status: result.trackingStatus
      })),
      "peer sponsorship responses"
    ),
    {
      code: "grouped_summary_limit",
      severity: "info",
      message:
        "Upriver /v1/sponsors returns each brand’s latest example plus a count, not evidence for every historical placement."
    } satisfies CoverageNotice,
    resultCapReached
      ? ({
          code: "upriver_result_cap",
          severity: "warning",
          message:
            "The live Upriver result or credit cap was reached, so this report may omit qualifying sponsors."
        } satisfies CoverageNotice)
      : null,
    failedPeers.length > 0
      ? ({
          code: "peer_research_partial",
          severity: "warning",
          message: `Sponsor research failed for ${failedPeers.join(
            ", "
          )}. Valid evidence from the remaining peers was preserved, but coverage is partial.`
        } satisfies CoverageNotice)
      : null
  ].filter((notice): notice is CoverageNotice => notice !== null);
}

function trackingCoverageWarning(
  code: Extract<
    CoverageNotice["code"],
    "target_tracking_status" | "peer_tracking_status"
  >,
  sources: Array<{
    label: string;
    status: SponsorTrackingStatus | null;
  }>,
  subject: string
): CoverageNotice | null {
  const missing = sources
    .filter(({ status }) => status === null)
    .map(({ label }) => label);
  const nonActive = sources.filter(
    ({ status }) => status !== null && status.status.toLowerCase() !== "active"
  );
  if (missing.length === 0 && nonActive.length === 0) return null;

  const details = [
    missing.length > 0
      ? `missing for ${missing.join(", ")}`
      : null,
    nonActive.length > 0
      ? `non-active for ${nonActive
          .map(({ label, status }) => `${label} (${status?.status})`)
          .join(", ")}`
      : null
  ].filter((detail): detail is string => detail !== null);

  return {
    code,
    severity: "warning",
    message: `Upriver tracking status is ${details.join(
      "; "
    )} in the ${subject}. The searched window's completeness cannot be confirmed, and zero rows must not be read as proof that no sponsorships exist.`
  };
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { describe, expect, it } from "vitest";
import { FixtureLlmPort } from "@/src/agent/llm/fixture-llm-port";
import { BoundedWordingAgent } from "@/src/agent/orchestrator/wording-agent";
import { CachedEvidenceGateway } from "@/src/radar/adapters/cache/cached-evidence-gateway";
import { FileSystemWorkflowRepository } from "@/src/radar/adapters/persistence";
import {
  UpriverHttpClient,
  type UpriverLifecycleEvent
} from "@/src/radar/adapters/upriver/http-client";
import { LiveUpriverGateway } from "@/src/radar/adapters/upriver/live-evidence-gateway";
import { WorkflowService } from "@/src/radar/application/run-workflow";

const enabled =
  process.env.SPONSOR_RADAR_LIVE_FULL_WORKFLOW === "true";

if (
  enabled &&
  !process.env.UPRIVER_API_KEY?.trim()
) {
  try {
    loadEnvFile(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

const RUN_CREDIT_LIMIT = 160;
const COLD_RUN_CREDIT_QUOTE = 157;
const RESOLUTION_CREDIT_CEILING = 11;
const EXECUTION_CREDIT_CEILING = 146;
const EXPECTED_TARGET_RESOLUTION_OBSERVATIONS = 2;
const DEFAULT_TARGET = "@dwarkeshPatel";

describe("manually approved live-evidence dynamic product workflow", () => {
  it.runIf(enabled)(
    "runs real approval, Upriver evidence, qualification, and bounded deterministic wording",
    async () => {
      const upriverApiKey =
        process.env.UPRIVER_API_KEY?.trim() ?? "";
      if (!upriverApiKey) {
        throw new Error(
          "The full live evidence workflow requires UPRIVER_API_KEY"
        );
      }

      const directory = await mkdtemp(
        path.join(tmpdir(), "sponsor-radar-live-full-")
      );
      const lifecycle: UpriverLifecycleEvent[] = [];
      try {
        const repository = new FileSystemWorkflowRepository({
          directory
        });
        const llm = new FixtureLlmPort();
        const service = new WorkflowService({
          repository,
          mode: "live",
          runCreditLimit: RUN_CREDIT_LIMIT,
          wordingAgent: new BoundedWordingAgent(process.cwd(), llm),
          gatewayFactory: ({ audit, maximumCredits }) => {
            const live = new LiveUpriverGateway(
              process.cwd(),
              new UpriverHttpClient({
                apiKey: upriverApiKey,
                maxRetries: 0,
                attemptTimeoutMs: 20_000,
                observer: (event) => {
                  lifecycle.push(event);
                  audit?.recordHttpLifecycle(event);
                  if (
                    event.phase === "completed" ||
                    event.phase === "failed"
                  ) {
                    process.stdout.write(
                      `${JSON.stringify({
                        type: "sponsor_radar_live_http",
                        phase: event.phase,
                        outcome:
                          event.phase === "completed"
                            ? "success"
                            : "failure",
                        operation: event.audit?.operation ?? null,
                        requestId: event.requestId,
                        providerRequestId:
                          event.meta.providerRequestId,
                        attempts: event.meta.attempts.length,
                        retryCount: Math.max(
                          0,
                          event.meta.attempts.length - 1
                        ),
                        latencyMs: event.meta.latencyMs,
                        rows:
                          event.phase === "completed"
                            ? (event.usage?.rows ?? null)
                            : null,
                        provisionalCredits:
                          event.phase === "completed"
                            ? (event.usage?.resultBasedCredits ?? null)
                            : null,
                        status:
                          event.meta.attempts.at(-1)?.status ?? null,
                        providerIssue:
                          event.phase === "failed"
                            ? {
                                code: event.code,
                                status: event.status
                              }
                            : null
                      })}\n`
                    );
                  }
                }
              }),
              {
                maximumCredits:
                  maximumCredits ?? RUN_CREDIT_LIMIT
              }
            );
            return new CachedEvidenceGateway(live, repository);
          }
        });

        const target =
          process.env.SPONSOR_RADAR_LIVE_TARGET?.trim() ||
          DEFAULT_TARGET;
        const nonce = crypto.randomUUID();
        const created = await service.createRun(
          target,
          `live-full-create-${nonce}`
        );

        expect(created.mode).toBe("live");
        expect(created.status).toBe("awaiting_plan_approval");
        expect(created.accounting).toEqual({
          policy: "per_run_v1",
          maximumCredits: RUN_CREDIT_LIMIT
        });
        expect(created.plan).toMatchObject({
          resolutionCreditCeiling: RESOLUTION_CREDIT_CEILING,
          executionCreditCeiling: EXECUTION_CREDIT_CEILING,
          totalCreditCeiling: COLD_RUN_CREDIT_QUOTE
        });
        expect(created.plan.llmCallCeiling).toBe(2);

        const proposed = await service.approvePlan(created.runId, {
          expectedVersion: created.version,
          planId: created.plan.planId,
          idempotencyKey: `live-full-plan-${nonce}`
        });

        expect(proposed.status).toBe(
          "awaiting_execution_approval"
        );
        expect(proposed.peerProposal).not.toBeNull();
        expect(proposed.peerProposal!.peers.length).toBeGreaterThan(0);
        expect(proposed.peerProposal!.peers.length).toBeLessThanOrEqual(
          3
        );
        expect(proposed.peerProposal!.quote).toMatchObject({
          creditCeiling: EXECUTION_CREDIT_CEILING,
          estimateKind: "maximum_reservation"
        });

        const completed = await service.approveExecution(
          proposed.runId,
          {
            expectedVersion: proposed.version,
            proposalId: proposed.peerProposal!.proposalId,
            quoteId: proposed.peerProposal!.quote.quoteId,
            approvedCreditCeiling:
              proposed.peerProposal!.quote.creditCeiling,
            idempotencyKey: `live-full-execution-${nonce}`
          }
        );

        const terminalHttpEvents = lifecycle.filter(
          (event) =>
            event.phase === "completed" || event.phase === "failed"
        );
        const llmEvents = completed.auditEvents.filter(
          (event) =>
            event.eventType === "llm.completed" ||
            event.eventType === "llm.failed"
        );
        const targetResolutionObservations = terminalHttpEvents.filter(
          (event) =>
            event.phase === "completed" &&
            event.audit?.operation === "live.resolve_target"
        );
        const automaticRetries = terminalHttpEvents.reduce(
          (total, event) =>
            total + Math.max(0, event.meta.attempts.length - 1),
          0
        );
        process.stdout.write(
          `${JSON.stringify({
            type: "sponsor_radar_live_full_result",
            runId: completed.runId,
            status: completed.status,
            state: completed.state.state,
            error: completed.error,
            target: proposed.peerProposal!.target,
            peers: proposed.peerProposal!.peers.map((peer) => ({
              name: peer.name,
              url: peer.url,
              subscriberCount: peer.subscriberCount
            })),
            approvedCreditCeiling:
              proposed.peerProposal!.quote.creditCeiling,
            runMaximumCredits: created.accounting.maximumCredits,
            coldRunCreditQuote: created.plan.totalCreditCeiling,
            quota: completed.quota,
            outcome: completed.outcome,
            coverage: completed.report?.coverage ?? null,
            leadCount: completed.report?.leads.length ?? null,
            leads:
              completed.report?.leads.map((lead) => ({
                brand: lead.brand,
                domain: lead.domain,
                peer: lead.peer,
                continuity: lead.continuity,
                targetProductLine: lead.targetProductLine,
                peerProductLine: lead.peerProductLine
              })) ?? null,
            upriver: terminalHttpEvents.map((event) => ({
              phase: event.phase,
              operation: event.audit?.operation ?? null,
              requestId: event.requestId,
              providerRequestId: event.meta.providerRequestId,
              attempts: event.meta.attempts.length,
              retryCount: Math.max(
                0,
                event.meta.attempts.length - 1
              ),
              latencyMs: event.meta.latencyMs,
              rows:
                event.phase === "completed"
                  ? (event.usage?.rows ?? null)
                  : null,
              provisionalCredits:
                event.phase === "completed"
                  ? (event.usage?.resultBasedCredits ?? null)
                  : null,
              outcome:
                event.phase === "completed" ? "success" : "failure",
              providerIssue:
                event.phase === "failed"
                  ? { code: event.code, status: event.status }
                  : null
            })),
            targetResolutionObservations:
              targetResolutionObservations.length,
            wording: llmEvents.map((event) => ({
              provider: event.llm?.provider ?? null,
              eventType: event.eventType,
              purpose: event.llm?.purpose ?? null,
              providerRequestId:
                event.llm?.providerRequestId ?? null,
              providerResponseId:
                event.llm?.providerResponseId ?? null,
              inputTokens: event.llm?.inputTokens ?? null,
              outputTokens: event.llm?.outputTokens ?? null
            })),
            liveModelBoundary:
              "validated separately with synthetic data only",
            automaticRetries
          })}\n`
        );

        expect(["completed", "partial"]).toContain(completed.status);
        expect(completed.report).not.toBeNull();
        if (completed.status === "partial") {
          expect(
            completed.report!.coverage.some(
              (notice) =>
                notice.code === "peer_research_partial" ||
                notice.code === "upriver_result_cap"
            )
          ).toBe(true);
        }
        expect(completed.report!.methodology.mode).toBe("live");
        expect(completed.report!.methodology.qualificationPolicy).toBe(
          "same_brand_reactivation"
        );
        expect(
          completed.quota.resolutionCreditsUsed +
            completed.quota.executionCreditsUsed
        ).toBeLessThanOrEqual(created.plan.totalCreditCeiling);

        for (const lead of completed.report!.leads) {
          expect(lead.continuity).toBe("U");
          expect(lead.targetProductLine).toBe("Unverified");
          expect(lead.peerProductLine).toBe("Unverified");
          expect(lead.outreachHypothesis.toLowerCase()).toContain(
            "unverified"
          );
        }

        expect(
          lifecycle.filter((event) => event.phase === "failed")
        ).toHaveLength(0);
        expect(terminalHttpEvents.length).toBeGreaterThanOrEqual(4);
        expect(
          new Set(terminalHttpEvents.map((event) => event.requestId)).size
        ).toBe(terminalHttpEvents.length);
        expect(
          terminalHttpEvents.every(
            (event) => event.requestId.trim().length > 0
          )
        ).toBe(true);
        expect(targetResolutionObservations).toHaveLength(
          EXPECTED_TARGET_RESOLUTION_OBSERVATIONS
        );
        expect(
          terminalHttpEvents.every(
            (event) => event.meta.attempts.length === 1
          )
        ).toBe(true);
        expect(automaticRetries).toBe(0);

        expect(llmEvents.length).toBeGreaterThanOrEqual(1);
        expect(llmEvents.length).toBeLessThanOrEqual(2);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    240_000
  );

  it.runIf(!enabled)(
    "stays disabled unless SPONSOR_RADAR_LIVE_FULL_WORKFLOW=true is supplied manually",
    () => {
      expect(enabled).toBe(false);
    }
  );
});

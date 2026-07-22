import type { AgentToolCall } from "@/src/agent/llm/agent-llm-port";
import type { AuditRecorder } from "@/src/observability/audit";
import { UpriverHttpError } from "@/src/radar/adapters/upriver/http-client";
import type { SponsorRadarEvidencePort } from "@/src/radar/application/ports";
import { canTreatPeerFailureAsPartial } from "@/src/radar/application/run-winback-report";
import type {
  EvidenceToolExecutor,
  EvidenceToolRequests,
  EvidenceToolResults
} from "@/src/radar/application/tools/tool-executor";
import {
  auditToolName,
  type EvidenceOperation
} from "@/src/radar/application/tools/tool-registry";
import type { CreditBudget } from "@/src/radar/domain/credits";
import { isReachComparable } from "@/src/radar/domain/reach";
import type { WinbackReport } from "@/src/radar/domain/types";
import {
  AGENT_TOOL_CATALOG,
  AGENT_TOOL_INPUT_SCHEMAS,
  isAgentToolName,
  projectAnalysis,
  projectLockedPeers,
  projectResolvedTarget,
  projectSponsorResult,
  serializeEnvelope,
  type AgentToolName
} from "@/src/radar/application/agentic/agent-tools";
import {
  AgentEvidencePreconditionError,
  type AgentEvidenceState
} from "@/src/radar/application/agentic/evidence-state";

export interface ToolDispatchOutcome {
  content: string;
  isError: boolean;
  terminal?: { report: WinbackReport };
}

/**
 * Raised only for evidence-integrity violations (for example a provider
 * returning a peer outside the locked reach window) and for paid failures
 * that must terminate the run. Model mistakes never throw — they come back
 * as structured error envelopes the model can adapt to.
 */
export class AgentRunFailedError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "AgentRunFailedError";
  }
}

export interface AgentToolBrokerOptions {
  executor: EvidenceToolExecutor;
  port: SponsorRadarEvidencePort;
  budget: CreditBudget;
  audit: AuditRecorder;
  state: AgentEvidenceState;
  phase: WinbackReport["phase"];
  now: () => number;
}

/**
 * The mediating boundary between model proposals and the single
 * `ToolExecutor` (ADR 0008): allowlist, Zod validation, reference
 * resolution, conservative credit preflight, execution, and result-based
 * settlement. A budget denial is information (a structured error envelope
 * with the remaining budget), never a run termination.
 */
export class AgentToolBroker {
  constructor(private readonly options: AgentToolBrokerOptions) {}

  async dispatch(call: AgentToolCall): Promise<ToolDispatchOutcome> {
    if (!isAgentToolName(call.name)) {
      return this.errorEnvelope("unknown_tool", {
        message: `Unknown tool ${call.name}`,
        allowedTools: Object.keys(AGENT_TOOL_CATALOG)
      });
    }
    const parsed = AGENT_TOOL_INPUT_SCHEMAS[call.name].safeParse(
      call.arguments ?? {}
    );
    if (!parsed.success) {
      return this.errorEnvelope("invalid_arguments", {
        message: `Invalid arguments for ${call.name}`,
        issues: parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      });
    }

    try {
      return await this.dispatchValidated(
        call.name,
        parsed.data as Record<string, string>
      );
    } catch (error) {
      if (error instanceof AgentEvidencePreconditionError) {
        return this.errorEnvelope("missing_prerequisite", {
          message: error.message
        });
      }
      throw error;
    }
  }

  private async dispatchValidated(
    name: AgentToolName,
    args: Record<string, string>
  ): Promise<ToolDispatchOutcome> {
    const { state } = this.options;
    switch (name) {
      case "resolve_target":
        return this.executeEvidence(name, "resolve_target", {
          request: { channel: args.channel },
          reason: "Confirm the exact requested YouTube channel before research",
          auditInput: { channel: args.channel },
          record: (result) => {
            state.recordResolvedTarget(result);
            return projectResolvedTarget(result);
          }
        });
      case "list_locked_peers": {
        const resolved = state.requireResolved();
        return this.executeEvidence(name, "list_locked_peers", {
          request: {
            targetUrl: resolved.target.url,
            targetSubscriberCount: resolved.target.subscriberCount
          },
          reason: "Discover reach-comparable peers for the resolved target",
          auditInput: {
            targetUrl: resolved.target.url,
            targetSubscriberCount: resolved.target.subscriberCount
          },
          record: (peers) => {
            for (const peer of peers) {
              if (
                !isReachComparable(
                  resolved.target.subscriberCount,
                  peer.subscriberCount
                )
              ) {
                throw new AgentRunFailedError(
                  `${peer.name} falls outside the locked reach window`
                );
              }
            }
            return projectLockedPeers(
              resolved.target,
              state.recordLockedPeers(peers)
            );
          }
        });
      }
      case "list_target_sponsors": {
        const resolved = state.requireResolved();
        return this.executeEvidence(name, "list_target_sponsors", {
          request: { targetUrl: resolved.target.url },
          reason:
            this.options.port.mode === "live"
              ? "Retrieve explicit sponsorships from the verified 365-day target window"
              : "Load the captured 365-day target sponsor history",
          auditInput: {
            publicationUrl: resolved.target.url,
            window: resolved.config.target_window
          },
          record: (result) => {
            state.recordTargetSponsors(result);
            return projectSponsorResult(result, {});
          }
        });
      }
      case "list_peer_sponsors": {
        const resolved = state.requireResolved();
        const peer = state.peerByRef(args.peerRef);
        return this.executeEvidence(name, "list_peer_sponsors", {
          request: { peerUrl: peer.url },
          reason: `${
            this.options.port.mode === "live" ? "Retrieve" : "Load captured"
          } recent explicit sponsorships for locked peer ${peer.name}`,
          auditInput: {
            publicationUrl: peer.url,
            window: resolved.config.peer_window,
            sponsorTypes: resolved.config.sponsor_types
          },
          record: (result) => {
            state.recordPeerSponsors(peer.peerRef, result);
            return projectSponsorResult(result, { peerRef: peer.peerRef });
          },
          onFailure: (error) => {
            if (!canTreatPeerFailureAsPartial(this.options.port.mode, error)) {
              return null;
            }
            state.recordPeerSponsorFailure(peer.peerRef);
            return this.errorEnvelope("peer_research_failed", {
              message: `Sponsor research failed for ${peer.name}; its evidence is recorded as partial. Continue with the remaining peers.`,
              peerRef: peer.peerRef
            });
          }
        });
      }
      case "analyze_evidence":
        return this.executeLocal("analyze_evidence", () => {
          const analysis = state.analyze();
          return {
            envelope: projectAnalysis(analysis),
            rows: analysis.qualification.leads.length
          };
        });
      case "submit_report":
        return this.executeLocal("submit_report", () => {
          const report = state.assembleReport({
            analysisRef: args.analysisRef,
            audit: this.options.audit,
            port: this.options.port,
            phase: this.options.phase,
            now: this.options.now
          });
          return {
            envelope: {
              submitted: true,
              leadCount: report.leads.length,
              outcome:
                report.leads.length > 0
                  ? "opportunities_found"
                  : "no_qualified_opportunities"
            },
            rows: report.leads.length,
            terminal: { report }
          };
        });
    }
  }

  private async executeEvidence<K extends EvidenceOperation>(
    name: AgentToolName,
    operation: K,
    input: {
      request: EvidenceToolRequests[K];
      reason: string;
      auditInput: unknown;
      record: (result: EvidenceToolResults[K]) => unknown;
      onFailure?: (error: unknown) => ToolDispatchOutcome | null;
    }
  ): Promise<ToolDispatchOutcome> {
    const { budget, port, audit, executor } = this.options;

    const preflight = budget.preflight({
      estimatedCredits: port.estimateCredits(operation),
      reason: input.reason
    });
    audit.recordPolicy({
      decision: preflight.decision,
      reason: preflight.reason,
      estimatedCredits: preflight.estimatedCredits,
      resultBasedCredits: 0,
      maximumCredits: budget.maximumCredits,
      remainingCredits: preflight.remainingCredits
    });
    if (preflight.decision === "deny") {
      return this.errorEnvelope("budget_exceeded", {
        message: `The ${name} call would exceed the remaining credit budget. Analyze what you have or finish with submit_report.`,
        estimatedCredits: preflight.estimatedCredits,
        shortfallCredits: preflight.shortfallCredits
      });
    }

    try {
      const result = await executor.execute(operation, input.request, {
        reason: input.reason,
        auditInput: input.auditInput
      });
      budget.reconcile(
        preflight.allocationId!,
        this.settledCreditsFromAudit(operation, preflight.estimatedCredits)
      );
      const data = input.record(result);
      return this.successEnvelope(data);
    } catch (error) {
      // A failed paid call settles conservatively at the full estimate; no
      // replay ever happens here (zero-retry is preserved by never
      // re-invoking the executor for the same proposal).
      budget.reconcile(
        preflight.allocationId!,
        port.mode === "fixture" ? 0 : preflight.estimatedCredits
      );
      if (error instanceof AgentRunFailedError) {
        throw error;
      }
      const recovered = input.onFailure?.(error);
      if (recovered) {
        return recovered;
      }
      if (name === "list_peer_sponsors") {
        throw new AgentRunFailedError(
          "Peer sponsor research failed outside the recoverable policy",
          error
        );
      }
      return this.errorEnvelope("tool_failed", {
        message: `${name} failed and will not be retried`,
        errorType:
          error instanceof UpriverHttpError ? error.code : "internal"
      });
    }
  }

  private async executeLocal(
    name: "analyze_evidence" | "submit_report",
    run: () => {
      envelope: unknown;
      rows: number;
      terminal?: { report: WinbackReport };
    }
  ): Promise<ToolDispatchOutcome> {
    const { audit } = this.options;
    const output = await audit.tool(
      {
        name: `local.${name}`,
        reason:
          name === "analyze_evidence"
            ? "Run the deterministic same-brand qualification over gathered evidence"
            : "Assemble the report from the completed analysis",
        mode: "fixture",
        input: {},
        cacheStatus: "not_applicable",
        estimatedCredits: 0
      },
      async () => run(),
      (result) => ({ rows: result.rows })
    );
    return {
      ...this.successEnvelope(output.envelope),
      ...(output.terminal ? { terminal: output.terminal } : {})
    };
  }

  private settledCreditsFromAudit(
    operation: string,
    conservativeFallback: number
  ): number {
    if (this.options.port.mode === "fixture") {
      return 0;
    }
    const completed = [...this.options.audit.getEvents()]
      .reverse()
      .find(
        (event) =>
          event.eventType === "tool.completed" &&
          event.tool?.name ===
            auditToolName(this.options.port.mode, operation as never)
      );
    return completed?.tool?.resultBasedCredits ?? conservativeFallback;
  }

  private successEnvelope(data: unknown): ToolDispatchOutcome {
    return {
      content: serializeEnvelope({
        ok: true,
        data,
        credits: this.creditsSummary()
      }),
      isError: false
    };
  }

  private errorEnvelope(
    code: string,
    extra: Record<string, unknown>
  ): ToolDispatchOutcome {
    return {
      content: serializeEnvelope({
        ok: false,
        code,
        ...extra,
        credits: this.creditsSummary()
      }),
      isError: true
    };
  }

  private creditsSummary(): Record<string, number> {
    const snapshot = this.options.budget.snapshot();
    return {
      settledCredits: snapshot.resultBasedCredits,
      remainingCredits: snapshot.remainingCredits,
      maximumCredits: snapshot.maximumCredits
    };
  }
}

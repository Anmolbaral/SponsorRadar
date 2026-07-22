import type { AgentLlmPort } from "@/src/agent/llm/agent-llm-port";
import type { AuditEvent } from "@/src/observability/audit";
import { AuditRecorder } from "@/src/observability/audit";
import type { SponsorRadarEvidencePort } from "@/src/radar/application/ports";
import { EvidenceToolExecutor } from "@/src/radar/application/tools/tool-executor";
import { CreditBudget } from "@/src/radar/domain/credits";
import { MAXIMUM_RUN_CREDITS } from "@/src/radar/application/run-workflow";
import type { WinbackReport } from "@/src/radar/domain/types";
import {
  runAgentLoop,
  DEFAULT_MAX_ITERATIONS
} from "@/src/radar/application/agentic/agent-loop";
import { AgentEvidenceState } from "@/src/radar/application/agentic/evidence-state";
import { AgentToolBroker } from "@/src/radar/application/agentic/tool-broker";
import type { AgentTranscriptSink } from "@/src/radar/application/agentic/transcript";

export interface RunAgenticReportInput {
  channel: string;
  maximumCredits?: number;
}

export interface RunAgenticReportOptions {
  runId?: string;
  audit?: AuditRecorder;
  now?: () => number;
  maxIterations?: number;
  transcriptSink?: AgentTranscriptSink;
}

export interface RunAgenticReportResult {
  report: WinbackReport;
  events: readonly AuditEvent[];
}

export interface ComposedAgenticRun {
  audit: AuditRecorder;
  budget: CreditBudget;
  state: AgentEvidenceState;
  maximumCredits: number;
  run(): Promise<WinbackReport>;
}

/**
 * Compose one autonomous run's components (ADR 0008). All ceilings are
 * enforced in code; the model only chooses the order and depth of the
 * research. Exposed separately from `runAgenticReport` so the workflow
 * service can observe evidence state for persisted heartbeats.
 */
export function composeAgenticRun(
  input: RunAgenticReportInput,
  evidencePort: SponsorRadarEvidencePort,
  llm: AgentLlmPort,
  options: RunAgenticReportOptions = {}
): ComposedAgenticRun {
  const now = options.now ?? Date.now;
  const mode = evidencePort.mode;
  const phase = mode === "fixture" ? "workflow_fixture" : "workflow_live";
  const audit =
    options.audit ??
    new AuditRecorder({
      runId: options.runId,
      clock: now,
      mode,
      phase
    });
  const maximumCredits = Math.min(
    input.maximumCredits ?? MAXIMUM_RUN_CREDITS,
    MAXIMUM_RUN_CREDITS
  );
  const budget = new CreditBudget(maximumCredits);
  const state = new AgentEvidenceState();
  const broker = new AgentToolBroker({
    executor: new EvidenceToolExecutor({
      port: evidencePort,
      audit,
      stage: "report"
    }),
    port: evidencePort,
    budget,
    audit,
    state,
    phase,
    now,
    requestedChannel: input.channel
  });

  return {
    audit,
    budget,
    state,
    maximumCredits,
    run: async () => {
      await evidencePort.prepareRun?.(input.channel);
      audit.startRun({ channel: input.channel });
      audit.recordPolicy({
        decision: "allow",
        reason:
          mode === "fixture"
            ? "Fixture mode is network-disabled and spends zero credits"
            : "The autonomous run is authorized up to its per-call enforced credit ceiling",
        estimatedCredits: 0,
        resultBasedCredits: 0,
        maximumCredits,
        remainingCredits: maximumCredits
      });
      return runAgentLoop({
        runId: audit.runId,
        channel: input.channel,
        llm,
        broker,
        audit,
        budget,
        maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        transcriptSink: options.transcriptSink
      });
    }
  };
}

export async function runAgenticReport(
  input: RunAgenticReportInput,
  evidencePort: SponsorRadarEvidencePort,
  llm: AgentLlmPort,
  options: RunAgenticReportOptions = {}
): Promise<RunAgenticReportResult> {
  const composed = composeAgenticRun(input, evidencePort, llm, options);
  const report = await composed.run();
  return { report, events: composed.audit.getEvents() };
}

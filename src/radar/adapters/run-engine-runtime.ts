import path from "node:path";
import type { AgentLlmPort } from "@/src/agent/llm/agent-llm-port";
import { FixtureResearchPlanner } from "@/src/agent/llm/fixture-research-planner";
import { OpenAiResponsesAgentLlm } from "@/src/agent/llm/openai-responses-agent-llm";
import type { AuditRecorder } from "@/src/observability/audit";
import { CachedEvidenceGateway } from "@/src/radar/adapters/cache/cached-evidence-gateway";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import { FileSystemWorkflowRepository } from "@/src/radar/adapters/persistence";
import { UpriverHttpClient } from "@/src/radar/adapters/upriver/http-client";
import { LiveUpriverGateway } from "@/src/radar/adapters/upriver/live-evidence-gateway";
import { AgenticWorkflowService } from "@/src/radar/application/agentic/agentic-run-service";
import type { EvidenceMode } from "@/src/radar/application/ports";
import type { RunEngine } from "@/src/radar/application/run-engine";
import {
  MAXIMUM_RUN_CREDITS,
  type WorkflowGatewayFactory
} from "@/src/radar/application/run-workflow";

export class LiveWorkflowDisabledError extends Error {
  readonly code = "live_workflow_disabled";

  constructor(message: string) {
    super(message);
    this.name = "LiveWorkflowDisabledError";
  }
}

/**
 * Composition root for run orchestration (ADR 0009): the agentic engine is
 * the only engine. Run records live under `${dataDir}/agentic`; the evidence
 * cache stays at the data-dir root so pre-cutover cached evidence is reused.
 */
export function createRunEngineFromEnvironment(): RunEngine {
  const repositoryRoot = process.cwd();
  const mode = workflowMode();
  const dataDirectory = workflowDataDirectory(repositoryRoot);
  const runCreditLimit = environmentInteger(
    "SPONSOR_RADAR_RUN_CREDIT_LIMIT",
    MAXIMUM_RUN_CREDITS
  );
  if (runCreditLimit > MAXIMUM_RUN_CREDITS) {
    throw new LiveWorkflowDisabledError(
      `SPONSOR_RADAR_RUN_CREDIT_LIMIT must not exceed ${MAXIMUM_RUN_CREDITS}`
    );
  }
  const cacheTtlMs = environmentInteger(
    "SPONSOR_RADAR_CACHE_TTL_MS",
    60 * 60 * 1_000
  );
  const agenticRepository = new FileSystemWorkflowRepository({
    directory: path.join(dataDirectory, "agentic")
  });
  const cacheRepository = new FileSystemWorkflowRepository({
    directory: dataDirectory
  });
  const gatewayFactory: WorkflowGatewayFactory = (input) => {
    const { audit, maximumCredits = runCreditLimit } = input;
    if (input.mode !== mode) {
      throw new LiveWorkflowDisabledError(
        `Persisted ${input.mode} run cannot continue while UPRIVER_MODE=${mode}`
      );
    }
    const underlying =
      mode === "fixture"
        ? new FixtureEvidenceGateway(repositoryRoot)
        : liveGateway(repositoryRoot, maximumCredits, audit);
    return new CachedEvidenceGateway(underlying, cacheRepository, {
      creatorTtlMs: cacheTtlMs,
      sponsorTtlMs: cacheTtlMs,
      verificationTtlMs: cacheTtlMs
    });
  };

  return new AgenticWorkflowService({
    repository: agenticRepository,
    gatewayFactory,
    mode,
    llm: agentLlmFromEnvironment(mode),
    runCreditLimit,
    maxIterations: environmentInteger("SPONSOR_RADAR_AGENT_MAX_ITERATIONS", 12)
  });
}

function agentLlmFromEnvironment(
  mode: "fixture" | "live"
): AgentLlmPort {
  const llmMode = process.env.SPONSOR_RADAR_LLM_MODE ?? "fixture";
  if (llmMode === "disabled") {
    throw new LiveWorkflowDisabledError(
      "The agentic engine requires a planner LLM; SPONSOR_RADAR_LLM_MODE must be fixture or openai"
    );
  }
  if (llmMode === "fixture") {
    if (mode !== "fixture") {
      throw new LiveWorkflowDisabledError(
        "A scripted fixture planner must not drive paid live evidence calls"
      );
    }
    return new FixtureResearchPlanner();
  }
  if (llmMode !== "openai") {
    throw new LiveWorkflowDisabledError(
      "SPONSOR_RADAR_LLM_MODE must be disabled, fixture, or openai"
    );
  }
  if (process.env.SPONSOR_RADAR_LIVE_LLM !== "true") {
    throw new LiveWorkflowDisabledError(
      "The paid planner LLM requires SPONSOR_RADAR_LIVE_LLM=true"
    );
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new LiveWorkflowDisabledError(
      "The paid planner LLM requires a server-only OpenAI API key"
    );
  }
  return new OpenAiResponsesAgentLlm({
    apiKey,
    model: process.env.SPONSOR_RADAR_OPENAI_MODEL
  });
}

export function workflowDataDirectory(repositoryRoot: string): string {
  const configured = process.env.SPONSOR_RADAR_DATA_DIR;
  return configured
    ? path.resolve(
        /*turbopackIgnore: true*/
        configured
      )
    : path.join(repositoryRoot, ".data", "sponsor-radar");
}

export function workflowMode(): EvidenceMode {
  const mode = process.env.UPRIVER_MODE ?? "fixture";
  if (mode !== "fixture" && mode !== "live") {
    throw new LiveWorkflowDisabledError(
      "UPRIVER_MODE must be fixture or live"
    );
  }
  if (
    mode === "live" &&
    process.env.UPRIVER_LIVE_WORKFLOW !== "true"
  ) {
    throw new LiveWorkflowDisabledError(
      "The live workflow requires UPRIVER_LIVE_WORKFLOW=true"
    );
  }
  return mode;
}

export function liveGateway(
  repositoryRoot: string,
  maximumCredits: number,
  audit: AuditRecorder | undefined
): LiveUpriverGateway {
  const apiKey = process.env.UPRIVER_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new LiveWorkflowDisabledError(
      "The live workflow requires a server-only Upriver API key"
    );
  }
  return new LiveUpriverGateway(
    repositoryRoot,
    new UpriverHttpClient({
      apiKey,
      maxRetries: 0,
      attemptTimeoutMs: 10_000,
      observer: audit
        ? (event) => audit.recordHttpLifecycle(event)
        : undefined
    }),
    { maximumCredits }
  );
}

export function environmentInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new LiveWorkflowDisabledError(
      `${name} must be a positive integer`
    );
  }
  return value;
}

import path from "node:path";
import type { AgentLlmPort } from "@/src/agent/llm/agent-llm-port";
import { FixtureResearchPlanner } from "@/src/agent/llm/fixture-research-planner";
import { OpenAiResponsesAgentLlm } from "@/src/agent/llm/openai-responses-agent-llm";
import { CachedEvidenceGateway } from "@/src/radar/adapters/cache/cached-evidence-gateway";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import { FileSystemWorkflowRepository } from "@/src/radar/adapters/persistence";
import {
  createWorkflowServiceFromEnvironment,
  environmentInteger,
  liveGateway,
  LiveWorkflowDisabledError,
  workflowDataDirectory,
  workflowMode
} from "@/src/radar/adapters/workflow-runtime";
import { AgenticWorkflowService } from "@/src/radar/application/agentic/agentic-run-service";
import type { RunEngine, RunEngineKind } from "@/src/radar/application/run-engine";
import {
  MAXIMUM_RUN_CREDITS,
  RunNotFoundError,
  runIdFor,
  type ApproveExecutionInput,
  type ApprovePlanInput,
  type MutateRunInput,
  type WorkflowGatewayFactory,
  type WorkflowRunResource
} from "@/src/radar/application/run-workflow";

/**
 * Composition root for run orchestration (ADR 0007/0008). The engine choice
 * is server-side only; reads and recovery actions always dispatch on which
 * store holds the record, so runs from either engine stay reachable across
 * flag flips and one idempotency key can never create two runs.
 */
export function createRunEngineFromEnvironment(): RunEngine {
  const engine = runEngineKind();
  const legacy = createWorkflowServiceFromEnvironment();
  const agentic = createAgenticServiceFromEnvironment(engine);
  return new EngineRouter(legacy, agentic, engine);
}

export function runEngineKind(): RunEngineKind {
  const raw = process.env.SPONSOR_RADAR_ENGINE ?? "legacy";
  if (raw !== "legacy" && raw !== "agentic") {
    throw new LiveWorkflowDisabledError(
      "SPONSOR_RADAR_ENGINE must be legacy or agentic"
    );
  }
  return raw;
}

class EngineRouter implements RunEngine {
  constructor(
    private readonly legacy: RunEngine,
    private readonly agentic: AgenticWorkflowService,
    private readonly activeEngine: RunEngineKind
  ) {}

  async createRun(
    requestedChannel: string,
    idempotencyKey: string
  ): Promise<WorkflowRunResource> {
    const runId = runIdFor(idempotencyKey);
    if (this.activeEngine === "agentic") {
      if (await this.legacyHasRun(runId)) {
        return this.legacy.createRun(requestedChannel, idempotencyKey);
      }
      return this.agentic.createRun(requestedChannel, idempotencyKey);
    }
    if (await this.agentic.hasRun(runId)) {
      return this.agentic.getRun(runId);
    }
    return this.legacy.createRun(requestedChannel, idempotencyKey);
  }

  async getRun(runId: string): Promise<WorkflowRunResource> {
    if (await this.agentic.hasRun(runId)) {
      return this.agentic.getRun(runId);
    }
    return this.legacy.getRun(runId);
  }

  async approvePlan(
    runId: string,
    input: ApprovePlanInput
  ): Promise<WorkflowRunResource> {
    if (await this.agentic.hasRun(runId)) {
      return this.agentic.approvePlan(runId, input);
    }
    return this.legacy.approvePlan(runId, input);
  }

  async approveExecution(
    runId: string,
    input: ApproveExecutionInput
  ): Promise<WorkflowRunResource> {
    if (await this.agentic.hasRun(runId)) {
      return this.agentic.approveExecution(runId, input);
    }
    return this.legacy.approveExecution(runId, input);
  }

  async cancelRun(
    runId: string,
    input: MutateRunInput
  ): Promise<WorkflowRunResource> {
    if (await this.agentic.hasRun(runId)) {
      return this.agentic.cancelRun(runId, input);
    }
    return this.legacy.cancelRun(runId, input);
  }

  async resumeRun(
    runId: string,
    input: MutateRunInput
  ): Promise<WorkflowRunResource> {
    if (await this.agentic.hasRun(runId)) {
      return this.agentic.resumeRun(runId, input);
    }
    return this.legacy.resumeRun(runId, input);
  }

  private async legacyHasRun(runId: string): Promise<boolean> {
    try {
      await this.legacy.getRun(runId);
      return true;
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        return false;
      }
      throw error;
    }
  }
}

function createAgenticServiceFromEnvironment(
  activeEngine: RunEngineKind
): AgenticWorkflowService {
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
  // Agentic run records live in a parallel store (ADR 0006/0008); the
  // evidence cache stays in the legacy store so both engines share it.
  const agenticRepository = new FileSystemWorkflowRepository({
    directory: path.join(dataDirectory, "agentic")
  });
  const cacheRepository = new FileSystemWorkflowRepository({
    directory: dataDirectory
  });
  const gatewayFactory: WorkflowGatewayFactory = (input) => {
    const { audit, maximumCredits = runCreditLimit } = input;
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
    llm: activeEngine === "agentic" ? agentLlmFromEnvironment(mode) : null,
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

import path from "node:path";
import { FixtureLlmPort } from "@/src/agent/llm/fixture-llm-port";
import { OpenAiResponsesLlmPort } from "@/src/agent/llm/openai-responses-llm-port";
import {
  BoundedWordingAgent,
  type WordingAgent
} from "@/src/agent/orchestrator/wording-agent";
import { CachedEvidenceGateway } from "@/src/radar/adapters/cache/cached-evidence-gateway";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import { FileSystemWorkflowRepository } from "@/src/radar/adapters/persistence";
import { UpriverHttpClient } from "@/src/radar/adapters/upriver/http-client";
import { LiveUpriverGateway } from "@/src/radar/adapters/upriver/live-evidence-gateway";
import {
  MAXIMUM_RUN_CREDITS,
  WorkflowService,
  type WorkflowGatewayFactory
} from "@/src/radar/application/run-workflow";
import type { EvidenceMode } from "@/src/radar/application/ports";

export class LiveWorkflowDisabledError extends Error {
  readonly code = "live_workflow_disabled";

  constructor(message: string) {
    super(message);
    this.name = "LiveWorkflowDisabledError";
  }
}

export function createWorkflowServiceFromEnvironment(): WorkflowService {
  const repositoryRoot = process.cwd();
  const mode = workflowMode();
  const runCreditLimit = environmentInteger(
    "SPONSOR_RADAR_RUN_CREDIT_LIMIT",
    MAXIMUM_RUN_CREDITS
  );
  if (runCreditLimit > MAXIMUM_RUN_CREDITS) {
    throw new LiveWorkflowDisabledError(
      `SPONSOR_RADAR_RUN_CREDIT_LIMIT must not exceed ${MAXIMUM_RUN_CREDITS}`
    );
  }
  // Evidence older than this is treated as expired: the read-through cache
  // reports a miss and re-fetches from the provider, so a run never serves a
  // stale target/peer/sponsor result that could mask an upstream outage.
  const cacheTtlMs = environmentInteger(
    "SPONSOR_RADAR_CACHE_TTL_MS",
    60 * 60 * 1_000
  );
  const repository = new FileSystemWorkflowRepository({
    directory: workflowDataDirectory(repositoryRoot)
  });
  const gatewayFactory: WorkflowGatewayFactory = (input) => {
    const {
      audit,
      maximumCredits = runCreditLimit,
      mode: requestedMode
    } = input;
    if (requestedMode !== mode) {
      throw new LiveWorkflowDisabledError(
        `Persisted ${requestedMode} run cannot continue while UPRIVER_MODE=${mode}`
      );
    }
    const underlying =
      requestedMode === "fixture"
        ? new FixtureEvidenceGateway(repositoryRoot)
        : liveGateway(repositoryRoot, maximumCredits, audit);
    return new CachedEvidenceGateway(underlying, repository, {
      creatorTtlMs: cacheTtlMs,
      sponsorTtlMs: cacheTtlMs,
      verificationTtlMs: cacheTtlMs
    });
  };

  return new WorkflowService({
    repository,
    gatewayFactory,
    mode,
    runCreditLimit,
    wordingAgent: wordingAgentFromEnvironment(repositoryRoot),
    quoteTtlMs: environmentInteger(
      "SPONSOR_RADAR_QUOTE_TTL_MS",
      60 * 60 * 1_000
    )
  });
}

function wordingAgentFromEnvironment(
  repositoryRoot: string
): WordingAgent | undefined {
  const mode = process.env.SPONSOR_RADAR_LLM_MODE ?? "fixture";
  if (mode === "disabled") {
    return undefined;
  }
  if (mode === "fixture") {
    return new BoundedWordingAgent(repositoryRoot, new FixtureLlmPort());
  }
  if (mode !== "openai") {
    throw new LiveWorkflowDisabledError(
      "SPONSOR_RADAR_LLM_MODE must be disabled, fixture, or openai"
    );
  }
  if (process.env.SPONSOR_RADAR_LIVE_LLM !== "true") {
    throw new LiveWorkflowDisabledError(
      "The paid wording-agent LLM requires SPONSOR_RADAR_LIVE_LLM=true"
    );
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new LiveWorkflowDisabledError(
      "The paid wording-agent LLM requires a server-only OpenAI API key"
    );
  }
  return new BoundedWordingAgent(
    repositoryRoot,
    new OpenAiResponsesLlmPort({
      apiKey,
      model: process.env.SPONSOR_RADAR_OPENAI_MODEL
    })
  );
}

function workflowDataDirectory(repositoryRoot: string): string {
  const configured = process.env.SPONSOR_RADAR_DATA_DIR;
  return configured
    ? path.resolve(
        /*turbopackIgnore: true*/
        configured
      )
    : path.join(repositoryRoot, ".data", "sponsor-radar");
}

function workflowMode(): EvidenceMode {
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

function liveGateway(
  repositoryRoot: string,
  maximumCredits: number,
  audit:
    | import("@/src/observability/audit").AuditRecorder
    | undefined
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

function environmentInteger(name: string, fallback: number): number {
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

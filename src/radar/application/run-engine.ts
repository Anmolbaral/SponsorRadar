import type {
  ApproveExecutionInput,
  ApprovePlanInput,
  MutateRunInput,
  WorkflowRunResource
} from "@/src/radar/application/run-workflow";

/**
 * The public run-orchestration contract shared by every engine. The legacy
 * `WorkflowService` satisfies it structurally; the agentic engine implements
 * it behind the server-side `SPONSOR_RADAR_ENGINE` flag (ADR 0008).
 */
export interface RunEngine {
  createRun(
    requestedChannel: string,
    idempotencyKey: string
  ): Promise<WorkflowRunResource>;
  getRun(runId: string): Promise<WorkflowRunResource>;
  approvePlan(
    runId: string,
    input: ApprovePlanInput
  ): Promise<WorkflowRunResource>;
  approveExecution(
    runId: string,
    input: ApproveExecutionInput
  ): Promise<WorkflowRunResource>;
  cancelRun(
    runId: string,
    input: MutateRunInput
  ): Promise<WorkflowRunResource>;
  resumeRun(
    runId: string,
    input: MutateRunInput
  ): Promise<WorkflowRunResource>;
}

export type RunEngineKind = "legacy" | "agentic";

import type {
  ApproveExecutionInput,
  ApprovePlanInput,
  MutateRunInput,
  WorkflowRunResource
} from "@/src/radar/application/run-workflow";

/**
 * The public run-orchestration contract, implemented by the agentic engine
 * (ADR 0008/0009). The wire shapes it serves are frozen in run-workflow.ts.
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


import { NextResponse } from "next/server";
import { z } from "zod";
import { createPhase3WorkflowServiceFromEnvironment } from "@/src/radar/adapters/workflow-runtime";
import {
  enforceMutationRateLimit,
  readBoundedJson
} from "@/src/security/http-request";
import { idempotencyKey, workflowErrorResponse } from "../../errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RunIdSchema = z.string().regex(/^run_[a-f0-9]{32}$/);
const ExpectedVersionSchema = z.number().int().nonnegative();
const ActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("approve_plan"),
      expectedVersion: ExpectedVersionSchema,
      planId: z.string().min(8).max(100)
    })
    .strict(),
  z
    .object({
      action: z.literal("approve_execution"),
      expectedVersion: ExpectedVersionSchema,
      proposalId: z.string().min(8).max(100),
      quoteId: z.string().min(8).max(100),
      approvedCreditCeiling: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel"),
      expectedVersion: ExpectedVersionSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("resume"),
      expectedVersion: ExpectedVersionSchema
    })
    .strict()
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId: rawRunId } = await context.params;
    const runId = RunIdSchema.parse(rawRunId);
    enforceMutationRateLimit(request, "workflow_action");
    const input = ActionSchema.parse(await readBoundedJson(request));
    const key = idempotencyKey(request);
    const service = createPhase3WorkflowServiceFromEnvironment();
    const run =
      input.action === "approve_plan"
        ? await service.approvePlan(runId, {
            expectedVersion: input.expectedVersion,
            planId: input.planId,
            idempotencyKey: key
          })
        : input.action === "approve_execution"
          ? await service.approveExecution(runId, {
              expectedVersion: input.expectedVersion,
              proposalId: input.proposalId,
              quoteId: input.quoteId,
              approvedCreditCeiling: input.approvedCreditCeiling,
              idempotencyKey: key
            })
          : input.action === "cancel"
            ? await service.cancelRun(runId, {
                expectedVersion: input.expectedVersion,
                idempotencyKey: key
              })
            : await service.resumeRun(runId, {
                expectedVersion: input.expectedVersion,
                idempotencyKey: key
              });
    return NextResponse.json(run, {
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    return workflowErrorResponse(error);
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { createWorkflowServiceFromEnvironment } from "@/src/radar/adapters/workflow-runtime";
import { workflowErrorResponse } from "../errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RunIdSchema = z.string().regex(/^run_[a-f0-9]{32}$/);

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await context.params;
    const service = createWorkflowServiceFromEnvironment();
    const run = await service.getRun(RunIdSchema.parse(runId));
    return NextResponse.json(run, {
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    return workflowErrorResponse(error);
  }
}

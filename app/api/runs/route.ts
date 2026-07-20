import { NextResponse } from "next/server";
import { z } from "zod";
import { createPhase3WorkflowServiceFromEnvironment } from "@/src/radar/adapters/workflow-runtime";
import {
  assertExactYouTubeChannel,
  enforceMutationRateLimit,
  readBoundedJson
} from "@/src/security/http-request";
import { idempotencyKey, workflowErrorResponse } from "./errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateRunSchema = z
  .object({
    channel: z.string().trim().min(1).max(200)
  })
  .strict();

export async function POST(request: Request) {
  try {
    enforceMutationRateLimit(request, "create_run");
    const input = CreateRunSchema.parse(await readBoundedJson(request));
    assertExactYouTubeChannel(input.channel);
    const service = createPhase3WorkflowServiceFromEnvironment();
    const run = await service.createRun(input.channel, idempotencyKey(request));
    return NextResponse.json(run, {
      status: 201,
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    return workflowErrorResponse(error);
  }
}

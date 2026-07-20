import { NextResponse } from "next/server";
import { z } from "zod";
import {
  FixtureEvidenceGateway,
  UnsupportedFixtureChannelError
} from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import type { SponsorRadarEvidencePort } from "@/src/radar/application/ports";
import { runWinbackReport } from "@/src/radar/application/run-winback-report";
import { AuditRecorder } from "@/src/observability/audit";
import {
  enforceMutationRateLimit,
  readBoundedJson,
  RequestGuardError
} from "@/src/security/http-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestSchema = z
  .object({
    channel: z.string().trim().min(1).max(200)
  })
  .strict();

export async function POST(request: Request) {
  try {
    enforceMutationRateLimit(request, "legacy_report");
    const input = RequestSchema.parse(await readBoundedJson(request));
    const { gateway, audit } = createGateway();
    const result = await runWinbackReport(input, gateway, { audit });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RequestGuardError) {
      return NextResponse.json(
        { error: error.message },
        {
          status: error.status,
          headers: {
            "cache-control": "no-store",
            ...(error.retryAfterSeconds
              ? { "retry-after": String(error.retryAfterSeconds) }
              : {})
          }
        }
      );
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: "Enter one exact YouTube @handle or channel URL",
          details: z.flattenError(error)
        },
        { status: 400 }
      );
    }
    if (error instanceof UnsupportedFixtureChannelError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof LiveModeDisabledError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "Send a valid JSON body with one YouTube channel" },
        { status: 400 }
      );
    }
    if (error instanceof Error && error.message.includes("YouTube")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json(
      {
        error:
          "The demo report could not be generated. Review the server audit trace."
      },
      { status: 500 }
    );
  }
}

class LiveModeDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveModeDisabledError";
  }
}

function createGateway(): {
  gateway: SponsorRadarEvidencePort;
  audit: AuditRecorder;
} {
  const mode = process.env.UPRIVER_MODE ?? "fixture";
  if (mode !== "fixture") {
    throw new LiveModeDisabledError(
      "Full paid Upriver reports are not exposed through the public demo route in Phase 2. Use the separately bounded manual smoke test."
    );
  }
  return {
    gateway: new FixtureEvidenceGateway(process.cwd()),
    audit: new AuditRecorder({
      sink:
        process.env.NODE_ENV === "test"
          ? undefined
          : (event) => {
              console.info(JSON.stringify({ type: "sponsor_radar_audit", event }));
            }
    })
  };
}

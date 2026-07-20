import { NextResponse } from "next/server";
import { z } from "zod";
import {
  PersistenceConflictError,
  PersistenceCorruptionError
} from "@/src/radar/adapters/persistence";
import { LiveWorkflowDisabledError } from "@/src/radar/adapters/workflow-runtime";
import {
  RunAccountingMigrationRequiredError,
  RunCreditLimitExceededError,
  RunNotFoundError,
  WorkflowConflictError
} from "@/src/radar/application/run-workflow";
import { IllegalRunTransitionError } from "@/src/radar/domain/run-state";
import { RequestGuardError } from "@/src/security/http-request";

export type WorkflowErrorCode =
  | "invalid_request"
  | "forbidden_request"
  | "request_too_large"
  | "unsupported_media_type"
  | "invalid_channel"
  | "rate_limited"
  | "malformed_json"
  | "invalid_workflow_request"
  | "run_not_found"
  | "run_conflict"
  | "invalid_run_state"
  | "capacity_reached"
  | "run_credit_limit_reached"
  | "run_restart_required"
  | "research_unavailable"
  | "internal_error";

export interface WorkflowErrorPayload {
  error: string;
  code: WorkflowErrorCode;
  retryable: boolean;
}

export function workflowErrorResponse(error: unknown): NextResponse {
  if (error instanceof RequestGuardError) {
    return publicErrorResponse(
      error.message,
      requestGuardCode(error.status),
      error.status === 429,
      error.status,
      error.retryAfterSeconds
        ? { "retry-after": String(error.retryAfterSeconds) }
        : undefined
    );
  }
  if (error instanceof SyntaxError) {
    return publicErrorResponse(
      "Send a valid JSON request body",
      "malformed_json",
      false,
      400
    );
  }
  if (error instanceof z.ZodError) {
    return publicErrorResponse(
      "The workflow request is invalid",
      "invalid_workflow_request",
      false,
      400
    );
  }
  if (error instanceof RunNotFoundError) {
    return publicErrorResponse(
      "This research could not be found. Start a new search.",
      "run_not_found",
      false,
      404
    );
  }
  if (error instanceof WorkflowConflictError) {
    reportInternalError("workflow_conflict", "run_conflict", 409);
    return publicErrorResponse(
      "This research changed while it was running. Refresh and try again.",
      "run_conflict",
      true,
      409
    );
  }
  if (error instanceof PersistenceConflictError) {
    reportInternalError("persistence_conflict", "research_unavailable", 409);
    return publicErrorResponse(
      "Research cannot start because the service needs attention. Please contact the demo owner.",
      "research_unavailable",
      false,
      409
    );
  }
  if (error instanceof IllegalRunTransitionError) {
    reportInternalError("illegal_run_transition", "invalid_run_state", 409);
    return publicErrorResponse(
      "This research cannot continue from its current state. Start a new search.",
      "invalid_run_state",
      false,
      409
    );
  }
  if (error instanceof RunCreditLimitExceededError) {
    return publicErrorResponse(
      "This search reached the demo’s per-run research limit. No additional provider research was started.",
      "run_credit_limit_reached",
      false,
      409
    );
  }
  if (error instanceof RunAccountingMigrationRequiredError) {
    return publicErrorResponse(
      "This saved search uses an older accounting policy. Start a new search to continue safely.",
      "run_restart_required",
      false,
      409
    );
  }
  if (error instanceof LiveWorkflowDisabledError) {
    reportInternalError("live_workflow_disabled", "research_unavailable", 503);
    return publicErrorResponse(
      "Research is unavailable because the demo service is not fully configured. Please contact the demo owner.",
      "research_unavailable",
      false,
      503
    );
  }
  if (error instanceof PersistenceCorruptionError) {
    reportInternalError("persistence_corruption", "research_unavailable", 500);
    return publicErrorResponse(
      "Research cannot continue because its saved data needs attention. Please contact the demo owner.",
      "research_unavailable",
      false,
      500
    );
  }
  reportInternalError("unexpected_error", "internal_error", 500);
  return publicErrorResponse(
    "Something went wrong while researching this channel.",
    "internal_error",
    false,
    500
  );
}

export function idempotencyKey(request: Request): string {
  return z
    .string()
    .trim()
    .min(8)
    .max(200)
    .parse(request.headers.get("idempotency-key"));
}

function requestGuardCode(status: RequestGuardError["status"]): WorkflowErrorCode {
  switch (status) {
    case 403:
      return "forbidden_request";
    case 413:
      return "request_too_large";
    case 415:
      return "unsupported_media_type";
    case 422:
      return "invalid_channel";
    case 429:
      return "rate_limited";
    case 400:
      return "invalid_request";
  }
}

function publicErrorResponse(
  message: string,
  code: WorkflowErrorCode,
  retryable: boolean,
  status: number,
  headers?: Record<string, string>
): NextResponse {
  return NextResponse.json<WorkflowErrorPayload>(
    { error: message, code, retryable },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...headers
      }
    }
  );
}

function reportInternalError(
  internalCategory: string,
  publicCode: WorkflowErrorCode,
  status: number
): void {
  console.error(
    JSON.stringify({
      type: "sponsor_radar_workflow_error",
      internalCategory,
      publicCode,
      status
    })
  );
}

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  workflowErrorResponse,
  type WorkflowErrorPayload
} from "@/app/api/runs/errors";
import {
  PersistenceConflictError,
  PersistenceCorruptionError
} from "@/src/radar/adapters/persistence";
import { LiveWorkflowDisabledError } from "@/src/radar/adapters/run-engine-runtime";
import {
  RunAccountingMigrationRequiredError,
  RunCreditLimitExceededError,
  RunNotFoundError,
  WorkflowConflictError
} from "@/src/radar/application/run-workflow";
import { IllegalRunTransitionError } from "@/src/radar/domain/run-state";
import { RequestGuardError } from "@/src/security/http-request";

describe("workflow HTTP error contract", () => {
  it("keeps request errors actionable and structured", async () => {
    const response = workflowErrorResponse(
      new RequestGuardError(
        "Enter a YouTube channel handle or URL",
        422
      )
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Enter a YouTube channel handle or URL",
      code: "invalid_channel",
      retryable: false
    });
  });

  it("keeps rate-limit recovery metadata without exposing internals", async () => {
    const response = workflowErrorResponse(
      new RequestGuardError(
        "Too many workflow requests. Wait briefly before trying again.",
        429,
        37
      )
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(await response.json()).toEqual({
      error: "Too many workflow requests. Wait briefly before trying again.",
      code: "rate_limited",
      retryable: true
    });
  });

  it("does not expose validation paths or rejected values", async () => {
    const result = z
      .object({ internalApprovalField: z.literal("allowed") })
      .safeParse({ internalApprovalField: "do-not-return-this" });
    if (result.success) {
      throw new Error("Expected the validation fixture to fail");
    }

    const response = workflowErrorResponse(result.error);
    const body = (await response.json()) as WorkflowErrorPayload;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "The workflow request is invalid",
      code: "invalid_workflow_request",
      retryable: false
    });
    expect(serialized).not.toContain("internalApprovalField");
    expect(serialized).not.toContain("do-not-return-this");
  });

  it.each([
    {
      name: "missing run identifiers",
      error: new RunNotFoundError(
        "run_1234567890abcdef1234567890abcdef"
      ),
      status: 404,
      payload: {
        error: "This research could not be found. Start a new search.",
        code: "run_not_found",
        retryable: false
      },
      forbidden: ["run_1234567890abcdef1234567890abcdef"]
    },
    {
      name: "workflow versions and state details",
      error: new WorkflowConflictError(
        "Run is at version 17, not expected version 12; cohortHash=private-hash"
      ),
      status: 409,
      payload: {
        error:
          "This research changed while it was running. Refresh and try again.",
        code: "run_conflict",
        retryable: true
      },
      forbidden: ["version 17", "version 12", "cohortHash", "private-hash"]
    },
    {
      name: "persistence quota hashes, field names, and limits",
      error: new PersistenceConflictError(
        "Quota 5f4b7f44e6924ad88f4ca4e19efd7da904b4264a4564d299c14016fc74851760 already has maximumUnits 150, not 200"
      ),
      status: 409,
      payload: {
        error:
          "We couldn’t complete this research right now. Start a new search or try again later.",
        code: "research_unavailable",
        retryable: false
      },
      forbidden: [
        "5f4b7f44e6924ad88f4ca4e19efd7da904b4264a4564d299c14016fc74851760",
        "maximumUnits",
        "150",
        "200"
      ]
    },
    {
      name: "illegal state-transition details",
      error: new IllegalRunTransitionError("planned", "executing"),
      status: 409,
      payload: {
        error:
          "This research cannot continue from its current state. Start a new search.",
        code: "invalid_run_state",
        retryable: false
      },
      forbidden: ["planned", "executing", "Allowed"]
    },
    {
      name: "per-run credit-limit details",
      error: new RunCreditLimitExceededError(),
      status: 409,
      payload: {
        error: "This research reached its safety limit. Start a new search.",
        code: "run_credit_limit_reached",
        retryable: false
      },
      forbidden: ["Upriver", "quota", "160"]
    },
    {
      name: "legacy accounting internals",
      error: new RunAccountingMigrationRequiredError(),
      status: 409,
      payload: {
        error: "This saved research can’t continue safely. Start a new search.",
        code: "run_restart_required",
        retryable: false
      },
      forbidden: ["legacy_shared_v1", "quota", "reservation"]
    },
    {
      name: "server configuration and environment names",
      error: new LiveWorkflowDisabledError(
        "UPRIVER_MODE=fixture; requires OPENAI_API_KEY and SPONSOR_RADAR_LIVE_LLM=true"
      ),
      status: 503,
      payload: {
        error:
          "We couldn’t complete this research right now. Start a new search or try again later.",
        code: "research_unavailable",
        retryable: false
      },
      forbidden: [
        "UPRIVER_MODE",
        "fixture",
        "OPENAI_API_KEY",
        "SPONSOR_RADAR_LIVE_LLM"
      ]
    },
    {
      name: "persistence paths and corruption details",
      error: new PersistenceCorruptionError(
        "Invalid data at /srv/private/workflows/quota.json"
      ),
      status: 500,
      payload: {
        error:
          "We couldn’t complete this research right now. Start a new search or try again later.",
        code: "research_unavailable",
        retryable: false
      },
      forbidden: ["/srv/private", "workflows", "quota.json"]
    },
    {
      name: "unexpected error messages",
      error: new Error(
        "Unexpected upstream failure with api_key=do-not-expose"
      ),
      status: 500,
      payload: {
        error: "Something went wrong while researching this channel.",
        code: "internal_error",
        retryable: false
      },
      forbidden: ["upstream", "api_key", "do-not-expose"]
    }
  ])("sanitizes $name", async ({ error, status, payload, forbidden }) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = workflowErrorResponse(error);
      const body = (await response.json()) as WorkflowErrorPayload;
      const publicOutput = JSON.stringify(body);
      const serverDiagnostic = JSON.stringify(log.mock.calls);

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toEqual(payload);
      for (const value of forbidden) {
        expect(publicOutput).not.toContain(value);
        expect(serverDiagnostic).not.toContain(value);
      }
    } finally {
      log.mockRestore();
    }
  });
});

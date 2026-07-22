import { describe, expect, it } from "vitest";
import {
  FixtureAgentLlm,
  fixtureAssistantToolUse,
  type FixtureAgentStep
} from "@/src/agent/llm/fixture-agent-llm";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import {
  UpriverHttpError,
  type UpriverAttemptMetadata,
  type UpriverErrorCode
} from "@/src/radar/adapters/upriver/http-client";
import type {
  EvidenceMode,
  EvidenceOperation,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import { canTreatPeerFailureAsPartial } from "@/src/radar/application/peer-failure-policy";
import { runAgenticReport } from "@/src/radar/application/agentic/run-agentic-report";
import { AgentRunFailedError } from "@/src/radar/application/agentic/tool-broker";
import { parseYouTubeIdentity } from "@/src/radar/domain/youtube";

const FIXTURE_CHANNEL = "@UrAvgConsumer";
// Hayls World is peer_3 in the fixture cohort locked for @UrAvgConsumer.
const FAILING_PEER_REF = "peer_3";

// Full research journey; the model is told the failed peer is partial and
// finishes with the remaining evidence.
function partialJourneySteps(): FixtureAgentStep[] {
  return [
    {
      respond: fixtureAssistantToolUse("resolve_target", {
        channel: FIXTURE_CHANNEL
      })
    },
    { respond: fixtureAssistantToolUse("list_locked_peers", {}) },
    {
      respond: fixtureAssistantToolUse("list_peer_sponsors", {
        peerRef: "peer_1"
      })
    },
    {
      respond: fixtureAssistantToolUse("list_peer_sponsors", {
        peerRef: "peer_2"
      })
    },
    {
      respond: fixtureAssistantToolUse("list_peer_sponsors", {
        peerRef: FAILING_PEER_REF
      })
    },
    {
      expect: (messages) => {
        const lastToolResult = [...messages]
          .reverse()
          .find((message) => message.role === "tool_result");
        if (
          !lastToolResult ||
          lastToolResult.role !== "tool_result" ||
          !lastToolResult.isError ||
          !lastToolResult.content.includes("peer_research_failed")
        ) {
          throw new Error(
            "The failed peer must come back as a peer_research_failed envelope"
          );
        }
      },
      respond: fixtureAssistantToolUse("list_target_sponsors", {})
    },
    { respond: fixtureAssistantToolUse("analyze_evidence", {}) },
    {
      respond: fixtureAssistantToolUse("submit_report", {
        analysisRef: "analysis_1"
      })
    }
  ];
}

// Shortest path to the failing peer for termination scenarios.
function failFastSteps(): FixtureAgentStep[] {
  return [
    {
      respond: fixtureAssistantToolUse("resolve_target", {
        channel: FIXTURE_CHANNEL
      })
    },
    { respond: fixtureAssistantToolUse("list_locked_peers", {}) },
    {
      respond: fixtureAssistantToolUse("list_peer_sponsors", {
        peerRef: FAILING_PEER_REF
      })
    }
  ];
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected the agentic run to terminate");
    },
    (error) => error
  );
}

describe("peer failure policy", () => {
  it("preserves successful fixture evidence as a partial report", async () => {
    const failure = new Error("Recorded fixture peer failure");
    expect(canTreatPeerFailureAsPartial("fixture", failure)).toBe(true);

    const { report } = await runAgenticReport(
      { channel: FIXTURE_CHANNEL },
      new FailingPeerGateway("fixture", failure),
      new FixtureAgentLlm(partialJourneySteps())
    );

    expect(report.leads.map((lead) => lead.brand)).toEqual(["Dell"]);
    expect(report.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "peer_research_partial",
          message: expect.stringContaining("Hayls World")
        })
      ])
    );
  });

  it.each([
    ["network_failure", null, "network_error"],
    ["timeout", null, "timeout"],
    ["rate_limited", 429, "http_error"],
    ["upstream_error", 503, "http_error"],
    ["invalid_response", 200, "success"]
  ] as const)(
    "terminates the run on ambiguous live %s failures",
    async (code, status, outcome) => {
      const failure = upriverFailure(code, status, outcome);
      expect(canTreatPeerFailureAsPartial("live", failure)).toBe(false);

      const rejection = await rejectionOf(
        runAgenticReport(
          { channel: FIXTURE_CHANNEL, maximumCredits: 150 },
          new FailingPeerGateway("live", failure),
          new FixtureAgentLlm(failFastSteps())
        )
      );

      expect(rejection).toBeInstanceOf(AgentRunFailedError);
      expect((rejection as AgentRunFailedError).cause).toBe(failure);
    }
  );

  it("terminates the run on unclassified live provider errors", async () => {
    const failure = new Error("Unknown provider failure");
    expect(canTreatPeerFailureAsPartial("live", failure)).toBe(false);

    const rejection = await rejectionOf(
      runAgenticReport(
        { channel: FIXTURE_CHANNEL, maximumCredits: 150 },
        new FailingPeerGateway("live", failure),
        new FixtureAgentLlm(failFastSteps())
      )
    );

    expect(rejection).toBeInstanceOf(AgentRunFailedError);
    expect((rejection as AgentRunFailedError).cause).toBe(failure);
  });

  it.each([
    ["invalid_request", null, null],
    ["bad_request", 400, "http_error"],
    ["authentication_failed", 401, "http_error"],
    ["permission_denied", 403, "http_error"]
  ] as const)(
    "permits explicitly no-spend terminal live %s failures to remain partial",
    async (code, status, outcome) => {
      const failure = upriverFailure(code, status, outcome);
      expect(canTreatPeerFailureAsPartial("live", failure)).toBe(true);

      const { report } = await runAgenticReport(
        { channel: FIXTURE_CHANNEL, maximumCredits: 150 },
        new FailingPeerGateway("live", failure),
        new FixtureAgentLlm(partialJourneySteps())
      );

      expect(report.leads.map((lead) => lead.brand)).toEqual(["Dell"]);
      expect(report.coverage).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "peer_research_partial" })
        ])
      );
    }
  );
});

class FailingPeerGateway implements SponsorRadarEvidencePort {
  readonly mode: EvidenceMode;
  private readonly fixture = new FixtureEvidenceGateway(process.cwd());

  constructor(
    mode: EvidenceMode,
    private readonly failure: Error
  ) {
    this.mode = mode;
  }

  estimateCredits(operation: EvidenceOperation): number {
    if (this.mode === "fixture") return 0;
    switch (operation) {
      case "resolve_target":
        return 1;
      case "list_locked_peers":
        return 3;
      case "list_target_sponsors":
        return 115;
      case "list_peer_sponsors":
        return 10;
      case "load_verification_ledger":
        return 0;
    }
  }

  estimateRunCredits(): number {
    return this.mode === "fixture" ? 0 : 149;
  }

  resolveTarget(input: string) {
    return this.fixture.resolveTarget(input);
  }

  listTargetSponsors(targetUrl: string) {
    return this.fixture.listTargetSponsors(targetUrl);
  }

  listLockedPeers(targetUrl: string, targetSubscriberCount?: number) {
    return this.fixture.listLockedPeers(targetUrl, targetSubscriberCount);
  }

  listPeerSponsors(peerUrl: string) {
    if (
      parseYouTubeIdentity(peerUrl).key ===
      parseYouTubeIdentity("@HaylsWorld").key
    ) {
      return Promise.reject(this.failure);
    }
    return this.fixture.listPeerSponsors(peerUrl);
  }

  loadVerificationLedger() {
    return this.fixture.loadVerificationLedger();
  }
}

function upriverFailure(
  code: UpriverErrorCode,
  status: number | null,
  outcome: UpriverAttemptMetadata["outcome"] | null
): UpriverHttpError {
  const attempts: UpriverAttemptMetadata[] =
    outcome === null
      ? []
      : [
          {
            attempt: 1,
            status,
            outcome,
            latencyMs: 1,
            retryDelayMs: null,
            providerRequestId: "provider-test"
          }
        ];
  return new UpriverHttpError(
    "Classified test failure",
    code,
    status,
    {
      requestId: "request-test",
      providerRequestId: "provider-test",
      latencyMs: 1,
      attempts
    }
  );
}

import {
  approximateAgentTokens,
  type AgentAssistantMessage,
  type AgentLlmPort,
  type AgentLlmRequest,
  type AgentLlmResponse,
  type AgentMessage
} from "@/src/agent/llm/agent-llm-port";

/**
 * Deterministic rule-based planner for fixture-mode runs (CI, e2e, evals).
 * It follows the canonical research order — resolve, lock peers, research
 * every peer, research the target history, analyze, submit — by reading the
 * tool-result envelopes already in the transcript. No randomness, no model.
 */
export class FixtureResearchPlanner implements AgentLlmPort {
  readonly provider = "fixture";
  readonly model = "agent-planner-fixture-v1";

  private callSequence = 0;

  async complete(request: AgentLlmRequest): Promise<AgentLlmResponse> {
    const progress = readProgress(request.messages);
    const message = this.nextMessage(progress, request.messages);
    this.callSequence += 1;
    return {
      message,
      stopReason: message.toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage: {
        inputTokens: approximateAgentTokens(JSON.stringify(request.messages)),
        outputTokens: approximateAgentTokens(
          JSON.stringify(message.toolCalls)
        )
      },
      providerRequestId: `fixture_planner_${request.requestId}`,
      providerResponseId: null
    };
  }

  private nextMessage(
    progress: ResearchProgress,
    messages: readonly AgentMessage[]
  ): AgentAssistantMessage {
    if (!progress.resolved) {
      return this.toolUse("resolve_target", {
        channel: readRequestedChannel(messages)
      });
    }
    if (progress.peerRefs === null) {
      return this.toolUse("list_locked_peers", {});
    }
    const unresearchedPeer = progress.peerRefs.find(
      (peerRef) => !progress.researchedPeerRefs.has(peerRef)
    );
    if (unresearchedPeer !== undefined) {
      return this.toolUse("list_peer_sponsors", { peerRef: unresearchedPeer });
    }
    if (!progress.targetResearched) {
      return this.toolUse("list_target_sponsors", {});
    }
    if (progress.analysisRef === null) {
      return this.toolUse("analyze_evidence", {});
    }
    return this.toolUse("submit_report", {
      analysisRef: progress.analysisRef
    });
  }

  private toolUse(
    name: string,
    callArguments: Record<string, unknown>
  ): AgentAssistantMessage {
    const rawArguments = JSON.stringify(callArguments);
    return {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: `planner_call_${this.callSequence + 1}`,
          name,
          arguments: callArguments,
          rawArguments
        }
      ]
    };
  }
}

interface ResearchProgress {
  resolved: boolean;
  peerRefs: string[] | null;
  researchedPeerRefs: Set<string>;
  targetResearched: boolean;
  analysisRef: string | null;
}

function readProgress(messages: readonly AgentMessage[]): ResearchProgress {
  const progress: ResearchProgress = {
    resolved: false,
    peerRefs: null,
    researchedPeerRefs: new Set(),
    targetResearched: false,
    analysisRef: null
  };
  for (const message of messages) {
    if (message.role !== "tool_result" || message.isError) {
      continue;
    }
    const envelope = parseEnvelope(message.content);
    if (envelope === null || envelope.ok !== true) {
      continue;
    }
    const data = envelope.data as Record<string, unknown> | undefined;
    switch (message.toolName) {
      case "resolve_target":
        progress.resolved = true;
        break;
      case "list_locked_peers":
        progress.peerRefs = Array.isArray(data?.peers)
          ? (data.peers as Array<{ peerRef?: unknown }>).flatMap((peer) =>
              typeof peer.peerRef === "string" ? [peer.peerRef] : []
            )
          : [];
        break;
      case "list_peer_sponsors":
        if (typeof data?.peerRef === "string") {
          progress.researchedPeerRefs.add(data.peerRef);
        }
        break;
      case "list_target_sponsors":
        progress.targetResearched = true;
        break;
      case "analyze_evidence":
        if (typeof data?.analysisRef === "string") {
          progress.analysisRef = data.analysisRef;
        }
        break;
      default:
        break;
    }
  }
  return progress;
}

function readRequestedChannel(messages: readonly AgentMessage[]): string {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    try {
      const parsed = JSON.parse(message.content) as { channel?: unknown };
      if (typeof parsed.channel === "string") {
        return parsed.channel;
      }
    } catch {
      continue;
    }
  }
  throw new Error("The fixture planner found no requested channel");
}

function parseEnvelope(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

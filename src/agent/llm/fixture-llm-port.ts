import { z } from "zod";
import type {
  LlmPort,
  LlmProviderRequest,
  LlmProviderResponse
} from "@/src/agent/llm/llm-port";

const PeerFixtureInputSchema = z
  .object({
    peers: z.array(
      z
        .object({
          peerId: z.string(),
          evidenceIds: z.array(z.string()).length(2)
        })
        .passthrough()
    )
  })
  .passthrough();
const WordingFixtureInputSchema = z
  .object({
    ledgers: z.array(
      z
        .object({
          leadId: z.string(),
          claims: z.array(
            z
              .object({
                claimId: z.string(),
                evidenceIds: z.array(z.string()).min(1).max(2)
              })
              .passthrough()
          )
        })
        .passthrough()
    )
  })
  .passthrough();

export class FixtureLlmPort implements LlmPort {
  readonly provider = "fixture";
  readonly model = "phase4-fixture-v1";

  async generateStructured(
    request: LlmProviderRequest
  ): Promise<LlmProviderResponse> {
    const input = JSON.parse(request.input) as unknown;
    const output =
      request.purpose === "peer_rationale"
        ? peerOutput(input)
        : wordingOutput(input);
    return {
      output,
      providerRequestId: `fixture_${request.requestId}`,
      inputTokens: approximateTokens(
        `${request.instructions}\n${request.input}`
      ),
      outputTokens: approximateTokens(JSON.stringify(output)),
      finishReason: "completed",
      refusal: null,
      toolCalls: 0
    };
  }
}

function peerOutput(value: unknown): unknown {
  const input = PeerFixtureInputSchema.parse(value);
  return {
    peers: input.peers.map((peer) => ({
      peerId: peer.peerId,
      rationale:
        "This channel is included because its subscriber reach falls inside the approved comparison window.",
      evidenceIds: peer.evidenceIds
    }))
  };
}

function wordingOutput(value: unknown): unknown {
  const input = WordingFixtureInputSchema.parse(value);
  return {
    narratives: input.ledgers.map((ledger) => ({
      leadId: ledger.leadId,
      sentences: ledger.claims.map((claim) => ({
        text: sentenceForClaim(claim.claimId),
        claimIds: [claim.claimId],
        evidenceIds: claim.evidenceIds
      }))
    }))
  };
}

function sentenceForClaim(claimId: string): string {
  if (claimId.endsWith("_target_observed")) {
    return "The cited target evidence records an earlier observed paid placement for this brand.";
  }
  if (claimId.endsWith("_peer_observed")) {
    return "The cited peer evidence records a more recent observed paid placement for the same brand.";
  }
  if (claimId.endsWith("_same_brand_reactivation")) {
    return "The cited placements share a sponsor domain, while product, campaign, and buyer continuity remain unverified.";
  }
  return "The cited placements support continuity within the same product family, making this an outreach research candidate.";
}

function approximateTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

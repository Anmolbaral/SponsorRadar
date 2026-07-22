import { z } from "zod";
import type { AgentToolDefinition } from "@/src/agent/llm/agent-llm-port";
import type {
  NormalizedSponsorEvidence,
  NormalizedSponsorEvidenceResult
} from "@/src/radar/adapters/upriver/normalize";
import type {
  LockedPeer,
  ResolvedTarget
} from "@/src/radar/application/ports";
import type { EvidenceOperation } from "@/src/radar/application/tools/tool-registry";
import { reachRatio } from "@/src/radar/domain/reach";
import type {
  AgentAnalysis,
  AgentEvidenceState,
  AgentPeer
} from "@/src/radar/application/agentic/evidence-state";

/**
 * The agent proposal surface (ADR 0008). This catalog is a separate exposure
 * layer: `TOOL_REGISTRY.llmExposed` stays false — the model proposes calls
 * here and the broker executes them through the single `ToolExecutor`.
 * Arguments are reference-based so model output can never steer a paid call
 * to an arbitrary URL.
 */

const MAX_PROJECTED_ROWS = 40;
const MAX_PROJECTED_STRING = 120;
const MAX_ENVELOPE_BYTES = 8_000;

export const AGENT_TOOL_INPUT_SCHEMAS = {
  resolve_target: z
    .object({
      channel: z.string().min(1).max(200)
    })
    .strict(),
  list_locked_peers: z.object({}).strict(),
  list_target_sponsors: z.object({}).strict(),
  list_peer_sponsors: z
    .object({
      peerRef: z.string().min(1).max(20)
    })
    .strict(),
  analyze_evidence: z.object({}).strict(),
  submit_report: z
    .object({
      analysisRef: z.string().min(1).max(20).nullish(),
      outcome: z.literal("channel_not_found").nullish()
    })
    .strict()
} as const;

/**
 * OpenAI strict function calling rejects optional properties: every key must
 * be required and optionality expressed as null. The Zod schema above stays
 * permissive so scripted planners may omit keys entirely.
 */
const SUBMIT_REPORT_WIRE_SCHEMA = {
  type: "object",
  properties: {
    analysisRef: {
      anyOf: [{ type: "string", minLength: 1, maxLength: 20 }, { type: "null" }]
    },
    outcome: {
      anyOf: [{ type: "string", enum: ["channel_not_found"] }, { type: "null" }]
    }
  },
  required: ["analysisRef", "outcome"],
  additionalProperties: false
} as const;

export type AgentToolName = keyof typeof AGENT_TOOL_INPUT_SCHEMAS;

interface AgentToolCatalogEntry {
  kind: "evidence" | "local";
  operation: EvidenceOperation | null;
  description: string;
}

export const AGENT_TOOL_CATALOG: Record<AgentToolName, AgentToolCatalogEntry> =
  {
    resolve_target: {
      kind: "evidence",
      operation: "resolve_target",
      description:
        "Resolve and verify the requested YouTube channel to an exact channel identity, and load the research windows (target window, peer window, stale cutoff). Must succeed before any other tool. Cost: 1 credit. If it reports channel_not_found, finish immediately with submit_report outcome \"channel_not_found\"."
    },
    list_locked_peers: {
      kind: "evidence",
      operation: "list_locked_peers",
      description:
        "Discover up to three reach-comparable peer channels for the resolved target. Requires resolve_target first. Returns peerRef handles used by list_peer_sponsors. Cost: up to 10 credits."
    },
    list_target_sponsors: {
      kind: "evidence",
      operation: "list_target_sponsors",
      description:
        "Retrieve the resolved target's sponsor history over the 365-day target window. This is the most expensive call (up to 115 credits) — only worth it when peer evidence shows a joinable signal."
    },
    list_peer_sponsors: {
      kind: "evidence",
      operation: "list_peer_sponsors",
      description:
        "Retrieve recent explicit sponsorships for one locked peer, addressed by its peerRef from list_locked_peers. Cost: up to 10 credits per peer."
    },
    analyze_evidence: {
      kind: "local",
      operation: null,
      description:
        "Run the deterministic same-brand reactivation qualification over all evidence gathered so far (stale target sponsors joined to recent peer sponsors by exact normalized domain). Free. Requires sponsors for every locked peer; target history is optional but without it there can be no leads. Returns an analysisRef for submit_report."
    },
    submit_report: {
      kind: "local",
      operation: null,
      description:
        "Finalize the run; this is the only way to finish. Free. Pass the analysisRef from analyze_evidence to submit the report — or, only after resolve_target reported channel_not_found, pass outcome \"channel_not_found\" instead to end the run without a report."
    }
  };

export function agentToolDefinitions(): AgentToolDefinition[] {
  return (Object.keys(AGENT_TOOL_CATALOG) as AgentToolName[]).map((name) => ({
    name,
    description: AGENT_TOOL_CATALOG[name].description,
    inputSchema: (name === "submit_report"
      ? SUBMIT_REPORT_WIRE_SCHEMA
      : z.toJSONSchema(AGENT_TOOL_INPUT_SCHEMAS[name], {
          target: "draft-2020-12"
        })) as AgentToolDefinition["inputSchema"]
  }));
}

export function isAgentToolName(name: string): name is AgentToolName {
  return name in AGENT_TOOL_CATALOG;
}

/** Field-allowlisted projections — the only evidence shapes the model sees. */

export function projectResolvedTarget(resolved: ResolvedTarget): unknown {
  return {
    target: {
      name: boundedText(resolved.target.name),
      subscriberCount: resolved.target.subscriberCount
    },
    identity: {
      handle:
        resolved.identity.handle === null
          ? null
          : boundedText(resolved.identity.handle),
      channelId:
        resolved.identity.channelId === null
          ? null
          : boundedText(resolved.identity.channelId)
    },
    windows: {
      targetWindow: resolved.config.target_window,
      peerWindow: resolved.config.peer_window,
      staleCutoffExclusive: resolved.config.stale_cutoff_exclusive,
      asOf: resolved.config.as_of
    }
  };
}

export function projectLockedPeers(
  target: ResolvedTarget["target"],
  peers: readonly AgentPeer[]
): unknown {
  return {
    peerCount: peers.length,
    peers: peers.map((peer) => ({
      peerRef: peer.peerRef,
      name: boundedText(peer.name),
      subscriberCount: peer.subscriberCount,
      reachRatio: roundedReachRatio(target.subscriberCount, peer)
    }))
  };
}

export function projectSponsorResult(
  result: NormalizedSponsorEvidenceResult,
  context: { peerRef?: string }
): unknown {
  const rows = result.rows.slice(0, MAX_PROJECTED_ROWS);
  return {
    ...(context.peerRef ? { peerRef: context.peerRef } : {}),
    rowCount: result.rows.length,
    truncatedRows: Math.max(0, result.rows.length - rows.length),
    completeness: result.completeness,
    trackingStatus: result.trackingStatus
      ? boundedText(result.trackingStatus.status)
      : null,
    rows: rows.map(projectSponsorRow)
  };
}

function projectSponsorRow(sponsor: NormalizedSponsorEvidence): unknown {
  return {
    sponsorName: boundedText(sponsor.sponsorName),
    domain: sponsor.normalizedDomain,
    publishedDate: sponsor.publishedDate,
    placementType: boundedText(sponsor.placementType),
    totalAdsFound: sponsor.totalAdsFound,
    evidenceConfidence: sponsor.evidenceConfidence,
    hasExcerpt: sponsor.excerpt !== null
  };
}

export function projectAnalysis(analysis: AgentAnalysis): unknown {
  return {
    analysisRef: analysis.analysisRef,
    leadCount: analysis.qualification.leads.length,
    targetHistorySearched: analysis.targetHistorySearched,
    funnel: analysis.funnel,
    leads: analysis.qualification.leads.map((lead) => ({
      brand: boundedText(lead.brand),
      domain: lead.domain,
      peer: boundedText(lead.peer)
    }))
  };
}

/**
 * Serialize a tool-result envelope for model context: control characters
 * stripped and a hard byte cap so no provider text can flood the transcript.
 */
export function serializeEnvelope(envelope: unknown): string {
  const serialized = JSON.stringify(envelope);
  const sanitized = serialized.replace(CONTROL_CHARACTERS, "");
  if (Buffer.byteLength(sanitized, "utf8") <= MAX_ENVELOPE_BYTES) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_ENVELOPE_BYTES - 20)}\u2026truncated"}`;
}

const CONTROL_CHARACTERS = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]",
  "g"
);
function boundedText(value: string): string {
  const stripped = value.replace(CONTROL_CHARACTERS, " ");
  return stripped.length <= MAX_PROJECTED_STRING
    ? stripped
    : `${stripped.slice(0, MAX_PROJECTED_STRING - 1)}\u2026`;
}

function roundedReachRatio(
  targetSubscriberCount: number,
  peer: LockedPeer
): number | null {
  const ratio = reachRatio(targetSubscriberCount, peer.subscriberCount);
  return ratio === null ? null : Math.round(ratio * 100) / 100;
}

export type { AgentEvidenceState };

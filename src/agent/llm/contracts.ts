import { z } from "zod";
import type { JsonSchema } from "@/src/agent/llm/llm-port";

const OpaqueIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{2,79}$/);
const EvidenceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9:_-]{2,119}$/);
const SafeTextSchema = z.string().trim().min(20).max(320);

const PeerRationaleItemSchema = z
  .object({
    peerId: OpaqueIdSchema,
    rationale: SafeTextSchema,
    evidenceIds: z.array(EvidenceIdSchema).length(2)
  })
  .strict();
const PeerRationaleOutputSchema = z
  .object({
    peers: z.array(PeerRationaleItemSchema).min(1).max(3)
  })
  .strict();

const GroundedSentenceSchema = z
  .object({
    text: SafeTextSchema,
    claimIds: z.array(OpaqueIdSchema).min(1).max(3),
    evidenceIds: z.array(EvidenceIdSchema).min(1).max(2)
  })
  .strict();
const GroundedNarrativeSchema = z
  .object({
    leadId: OpaqueIdSchema,
    sentences: z.array(GroundedSentenceSchema).min(1).max(3)
  })
  .strict();
const GroundedWordingOutputSchema = z
  .object({
    narratives: z.array(GroundedNarrativeSchema).max(3)
  })
  .strict();

const SAME_BRAND_REACTIVATION_CLAIM_SUFFIX =
  "_same_brand_reactivation";
const CONTINUITY_DIMENSION = String.raw`(?:product(?:\s+(?:line|family|continuity))?|campaign(?:\s+continuity)?|buyer(?:\s+(?:identity|continuity))?|agency(?:\s+(?:identity|continuity))?|budget(?:\s+continuity)?|commercial\s+relationship|relationship(?:\s+(?:details?|status|continuity))?|contract|deal|account(?:\s+(?:owner|team))?|sales(?:\s+(?:owner|team))?|decision[- ]maker|contact|team|creative|offer|messaging?|strategy|terms|scope|activation|media\s+plan|insertion\s+order|spend|rate|continuity)`;
const QUALIFIED_CONTINUITY_DIMENSION = String.raw`(?:(?:the|a|any)\s+)?(?:(?:same|shared)\s+)?${CONTINUITY_DIMENSION}`;
const CONTINUITY_DIMENSION_LIST = String.raw`${QUALIFIED_CONTINUITY_DIMENSION}(?:\s*(?:(?:,\s*)?(?:and|or)|/|,)\s*${QUALIFIED_CONTINUITY_DIMENSION})*`;
const CONTINUITY_DIMENSION_PATTERN = new RegExp(
  String.raw`\b${CONTINUITY_DIMENSION}\b`,
  "i"
);
const SAME_BRAND_RELATIONSHIP = String.raw`\b(?:(?:same[- ]brand|(?:same|shared|matching)\s+sponsor)(?:\s+domain)?|share(?:s|d)?\s+(?:(?:a|the)\s+)?sponsor\s+domain|sponsor\s+domain\s+(?:matches|matched|is\s+(?:shared|the\s+same)))\b`;
const SAME_BRAND_RELATIONSHIP_PATTERN = new RegExp(
  SAME_BRAND_RELATIONSHIP,
  "i"
);
const SAME_BRAND_RELATIONSHIP_GLOBAL_PATTERN = new RegExp(
  SAME_BRAND_RELATIONSHIP,
  "gi"
);
const RESIDUAL_CONTINUITY_ASSERTION_PATTERN =
  /\b(?:continued|continues|continuing|renewed|reactivated|unchanged|persists?|retained|carried\s+over)\b|\b(?:it|they|these|those|both)\b.{0,30}\b(?:same|shared|ongoing|active|current|consistent)\b/i;
const EXPLICIT_CONTINUITY_UNCERTAINTY_PATTERNS = [
  new RegExp(
    String.raw`\b${CONTINUITY_DIMENSION_LIST}\s+(?:(?:remain|stay)s?|is|are|was|were)\s+(?:unverified|unknown|uncertain|not\s+(?:verified|established|known|confirmed|supported|shown|demonstrated|proven))\b`,
    "gi"
  ),
  new RegExp(
    String.raw`\b${CONTINUITY_DIMENSION_LIST}\s+(?:has|have|had)\s+not\s+been\s+(?:verified|established|confirmed|supported|shown|demonstrated|proven)\b`,
    "gi"
  ),
  new RegExp(
    String.raw`\b(?:(?:does|do|did|could|may|might)\s+not|cannot|can['’]?t|fails?\s+to)\s+(?:verify|establish|confirm|support|show|demonstrate|prove)\s+(?:(?:that|whether)\s+)?${CONTINUITY_DIMENSION_LIST}\b`,
    "gi"
  ),
  new RegExp(
    String.raw`\b(?:no|insufficient)\s+(?:cited\s+)?evidence\s+(?:(?:verifies|establishes|confirms|supports|shows|demonstrates|proves)\s+|(?:of|for)\s+)?${CONTINUITY_DIMENSION_LIST}\b`,
    "gi"
  )
] as const;

export interface ExpectedPeerRationale {
  peerId: string;
  evidenceIds: readonly [string, string];
}

export interface PeerRationaleArtifact {
  peerId: string;
  rationale: string;
  evidenceIds: [string, string];
}

export interface GroundingClaim {
  claimId: string;
  evidenceIds: readonly string[];
}

export interface GroundingLedger {
  leadId: string;
  claims: readonly GroundingClaim[];
}

export interface GroundedSentenceArtifact {
  text: string;
  claimIds: string[];
  evidenceIds: string[];
}

export interface GroundedNarrativeArtifact {
  leadId: string;
  sentences: GroundedSentenceArtifact[];
}

export function peerRationaleJsonSchema(
  expected: readonly ExpectedPeerRationale[]
): JsonSchema {
  assertExpectedPeers(expected);
  return {
    type: "object",
    additionalProperties: false,
    required: ["peers"],
    properties: {
      peers: {
        type: "array",
        minItems: expected.length,
        maxItems: expected.length,
        items: {
          anyOf: expected.map((peer) => ({
            type: "object",
            additionalProperties: false,
            required: ["peerId", "rationale", "evidenceIds"],
            properties: {
              peerId: {
                type: "string",
                enum: [peer.peerId]
              },
              rationale: {
                type: "string",
                minLength: 20,
                maxLength: 320
              },
              evidenceIds: {
                type: "array",
                minItems: 2,
                maxItems: 2,
                items: {
                  type: "string",
                  enum: [...peer.evidenceIds]
                }
              }
            }
          }))
        }
      }
    }
  };
}

export function groundedWordingJsonSchema(
  ledgers: readonly GroundingLedger[]
): JsonSchema {
  assertGroundingLedgers(ledgers);
  return {
    type: "object",
    additionalProperties: false,
    required: ["narratives"],
    properties: {
      narratives: {
        type: "array",
        minItems: ledgers.length,
        maxItems: ledgers.length,
        items: {
          anyOf: ledgers.map((ledger) => {
            const claimIds = ledger.claims.map(
              (claim) => claim.claimId
            );
            const evidenceIds = [
              ...new Set(
                ledger.claims.flatMap(
                  (claim) => claim.evidenceIds
                )
              )
            ];
            return {
              type: "object",
              additionalProperties: false,
              required: ["leadId", "sentences"],
              properties: {
                leadId: {
                  type: "string",
                  enum: [ledger.leadId]
                },
                sentences: {
                  type: "array",
                  minItems: 1,
                  maxItems: ledger.claims.length,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: [
                      "text",
                      "claimIds",
                      "evidenceIds"
                    ],
                    properties: {
                      text: {
                        type: "string",
                        minLength: 20,
                        maxLength: 320
                      },
                      claimIds: {
                        type: "array",
                        minItems: 1,
                        maxItems: ledger.claims.length,
                        items: {
                          type: "string",
                          enum: claimIds
                        }
                      },
                      evidenceIds: {
                        type: "array",
                        minItems: 1,
                        maxItems: 2,
                        items: {
                          type: "string",
                          enum: evidenceIds
                        }
                      }
                    }
                  }
                }
              }
            };
          })
        }
      }
    }
  };
}

export function parsePeerRationaleOutput(
  value: unknown,
  expected: readonly ExpectedPeerRationale[]
): PeerRationaleArtifact[] {
  const parsed = PeerRationaleOutputSchema.parse(value).peers;
  if (parsed.length !== expected.length) {
    throw new LlmGroundingError(
      "Peer rationale output changed the locked cohort size"
    );
  }
  return parsed.map((item, index) => {
    const required = expected[index];
    if (item.peerId !== required.peerId) {
      throw new LlmGroundingError(
        "Peer rationale output changed the locked cohort order or identity"
      );
    }
    assertExactUniqueIds(
      item.evidenceIds,
      required.evidenceIds,
      "peer evidence"
    );
    assertSafeGeneratedText(item.rationale);
    if (!/\b(reach|subscriber|audience size)\b/i.test(item.rationale)) {
      throw new LlmGroundingError(
        "Peer rationale must stay within the supplied reach evidence"
      );
    }
    if (
      containsNumericClaim(item.rationale) ||
      /https?:\/\//i.test(item.rationale)
    ) {
      throw new LlmGroundingError(
        "Peer rationale may not introduce generated numeric or URL claims"
      );
    }
    return {
      peerId: item.peerId,
      rationale: item.rationale,
      evidenceIds: [
        item.evidenceIds[0],
        item.evidenceIds[1]
      ]
    };
  });
}

export function parseGroundedWordingOutput(
  value: unknown,
  ledgers: readonly GroundingLedger[]
): GroundedNarrativeArtifact[] {
  const parsed = GroundedWordingOutputSchema.parse(value).narratives;
  if (parsed.length !== ledgers.length) {
    throw new LlmGroundingError(
      "Grounded wording output changed the qualified lead count"
    );
  }
  return parsed.map((narrative, index) => {
    const ledger = ledgers[index];
    if (narrative.leadId !== ledger.leadId) {
      throw new LlmGroundingError(
        "Grounded wording output changed lead identity or order"
      );
    }
    const allowedClaims = new Map(
      ledger.claims.map((claim) => [claim.claimId, claim])
    );
    const usedClaims: string[] = [];
    for (const sentence of narrative.sentences) {
      assertUnique(sentence.claimIds, "claim IDs");
      const expectedEvidence = sentence.claimIds.flatMap((claimId) => {
        const claim = allowedClaims.get(claimId);
        if (!claim) {
          throw new LlmGroundingError(
            `Generated wording cited unknown claim ${claimId}`
          );
        }
        return claim.evidenceIds;
      });
      const citesSameBrandReactivation = sentence.claimIds.some(
        (claimId) =>
          claimId.endsWith(SAME_BRAND_REACTIVATION_CLAIM_SUFFIX)
      );
      assertSafeGeneratedText(sentence.text, {
        allowContinuityUncertainty: citesSameBrandReactivation
      });
      if (
        citesSameBrandReactivation
      ) {
        assertSameBrandReactivationWording(sentence.text);
      }
      if (containsNumericClaim(sentence.text) || /https?:\/\//i.test(sentence.text)) {
        throw new LlmGroundingError(
          "Generated wording may not introduce numeric or URL claims"
        );
      }
      assertExactUniqueIds(
        sentence.evidenceIds,
        [...new Set(expectedEvidence)],
        "sentence evidence"
      );
      usedClaims.push(...sentence.claimIds);
    }
    assertExactUniqueIds(
      usedClaims,
      ledger.claims.map((claim) => claim.claimId),
      "material claims"
    );
    return {
      leadId: narrative.leadId,
      sentences: narrative.sentences.map((sentence) => ({
        text: sentence.text,
        claimIds: [...sentence.claimIds],
        evidenceIds: [...sentence.evidenceIds]
      }))
    };
  });
}

export class LlmGroundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmGroundingError";
  }
}

function assertExpectedPeers(
  expected: readonly ExpectedPeerRationale[]
): void {
  if (expected.length < 1 || expected.length > 3) {
    throw new LlmGroundingError(
      "Peer schema requires one to three locked peers"
    );
  }
  assertUnique(
    expected.map((peer) => peer.peerId),
    "peer schema IDs"
  );
  for (const peer of expected) {
    assertOpaqueId(peer.peerId, "peer schema ID");
    if (peer.evidenceIds.length !== 2) {
      throw new LlmGroundingError(
        "Peer schema requires exactly two evidence IDs"
      );
    }
    assertUnique(peer.evidenceIds, "peer schema evidence IDs");
    for (const evidenceId of peer.evidenceIds) {
      assertEvidenceId(evidenceId, "peer schema evidence ID");
    }
  }
}

function assertGroundingLedgers(
  ledgers: readonly GroundingLedger[]
): void {
  if (ledgers.length < 1 || ledgers.length > 3) {
    throw new LlmGroundingError(
      "Grounded wording schema requires one to three ledgers"
    );
  }
  assertUnique(
    ledgers.map((ledger) => ledger.leadId),
    "grounding schema lead IDs"
  );
  const allClaimIds: string[] = [];
  for (const ledger of ledgers) {
    assertOpaqueId(ledger.leadId, "grounding schema lead ID");
    if (ledger.claims.length < 1 || ledger.claims.length > 3) {
      throw new LlmGroundingError(
        "Grounding schema requires one to three claims per lead"
      );
    }
    assertUnique(
      ledger.claims.map((claim) => claim.claimId),
      "grounding schema claim IDs"
    );
    for (const claim of ledger.claims) {
      assertOpaqueId(claim.claimId, "grounding schema claim ID");
      if (
        claim.evidenceIds.length < 1 ||
        claim.evidenceIds.length > 2
      ) {
        throw new LlmGroundingError(
          "Grounding schema requires one or two evidence IDs per claim"
        );
      }
      assertUnique(
        claim.evidenceIds,
        "grounding schema evidence IDs"
      );
      for (const evidenceId of claim.evidenceIds) {
        assertEvidenceId(
          evidenceId,
          "grounding schema evidence ID"
        );
      }
      allClaimIds.push(claim.claimId);
    }
  }
  assertUnique(allClaimIds, "grounding schema claim IDs");
}

function assertOpaqueId(value: string, label: string): void {
  if (!OpaqueIdSchema.safeParse(value).success) {
    throw new LlmGroundingError(`${label} is invalid`);
  }
}

function assertEvidenceId(value: string, label: string): void {
  if (!EvidenceIdSchema.safeParse(value).success) {
    throw new LlmGroundingError(`${label} is invalid`);
  }
}

function assertSafeGeneratedText(
  value: string,
  options: { allowContinuityUncertainty?: boolean } = {}
): void {
  const forbidden = [
    /\b(?:ignore|override|reveal)\b.{0,30}\b(?:instruction|policy|prompt)\b/i,
    /\b(?:api[- ]?key|authorization header|system prompt)\b/i,
    /\b(?:call|invoke|run|use)\b.{0,50}\b(?:tool|api|http|endpoint)\b/i,
    /\b(?:stopped|ended|cancelled)\b.{0,20}\bsponsor/i,
    /\b(?:guarantee|definitely|certainly|proves?)\b/i,
    /```|<script|<\/?[a-z][^>]*>/i
  ];
  if (!options.allowContinuityUncertainty) {
    forbidden.push(
      /\b(?:buyer|agency|budget)\b/i,
      /\b(?:same|active|current)\b.{0,20}\bcampaign\b/i
    );
  }
  if (forbidden.some((pattern) => pattern.test(value))) {
    throw new LlmGroundingError(
      "Generated text contains an unsupported or instruction-like claim"
    );
  }
}

function assertSameBrandReactivationWording(value: string): void {
  if (!SAME_BRAND_RELATIONSHIP_PATTERN.test(value)) {
    throw new LlmGroundingError(
      "Same-brand reactivation wording must state only the shared sponsor-domain relationship"
    );
  }

  let uncertaintySpans = 0;
  let residual = value;
  for (const pattern of EXPLICIT_CONTINUITY_UNCERTAINTY_PATTERNS) {
    residual = residual.replace(pattern, () => {
      uncertaintySpans += 1;
      return " uncertainty-preserved ";
    });
  }
  residual = residual.replace(
    SAME_BRAND_RELATIONSHIP_GLOBAL_PATTERN,
    " sponsor-domain-observed "
  );
  if (uncertaintySpans === 0) {
    throw new LlmGroundingError(
      "Same-brand reactivation wording must explicitly preserve continuity uncertainty"
    );
  }
  if (
    CONTINUITY_DIMENSION_PATTERN.test(residual) ||
    RESIDUAL_CONTINUITY_ASSERTION_PATTERN.test(residual)
  ) {
    throw new LlmGroundingError(
      "Same-brand reactivation wording may not assert product, campaign, commercial-party, or other continuity"
    );
  }
}

function containsNumericClaim(value: string): boolean {
  return (
    /\d/.test(value) ||
    /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|million|billion|percent)\b/i.test(
      value
    )
  );
}

function assertExactUniqueIds(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  assertUnique(actual, label);
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new LlmGroundingError(
      `Generated ${label} did not exactly match the supplied ledger`
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new LlmGroundingError(`Generated ${label} contained duplicates`);
  }
}

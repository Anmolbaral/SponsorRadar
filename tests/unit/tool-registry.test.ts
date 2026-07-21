import { describe, expect, it } from "vitest";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import {
  auditToolName,
  composeResolutionCredits,
  composeRunCeilingCredits,
  DEFAULT_OPERATION_RESULT_CAPS,
  estimateOperationCredits,
  EVIDENCE_OPERATIONS,
  isRegisteredOperation,
  MAX_PEER_COHORT,
  parseAuditToolName,
  SIMILAR_CREATOR_RESULT_CAP,
  TOOL_REGISTRY
} from "@/src/radar/application/tools/tool-registry";
import { UPRIVER_CREDIT_RATES } from "@/src/radar/domain/credits";

describe("authoritative tool registry (ADR 0004)", () => {
  it("registers exactly the five canonical provider operations", () => {
    expect([...EVIDENCE_OPERATIONS].sort()).toEqual([
      "list_locked_peers",
      "list_peer_sponsors",
      "list_target_sponsors",
      "load_verification_ledger",
      "resolve_target"
    ]);
  });

  it("maps every registered operation to a callable evidence-port method", () => {
    const port = new FixtureEvidenceGateway(process.cwd());
    for (const operation of EVIDENCE_OPERATIONS) {
      const method = TOOL_REGISTRY[operation].portMethod;
      expect(typeof port[method]).toBe("function");
    }
    const registeredMethods = EVIDENCE_OPERATIONS.map(
      (operation) => TOOL_REGISTRY[operation].portMethod
    );
    expect(new Set(registeredMethods).size).toBe(
      EVIDENCE_OPERATIONS.length
    );
  });

  it("keeps brand research unregistered so it fails closed by omission", () => {
    expect(isRegisteredOperation("brand_research")).toBe(false);
    expect(EVIDENCE_OPERATIONS).not.toContain("brand_research");
  });

  it("never exposes any operation to the model", () => {
    for (const operation of EVIDENCE_OPERATIONS) {
      expect(TOOL_REGISTRY[operation].llmExposed).toBe(false);
    }
  });

  it("prices every operation with a valid rate kind and consistent settlement", () => {
    for (const operation of EVIDENCE_OPERATIONS) {
      const entry = TOOL_REGISTRY[operation];
      if (entry.billing === null) {
        expect(entry.settlement).toBe("free");
        expect(entry.replayClass).toBe("free_reread");
        continue;
      }
      expect(entry.billing.rateKind in UPRIVER_CREDIT_RATES).toBe(true);
      expect(entry.settlement).not.toBe("free");
      expect(entry.replayClass).toBe("paid_zero_retry");
    }
  });

  it("pins the per-operation credit estimates at the default caps", () => {
    expect(estimateOperationCredits("resolve_target")).toBe(1);
    expect(estimateOperationCredits("list_locked_peers")).toBe(
      SIMILAR_CREATOR_RESULT_CAP * UPRIVER_CREDIT_RATES.creatorResult
    );
    expect(estimateOperationCredits("list_locked_peers")).toBe(10);
    expect(estimateOperationCredits("list_target_sponsors")).toBe(115);
    expect(estimateOperationCredits("list_peer_sponsors")).toBe(10);
    expect(estimateOperationCredits("load_verification_ledger")).toBe(0);
  });

  it("pins the stage compositions that feed the immutable quote", () => {
    const estimate = (operation: Parameters<typeof estimateOperationCredits>[0]) =>
      estimateOperationCredits(operation, DEFAULT_OPERATION_RESULT_CAPS);
    expect(composeResolutionCredits(estimate)).toBe(11);
    expect(composeRunCeilingCredits(estimate)).toBe(156);
    expect(MAX_PEER_COHORT).toBe(3);
    // The workflow quote adds one execution-revalidation resolve credit,
    // giving the pinned 157-credit uncached total under the 160-credit
    // per-run maximum (see tests/acceptance/workflow.test.ts).
    expect(
      composeRunCeilingCredits(estimate) +
        estimateOperationCredits("resolve_target")
    ).toBe(157);
  });

  it("derives the frozen audit tool names for writers and readers", () => {
    expect(auditToolName("live", "resolve_target")).toBe(
      "live.resolve_target"
    );
    expect(auditToolName("fixture", "list_peer_sponsors")).toBe(
      "fixture.list_peer_sponsors"
    );
    expect(auditToolName("local", "load_verification_ledger")).toBe(
      "local.load_verification_ledger"
    );
  });

  it("parses recorded audit names back to registered operations only", () => {
    for (const operation of EVIDENCE_OPERATIONS) {
      expect(parseAuditToolName(auditToolName("live", operation))).toEqual({
        scope: "live",
        operation
      });
      expect(
        parseAuditToolName(auditToolName("fixture", operation))
      ).toEqual({ scope: "fixture", operation });
    }
    expect(parseAuditToolName("live.brand_research")).toBeNull();
    expect(parseAuditToolName("local.load_approved_peer_cohort")).toBeNull();
    expect(
      parseAuditToolName("upriver.http.live.resolve_target")
    ).toBeNull();
    expect(parseAuditToolName("resolve_target")).toBeNull();
  });
});

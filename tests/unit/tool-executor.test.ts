import { describe, expect, it } from "vitest";
import { AuditRecorder } from "@/src/observability/audit";
import type {
  EvidenceCacheStatus,
  EvidenceOperation,
  LockedPeer,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import {
  EvidenceToolExecutor,
  ToolPolicyViolationError
} from "@/src/radar/application/tools/tool-executor";
import { auditToolName } from "@/src/radar/application/tools/tool-registry";

class StubPort implements SponsorRadarEvidencePort {
  readonly mode: "fixture" | "live";
  cacheStatus: EvidenceCacheStatus = "not_applicable";
  calls: string[] = [];
  failWith: Error | null = null;
  sponsorRows: unknown = [];

  constructor(mode: "fixture" | "live" = "live") {
    this.mode = mode;
  }

  estimateCredits(operation: EvidenceOperation): number {
    return operation === "load_verification_ledger" ? 0 : 7;
  }

  estimateRunCredits(): number {
    return 100;
  }

  async inspectCache(): Promise<EvidenceCacheStatus> {
    return this.cacheStatus;
  }

  async resolveTarget(input: string) {
    this.calls.push(`resolveTarget:${input}`);
    if (this.failWith) throw this.failWith;
    return {
      target: { name: "Target", url: input, subscriberCount: 10 },
      identity: {} as never,
      config: {} as never
    };
  }

  async listTargetSponsors(targetUrl: string) {
    this.calls.push(`listTargetSponsors:${targetUrl}`);
    if (this.failWith) throw this.failWith;
    return {
      rows: this.sponsorRows,
      completeness: "complete",
      trackingStatus: null
    } as never;
  }

  async listLockedPeers(targetUrl: string): Promise<LockedPeer[]> {
    this.calls.push(`listLockedPeers:${targetUrl}`);
    if (this.failWith) throw this.failWith;
    return [
      { name: "Peer", url: targetUrl, subscriberCount: 10, creatorId: null }
    ];
  }

  async listPeerSponsors(peerUrl: string) {
    this.calls.push(`listPeerSponsors:${peerUrl}`);
    if (this.failWith) throw this.failWith;
    return {
      rows: [{ sponsor: "row" }, { sponsor: "row" }],
      completeness: "complete",
      trackingStatus: null
    } as never;
  }

  async loadVerificationLedger() {
    this.calls.push("loadVerificationLedger");
    if (this.failWith) throw this.failWith;
    return { peer_inventory: [{}], overlaps: [{}, {}] } as never;
  }
}

function executor(
  port: SponsorRadarEvidencePort,
  stage: "resolution" | "execution" | "report" = "report"
) {
  const audit = new AuditRecorder({ clock: () => 0 });
  return {
    audit,
    tools: new EvidenceToolExecutor({ port, audit, stage })
  };
}

const CALL = { reason: "test reason", auditInput: { probe: true } };

describe("evidence tool executor denial matrix", () => {
  it("refuses unregistered operations before any adapter or audit work", async () => {
    const port = new StubPort();
    const { audit, tools } = executor(port);
    await expect(
      tools.execute(
        "brand_research" as EvidenceOperation,
        { channel: "@x" } as never,
        CALL
      )
    ).rejects.toBeInstanceOf(ToolPolicyViolationError);
    expect(port.calls).toEqual([]);
    expect(audit.getEvents()).toEqual([]);
  });

  it("refuses operations outside their allowed stage with zero adapter work", async () => {
    const port = new StubPort();
    const { audit, tools } = executor(port, "resolution");
    await expect(
      tools.execute("list_target_sponsors", { targetUrl: "@x" }, CALL)
    ).rejects.toBeInstanceOf(ToolPolicyViolationError);
    await expect(
      tools.execute(
        "load_verification_ledger",
        { ledgerKey: "ledger" },
        CALL
      )
    ).rejects.toBeInstanceOf(ToolPolicyViolationError);
    expect(port.calls).toEqual([]);
    expect(audit.getEvents()).toEqual([]);
  });

  it("keeps peer discovery out of the execution stage", async () => {
    const port = new StubPort();
    const { tools } = executor(port, "execution");
    await expect(
      tools.execute(
        "list_locked_peers",
        { targetUrl: "@x", targetSubscriberCount: 10 },
        CALL
      )
    ).rejects.toBeInstanceOf(ToolPolicyViolationError);
    expect(port.calls).toEqual([]);
  });

  it("refuses invalid input before any adapter or audit work", async () => {
    const port = new StubPort();
    const { audit, tools } = executor(port);
    await expect(
      tools.execute("resolve_target", { channel: "   " }, CALL)
    ).rejects.toBeInstanceOf(ToolPolicyViolationError);
    await expect(
      tools.execute(
        "list_locked_peers",
        { targetUrl: "@x", targetSubscriberCount: 0 },
        CALL
      )
    ).rejects.toBeInstanceOf(ToolPolicyViolationError);
    expect(port.calls).toEqual([]);
    expect(audit.getEvents()).toEqual([]);
  });

  it("rejects adapter output that violates the structural contract", async () => {
    const port = new StubPort();
    port.sponsorRows = "not-an-array";
    const { audit, tools } = executor(port);
    await expect(
      tools.execute("list_target_sponsors", { targetUrl: "@x" }, CALL)
    ).rejects.toBeInstanceOf(ToolPolicyViolationError);
    expect(port.calls).toHaveLength(1);
    const [, failed] = audit.getEvents();
    expect(failed.eventType).toBe("tool.failed");
    expect(failed.tool?.errorType).toBe("ToolPolicyViolationError");
  });

  it("never retries a failed adapter call and records the failure", async () => {
    const port = new StubPort();
    port.failWith = new Error("provider unavailable");
    const { audit, tools } = executor(port);
    await expect(
      tools.execute("resolve_target", { channel: "@x" }, CALL)
    ).rejects.toThrow("provider unavailable");
    expect(port.calls).toEqual(["resolveTarget:@x"]);
    const events = audit.getEvents();
    expect(events.map((event) => event.eventType)).toEqual([
      "tool.started",
      "tool.failed"
    ]);
  });
});

describe("evidence tool executor audit and settlement", () => {
  it("records the frozen mode-scoped name and fixed-per-call settlement", async () => {
    const port = new StubPort("live");
    const { audit, tools } = executor(port);
    await tools.execute("resolve_target", { channel: "@x" }, CALL);
    const [started, completed] = audit.getEvents();
    expect(started.tool?.name).toBe(auditToolName("live", "resolve_target"));
    expect(started.tool?.estimatedCredits).toBe(7);
    expect(completed.tool?.rows).toBe(1);
    expect(completed.tool?.resultBasedCredits).toBe(1);
  });

  it("prices cache hits at zero estimated and settled credits", async () => {
    const port = new StubPort("live");
    port.cacheStatus = "hit";
    const { audit, tools } = executor(port);
    await tools.execute("list_peer_sponsors", { peerUrl: "@peer" }, CALL);
    const [started, completed] = audit.getEvents();
    expect(started.tool?.estimatedCredits).toBe(0);
    expect(completed.tool?.resultBasedCredits).toBe(0);
  });

  it("settles sponsor research from returned rows at the grouped rate", async () => {
    const port = new StubPort("live");
    const { audit, tools } = executor(port);
    await tools.execute("list_peer_sponsors", { peerUrl: "@peer" }, CALL);
    const [, completed] = audit.getEvents();
    expect(completed.tool?.rows).toBe(2);
    expect(completed.tool?.resultBasedCredits).toBe(10);
  });

  it("settles peer discovery from the observed HTTP usage when present", async () => {
    const port = new StubPort("live");
    const { audit, tools } = executor(port);
    audit.recordHttpLifecycle({
      phase: "completed",
      method: "POST",
      path: "/v1/creators/similar",
      requestId: "req-1",
      audit: {
        operation: auditToolName("live", "list_locked_peers"),
        reason: "test",
        estimatedCredits: 7
      },
      meta: { providerRequestId: null, latencyMs: 1, attempts: [{}] },
      usage: { rows: 4, resultBasedCredits: 4 }
    });
    await tools.execute(
      "list_locked_peers",
      { targetUrl: "@x", targetSubscriberCount: 10 },
      CALL
    );
    const completed = [...audit.getEvents()]
      .reverse()
      .find((event) => event.eventType === "tool.completed");
    expect(completed?.tool?.resultBasedCredits).toBe(4);
  });

  it("records the ledger as a local fixture-mode tool with no settlement", async () => {
    const port = new StubPort("fixture");
    const { audit, tools } = executor(port);
    port.cacheStatus = "hit";
    await tools.execute(
      "load_verification_ledger",
      { ledgerKey: "reach-matched-pilot-2026-07-19" },
      CALL
    );
    const [started, completed] = audit.getEvents();
    expect(started.tool?.name).toBe("local.load_verification_ledger");
    expect(started.tool?.mode).toBe("fixture");
    expect(completed.tool?.rows).toBe(3);
    expect(completed.tool?.resultBasedCredits).toBeNull();
  });

  it("resolves fresh only through resolveTargetFresh and prices it as a miss", async () => {
    const port = new StubPort("live");
    const fresh: SponsorRadarEvidencePort = Object.assign(port, {
      resolveTargetFresh: async (input: string) => {
        port.calls.push(`resolveTargetFresh:${input}`);
        return port.resolveTarget(`fresh:${input}`);
      }
    });
    port.cacheStatus = "hit";
    const { audit, tools } = executor(fresh);
    await tools.execute(
      "resolve_target",
      { channel: "@x", fresh: true },
      CALL
    );
    expect(port.calls[0]).toBe("resolveTargetFresh:@x");
    const [started] = audit.getEvents();
    expect(started.tool?.cacheStatus).toBe("miss");
    expect(started.tool?.estimatedCredits).toBe(7);
  });
});

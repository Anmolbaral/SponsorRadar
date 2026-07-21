import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CachedEvidenceGateway } from "@/src/radar/adapters/cache/cached-evidence-gateway";
import { FixtureEvidenceGateway } from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";
import { FileSystemWorkflowRepository } from "@/src/radar/adapters/persistence";
import type { JsonValue } from "@/src/radar/adapters/persistence";
import type {
  EvidenceOperation,
  SponsorRadarEvidencePort
} from "@/src/radar/application/ports";
import { runWinbackReport } from "@/src/radar/application/run-winback-report";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("cached evidence gateway", () => {
  it("turns an identical warm live run into cache hits with no provider calls or credits", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const coldProvider = new CountingLiveFixtureGateway(process.cwd());
    const coldGateway = new CachedEvidenceGateway(coldProvider, repository);

    const cold = await runWinbackReport(
      { channel: "@UrAvgConsumer", maximumCredits: 1_000 },
      coldGateway,
      { phase: "workflow_live" }
    );

    expect(cold.report.leads.map((lead) => lead.brand)).toEqual(["Dell"]);
    expect(coldProvider.totalCalls()).toBe(7);
    expect(
      cold.events
        .filter((event) => event.eventType === "tool.completed")
        .every((event) => event.tool?.cacheStatus === "miss")
    ).toBe(true);
    expect(cold.report.audit.resultBasedCreditEstimate).toBeGreaterThan(0);

    const warmProvider = new CountingLiveFixtureGateway(process.cwd());
    const warmGateway = new CachedEvidenceGateway(warmProvider, repository);
    const warm = await runWinbackReport(
      { channel: "https://youtube.com/@UrAvgConsumer", maximumCredits: 0 },
      warmGateway,
      { phase: "workflow_live" }
    );

    expect(warm.report.leads).toEqual(cold.report.leads);
    expect(warm.report.funnel).toEqual(cold.report.funnel);
    expect(warmProvider.totalCalls()).toBe(0);
    expect(warm.report.audit.resultBasedCreditEstimate).toBe(0);
    expect(
      warm.events
        .filter((event) => event.eventType === "tool.completed")
        .every(
          (event) =>
            event.tool?.cacheStatus === "hit" &&
            event.tool.estimatedCredits === 0 &&
            (event.tool.mode === "fixture"
              ? event.tool.resultBasedCredits === null
              : event.tool.resultBasedCredits === 0)
        )
    ).toBe(true);
  });

  it("treats expired cache entries as misses and refreshes them", async () => {
    const directory = await temporaryDirectory();
    let now = Date.parse("2026-07-19T12:00:00.000Z");
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => now
    });
    const firstProvider = new CountingLiveFixtureGateway(process.cwd());
    const first = new CachedEvidenceGateway(firstProvider, repository, {
      creatorTtlMs: 10,
      sponsorTtlMs: 10,
      verificationTtlMs: 10
    });

    await first.resolveTarget("@UrAvgConsumer");
    expect(firstProvider.calls.resolve_target).toBe(1);

    now += 11;
    const secondProvider = new CountingLiveFixtureGateway(process.cwd());
    const second = new CachedEvidenceGateway(secondProvider, repository, {
      creatorTtlMs: 10,
      sponsorTtlMs: 10,
      verificationTtlMs: 10
    });

    expect(await second.inspectCache("resolve_target", "@UrAvgConsumer")).toBe(
      "miss"
    );
    await second.resolveTarget("@UrAvgConsumer");
    expect(secondProvider.calls.resolve_target).toBe(1);
  });

  it("never serves fixture-warmed evidence to a live gateway", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const fixture = new CachedEvidenceGateway(
      new FixtureEvidenceGateway(process.cwd()),
      repository
    );

    await fixture.resolveTarget("@UrAvgConsumer");
    expect(
      await fixture.inspectCache("resolve_target", "@UrAvgConsumer")
    ).toBe("hit");

    const liveProvider = new CountingLiveFixtureGateway(process.cwd());
    const live = new CachedEvidenceGateway(liveProvider, repository);
    expect(
      await live.inspectCache("resolve_target", "@UrAvgConsumer")
    ).toBe("miss");

    await live.resolveTarget("@UrAvgConsumer");
    expect(liveProvider.calls.resolve_target).toBe(1);
    expect(
      await live.inspectCache("resolve_target", "@UrAvgConsumer")
    ).toBe("hit");
  });

  it("shares equivalent handle lookups without conflating legacy aliases", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const provider = new CountingLiveFixtureGateway(process.cwd());
    const gateway = new CachedEvidenceGateway(provider, repository);

    await gateway.resolveTarget("@UrAvgConsumer");

    await expect(
      gateway.inspectCache(
        "resolve_target",
        "youtube.com/@URAVGCONSUMER"
      )
    ).resolves.toBe("hit");
    await expect(
      gateway.inspectCache("resolve_target", "/c/UrAvgConsumer")
    ).resolves.toBe("miss");
    await expect(
      gateway.inspectCache("resolve_target", "/user/UrAvgConsumer")
    ).resolves.toBe("miss");
  });

  it("treats schema-v2 resolved targets without identity as misses", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const fixtureResolved = await new FixtureEvidenceGateway(
      process.cwd()
    ).resolveTarget("@UrAvgConsumer");
    const provider = new CountingLiveFixtureGateway(process.cwd());
    await repository.putCache({
      namespace: "sponsor-radar-upriver-evidence:live",
      key: resolveTargetCacheKey(provider.cachePolicyKey),
      valueSchemaVersion: 2,
      ttlMs: 60_000,
      value: {
        target: fixtureResolved.target,
        config: fixtureResolved.config
      } as unknown as JsonValue
    });
    const gateway = new CachedEvidenceGateway(provider, repository);

    await expect(
      gateway.inspectCache("resolve_target", "@UrAvgConsumer")
    ).resolves.toBe("miss");
    await expect(
      gateway.resolveTarget("@UrAvgConsumer")
    ).resolves.toMatchObject({
      identity: {
        channelId: "UC9fSZHEh6XsRpX-xJc6lT3A"
      }
    });
    expect(provider.calls.resolve_target).toBe(1);
  });

  it("rejects a malformed v3 cache pairing a target with another identity", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const fixtureResolved = await new FixtureEvidenceGateway(
      process.cwd()
    ).resolveTarget("@UrAvgConsumer");
    const provider = new CountingLiveFixtureGateway(process.cwd());
    await repository.putCache({
      namespace: "sponsor-radar-upriver-evidence:live",
      key: resolveTargetCacheKey(provider.cachePolicyKey),
      valueSchemaVersion: 3,
      ttlMs: 60_000,
      value: {
        ...fixtureResolved,
        identity: {
          verificationBasis: "exact_unique_handle",
          channelId: null,
          handle: "MKBHD",
          canonicalUrl: "https://www.youtube.com/@MKBHD",
          key: "handle:mkbhd"
        }
      } as unknown as JsonValue
    });
    const gateway = new CachedEvidenceGateway(provider, repository);

    await expect(
      gateway.inspectCache("resolve_target", "@UrAvgConsumer")
    ).resolves.toBe("miss");
    await gateway.resolveTarget("@UrAvgConsumer");
    expect(provider.calls.resolve_target).toBe(1);
  });

  it("binds target sponsor cache entries to the verified channel ID", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const firstProvider = new ReassignedIdentityGateway(
      process.cwd(),
      "UCIdentityA123"
    );
    const first = new CachedEvidenceGateway(firstProvider, repository);
    const firstResolved = await first.resolveTarget("/c/OldAlias");
    await first.listTargetSponsors(firstResolved.target.url);
    expect(firstProvider.calls.list_target_sponsors).toBe(1);

    const secondProvider = new ReassignedIdentityGateway(
      process.cwd(),
      "UCIdentityB123"
    );
    const second = new CachedEvidenceGateway(secondProvider, repository);
    const secondResolved = await second.resolveTarget("/user/NewAlias");

    await expect(
      second.inspectCache(
        "list_target_sponsors",
        secondResolved.target.url
      )
    ).resolves.toBe("miss");
    await second.listTargetSponsors(secondResolved.target.url);
    expect(secondProvider.calls.list_target_sponsors).toBe(1);
  });

  it("bypasses a warm creator entry only for explicit fresh revalidation", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const firstProvider = new ReassignedIdentityGateway(
      process.cwd(),
      "UCIdentityA123"
    );
    const first = new CachedEvidenceGateway(firstProvider, repository);
    const initial = await first.resolveTarget("@UrAvgConsumer");
    expect(initial.identity.channelId).toBe("UCIdentityA123");

    const secondProvider = new ReassignedIdentityGateway(
      process.cwd(),
      "UCIdentityB123"
    );
    const second = new CachedEvidenceGateway(secondProvider, repository);
    const warm = await second.resolveTarget("@UrAvgConsumer");
    expect(warm.identity.channelId).toBe("UCIdentityA123");
    expect(secondProvider.calls.resolve_target).toBe(0);

    const fresh = await second.resolveTargetFresh("@UrAvgConsumer");
    expect(fresh.identity.channelId).toBe("UCIdentityB123");
    expect(secondProvider.calls.resolve_target).toBe(1);
    await expect(
      second.resolveTarget("@UrAvgConsumer")
    ).resolves.toMatchObject({
      identity: {
        channelId: "UCIdentityB123"
      }
    });
    expect(secondProvider.calls.resolve_target).toBe(1);
  });

  it("refuses target evidence operations before verified resolution", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const provider = new CountingLiveFixtureGateway(process.cwd());
    const gateway = new CachedEvidenceGateway(provider, repository);

    await expect(
      gateway.listTargetSponsors(
        "https://www.youtube.com/@UrAvgConsumer"
      )
    ).rejects.toThrow(/Resolve and verify/);
    await expect(
      gateway.listLockedPeers(
        "https://www.youtube.com/@UrAvgConsumer",
        3_450_000
      )
    ).rejects.toThrow(/Resolve and verify/);
    await expect(
      gateway.listPeerSponsors("https://www.youtube.com/@Dave2D")
    ).rejects.toThrow(/Resolve and verify/);
    expect(provider.calls.list_target_sponsors).toBe(0);
    expect(provider.calls.list_locked_peers).toBe(0);
    expect(provider.calls.list_peer_sponsors).toBe(0);
  });

  it("binds discovered peers to the target subscriber count", async () => {
    const directory = await temporaryDirectory();
    const repository = new FileSystemWorkflowRepository({ directory });
    const provider = new CountingLiveFixtureGateway(process.cwd());
    const gateway = new CachedEvidenceGateway(provider, repository);
    const resolved = await gateway.resolveTarget("@UrAvgConsumer");

    await gateway.listLockedPeers(
      resolved.target.url,
      resolved.target.subscriberCount
    );
    expect(
      await gateway.inspectCache(
        "list_locked_peers",
        resolved.target.url,
        resolved.target.subscriberCount
      )
    ).toBe("hit");
    expect(
      await gateway.inspectCache(
        "list_locked_peers",
        resolved.target.url,
        resolved.target.subscriberCount + 1
      )
    ).toBe("miss");

    await gateway.listLockedPeers(
      resolved.target.url,
      resolved.target.subscriberCount + 1
    );
    expect(provider.calls.list_locked_peers).toBe(2);
  });

  it("prices sponsor refreshes as execution when creator evidence is still warm", async () => {
    const directory = await temporaryDirectory();
    let now = Date.parse("2026-07-19T12:00:00.000Z");
    const repository = new FileSystemWorkflowRepository({
      directory,
      clock: () => now
    });
    const options = {
      creatorTtlMs: 1_000,
      sponsorTtlMs: 10,
      verificationTtlMs: 1_000
    };
    const provider = new CountingLiveFixtureGateway(process.cwd());
    const warm = new CachedEvidenceGateway(
      provider,
      repository,
      options
    );
    const resolved = await warm.resolveTarget("@UrAvgConsumer");
    const peers = await warm.listLockedPeers(
      resolved.target.url,
      resolved.target.subscriberCount
    );
    await warm.listTargetSponsors(resolved.target.url);
    await Promise.all(
      peers.map((peer) => warm.listPeerSponsors(peer.url))
    );

    now += 11;
    const refreshed = new CachedEvidenceGateway(
      new CountingLiveFixtureGateway(process.cwd()),
      repository,
      options
    );
    await refreshed.prepareRun("@UrAvgConsumer");

    expect(refreshed.estimateResolutionCredits()).toBe(0);
    expect(refreshed.estimateRunCredits()).toBe(145);
    expect(
      await refreshed.inspectCache("resolve_target", "@UrAvgConsumer")
    ).toBe("hit");
    expect(
      await refreshed.inspectCache(
        "list_locked_peers",
        resolved.target.url,
        resolved.target.subscriberCount
      )
    ).toBe("hit");
    expect(
      await refreshed.inspectCache(
        "list_target_sponsors",
        resolved.target.url
      )
    ).toBe("miss");
  });

  it.each([
    {
      label: "as-of date",
      firstPolicy:
        "live:asOf=2026-07-19:targetCap=23:peerCap=2:similarCap=10",
      secondPolicy:
        "live:asOf=2026-07-20:targetCap=23:peerCap=2:similarCap=10"
    },
    {
      label: "result caps",
      firstPolicy:
        "live:asOf=2026-07-19:targetCap=23:peerCap=2:similarCap=10",
      secondPolicy:
        "live:asOf=2026-07-19:targetCap=20:peerCap=3:similarCap=10"
    }
  ])(
    "isolates cached evidence when the $label policy changes",
    async ({ firstPolicy, secondPolicy }) => {
      const directory = await temporaryDirectory();
      const repository = new FileSystemWorkflowRepository({ directory });
      const firstProvider = new CountingLiveFixtureGateway(
        process.cwd(),
        firstPolicy
      );
      const first = new CachedEvidenceGateway(
        firstProvider,
        repository
      );
      await first.resolveTarget("@UrAvgConsumer");

      const secondProvider = new CountingLiveFixtureGateway(
        process.cwd(),
        secondPolicy
      );
      const second = new CachedEvidenceGateway(
        secondProvider,
        repository
      );

      expect(
        await second.inspectCache("resolve_target", "@UrAvgConsumer")
      ).toBe("miss");
      await second.resolveTarget("@UrAvgConsumer");
      expect(secondProvider.calls.resolve_target).toBe(1);
    }
  );
});

class CountingLiveFixtureGateway implements SponsorRadarEvidencePort {
  readonly mode = "live" as const;
  readonly qualificationPolicy = "verified_product_continuity" as const;
  readonly cachePolicyKey: string;
  readonly calls: Record<EvidenceOperation, number> = {
    resolve_target: 0,
    list_target_sponsors: 0,
    list_locked_peers: 0,
    list_peer_sponsors: 0,
    load_verification_ledger: 0
  };
  private readonly fixture: FixtureEvidenceGateway;

  constructor(
    repositoryRoot: string,
    cachePolicyKey = "live:test-policy-v1"
  ) {
    this.fixture = new FixtureEvidenceGateway(repositoryRoot);
    this.cachePolicyKey = cachePolicyKey;
  }

  estimateCredits(operation: EvidenceOperation): number {
    switch (operation) {
      case "resolve_target":
        return 1;
      case "list_target_sponsors":
        return 115;
      case "list_locked_peers":
        return 3;
      case "list_peer_sponsors":
        return 10;
      case "load_verification_ledger":
        return 0;
    }
  }

  estimateRunCredits(): number {
    return 149;
  }

  resolveTarget(input: string) {
    this.calls.resolve_target += 1;
    return this.fixture.resolveTarget(input);
  }

  listTargetSponsors(targetUrl: string) {
    this.calls.list_target_sponsors += 1;
    return this.fixture.listTargetSponsors(targetUrl);
  }

  listLockedPeers(targetUrl: string, targetSubscriberCount?: number) {
    this.calls.list_locked_peers += 1;
    return this.fixture.listLockedPeers(
      targetUrl,
      targetSubscriberCount
    );
  }

  listPeerSponsors(peerUrl: string) {
    this.calls.list_peer_sponsors += 1;
    return this.fixture.listPeerSponsors(peerUrl);
  }

  loadVerificationLedger() {
    this.calls.load_verification_ledger += 1;
    return this.fixture.loadVerificationLedger();
  }

  totalCalls(): number {
    return Object.values(this.calls).reduce((sum, count) => sum + count, 0);
  }
}

class ReassignedIdentityGateway extends CountingLiveFixtureGateway {
  constructor(
    repositoryRoot: string,
    private readonly channelId: string
  ) {
    super(repositoryRoot, "live:reassigned-handle-test-v1");
  }

  override async resolveTarget(input: string) {
    void input;
    const resolved = await super.resolveTarget("@UrAvgConsumer");
    return {
      ...resolved,
      identity: {
        verificationBasis: "channel_id" as const,
        channelId: this.channelId,
        handle: "UrAvgConsumer",
        canonicalUrl: resolved.target.url,
        key: `channel:${this.channelId}`
      }
    };
  }
}

function resolveTargetCacheKey(cachePolicyKey: string): string {
  return JSON.stringify({
    operation: "resolve_target",
    normalizedInput: "handle:uravgconsumer",
    cachePolicyKey,
    policyVersion: "dynamic-cohort-v3"
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "sponsor-radar-evidence-cache-")
  );
  temporaryDirectories.push(directory);
  return directory;
}

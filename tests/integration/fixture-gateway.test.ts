import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FixtureEvidenceGateway,
  UnsupportedFixtureChannelError
} from "@/src/radar/adapters/fixtures/fixture-evidence-gateway";

const root = process.cwd();

describe("fixture evidence gateway", () => {
  it("loads the locked real-data cohort through production parsers", async () => {
    const gateway = new FixtureEvidenceGateway(root);
    const resolved = await gateway.resolveTarget("@UrAvgConsumer");
    const [targetRows, peers, ledger] = await Promise.all([
      gateway.listTargetSponsors(resolved.target.url),
      gateway.listLockedPeers(resolved.target.url),
      gateway.loadVerificationLedger()
    ]);
    const peerRows = await Promise.all(
      peers.map((peer) => gateway.listPeerSponsors(peer.url))
    );

    expect(resolved.target).toEqual({
      name: "UrAvgConsumer",
      url: "https://www.youtube.com/@UrAvgConsumer",
      subscriberCount: 3_450_000
    });
    expect(resolved.identity).toEqual({
      verificationBasis: "channel_id",
      channelId: "UC9fSZHEh6XsRpX-xJc6lT3A",
      handle: "UrAvgConsumer",
      canonicalUrl: "https://www.youtube.com/@UrAvgConsumer",
      key: "channel:UC9fSZHEh6XsRpX-xJc6lT3A"
    });
    expect(targetRows.rows).toHaveLength(89);
    expect(targetRows).toMatchObject({
      completeness: "complete",
      trackingStatus: null
    });
    expect(peers.map((peer) => peer.name)).toEqual([
      "Dave2D",
      "SarahGrace",
      "Hayls World"
    ]);
    expect(peerRows.map((result) => result.rows.length)).toEqual([1, 1, 1]);
    expect(ledger.overlaps).toHaveLength(1);
  });

  it("refuses to turn unsupported channels into fabricated fixture output", async () => {
    const gateway = new FixtureEvidenceGateway(root);
    await expect(gateway.resolveTarget("@MKBHD")).rejects.toBeInstanceOf(
      UnsupportedFixtureChannelError
    );
    await expect(
      gateway.resolveTarget("/c/UrAvgConsumer")
    ).rejects.toBeInstanceOf(UnsupportedFixtureChannelError);
    await expect(
      gateway.resolveTarget("/user/UrAvgConsumer")
    ).rejects.toBeInstanceOf(UnsupportedFixtureChannelError);
  });

  it.each([
    "UrAvgConsumer",
    "/@UrAvgConsumer",
    "youtube.com/@UrAvgConsumer",
    "/channel/UC9fSZHEh6XsRpX-xJc6lT3A"
  ])("uses captured identity proof for %s", async (input) => {
    const gateway = new FixtureEvidenceGateway(root);

    await expect(gateway.resolveTarget(input)).resolves.toMatchObject({
      identity: {
        verificationBasis: "channel_id",
        channelId: "UC9fSZHEh6XsRpX-xJc6lT3A"
      }
    });
  });

  it("detects accidental mutation of the golden captured files", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, "tests/fixtures/provenance.json"), "utf8")
    ) as {
      files: Array<{ path: string; sha256: string }>;
    };

    for (const entry of manifest.files) {
      const content = await readFile(path.join(root, entry.path));
      const hash = createHash("sha256").update(content).digest("hex");
      expect(hash, entry.path).toBe(entry.sha256);
    }
  });
});

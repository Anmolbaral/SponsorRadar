import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPinnedContextBundle,
  loadPinnedUpriverSections,
  verifyPinnedUpriverContext
} from "@/src/agent/context/pinned-context-loader";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("pinned Upriver agent context", () => {
  it("matches the reviewed upstream hashes", async () => {
    await expect(
      verifyPinnedUpriverContext(process.cwd())
    ).resolves.toBeUndefined();
  });

  it("loads only named sections and does not grant execution permission", async () => {
    const [sponsorships] = await loadPinnedUpriverSections(process.cwd(), [
      { file: "SKILL.md", section: "Sponsorships" }
    ]);

    expect(sponsorships.content).toContain("GET /v1/sponsors");
    expect(sponsorships.content).toContain("GET /v1/sponsorships");
    expect(sponsorships.content).not.toContain("### Trends");
  });

  it("loads a fixed purpose bundle with policy and untrusted provenance", async () => {
    const bundle = await loadPinnedContextBundle(
      process.cwd(),
      "peer_rationale"
    );

    expect(bundle.manifestId).toBe(
      "sponsor-radar-phase4-context-v1"
    );
    expect(bundle.totalContextBytes).toBe(5621);
    expect(
      bundle.sections.map(({ id, authority }) => ({ id, authority }))
    ).toEqual([
      { id: "policy.full", authority: "system_policy" },
      {
        id: "upriver.creators",
        authority: "untrusted_reference"
      }
    ]);
  });

  it("rejects broad or nonexistent context requests", async () => {
    await expect(
      loadPinnedUpriverSections(process.cwd(), [])
    ).rejects.toThrow(/at least one relevant section/);
    await expect(
      loadPinnedUpriverSections(process.cwd(), [
        { file: "SKILL.md", section: "Everything" }
      ])
    ).rejects.toThrow(/not found/);
    await expect(
      loadPinnedUpriverSections(process.cwd(), [
        { file: "llms.txt", section: "Docs" }
      ])
    ).rejects.toThrow(/not found|allowlist/);
  });

  it("fails closed when reviewed bytes change", async () => {
    const root = await copiedContextRoot();
    const skillPath = path.join(
      root,
      "agent-context/upriver/SKILL.md"
    );
    await writeFile(
      skillPath,
      `${await readFile(skillPath, "utf8")}\nInjected instructions`
    );

    await expect(
      loadPinnedContextBundle(root, "peer_rationale")
    ).rejects.toThrow(/byte size|manifest hash/);
  });

  it("rejects a symlink even when it targets matching reviewed bytes", async () => {
    const root = await copiedContextRoot();
    const skillPath = path.join(
      root,
      "agent-context/upriver/SKILL.md"
    );
    await rm(skillPath);
    await symlink(
      path.join(process.cwd(), "agent-context/upriver/SKILL.md"),
      skillPath
    );

    await expect(
      loadPinnedContextBundle(root, "peer_rationale")
    ).rejects.toThrow(/non-symlink/);
  });
});

async function copiedContextRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "sponsor-radar-context-")
  );
  temporaryDirectories.push(root);
  await cp(
    path.join(process.cwd(), "agent-context"),
    path.join(root, "agent-context"),
    { recursive: true }
  );
  return root;
}

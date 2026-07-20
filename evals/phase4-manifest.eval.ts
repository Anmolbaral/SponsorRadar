import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const ManifestSchema = z
  .object({
    schema_version: z.literal(1),
    eval_set_id: z.literal("sponsor-radar-phase4-frozen-v1"),
    frozen_at: z.iso.date(),
    hash_algorithm: z.literal("sha256"),
    files: z
      .array(
        z
          .object({
            path: z.string().regex(/^evals\/cases\/[a-z0-9-]+\.json$/),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            bytes: z.number().int().positive(),
            cases: z.number().int().positive()
          })
          .strict()
      )
      .length(3),
    gates: z
      .object({
        tool_policy_budget_compliance: z.literal(1),
        known_false_positive_leads: z.literal(0),
        result_inflation_cases_allowed: z.literal(0),
        material_claim_attribution: z.literal(1),
        minimum_labeled_cases: z.number().int().min(25),
        minimum_macro_f1: z.number().min(0.9).max(1)
      })
      .strict()
  })
  .strict();

describe("Phase 4 frozen eval manifest", () => {
  it("matches every reviewed case file byte-for-byte", async () => {
    const manifest = ManifestSchema.parse(
      JSON.parse(
        await readFile(
          path.join(process.cwd(), "evals/phase4-manifest.json"),
          "utf8"
        )
      ) as unknown
    );
    for (const entry of manifest.files) {
      const bytes = await readFile(path.join(process.cwd(), entry.path));
      expect(bytes.length, entry.path).toBe(entry.bytes);
      expect(
        createHash("sha256").update(bytes).digest("hex"),
        entry.path
      ).toBe(entry.sha256);
      expect(
        (JSON.parse(bytes.toString("utf8")) as unknown[]).length,
        entry.path
      ).toBe(entry.cases);
    }
  });
});

import { z } from "zod";

const CreditFeatureSchema = z
  .object({
    credit_rate: z.number(),
    quantity: z.number(),
    credits_used: z.number()
  })
  .passthrough();

const UpriverCreditsSchema = z
  .object({
    balance: z.number().nullable().optional(),
    usage: z.number().nullable().optional(),
    included_usage: z.number().nullable().optional(),
    usage_by_feature: z.record(z.string(), CreditFeatureSchema).optional()
  })
  .passthrough();

const UsageResponseSchema = z
  .object({
    usage_by_range: z.record(
      z.string(),
      z
        .object({
          features: z.record(z.string(), z.unknown())
        })
        .passthrough()
    )
  })
  .passthrough();

export interface CreditSnapshot {
  range: string;
  reportedUsage: number | null;
  includedUsage: number | null;
  balance: number | null;
  derivedUsage: number;
  rates: Record<string, number>;
  countersConsistent: boolean;
}

export function parseCreditSnapshot(
  input: unknown,
  range = "7d"
): CreditSnapshot {
  const response = UsageResponseSchema.parse(input);
  const selectedRange = response.usage_by_range[range];
  if (!selectedRange) {
    throw new Error(`usage range "${range}" was not present`);
  }

  const credits = UpriverCreditsSchema.parse(
    selectedRange.features.upriver_credits
  );
  const features = credits.usage_by_feature ?? {};
  const derivedUsage = Object.values(features).reduce(
    (sum, feature) => sum + feature.credits_used,
    0
  );
  const reportedUsage = credits.usage ?? null;

  return {
    range,
    reportedUsage,
    includedUsage: credits.included_usage ?? null,
    balance: credits.balance ?? null,
    derivedUsage,
    rates: Object.fromEntries(
      Object.entries(features).map(([name, feature]) => [
        name,
        feature.credit_rate
      ])
    ),
    countersConsistent:
      reportedUsage !== null && reportedUsage === derivedUsage
  };
}

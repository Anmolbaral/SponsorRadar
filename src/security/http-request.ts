import { parseYouTubeChannelReference } from "@/src/radar/domain/youtube";

const MAX_JSON_BODY_BYTES = 4_096;

type RequestGuardStatus = 400 | 403 | 413 | 415 | 422 | 429;

export class RequestGuardError extends Error {
  constructor(
    message: string,
    readonly status: RequestGuardStatus,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "RequestGuardError";
  }
}

export async function readBoundedJson(request: Request): Promise<unknown> {
  assertSameOriginMutation(request);

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new RequestGuardError(
      "Send the request as application/json",
      415
    );
  }

  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_JSON_BODY_BYTES)
  ) {
    throw new RequestGuardError("The request body is too large", 413);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
    throw new RequestGuardError("The request body is too large", 413);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestGuardError("Send a valid JSON request body", 400);
  }
}

export function assertExactYouTubeChannel(channel: string): void {
  try {
    parseYouTubeChannelReference(channel);
  } catch {
    throw new RequestGuardError(
      "Enter one exact YouTube channel handle or URL",
      422
    );
  }
}

export function enforceMutationRateLimit(
  request: Request,
  scope: "create_run" | "workflow_action" | "legacy_report"
): void {
  const policy =
    scope === "workflow_action"
      ? { maximum: 120, windowMs: 5 * 60_000 }
      : scope === "create_run"
        ? { maximum: 60, windowMs: 5 * 60_000 }
        : { maximum: 20, windowMs: 5 * 60_000 };
  const now = Date.now();
  pruneRateLimits(now);
  const key = `${scope}:${requestClientKey(request)}`;
  const existing = rateLimits.get(key);
  if (!existing || existing.expiresAt <= now) {
    rateLimits.set(key, {
      count: 1,
      expiresAt: now + policy.windowMs
    });
    return;
  }
  if (existing.count >= policy.maximum) {
    throw new RequestGuardError(
      "Too many workflow requests. Wait briefly before trying again.",
      429,
      Math.max(1, Math.ceil((existing.expiresAt - now) / 1_000))
    );
  }
  existing.count += 1;
}

export function resetRequestRateLimitsForTesting(): void {
  rateLimits.clear();
}

function assertSameOriginMutation(request: Request): void {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin && origin !== requestOrigin) {
    throw new RequestGuardError(
      "Cross-origin workflow mutations are not allowed",
      403
    );
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    fetchSite &&
    fetchSite !== "same-origin" &&
    fetchSite !== "same-site" &&
    fetchSite !== "none"
  ) {
    throw new RequestGuardError(
      "Cross-origin workflow mutations are not allowed",
      403
    );
  }
}

interface RateLimitEntry {
  count: number;
  expiresAt: number;
}

const globalRateLimitState = globalThis as typeof globalThis & {
  __sponsorRadarRateLimits?: Map<string, RateLimitEntry>;
};
const rateLimits =
  globalRateLimitState.__sponsorRadarRateLimits ??
  new Map<string, RateLimitEntry>();
globalRateLimitState.__sponsorRadarRateLimits = rateLimits;

function requestClientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const address = forwarded?.split(",", 1)[0]?.trim() || "unknown";
  return stableNonSecretHash(address);
}

function stableNonSecretHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function pruneRateLimits(now: number): void {
  for (const [key, value] of rateLimits) {
    if (value.expiresAt <= now) rateLimits.delete(key);
  }
  if (rateLimits.size > 5_000) {
    const oldest = [...rateLimits.entries()]
      .sort((left, right) => left[1].expiresAt - right[1].expiresAt)
      .slice(0, rateLimits.size - 5_000);
    for (const [key] of oldest) rateLimits.delete(key);
  }
}

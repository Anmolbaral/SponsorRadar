import { randomUUID } from "node:crypto";
import { ApiErrorSchema } from "@/src/radar/adapters/upriver/contracts";

export const UPRIVER_BASE_URL = "https://api.upriver.ai";

const TERMINAL_STATUS_CODES = new Set([400, 401, 403]);
const MAX_ERROR_BODY_LENGTH = 16_384;
const MAX_PROVIDER_CODE_LENGTH = 64;
const MAX_PROVIDER_MESSAGE_LENGTH = 300;

export type UpriverFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type UpriverQueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean)[];

export interface UpriverRequest<T> {
  method: "GET" | "POST";
  path: `/${string}`;
  query?: Readonly<Record<string, UpriverQueryValue>>;
  body?: unknown;
  audit?: {
    operation: string;
    reason: string;
    estimatedCredits?: number;
    creditsPerResult?: number;
    resultRows?: (data: T) => number;
  };
  /**
   * The adapter boundary must validate every successful JSON response.
   * A Zod schema's `parse` method can be passed directly.
   */
  validate: (input: unknown) => T;
}

export interface UpriverAttemptMetadata {
  attempt: number;
  status: number | null;
  outcome: "success" | "http_error" | "network_error" | "timeout";
  latencyMs: number;
  retryDelayMs: number | null;
  providerRequestId: string | null;
}

export interface UpriverRequestMetadata {
  requestId: string;
  providerRequestId: string | null;
  latencyMs: number;
  attempts: readonly UpriverAttemptMetadata[];
}

export interface UpriverResponse<T> {
  data: T;
  meta: UpriverRequestMetadata;
}

export type UpriverErrorCode =
  | "invalid_request"
  | "bad_request"
  | "authentication_failed"
  | "permission_denied"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "http_error"
  | "network_failure"
  | "timeout"
  | "invalid_response";

/** Upriver's own error code/message, bounded; the rest of the body is dropped. */
export interface UpriverProviderErrorDetail {
  providerCode: string | null;
  providerMessage: string | null;
}

interface UpriverLifecycleIdentity {
  method: "GET" | "POST";
  path: `/${string}`;
  requestId: string;
  audit?: {
    operation: string;
    reason: string;
    estimatedCredits: number;
  };
}

export type UpriverLifecycleEvent =
  | (UpriverLifecycleIdentity & {
      phase: "started";
    })
  | (UpriverLifecycleIdentity & {
      phase: "completed";
      meta: UpriverRequestMetadata;
      usage?: {
        rows: number;
        resultBasedCredits: number;
      };
    })
  | (UpriverLifecycleIdentity & {
      phase: "failed";
      code: UpriverErrorCode;
      status: number | null;
      meta: UpriverRequestMetadata;
    });

export type UpriverLifecycleObserver = (
  event: UpriverLifecycleEvent
) => void;

export interface UpriverTimer {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}

/**
 * Safe to log: carries no raw payload, headers, or query — only the
 * provider's error code/message as bounded, sanitized strings.
 */
export class UpriverHttpError extends Error {
  readonly name = "UpriverHttpError";
  readonly providerCode: string | null;
  readonly providerMessage: string | null;

  constructor(
    message: string,
    readonly code: UpriverErrorCode,
    readonly status: number | null,
    readonly meta: UpriverRequestMetadata,
    providerDetail?: UpriverProviderErrorDetail
  ) {
    super(message);
    this.providerCode = providerDetail?.providerCode ?? null;
    this.providerMessage = providerDetail?.providerMessage ?? null;
  }

  toJSON(): {
    name: string;
    message: string;
    code: UpriverErrorCode;
    status: number | null;
    providerCode: string | null;
    providerMessage: string | null;
    meta: UpriverRequestMetadata;
  } {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      providerCode: this.providerCode,
      providerMessage: this.providerMessage,
      meta: this.meta
    };
  }
}

export interface UpriverHttpClientOptions {
  apiKey: string;
  fetch?: UpriverFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  requestId?: () => string;
  /**
   * May be lowered by tests or callers, but may never exceed two retries.
   */
  maxRetries?: 0 | 1 | 2;
  baseBackoffMs?: number;
  maxRetryDelayMs?: number;
  attemptTimeoutMs?: number;
  timer?: UpriverTimer;
  /**
   * Observer failures are ignored so audit plumbing cannot change API results.
   * Events contain no query, request body, headers, or API key.
   */
  observer?: UpriverLifecycleObserver;
}

export interface CursorPage<T> {
  results: readonly T[];
  next_cursor?: string | null;
  has_more?: boolean;
}

export interface CursorPaginationBoundaries {
  pageSize: number;
  maxPages: number;
  maxResults: number;
  maxCredits: number;
  /**
   * These are conservative estimates used before each request. The helper
   * never starts a page whose worst-case cost would exceed maxCredits.
   */
  creditsPerRequest?: number;
  creditsPerResult?: number;
}

export interface CursorPaginationRequest<T> {
  path: `/${string}`;
  query?: Readonly<Record<string, UpriverQueryValue>>;
  audit?: {
    operation: string;
    reason: string;
  };
  validatePage: (input: unknown) => CursorPage<T>;
  boundaries: CursorPaginationBoundaries;
}

export type CursorPaginationStopReason =
  | "end"
  | "max_pages"
  | "max_results"
  | "max_credits";

export interface CursorPaginationResult<T> {
  results: readonly T[];
  pages: number;
  estimatedCredits: number;
  stopReason: CursorPaginationStopReason;
  requests: readonly UpriverRequestMetadata[];
}

export class UpriverHttpClient {
  private readonly apiKey: string;
  private readonly fetcher: UpriverFetch;
  private readonly sleeper: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly createRequestId: () => string;
  readonly maxRetries: 0 | 1 | 2;
  private readonly baseBackoffMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly timer: UpriverTimer;
  private readonly observer?: UpriverLifecycleObserver;

  constructor(options: UpriverHttpClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error("Upriver API key is required");
    }

    this.apiKey = apiKey;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleeper = options.sleep ?? defaultSleep;
    this.now = options.clock ?? Date.now;
    this.createRequestId = options.requestId ?? randomUUID;
    const maxRetries = options.maxRetries ?? 2;
    if (
      !Number.isInteger(maxRetries) ||
      maxRetries < 0 ||
      maxRetries > 2
    ) {
      throw new Error("maxRetries must be an integer from 0 to 2");
    }
    this.maxRetries = maxRetries;
    this.baseBackoffMs = positiveNumber(
      options.baseBackoffMs ?? 250,
      "baseBackoffMs"
    );
    this.maxRetryDelayMs = positiveNumber(
      options.maxRetryDelayMs ?? 30_000,
      "maxRetryDelayMs"
    );
    this.attemptTimeoutMs = positiveNumber(
      options.attemptTimeoutMs ?? 10_000,
      "attemptTimeoutMs"
    );
    this.timer = options.timer ?? defaultTimer;
    this.observer = options.observer;
  }

  async request<T>(request: UpriverRequest<T>): Promise<UpriverResponse<T>> {
    const requestId = this.createRequestId();
    const requestStartedAt = this.now();
    const attempts: UpriverAttemptMetadata[] = [];
    const identity: UpriverLifecycleIdentity = {
      method: request.method,
      path: request.path,
      requestId,
      ...(request.audit
        ? {
            audit: {
              operation: request.audit.operation,
              reason: request.audit.reason,
              estimatedCredits: request.audit.estimatedCredits ?? 0
            }
          }
        : {})
    };
    this.observe({ phase: "started", ...identity });

    try {
      const response = await this.executeRequest(
        request,
        requestId,
        requestStartedAt,
        attempts
      );
      this.observe({
        phase: "completed",
        ...identity,
        meta: response.meta,
        ...describeRequestUsage(request.audit, response.data)
      });
      return response;
    } catch (error) {
      const safeError =
        error instanceof UpriverHttpError
          ? error
          : this.error(
              "Upriver request failed",
              "network_failure",
              null,
              requestId,
              requestStartedAt,
              attempts
            );
      this.observe({
        phase: "failed",
        ...identity,
        code: safeError.code,
        status: safeError.status,
        meta: safeError.meta
      });
      throw safeError;
    }
  }

  private async executeRequest<T>(
    request: UpriverRequest<T>,
    requestId: string,
    requestStartedAt: number,
    attempts: UpriverAttemptMetadata[]
  ): Promise<UpriverResponse<T>> {
    const url = this.buildUrl(request.path, request.query, requestId, attempts);
    const init = this.buildRequestInit(request, requestId, attempts);

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      const attemptStartedAt = this.now();
      const controller = new AbortController();
      let timedOut = false;
      const timeoutHandle = this.timer.set(() => {
        timedOut = true;
        controller.abort();
      }, this.attemptTimeoutMs);
      let response: Response;

      try {
        response = await this.fetcher(url, {
          ...init,
          signal: controller.signal
        });
      } catch {
        this.clearTimer(timeoutHandle);
        const attemptMeta: UpriverAttemptMetadata = {
          attempt,
          status: null,
          outcome: timedOut ? "timeout" : "network_error",
          latencyMs: elapsed(attemptStartedAt, this.now()),
          retryDelayMs: null,
          providerRequestId: null
        };

        if (attempt <= this.maxRetries) {
          attemptMeta.retryDelayMs = this.backoffFor(attempt);
          attempts.push(attemptMeta);
          await this.sleeper(attemptMeta.retryDelayMs);
          continue;
        }

        attempts.push(attemptMeta);
        throw this.error(
          timedOut
            ? "Upriver request timed out after retrying"
            : "Upriver request failed after retrying",
          timedOut ? "timeout" : "network_failure",
          null,
          requestId,
          requestStartedAt,
          attempts
        );
      }

      const providerRequestId = response.headers.get("x-request-id");

      if (response.ok) {
        let input: unknown;
        try {
          input = await response.json();
        } catch {
          this.clearTimer(timeoutHandle);
          const bodyAttempt: UpriverAttemptMetadata = {
            attempt,
            status: response.status,
            outcome: timedOut ? "timeout" : "success",
            latencyMs: elapsed(attemptStartedAt, this.now()),
            retryDelayMs: null,
            providerRequestId
          };

          if (timedOut && attempt <= this.maxRetries) {
            bodyAttempt.retryDelayMs = this.backoffFor(attempt);
            attempts.push(bodyAttempt);
            await this.sleeper(bodyAttempt.retryDelayMs);
            continue;
          }

          attempts.push(bodyAttempt);
          throw this.error(
            timedOut
              ? "Upriver response body timed out after retrying"
              : "Upriver returned an invalid JSON response",
            timedOut ? "timeout" : "invalid_response",
            response.status,
            requestId,
            requestStartedAt,
            attempts
          );
        }

        this.clearTimer(timeoutHandle);
        const successAttempt: UpriverAttemptMetadata = {
          attempt,
          status: response.status,
          outcome: "success",
          latencyMs: elapsed(attemptStartedAt, this.now()),
          retryDelayMs: null,
          providerRequestId
        };
        attempts.push(successAttempt);

        let data: T;
        try {
          data = request.validate(input);
        } catch {
          throw this.error(
            "Upriver returned a response that failed validation",
            "invalid_response",
            response.status,
            requestId,
            requestStartedAt,
            attempts
          );
        }

        return {
          data,
          meta: this.metadata(requestId, requestStartedAt, attempts)
        };
      }

      const willRetry =
        !TERMINAL_STATUS_CODES.has(response.status) &&
        (response.status === 429 || response.status >= 500) &&
        attempt <= this.maxRetries;
      // Read before clearing the attempt timer so a stalled error body is
      // still bounded by the same abort controller as the request itself.
      const providerDetail = willRetry
        ? NO_PROVIDER_DETAIL
        : await readProviderErrorDetail(response);
      this.clearTimer(timeoutHandle);
      const latencyMs = elapsed(attemptStartedAt, this.now());
      const errorAttempt: UpriverAttemptMetadata = {
        attempt,
        status: response.status,
        outcome: "http_error",
        latencyMs,
        retryDelayMs: null,
        providerRequestId
      };

      if (willRetry) {
        errorAttempt.retryDelayMs =
          response.status === 429
            ? this.retryAfterOrBackoff(response.headers, attempt)
            : this.backoffFor(attempt);
        attempts.push(errorAttempt);
        await this.sleeper(errorAttempt.retryDelayMs);
        continue;
      }

      attempts.push(errorAttempt);
      throw this.error(
        safeHttpMessage(response.status),
        errorCodeForStatus(response.status),
        response.status,
        requestId,
        requestStartedAt,
        attempts,
        providerDetail
      );
    }

    throw new Error("Unreachable Upriver retry state");
  }

  /**
   * GET-only cursor helper for Upriver sponsorship list endpoints. It owns the
   * cursor and limit query keys so callers cannot accidentally bypass a bound.
   */
  async paginateCursor<T>(
    request: CursorPaginationRequest<T>
  ): Promise<CursorPaginationResult<T>> {
    const boundaries = parseBoundaries(request.boundaries);
    const results: T[] = [];
    const requests: UpriverRequestMetadata[] = [];
    const seenCursors = new Set<string>();
    const creditsPerRequest = boundaries.creditsPerRequest ?? 0;
    const creditsPerResult = boundaries.creditsPerResult ?? 0;
    let cursor: string | null = null;
    let pages = 0;
    let estimatedCredits = 0;

    while (true) {
      if (pages >= boundaries.maxPages) {
        return paginationResult(
          results,
          pages,
          estimatedCredits,
          "max_pages",
          requests
        );
      }

      const remainingResults = boundaries.maxResults - results.length;
      if (remainingResults <= 0) {
        return paginationResult(
          results,
          pages,
          estimatedCredits,
          "max_results",
          requests
        );
      }

      const remainingCredits = boundaries.maxCredits - estimatedCredits;
      if (remainingCredits < creditsPerRequest) {
        return paginationResult(
          results,
          pages,
          estimatedCredits,
          "max_credits",
          requests
        );
      }

      const creditLimitedResults =
        creditsPerResult === 0
          ? boundaries.pageSize
          : Math.floor(
              (remainingCredits - creditsPerRequest) / creditsPerResult
            );
      const limit = Math.min(
        boundaries.pageSize,
        remainingResults,
        creditLimitedResults
      );

      if (limit <= 0) {
        return paginationResult(
          results,
          pages,
          estimatedCredits,
          "max_credits",
          requests
        );
      }

      const query: Record<string, UpriverQueryValue> = {
        ...request.query,
        limit
      };
      delete query.cursor;
      if (cursor !== null) {
        query.cursor = cursor;
      }

      const response = await this.request({
        method: "GET",
        path: request.path,
        query,
        audit: request.audit
          ? {
              ...request.audit,
              estimatedCredits:
                creditsPerRequest + limit * creditsPerResult,
              creditsPerResult,
              resultRows: (page) => page.results.length
            }
          : undefined,
        validate: request.validatePage
      });
      const page = response.data;
      requests.push(response.meta);
      pages += 1;

      if (page.results.length > limit) {
        throw this.paginationResponseError(
          response.meta,
          "Upriver returned more results than requested"
        );
      }

      results.push(...page.results);
      estimatedCredits +=
        creditsPerRequest + page.results.length * creditsPerResult;

      const nextCursor = page.next_cursor ?? null;
      const hasMore = page.has_more ?? nextCursor !== null;

      if (!hasMore) {
        return paginationResult(
          results,
          pages,
          estimatedCredits,
          "end",
          requests
        );
      }

      if (results.length >= boundaries.maxResults) {
        return paginationResult(
          results,
          pages,
          estimatedCredits,
          "max_results",
          requests
        );
      }

      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw this.paginationResponseError(
          response.meta,
          "Upriver returned an invalid pagination cursor"
        );
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  private buildUrl(
    path: string,
    query: UpriverRequest<unknown>["query"],
    requestId: string,
    attempts: readonly UpriverAttemptMetadata[]
  ): URL {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
      throw this.error(
        "Upriver request path must be relative",
        "invalid_request",
        null,
        requestId,
        this.now(),
        attempts
      );
    }

    const url = new URL(path, UPRIVER_BASE_URL);
    for (const [key, rawValue] of Object.entries(query ?? {})) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        if (value !== null && value !== undefined) {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url;
  }

  private buildRequestInit<T>(
    request: UpriverRequest<T>,
    requestId: string,
    attempts: readonly UpriverAttemptMetadata[]
  ): RequestInit {
    if (request.method === "GET" && request.body !== undefined) {
      throw this.error(
        "GET requests cannot include a body",
        "invalid_request",
        null,
        requestId,
        this.now(),
        attempts
      );
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-API-Key": this.apiKey,
      "X-Request-ID": requestId
    };
    let body: string | undefined;

    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      try {
        body = JSON.stringify(request.body);
      } catch {
        throw this.error(
          "Upriver request body could not be serialized",
          "invalid_request",
          null,
          requestId,
          this.now(),
          attempts
        );
      }
    }

    return {
      method: request.method,
      headers,
      body
    };
  }

  private retryAfterOrBackoff(headers: Headers, attempt: number): number {
    const retryAfter = parseRetryAfter(
      headers.get("retry-after"),
      this.now()
    );
    return retryAfter === null
      ? this.backoffFor(attempt)
      : Math.min(retryAfter, this.maxRetryDelayMs);
  }

  private backoffFor(attempt: number): number {
    return Math.min(
      this.baseBackoffMs * 2 ** Math.max(0, attempt - 1),
      this.maxRetryDelayMs
    );
  }

  private observe(event: UpriverLifecycleEvent): void {
    try {
      this.observer?.(event);
    } catch {
      // Audit plumbing must never alter the provider request result.
    }
  }

  private clearTimer(handle: unknown): void {
    try {
      this.timer.clear(handle);
    } catch {
      // A timer adapter cleanup failure must not expose or replace API results.
    }
  }

  private metadata(
    requestId: string,
    startedAt: number,
    attempts: readonly UpriverAttemptMetadata[]
  ): UpriverRequestMetadata {
    const lastAttempt = attempts.at(-1);
    return {
      requestId,
      providerRequestId: lastAttempt?.providerRequestId ?? null,
      latencyMs: elapsed(startedAt, this.now()),
      attempts: [...attempts]
    };
  }

  private error(
    message: string,
    code: UpriverErrorCode,
    status: number | null,
    requestId: string,
    startedAt: number,
    attempts: readonly UpriverAttemptMetadata[],
    providerDetail?: UpriverProviderErrorDetail
  ): UpriverHttpError {
    return new UpriverHttpError(
      message,
      code,
      status,
      this.metadata(requestId, startedAt, attempts),
      providerDetail
    );
  }

  private paginationResponseError(
    meta: UpriverRequestMetadata,
    message: string
  ): UpriverHttpError {
    return new UpriverHttpError(
      message,
      "invalid_response",
      200,
      meta
    );
  }
}

function parseBoundaries(
  boundaries: CursorPaginationBoundaries
): CursorPaginationBoundaries {
  nonnegativeInteger(boundaries.maxPages, "maxPages");
  nonnegativeInteger(boundaries.maxResults, "maxResults");
  nonnegativeNumber(boundaries.maxCredits, "maxCredits");
  positiveInteger(boundaries.pageSize, "pageSize");
  nonnegativeNumber(
    boundaries.creditsPerRequest ?? 0,
    "creditsPerRequest"
  );
  nonnegativeNumber(boundaries.creditsPerResult ?? 0, "creditsPerResult");
  return boundaries;
}

function paginationResult<T>(
  results: readonly T[],
  pages: number,
  estimatedCredits: number,
  stopReason: CursorPaginationStopReason,
  requests: readonly UpriverRequestMetadata[]
): CursorPaginationResult<T> {
  return {
    results: [...results],
    pages,
    estimatedCredits,
    stopReason,
    requests: [...requests]
  };
}

function describeRequestUsage<T>(
  audit: UpriverRequest<T>["audit"],
  data: T
): {
  usage?: {
    rows: number;
    resultBasedCredits: number;
  };
} {
  if (!audit?.resultRows) return {};

  try {
    const rows = audit.resultRows(data);
    const creditsPerResult = audit.creditsPerResult ?? 0;
    if (
      !Number.isInteger(rows) ||
      rows < 0 ||
      !Number.isFinite(creditsPerResult) ||
      creditsPerResult < 0
    ) {
      return {};
    }
    return {
      usage: {
        rows,
        resultBasedCredits: rows * creditsPerResult
      }
    };
  } catch {
    return {};
  }
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt) ? null : Math.max(0, retryAt - now);
}

function errorCodeForStatus(status: number): UpriverErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "authentication_failed";
  if (status === 403) return "permission_denied";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_error";
  return "http_error";
}

function safeHttpMessage(status: number): string {
  if (status === 400) return "Upriver rejected the request";
  if (status === 401) return "Upriver authentication failed";
  if (status === 403) return "Upriver permission was denied";
  if (status === 404) return "Upriver could not find the requested resource";
  if (status === 429) return "Upriver rate limit was reached";
  if (status >= 500) return "Upriver remained unavailable after retrying";
  return `Upriver request failed with HTTP ${status}`;
}

const NO_PROVIDER_DETAIL: UpriverProviderErrorDetail = {
  providerCode: null,
  providerMessage: null
};

/**
 * Extracts only the structured `{detail: {code, message}}` form; free-text
 * and array details stay redacted (they can echo request content). Never
 * throws: an unreadable error body must not mask the HTTP failure.
 */
async function readProviderErrorDetail(
  response: Response
): Promise<UpriverProviderErrorDetail> {
  try {
    const body = await readBoundedBody(response, MAX_ERROR_BODY_LENGTH);
    if (body === null || body.length === 0) {
      return NO_PROVIDER_DETAIL;
    }
    const parsed = ApiErrorSchema.safeParse(JSON.parse(body));
    if (!parsed.success) {
      return NO_PROVIDER_DETAIL;
    }
    const detail = parsed.data.detail;
    if (typeof detail === "string" || Array.isArray(detail)) {
      return NO_PROVIDER_DETAIL;
    }
    const providerCode =
      typeof detail.code === "string" && PROVIDER_CODE_PATTERN.test(detail.code)
        ? detail.code
        : null;
    if (providerCode === null) {
      return NO_PROVIDER_DETAIL;
    }
    return {
      providerCode,
      providerMessage:
        typeof detail.message === "string"
          ? boundedErrorText(detail.message, MAX_PROVIDER_MESSAGE_LENGTH)
          : null
    };
  } catch {
    return NO_PROVIDER_DETAIL;
  }
}

/** Caps the read itself: an oversized body is abandoned, never buffered. */
async function readBoundedBody(
  response: Response,
  maximumBytes: number
): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return null;
  }
  if (!response.body) {
    const text = await response.text();
    return text.length > maximumBytes ? null : text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

const PROVIDER_CODE_PATTERN = new RegExp(
  `^[a-zA-Z0-9_.-]{1,${MAX_PROVIDER_CODE_LENGTH}}$`
);

function boundedErrorText(value: string, maximumLength: number): string | null {
  const stripped = value
    .replace(SANITIZED_CHARACTERS_PATTERN, " ")
    .trim()
    .slice(0, maximumLength);
  return stripped.length === 0 ? null : stripped;
}

/** All C0 controls (tab/LF/CR included), DEL, and bidi override characters. */
const SANITIZED_CHARACTERS_PATTERN = new RegExp(
  "[\\u0000-\\u001F\\u007F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  "g"
);

function elapsed(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function nonnegativeNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function nonnegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

const defaultTimer: UpriverTimer = {
  set(callback, milliseconds) {
    return setTimeout(callback, milliseconds);
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
};

/**
 * LLM resilience: retry with exponential backoff + jitter (backlog #17).
 *
 * Wraps provider calls so a transient hiccup — a 429, a 5xx, a dropped socket —
 * doesn't sink a whole review. Only *retryable* failures are retried; a 4xx
 * (bad request / auth) or an empty-content result fails fast. Backoff is
 * exponential with jitter so concurrent specialist passes don't retry in
 * lockstep. `sleep`/`random` are injectable so the behavior is unit-testable
 * without real timers.
 */

/** HTTP statuses worth retrying: rate-limit, request timeout/too-early, and 5xx. */
const RETRYABLE_STATUS = new Set([408, 425, 429]);

/** Network/transport error codes (Node/undici) that are transient. */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT"
]);

export interface RetryOptions {
  /** Total attempts including the first try. Default {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Base backoff in ms (doubles each attempt). Default {@link DEFAULT_BASE_DELAY_MS}. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default {@link DEFAULT_MAX_DELAY_MS}. */
  maxDelayMs?: number;
  /** Sleep implementation (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0,1) (injectable for tests). */
  random?: () => number;
  /** Called before each retry sleep — for heartbeat/progress logging. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 8_000;

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status) || (status >= 500 && status < 600);
}

function normalizedMaxAttempts(value: number | undefined): number {
  const raw = value ?? DEFAULT_MAX_ATTEMPTS;
  return Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : DEFAULT_MAX_ATTEMPTS;
}

/** True when an error looks transient and a retry might succeed. */
export function isRetryableError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      return isRetryableStatus(status);
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_CODES.has(code)) {
      return true;
    }
    if ((error as { name?: unknown }).name === "AbortError") {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  // Provider errors are thrown as "<Provider> API error (<status>): …".
  const statusMatch = message.match(/API error \((\d{3})\)/);
  if (statusMatch && isRetryableStatus(Number(statusMatch[1]))) {
    return true;
  }
  return /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)\b|fetch failed|network error|socket hang up|connect timeout/i.test(
    message
  );
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff delay for an attempt: exponential, capped, with full jitter. */
export function backoffDelay(attempt: number, options: RetryOptions = {}): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const expo = Math.min(max, base * 2 ** (attempt - 1));
  // Full jitter over the lower half → upper bound, so retries spread out.
  return Math.round(expo * (0.5 + random() * 0.5));
}

/**
 * Run `fn`, retrying on retryable errors with exponential backoff + jitter.
 * Non-retryable errors (and the final attempt) reject immediately.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = normalizedMaxAttempts(options.maxAttempts);
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableError(error)) {
        throw error;
      }
      const delayMs = backoffDelay(attempt, options);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError ?? new Error("withRetry exhausted without an error");
}

/**
 * Wrap a `(request, config) => Promise` provider call so it retries transient
 * failures. Shape-preserving, so it drops into the existing injectable
 * `complete` / `completeWithTools` slots.
 */
export function retrying<Req, Cfg, Res>(
  fn: (request: Req, config: Cfg) => Promise<Res>,
  options: RetryOptions = {}
): (request: Req, config: Cfg) => Promise<Res> {
  return (request, config) => withRetry(() => fn(request, config), options);
}

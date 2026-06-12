import { describe, expect, it, vi } from "vitest";
import { withRetry, retrying, isRetryableError, backoffDelay } from "../src/providers/retry.js";

/** A sleep that records delays without waiting. */
function fakeSleep() {
  const delays: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    delays.push(ms);
  });
  return { sleep, delays };
}

describe("isRetryableError", () => {
  it("retries rate-limit, timeout, and 5xx statuses", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 529]) {
      expect(isRetryableError({ status })).toBe(true);
    }
  });

  it("does not retry 4xx (except 408/425/429) or empty content", () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 401 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError(new Error("Gemini API returned no content (finishReason: SAFETY)"))).toBe(false);
  });

  it("classifies provider error messages by embedded status", () => {
    expect(isRetryableError(new Error("Anthropic API error (429): slow down"))).toBe(true);
    expect(isRetryableError(new Error("Anthropic API error (529): overloaded_error"))).toBe(true);
    expect(isRetryableError(new Error("OpenAI API error (500): oops"))).toBe(true);
    expect(isRetryableError(new Error("Gemini API error (403): forbidden"))).toBe(false);
  });

  it("retries network/transport errors", () => {
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and is capped, with jitter in the upper half", () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 };
    // random=0 → 0.5× the exponential term.
    expect(backoffDelay(1, opts)).toBe(50);
    expect(backoffDelay(2, opts)).toBe(100);
    expect(backoffDelay(3, opts)).toBe(200);
    // random=1 → full term; capped at maxDelayMs.
    expect(backoffDelay(10, { ...opts, random: () => 1 })).toBe(1000);
  });
});

describe("withRetry", () => {
  it("returns immediately on success (no sleep)", async () => {
    const { sleep } = fakeSleep();
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, { sleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a retryable error then succeeds", async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Anthropic API error (429): slow"))
      .mockResolvedValueOnce("recovered");
    const result = await withRetry(fn, { sleep, baseDelayMs: 10, random: () => 0 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toHaveLength(1);
  });

  it("does not retry a non-retryable error", async () => {
    const { sleep } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(new Error("OpenAI API error (400): bad request"));
    await expect(withRetry(fn, { sleep })).rejects.toThrow(/400/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(new Error("OpenAI API error (503): overloaded"));
    await expect(withRetry(fn, { sleep, maxAttempts: 3, baseDelayMs: 10, random: () => 0 })).rejects.toThrow(/503/);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2); // sleeps between the 3 attempts
  });

  it("sanitizes invalid maxAttempts values", async () => {
    const { sleep } = fakeSleep();
    const fnWithNaN = vi.fn().mockRejectedValue(new Error("OpenAI API error (503): overloaded"));
    await expect(withRetry(fnWithNaN, { sleep, maxAttempts: Number.NaN, random: () => 0 })).rejects.toThrow(/503/);
    expect(fnWithNaN).toHaveBeenCalledTimes(3);

    const fnWithInfinity = vi.fn().mockRejectedValue(new Error("OpenAI API error (503): overloaded"));
    await expect(withRetry(fnWithInfinity, { sleep, maxAttempts: Number.POSITIVE_INFINITY, random: () => 0 })).rejects.toThrow(/503/);
    expect(fnWithInfinity).toHaveBeenCalledTimes(3);
  });

  it("normalizes maxAttempts to at least one whole attempt", async () => {
    const { sleep } = fakeSleep();
    const fnWithZero = vi.fn().mockRejectedValue(new Error("OpenAI API error (503): overloaded"));
    await expect(withRetry(fnWithZero, { sleep, maxAttempts: 0 })).rejects.toThrow(/503/);
    expect(fnWithZero).toHaveBeenCalledTimes(1);

    const fnWithFraction = vi
      .fn()
      .mockRejectedValueOnce(new Error("OpenAI API error (503): overloaded"))
      .mockRejectedValueOnce(new Error("OpenAI API error (503): overloaded"))
      .mockResolvedValue("recovered");
    await expect(withRetry(fnWithFraction, { sleep, maxAttempts: 2.9 })).rejects.toThrow(/503/);
    expect(fnWithFraction).toHaveBeenCalledTimes(2);
  });

  it("invokes onRetry before each backoff", async () => {
    const { sleep } = fakeSleep();
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("API error (500): x"))
      .mockResolvedValueOnce("ok");
    await withRetry(fn, { sleep, onRetry, baseDelayMs: 10, random: () => 0 });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1 });
  });
});

describe("retrying", () => {
  it("wraps a (request, config) call, preserving arguments", async () => {
    const { sleep } = fakeSleep();
    const inner = vi
      .fn()
      .mockRejectedValueOnce(new Error("Gemini API error (429): slow"))
      .mockResolvedValueOnce({ text: "done" });
    const wrapped = retrying(inner, { sleep, baseDelayMs: 1, random: () => 0 });

    const result = await wrapped({ prompt: "p" }, { provider: "gemini", model: "m", apiKey: "k" });
    expect(result).toEqual({ text: "done" });
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner.mock.calls[0]).toEqual([{ prompt: "p" }, { provider: "gemini", model: "m", apiKey: "k" }]);
  });
});

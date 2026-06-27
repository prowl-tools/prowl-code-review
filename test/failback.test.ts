import { describe, expect, it, vi } from "vitest";
import { withFailback, modelFailbackChain, type FailbackEvent } from "../src/providers/failback.js";
import type { ProviderConfig } from "../src/providers/types.js";

const config: ProviderConfig = { provider: "anthropic", model: "claude-opus-4-8", apiKey: "k" };

function retryable(status: number): Error {
  return Object.assign(new Error(`Anthropic API error (${status}): overloaded`), { status });
}

describe("modelFailbackChain", () => {
  it("returns older same-family models in order", () => {
    expect(modelFailbackChain("anthropic", "claude-opus-4-8")).toEqual([
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-opus-4-1"
    ]);
    expect(modelFailbackChain("anthropic", "claude-sonnet-4-6")).toEqual(["claude-sonnet-4-5"]);
    expect(modelFailbackChain("gemini", "gemini-2.5-pro")).toEqual(["gemini-2.5-flash"]);
  });

  it("returns [] for the oldest model or an unknown one", () => {
    expect(modelFailbackChain("anthropic", "claude-opus-4-1")).toEqual([]);
    expect(modelFailbackChain("anthropic", "claude-haiku-4-5")).toEqual([]);
    expect(modelFailbackChain("anthropic", "claude-custom-tuned")).toEqual([]);
    expect(modelFailbackChain("openai", "gpt-4o")).toEqual([]);
  });

  it("never crosses model families", () => {
    expect(modelFailbackChain("anthropic", "claude-sonnet-4-6")).not.toContain("claude-haiku-4-5");
  });
});

describe("withFailback", () => {
  it("returns the first model's result when it succeeds (no failback)", async () => {
    const complete = vi.fn(async (_req: unknown, cfg: ProviderConfig) => `ok:${cfg.model}`);
    const onFailback = vi.fn();
    const run = withFailback(complete, { onFailback });
    expect(await run({}, config)).toBe("ok:claude-opus-4-8");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onFailback).not.toHaveBeenCalled();
  });

  it("falls back to the next older model on a retryable failure", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(retryable(429))
      .mockResolvedValueOnce("ok:claude-opus-4-7");
    const events: FailbackEvent[] = [];
    const run = withFailback(complete, { onFailback: (e) => events.push(e) });
    expect(await run({}, config)).toBe("ok:claude-opus-4-7");
    expect(complete.mock.calls.map((c) => (c[1] as ProviderConfig).model)).toEqual([
      "claude-opus-4-8",
      "claude-opus-4-7"
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "anthropic", from: "claude-opus-4-8", to: "claude-opus-4-7" });
  });

  it("emits the failback event only after the older model succeeds", async () => {
    const onFailback = vi.fn();
    const complete = vi.fn(async (_req: unknown, cfg: ProviderConfig) => {
      if (cfg.model === "claude-opus-4-8") {
        throw retryable(429);
      }
      expect(onFailback).not.toHaveBeenCalled();
      return `ok:${cfg.model}`;
    });
    const run = withFailback(complete, { onFailback });

    expect(await run({}, config)).toBe("ok:claude-opus-4-7");
    expect(onFailback).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", from: "claude-opus-4-8", to: "claude-opus-4-7" })
    );
  });

  it("reports the final successful target when intermediate fallback models fail", async () => {
    const complete = vi.fn(async (_req: unknown, cfg: ProviderConfig) => {
      if (cfg.model !== "claude-opus-4-6") {
        throw retryable(503);
      }
      return `ok:${cfg.model}`;
    });
    const events: FailbackEvent[] = [];
    const run = withFailback(complete, { onFailback: (e) => events.push(e) });

    expect(await run({}, config)).toBe("ok:claude-opus-4-6");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "anthropic", from: "claude-opus-4-8", to: "claude-opus-4-6" });
  });

  it("does not fall back on a non-retryable error", async () => {
    const complete = vi.fn().mockRejectedValue(Object.assign(new Error("bad request"), { status: 400 }));
    const onFailback = vi.fn();
    const run = withFailback(complete, { onFailback });
    await expect(run({}, config)).rejects.toThrow("bad request");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onFailback).not.toHaveBeenCalled();
  });

  it("throws the last error after exhausting the whole ladder", async () => {
    const complete = vi.fn().mockRejectedValue(retryable(503));
    const onFailback = vi.fn();
    const run = withFailback(complete, { onFailback });
    await expect(run({}, { ...config, model: "claude-sonnet-4-6" })).rejects.toThrow(/503/);
    // sonnet-4-6 → sonnet-4-5 → throw: two attempts.
    expect(complete).toHaveBeenCalledTimes(2);
    expect(onFailback).not.toHaveBeenCalled();
  });

  it("does not emit a failback event when the fallback target fails", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(retryable(429))
      .mockRejectedValueOnce(Object.assign(new Error("bad request"), { status: 400 }));
    const onFailback = vi.fn();
    const run = withFailback(complete, { chain: () => ["claude-opus-4-7"], onFailback });

    await expect(run({}, config)).rejects.toThrow("bad request");
    expect(onFailback).not.toHaveBeenCalled();
  });

  it("does not fall back when the model has no older generation", async () => {
    const complete = vi.fn().mockRejectedValue(retryable(429));
    const run = withFailback(complete);
    await expect(run({}, { ...config, model: "claude-opus-4-1" })).rejects.toThrow(/429/);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

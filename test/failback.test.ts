import { describe, expect, it, vi } from "vitest";
import {
  withFailback,
  modelFailbackChain,
  retiredModelFallbacks,
  type FailbackEvent
} from "../src/providers/failback.js";
import { CodexError } from "../src/providers/codex.js";
import type { ProviderConfig } from "../src/providers/types.js";

const config: ProviderConfig = { provider: "anthropic", model: "claude-opus-4-8", apiKey: "k" };

function retryable(status: number): Error {
  return Object.assign(new Error(`Anthropic API error (${status}): overloaded`), { status });
}

const codexConfig: ProviderConfig = { provider: "codex", model: "gpt-5.4", apiKey: "" };
function retiredModel(): CodexError {
  return new CodexError("model gpt-5.4 is no longer available under ChatGPT sign-in", "model-retired");
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

  it("does not fall back on a Codex usage-limit (non-retryable, no retry storm)", async () => {
    const complete = vi.fn().mockRejectedValue(new CodexError("usage limit reached", "usage-limit"));
    const onFailback = vi.fn();
    const run = withFailback(complete, { onFailback });
    await expect(run({}, { ...codexConfig, model: "gpt-5.5" })).rejects.toBeInstanceOf(CodexError);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onFailback).not.toHaveBeenCalled();
  });

  it("falls back a retired Codex model to the live ladder even when it's on no rung", async () => {
    // gpt-5.4 is not on the codex ladder; a retired-model error should still fall
    // through to gpt-5.6-terra → gpt-5.5.
    const complete = vi.fn(async (_req: unknown, cfg: ProviderConfig) => {
      if (cfg.model !== "gpt-5.5") {
        throw retiredModel();
      }
      return `ok:${cfg.model}`;
    });
    const events: FailbackEvent[] = [];
    const run = withFailback(complete, { onFailback: (e) => events.push(e) });
    expect(await run({}, codexConfig)).toBe("ok:gpt-5.5");
    expect(complete.mock.calls.map((c) => (c[1] as ProviderConfig).model)).toEqual([
      "gpt-5.4",
      "gpt-5.6-terra",
      "gpt-5.5"
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "codex", from: "gpt-5.4", to: "gpt-5.5", reason: "model-retired" });
  });

  it("throws when the retired-model ladder is exhausted", async () => {
    const complete = vi.fn().mockRejectedValue(retiredModel());
    const onFailback = vi.fn();
    const run = withFailback(complete, { onFailback });
    await expect(run({}, codexConfig)).rejects.toBeInstanceOf(CodexError);
    // gpt-5.4 → gpt-5.6-terra → gpt-5.5 → throw: three attempts.
    expect(complete).toHaveBeenCalledTimes(3);
    expect(onFailback).not.toHaveBeenCalled();
  });

  it("tags an overload failback with reason 'overload'", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(retryable(429))
      .mockResolvedValueOnce("ok:claude-opus-4-7");
    const events: FailbackEvent[] = [];
    const run = withFailback(complete, { onFailback: (e) => events.push(e) });
    await run({}, config);
    expect(events[0]).toMatchObject({ reason: "overload" });
  });
});

describe("retiredModelFallbacks", () => {
  it("returns the codex ladder's live targets", () => {
    expect(retiredModelFallbacks("codex")).toEqual(["gpt-5.6-terra", "gpt-5.5"]);
  });

  it("returns the flattened ladder for other providers", () => {
    expect(retiredModelFallbacks("gemini")).toEqual(["gemini-2.5-pro", "gemini-2.5-flash"]);
  });
});

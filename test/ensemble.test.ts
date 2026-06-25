import { describe, expect, it, vi } from "vitest";
import { runEnsembleReview } from "../src/review/ensemble.js";
import type { ProviderConfig } from "../src/providers/types.js";
import type { Finding } from "../src/review/findings.js";
import type { ReviewInput, ReviewResult } from "../src/review/run-review.js";
import { createDebugRecorder, type DebugEvent } from "../src/debug/trace.js";

const CONFIGS: ProviderConfig[] = [
  { provider: "anthropic", model: "claude-x", apiKey: "a" },
  { provider: "openai", model: "gpt-x", apiKey: "o" }
];

const INPUT: ReviewInput = { diff: "diff" };

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "a.ts",
    line: 1,
    severity: "major",
    category: "correctness",
    title: "bug",
    body: "b",
    confidence: 0.8,
    ...over
  };
}

function result(findings: Finding[], over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    findings,
    uncappedFindings: findings,
    raw: findings,
    passes: [{ specialist: "correctness", findings: findings.length, ok: true }],
    verification: { verified: 0, droppedFalsePositive: 0, demoted: 0, unverified: 0, ok: true },
    judge: { duplicatesRemoved: 0, belowThreshold: 0, belowConfidence: 0, capped: 0 },
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
    ...over
  };
}

describe("runEnsembleReview (#53)", () => {
  function byType<T extends DebugEvent["type"]>(events: DebugEvent[], type: T) {
    return events.filter((event): event is Extract<DebugEvent, { type: T }> => event.type === type);
  }

  it("pools findings and tags provenance per provider", async () => {
    const runReview = vi
      .fn()
      .mockResolvedValueOnce(result([finding({ file: "a.ts", title: "only-anthropic" })]))
      .mockResolvedValueOnce(result([finding({ file: "b.ts", title: "only-openai" })]));

    const res = await runEnsembleReview(INPUT, { configs: CONFIGS, runReview });

    expect(runReview).toHaveBeenCalledTimes(2);
    expect(res.findings).toHaveLength(2);
    const byFile = Object.fromEntries(res.findings.map((f) => [f.file, f.sources]));
    expect(byFile["a.ts"]).toEqual(["anthropic"]);
    expect(byFile["b.ts"]).toEqual(["openai"]);
    expect(res.providers.map((p) => [p.provider, p.ok, p.findings])).toEqual([
      ["anthropic", true, 1],
      ["openai", true, 1]
    ]);
    expect(res.providers.map((p) => p.usage?.inputTokens)).toEqual([10, 10]);
  });

  it("consolidates a finding both providers raise, unioning sources and boosting confidence", async () => {
    const runReview = vi
      .fn()
      .mockResolvedValueOnce(result([finding({ confidence: 0.6 })]))
      .mockResolvedValueOnce(result([finding({ confidence: 0.6 })]));

    const res = await runEnsembleReview(INPUT, { configs: CONFIGS, runReview });

    expect(res.findings).toHaveLength(1);
    expect(new Set(res.findings[0].sources)).toEqual(new Set(["anthropic", "openai"]));
    expect(res.findings[0].confidence).toBeCloseTo(0.75); // 0.6 + 0.15
    expect(res.judge.duplicatesRemoved).toBe(1);
  });

  it("keeps deterministic grounding findings single-counted and without provider provenance", async () => {
    const grounding = finding({
      category: "lint",
      title: "no-debugger",
      body: "Unexpected debugger statement",
      confidence: 0.9
    });
    const runReview = vi.fn().mockResolvedValue(result([grounding], { raw: [grounding] }));

    const res = await runEnsembleReview(
      { ...INPUT, grounding: { findings: [grounding], summary: "no-debugger" } },
      { configs: CONFIGS, runReview }
    );

    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ title: "no-debugger", confidence: 0.9 });
    expect(res.findings[0].sources).toBeUndefined();
    expect(res.judge.duplicatesRemoved).toBe(0);
    expect(res.providers.map((provider) => provider.findings)).toEqual([0, 0]);
    expect(res.raw).toHaveLength(1);
  });

  it("matches grounding findings even when verification rewrites confidence", async () => {
    const grounding = finding({
      category: "lint",
      title: "no-debugger",
      body: "Unexpected debugger statement",
      confidence: 0.9
    });
    const verifiedGrounding = { ...grounding, confidence: 0.6 };
    const runReview = vi.fn().mockResolvedValue(result([verifiedGrounding], { raw: [verifiedGrounding] }));

    const res = await runEnsembleReview(
      { ...INPUT, grounding: { findings: [grounding], summary: "no-debugger" } },
      { configs: CONFIGS, runReview }
    );

    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ title: "no-debugger", confidence: 0.6 });
    expect(res.findings[0].sources).toBeUndefined();
    expect(res.providers.map((provider) => provider.findings)).toEqual([0, 0]);
    expect(res.raw).toEqual([grounding]);
  });

  it("does not re-add grounding findings every provider verifier dropped", async () => {
    const grounding = finding({
      category: "lint",
      title: "no-debugger",
      body: "Unexpected debugger statement",
      confidence: 0.9
    });
    const runReview = vi.fn().mockResolvedValue(
      result([], {
        raw: [grounding],
        verification: { verified: 1, droppedFalsePositive: 1, demoted: 0, unverified: 0, ok: true }
      })
    );

    const res = await runEnsembleReview(
      { ...INPUT, grounding: { findings: [grounding], summary: "no-debugger" } },
      { configs: CONFIGS, runReview }
    );

    expect(res.findings).toHaveLength(0);
    expect(res.providers.map((provider) => provider.findings)).toEqual([0, 0]);
    expect(res.verification.droppedFalsePositive).toBe(2);
    expect(res.raw).toEqual([grounding]);
  });

  it("disables per-provider floors so each provider returns everything", async () => {
    const runReview = vi.fn().mockResolvedValue(result([finding()]));
    await runEnsembleReview(INPUT, { configs: CONFIGS, runReview, minSeverity: "major", minConfidence: 0.7 });

    for (const call of runReview.mock.calls) {
      expect(call[1]).toMatchObject({ minSeverity: "info", minConfidence: 0, maxFindings: Infinity });
    }
  });

  it("rescues a sub-threshold finding both providers agree on", async () => {
    // Each provider scores 0.45 (below the 0.5 floor); consensus lifts to 0.6.
    const runReview = vi
      .fn()
      .mockResolvedValueOnce(result([finding({ confidence: 0.45 })]))
      .mockResolvedValueOnce(result([finding({ confidence: 0.45 })]));

    const res = await runEnsembleReview(INPUT, { configs: CONFIGS, runReview, minConfidence: 0.5 });

    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].confidence).toBeCloseTo(0.6);
  });

  it("splits the token budget evenly across providers", async () => {
    const runReview = vi.fn().mockResolvedValue(result([]));
    await runEnsembleReview(INPUT, { configs: CONFIGS, runReview, maxTokens: 1000 });
    for (const call of runReview.mock.calls) {
      expect(call[1].maxTokens).toBe(500);
    }
  });

  it("degrades gracefully when one provider fails", async () => {
    const runReview = vi
      .fn()
      .mockResolvedValueOnce(result([finding({ title: "survivor" })]))
      .mockRejectedValueOnce(new Error("openai 500"));

    const res = await runEnsembleReview(INPUT, { configs: CONFIGS, runReview });

    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].title).toBe("survivor");
    const openai = res.providers.find((p) => p.provider === "openai");
    expect(openai?.ok).toBe(false);
    expect(openai?.error).toContain("openai 500");
    // The failed provider surfaces as a degraded pass (never silent).
    expect(res.passes.some((p) => p.specialist === "openai" && !p.ok)).toBe(true);
  });

  it("sums token usage and namespaces specialist passes by provider", async () => {
    const runReview = vi.fn().mockResolvedValue(result([finding()]));
    const res = await runEnsembleReview(INPUT, { configs: CONFIGS, runReview });
    expect(res.usage.inputTokens).toBe(20); // 10 + 10
    expect(res.passes.map((p) => p.specialist).sort()).toEqual(["anthropic:correctness", "openai:correctness"]);
  });

  it("emits the final cross-provider judge event when debug tracing is enabled", async () => {
    const runReview = vi
      .fn()
      .mockResolvedValueOnce(result([finding({ confidence: 0.6 })]))
      .mockResolvedValueOnce(result([finding({ confidence: 0.6 })]));
    const { sink, records } = createDebugRecorder();

    await runEnsembleReview(INPUT, { configs: CONFIGS, runReview, debug: sink });

    const judges = byType(records.map((record) => record.event), "judge");
    expect(judges).toHaveLength(1);
    expect(judges[0]).toMatchObject({ provider: "ensemble", duplicatesRemoved: 1 });
    expect(judges[0].findings[0].sources).toEqual(["anthropic", "openai"]);
  });
});

describe("runEnsembleReview perspectives (#53)", () => {
  it("preserves each model's distinct take on a consolidated finding", async () => {
    const runReview = vi
      .fn()
      .mockResolvedValueOnce(result([finding({ severity: "major", confidence: 0.6, body: "anthropic reasoning" })]))
      .mockResolvedValueOnce(result([finding({ severity: "critical", confidence: 0.7, body: "openai reasoning" })]));

    const res = await runEnsembleReview(INPUT, { configs: CONFIGS, runReview });

    expect(res.findings).toHaveLength(1);
    const perspectives = res.findings[0].perspectives ?? [];
    expect(perspectives.map((p) => p.provider).sort()).toEqual(["anthropic", "openai"]);
    expect(perspectives.find((p) => p.provider === "anthropic")?.body).toBe("anthropic reasoning");
    expect(perspectives.find((p) => p.provider === "openai")?.body).toBe("openai reasoning");
    // The differing per-model severities are retained in the perspectives.
    expect(perspectives.find((p) => p.provider === "openai")?.severity).toBe("critical");
  });

  it("attributes a single-provider finding to its one perspective", async () => {
    const runReview = vi
      .fn()
      .mockResolvedValueOnce(result([finding({ file: "a.ts", title: "only-anthropic" })]))
      .mockResolvedValueOnce(result([finding({ file: "b.ts", title: "only-openai" })]));

    const res = await runEnsembleReview(INPUT, { configs: CONFIGS, runReview });
    for (const f of res.findings) {
      expect(f.perspectives).toHaveLength(1);
    }
  });
});

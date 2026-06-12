import { describe, expect, it, vi } from "vitest";
import {
  verifyFindings,
  parseVerdicts,
  buildVerifyPrompt,
  buildVerifySystem,
  DEFAULT_VERIFY_CONFIDENCE
} from "../src/review/verify.js";
import type { Finding } from "../src/review/findings.js";
import type { CompletionRequest, CompletionResult, ProviderConfig } from "../src/providers/index.js";

const config: ProviderConfig = { provider: "anthropic", model: "m", apiKey: "k" };
const USAGE = { inputTokens: 2, outputTokens: 3, cachedInputTokens: 0 };

function reply(text: string): CompletionResult {
  return { text, provider: "anthropic", model: "m", usage: USAGE };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "a.ts",
    line: 1,
    severity: "major",
    category: "correctness",
    title: "t",
    body: "b",
    confidence: 0.5,
    ...over
  };
}

describe("parseVerdicts", () => {
  it("parses a fenced JSON array and drops malformed entries", () => {
    const verdicts = parseVerdicts(
      "```json\n" +
        JSON.stringify([
          { index: 0, falsePositive: true, confidence: 0.1 },
          { index: 1, falsePositive: false, confidence: 0.9, reason: "real" },
          { index: 2, confidence: 0.5 }, // missing falsePositive → dropped
          { nope: true } // garbage → dropped
        ]) +
        "\n```"
    );
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toMatchObject({ index: 0, falsePositive: true });
    expect(verdicts[1]).toMatchObject({ index: 1, falsePositive: false, reason: "real" });
  });

  it("returns [] when there is no JSON array", () => {
    expect(parseVerdicts("no json here")).toEqual([]);
    expect(parseVerdicts("{not: array}")).toEqual([]);
  });
});

describe("verifyFindings", () => {
  it("skips the call entirely when nothing is below the confidence threshold", async () => {
    const complete = vi.fn(async () => reply("[]"));
    const findings = [finding({ confidence: 0.9 }), finding({ confidence: DEFAULT_VERIFY_CONFIDENCE })];
    const result = await verifyFindings(findings, { diff: "d" }, { config, complete });

    expect(complete).not.toHaveBeenCalled();
    expect(result.verified).toBe(0);
    expect(result.findings).toEqual(findings);
    expect(result.ok).toBe(true);
  });

  it("only sends sub-threshold findings, drops false positives, and adjusts confidence", async () => {
    const findings = [
      finding({ file: "keep.ts", confidence: 0.95, title: "trusted" }), // not a candidate
      finding({ file: "fp.ts", confidence: 0.4, title: "false-positive" }), // candidate 0
      finding({ file: "demote.ts", confidence: 0.7, title: "weakened" }), // candidate 1
      finding({ file: "confirm.ts", confidence: 0.6, title: "confirmed" }) // candidate 2
    ];
    const complete = vi.fn(async (request: CompletionRequest): Promise<CompletionResult> => {
      // Only the three sub-0.8 findings should be presented.
      expect(request.prompt).toContain("fp.ts");
      expect(request.prompt).toContain("demote.ts");
      expect(request.prompt).toContain("confirm.ts");
      expect(request.prompt).not.toContain("keep.ts");
      return reply(
        JSON.stringify([
          { index: 0, falsePositive: true, confidence: 0.05 },
          { index: 1, falsePositive: false, confidence: 0.55 },
          { index: 2, falsePositive: false, confidence: 0.85 }
        ])
      );
    });

    const result = await verifyFindings(findings, { diff: "d" }, { config, complete });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.verified).toBe(3);
    expect(result.droppedFalsePositive).toBe(1);
    expect(result.demoted).toBe(1); // 0.7 → 0.55
    expect(result.unverified).toBe(0);

    const byTitle = Object.fromEntries(result.findings.map((f) => [f.title, f]));
    expect(byTitle["false-positive"]).toBeUndefined(); // dropped
    expect(byTitle.trusted.confidence).toBe(0.95); // untouched
    expect(byTitle.weakened.confidence).toBe(0.55); // demoted
    expect(byTitle.confirmed.confidence).toBe(0.85); // raised
    // Surviving order preserves the original sequence.
    expect(result.findings.map((f) => f.title)).toEqual(["trusted", "weakened", "confirmed"]);
  });

  it("keeps a candidate the verifier returns no verdict for (counted unverified)", async () => {
    const findings = [finding({ confidence: 0.3, title: "orphan" })];
    const complete = vi.fn(async () => reply("[]"));
    const result = await verifyFindings(findings, { diff: "d" }, { config, complete });

    expect(result.verified).toBe(1);
    expect(result.unverified).toBe(1);
    expect(result.droppedFalsePositive).toBe(0);
    expect(result.findings).toEqual(findings);
  });

  it("degrades gracefully when the verification call throws", async () => {
    const findings = [finding({ confidence: 0.3 })];
    const complete = vi.fn(async () => {
      throw new Error("provider exploded");
    });
    const result = await verifyFindings(findings, { diff: "d" }, { config, complete });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/provider exploded/);
    expect(result.unverified).toBe(1);
    expect(result.findings).toEqual(findings); // nothing dropped
  });

  it("honors a custom verifyConfidence threshold", async () => {
    const findings = [finding({ confidence: 0.6 })];
    const complete = vi.fn(async () => reply("[]"));
    // Threshold 0.5 → the 0.6 finding is now trusted, no call.
    const result = await verifyFindings(findings, { diff: "d" }, { config, complete, verifyConfidence: 0.5 });
    expect(complete).not.toHaveBeenCalled();
    expect(result.verified).toBe(0);
  });
});

describe("verify prompt construction", () => {
  it("keeps untrusted evidence out of the system block", () => {
    const system = buildVerifySystem();
    expect(system).toContain("false-positive verifier");
    expect(system).toContain("hypothetical"); // drops doesn't-happen-now findings (#58)
    expect(system).not.toContain("SECRET_DIFF");

    const prompt = buildVerifyPrompt({
      candidates: [finding({ title: "candidate-x" })],
      diff: "SECRET_DIFF",
      context: "ctx-data"
    });
    expect(prompt).toContain("untrusted");
    expect(prompt).toContain("candidate-x");
    expect(prompt).toContain("SECRET_DIFF");
    expect(prompt).toContain("ctx-data");
  });
});

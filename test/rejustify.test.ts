import { describe, expect, it, vi } from "vitest";
import {
  buildRejustifySystem,
  buildRejustifyPrompt,
  parseRejustifyVerdict,
  rejustifyFinding,
  buildRejustifyReply,
  type RejustifyInput
} from "../src/review/rejustify.js";
import type { Finding } from "../src/review/findings.js";
import type { ProviderConfig } from "../src/providers/index.js";

const config: ProviderConfig = { provider: "anthropic", model: "m", apiKey: "k" };
const AWS_ACCESS_KEY = ["AKIA", "1234567890ABCD99"].join("");

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: 6,
    severity: "major",
    category: "correctness",
    title: "Unchecked null deref",
    body: "`user` may be undefined here.",
    confidence: 0.7,
    ...over
  };
}

function input(over: Partial<RejustifyInput> = {}): RejustifyInput {
  return { finding: finding(), disputeReply: "I disagree — user is guaranteed non-null by the caller.", diff: "+ user.name", ...over };
}

describe("buildRejustifySystem (#22)", () => {
  it("frames inputs as untrusted, demands an honest defend/withdraw decision", () => {
    const system = buildRejustifySystem();
    expect(system).toContain("DISPUTED");
    expect(system).toContain("untrusted DATA");
    expect(system).toMatch(/do not reflexively defend/i);
    expect(system).toContain("decision");
    expect(system).toContain("reasoning");
  });
});

describe("buildRejustifyPrompt (#22)", () => {
  it("includes the finding, the objection, and the diff, each marked untrusted", () => {
    const prompt = buildRejustifyPrompt(input());
    expect(prompt).toContain("Unchecked null deref");
    expect(prompt).toContain("guaranteed non-null");
    expect(prompt).toContain("user.name");
    expect(prompt).toContain("untrusted data");
  });

  it("handles a missing objection", () => {
    expect(buildRejustifyPrompt(input({ disputeReply: undefined }))).toContain("no specific reason given");
  });

  it("handles empty context inputs and includes a context availability note", () => {
    const prompt = buildRejustifyPrompt(
      input({
        disputeReply: "",
        diff: "",
        context: undefined,
        contextNote: "Cross-file context retrieval was skipped."
      })
    );
    expect(prompt).toContain("no specific reason given");
    expect(prompt).toContain("Context availability");
    expect(prompt).toContain("Cross-file context retrieval was skipped.");
    expect(prompt).toContain("# Untrusted pull request diff");
  });

  it("redacts secrets from the finding, objection, and diff", () => {
    const prompt = buildRejustifyPrompt(
      input({
        finding: finding({ body: `leaked ${AWS_ACCESS_KEY}` }),
        disputeReply: `nonsense token ghp_${"b".repeat(36)}`,
        diff: `+const k = "${AWS_ACCESS_KEY}";`
      })
    );
    expect(prompt).not.toContain(AWS_ACCESS_KEY);
    expect(prompt).not.toContain(`ghp_${"b".repeat(36)}`);
    expect(prompt).toContain("[REDACTED:");
  });

  it("redacts secrets from cross-file context", () => {
    const prompt = buildRejustifyPrompt(input({ context: `export const key = "${AWS_ACCESS_KEY}";` }));
    expect(prompt).toContain("Untrusted cross-file context");
    expect(prompt).not.toContain(AWS_ACCESS_KEY);
    expect(prompt).toContain("[REDACTED:");
  });
});

describe("parseRejustifyVerdict (#22)", () => {
  it("parses a clean object", () => {
    expect(parseRejustifyVerdict('{"decision":"defend","reasoning":"still null"}')).toEqual({
      decision: "defend",
      reasoning: "still null"
    });
  });

  it("tolerates fences and surrounding prose", () => {
    const verdict = parseRejustifyVerdict('Here:\n```json\n{"decision":"withdraw","reasoning":"you are right"}\n```');
    expect(verdict).toEqual({ decision: "withdraw", reasoning: "you are right" });
  });

  it("returns undefined for a missing/invalid decision or non-JSON", () => {
    expect(parseRejustifyVerdict("not json")).toBeUndefined();
    expect(parseRejustifyVerdict('{"decision":"maybe","reasoning":"x"}')).toBeUndefined();
    expect(parseRejustifyVerdict('{"reasoning":"x"}')).toBeUndefined();
  });
});

describe("rejustifyFinding (#22)", () => {
  it("returns the parsed verdict from the provider", async () => {
    const complete = vi.fn(async () => ({
      text: '{"decision":"defend","reasoning":"The caller does not guarantee non-null on the new branch."}',
      usage: { inputTokens: 5, outputTokens: 3, cachedInputTokens: 0 },
      provider: "anthropic" as const,
      model: "m"
    }));
    const result = await rejustifyFinding(input(), { config, complete });
    expect(result.ok).toBe(true);
    expect(result.verdict?.decision).toBe("defend");
    const request = complete.mock.calls[0][0];
    expect(request.system).toContain("DISPUTED");
    expect(request.responseFormat).toBe("json");
  });

  it("reports ok:false on an unparseable response (caller falls back to withholding)", async () => {
    const complete = vi.fn(async () => ({
      text: "I think maybe it's fine?",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      provider: "anthropic" as const,
      model: "m"
    }));
    const result = await rejustifyFinding(input(), { config, complete });
    expect(result.ok).toBe(false);
    expect(result.verdict).toBeUndefined();
  });

  it("degrades gracefully when the provider call throws", async () => {
    const complete = vi.fn(async () => {
      throw new Error("Anthropic API error (500)");
    });
    const result = await rejustifyFinding(input(), { config, complete });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
  });
});

describe("buildRejustifyReply (#22)", () => {
  it("frames a defense and sanitizes the reasoning", () => {
    const body = buildRejustifyReply({ decision: "defend", reasoning: "still null <script>alert(1)</script>" });
    expect(body).toContain("Standing by this finding");
    expect(body).not.toContain("<script>");
    expect(body).toContain("prowl-review");
  });

  it("frames a withdrawal", () => {
    const body = buildRejustifyReply({ decision: "withdraw", reasoning: "You're right, the caller guards it." });
    expect(body).toContain("Withdrawing this finding");
    expect(body).toContain("Thanks for the correction");
  });

  it("redacts a secret echoed into the reasoning", () => {
    const body = buildRejustifyReply({ decision: "defend", reasoning: `see ${AWS_ACCESS_KEY}` });
    expect(body).not.toContain(AWS_ACCESS_KEY);
  });
});

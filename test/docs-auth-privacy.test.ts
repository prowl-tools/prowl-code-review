import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Auth-policy (#38) + data-privacy (#40) docs. These are policy statements users
 * rely on, so guard them against accidental deletion/weakening: the load-bearing
 * claims must stay present and the README must link both pages.
 */
const read = (path: string): string => {
  try {
    return readFileSync(join(process.cwd(), path), "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Expected policy doc at ${path} to be readable: ${reason}`);
  }
};

const authDoc = (): string => read("docs/auth.md");
const privacyDoc = (): string => read("docs/privacy.md");
const readmeDoc = (): string => read("README.md");

describe("auth policy doc (#38)", () => {
  it("states the BYOK env-only key policy with the exact variables", () => {
    const doc = authDoc();

    expect(doc).toContain("PROWL_AI_PROVIDER");
    expect(doc).toContain("PROWL_AI_KEY_<PROVIDER>");
    expect(doc).toContain("PROWL_AI_KEY");
    expect(doc).toMatch(/environment only/i);
    expect(doc).toMatch(/Provider keys come from the environment only[\s\S]*never from `\.prowl-review\.yml`/i);
    expect(doc).toMatch(/\.prowl-review\.yml[\s\S]*no config field that accepts a key/i);
  });

  it("documents why subscription routing is unsupported for Claude/Gemini and why Codex is the only exception", () => {
    const doc = authDoc();

    expect(doc).toContain("Anthropic Consumer Terms");
    expect(doc).toMatch(/Gemini.*not supported|not supported.*Gemini/i);
    expect(doc).toMatch(/automated or non-human\s+means/i);
    expect(doc).toMatch(/bot, script, or otherwise/i);
    expect(doc).toMatch(/account-ban risk/i);
    expect(doc).toMatch(/OpenClaw/i);
    expect(doc).toMatch(/OpenAI\/Codex[\s\S]*only possible exception[\s\S]*off-by-default/i);
    expect(doc).toMatch(/OpenAI\/Codex[\s\S]*Legal\/Compliance sign-off/i);
  });

  it("explains Action secret handling and GITHUB_TOKEN posting", () => {
    const doc = authDoc();

    expect(doc).toContain("ai-key-openai");
    expect(doc).toContain("GITHUB_TOKEN");
    expect(doc).toMatch(/secret/i);
    expect(doc).toMatch(/fork/i);
  });
});

describe("data-privacy doc (#40)", () => {
  it("states review prompt content goes directly to the user's provider, with no proxy and no telemetry", () => {
    const doc = privacyDoc();

    expect(doc).toMatch(/never see your code/i);
    expect(doc).toMatch(/no telemetry|no.*analytics/i);
    expect(doc).toMatch(/no prowl-review server/i);
    expect(doc).toMatch(/hosted proxy/i);
    expect(doc).toContain("api.anthropic.com");
    expect(doc).toContain("api.openai.com");
    expect(doc).toContain("generativelanguage.googleapis.com");
  });

  it("inventories provider-bound prompt inputs beyond diff and context", () => {
    const doc = privacyDoc();

    expect(doc).toMatch(/repo\/org guidelines/i);
    expect(doc).toMatch(/repo-wide learned patterns/i);
    expect(doc).toMatch(/grounding/i);
    expect(doc).toMatch(/requirements/i);
    expect(doc).toContain("requirementsDiff");
    expect(doc).toMatch(/PR title/i);
  });

  it("documents optional non-provider egress for configured grounding features", () => {
    const doc = privacyDoc();

    expect(doc).toContain("PROWL_ORG_GUIDELINES_PATH");
    expect(doc).toMatch(/Semgrep registry/i);
    expect(doc).toMatch(/p\/default/);
    expect(doc).toMatch(/metrics.*disabled|metrics and version checks disabled/i);
    expect(doc).toMatch(/OSV\.dev/i);
  });

  it("documents secret redaction + sensitive-file skipping before sending", () => {
    const doc = privacyDoc();

    expect(doc).toMatch(/redact/i);
    expect(doc).toContain("[REDACTED:");
    expect(doc).toMatch(/\.env/);
  });

  it("states zero retention on our side", () => {
    const doc = privacyDoc();

    expect(doc).toMatch(/prowl-review retains \*\*nothing on a prowl-review server\*\*/i);
    expect(doc).toMatch(/no\s+database[\s\S]*no hosted logs of your code or key/i);
    expect(doc).toMatch(/State that does persist[\s\S]*lives \*\*in your own\s+GitHub\*\*/i);
    expect(doc).toMatch(/tracking issue in your repo/i);
    expect(doc).toMatch(/debug tracing[\s\S]*redacted JSONL trace[\s\S]*your workspace/i);
    expect(doc).toMatch(/GitHub Actions artifact[\s\S]*GitHub\/artifact policy/i);
  });
});

describe("README links the policy docs", () => {
  it("points at both docs/auth.md and docs/privacy.md", () => {
    const readme = readmeDoc();

    expect(readme).toContain("docs/auth.md");
    expect(readme).toContain("docs/privacy.md");
  });
});

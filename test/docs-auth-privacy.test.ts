import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Auth-policy (#38) + data-privacy (#40) docs. These are policy statements users
 * rely on, so guard them against accidental deletion/weakening: the load-bearing
 * claims must stay present and the README must link both pages.
 */
const read = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

describe("auth policy doc (#38)", () => {
  const doc = read("docs/auth.md");

  it("states the BYOK env-only key policy with the exact variables", () => {
    expect(doc).toContain("PROWL_AI_PROVIDER");
    expect(doc).toContain("PROWL_AI_KEY_<PROVIDER>");
    expect(doc).toContain("PROWL_AI_KEY");
    // Keys never come from config/repo.
    expect(doc).toMatch(/environment only/i);
    expect(doc).toMatch(/never (?:from )?committed|never .*repo|never from .*config/i);
  });

  it("documents why subscription routing is unsupported for Claude/Gemini, Codex the only exception", () => {
    expect(doc).toContain("Anthropic Consumer Terms");
    expect(doc).toMatch(/Gemini.*not supported|not supported.*Gemini/i);
    expect(doc).toMatch(/OpenAI\/Codex/);
    expect(doc).toMatch(/off-by-default|off by default/i);
  });

  it("explains Action secret handling and GITHUB_TOKEN posting", () => {
    expect(doc).toContain("GITHUB_TOKEN");
    expect(doc).toMatch(/secret/i);
    expect(doc).toMatch(/fork/i);
  });
});

describe("data-privacy doc (#40)", () => {
  const doc = read("docs/privacy.md");

  it("states code goes only to the user's provider, with no proxy and no telemetry", () => {
    expect(doc).toMatch(/never see your code/i);
    expect(doc).toMatch(/no telemetry|no.*analytics/i);
    expect(doc).toContain("api.anthropic.com");
    expect(doc).toContain("api.openai.com");
    expect(doc).toContain("generativelanguage.googleapis.com");
  });

  it("documents secret redaction + sensitive-file skipping before sending", () => {
    expect(doc).toMatch(/redact/i);
    expect(doc).toContain("[REDACTED:");
    expect(doc).toMatch(/\.env/);
  });

  it("states zero retention on our side", () => {
    expect(doc).toMatch(/retains?\s+\*\*?nothing|zero[- ]retention|retains nothing/i);
  });
});

describe("README links the policy docs", () => {
  const readme = read("README.md");
  it("points at both docs/auth.md and docs/privacy.md", () => {
    expect(readme).toContain("docs/auth.md");
    expect(readme).toContain("docs/privacy.md");
  });
});

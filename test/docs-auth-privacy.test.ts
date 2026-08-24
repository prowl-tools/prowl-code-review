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
    throw new Error(`Expected policy doc at ${path} to be readable: ${reason}`, { cause: error });
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
    expect(doc).toContain("gpt-5.4-mini");
    expect(doc).not.toContain("gpt-5.2");
    expect(doc).toMatch(/environment only/i);
    expect(doc).toMatch(/Provider keys come from the environment only[\s\S]*never from `\.prowl-review\.yml`/i);
    expect(doc).toMatch(/\.prowl-review\.yml[\s\S]*no config field that accepts a key/i);
  });

  it("documents why subscription routing stays unsupported for Claude/Gemini", () => {
    const doc = authDoc();

    expect(doc).toContain("Anthropic Consumer Terms");
    expect(doc).toMatch(/Gemini.*not supported|not supported.*Gemini/i);
    expect(doc).toMatch(/automated or non-human\s+means/i);
    expect(doc).toMatch(/bot, script, or otherwise/i);
    expect(doc).toMatch(/account-ban risk/i);
    expect(doc).toMatch(/OpenClaw/i);
    // No Claude/Gemini equivalent, ever — Codex is the sole exception.
    expect(doc).toMatch(/no Claude\/Gemini equivalent|never.*Claude.*Gemini|no equivalent.*Claude/i);
  });

  it("documents the Codex subscription provider as a supported, opt-in, self-hosted-only exception (#45)", () => {
    const doc = authDoc();

    // Codex via the first-party CLI is supported and keyless, but off by default.
    expect(doc).toMatch(/provider: codex/);
    expect(doc).toMatch(/off by default/i);
    expect(doc).toMatch(/opt[- ]in/i);
    expect(doc).toMatch(/codex login/);
    // Self-hosted / local infrastructure only — never GitHub-hosted runners on public repos.
    expect(doc).toMatch(/self-hosted|local infrastructure/i);
    expect(doc).toContain("Do not use this workflow for public or open-source repositories");
    // Never copy auth.json between machines.
    expect(doc).toMatch(/auth\.json/);
    expect(doc).toMatch(/never (?:copy|copied|move)|do not copy/i);
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

  it("documents Codex subscription egress via the local first-party CLI (#45)", () => {
    const doc = privacyDoc();

    expect(doc).toMatch(/codex/i);
    expect(doc).toMatch(/ChatGPT/);
    // Data goes to OpenAI through the local codex CLI, still nothing to prowl-review.
    expect(doc).toMatch(/codex.*CLI|CLI.*codex/i);
    expect(doc).toMatch(/auth\.json/);
    // Trust boundary: Codex's own shell can READ any file during retrieval; the
    // refusal/redaction protects the returned bundle, not what Codex opens.
    expect(doc).toMatch(/read any file/i);
    expect(doc).toMatch(/real repo root/i);
    expect(doc).toMatch(/bundle Codex returns|what enters the review/i);
    expect(doc).toMatch(/soft instruction|not a sandbox guarantee/i);
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

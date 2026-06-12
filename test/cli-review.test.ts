import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  loadGuidelines,
  parseMinSeverity,
  resolveGuidelinesWorkspace,
  resolvePullNumber,
  resolveRepo,
  resolveReviewOptions,
  resolveTrustWorkspace,
  resolveWorkspace
} from "../src/cli/commands/review.js";
import { resolveProviderConfig } from "../src/providers/index.js";
import type { ProwlReviewConfig } from "../src/config/schema.js";

const ORIGINAL_ENV = process.env;
let tempDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prowl-review-"));
  tempDirs.push(dir);
  return dir;
}

describe("review command helpers", () => {
  it("resolves repository from flag or environment", () => {
    expect(resolveRepo("owner/repo")).toEqual({ owner: "owner", repo: "repo" });

    process.env.GITHUB_REPOSITORY = "env-owner/env-repo";
    expect(resolveRepo()).toEqual({ owner: "env-owner", repo: "env-repo" });
  });

  it("rejects malformed repositories", () => {
    for (const value of ["owner", "owner/", "/repo", "owner/repo/extra"]) {
      expect(() => resolveRepo(value)).toThrow(/Repository required/);
    }
  });

  it("resolves pull numbers from flags and event payloads", () => {
    expect(resolvePullNumber("42")).toBe(42);

    const dir = tempDir();
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
    process.env.GITHUB_EVENT_PATH = eventPath;
    expect(resolvePullNumber()).toBe(7);

    writeFileSync(eventPath, JSON.stringify({ number: 8 }));
    expect(resolvePullNumber()).toBe(8);
  });

  it("rejects invalid pull numbers and invalid event payloads", () => {
    expect(() => resolvePullNumber("0")).toThrow(/Invalid --pr/);
    expect(() => resolvePullNumber("not-a-number")).toThrow(/Invalid --pr/);

    const dir = tempDir();
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, "{not-json");
    process.env.GITHUB_EVENT_PATH = eventPath;
    expect(() => resolvePullNumber()).toThrow(/Pull request number required/);
  });

  it("loads guidelines in precedence order and skips unreadable entries", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "CLAUDE.md"), "claude rules");
    expect(loadGuidelines(dir)).toBe("claude rules");

    writeFileSync(join(dir, "REVIEW_GUIDELINES.md"), "review rules");
    expect(loadGuidelines(dir)).toBe("review rules");

    const fallbackDir = tempDir();
    mkdirSync(join(fallbackDir, "REVIEW_GUIDELINES.md"));
    writeFileSync(join(fallbackDir, "CLAUDE.md"), "fallback rules");
    expect(loadGuidelines(fallbackDir)).toBe("fallback rules");
  });

  it("parses and validates min severity", () => {
    expect(parseMinSeverity(undefined)).toBeUndefined();
    expect(parseMinSeverity("major")).toBe("major");
    expect(() => parseMinSeverity("urgent")).toThrow(/Invalid --min-severity/);
  });

  it("prefers the explicit action workspace over the GitHub default", () => {
    process.env.GITHUB_WORKSPACE = "/base";
    process.env.PROWL_WORKSPACE = "/head";
    expect(resolveWorkspace()).toBe("/head");

    process.env.PROWL_WORKSPACE = "";
    expect(resolveWorkspace()).toBe("/base");
  });

  it("keeps trusted guidelines explicit and separate from the context workspace", () => {
    process.env.GITHUB_WORKSPACE = "/base";
    process.env.PROWL_WORKSPACE = "/head";
    process.env.PROWL_GUIDELINES_WORKSPACE = "/trusted-guidelines";
    expect(resolveGuidelinesWorkspace()).toBe("/trusted-guidelines");

    process.env.PROWL_GUIDELINES_WORKSPACE = "";
    expect(resolveGuidelinesWorkspace()).toBeUndefined();

    process.env.PROWL_GUIDELINES_WORKSPACE = "   ";
    expect(resolveGuidelinesWorkspace()).toBeUndefined();
  });

  it("resolves workspace execution trust from explicit truthy env values", () => {
    delete process.env.PROWL_TRUST_WORKSPACE;
    expect(resolveTrustWorkspace()).toBe(false);

    process.env.PROWL_TRUST_WORKSPACE = "true";
    expect(resolveTrustWorkspace()).toBe(true);

    process.env.PROWL_TRUST_WORKSPACE = "1";
    expect(resolveTrustWorkspace()).toBe(true);

    process.env.PROWL_TRUST_WORKSPACE = "yes";
    expect(resolveTrustWorkspace()).toBe(true);

    process.env.PROWL_TRUST_WORKSPACE = "TRUE";
    expect(resolveTrustWorkspace()).toBe(true);

    process.env.PROWL_TRUST_WORKSPACE = "Yes";
    expect(resolveTrustWorkspace()).toBe(true);

    process.env.PROWL_TRUST_WORKSPACE = " true ";
    expect(resolveTrustWorkspace()).toBe(true);

    process.env.PROWL_TRUST_WORKSPACE = "false";
    expect(resolveTrustWorkspace()).toBe(false);
  });

  it.each(["true", "TRUE", "1", "yes", "YES", " true "])(
    "resolves injected PROWL_TRUST_WORKSPACE=%s as trusted",
    (value) => {
      expect(resolveTrustWorkspace({ PROWL_TRUST_WORKSPACE: value } as NodeJS.ProcessEnv)).toBe(true);
    }
  );

  it("resolves workspace execution trust to false for other env values", () => {
    for (const value of ["0", "no", "falsey", "", "y", "t", "on"]) {
      process.env.PROWL_TRUST_WORKSPACE = value;
      expect(resolveTrustWorkspace()).toBe(false);
    }
  });
});

describe("resolveReviewOptions (#29 — CLI > config > default precedence)", () => {
  const env = {} as NodeJS.ProcessEnv;

  it("falls back to built-in defaults (undefined) when neither CLI nor config set a value", () => {
    const resolved = resolveReviewOptions({}, {}, env);
    expect(resolved.minSeverity).toBeUndefined();
    expect(resolved.minConfidence).toBeUndefined();
    expect(resolved.maxFindings).toBeUndefined();
    expect(resolved.verify).toBeUndefined();
    expect(resolved.skipContext).toBeUndefined();
    expect(resolved.skipGrounding).toBeUndefined();
    expect(resolved.contextLimits).toBeUndefined();
    expect(resolved.diffLimits).toBeUndefined();
    expect(resolved.trustWorkspace).toBe(false);
  });

  it("applies safe config values when the CLI is silent", () => {
    const config: ProwlReviewConfig = {
      review: { minSeverity: "major", minConfidence: 0.7, maxFindings: 10, verify: false, verifyConfidence: 0.9 },
      context: { enabled: false, maxRounds: 3, maxFiles: 8 },
      grounding: { enabled: false },
      diff: { maxFiles: 50, maxBytes: 1000 }
    };
    const resolved = resolveReviewOptions({}, config, env);
    expect(resolved.minSeverity).toBe("major");
    expect(resolved.minConfidence).toBe(0.7);
    expect(resolved.maxFindings).toBe(10);
    expect(resolved.verify).toBe(false);
    expect(resolved.verifyConfidence).toBe(0.9);
    expect(resolved.skipContext).toBe(true);
    expect(resolved.contextLimits).toEqual({ maxRounds: 3, maxFiles: 8 });
    expect(resolved.skipGrounding).toBe(true);
    expect(resolved.trustWorkspace).toBe(false);
    expect(resolved.diffLimits).toEqual({ maxFiles: 50, maxDiffBytes: 1000 });
  });

  it("lets a CLI --min-severity override the config", () => {
    const resolved = resolveReviewOptions({ minSeverity: "critical" }, { review: { minSeverity: "minor" } }, env);
    expect(resolved.minSeverity).toBe("critical");
  });

  it("lets CLI disable flags win over an enabling config", () => {
    const config: ProwlReviewConfig = { context: { enabled: true }, grounding: { enabled: true } };
    const resolved = resolveReviewOptions({ context: false, grounding: false, verify: false }, config, env);
    expect(resolved.skipContext).toBe(true);
    expect(resolved.skipGrounding).toBe(true);
    expect(resolved.verify).toBe(false);
  });

  it("lets a CLI --trust-workspace win over config and env", () => {
    expect(resolveReviewOptions({ trustWorkspace: true }, {}, env).trustWorkspace).toBe(true);
  });

  it("uses only out-of-band inputs to enable workspace execution trust", () => {
    expect(resolveReviewOptions({}, {}, { PROWL_TRUST_WORKSPACE: "true" } as NodeJS.ProcessEnv).trustWorkspace).toBe(true);
    expect(resolveReviewOptions({ trustWorkspace: true }, {}, env).trustWorkspace).toBe(true);
  });
});

describe("resolveProviderConfig defaults (#29 — env > config > built-in)", () => {
  it("uses config provider/model when the env vars are absent", () => {
    const cfg = resolveProviderConfig({ PROWL_AI_KEY: "k" } as NodeJS.ProcessEnv, { provider: "openai", model: "gpt-x" });
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-x");
  });

  it("lets env provider/model win over the config defaults", () => {
    const cfg = resolveProviderConfig(
      { PROWL_AI_KEY: "k", PROWL_AI_PROVIDER: "gemini", PROWL_AI_MODEL: "g-env" } as NodeJS.ProcessEnv,
      { provider: "openai", model: "gpt-x" }
    );
    expect(cfg.provider).toBe("gemini");
    expect(cfg.model).toBe("g-env");
  });

  it("ignores blank env provider/model values so config defaults can apply", () => {
    const cfg = resolveProviderConfig(
      { PROWL_AI_KEY: "k", PROWL_AI_PROVIDER: "", PROWL_AI_MODEL: "   " } as NodeJS.ProcessEnv,
      { provider: "openai", model: "gpt-x" }
    );
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-x");
  });

  it("falls back to the provider's default model when neither env nor config set one", () => {
    const cfg = resolveProviderConfig({ PROWL_AI_KEY: "k" } as NodeJS.ProcessEnv, { provider: "anthropic" });
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBeTruthy();
  });
});

describe("GitHub Action provider metadata", () => {
  it("defaults provider selection to an out-of-band action input", () => {
    const action = parseYaml(readFileSync(join(process.cwd(), "action.yml"), "utf8")) as {
      inputs?: Record<string, { default?: unknown }>;
      runs?: { steps?: Array<{ id?: string; env?: Record<string, string> }> };
    };
    const reviewStep = action.runs?.steps?.find((step) => step.id === "review");

    expect(action.inputs?.["ai-provider"]?.default).toBe("anthropic");
    expect(reviewStep?.env?.PROWL_AI_PROVIDER).toBe("${{ inputs.ai-provider }}");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  loadGuidelines,
  parseMinSeverity,
  resolveGuidelinesWorkspace,
  resolveConfigLoadOptions,
  resolveDryRun,
  resolvePullNumber,
  resolveRepo,
  resolveReviewOptions,
  resolveTrustWorkspace,
  resolveUsageLogPath,
  resolveWorkspace,
  reportReviewCommandResult
} from "../src/cli/commands/review.js";
import { resolveProviderConfig } from "../src/providers/index.js";
import { defaultUsageLogPath } from "../src/cost/usage-log.js";
import type { ProwlReviewConfig } from "../src/config/schema.js";
import type { ReviewPullRequestResult } from "../src/pipeline.js";

const ORIGINAL_ENV = process.env;
let tempDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  vi.restoreAllMocks();
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

function reviewCommandResult(over: Partial<ReviewPullRequestResult> = {}): ReviewPullRequestResult {
  return {
    meta: {
      number: 7,
      title: "T",
      body: null,
      baseSha: "base",
      headSha: "head",
      draft: false,
      state: "open",
      author: "me",
      changedFiles: 1
    },
    payload: { body: "summary", comments: [] } as ReviewPullRequestResult["payload"],
    review: {
      findings: [],
      raw: [],
      passes: [],
      verification: { verified: 0, droppedFalsePositive: 0, demoted: 0, unverified: 0, ok: true },
      judge: { duplicatesRemoved: 0, belowThreshold: 0, belowConfidence: 0, capped: 0 },
      usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 }
    },
    usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 },
    skipped: [],
    contextFiles: 0,
    posted: false,
    ...over
  };
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
    expect(parseMinSeverity(" major ")).toBe("major");
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

  it("lets trusted action env min severity override the config when CLI is silent", () => {
    const resolved = resolveReviewOptions(
      {},
      { review: { minSeverity: "minor" } },
      { PROWL_MIN_SEVERITY: "major" } as NodeJS.ProcessEnv
    );
    expect(resolved.minSeverity).toBe("major");
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

  it("resolves the usage-log path: explicit env > local default > none in CI (#36)", () => {
    expect(resolveUsageLogPath("/ws", { PROWL_USAGE_LOG: "logs/u.jsonl" } as NodeJS.ProcessEnv)).toBe("/ws/logs/u.jsonl");
    expect(resolveUsageLogPath("/ws", { PROWL_USAGE_LOG: "/ws/tmp/u.jsonl" } as NodeJS.ProcessEnv)).toBe("/ws/tmp/u.jsonl");
    expect(resolveUsageLogPath("/ws", { PROWL_USAGE_LOG: "../u.jsonl" } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveUsageLogPath("/ws", { PROWL_USAGE_LOG: "/tmp/u.jsonl" } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveUsageLogPath("/ws", {} as NodeJS.ProcessEnv)).toBe(defaultUsageLogPath("/ws"));
    expect(resolveUsageLogPath("/ws", { GITHUB_ACTIONS: "true" } as NodeJS.ProcessEnv)).toBeNull();
    // an explicit in-workspace log path still wins inside CI
    expect(
      resolveUsageLogPath("/ws", { GITHUB_ACTIONS: "true", PROWL_USAGE_LOG: "ci/u.jsonl" } as NodeJS.ProcessEnv)
    ).toBe("/ws/ci/u.jsonl");
  });

  it("passes the config maxInlineComments through (incl. 0), undefined for the default (#25)", () => {
    expect(resolveReviewOptions({}, {}, env).maxInlineComments).toBeUndefined();
    expect(resolveReviewOptions({}, { review: { maxInlineComments: 5 } }, env).maxInlineComments).toBe(5);
    expect(resolveReviewOptions({}, { review: { maxInlineComments: 0 } }, env).maxInlineComments).toBe(0);
  });

  it("passes the config ignore list through, leaving it undefined for defaults (#19)", () => {
    expect(resolveReviewOptions({}, {}, env).ignore).toBeUndefined(); // → pipeline applies the default globs
    expect(resolveReviewOptions({}, { ignore: ["vendor", "*.snap"] }, env).ignore).toEqual(["vendor", "*.snap"]);
    expect(resolveReviewOptions({}, { ignore: [] }, env).ignore).toEqual([]); // explicit "ignore nothing"
  });

  it("keeps the agent prompt on by default and disables it from CLI or config (#57)", () => {
    expect(resolveReviewOptions({}, {}, env).agentPrompt).toBeUndefined(); // default on (pipeline default)
    expect(resolveReviewOptions({ agentPrompt: false }, {}, env).agentPrompt).toBe(false); // --no-agent-prompt
    expect(resolveReviewOptions({}, { agentPrompt: false }, env).agentPrompt).toBe(false); // config off
    expect(resolveReviewOptions({}, { agentPrompt: true }, env).agentPrompt).toBeUndefined(); // explicit on stays default
  });

  it("resolves the specialist set only when config sets one (#51)", () => {
    expect(resolveReviewOptions({}, {}, env).specialists).toBeUndefined(); // → pipeline's built-in default set
    const resolved = resolveReviewOptions(
      {},
      { specialists: { builtins: { performance: false }, custom: [{ key: "compliance", focus: "f" }] } },
      env
    );
    expect(resolved.specialists?.map((s) => s.key)).toEqual(["correctness", "security", "tests", "compliance"]);
  });

  it("passes the riskTiering config straight through (#31)", () => {
    expect(resolveReviewOptions({}, {}, env).riskTiering).toBeUndefined(); // → tiering on with built-in thresholds
    const cfg = { riskTiering: { enabled: false } };
    expect(resolveReviewOptions({}, cfg, env).riskTiering).toEqual({ enabled: false });
  });
});

describe("review command action env helpers", () => {
  it("disables config loading when the action marks repo config untrusted", () => {
    expect(resolveConfigLoadOptions({}, "/repo", { PROWL_NO_CONFIG: "true" } as NodeJS.ProcessEnv)).toEqual({
      cwd: "/repo",
      disabled: true
    });
  });

  it("loads an explicit trusted config path from action env", () => {
    expect(
      resolveConfigLoadOptions(
        {},
        "/repo",
        { PROWL_NO_CONFIG: "true", PROWL_CONFIG_PATH: " /trusted/.prowl-review.yml " } as NodeJS.ProcessEnv
      )
    ).toEqual({ cwd: "/repo", configPath: "/trusted/.prowl-review.yml" });
  });

  it("lets CLI --no-config override an action config path", () => {
    expect(
      resolveConfigLoadOptions(
        { config: false },
        "/repo",
        { PROWL_CONFIG_PATH: "/trusted/.prowl-review.yml" } as NodeJS.ProcessEnv
      )
    ).toEqual({ cwd: "/repo", disabled: true });
  });

  it("uses trusted action env for dry-run mode", () => {
    expect(resolveDryRun({}, { PROWL_DRY_RUN: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveDryRun({}, { PROWL_DRY_RUN: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveDryRun({ dryRun: true }, { PROWL_DRY_RUN: "false" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("reports and logs cost even when publishing failed", () => {
    const root = tempDir();
    const summaryPath = join(root, "summary.md");
    const outputPath = join(root, "output.txt");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    reportReviewCommandResult(reviewCommandResult(), {
      owner: "o",
      repo: "r",
      pullNumber: 7,
      root,
      providerConfig: { provider: "openai", model: "gpt-5", apiKey: "k" },
      env: {
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        PROWL_USAGE_LOG: "usage.jsonl"
      } as NodeJS.ProcessEnv,
      now: () => new Date("2026-06-14T00:00:00.000Z"),
      publishFailed: true
    });

    expect(logSpy.mock.calls.some(([line]) => String(line).includes("publish failed"))).toBe(true);
    expect(logSpy.mock.calls.some(([line]) => String(line).includes("prowl-review cost:"))).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toContain("posted=false");
    expect(readFileSync(summaryPath, "utf8")).toContain("prowl-review cost");
    expect(JSON.parse(readFileSync(join(root, "usage.jsonl"), "utf8"))).toMatchObject({
      ts: "2026-06-14T00:00:00.000Z",
      provider: "openai",
      model: "gpt-5",
      repo: "o/r",
      pr: 7,
      inputTokens: 1_000_000
    });
  });

  it("includes the risk tier in cost output only when present", () => {
    const root = tempDir();
    const summaryPath = join(root, "summary.md");
    const summaryWithoutTierPath = join(root, "summary-no-tier.md");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const baseOptions = {
      owner: "o",
      repo: "r",
      pullNumber: 7,
      root,
      providerConfig: { provider: "openai", model: "gpt-5", apiKey: "k" },
      env: { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summaryPath } as NodeJS.ProcessEnv
    };

    reportReviewCommandResult(reviewCommandResult({ riskTier: "minimal" }), baseOptions);

    const costLine = logSpy.mock.calls.map(([line]) => String(line)).find((line) => line.startsWith("prowl-review cost:"));
    expect(costLine).toContain("risk tier: minimal");
    expect(readFileSync(summaryPath, "utf8")).toContain("risk tier: minimal");

    logSpy.mockClear();
    reportReviewCommandResult(reviewCommandResult(), {
      ...baseOptions,
      env: { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summaryWithoutTierPath } as NodeJS.ProcessEnv
    });

    const costLineWithoutTier = logSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.startsWith("prowl-review cost:"));
    expect(costLineWithoutTier).not.toContain("risk tier:");
    expect(readFileSync(summaryWithoutTierPath, "utf8")).not.toContain("risk tier:");
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
  it("keeps provider and config policy in out-of-band action inputs", () => {
    const action = parseYaml(readFileSync(join(process.cwd(), "action.yml"), "utf8")) as {
      inputs?: Record<string, { default?: unknown }>;
      runs?: { steps?: Array<{ id?: string; env?: Record<string, string>; run?: string }> };
    };
    const reviewStep = action.runs?.steps?.find((step) => step.id === "review");

    expect(action.inputs?.["ai-provider"]?.default).toBe("anthropic");
    expect(action.inputs?.["config-path"]?.default).toBe("");
    expect(reviewStep?.env?.PROWL_AI_PROVIDER).toBe("${{ inputs.ai-provider }}");
    expect(reviewStep?.env?.PROWL_CONFIG_PATH).toBe("${{ inputs.config-path }}");
    expect(reviewStep?.env?.PROWL_NO_CONFIG).toBe("${{ inputs.config-path == '' }}");
    expect(reviewStep?.run).toBe('node "${{ github.action_path }}/dist/cli.js" review');
  });
});

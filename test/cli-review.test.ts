import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildReviewCommand,
  loadGuidelines,
  loadLearnedPatterns,
  composeGuidelines,
  isForkPullRequestEvent,
  hasAnyProviderKey,
  resolveForkReviewDecision,
  resolveForkReviewDecisionForRun,
  resolveOrgGuidelinesPath,
  parseMinSeverity,
  resolveGuidelinesWorkspace,
  resolveConfigLoadOptions,
  resolveDryRun,
  resolveProviderDefaults,
  resolvePullNumber,
  resolveRepo,
  resolveReviewedHeadSha,
  resolveIsDraftEvent,
  resolveReviewOptions,
  resolveTrustWorkspace,
  resolveUsageLogPath,
  resolveDebugLogPath,
  DEFAULT_DEBUG_LOG_FILENAME,
  resolveWorkspace,
  reportReviewCommandResult
} from "../src/cli/commands/review.js";
import type { OctokitLike } from "../src/github/client.js";
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

  it("keeps pull request event basics readable when the head repo is null", () => {
    const dir = tempDir();
    const eventPath = join(dir, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 7,
          head: { repo: null, sha: "head-sha" }
        }
      })
    );

    process.env.GITHUB_EVENT_PATH = eventPath;
    expect(resolvePullNumber()).toBe(7);
    expect(resolveReviewedHeadSha()).toBe("head-sha");
  });

  it("rejects invalid pull numbers and invalid event payloads", () => {
    expect(() => resolvePullNumber("0")).toThrow(/Invalid --pr/);
    expect(() => resolvePullNumber("not-a-number")).toThrow(/Invalid --pr/);

    const dir = tempDir();
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, "{not-json");
    process.env.GITHUB_EVENT_PATH = eventPath;
    expect(() => resolvePullNumber()).toThrow(/Pull request number required/);

    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: "7" } }));
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

  it("loads LEARNED_PATTERNS.md when present (#30)", () => {
    const dir = tempDir();
    expect(loadLearnedPatterns(dir)).toBeUndefined();
    writeFileSync(join(dir, "LEARNED_PATTERNS.md"), "Known false positive: X.");
    expect(loadLearnedPatterns(dir)).toBe("Known false positive: X.");
  });

  it("composes org + repo guidelines under sub-headers (#30)", () => {
    expect(composeGuidelines(undefined, undefined)).toBeUndefined();
    expect(composeGuidelines(undefined, "repo rules")).toBe("repo rules");
    expect(composeGuidelines("org rules", undefined)).toBe("org rules");
    expect(composeGuidelines("", "repo rules")).toBe("repo rules");
    expect(composeGuidelines("   ", "repo rules")).toBe("repo rules");
    expect(composeGuidelines("org rules", "")).toBe("org rules");
    expect(composeGuidelines("org rules", "repo rules")).toBe(
      "## Organization standards\norg rules\n\n## Repository standards\nrepo rules"
    );
  });

  it("resolves the org guidelines path only from a non-empty env value (#30)", () => {
    expect(resolveOrgGuidelinesPath({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveOrgGuidelinesPath({ PROWL_ORG_GUIDELINES_PATH: "  " } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveOrgGuidelinesPath({ PROWL_ORG_GUIDELINES_PATH: "/org/guide.md" } as NodeJS.ProcessEnv)).toBe(
      "/org/guide.md"
    );
  });

  it("parses and validates min severity", () => {
    expect(parseMinSeverity(undefined)).toBeUndefined();
    expect(parseMinSeverity("major")).toBe("major");
    expect(parseMinSeverity(" major ")).toBe("major");
    expect(() => parseMinSeverity("urgent")).toThrow(/Invalid --min-severity/);
  });

  it.each([["--json"], ["--no-color"], ["--fail-on", "major"]])(
    "rejects local-only %s without --base or --head",
    async (...args) => {
      const command = buildReviewCommand();
      await expect(command.parseAsync(["node", "review", ...args])).rejects.toThrow(
        /require `--base` or `--head`/
      );
    }
  );

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

    expect(resolveGuidelinesWorkspace({ PROWL_GUIDELINES_WORKSPACE: "/injected-guidelines" } as NodeJS.ProcessEnv)).toBe(
      "/injected-guidelines"
    );
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

  it("detects fork pull request events", () => {
    const dir = tempDir();
    const eventPath = join(dir, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: { head: { repo: { fork: true, full_name: "fork/prowl-code-review" } } }
      })
    );

    expect(
      isForkPullRequestEvent({
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "prowl-tools/prowl-code-review"
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it("treats same-repository pull request events as trusted candidates", () => {
    const dir = tempDir();
    const eventPath = join(dir, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: { head: { repo: { fork: false, full_name: "prowl-tools/prowl-code-review" } } }
      })
    );

    expect(
      isForkPullRequestEvent({
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "prowl-tools/prowl-code-review"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("does not treat same-repo PRs in a forked repository as fork PRs", () => {
    const dir = tempDir();
    const eventPath = join(dir, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        repository: { full_name: "maintainer/prowl-code-review" },
        pull_request: {
          base: { repo: { full_name: "maintainer/prowl-code-review" } },
          head: { repo: { fork: true, full_name: "maintainer/prowl-code-review" } }
        }
      })
    );

    expect(
      isForkPullRequestEvent({
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "maintainer/prowl-code-review"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("detects whether any provider key is present (generic or scoped, #20)", () => {
    expect(hasAnyProviderKey({} as NodeJS.ProcessEnv)).toBe(false);
    expect(hasAnyProviderKey({ PROWL_AI_KEY: "  " } as NodeJS.ProcessEnv)).toBe(false);
    expect(hasAnyProviderKey({ PROWL_AI_KEY: "k" } as NodeJS.ProcessEnv)).toBe(true);
    expect(hasAnyProviderKey({ PROWL_AI_KEY_ANTHROPIC: "k" } as NodeJS.ProcessEnv)).toBe(true);
    expect(hasAnyProviderKey({ PROWL_AI_KEY_GEMINI: "k" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("decides fork-PR handling: skip a keyless fork, review otherwise (#20)", () => {
    const dir = tempDir();
    const forkPath = join(dir, "fork.json");
    writeFileSync(
      forkPath,
      JSON.stringify({ pull_request: { head: { repo: { fork: true, full_name: "contributor/prowl-code-review" } } } })
    );
    const samePath = join(dir, "same.json");
    writeFileSync(
      samePath,
      JSON.stringify({ pull_request: { head: { repo: { fork: false, full_name: "prowl-tools/prowl-code-review" } } } })
    );
    const base = { GITHUB_REPOSITORY: "prowl-tools/prowl-code-review" };

    // Fork without a key → skip (no secrets shared with fork pull_request runs).
    const keylessFork = resolveForkReviewDecision({ ...base, GITHUB_EVENT_PATH: forkPath } as NodeJS.ProcessEnv);
    expect(keylessFork).toMatchObject({ isFork: true, hasKey: false, skip: true });

    // Fork WITH a key (e.g. pull_request_target) → review, but flagged as a fork.
    const keyedFork = resolveForkReviewDecision({
      ...base,
      GITHUB_EVENT_PATH: forkPath,
      PROWL_AI_KEY: "k"
    } as NodeJS.ProcessEnv);
    expect(keyedFork).toMatchObject({ isFork: true, hasKey: true, skip: false });

    // Same-repo PR with no key → not skipped here (a real misconfig fails loudly downstream).
    const sameRepo = resolveForkReviewDecision({ ...base, GITHUB_EVENT_PATH: samePath } as NodeJS.ProcessEnv);
    expect(sameRepo).toMatchObject({ isFork: false, skip: false });
  });

  it("uses complete pull request event metadata for fork decisions without fetching", async () => {
    const dir = tempDir();
    const eventPath = join(dir, "fork.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        repository: { full_name: "prowl-tools/prowl-code-review" },
        pull_request: {
          head: { repo: { fork: true, full_name: "contributor/prowl-code-review" } },
          base: { repo: { full_name: "prowl-tools/prowl-code-review" } }
        }
      })
    );
    const pullsGet = vi.fn();
    const octokit = { rest: { pulls: { get: pullsGet } } } as unknown as OctokitLike;

    const decision = await resolveForkReviewDecisionForRun(
      octokit,
      { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 },
      {
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "prowl-tools/prowl-code-review"
      } as NodeJS.ProcessEnv
    );

    expect(decision).toMatchObject({ isFork: true, hasKey: false, skip: true });
    expect(pullsGet).not.toHaveBeenCalled();
  });

  it("fetches pull request metadata when event repo metadata is explicitly null", async () => {
    const dir = tempDir();
    const eventPath = join(dir, "fork.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          number: 7,
          head: { repo: null, sha: "head-sha" }
        }
      })
    );
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: "Fork PR",
        body: null,
        base: { sha: "base-sha", repo: { full_name: "prowl-tools/prowl-code-review" } },
        head: { sha: "head-sha", repo: { full_name: "contributor/prowl-code-review", fork: true } },
        state: "open",
        user: null
      }
    });
    const octokit = { rest: { pulls: { get: pullsGet } } } as unknown as OctokitLike;

    const decision = await resolveForkReviewDecisionForRun(
      octokit,
      { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 },
      {
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "prowl-tools/prowl-code-review"
      } as NodeJS.ProcessEnv
    );

    expect(decision).toMatchObject({ isFork: true, hasKey: false, skip: true });
    expect(pullsGet).toHaveBeenCalledWith({ owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 });
  });

  it("treats fork-decision metadata fetch failures as untrusted", async () => {
    const dir = tempDir();
    const eventPath = join(dir, "comment.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        issue: { number: 7, pull_request: { url: "https://api.github.com/repos/prowl-tools/prowl-code-review/pulls/7" } }
      })
    );
    const pullsGet = vi.fn().mockRejectedValue(new Error("not found"));
    const octokit = { rest: { pulls: { get: pullsGet } } } as unknown as OctokitLike;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const decision = await resolveForkReviewDecisionForRun(
      octokit,
      { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 },
      {
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "prowl-tools/prowl-code-review"
      } as NodeJS.ProcessEnv
    );

    expect(decision).toMatchObject({ isFork: true, hasKey: false, skip: true });
    expect(pullsGet).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("treating prowl-tools/prowl-code-review#7 as untrusted"));
  });

  it("does not load workspace config on a fork PR, but honors an explicit trusted path (#20)", () => {
    const dir = tempDir();
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const forkPath = join(dir, "fork.json");
    writeFileSync(
      forkPath,
      JSON.stringify({ pull_request: { head: { repo: { fork: true, full_name: "contributor/prowl-code-review" } } } })
    );
    const forkEnv = {
      GITHUB_EVENT_PATH: forkPath,
      GITHUB_REPOSITORY: "prowl-tools/prowl-code-review"
    } as NodeJS.ProcessEnv;
    const trustedBase = join(dir, "trusted");

    // No explicit path on a fork → config auto-discovery is disabled (untrusted checkout).
    expect(resolveConfigLoadOptions({}, workspace, forkEnv)).toEqual({ cwd: workspace, disabled: true });
    // Relative explicit paths stay anchored to the trusted Action working directory, not the reviewed checkout.
    expect(resolveConfigLoadOptions({ config: ".prowl-review.yml" }, workspace, forkEnv, true, trustedBase)).toEqual({
      cwd: workspace,
      configPath: resolve(trustedBase, ".prowl-review.yml")
    });
    // Explicit config paths inside the reviewed checkout are still untrusted.
    expect(resolveConfigLoadOptions({ config: join(workspace, "nested", ".prowl-review.yml") }, workspace, forkEnv)).toEqual({
      cwd: workspace,
      disabled: true
    });
    expect(
      resolveConfigLoadOptions({}, workspace, { ...forkEnv, PROWL_CONFIG_PATH: join(workspace, ".prowl-review.yml") })
    ).toEqual({ cwd: workspace, disabled: true });
    // An out-of-workspace maintainer-set trusted config path is still honored on a fork.
    const trustedConfig = join(dir, "trusted", ".prowl-review.yml");
    expect(
      resolveConfigLoadOptions({}, workspace, { ...forkEnv, PROWL_CONFIG_PATH: trustedConfig })
    ).toEqual({ cwd: workspace, configPath: trustedConfig });
  });

  it("resolves the reviewed head SHA from env or the pull request event payload", () => {
    expect(resolveReviewedHeadSha({ PROWL_REVIEWED_HEAD_SHA: "  abc123  " } as NodeJS.ProcessEnv)).toBe("abc123");

    const dir = tempDir();
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { sha: "event-head" } } }));
    expect(resolveReviewedHeadSha({ GITHUB_EVENT_PATH: eventPath } as NodeJS.ProcessEnv)).toBe("event-head");
    expect(resolveReviewedHeadSha({ GITHUB_EVENT_PATH: join(dir, "missing.json") } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("resolves draft status from the pull request event payload (#28)", () => {
    const dir = tempDir();
    const draftPath = join(dir, "draft.json");
    writeFileSync(draftPath, JSON.stringify({ pull_request: { draft: true } }));
    expect(resolveIsDraftEvent({ GITHUB_EVENT_PATH: draftPath } as NodeJS.ProcessEnv)).toBe(true);

    const readyPath = join(dir, "ready.json");
    writeFileSync(readyPath, JSON.stringify({ pull_request: { draft: false } }));
    expect(resolveIsDraftEvent({ GITHUB_EVENT_PATH: readyPath } as NodeJS.ProcessEnv)).toBe(false);

    // No event / no pull_request / unreadable → undefined (treated as not-a-draft).
    expect(resolveIsDraftEvent({} as NodeJS.ProcessEnv)).toBeUndefined();
    const noPrPath = join(dir, "no-pr.json");
    writeFileSync(noPrPath, JSON.stringify({ number: 7 }));
    expect(resolveIsDraftEvent({ GITHUB_EVENT_PATH: noPrPath } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveIsDraftEvent({ GITHUB_EVENT_PATH: join(dir, "missing.json") } as NodeJS.ProcessEnv)).toBeUndefined();
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

  it("disables workspace execution trust for fork pull request events", () => {
    const dir = tempDir();
    const eventPath = join(dir, "event.json");
    const forkEnv = {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "prowl-tools/prowl-code-review",
      PROWL_TRUST_WORKSPACE: "true"
    } as NodeJS.ProcessEnv;
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: { head: { repo: { fork: true, full_name: "contributor/prowl-code-review" } } }
      })
    );

    expect(resolveReviewOptions({}, {}, forkEnv).trustWorkspace).toBe(false);
    expect(resolveReviewOptions({ trustWorkspace: true }, {}, forkEnv).trustWorkspace).toBe(false);
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

  it("resolves the debug trace path: off by default; flag/env/config enable it (#49)", () => {
    const noEnv = {} as NodeJS.ProcessEnv;
    // Off unless enabled by flag, env, or config.
    expect(resolveDebugLogPath({}, {}, "/ws", noEnv)).toBeNull();
    // `--debug` (boolean) → default file in the workspace.
    expect(resolveDebugLogPath({ debug: true }, {}, "/ws", noEnv)).toBe(`/ws/${DEFAULT_DEBUG_LOG_FILENAME}`);
    // `--debug <path>` (string) wins over env + config.
    expect(
      resolveDebugLogPath(
        { debug: "traces/run.jsonl" },
        { debug: { path: "cfg.jsonl" } },
        "/ws",
        { PROWL_DEBUG_LOG: "env.jsonl" } as NodeJS.ProcessEnv
      )
    ).toBe("/ws/traces/run.jsonl");
    // PROWL_DEBUG enables it; PROWL_DEBUG_LOG sets the path.
    expect(
      resolveDebugLogPath({}, {}, "/ws", { PROWL_DEBUG: "true", PROWL_DEBUG_LOG: "env.jsonl" } as NodeJS.ProcessEnv)
    ).toBe("/ws/env.jsonl");
    // config.debug.enabled + config.debug.path.
    expect(resolveDebugLogPath({}, { debug: { enabled: true, path: "cfg.jsonl" } }, "/ws", noEnv)).toBe("/ws/cfg.jsonl");
    // A path escaping the workspace is rejected.
    expect(resolveDebugLogPath({ debug: "../escape.jsonl" }, {}, "/ws", noEnv)).toBeNull();
    expect(resolveDebugLogPath({ debug: "/tmp/escape.jsonl" }, {}, "/ws", noEnv)).toBeNull();
  });

  it("rejects debug trace paths that traverse symlinked components (#49)", () => {
    const workspace = tempDir();
    const outside = tempDir();

    symlinkSync(outside, join(workspace, "traces"), "dir");
    expect(resolveDebugLogPath({ debug: "traces/run.jsonl" }, {}, workspace, {} as NodeJS.ProcessEnv)).toBeNull();

    const target = join(outside, "trace.jsonl");
    writeFileSync(target, "");
    symlinkSync(target, join(workspace, "trace.jsonl"), "file");
    expect(resolveDebugLogPath({ debug: "trace.jsonl" }, {}, workspace, {} as NodeJS.ProcessEnv)).toBeNull();
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

  it("forces a full review from CLI or config, else defaults (#23)", () => {
    expect(resolveReviewOptions({}, {}, env).incremental).toBeUndefined(); // → pipeline default (on)
    expect(resolveReviewOptions({ incremental: false }, {}, env).incremental).toBe(false); // --no-incremental
    expect(resolveReviewOptions({}, { review: { incremental: false } }, env).incremental).toBe(false); // config off
    expect(resolveReviewOptions({}, { review: { incremental: true } }, env).incremental).toBe(true);
  });

  it("passes the checkRun config straight through (#24)", () => {
    expect(resolveReviewOptions({}, {}, env).checkRun).toBeUndefined();
    const cfg = { checkRun: { enabled: true, failOn: "critical" as const } };
    expect(resolveReviewOptions({}, cfg, env).checkRun).toEqual({ enabled: true, failOn: "critical" });
  });

  it("passes the riskTiering config straight through (#31)", () => {
    expect(resolveReviewOptions({}, {}, env).riskTiering).toBeUndefined(); // → tiering on with built-in thresholds
    const cfg = { riskTiering: { enabled: false } };
    expect(resolveReviewOptions({}, cfg, env).riskTiering).toEqual({ enabled: false });
  });

  it("resolves the resolveThreads toggle (CLI --no-resolve-threads wins, else config) (#22)", () => {
    expect(resolveReviewOptions({}, {}, env).resolveThreads).toBeUndefined(); // → default on
    expect(resolveReviewOptions({ resolveThreads: false }, {}, env).resolveThreads).toBe(false);
    expect(resolveReviewOptions({}, { review: { resolveThreads: false } }, env).resolveThreads).toBe(false);
  });

  it("passes the approval config straight through (#52)", () => {
    expect(resolveReviewOptions({}, {}, env).approval).toBeUndefined(); // → gate off (comment only)
    const cfg = { approval: { enabled: true, requestChangesAt: "major" as const, approveWhenClean: true } };
    expect(resolveReviewOptions({}, cfg, env).approval).toEqual({
      enabled: true,
      requestChangesAt: "major",
      approveWhenClean: true
    });
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

  it("resolves relative action config paths from the trusted workspace", () => {
    expect(
      resolveConfigLoadOptions(
        {},
        "/runner/workspace/pr-head",
        {
          GITHUB_WORKSPACE: "/runner/workspace/base",
          PROWL_CONFIG_PATH: "prowl-review-config/.prowl-review.yml"
        } as NodeJS.ProcessEnv
      )
    ).toEqual({
      cwd: "/runner/workspace/pr-head",
      configPath: "/runner/workspace/base/prowl-review-config/.prowl-review.yml"
    });
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

  it("logs zero linked issues validated", () => {
    const root = tempDir();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    reportReviewCommandResult(reviewCommandResult({ issuesValidated: 0 }), {
      owner: "o",
      repo: "r",
      pullNumber: 7,
      root,
      providerConfig: { provider: "openai", model: "gpt-5", apiKey: "k" }
    });

    expect(logSpy.mock.calls.some(([line]) => String(line).includes("validated against 0 linked issue(s)"))).toBe(true);
  });

  it("prices ensemble runs with each provider's own model and usage", () => {
    const root = tempDir();
    const summaryPath = join(root, "summary.md");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    reportReviewCommandResult(
      reviewCommandResult({
        review: {
          findings: [],
          raw: [],
          passes: [],
          verification: { verified: 0, droppedFalsePositive: 0, demoted: 0, unverified: 0, ok: true },
          judge: { duplicatesRemoved: 0, belowThreshold: 0, belowConfidence: 0, capped: 0 },
          usage: { inputTokens: 300, outputTokens: 0, cachedInputTokens: 0 }
        },
        usage: { inputTokens: 350, outputTokens: 0, cachedInputTokens: 0 },
        ensemble: {
          providers: [
            {
              provider: "anthropic",
              model: "claude-x",
              ok: true,
              findings: 0,
              usage: { inputTokens: 100, outputTokens: 0, cachedInputTokens: 0 }
            },
            {
              provider: "openai",
              model: "gpt-x",
              ok: true,
              findings: 0,
              usage: { inputTokens: 200, outputTokens: 0, cachedInputTokens: 0 }
            }
          ]
        }
      }),
      {
        owner: "o",
        repo: "r",
        pullNumber: 7,
        root,
        providerConfig: { provider: "anthropic", model: "claude-x", apiKey: "k" },
        pricing: {
          "claude-x": { input: 10, output: 0 },
          "gpt-x": { input: 1, output: 0 }
        },
        env: {
          GITHUB_STEP_SUMMARY: summaryPath,
          PROWL_USAGE_LOG: "usage.jsonl"
        } as NodeJS.ProcessEnv,
        now: () => new Date("2026-06-14T00:00:00.000Z")
      }
    );

    const costLine = logSpy.mock.calls.map(([line]) => String(line)).find((line) => line.startsWith("prowl-review cost:"));
    expect(costLine).toContain("ensemble 3 cost segment(s)");
    expect(costLine).toContain("in 350");
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toContain("anthropic/claude-x");
    expect(summary).toContain("openai/gpt-x");
    const records = readFileSync(join(root, "usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => `${record.provider}/${record.model}`)).toEqual([
      "anthropic/claude-x",
      "anthropic/claude-x",
      "openai/gpt-x"
    ]);
    expect(records.map((record) => record.inputTokens)).toEqual([50, 100, 200]);
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

  it("accepts a provider-specific key when the plain key is absent", () => {
    const cfg = resolveProviderConfig(
      { PROWL_AI_KEY_OPENAI: "openai-key" } as NodeJS.ProcessEnv,
      { provider: "openai", model: "gpt-x" }
    );

    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-x");
    expect(cfg.apiKey).toBe("openai-key");
  });

  it("bootstraps the primary provider from a keyed ensemble provider", () => {
    const env = {
      PROWL_AI_KEY_OPENAI: "openai-key",
      PROWL_AI_KEY_GEMINI: "gemini-key"
    } as NodeJS.ProcessEnv;
    const defaults = resolveProviderDefaults(
      {
        ensemble: {
          enabled: true,
          providers: [{ provider: "openai", model: "gpt-x" }, { provider: "gemini" }]
        }
      },
      env
    );

    expect(defaults).toEqual({ provider: "openai", model: "gpt-x" });
    expect(resolveProviderConfig(env, defaults)).toMatchObject({
      provider: "openai",
      model: "gpt-x",
      apiKey: "openai-key"
    });
  });

  it("uses the scoped key for a bootstrapped ensemble primary before a generic key", () => {
    const env = {
      PROWL_AI_KEY: "legacy-anthropic-key",
      PROWL_AI_KEY_OPENAI: "openai-key",
      PROWL_AI_KEY_GEMINI: "gemini-key"
    } as NodeJS.ProcessEnv;
    const defaults = resolveProviderDefaults(
      {
        ensemble: {
          enabled: true,
          providers: [{ provider: "openai", model: "gpt-x" }, { provider: "gemini" }]
        }
      },
      env
    );

    expect(defaults).toEqual({ provider: "openai", model: "gpt-x" });
    expect(resolveProviderConfig(env, defaults)).toMatchObject({
      provider: "openai",
      model: "gpt-x",
      apiKey: "openai-key"
    });
  });

  it("treats the blank Action provider input as absent for ensemble bootstrap", () => {
    const env = {
      GITHUB_ACTIONS: "true",
      PROWL_AI_PROVIDER: "",
      PROWL_AI_KEY_OPENAI: "openai-key",
      PROWL_AI_KEY_GEMINI: "gemini-key"
    } as NodeJS.ProcessEnv;
    const defaults = resolveProviderDefaults(
      {
        ensemble: {
          enabled: true,
          providers: [{ provider: "openai", model: "gpt-x" }, { provider: "gemini" }]
        }
      },
      env
    );

    expect(defaults).toEqual({ provider: "openai", model: "gpt-x" });
    expect(resolveProviderConfig(env, defaults)).toMatchObject({
      provider: "openai",
      model: "gpt-x",
      apiKey: "openai-key"
    });
  });

  it("skips keyless ensemble defaults when choosing a bootstrap provider", () => {
    const defaults = resolveProviderDefaults(
      {
        ensemble: {
          enabled: true,
          providers: [{ provider: "openai" }, { provider: "gemini", model: "gemini-x" }]
        }
      },
      { PROWL_AI_KEY_GEMINI: "gemini-key" } as NodeJS.ProcessEnv
    );

    expect(defaults).toEqual({ provider: "gemini", model: "gemini-x" });
  });

  it("does not treat the generic key as evidence that every ensemble provider is keyed", () => {
    const env = { PROWL_AI_KEY: "legacy-anthropic-key" } as NodeJS.ProcessEnv;
    const defaults = resolveProviderDefaults(
      {
        ensemble: {
          enabled: true,
          providers: [{ provider: "openai" }, { provider: "anthropic" }]
        }
      },
      env
    );

    expect(defaults).toEqual({});
    expect(resolveProviderConfig(env, defaults)).toMatchObject({
      provider: "anthropic",
      apiKey: "legacy-anthropic-key"
    });
  });

  it("keeps explicit env provider selection ahead of ensemble bootstrap choices", () => {
    const defaults = resolveProviderDefaults(
      {
        ensemble: {
          enabled: true,
          providers: [{ provider: "openai" }, { provider: "gemini" }]
        }
      },
      {
        PROWL_AI_PROVIDER: "gemini",
        PROWL_AI_KEY_OPENAI: "openai-key",
        PROWL_AI_KEY_GEMINI: "gemini-key"
      } as NodeJS.ProcessEnv
    );

    expect(defaults).toEqual({});
  });

  it("keeps explicit provider defaults ahead of ensemble bootstrap choices", () => {
    const defaults = resolveProviderDefaults(
      {
        provider: "anthropic",
        model: "claude-x",
        ensemble: {
          enabled: true,
          providers: [{ provider: "openai" }, { provider: "gemini" }]
        }
      },
      {
        PROWL_AI_KEY_OPENAI: "openai-key",
        PROWL_AI_KEY_GEMINI: "gemini-key"
      } as NodeJS.ProcessEnv
    );

    expect(defaults).toEqual({ provider: "anthropic", model: "claude-x" });
  });
});

describe("GitHub Action provider metadata", () => {
  it("keeps provider and config policy in out-of-band action inputs", () => {
    const action = parseYaml(readFileSync(join(process.cwd(), "action.yml"), "utf8")) as {
      inputs?: Record<string, { default?: unknown; description?: string; required?: unknown }>;
      runs?: { steps?: Array<{ id?: string; env?: Record<string, string>; run?: string }> };
    };
    const reviewStep = action.runs?.steps?.find((step) => step.id === "review");

    expect(action.inputs?.["ai-key"]?.required).toBe(false);
    expect(action.inputs?.["ai-key-anthropic"]?.default).toBe("");
    expect(action.inputs?.["ai-key-openai"]?.default).toBe("");
    expect(action.inputs?.["ai-key-gemini"]?.default).toBe("");
    expect(action.inputs?.["ai-provider"]?.default).toBe("");
    expect(action.inputs?.["ai-provider"]?.description).toContain("Leave blank");
    expect(action.inputs?.["config-path"]?.default).toBe("");
    expect(action.inputs?.["trust-workspace"]?.description).toContain("fork PR");
    expect(reviewStep?.env?.PROWL_INPUT_AI_KEY).toBe("${{ inputs.ai-key }}");
    expect(reviewStep?.env?.PROWL_INPUT_AI_KEY_ANTHROPIC).toBe("${{ inputs.ai-key-anthropic }}");
    expect(reviewStep?.env?.PROWL_INPUT_AI_KEY_OPENAI).toBe("${{ inputs.ai-key-openai }}");
    expect(reviewStep?.env?.PROWL_INPUT_AI_KEY_GEMINI).toBe("${{ inputs.ai-key-gemini }}");
    expect(reviewStep?.env?.PROWL_AI_PROVIDER).toBe("${{ inputs.ai-provider }}");
    expect(reviewStep?.env?.PROWL_CONFIG_PATH).toBe("${{ inputs.config-path }}");
    expect(reviewStep?.env?.PROWL_NO_CONFIG).toBe("${{ inputs.config-path == '' }}");
    expect(reviewStep?.env?.PROWL_REVIEWED_HEAD_SHA).toBe(
      "${{ env.PROWL_REVIEWED_HEAD_SHA || github.event.pull_request.head.sha }}"
    );
    expect(reviewStep?.run).toContain('export PROWL_AI_KEY="${PROWL_INPUT_AI_KEY}"');
    expect(reviewStep?.run).toContain('export PROWL_AI_KEY_ANTHROPIC="${PROWL_INPUT_AI_KEY_ANTHROPIC}"');
    expect(reviewStep?.run).toContain('export PROWL_AI_KEY_OPENAI="${PROWL_INPUT_AI_KEY_OPENAI}"');
    expect(reviewStep?.run).toContain('export PROWL_AI_KEY_GEMINI="${PROWL_INPUT_AI_KEY_GEMINI}"');
    expect(reviewStep?.run).toContain(
      'node "${{ github.action_path }}/dist/cli.js" "${{ inputs.mode == \'command\' && \'command\' || \'review\' }}"'
    );
    expect(action.inputs?.mode?.default).toBe("review");
  });
});

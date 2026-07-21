import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOctokit: vi.fn(() => ({ rest: {} })),
  fetchPriorReviewState: vi.fn(),
  reviewPullRequest: vi.fn(),
  submitCheckRun: vi.fn()
}));

vi.mock("../src/github/client.js", () => ({
  createOctokit: mocks.createOctokit
}));

vi.mock("../src/github/review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/github/review.js")>()),
  fetchPriorReviewState: mocks.fetchPriorReviewState
}));

vi.mock("../src/pipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/pipeline.js")>()),
  reviewPullRequest: mocks.reviewPullRequest
}));

vi.mock("../src/github/check-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/github/check-run.js")>()),
  submitCheckRun: mocks.submitCheckRun
}));

import { runReviewWithOptions } from "../src/cli/commands/review.js";
import type { ReviewPullRequestResult } from "../src/pipeline.js";

const ORIGINAL_ENV = process.env;
const tempDirs: string[] = [];

/** Write a GitHub event payload to a temp file and point GITHUB_EVENT_PATH at it. */
function writeEvent(payload: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), "prowl-review-event-"));
  tempDirs.push(dir);
  const path = join(dir, "event.json");
  writeFileSync(path, JSON.stringify(payload));
  process.env.GITHUB_EVENT_PATH = path;
}

/** Point the workspace at an empty temp dir (no usage-log writes / config discovery in the repo). */
function isolateWorkspace(): void {
  const dir = mkdtempSync(join(tmpdir(), "prowl-review-ws-"));
  tempDirs.push(dir);
  process.env.PROWL_WORKSPACE = dir;
}

/** Write a config file and return its path. */
function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "prowl-review-config-"));
  tempDirs.push(dir);
  const path = join(dir, ".prowl-review.yml");
  writeFileSync(path, contents);
  return path;
}

function clearProviderKeys(): void {
  delete process.env.PROWL_AI_KEY;
  delete process.env.PROWL_AI_KEY_ANTHROPIC;
  delete process.env.PROWL_AI_KEY_OPENAI;
  delete process.env.PROWL_AI_KEY_GEMINI;
}

/** Minimal complete pipeline result so reportReviewCommandResult doesn't throw. */
function reviewResult(over: Partial<ReviewPullRequestResult> = {}): ReviewPullRequestResult {
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
    usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 },
    skipped: [],
    contextFiles: 0,
    posted: false,
    ...over
  };
}

function sameRepoEvent(draft = false): unknown {
  return {
    repository: { full_name: "prowl-tools/prowl-code-review" },
    pull_request: {
      number: 7,
      draft,
      head: { repo: { fork: false, full_name: "prowl-tools/prowl-code-review" }, sha: "head" },
      base: { repo: { full_name: "prowl-tools/prowl-code-review" } }
    }
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, GITHUB_TOKEN: "token" };
  vi.restoreAllMocks();
  mocks.createOctokit.mockReset().mockReturnValue({ rest: {} });
  mocks.fetchPriorReviewState.mockReset();
  mocks.reviewPullRequest.mockReset();
  mocks.submitCheckRun.mockReset();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("runReviewWithOptions pause gate", () => {
  it("skips the review pipeline when auto-review is paused", async () => {
    // Isolate config discovery from the repo's own .prowl-review.yml (which
    // enables checkRun) so this asserts the default: checkRun off → no check.
    isolateWorkspace();
    writeEvent(sameRepoEvent());
    mocks.fetchPriorReviewState.mockResolvedValue({ v: 1, paused: true, postedFindings: [] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runReviewWithOptions({ pr: "7", repo: "prowl-tools/prowl-code-review" }, { respectPause: true });

    expect(mocks.createOctokit).toHaveBeenCalledWith("token");
    expect(mocks.fetchPriorReviewState).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 }
    );
    expect(mocks.reviewPullRequest).not.toHaveBeenCalled();
    expect(mocks.submitCheckRun).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("auto-review paused"));
  });

  it("publishes a neutral check run when paused and checkRun is enabled", async () => {
    writeEvent(sameRepoEvent());
    const tempDir = mkdtempSync(join(tmpdir(), "prowl-review-pause-"));
    const configPath = join(tempDir, ".prowl-review.yml");
    writeFileSync(configPath, "checkRun:\n  enabled: true\n");

    try {
      process.env.PROWL_REVIEWED_HEAD_SHA = "head-paused";
      mocks.fetchPriorReviewState.mockResolvedValue({ v: 1, paused: true, postedFindings: [] });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await runReviewWithOptions(
        { pr: "7", repo: "prowl-tools/prowl-code-review", config: configPath },
        { respectPause: true }
      );

      expect(mocks.reviewPullRequest).not.toHaveBeenCalled();
      expect(mocks.submitCheckRun).toHaveBeenCalledWith(
        expect.anything(),
        { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 },
        expect.objectContaining({
          headSha: "head-paused",
          plan: expect.objectContaining({
            conclusion: "neutral",
            title: "Auto-review paused",
            annotations: []
          })
        })
      );
      const plan = mocks.submitCheckRun.mock.calls[0][2].plan;
      expect(plan.summary).toContain("@prowl-review resume");
      expect(logSpy).toHaveBeenCalledWith("prowl-review: merge-gate check run → neutral");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not fail the skip when neutral check-run submission fails", async () => {
    isolateWorkspace();
    writeEvent(sameRepoEvent());
    process.env.PROWL_REVIEWED_HEAD_SHA = "head-paused";
    mocks.fetchPriorReviewState.mockResolvedValue({ v: 1, paused: true, postedFindings: [] });
    mocks.submitCheckRun.mockRejectedValue(new Error("checks API unavailable"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const config = writeConfig("checkRun:\n  enabled: true\n");

    await expect(
      runReviewWithOptions(
        { pr: "7", repo: "prowl-tools/prowl-code-review", config },
        { respectPause: true }
      )
    ).resolves.toBeUndefined();

    expect(mocks.reviewPullRequest).not.toHaveBeenCalled();
    expect(mocks.submitCheckRun).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("auto-review paused"));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("merge-gate check run"));
  });
});

describe("runReviewWithOptions draft + auto controls (#28)", () => {
  it("skips a draft PR by default on the auto path", async () => {
    isolateWorkspace();
    mocks.fetchPriorReviewState.mockResolvedValue(null);
    writeEvent(sameRepoEvent(true));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runReviewWithOptions({ pr: "7", repo: "prowl-tools/prowl-code-review" }, { respectPause: true });

    expect(mocks.reviewPullRequest).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("skipped draft pull request"));
  });

  it("reviews a draft when review.reviewDrafts is true", async () => {
    isolateWorkspace();
    mocks.fetchPriorReviewState.mockResolvedValue(null);
    mocks.reviewPullRequest.mockResolvedValue(reviewResult());
    writeEvent(sameRepoEvent(true));
    process.env.PROWL_REVIEWED_HEAD_SHA = "head-draft";
    process.env.PROWL_AI_KEY = "key";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const config = writeConfig("review:\n  reviewDrafts: true\ncheckRun:\n  enabled: true\n");

    await runReviewWithOptions(
      { pr: "7", repo: "prowl-tools/prowl-code-review", config },
      { respectPause: true }
    );

    expect(mocks.reviewPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.submitCheckRun).not.toHaveBeenCalled();
  });

  it("reviews a ready (non-draft) PR on the auto path", async () => {
    isolateWorkspace();
    mocks.fetchPriorReviewState.mockResolvedValue(null);
    mocks.reviewPullRequest.mockResolvedValue(reviewResult());
    writeEvent(sameRepoEvent(false));
    process.env.PROWL_REVIEWED_HEAD_SHA = "head-ready";
    process.env.PROWL_AI_KEY = "key";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const config = writeConfig("checkRun:\n  enabled: true\n");

    await runReviewWithOptions(
      { pr: "7", repo: "prowl-tools/prowl-code-review", config },
      { respectPause: true }
    );

    expect(mocks.reviewPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.submitCheckRun).not.toHaveBeenCalled();
  });

  it("reviews a draft when invoked on demand (respectPause cleared)", async () => {
    isolateWorkspace();
    mocks.reviewPullRequest.mockResolvedValue(reviewResult());
    writeEvent(sameRepoEvent(true));
    process.env.PROWL_REVIEWED_HEAD_SHA = "head-demand";
    process.env.PROWL_AI_KEY = "key";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const config = writeConfig("checkRun:\n  enabled: true\n");

    await runReviewWithOptions(
      { pr: "7", repo: "prowl-tools/prowl-code-review", config },
      { respectPause: false }
    );

    expect(mocks.fetchPriorReviewState).not.toHaveBeenCalled();
    expect(mocks.reviewPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.submitCheckRun).not.toHaveBeenCalled();
  });

  it("skips on the auto path when review.auto is false (on-demand only)", async () => {
    isolateWorkspace();
    mocks.fetchPriorReviewState.mockResolvedValue(null);
    writeEvent(sameRepoEvent(false));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const config = writeConfig("review:\n  auto: false\n");

    await runReviewWithOptions(
      { pr: "7", repo: "prowl-tools/prowl-code-review", config },
      { respectPause: true }
    );

    expect(mocks.reviewPullRequest).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("auto-review disabled"));
  });

  it("posts a neutral check run when skipping a draft with checkRun enabled", async () => {
    isolateWorkspace();
    mocks.fetchPriorReviewState.mockResolvedValue(null);
    writeEvent(sameRepoEvent(true));
    process.env.PROWL_REVIEWED_HEAD_SHA = "head-draft";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const config = writeConfig("checkRun:\n  enabled: true\n");

    await runReviewWithOptions(
      { pr: "7", repo: "prowl-tools/prowl-code-review", config },
      { respectPause: true }
    );

    expect(mocks.reviewPullRequest).not.toHaveBeenCalled();
    expect(mocks.submitCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 },
      expect.objectContaining({
        headSha: "head-draft",
        plan: expect.objectContaining({ conclusion: "neutral", title: "Draft pull request — review skipped" })
      })
    );
  });
});

describe("runReviewWithOptions fork-PR safety (#20)", () => {
  const forkEvent = {
    pull_request: { number: 7, draft: false, head: { repo: { fork: true, full_name: "contributor/prowl-code-review" } } }
  };

  it("does not fetch prior review state when skipping a keyless fork PR", async () => {
    isolateWorkspace();
    writeEvent(forkEvent);
    clearProviderKeys();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runReviewWithOptions({ pr: "7", repo: "prowl-tools/prowl-code-review" }, { respectPause: true });

    expect(mocks.reviewPullRequest).not.toHaveBeenCalled();
    // Skipped before the pause gate, so prior state is never fetched.
    expect(mocks.fetchPriorReviewState).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("skipped fork pull request"));
  });

  it("fetches PR repo metadata before deciding fork safety for issue-comment reviews", async () => {
    isolateWorkspace();
    writeEvent({ issue: { number: 7, pull_request: { url: "https://api.github.com/repos/prowl-tools/prowl-code-review/pulls/7" } } });
    clearProviderKeys();
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: "Fork PR",
        body: null,
        base: { sha: "base", repo: { full_name: "prowl-tools/prowl-code-review" } },
        head: {
          sha: "head",
          repo: { full_name: "contributor/prowl-code-review", fork: true }
        },
        draft: false,
        state: "open",
        user: { login: "contributor" },
        changed_files: 1
      }
    });
    mocks.createOctokit.mockReturnValue({ rest: { pulls: { get: pullsGet } } });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runReviewWithOptions({ pr: "7", repo: "prowl-tools/prowl-code-review" });

    expect(pullsGet).toHaveBeenCalledWith({ owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 });
    expect(mocks.reviewPullRequest).not.toHaveBeenCalled();
    expect(mocks.fetchPriorReviewState).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("skipped fork pull request"));
  });

  it("fetches PR repo metadata before deciding fork safety when event head repo is null", async () => {
    isolateWorkspace();
    writeEvent({ pull_request: { number: 7, draft: false, head: { repo: null, sha: "head" } } });
    clearProviderKeys();
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: "Fork PR",
        body: null,
        base: { sha: "base", repo: { full_name: "prowl-tools/prowl-code-review" } },
        head: {
          sha: "head",
          repo: { full_name: "contributor/prowl-code-review", fork: true }
        },
        draft: false,
        state: "open",
        user: { login: "contributor" },
        changed_files: 1
      }
    });
    mocks.createOctokit.mockReturnValue({ rest: { pulls: { get: pullsGet } } });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runReviewWithOptions({ pr: "7", repo: "prowl-tools/prowl-code-review" });

    expect(pullsGet).toHaveBeenCalledWith({ owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 });
    expect(mocks.reviewPullRequest).not.toHaveBeenCalled();
    expect(mocks.fetchPriorReviewState).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("skipped fork pull request"));
  });

  it("does not fetch PR repo metadata before a paused auto-review exit when event metadata is incomplete", async () => {
    isolateWorkspace();
    writeEvent({ issue: { number: 7, pull_request: { url: "https://api.github.com/repos/prowl-tools/prowl-code-review/pulls/7" } } });
    clearProviderKeys();
    const pullsGet = vi.fn();
    mocks.createOctokit.mockReturnValue({ rest: { pulls: { get: pullsGet } } });
    mocks.fetchPriorReviewState.mockResolvedValue({ v: 1, paused: true, postedFindings: [] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runReviewWithOptions({ pr: "7", repo: "prowl-tools/prowl-code-review" }, { respectPause: true });

    expect(mocks.fetchPriorReviewState).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 }
    );
    expect(pullsGet).not.toHaveBeenCalled();
    expect(mocks.reviewPullRequest).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("auto-review paused"));
  });

  it("uses complete same-repo event metadata without fetching PR repo metadata", async () => {
    isolateWorkspace();
    writeEvent({
      repository: { full_name: "prowl-tools/prowl-code-review" },
      pull_request: {
        number: 7,
        draft: false,
        head: { repo: { fork: false, full_name: "prowl-tools/prowl-code-review" }, sha: "head" },
        base: { repo: { full_name: "prowl-tools/prowl-code-review" } }
      }
    });
    process.env.PROWL_AI_KEY = "key";
    const pullsGet = vi.fn();
    mocks.createOctokit.mockReturnValue({ rest: { pulls: { get: pullsGet } } });
    mocks.fetchPriorReviewState.mockResolvedValue(null);
    mocks.reviewPullRequest.mockResolvedValue(reviewResult());
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runReviewWithOptions({ pr: "7", repo: "prowl-tools/prowl-code-review" }, { respectPause: true });

    expect(pullsGet).not.toHaveBeenCalled();
    expect(mocks.reviewPullRequest).toHaveBeenCalledTimes(1);
  });

  it("posts a neutral check run for a skipped fork PR when checkRun is enabled (tolerant)", async () => {
    isolateWorkspace();
    writeEvent(forkEvent);
    clearProviderKeys();
    process.env.PROWL_REVIEWED_HEAD_SHA = "fork-head";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const config = writeConfig("checkRun:\n  enabled: true\n");

    await runReviewWithOptions({ pr: "7", repo: "prowl-tools/prowl-code-review", config }, { respectPause: true });

    expect(mocks.reviewPullRequest).not.toHaveBeenCalled();
    expect(mocks.submitCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 },
      expect.objectContaining({
        headSha: "fork-head",
        plan: expect.objectContaining({ conclusion: "neutral", title: "Fork pull request — review skipped" })
      })
    );
  });

  it("reviews a fork PR that has a key (pull_request_target), warning that the fork is untrusted", async () => {
    isolateWorkspace();
    writeEvent(forkEvent);
    mocks.fetchPriorReviewState.mockResolvedValue(null);
    mocks.reviewPullRequest.mockResolvedValue(reviewResult());
    process.env.PROWL_AI_KEY = "key";
    process.env.PROWL_REVIEWED_HEAD_SHA = "fork-head";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runReviewWithOptions({ pr: "7", repo: "prowl-tools/prowl-code-review" }, { respectPause: true });

    expect(mocks.reviewPullRequest).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("reviewing a FORK pull request"));
  });
});

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
});

describe("runReviewWithOptions draft + auto controls (#28)", () => {
  it("skips a draft PR by default on the auto path", async () => {
    isolateWorkspace();
    mocks.fetchPriorReviewState.mockResolvedValue(null);
    writeEvent({ pull_request: { number: 7, draft: true } });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runReviewWithOptions({ pr: "7", repo: "prowl-tools/prowl-code-review" }, { respectPause: true });

    expect(mocks.reviewPullRequest).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("skipped draft pull request"));
  });

  it("reviews a draft when review.reviewDrafts is true", async () => {
    isolateWorkspace();
    mocks.fetchPriorReviewState.mockResolvedValue(null);
    mocks.reviewPullRequest.mockResolvedValue(reviewResult());
    writeEvent({ pull_request: { number: 7, draft: true } });
    process.env.PROWL_AI_KEY = "key";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const config = writeConfig("review:\n  reviewDrafts: true\n");

    await runReviewWithOptions(
      { pr: "7", repo: "prowl-tools/prowl-code-review", config },
      { respectPause: true }
    );

    expect(mocks.reviewPullRequest).toHaveBeenCalledTimes(1);
  });

  it("reviews a ready (non-draft) PR on the auto path", async () => {
    isolateWorkspace();
    mocks.fetchPriorReviewState.mockResolvedValue(null);
    mocks.reviewPullRequest.mockResolvedValue(reviewResult());
    writeEvent({ pull_request: { number: 7, draft: false } });
    process.env.PROWL_AI_KEY = "key";
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runReviewWithOptions({ pr: "7", repo: "prowl-tools/prowl-code-review" }, { respectPause: true });

    expect(mocks.reviewPullRequest).toHaveBeenCalledTimes(1);
  });

  it("reviews a draft when invoked on demand (respectPause cleared)", async () => {
    isolateWorkspace();
    mocks.reviewPullRequest.mockResolvedValue(reviewResult());
    writeEvent({ pull_request: { number: 7, draft: true } });
    process.env.PROWL_AI_KEY = "key";
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runReviewWithOptions({ pr: "7", repo: "prowl-tools/prowl-code-review" }, { respectPause: false });

    expect(mocks.fetchPriorReviewState).not.toHaveBeenCalled();
    expect(mocks.reviewPullRequest).toHaveBeenCalledTimes(1);
  });

  it("skips on the auto path when review.auto is false (on-demand only)", async () => {
    isolateWorkspace();
    mocks.fetchPriorReviewState.mockResolvedValue(null);
    writeEvent({ pull_request: { number: 7, draft: false } });
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
    writeEvent({ pull_request: { number: 7, draft: true } });
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

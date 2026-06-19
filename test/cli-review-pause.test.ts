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

const ORIGINAL_ENV = process.env;

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

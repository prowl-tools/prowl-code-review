import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOctokit: vi.fn(() => ({ rest: {} })),
  fetchPriorReviewState: vi.fn(),
  reviewPullRequest: vi.fn()
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

import { runReviewWithOptions } from "../src/cli/commands/review.js";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, GITHUB_TOKEN: "token" };
  vi.restoreAllMocks();
  mocks.createOctokit.mockReset().mockReturnValue({ rest: {} });
  mocks.fetchPriorReviewState.mockReset();
  mocks.reviewPullRequest.mockReset();
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
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("auto-review paused"));
  });
});

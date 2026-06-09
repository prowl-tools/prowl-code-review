import { describe, expect, it, vi } from "vitest";
import { submitReview } from "../src/github/review.js";
import type { OctokitLike } from "../src/github/client.js";
import type { ReviewPayload } from "../src/review/inline.js";

function mockOctokit() {
  const createReview = vi.fn(async () => ({ data: {} }));
  const octokit = { rest: { pulls: { createReview } } } as unknown as OctokitLike;
  return { octokit, createReview };
}

const ref = { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 12 };

const payload: ReviewPayload = {
  body: "## 🦝 prowl-review",
  event: "COMMENT",
  comments: [{ path: "src/a.ts", line: 6, side: "RIGHT", body: "issue" }]
};

describe("submitReview", () => {
  it("publishes one review with body, event, comments, and commit id", async () => {
    const { octokit, createReview } = mockOctokit();
    await submitReview(octokit, ref, payload, "head-sha");

    expect(createReview).toHaveBeenCalledTimes(1);
    expect(createReview).toHaveBeenCalledWith({
      owner: "prowl-tools",
      repo: "prowl-code-review",
      pull_number: 12,
      body: "## 🦝 prowl-review",
      event: "COMMENT",
      commit_id: "head-sha",
      comments: payload.comments
    });
  });

  it("omits commit_id when not provided", async () => {
    const { octokit, createReview } = mockOctokit();
    await submitReview(octokit, ref, payload);

    const args = createReview.mock.calls[0][0] as Record<string, unknown>;
    expect(args).not.toHaveProperty("commit_id");
    expect(args.event).toBe("COMMENT");
  });
});

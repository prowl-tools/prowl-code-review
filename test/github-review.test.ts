import { describe, expect, it, vi } from "vitest";
import { submitReview, planPublish } from "../src/github/review.js";
import type { OctokitLike } from "../src/github/client.js";
import type { ReviewComment, ReviewPayload } from "../src/review/inline.js";
import { REVIEW_MARKER } from "../src/review/walkthrough.js";
import { serializeState, parseState } from "../src/review/state.js";

function mockOctokit(priorComments: Array<{ id: number; body?: string; user?: { login?: string } | null }> = []) {
  const listComments = vi.fn(async () => ({ data: priorComments }));
  const createComment = vi.fn(async () => ({ data: {} }));
  const updateComment = vi.fn(async () => ({ data: {} }));
  const createReviewComment = vi.fn(async () => ({ data: {} }));
  const octokit = {
    rest: {
      pulls: { createReviewComment },
      issues: { listComments, createComment, updateComment }
    }
  } as unknown as OctokitLike;
  return { octokit, listComments, createComment, updateComment, createReviewComment };
}

const ref = { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 12 };

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return { path: "src/a.ts", line: 6, side: "RIGHT", body: "issue", fingerprint: "fp-a", ...over };
}

function payload(over: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    body: `${REVIEW_MARKER}\n## prowl-review\n\nsummary`,
    event: "COMMENT",
    comments: [comment()],
    ...over
  };
}

describe("planPublish", () => {
  it("creates on first run and records all inline fingerprints in state", () => {
    const plan = planPublish({ payload: payload(), priorComment: null, headSha: "sha1" });
    expect(plan.priorCommentId).toBeUndefined();
    expect(plan.newInlineComments).toHaveLength(1);
    expect(plan.state.lastReviewedSha).toBe("sha1");
    expect(plan.state.postedFindings).toEqual(["fp-a"]);
    expect(parseState(plan.summaryBody)).toEqual(plan.state); // state embedded in body
  });

  it("dedups inline findings already posted on a prior push", () => {
    const prior = {
      id: 99,
      body: `${REVIEW_MARKER}\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`
    };
    const plan = planPublish({
      payload: payload({ comments: [comment({ fingerprint: "fp-a" }), comment({ fingerprint: "fp-b" })] }),
      priorComment: prior,
      headSha: "sha2"
    });
    expect(plan.priorCommentId).toBe(99);
    // fp-a already posted → only fp-b is net-new.
    expect(plan.newInlineComments.map((c) => c.fingerprint)).toEqual(["fp-b"]);
    // state accumulates both.
    expect(plan.state.postedFindings.sort()).toEqual(["fp-a", "fp-b"]);
  });
});

describe("submitReview", () => {
  it("creates the summary comment and posts inline findings on a first run", async () => {
    const { octokit, createComment, updateComment, createReviewComment } = mockOctokit([]);
    await submitReview(octokit, ref, payload(), { commitId: "head", headSha: "head" });

    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
    const created = createComment.mock.calls[0][0] as { body: string; issue_number: number };
    expect(created.issue_number).toBe(12);
    expect(created.body).toContain("prowl-review:state"); // state embedded
    expect(createReviewComment).toHaveBeenCalledTimes(1);
    const inline = createReviewComment.mock.calls[0][0] as Record<string, unknown>;
    expect(inline.commit_id).toBe("head");
    expect(inline).not.toHaveProperty("fingerprint"); // internal field stripped
  });

  it("updates the prior summary in place and skips already-posted inline findings", async () => {
    const prior = {
      id: 77,
      body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`
    };
    const { octokit, createComment, updateComment, createReviewComment } = mockOctokit([prior]);
    await submitReview(octokit, ref, payload(), { commitId: "head2", headSha: "head2" });

    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect((updateComment.mock.calls[0][0] as { comment_id: number }).comment_id).toBe(77);
    // The single finding was already posted last push → no new inline comment.
    expect(createReviewComment).not.toHaveBeenCalled();
  });

  it("does not post inline comments when no commit id is available", async () => {
    const { octokit, createReviewComment } = mockOctokit([]);
    await submitReview(octokit, ref, payload());
    expect(createReviewComment).not.toHaveBeenCalled();
  });
});

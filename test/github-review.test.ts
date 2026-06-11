import { describe, expect, it, vi } from "vitest";
import { submitReview, planPublish } from "../src/github/review.js";
import type { OctokitLike } from "../src/github/client.js";
import type { ReviewComment, ReviewPayload } from "../src/review/inline.js";
import { REVIEW_MARKER } from "../src/review/walkthrough.js";
import { serializeState, parseState } from "../src/review/state.js";

type MockIssueComment = { id: number; body?: string; user?: { login?: string } | null };

function mockOctokit(priorComments: MockIssueComment[] = []) {
  const listComments = vi.fn(
    async (params: { per_page?: number; page?: number }) => {
      const perPage = params.per_page ?? 30;
      const page = params.page ?? 1;
      const start = (page - 1) * perPage;
      return { data: priorComments.slice(start, start + perPage) };
    }
  );
  const createComment = vi.fn(async () => ({ data: {} }));
  const updateComment = vi.fn(async () => ({ data: {} }));
  const createReview = vi.fn(async () => ({ data: {} }));
  const octokit = {
    rest: {
      pulls: { createReview },
      issues: { listComments, createComment, updateComment }
    }
  } as unknown as OctokitLike;
  return { octokit, listComments, createComment, updateComment, createReview };
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

  it("can leave unposted inline findings out of persisted state", () => {
    const plan = planPublish({
      payload: payload(),
      priorComment: null,
      headSha: "sha1",
      postedInlineComments: []
    });
    expect(plan.newInlineComments.map((c) => c.fingerprint)).toEqual(["fp-a"]);
    expect(plan.state.postedFindings).toEqual([]);
    expect(parseState(plan.summaryBody)).toEqual(plan.state);
  });
});

describe("submitReview", () => {
  it("creates the summary comment and posts inline findings as one review on a first run", async () => {
    const { octokit, createComment, updateComment, createReview } = mockOctokit([]);
    await submitReview(octokit, ref, payload(), { commitId: "head", headSha: "head" });

    expect(updateComment).not.toHaveBeenCalled();
    expect(createReview).toHaveBeenCalledTimes(1);
    const review = createReview.mock.calls[0][0] as {
      commit_id?: string;
      event?: string;
      comments?: Array<Record<string, unknown>>;
    };
    expect(review.commit_id).toBe("head");
    expect(review.event).toBe("COMMENT");
    expect(review).toEqual(
      expect.objectContaining({
        body: "prowl-review posted 1 new inline finding. See the summary comment for full review context."
      })
    );
    expect(review.comments).toHaveLength(1);
    expect(review.comments?.[0]).not.toHaveProperty("fingerprint"); // internal field stripped
    expect(createComment).toHaveBeenCalledTimes(1);
    const created = createComment.mock.calls[0][0] as { body: string; issue_number: number };
    expect(created.issue_number).toBe(12);
    expect(created.body).toContain("prowl-review:state"); // state embedded
    expect(parseState(created.body)?.postedFindings).toEqual(["fp-a"]);
  });

  it("updates the prior summary in place and skips already-posted inline findings", async () => {
    const prior = {
      id: 77,
      body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`
    };
    const { octokit, createComment, updateComment, createReview } = mockOctokit([prior]);
    await submitReview(octokit, ref, payload(), { commitId: "head2", headSha: "head2" });

    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect((updateComment.mock.calls[0][0] as { comment_id: number }).comment_id).toBe(77);
    // The single finding was already posted last push → no new inline comment.
    expect(createReview).not.toHaveBeenCalled();
  });

  it("updates the summary even when there are no new inline findings", async () => {
    const prior = {
      id: 77,
      body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`
    };
    const { octokit, createComment, updateComment, createReview } = mockOctokit([prior]);
    await submitReview(
      octokit,
      ref,
      payload({ body: `${REVIEW_MARKER}\n## prowl-review\n\nnew summary` }),
      { headSha: "head3" }
    );

    expect(createReview).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledTimes(1);
    const updated = updateComment.mock.calls[0][0] as { body: string; comment_id: number };
    expect(updated.comment_id).toBe(77);
    expect(updated.body).toContain("new summary");
    expect(parseState(updated.body)).toEqual({
      v: 1,
      lastReviewedSha: "head3",
      postedFindings: ["fp-a"]
    });
  });

  it("does not post inline comments when no commit id is available", async () => {
    const { octokit, createComment, createReview } = mockOctokit([]);
    await submitReview(octokit, ref, payload());
    expect(createReview).not.toHaveBeenCalled();
    const created = createComment.mock.calls[0][0] as { body: string };
    expect(parseState(created.body)?.postedFindings).toEqual([]);
  });

  it("does not persist new fingerprints when posting the review fails", async () => {
    const { octokit, createComment, updateComment, createReview } = mockOctokit([]);
    createReview.mockRejectedValueOnce(new Error("github unavailable"));

    await expect(
      submitReview(octokit, ref, payload(), { commitId: "head", headSha: "head" })
    ).rejects.toThrow("github unavailable");

    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
  });

  it("preserves non-comment review events", async () => {
    const { octokit, createComment, createReview } = mockOctokit([]);
    await submitReview(
      octokit,
      ref,
      payload({ event: "REQUEST_CHANGES", comments: [] }),
      { headSha: "head" }
    );

    expect(createReview).toHaveBeenCalledTimes(1);
    expect(createReview.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        owner: "prowl-tools",
        repo: "prowl-code-review",
        pull_number: 12,
        event: "REQUEST_CHANGES",
        body: expect.stringContaining("summary")
      })
    );
    expect(createReview.mock.calls[0][0]).not.toHaveProperty("comments");
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it("paginates when looking for the prior summary comment", async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: "noise" }));
    const prior = {
      id: 201,
      body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`,
      user: { login: "github-actions[bot]" }
    };
    const { octokit, listComments, createComment, updateComment } = mockOctokit([...filler, prior]);

    await submitReview(octokit, ref, payload(), { botLogin: "github-actions[bot]" });

    expect(listComments).toHaveBeenCalledTimes(2);
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect((updateComment.mock.calls[0][0] as { comment_id: number }).comment_id).toBe(201);
  });

  it("caps the prior summary scan to avoid unbounded pagination", async () => {
    const filler = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, body: "noise" }));
    const priorAfterCap = {
      id: 1001,
      body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`
    };
    const { octokit, listComments, createComment, updateComment, createReview } = mockOctokit([
      ...filler,
      priorAfterCap
    ]);

    await submitReview(octokit, ref, payload());

    expect(listComments).toHaveBeenCalledTimes(10);
    expect(updateComment).not.toHaveBeenCalled();
    expect(createReview).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
  });
});

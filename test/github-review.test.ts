import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  submitReview,
  planPublish,
  hasActiveRequestChanges,
  setPausedState,
  setIgnoredFindings,
  setConfigOverrides,
  fetchReviewCommentFingerprints,
  fetchReviewCommentLearningEntries,
  fetchRepoLearnings,
  recordRepoLearnings,
  replyToReviewComment,
  fetchReviewCommentBody,
  getAuthenticatedLogin
} from "../src/github/review.js";
import type { OctokitLike } from "../src/github/client.js";
import type { ReviewComment, ReviewPayload } from "../src/review/inline.js";
import { REVIEW_MARKER } from "../src/review/walkthrough.js";
import { serializeState, parseState } from "../src/review/state.js";
import {
  LEARNINGS_ISSUE_TITLE,
  learningFingerprints,
  parseLearnings,
  renderLearningsIssueBody
} from "../src/review/learnings.js";

type MockIssueComment = { id: number; body?: string; user?: { login?: string } | null };
type MockReviewComment = { body?: string; user?: { login?: string } | null };
type MockReviewSubmission = { state?: string; user?: { login?: string } | null };

function mockOctokit(
  priorComments: MockIssueComment[] = [],
  priorReviewComments: MockReviewComment[] = [],
  login = "github-actions[bot]",
  priorReviews: MockReviewSubmission[] = []
) {
  const listComments = vi.fn(
    async (params: { per_page?: number; page?: number; sort?: string; direction?: "asc" | "desc" }) => {
      const perPage = params.per_page ?? 30;
      const page = params.page ?? 1;
      const comments =
        (params.sort === undefined || params.sort === "created") && params.direction === "desc"
          ? [...priorComments].reverse()
          : priorComments;
      const start = (page - 1) * perPage;
      return { data: comments.slice(start, start + perPage) };
    }
  );
  const listReviewComments = vi.fn(
    async (params: { per_page?: number; page?: number }) => {
      const perPage = params.per_page ?? 30;
      const page = params.page ?? 1;
      const start = (page - 1) * perPage;
      return { data: priorReviewComments.slice(start, start + perPage) };
    }
  );
  const listReviews = vi.fn(
    async (params: { per_page?: number; page?: number }) => {
      const perPage = params.per_page ?? 30;
      const page = params.page ?? 1;
      const start = (page - 1) * perPage;
      return { data: priorReviews.slice(start, start + perPage) };
    }
  );
  let nextCommentId = 9000;
  const createComment = vi.fn(async () => ({ data: { id: (nextCommentId += 1) } }));
  const updateComment = vi.fn(async () => ({ data: {} }));
  const createReview = vi.fn(async () => ({ data: {} }));
  const createReplyForReviewComment = vi.fn(async () => ({ data: {} }));
  const getReviewComment = vi.fn(async () => ({ data: { body: "root finding" } }));
  const getAuthenticated = vi.fn(async () => ({ data: { login } }));
  const octokit = {
    rest: {
      pulls: {
        createReview,
        createReplyForReviewComment,
        getReviewComment,
        listReviewComments,
        listReviews
      },
      issues: { listComments, createComment, updateComment },
      users: { getAuthenticated }
    }
  } as unknown as OctokitLike;
  return {
    octokit,
    listComments,
    listReviewComments,
    listReviews,
    createComment,
    updateComment,
    createReview,
    createReplyForReviewComment,
    getReviewComment,
    getAuthenticated
  };
}

const ref = { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 12 };

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return { path: "src/a.ts", line: 6, side: "RIGHT", body: "issue", severity: "major", fingerprint: "fp-a", ...over };
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

  it("can create a fresh summary while carrying forward prior dedup state", () => {
    const prior = {
      id: 99,
      body:
        `${REVIEW_MARKER}\n## prowl-review\n\nold unresolved summary finding\n` +
        serializeState({ v: 1, lastReviewedSha: "old-sha", postedFindings: ["fp-a"] })
    };
    const plan = planPublish({
      payload: payload({
        body: `${REVIEW_MARKER}\n## prowl-review\n\nnew delta summary`,
        comments: [comment({ fingerprint: "fp-a" }), comment({ fingerprint: "fp-b" })]
      }),
      priorComment: prior,
      headSha: "sha2",
      preservePriorSummary: true
    });

    expect(plan.priorCommentId).toBeUndefined();
    expect(plan.newInlineComments.map((c) => c.fingerprint)).toEqual(["fp-b"]);
    expect(plan.state).toEqual({ v: 1, lastReviewedSha: "sha2", postedFindings: ["fp-a", "fp-b"] });
    expect(plan.summaryBody).toContain("new delta summary");
    expect(plan.summaryBody).not.toContain("old unresolved summary finding");
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

  it("dedups against fingerprints recovered from prior inline comments", () => {
    const plan = planPublish({
      payload: payload({ comments: [comment({ fingerprint: "fp-a" }), comment({ fingerprint: "fp-b" })] }),
      priorComment: null,
      priorPostedFindings: ["fp-a"],
      headSha: "sha1"
    });
    expect(plan.newInlineComments.map((c) => c.fingerprint)).toEqual(["fp-b"]);
    expect(plan.state.postedFindings.sort()).toEqual(["fp-a", "fp-b"]);
  });

  it("preserves the paused flag from prior summary state", () => {
    const prior = {
      id: 99,
      body: `${REVIEW_MARKER}\n${serializeState({ v: 1, paused: true, postedFindings: ["fp-a"] })}`
    };
    const plan = planPublish({
      payload: payload({ comments: [comment({ fingerprint: "fp-a" })] }),
      priorComment: prior,
      headSha: "sha2"
    });

    expect(plan.state).toEqual({ v: 1, lastReviewedSha: "sha2", paused: true, postedFindings: ["fp-a"] });
    expect(parseState(plan.summaryBody)?.paused).toBe(true);
  });

  it("preserves the ignore list across a review publish (#30)", () => {
    const prior = {
      id: 99,
      body: `${REVIEW_MARKER}\n${serializeState({
        v: 1,
        paused: true,
        ignoredFindings: ["fp-muted"],
        postedFindings: ["fp-a"]
      })}`
    };
    const plan = planPublish({
      payload: payload({ comments: [comment({ fingerprint: "fp-a" })] }),
      priorComment: prior,
      headSha: "sha2"
    });
    // A normal review must not wipe the muted-finding list.
    expect(plan.state.paused).toBe(true);
    expect(plan.state.ignoredFindings).toEqual(["fp-muted"]);
    expect(parseState(plan.summaryBody)?.ignoredFindings).toEqual(["fp-muted"]);
  });

  it("allows reposting fingerprints whose old thread was resolved as fixed", () => {
    const prior = {
      id: 99,
      body: `${REVIEW_MARKER}\n${serializeState({ v: 1, postedFindings: ["fp-a", "fp-b"] })}`
    };
    const plan = planPublish({
      payload: payload({ comments: [comment({ fingerprint: "fp-a" }), comment({ fingerprint: "fp-b" })] }),
      priorComment: prior,
      priorPostedFindings: ["fp-a", "fp-b"],
      repostableFindings: ["fp-a"],
      headSha: "sha2"
    });
    expect(plan.newInlineComments.map((c) => c.fingerprint)).toEqual(["fp-a"]);
    expect(plan.state.postedFindings.sort()).toEqual(["fp-a", "fp-b"]);
  });

  it("drops repostable fingerprints from persisted state when they are not current", () => {
    const prior = {
      id: 99,
      body: `${REVIEW_MARKER}\n${serializeState({ v: 1, postedFindings: ["fixed", "still-current"] })}`
    };
    const plan = planPublish({
      payload: payload({ comments: [] }),
      priorComment: prior,
      priorPostedFindings: ["fixed", "still-current"],
      repostableFindings: ["fixed"],
      headSha: "sha2"
    });
    expect(plan.newInlineComments).toEqual([]);
    expect(plan.state.postedFindings).toEqual(["still-current"]);
  });

  it("prunes state history before truncating visible summary content", () => {
    const priorPostedFindings = Array.from({ length: 400 }, (_, index) => `fp-${index.toString().padStart(4, "0")}`);
    const plan = planPublish({
      payload: payload({
        body: `${REVIEW_MARKER}\n${"x".repeat(65_000)}`,
        comments: []
      }),
      priorComment: null,
      priorPostedFindings,
      headSha: "sha1"
    });

    expect(plan.summaryBody.length).toBeLessThanOrEqual(65_536);
    expect(plan.summaryBody).not.toContain("[summary truncated to keep the GitHub comment within the body size limit]");
    expect(plan.state.postedFindings.length).toBeLessThan(priorPostedFindings.length);
    expect(parseState(plan.summaryBody)).toEqual(plan.state);
  });

  it("prunes old fingerprints when the state marker alone would exceed the comment limit", () => {
    const priorPostedFindings = Array.from(
      { length: 5_000 },
      (_, index) => `fp-${index.toString().padStart(14, "0")}`
    );
    const plan = planPublish({
      payload: payload({
        body: `${REVIEW_MARKER}\nsummary`,
        comments: []
      }),
      priorComment: null,
      priorPostedFindings,
      headSha: "sha1"
    });

    expect(plan.summaryBody.length).toBeLessThanOrEqual(65_536);
    expect(plan.summaryBody.startsWith(REVIEW_MARKER)).toBe(true);
    expect(plan.summaryBody).toContain("summary");
    expect(plan.state.postedFindings.length).toBeLessThan(priorPostedFindings.length);
    expect(plan.state.postedFindings.at(-1)).toBe(priorPostedFindings.at(-1));
    expect(plan.state.postedFindings).not.toContain(priorPostedFindings[0]);
    expect(parseState(plan.summaryBody)).toEqual(plan.state);
  });
});

describe("hasActiveRequestChanges", () => {
  it("treats a bot request-changes review as active even after a later comment", async () => {
    const { octokit } = mockOctokit([], [], "github-actions[bot]", [
      { state: "CHANGES_REQUESTED", user: { login: "github-actions[bot]" } },
      { state: "COMMENTED", user: { login: "github-actions[bot]" } }
    ]);

    await expect(hasActiveRequestChanges(octokit, ref)).resolves.toEqual({ active: true, truncated: false });
  });

  it("treats a later bot approval as clearing a prior request-changes review", async () => {
    const { octokit } = mockOctokit([], [], "github-actions[bot]", [
      { state: "REQUEST_CHANGES", user: { login: "github-actions[bot]" } },
      { state: "APPROVED", user: { login: "github-actions[bot]" } }
    ]);

    await expect(hasActiveRequestChanges(octokit, ref)).resolves.toEqual({ active: false, truncated: false });
  });

  it("ignores review states from other users", async () => {
    const { octokit } = mockOctokit([], [], "github-actions[bot]", [
      { state: "CHANGES_REQUESTED", user: { login: "reviewer" } }
    ]);

    await expect(hasActiveRequestChanges(octokit, ref)).resolves.toEqual({ active: false, truncated: false });
  });

  it("reports an incomplete answer when review history hits the pagination cap", async () => {
    const reviews = Array.from({ length: 1000 }, () => ({
      state: "COMMENTED",
      user: { login: "github-actions[bot]" }
    }));
    const { octokit, listReviews } = mockOctokit([], [], "github-actions[bot]", reviews);

    await expect(hasActiveRequestChanges(octokit, ref)).resolves.toEqual({ active: false, truncated: true });
    expect(listReviews).toHaveBeenCalledTimes(10);
  });
});

describe("fetchReviewCommentBody", () => {
  it("fetches and trims an inline review comment body", async () => {
    const { octokit, getReviewComment } = mockOctokit();
    getReviewComment.mockResolvedValueOnce({ data: { body: "  root finding  " } });

    await expect(fetchReviewCommentBody(octokit, ref, 321)).resolves.toBe("root finding");
    expect(getReviewComment).toHaveBeenCalledWith({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: 321
    });
  });

  it("returns undefined when the review comment cannot be read", async () => {
    const { octokit, getReviewComment } = mockOctokit();
    getReviewComment.mockRejectedValueOnce(new Error("missing"));

    await expect(fetchReviewCommentBody(octokit, ref, 321)).resolves.toBeUndefined();
  });
});

describe("submitReview", () => {
  it("seeds the summary before the review on a first run so it sits above the findings", async () => {
    const { octokit, createComment, updateComment, createReview } = mockOctokit([]);
    await submitReview(octokit, ref, payload(), { commitId: "head", headSha: "head" });

    // Order: seed summary (earlier timestamp → above the review) → post review →
    // update the summary with the posted fingerprints (#22 ordering / #12 marker).
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.invocationCallOrder[0]).toBeLessThan(createReview.mock.invocationCallOrder[0]);
    expect(createReview.mock.invocationCallOrder[0]).toBeLessThan(updateComment.mock.invocationCallOrder[0]);

    const review = createReview.mock.calls[0][0] as {
      commit_id?: string;
      event?: string;
      comments?: Array<Record<string, unknown>>;
      body?: string;
    };
    expect(review.commit_id).toBe("head");
    expect(review.event).toBe("COMMENT");
    // Self-contained findings summary (no "see the other comment" pointer) so the
    // review reads as a complete unit with its inline findings nested (CodeRabbit-style).
    expect(review.body).toContain("**prowl-review** flagged 1 finding");
    expect(review.body).toContain("🟠 1 major");
    expect(review.body).not.toContain("summary comment");
    expect(review.body).not.toContain(REVIEW_MARKER);
    expect(review.body).not.toContain("prowl-review:state");
    expect(review.comments).toHaveLength(1);
    expect(review.comments?.[0]).not.toHaveProperty("fingerprint"); // internal field stripped
    expect(review.comments?.[0]?.body).toContain("prowl-review:finding fp-a");

    // The seed records no reviewed SHA or posted fingerprints yet; the post-review
    // update writes the real marker.
    const seeded = createComment.mock.calls[0][0] as { body: string; issue_number: number };
    expect(seeded.issue_number).toBe(12);
    expect(seeded.body).toContain("prowl-review:state");
    const seedState = parseState(seeded.body);
    expect(seedState?.lastReviewedSha).toBeUndefined();
    expect(seedState?.postedFindings).toEqual([]);
    const updated = updateComment.mock.calls[0][0] as { comment_id: number; body: string };
    expect(updated.comment_id).toBe(9001); // the seeded comment's id (from mock createComment)
    expect(parseState(updated.body)).toEqual({
      v: 1,
      lastReviewedSha: "head",
      postedFindings: ["fp-a"]
    });
  });

  it("updates the prior summary in place and skips already-posted inline findings", async () => {
    const prior = {
      id: 77,
      body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`,
      user: { login: "github-actions[bot]" }
    };
    const { octokit, createComment, updateComment, createReview } = mockOctokit([prior]);
    await submitReview(octokit, ref, payload(), { commitId: "head2", headSha: "head2" });

    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect((updateComment.mock.calls[0][0] as { comment_id: number }).comment_id).toBe(77);
    // The single finding was already posted last push → no new inline comment.
    expect(createReview).not.toHaveBeenCalled();
  });

  it("preserves the prior summary when requested and still dedups inline findings", async () => {
    const prior = {
      id: 77,
      body: `${REVIEW_MARKER}\n## prowl-review\nold summary\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`,
      user: { login: "github-actions[bot]" }
    };
    const { octokit, createComment, updateComment, createReview } = mockOctokit([prior]);

    await submitReview(
      octokit,
      ref,
      payload({
        body: `${REVIEW_MARKER}\n## prowl-review\n\nnew delta summary`,
        comments: [comment({ fingerprint: "fp-a" }), comment({ fingerprint: "fp-b" })]
      }),
      { commitId: "head2", headSha: "head2", preservePriorSummary: true }
    );

    // A fresh summary is seeded + updated; the prior summary (id 77) is left untouched.
    expect(createReview).toHaveBeenCalledTimes(1);
    const review = createReview.mock.calls[0][0] as { comments?: Array<{ body?: string }> };
    expect(review.comments).toHaveLength(1);
    expect(review.comments?.[0]?.body).toContain("prowl-review:finding fp-b");
    expect(createComment).toHaveBeenCalledTimes(1);
    const created = createComment.mock.calls[0][0] as { body: string };
    expect(created.body).toContain("new delta summary");
    expect(parseState(created.body)?.lastReviewedSha).toBeUndefined();
    expect(updateComment).toHaveBeenCalledTimes(1);
    const updated = updateComment.mock.calls[0][0] as { comment_id: number; body: string };
    expect(updated.comment_id).not.toBe(77); // the seeded fresh comment, not the preserved prior
    expect(parseState(updated.body)).toEqual({
      v: 1,
      lastReviewedSha: "head2",
      postedFindings: ["fp-a", "fp-b"]
    });
  });

  it("creates the final summary directly on a first comment run with no inline findings", async () => {
    const { octokit, createComment, updateComment, createReview } = mockOctokit([]);

    await submitReview(octokit, ref, payload({ comments: [] }), { headSha: "head-empty" });

    expect(createReview).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(parseState((createComment.mock.calls[0][0] as { body: string }).body)).toEqual({
      v: 1,
      lastReviewedSha: "head-empty",
      postedFindings: []
    });
  });

  it("updates the summary even when there are no new inline findings", async () => {
    const prior = {
      id: 77,
      body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`,
      user: { login: "github-actions[bot]" }
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

  it("preserves paused state when refreshing the summary", async () => {
    const prior = {
      id: 77,
      body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, paused: true, postedFindings: ["fp-a"] })}`,
      user: { login: "github-actions[bot]" }
    };
    const { octokit, updateComment } = mockOctokit([prior]);

    await submitReview(
      octokit,
      ref,
      payload({ body: `${REVIEW_MARKER}\n## prowl-review\n\nmanual review`, comments: [] }),
      { headSha: "head-paused" }
    );

    expect(parseState((updateComment.mock.calls[0][0] as { body: string }).body)).toEqual({
      v: 1,
      lastReviewedSha: "head-paused",
      paused: true,
      postedFindings: ["fp-a"]
    });
  });

  it("re-reads the summary before updating so a concurrent pause is preserved", async () => {
    const prior = {
      id: 77,
      body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`,
      user: { login: "github-actions[bot]" }
    };
    const pausedPrior = {
      id: 77,
      body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, paused: true, postedFindings: ["fp-a"] })}`,
      user: { login: "github-actions[bot]" }
    };
    const { octokit, listComments, updateComment } = mockOctokit([]);
    listComments.mockResolvedValueOnce({ data: [prior] }).mockResolvedValueOnce({ data: [pausedPrior] });

    await submitReview(
      octokit,
      ref,
      payload({ body: `${REVIEW_MARKER}\n## prowl-review\n\nslow review`, comments: [] }),
      { headSha: "head-after-pause" }
    );

    expect(listComments).toHaveBeenCalledTimes(2);
    expect(parseState((updateComment.mock.calls[0][0] as { body: string }).body)).toEqual({
      v: 1,
      lastReviewedSha: "head-after-pause",
      paused: true,
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

    await expect(submitReview(octokit, ref, payload(), { commitId: "head", headSha: "head" })).rejects.toThrow(
      "github unavailable"
    );

    // The summary is seeded before the review, but with NO posted fingerprints, so a
    // failed review never persists a reviewed SHA or fingerprints for comments that
    // don't exist (#12).
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(parseState((createComment.mock.calls[0][0] as { body: string }).body)).toEqual({
      v: 1,
      postedFindings: []
    });
    expect(updateComment).not.toHaveBeenCalled();
  });

  it("cancels before the first publish write when the publish guard fails", async () => {
    const { octokit, createComment, updateComment, createReview } = mockOctokit([]);
    const shouldPublish = vi.fn(async () => false);

    const result = await submitReview(octokit, ref, payload(), {
      commitId: "head",
      headSha: "head",
      shouldPublish
    });

    expect(result).toEqual({ posted: false, cancelled: true });
    expect(shouldPublish).toHaveBeenCalledTimes(1);
    expect(createReview).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
  });

  it("re-checks the publish guard after the summary re-read", async () => {
    const { octokit, listComments, createComment, updateComment, createReview } = mockOctokit([]);
    // Three guard passes now: seed summary, post review, then the final summary write.
    const shouldPublish = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await submitReview(octokit, ref, payload(), {
      commitId: "head",
      headSha: "head",
      shouldPublish
    });

    expect(result).toEqual({ posted: true, cancelled: true });
    expect(shouldPublish).toHaveBeenCalledTimes(3);
    expect(listComments).toHaveBeenCalledTimes(2);
    expect(listComments.mock.invocationCallOrder[1]).toBeLessThan(shouldPublish.mock.invocationCallOrder[2]);
    // Summary seeded + review posted on the first two guard passes; the final summary
    // write (update) is cancelled on the third.
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledTimes(1); // the seed
    expect(updateComment).not.toHaveBeenCalled();
  });

  it("does not trust marker comments from other users", async () => {
    const untrusted = {
      id: 88,
      body: `${REVIEW_MARKER}\n## fake\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`,
      user: { login: "attacker" }
    };
    const { octokit, createComment, updateComment, createReview } = mockOctokit([untrusted]);

    await submitReview(octokit, ref, payload());

    expect(updateComment).not.toHaveBeenCalled();
    expect(createReview).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(parseState((createComment.mock.calls[0][0] as { body: string }).body)?.postedFindings).toEqual([]);
  });

  it("falls back to a fresh summary when the login cannot be resolved outside Actions", async () => {
    // No override, no PROWL_BOT_LOGIN, not in Actions → login is genuinely
    // unresolved, so there's no prior to find and a fresh summary is created.
    const savedActions = process.env.GITHUB_ACTIONS;
    const savedLogin = process.env.PROWL_BOT_LOGIN;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.PROWL_BOT_LOGIN;
    try {
      const prior = {
        id: 77,
        body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`,
        user: { login: "github-actions[bot]" }
      };
      const { octokit, createComment, getAuthenticated, updateComment } = mockOctokit([prior]);
      getAuthenticated.mockRejectedValueOnce(new Error("auth unavailable"));

      await submitReview(octokit, ref, payload());

      expect(getAuthenticated).toHaveBeenCalledTimes(1);
      expect(updateComment).not.toHaveBeenCalled();
      expect(createComment).toHaveBeenCalledTimes(1);
      expect(parseState((createComment.mock.calls[0][0] as { body: string }).body)?.postedFindings).toEqual([]);
    } finally {
      if (savedActions === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = savedActions;
      if (savedLogin === undefined) delete process.env.PROWL_BOT_LOGIN;
      else process.env.PROWL_BOT_LOGIN = savedLogin;
    }
  });

  it("resolves to github-actions[bot] and updates the prior summary in place inside Actions", async () => {
    // The Actions GITHUB_TOKEN can't resolve its login via GET /user; the fix
    // falls back to github-actions[bot] so the prior summary is found + edited
    // instead of duplicated (#22 dedup regression).
    const savedActions = process.env.GITHUB_ACTIONS;
    const savedLogin = process.env.PROWL_BOT_LOGIN;
    process.env.GITHUB_ACTIONS = "true";
    delete process.env.PROWL_BOT_LOGIN;
    try {
      const prior = {
        id: 77,
        body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, postedFindings: [] })}`,
        user: { login: "github-actions[bot]" }
      };
      const { octokit, createComment, updateComment, getAuthenticated } = mockOctokit([prior]);
      getAuthenticated.mockRejectedValue(new Error("Resource not accessible by integration"));

      await submitReview(octokit, ref, payload({ comments: [] }));

      expect(updateComment).toHaveBeenCalledTimes(1);
      expect(updateComment.mock.calls[0][0]).toMatchObject({ comment_id: 77 });
      expect(createComment).not.toHaveBeenCalled();
    } finally {
      if (savedActions === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = savedActions;
      if (savedLogin === undefined) delete process.env.PROWL_BOT_LOGIN;
      else process.env.PROWL_BOT_LOGIN = savedLogin;
    }
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
        body: expect.stringContaining("requested changes")
      })
    );
    expect(createReview.mock.calls[0][0]).not.toHaveProperty("comments");
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it("carries inline findings on the verdict review for a non-comment event", async () => {
    const { octokit, createComment, createReview } = mockOctokit([]);
    await submitReview(
      octokit,
      ref,
      payload({ event: "REQUEST_CHANGES", comments: [comment()] }),
      { commitId: "head", headSha: "head" }
    );

    // One review carries both the verdict and the inline findings (no quiet
    // individual posting on the verdict path).
    expect(createReview).toHaveBeenCalledTimes(1);
    const review = createReview.mock.calls[0][0] as { event?: string; body?: string; comments?: unknown[] };
    expect(review.event).toBe("REQUEST_CHANGES");
    expect(review.body).toContain("requested changes");
    expect(review.body).toContain("**prowl-review** flagged 1 finding");
    expect(review.comments).toHaveLength(1);
    expect(review.body).not.toContain(REVIEW_MARKER);
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it("summarizes current findings on a verdict review when some inline findings are already posted", async () => {
    const prior = {
      id: 77,
      body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`,
      user: { login: "github-actions[bot]" }
    };
    const { octokit, createReview } = mockOctokit([prior]);

    await submitReview(
      octokit,
      ref,
      payload({
        event: "REQUEST_CHANGES",
        comments: [comment(), comment({ fingerprint: "fp-b", severity: "critical" })]
      }),
      { commitId: "head", headSha: "head" }
    );

    expect(createReview).toHaveBeenCalledTimes(1);
    const review = createReview.mock.calls[0][0] as { body?: string; comments?: unknown[] };
    expect(review.body).toContain("requested changes");
    expect(review.body).toContain("**prowl-review** flagged 2 findings");
    expect(review.body).toContain("### Review details");
    expect(review.comments).toHaveLength(1);
    expect(JSON.stringify(review.comments?.[0])).toContain("fp-b");
  });

  it("includes summary details on request-changes reviews with no inline comments", async () => {
    const { octokit, createReview } = mockOctokit([]);

    await submitReview(
      octokit,
      ref,
      payload({
        event: "REQUEST_CHANGES",
        comments: [],
        body:
          `${REVIEW_MARKER}\n## prowl-review\n\n### Findings\n\n` +
          "| Severity | Location | Finding |\n" +
          "| :-- | :-- | :-- |\n" +
          "| 🟠 major | package-lock.json | **Known vulnerable dependency** |\n\n" +
          serializeState({ v: 1, postedFindings: [] })
      }),
      { commitId: "head", headSha: "head" }
    );

    expect(createReview).toHaveBeenCalledTimes(1);
    const review = createReview.mock.calls[0][0] as { body?: string; comments?: unknown[] };
    expect(review.body).toContain("requested changes");
    expect(review.body).toContain("### Review details");
    expect(review.body).toContain("Known vulnerable dependency");
    expect(review.body).not.toContain("prowl-review:summary");
    expect(review.body).not.toContain("prowl-review:state");
    expect(review.comments).toBeUndefined();
  });

  it("includes summary details when exactly one finding overflows the inline cap", async () => {
    const { octokit, createReview } = mockOctokit([]);

    await submitReview(
      octokit,
      ref,
      payload({
        event: "REQUEST_CHANGES",
        comments: [comment()],
        body: `${REVIEW_MARKER}\n## prowl-review\n\n## 1 more finding (inline comment cap: 1)\n\nsrc/b.ts:8 — Overflow`
      }),
      { commitId: "head", headSha: "head" }
    );

    expect(createReview).toHaveBeenCalledTimes(1);
    const review = createReview.mock.calls[0][0] as { body?: string; comments?: unknown[] };
    expect(review.body).toContain("**prowl-review** flagged 1 finding");
    expect(review.body).toContain("### Review details");
    expect(review.body).toContain("1 more finding (inline comment cap: 1)");
    expect(review.comments).toHaveLength(1);
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

    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({ sort: "created", direction: "desc" })
    );
    expect(listComments).toHaveBeenCalledTimes(2);
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect((updateComment.mock.calls[0][0] as { comment_id: number }).comment_id).toBe(201);
  });

  it("caps each prior summary scan to avoid unbounded pagination", async () => {
    const filler = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, body: "noise" }));
    const priorBeforeCap = {
      id: 1001,
      body: `${REVIEW_MARKER}\n## prowl-review\n${serializeState({ v: 1, postedFindings: ["fp-a"] })}`,
      user: { login: "github-actions[bot]" }
    };
    const { octokit, listComments, createComment, updateComment, createReview } = mockOctokit([
      priorBeforeCap,
      ...filler
    ]);

    await submitReview(octokit, ref, payload());

    expect(listComments).toHaveBeenCalledTimes(20);
    expect(updateComment).not.toHaveBeenCalled();
    expect(createReview).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it("recovers posted fingerprints from prior bot inline comments when summary state is stale", async () => {
    const { octokit, createComment, createReview } = mockOctokit(
      [],
      [{ body: "old inline\n\n<!-- prowl-review:finding fp-a -->", user: { login: "github-actions[bot]" } }]
    );

    await submitReview(octokit, ref, payload(), { commitId: "head", headSha: "head" });

    expect(createReview).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(parseState((createComment.mock.calls[0][0] as { body: string }).body)).toEqual({
      v: 1,
      lastReviewedSha: "head",
      postedFindings: ["fp-a"]
    });
  });

  it("paginates when recovering fingerprints from prior bot inline comments", async () => {
    const filler = Array.from({ length: 100 }, () => ({
      body: "noise",
      user: { login: "github-actions[bot]" }
    }));
    const { octokit, createComment, createReview, listReviewComments } = mockOctokit(
      [],
      [...filler, { body: "old inline\n\n<!-- prowl-review:finding fp-a -->", user: { login: "github-actions[bot]" } }]
    );

    await submitReview(octokit, ref, payload(), { commitId: "head", headSha: "head" });

    expect(listReviewComments).toHaveBeenCalledTimes(2);
    expect(createReview).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(parseState((createComment.mock.calls[0][0] as { body: string }).body)?.postedFindings).toEqual([
      "fp-a"
    ]);
  });

  it("caps prior inline fingerprint recovery to avoid unbounded pagination", async () => {
    const filler = Array.from({ length: 1000 }, () => ({
      body: "noise",
      user: { login: "github-actions[bot]" }
    }));
    const { octokit, createComment, updateComment, createReview, listReviewComments } = mockOctokit(
      [],
      [...filler, { body: "old inline\n\n<!-- prowl-review:finding fp-a -->", user: { login: "github-actions[bot]" } }]
    );

    await submitReview(octokit, ref, payload(), { commitId: "head", headSha: "head" });

    expect(listReviewComments).toHaveBeenCalledTimes(10);
    // Recovery caps before reaching fp-a (page 11), so it posts as net-new: the
    // summary is seeded (empty marker), the review posts, then the marker is updated.
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(parseState((updateComment.mock.calls[0][0] as { body: string }).body)?.postedFindings).toEqual([
      "fp-a"
    ]);
  });
});

describe("setPausedState (#26)", () => {
  it("sets paused in the existing summary marker, preserving prior state", async () => {
    const prior = `${REVIEW_MARKER}\n\nsummary\n\n${serializeState({
      v: 1,
      lastReviewedSha: "abc",
      ignoredFindings: ["fp-muted"],
      postedFindings: ["fp-a"]
    })}`;
    const { octokit, updateComment, createComment } = mockOctokit([
      { id: 5, body: prior, user: { login: "github-actions[bot]" } }
    ]);
    const result = await setPausedState(octokit, ref, true);
    expect(result.updatedExisting).toBe(true);
    expect(createComment).not.toHaveBeenCalled();
    const state = parseState((updateComment.mock.calls[0][0] as { body: string }).body);
    expect(state?.paused).toBe(true);
    expect(state?.lastReviewedSha).toBe("abc"); // preserved
    expect(state?.ignoredFindings).toEqual(["fp-muted"]); // preserved
    expect(state?.postedFindings).toEqual(["fp-a"]); // preserved
  });

  it("creates a marked comment when no summary exists yet", async () => {
    const { octokit, createComment, updateComment } = mockOctokit([]);
    const result = await setPausedState(octokit, ref, true);
    expect(result.updatedExisting).toBe(false);
    expect(updateComment).not.toHaveBeenCalled();
    const body = (createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain(REVIEW_MARKER);
    expect(parseState(body)?.paused).toBe(true);
  });

  it("clears paused on resume", async () => {
    const prior = `${REVIEW_MARKER}\n\nsummary\n\n${serializeState({ v: 1, paused: true, postedFindings: [] })}`;
    const { octokit, updateComment } = mockOctokit([{ id: 5, body: prior, user: { login: "github-actions[bot]" } }]);
    await setPausedState(octokit, ref, false);
    expect(parseState((updateComment.mock.calls[0][0] as { body: string }).body)?.paused).toBe(false);
  });
});

describe("replyToReviewComment (#27)", () => {
  it("posts an inline review-thread reply with the expected GitHub parameters", async () => {
    const { octokit, createReplyForReviewComment } = mockOctokit([]);

    await replyToReviewComment(octokit, ref, 444, "Answer body");

    expect(createReplyForReviewComment).toHaveBeenCalledWith({
      owner: "prowl-tools",
      repo: "prowl-code-review",
      pull_number: 12,
      comment_id: 444,
      body: "Answer body"
    });
  });
});

describe("setIgnoredFindings (#30)", () => {
  it("merges fingerprints into the existing summary state marker", async () => {
    const prior = `${REVIEW_MARKER}\n\nsummary\n\n${serializeState({
      v: 1,
      lastReviewedSha: "abc",
      ignoredFindings: ["fp-old"],
      postedFindings: ["fp-a"]
    })}`;
    const { octokit, updateComment, createComment } = mockOctokit([
      { id: 5, body: prior, user: { login: "github-actions[bot]" } }
    ]);
    const result = await setIgnoredFindings(octokit, ref, ["fp-new", "fp-old"]);
    expect(result.added).toBe(1); // fp-new is new; fp-old already present
    expect(createComment).not.toHaveBeenCalled();
    const state = parseState((updateComment.mock.calls[0][0] as { body: string }).body);
    expect(state?.ignoredFindings?.sort()).toEqual(["fp-new", "fp-old"]);
    expect(state?.lastReviewedSha).toBe("abc"); // preserved
    expect(state?.postedFindings).toEqual(["fp-a"]); // preserved
  });

  it("creates a marked comment when no summary exists yet", async () => {
    const { octokit, createComment, updateComment } = mockOctokit([]);
    const result = await setIgnoredFindings(octokit, ref, ["fp-1"]);
    expect(result.total).toBe(1);
    expect(updateComment).not.toHaveBeenCalled();
    const body = (createComment.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain(REVIEW_MARKER);
    expect(parseState(body)?.ignoredFindings).toEqual(["fp-1"]);
  });
});

describe("fetchReviewCommentFingerprints (#30)", () => {
  it("recovers the finding fingerprint embedded in the comment body", async () => {
    const { octokit, getReviewComment } = mockOctokit();
    getReviewComment.mockResolvedValueOnce({
      data: { body: "Finding text\n<!-- prowl-review:finding fp-xyz -->" }
    });
    expect(await fetchReviewCommentFingerprints(octokit, ref, 100)).toEqual(["fp-xyz"]);
  });

  it("returns [] when the comment carries no marker", async () => {
    const { octokit, getReviewComment } = mockOctokit();
    getReviewComment.mockResolvedValueOnce({ data: { body: "just a human reply" } });
    expect(await fetchReviewCommentFingerprints(octokit, ref, 100)).toEqual([]);
  });
});

describe("getAuthenticatedLogin (#22 dedup on the Actions token)", () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PROWL_BOT_LOGIN;
    delete process.env.GITHUB_ACTIONS;
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  function octokitGetUser(impl: () => Promise<{ data: { login?: string } }>): OctokitLike {
    return { rest: { users: { getAuthenticated: vi.fn(impl) } } } as unknown as OctokitLike;
  }

  it("prefers an explicit override", async () => {
    const octokit = octokitGetUser(async () => ({ data: { login: "x" } }));
    expect(await getAuthenticatedLogin(octokit, "my-app[bot]")).toBe("my-app[bot]");
  });

  it("prefers GET /user over PROWL_BOT_LOGIN when the token identifies itself", async () => {
    process.env.PROWL_BOT_LOGIN = "github-actions[bot]";
    const getAuth = vi.fn(async () => ({ data: { login: "real-user" } }));
    const octokit = { rest: { users: { getAuthenticated: getAuth } } } as unknown as OctokitLike;
    expect(await getAuthenticatedLogin(octokit)).toBe("real-user");
    expect(getAuth).toHaveBeenCalledTimes(1);
  });

  it("uses PROWL_BOT_LOGIN as a hint when a custom GitHub App token cannot resolve itself", async () => {
    process.env.PROWL_BOT_LOGIN = "my-app[bot]";
    process.env.GITHUB_ACTIONS = "true";
    const octokit = octokitGetUser(async () => {
      throw new Error("Resource not accessible by integration");
    });
    expect(await getAuthenticatedLogin(octokit)).toBe("my-app[bot]");
  });

  it("falls back to GET /user for a PAT", async () => {
    const octokit = octokitGetUser(async () => ({ data: { login: "real-user" } }));
    expect(await getAuthenticatedLogin(octokit)).toBe("real-user");
  });

  it("falls back to github-actions[bot] when GET /user 403s inside Actions", async () => {
    process.env.GITHUB_ACTIONS = "true";
    const octokit = octokitGetUser(async () => {
      throw new Error("Resource not accessible by integration");
    });
    expect(await getAuthenticatedLogin(octokit)).toBe("github-actions[bot]");
  });

  it("returns undefined when GET /user fails outside Actions", async () => {
    const octokit = octokitGetUser(async () => {
      throw new Error("403");
    });
    expect(await getAuthenticatedLogin(octokit)).toBeUndefined();
  });
});

describe("setConfigOverrides (#26)", () => {
  it("merges overrides into the existing summary state, preserving other fields", async () => {
    const prior = `${REVIEW_MARKER}\n\nsummary\n\n${serializeState({
      v: 1,
      lastReviewedSha: "abc",
      paused: true,
      ignoredFindings: ["fp-muted"],
      configOverrides: { minSeverity: "minor" },
      postedFindings: ["fp-a"]
    })}`;
    const { octokit, updateComment, createComment } = mockOctokit([
      { id: 5, body: prior, user: { login: "github-actions[bot]" } }
    ]);

    const result = await setConfigOverrides(octokit, ref, { overrides: { maxFindings: 10, minSeverity: "major" } });

    expect(result.overrides).toEqual({ minSeverity: "major", maxFindings: 10 });
    expect(createComment).not.toHaveBeenCalled();
    const updated = updateComment.mock.calls[0][0] as { comment_id: number; body: string };
    expect(updated.comment_id).toBe(5);
    expect(parseState(updated.body)).toEqual({
      v: 1,
      lastReviewedSha: "abc",
      paused: true,
      ignoredFindings: ["fp-muted"],
      configOverrides: { minSeverity: "major", maxFindings: 10 },
      postedFindings: ["fp-a"]
    });
  });

  it("clears overrides on reset while preserving the rest of the state", async () => {
    const prior = `${REVIEW_MARKER}\n\nsummary\n\n${serializeState({
      v: 1,
      ignoredFindings: ["fp-muted"],
      configOverrides: { minSeverity: "major", verify: false },
      postedFindings: ["fp-a"]
    })}`;
    const { octokit, updateComment } = mockOctokit([{ id: 5, body: prior, user: { login: "github-actions[bot]" } }]);

    const result = await setConfigOverrides(octokit, ref, { reset: true });

    expect(result.overrides).toBeUndefined();
    const updated = updateComment.mock.calls[0][0] as { body: string };
    const state = parseState(updated.body);
    expect(state?.configOverrides).toBeUndefined();
    expect(state?.ignoredFindings).toEqual(["fp-muted"]); // unrelated state preserved
  });

  it("creates a marked summary when none exists yet", async () => {
    const { octokit, createComment, updateComment } = mockOctokit([]);
    const result = await setConfigOverrides(octokit, ref, { overrides: { minSeverity: "major" } });
    expect(updateComment).not.toHaveBeenCalled();
    const created = createComment.mock.calls[0][0] as { body: string };
    expect(parseState(created.body)?.configOverrides).toEqual({ minSeverity: "major" });
    expect(result.overrides).toEqual({ minSeverity: "major" });
  });

  it("preserves state from a minimal summary created by other command state writes", async () => {
    const paused = mockOctokit([]);
    await setPausedState(paused.octokit, ref, true);
    const pausedBody = (paused.createComment.mock.calls[0][0] as { body: string }).body;

    const ignored = mockOctokit([{ id: 5, body: pausedBody, user: { login: "github-actions[bot]" } }]);
    await setIgnoredFindings(ignored.octokit, ref, ["fp-muted"]);
    const ignoredBody = (ignored.updateComment.mock.calls[0][0] as { body: string }).body;

    const configured = mockOctokit([{ id: 5, body: ignoredBody, user: { login: "github-actions[bot]" } }]);
    await setConfigOverrides(configured.octokit, ref, { overrides: { verify: false } });

    const finalState = parseState((configured.updateComment.mock.calls[0][0] as { body: string }).body);
    expect(finalState?.paused).toBe(true);
    expect(finalState?.ignoredFindings).toEqual(["fp-muted"]);
    expect(finalState?.configOverrides).toEqual({ verify: false });
  });
});

describe("config overrides survive other state writes (#26)", () => {
  const overrides = { minSeverity: "major" as const };

  it("planPublish carries forward configOverrides on a normal review", () => {
    const prior = {
      id: 9,
      body: `${REVIEW_MARKER}\n${serializeState({ v: 1, configOverrides: overrides, postedFindings: [] })}`
    };
    const plan = planPublish({ payload: payload(), priorComment: prior, headSha: "sha2" });
    expect(plan.state.configOverrides).toEqual(overrides);
  });

  it("setPausedState preserves configOverrides", async () => {
    const prior = `${REVIEW_MARKER}\n${serializeState({ v: 1, configOverrides: overrides, postedFindings: ["fp-a"] })}`;
    const { octokit, updateComment } = mockOctokit([{ id: 5, body: prior, user: { login: "github-actions[bot]" } }]);
    await setPausedState(octokit, ref, true);
    expect(parseState((updateComment.mock.calls[0][0] as { body: string }).body)?.configOverrides).toEqual(overrides);
  });

  it("setIgnoredFindings preserves configOverrides", async () => {
    const prior = `${REVIEW_MARKER}\n${serializeState({ v: 1, configOverrides: overrides, postedFindings: [] })}`;
    const { octokit, updateComment } = mockOctokit([{ id: 5, body: prior, user: { login: "github-actions[bot]" } }]);
    await setIgnoredFindings(octokit, ref, ["fp-x"]);
    expect(parseState((updateComment.mock.calls[0][0] as { body: string }).body)?.configOverrides).toEqual(overrides);
  });
});

type MockRepoIssue = {
  number: number;
  title?: string;
  body?: string | null;
  user?: { login?: string } | null;
  pull_request?: unknown;
};

function mockLearningsOctokit(issues: MockRepoIssue[] = [], login = "github-actions[bot]") {
  const listForRepo = vi.fn(async (params: { per_page?: number; page?: number; creator?: string }) => {
    const perPage = params.per_page ?? 30;
    const page = params.page ?? 1;
    const filtered = params.creator ? issues.filter((issue) => issue.user?.login === params.creator) : issues;
    const start = (page - 1) * perPage;
    return { data: filtered.slice(start, start + perPage) };
  });
  const create = vi.fn(async () => ({ data: { number: 4242 } }));
  const update = vi.fn(async () => ({ data: {} }));
  const getReviewComment = vi.fn(async () => ({ data: { body: "" } }));
  const getAuthenticated = vi.fn(async () => ({ data: { login } }));
  const octokit = {
    rest: {
      issues: { listForRepo, create, update },
      pulls: { getReviewComment },
      users: { getAuthenticated }
    }
  } as unknown as OctokitLike;
  return { octokit, listForRepo, create, update, getReviewComment, getAuthenticated };
}

describe("repo-wide learnings store (#30)", () => {
  const issueWith = (patterns: Array<{ fp: string; label?: string }>, over: Partial<MockRepoIssue> = {}): MockRepoIssue => ({
    number: 7,
    title: LEARNINGS_ISSUE_TITLE,
    body: renderLearningsIssueBody({ v: 1, patterns }),
    user: { login: "github-actions[bot]" },
    ...over
  });

  it("fetchRepoLearnings returns the muted fingerprints from the open store issue", async () => {
    const { octokit } = mockLearningsOctokit([issueWith([{ fp: "aaaa", label: "A" }, { fp: "bbbb" }])]);
    expect(await fetchRepoLearnings(octokit, ref)).toEqual(["aaaa", "bbbb"]);
  });

  it("fetchRepoLearnings ignores pull requests and unmarked issues", async () => {
    const { octokit } = mockLearningsOctokit([
      { number: 1, body: "a PR body", user: { login: "github-actions[bot]" }, pull_request: {} },
      { number: 2, body: "unrelated issue", user: { login: "github-actions[bot]" } }
    ]);
    expect(await fetchRepoLearnings(octokit, ref)).toEqual([]);
  });

  it("fetchRepoLearnings is tolerant of API errors", async () => {
    const { octokit, listForRepo } = mockLearningsOctokit([]);
    listForRepo.mockRejectedValueOnce(new Error("boom"));
    expect(await fetchRepoLearnings(octokit, ref)).toEqual([]);
  });

  it("recordRepoLearnings creates the store issue when none exists", async () => {
    const { octokit, create, update } = mockLearningsOctokit([]);
    const { added } = await recordRepoLearnings(octokit, ref, [{ fp: "aaaa", label: "Null deref" }]);
    expect(added).toBe(1);
    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const body = (create.mock.calls[0][0] as { title: string; body: string }).body;
    expect(parseLearnings(body)?.patterns).toEqual([{ fp: "aaaa", label: "Null deref" }]);
    expect((create.mock.calls[0][0] as { title: string }).title).toBe(LEARNINGS_ISSUE_TITLE);
  });

  it("recordRepoLearnings merges into an existing store issue in place", async () => {
    const { octokit, create, update } = mockLearningsOctokit([issueWith([{ fp: "aaaa", label: "A" }])]);
    const { added } = await recordRepoLearnings(octokit, ref, [
      { fp: "aaaa", label: "A" },
      { fp: "cccc", label: "C" }
    ]);
    expect(added).toBe(1);
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const call = update.mock.calls[0][0] as { issue_number: number; body: string };
    expect(call.issue_number).toBe(7);
    expect(learningFingerprints(parseLearnings(call.body))).toEqual(["aaaa", "cccc"]);
  });

  it("recordRepoLearnings is a no-op for empty entries", async () => {
    const { octokit, create, update, listForRepo } = mockLearningsOctokit([]);
    expect(await recordRepoLearnings(octokit, ref, [])).toEqual({ added: 0 });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(listForRepo).not.toHaveBeenCalled();
  });

  it("fetchReviewCommentLearningEntries recovers fingerprint + label from the comment", async () => {
    const { octokit, getReviewComment } = mockLearningsOctokit([]);
    getReviewComment.mockResolvedValueOnce({
      data: {
        body: "🟠 **[major] Off-by-one in loop bound**\n\nDetails…\n\n<!-- prowl-review:finding aaaa1111 -->"
      }
    });
    expect(await fetchReviewCommentLearningEntries(octokit, ref, 99)).toEqual([
      { fp: "aaaa1111", label: "Off-by-one in loop bound" }
    ]);
  });

  it("fetchReviewCommentLearningEntries falls back to a label-less entry", async () => {
    const { octokit, getReviewComment } = mockLearningsOctokit([]);
    getReviewComment.mockResolvedValueOnce({
      data: { body: "plain note\n\n<!-- prowl-review:finding bbbb2222 -->" }
    });
    expect(await fetchReviewCommentLearningEntries(octokit, ref, 99)).toEqual([{ fp: "bbbb2222" }]);
  });
});

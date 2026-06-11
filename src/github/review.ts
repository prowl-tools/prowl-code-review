import type { OctokitLike } from "./client.js";
import type { PullRequestRef } from "./diff.js";
import type { ReviewComment, ReviewPayload } from "../review/inline.js";
import { REVIEW_MARKER } from "../review/walkthrough.js";
import { embedState, parseState, REVIEW_STATE_VERSION, type ReviewState } from "../review/state.js";

/**
 * Publish the review with update-not-duplicate semantics (backlog #12 + #22).
 *
 * The summary is a single top-level PR comment carrying our hidden marker +
 * persisted state; on a re-run we find it and edit it **in place** instead of
 * stacking a new one. Inline findings are posted as review comments, deduped
 * against the fingerprints of findings already posted on a prior push (from the
 * marker state), so the same finding isn't repeated every push.
 *
 * The decision (`planPublish`) is pure and unit-tested; `submitReview` performs
 * the GitHub reads/writes. `octokit` is injectable for testing.
 */

/** A prior prowl-review summary comment found on the PR. */
export interface PriorSummaryComment {
  id: number;
  body: string;
}

/** The publish decision derived purely from the payload + prior state. */
export interface PublishPlan {
  /** Existing summary comment to edit in place, or undefined to create one. */
  priorCommentId?: number;
  /** Summary comment body with the refreshed state marker embedded. */
  summaryBody: string;
  /** Inline findings not already posted on a previous push. */
  newInlineComments: ReviewComment[];
  /** The state persisted in this run's summary marker. */
  state: ReviewState;
}

export interface SubmitReviewOptions {
  /** Head commit SHA used to anchor inline comments. */
  commitId?: string;
  /** Head SHA recorded as `lastReviewedSha` for incremental re-review (#23). */
  headSha?: string;
  /** Bot login used as a secondary check when matching our prior comment. */
  botLogin?: string;
}

/**
 * Decide what to publish: which inline findings are net-new, and the summary
 * body (with refreshed state) to create or update. Pure — no GitHub calls.
 */
export function planPublish(input: {
  payload: ReviewPayload;
  priorComment: PriorSummaryComment | null;
  headSha?: string;
  /** Inline comments known to have been posted; defaults to all net-new comments for pure planning. */
  postedInlineComments?: ReviewComment[];
}): PublishPlan {
  const priorState = parseState(input.priorComment?.body);
  const alreadyPosted = new Set(priorState?.postedFindings ?? []);

  const newInlineComments = input.payload.comments.filter(
    (comment) => !alreadyPosted.has(comment.fingerprint)
  );
  const postedInlineComments = input.postedInlineComments ?? newInlineComments;

  // Track only inline fingerprints that were actually posted, so failed/skipped
  // publishes are retried on the next run instead of disappearing from state.
  const postedFindings = [
    ...new Set([...(priorState?.postedFindings ?? []), ...postedInlineComments.map((c) => c.fingerprint)])
  ];

  const state: ReviewState = {
    v: REVIEW_STATE_VERSION,
    ...(input.headSha ? { lastReviewedSha: input.headSha } : {}),
    postedFindings
  };

  return {
    priorCommentId: input.priorComment?.id,
    summaryBody: embedState(input.payload.body, state),
    newInlineComments,
    state
  };
}

/** Find prowl-review's own prior summary comment by its hidden marker. */
async function findPriorSummary(
  octokit: OctokitLike,
  ref: PullRequestRef,
  botLogin?: string
): Promise<PriorSummaryComment | null> {
  const perPage = 100;
  const markerComments: Array<{ id: number; body?: string; user?: { login?: string } | null }> = [];
  let page = 1;

  for (;;) {
    const response = await octokit.rest.issues.listComments({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.pull_number,
      per_page: perPage,
      page
    });
    markerComments.push(
      ...response.data.filter((comment) => (comment.body ?? "").includes(REVIEW_MARKER))
    );

    if (response.data.length < perPage) {
      break;
    }
    page += 1;
  }

  if (markerComments.length === 0) {
    return null;
  }
  // Prefer one authored by our bot when a login is known; otherwise the most
  // recent marker comment (listComments returns ascending by creation).
  const botComments = botLogin
    ? markerComments.filter((comment) => comment.user?.login === botLogin)
    : [];
  const chosen = botComments.at(-1) ?? markerComments[markerComments.length - 1];
  return { id: chosen.id, body: chosen.body ?? "" };
}

/** Strip internal fields before sending an inline comment to GitHub. */
function toGitHubComment(comment: ReviewComment) {
  return {
    path: comment.path,
    body: comment.body,
    line: comment.line,
    side: comment.side,
    ...(comment.start_line !== undefined ? { start_line: comment.start_line } : {}),
    ...(comment.start_side !== undefined ? { start_side: comment.start_side } : {})
  };
}

function inlineBatchReviewBody(commentCount: number): string {
  const noun = commentCount === 1 ? "finding" : "findings";
  return `prowl-review posted ${commentCount} new inline ${noun}. See the summary comment for full review context.`;
}

/**
 * Publish (or update) the review on the PR. Edits the prior summary comment in
 * place when present, and posts only net-new inline findings.
 */
export async function submitReview(
  octokit: OctokitLike,
  ref: PullRequestRef,
  payload: ReviewPayload,
  options: SubmitReviewOptions = {}
): Promise<void> {
  const prior = await findPriorSummary(octokit, ref, options.botLogin);
  const initialPlan = planPublish({
    payload,
    priorComment: prior,
    headSha: options.headSha,
    postedInlineComments: []
  });

  let postedInlineComments: ReviewComment[] = [];
  const reviewComments = options.commitId ? initialPlan.newInlineComments.map(toGitHubComment) : [];
  const shouldCreateReview = payload.event !== "COMMENT" || reviewComments.length > 0;

  if (shouldCreateReview) {
    await octokit.rest.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      event: payload.event,
      ...(options.commitId ? { commit_id: options.commitId } : {}),
      body: payload.event === "COMMENT" ? inlineBatchReviewBody(reviewComments.length) : payload.body,
      ...(reviewComments.length > 0 ? { comments: reviewComments } : {})
    });
    postedInlineComments = reviewComments.length > 0 ? initialPlan.newInlineComments : [];
  }

  const finalPlan = planPublish({
    payload,
    priorComment: prior,
    headSha: options.headSha,
    postedInlineComments
  });

  // Summary: update in place, or create on the first run.
  if (finalPlan.priorCommentId !== undefined) {
    await octokit.rest.issues.updateComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: finalPlan.priorCommentId,
      body: finalPlan.summaryBody
    });
  } else {
    await octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.pull_number,
      body: finalPlan.summaryBody
    });
  }
}

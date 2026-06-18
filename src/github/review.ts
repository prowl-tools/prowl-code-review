import type { OctokitLike } from "./client.js";
import type { PullRequestRef } from "./diff.js";
import type { ReviewComment, ReviewEvent, ReviewPayload } from "../review/inline.js";
import { REVIEW_MARKER } from "../review/walkthrough.js";
import {
  embedStateWithFittedState,
  GITHUB_COMMENT_BODY_LIMIT,
  parseState,
  REVIEW_STATE_VERSION,
  type ReviewState
} from "../review/state.js";

/**
 * Publish the review with update-not-duplicate semantics (backlog #12 + #22).
 *
 * By default the summary is a single top-level PR comment carrying our hidden
 * marker + persisted state; on a re-run we find it and edit it **in place**
 * instead of stacking a new one. Incremental delta runs can opt into preserving
 * the prior visible summary by creating a fresh summary comment while still
 * carrying forward the hidden state used for deduplication. Inline findings are
 * posted as review comments, deduped against the fingerprints of findings
 * already posted on a prior push (from the marker state), so the same finding
 * isn't repeated every push.
 *
 * The decision (`planPublish`) is pure and unit-tested; `submitReview` performs
 * the GitHub reads/writes. `octokit` is injectable for testing.
 */

const MAX_SUMMARY_COMMENT_PAGES = 10;
const MAX_INLINE_COMMENT_PAGES = 10;
const MAX_REVIEW_PAGES = 10;
const INLINE_FINGERPRINT_PREFIX = "<!-- prowl-review:finding ";
const INLINE_FINGERPRINT_SUFFIX = " -->";
const INLINE_FINGERPRINT_RE = /<!-- prowl-review:finding ([A-Za-z0-9._:-]+) -->/g;

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
  /** Create a fresh summary comment so earlier visible findings remain on the PR. */
  preservePriorSummary?: boolean;
  /** Bot login used as a secondary check when matching our prior comment. */
  botLogin?: string;
}

/** Whether prowl-review has an active request-changes review, plus scan completeness. */
export interface PriorRequestChangesState {
  /** True only when a complete scan finds the latest decisive bot review requests changes. */
  active: boolean;
  /** True when the review history exceeded the pagination cap, making the answer incomplete. */
  truncated: boolean;
}

/**
 * Decide what to publish: which inline findings are net-new, and the summary
 * body (with refreshed state) to create or update. Pure — no GitHub calls.
 */
export function planPublish(input: {
  payload: ReviewPayload;
  priorComment: PriorSummaryComment | null;
  headSha?: string;
  /** Create a fresh summary comment instead of editing the prior one. */
  preservePriorSummary?: boolean;
  /** Fingerprints recovered from prior bot-authored inline comments. */
  priorPostedFindings?: string[];
  /** Inline comments known to have been posted; defaults to all net-new comments for pure planning. */
  postedInlineComments?: ReviewComment[];
}): PublishPlan {
  const priorState = parseState(input.priorComment?.body);
  const alreadyPosted = new Set([
    ...(priorState?.postedFindings ?? []),
    ...(input.priorPostedFindings ?? [])
  ]);

  const newInlineComments = input.payload.comments.filter(
    (comment) => !alreadyPosted.has(comment.fingerprint)
  );
  const postedInlineComments = input.postedInlineComments ?? newInlineComments;

  // Track only inline fingerprints that were actually posted, so failed/skipped
  // publishes are retried on the next run instead of disappearing from state.
  const postedFindings = [
    ...new Set([...alreadyPosted, ...postedInlineComments.map((c) => c.fingerprint)])
  ];

  const requestedState: ReviewState = {
    v: REVIEW_STATE_VERSION,
    ...(input.headSha ? { lastReviewedSha: input.headSha } : {}),
    postedFindings
  };
  const { body: summaryBody, state } = embedStateWithFittedState(
    input.payload.body,
    requestedState,
    GITHUB_COMMENT_BODY_LIMIT
  );

  return {
    priorCommentId: input.preservePriorSummary ? undefined : input.priorComment?.id,
    summaryBody,
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
  if (!botLogin) {
    return null;
  }

  const perPage = 100;
  let page = 1;

  for (;;) {
    const response = await octokit.rest.issues.listComments({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.pull_number,
      per_page: perPage,
      page,
      sort: "created",
      direction: "desc"
    });
    const chosen = response.data.find(
      (comment) => comment.user?.login === botLogin && (comment.body ?? "").includes(REVIEW_MARKER)
    );
    if (chosen) {
      return { id: chosen.id, body: chosen.body ?? "" };
    }

    if (response.data.length < perPage || page >= MAX_SUMMARY_COMMENT_PAGES) {
      break;
    }
    page += 1;
  }

  return null;
}

/**
 * Load the persisted review state from our prior summary comment (incremental
 * re-review, #23): resolve the bot login, find the marked comment, parse its
 * state. Returns null when there's no prior review (a fresh first run). Tolerant
 * — any read failure yields null so the run falls back to a full review.
 */
export async function fetchPriorReviewState(
  octokit: OctokitLike,
  ref: PullRequestRef,
  botLogin?: string
): Promise<ReviewState | null> {
  try {
    const login = await getAuthenticatedLogin(octokit, botLogin);
    const prior = await findPriorSummary(octokit, ref, login);
    return parseState(prior?.body);
  } catch {
    return null;
  }
}

/** Resolve the authenticated bot login used to trust prior prowl-review comments. */
export async function getAuthenticatedLogin(octokit: OctokitLike, botLogin?: string): Promise<string | undefined> {
  if (botLogin) {
    return botLogin;
  }

  try {
    const response = await octokit.rest.users.getAuthenticated();
    return response.data.login;
  } catch {
    return undefined;
  }
}

function isRequestChangesState(state: string | undefined): boolean {
  return state === "REQUEST_CHANGES" || state === "CHANGES_REQUESTED";
}

function isDecisiveReviewState(state: string | undefined): boolean {
  return isRequestChangesState(state) || state === "APPROVED" || state === "DISMISSED";
}

/**
 * Return true when the bot has an active request-changes review on the PR.
 * COMMENTED reviews do not clear GitHub's requested-changes state; a later
 * approval or dismissal does.
 */
export async function hasActiveRequestChanges(
  octokit: OctokitLike,
  ref: PullRequestRef,
  botLogin?: string
): Promise<PriorRequestChangesState> {
  try {
    const login = await getAuthenticatedLogin(octokit, botLogin);
    if (!login) {
      return { active: false, truncated: false };
    }

    const perPage = 100;
    let page = 1;
    let latestDecisiveState: string | undefined;
    let truncated = false;
    for (;;) {
      const response = await octokit.rest.pulls.listReviews({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.pull_number,
        per_page: perPage,
        page
      });

      for (const review of response.data) {
        if (review.user?.login === login && isDecisiveReviewState(review.state)) {
          latestDecisiveState = review.state;
        }
      }

      if (response.data.length < perPage) {
        break;
      }
      if (page >= MAX_REVIEW_PAGES) {
        truncated = true;
        break;
      }
      page += 1;
    }

    return { active: truncated ? false : isRequestChangesState(latestDecisiveState), truncated };
  } catch {
    return { active: false, truncated: false };
  }
}

/** Append a hidden fingerprint marker so posted inline comments can be recovered after summary-write failures. */
function appendInlineFingerprintMarker(body: string, fingerprint: string): string {
  return `${body.replace(INLINE_FINGERPRINT_RE, "").trimEnd()}\n\n${INLINE_FINGERPRINT_PREFIX}${fingerprint}${INLINE_FINGERPRINT_SUFFIX}`;
}

/** Extract hidden prowl-review fingerprints from an existing inline review comment body. */
export function parseInlineFingerprintMarkers(body: string | undefined): string[] {
  if (!body) {
    return [];
  }
  return [...body.matchAll(INLINE_FINGERPRINT_RE)].map((match) => match[1]);
}

/** List fingerprints already posted by this bot as inline review comments. */
async function listPriorInlineFingerprints(
  octokit: OctokitLike,
  ref: PullRequestRef,
  botLogin?: string
): Promise<string[]> {
  if (!botLogin) {
    return [];
  }

  const perPage = 100;
  const fingerprints: string[] = [];
  let page = 1;

  for (;;) {
    const response = await octokit.rest.pulls.listReviewComments({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      per_page: perPage,
      page
    });
    for (const comment of response.data) {
      if (comment.user?.login === botLogin) {
        fingerprints.push(...parseInlineFingerprintMarkers(comment.body));
      }
    }

    if (response.data.length < perPage || page >= MAX_INLINE_COMMENT_PAGES) {
      break;
    }
    page += 1;
  }

  return [...new Set(fingerprints)];
}

/** Strip internal fields before sending an inline comment to GitHub. */
function toGitHubComment(comment: ReviewComment) {
  return {
    path: comment.path,
    body: appendInlineFingerprintMarker(comment.body, comment.fingerprint),
    line: comment.line,
    side: comment.side,
    ...(comment.start_line !== undefined ? { start_line: comment.start_line } : {}),
    ...(comment.start_side !== undefined ? { start_side: comment.start_side } : {})
  };
}

/** Build the marker-free review body used when batching inline COMMENT reviews. */
function inlineBatchReviewBody(commentCount: number): string {
  const noun = commentCount === 1 ? "finding" : "findings";
  return `prowl-review posted ${commentCount} new inline ${noun}. The updatable summary comment has the full review context.`;
}

/**
 * Short body for an APPROVE/REQUEST_CHANGES review event (#52). The full
 * walkthrough lives in the updatable summary comment, so the event review just
 * carries the verdict + a pointer — never a second copy of the walkthrough.
 */
function eventReviewBody(event: ReviewEvent): string {
  if (event === "REQUEST_CHANGES") {
    return "prowl-review requested changes. See the prowl-review summary comment for the full review.";
  }
  if (event === "APPROVE") {
    return "prowl-review approved these changes. See the prowl-review summary comment for the full review.";
  }
  return "";
}

/**
 * Publish (or update) the review on the PR. Edits the prior summary comment in
 * place when present unless `preservePriorSummary` is requested, and posts only
 * net-new inline findings.
 */
export async function submitReview(
  octokit: OctokitLike,
  ref: PullRequestRef,
  payload: ReviewPayload,
  options: SubmitReviewOptions = {}
): Promise<void> {
  const botLogin = await getAuthenticatedLogin(octokit, options.botLogin);
  const [prior, priorPostedFindings] = await Promise.all([
    findPriorSummary(octokit, ref, botLogin),
    listPriorInlineFingerprints(octokit, ref, botLogin)
  ]);
  const initialPlan = planPublish({
    payload,
    priorComment: prior,
    headSha: options.headSha,
    preservePriorSummary: options.preservePriorSummary,
    priorPostedFindings,
    postedInlineComments: []
  });

  let postedInlineComments: ReviewComment[] = [];
  const reviewComments = options.commitId ? initialPlan.newInlineComments.map(toGitHubComment) : [];

  if (reviewComments.length > 0) {
    // Post before persisting fingerprints; otherwise a failed GitHub review
    // submission would suppress retries for inline comments that never existed.
    await octokit.rest.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      event: "COMMENT",
      ...(options.commitId ? { commit_id: options.commitId } : {}),
      body: inlineBatchReviewBody(reviewComments.length),
      comments: reviewComments
    });
    postedInlineComments = initialPlan.newInlineComments;
  }

  if (payload.event !== "COMMENT") {
    await octokit.rest.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      event: payload.event,
      ...(options.commitId ? { commit_id: options.commitId } : {}),
      body: eventReviewBody(payload.event)
    });
  }

  const finalPlan = planPublish({
    payload,
    priorComment: prior,
    headSha: options.headSha,
    preservePriorSummary: options.preservePriorSummary,
    priorPostedFindings,
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

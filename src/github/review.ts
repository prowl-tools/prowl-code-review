import type { OctokitLike } from "./client.js";
import type { PullRequestRef } from "./diff.js";
import type { ReviewComment, ReviewPayload } from "../review/inline.js";
import { buildPublishedReviewBody } from "../review/inline.js";
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
  /** Return false to cancel before a publish write, e.g. when the PR head advanced. */
  shouldPublish?: () => Promise<boolean>;
  /** Create a fresh summary comment so earlier visible findings remain on the PR. */
  preservePriorSummary?: boolean;
  /** Prior inline fingerprints to ignore because their old thread was resolved as fixed. */
  repostableFindings?: string[];
  /** Bot login used as a secondary check when matching our prior comment. */
  botLogin?: string;
}

export interface SubmitReviewResult {
  /** True when at least one GitHub publish mutation completed. */
  posted: boolean;
  /** True when `shouldPublish` cancelled before a pending publish mutation. */
  cancelled: boolean;
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
  /** Prior inline fingerprints to ignore because their old thread was resolved as fixed. */
  repostableFindings?: string[];
  /** Inline comments known to have been posted; defaults to all net-new comments for pure planning. */
  postedInlineComments?: ReviewComment[];
}): PublishPlan {
  const priorState = parseState(input.priorComment?.body);
  const repostable = new Set(input.repostableFindings ?? []);
  const alreadyPosted = new Set([
    ...(priorState?.postedFindings ?? []),
    ...(input.priorPostedFindings ?? [])
  ].filter((fingerprint) => !repostable.has(fingerprint)));

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
    ...(priorState?.paused !== undefined ? { paused: priorState.paused } : {}),
    ...(priorState?.ignoredFindings && priorState.ignoredFindings.length > 0
      ? { ignoredFindings: priorState.ignoredFindings }
      : {}),
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

/**
 * Resolve the authenticated bot login used to find prior prowl-review comments,
 * threads, and state. Precedence: explicit override → `GET /user` →
 * `PROWL_BOT_LOGIN` env hint → the GitHub Actions default.
 *
 * The Actions `GITHUB_TOKEN` is a GitHub App *installation* token, so `GET /user`
 * returns 403 ("Resource not accessible by integration"). Without a fallback the
 * login is `undefined`, which silently disables every stateful feature — the
 * summary is never found so it's re-posted every run (duplicate comments),
 * incremental re-review (#23), pause/resume (#26), the ignore list (#30), and
 * thread tidy (#22) all no-op. So when `GET /user` fails inside Actions we use
 * an operator-provided `PROWL_BOT_LOGIN` for custom GitHub-App tokens, otherwise
 * the default token's identity, `github-actions[bot]`.
 */
export async function getAuthenticatedLogin(octokit: OctokitLike, botLogin?: string): Promise<string | undefined> {
  if (botLogin?.trim()) {
    return botLogin.trim();
  }
  const envLogin = process.env.PROWL_BOT_LOGIN?.trim();

  try {
    const response = await octokit.rest.users.getAuthenticated();
    if (response.data.login) {
      return response.data.login;
    }
  } catch {
    // installation tokens 403 on GET /user; fall through to the Actions default
  }

  if (envLogin) {
    return envLogin;
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    return "github-actions[bot]";
  }
  return undefined;
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
): Promise<SubmitReviewResult> {
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
    repostableFindings: options.repostableFindings,
    postedInlineComments: []
  });

  let postedInlineComments: ReviewComment[] = [];
  let posted = false;
  const newInline = options.commitId ? initialPlan.newInlineComments : [];
  const reviewComments = newInline.map(toGitHubComment);

  if (payload.event === "COMMENT") {
    // COMMENT path (#22): publish net-new inline findings as one cohesive review
    // instead of one REST mutation per finding.
    if (reviewComments.length > 0) {
      // Post before persisting fingerprints; otherwise a failed GitHub review
      // submission would suppress retries for inline comments that never existed.
      if (options.shouldPublish && !(await options.shouldPublish())) {
        return { posted, cancelled: true };
      }
      await octokit.rest.pulls.createReview({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.pull_number,
        event: "COMMENT",
        ...(options.commitId ? { commit_id: options.commitId } : {}),
        body: buildPublishedReviewBody(newInline, "COMMENT"),
        comments: reviewComments
      });
      posted = true;
      postedInlineComments = newInline;
    }
  } else {
    // Verdict path (#52): one review carries the REQUEST_CHANGES/APPROVE event
    // plus the inline findings — a single, meaningful review entry.
    if (options.shouldPublish && !(await options.shouldPublish())) {
      return { posted, cancelled: true };
    }
    await octokit.rest.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pull_number,
      event: payload.event,
      ...(options.commitId ? { commit_id: options.commitId } : {}),
      body: buildPublishedReviewBody(newInline, payload.event),
      ...(reviewComments.length > 0 ? { comments: reviewComments } : {})
    });
    posted = true;
    postedInlineComments = newInline;
  }

  // Re-read the summary just before writing so command-side state changes
  // (pause/resume) that landed during a long review are not overwritten.
  const latestPrior = await findPriorSummary(octokit, ref, botLogin);
  const finalPlan = planPublish({
    payload,
    priorComment: latestPrior ?? prior,
    headSha: options.headSha,
    preservePriorSummary: options.preservePriorSummary,
    priorPostedFindings,
    repostableFindings: options.repostableFindings,
    postedInlineComments
  });
  // Summary: update in place, or create on the first run.
  if (options.shouldPublish && !(await options.shouldPublish())) {
    return { posted, cancelled: true };
  }
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
  return { posted: true, cancelled: false };
}

/**
 * Toggle the auto-review "paused" flag for a PR (#26). Persists `paused` in the
 * state marker on prowl-review's summary comment — editing it in place when
 * present, or creating a minimal marked comment when the bot hasn't reviewed the
 * PR yet (so the flag survives and `fetchPriorReviewState` finds it). Preserves
 * the existing `lastReviewedSha` + `postedFindings` so toggling pause never
 * disturbs incremental/dedup state. Returns whether a prior summary was updated.
 */
export async function setPausedState(
  octokit: OctokitLike,
  ref: PullRequestRef,
  paused: boolean,
  botLogin?: string
): Promise<{ updatedExisting: boolean }> {
  const login = await getAuthenticatedLogin(octokit, botLogin);
  const prior = await findPriorSummary(octokit, ref, login);

  if (prior) {
    const priorState = parseState(prior.body);
    const nextState: ReviewState = {
      v: REVIEW_STATE_VERSION,
      ...(priorState?.lastReviewedSha ? { lastReviewedSha: priorState.lastReviewedSha } : {}),
      paused,
      ...(priorState?.ignoredFindings && priorState.ignoredFindings.length > 0
        ? { ignoredFindings: priorState.ignoredFindings }
        : {}),
      postedFindings: priorState?.postedFindings ?? []
    };
    const { body } = embedStateWithFittedState(prior.body, nextState, GITHUB_COMMENT_BODY_LIMIT);
    await octokit.rest.issues.updateComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: prior.id,
      body
    });
    return { updatedExisting: true };
  }

  const note = paused
    ? "prowl-review is **paused** for this PR. Comment `@prowl-review resume` to re-enable auto-review."
    : "prowl-review is **active** for this PR.";
  const { body } = embedStateWithFittedState(
    `${REVIEW_MARKER}\n\n${note}`,
    { v: REVIEW_STATE_VERSION, paused, postedFindings: [] },
    GITHUB_COMMENT_BODY_LIMIT
  );
  await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pull_number,
    body
  });
  return { updatedExisting: false };
}

/** Post a top-level PR comment — used for bot-command acknowledgments (#26). */
export async function postPullRequestComment(
  octokit: OctokitLike,
  ref: PullRequestRef,
  body: string
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pull_number,
    body
  });
}

/** Reply in-thread to an existing review comment — used for inline chat replies (#27). */
export async function replyToReviewComment(
  octokit: OctokitLike,
  ref: PullRequestRef,
  commentId: number,
  body: string
): Promise<void> {
  await octokit.rest.pulls.createReplyForReviewComment({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: ref.pull_number,
    comment_id: commentId,
    body
  });
}

/** Fetch an inline review comment body for thread-grounded chat replies (#27). */
export async function fetchReviewCommentBody(
  octokit: OctokitLike,
  ref: PullRequestRef,
  commentId: number
): Promise<string | undefined> {
  try {
    const response = await octokit.rest.pulls.getReviewComment({
      owner: ref.owner,
      repo: ref.repo,
      comment_id: commentId
    });
    return response.data.body?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recover the prowl-review finding fingerprint(s) embedded in a review comment,
 * used to resolve which finding an `@prowl-review ignore` reply targets (#30).
 * Returns [] when the comment is gone or carries no marker.
 */
export async function fetchReviewCommentFingerprints(
  octokit: OctokitLike,
  ref: PullRequestRef,
  commentId: number
): Promise<string[]> {
  const body = await fetchReviewCommentBody(octokit, ref, commentId);
  return parseInlineFingerprintMarkers(body);
}

/**
 * Mute finding fingerprints for a PR via `@prowl-review ignore` (#30): merge them
 * into `ignoredFindings` in the summary comment's state marker (#12), so future
 * reviews of this PR suppress them. Edits the summary in place when present, or
 * creates a minimal marked comment otherwise. Returns how many were newly added.
 */
export async function setIgnoredFindings(
  octokit: OctokitLike,
  ref: PullRequestRef,
  fingerprints: string[],
  botLogin?: string
): Promise<{ added: number; total: number }> {
  const login = await getAuthenticatedLogin(octokit, botLogin);
  const prior = await findPriorSummary(octokit, ref, login);
  const priorState = prior ? parseState(prior.body) : null;
  const existing = new Set(priorState?.ignoredFindings ?? []);
  const before = existing.size;
  for (const fingerprint of fingerprints) {
    existing.add(fingerprint);
  }
  const merged = [...existing];
  const added = merged.length - before;

  if (prior) {
    const nextState: ReviewState = {
      v: REVIEW_STATE_VERSION,
      ...(priorState?.lastReviewedSha ? { lastReviewedSha: priorState.lastReviewedSha } : {}),
      ...(priorState?.paused !== undefined ? { paused: priorState.paused } : {}),
      ...(merged.length > 0 ? { ignoredFindings: merged } : {}),
      postedFindings: priorState?.postedFindings ?? []
    };
    const { body } = embedStateWithFittedState(prior.body, nextState, GITHUB_COMMENT_BODY_LIMIT);
    await octokit.rest.issues.updateComment({ owner: ref.owner, repo: ref.repo, comment_id: prior.id, body });
    return { added, total: merged.length };
  }

  const { body } = embedStateWithFittedState(
    `${REVIEW_MARKER}\n\nprowl-review is muting ${merged.length} finding(s) on this PR per \`@prowl-review ignore\`.`,
    { v: REVIEW_STATE_VERSION, ignoredFindings: merged, postedFindings: [] },
    GITHUB_COMMENT_BODY_LIMIT
  );
  await octokit.rest.issues.createComment({ owner: ref.owner, repo: ref.repo, issue_number: ref.pull_number, body });
  return { added, total: merged.length };
}

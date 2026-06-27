import type { OctokitLike } from "./client.js";
import type { PullRequestRef } from "./diff.js";
import { BREAK_GLASS_TRUSTED_ASSOCIATIONS } from "./break-glass.js";
import { getAuthenticatedLogin, parseInlineFingerprintMarkers } from "./review.js";
import {
  classifyReplyIntent,
  isDisputingIntent,
  isResolvingIntent,
  type ReplyIntent
} from "../review/reply-intent.js";

/**
 * Review-thread tidy-up (backlog #22 remainder): resolve fixed/settled finding
 * threads and honor human replies, so re-runs keep the PR clean instead of
 * leaving stale threads open or re-nagging on a finding the author already
 * addressed or disputed.
 *
 * GitHub's REST API can't resolve a review thread, so this uses GraphQL
 * (`reviewThreads` query + `resolveReviewThread` mutation). For each thread
 * prowl-review authored (identified by the hidden finding fingerprint in its
 * comment body) we decide, purely, whether to:
 *  - **resolve** it — the finding is gone from the latest full review (fixed),
 *    or a human reply settled it (won't-fix / acknowledged); or
 *  - **keep it open** — a human disputed it ("I disagree"): the finding is
 *    withheld from re-raising (#22) pending re-justification, but the thread is
 *    left for the human.
 *
 * `planThreadActions` is pure and unit-tested; `fetchReviewThreads` /
 * `resolveReviewThread` perform the GitHub I/O and are tolerant (a failure never
 * sinks the review, which is the primary output).
 */

/** How many review threads / comments to page through (cap so a huge PR is bounded). */
const THREAD_PAGE_SIZE = 100;
const COMMENTS_PER_THREAD = 50;
const MAX_THREAD_PAGES = 20;

/** A prowl-review-authored review thread, reduced to what the decision needs. */
export interface ReviewThread {
  /** GraphQL node id used by the resolve mutation. */
  id: string;
  /** True when the thread is already resolved (skip — nothing to do). */
  isResolved: boolean;
  /** True when GitHub marks the thread outdated (its diff line changed/disappeared). */
  isOutdated: boolean;
  /** Finding fingerprints recovered from prowl-review's comments in this thread. */
  fingerprints: string[];
  /** Classified intent of the newest decisive trusted human reply, if any. */
  humanIntent: ReplyIntent;
  /** Body of the decisive human reply, kept for re-justification context (#22). */
  humanReplyBody?: string;
}

/** Why a thread is being resolved (for the audit note). */
export type ThreadResolveReason = "fixed" | "acknowledged" | "wont-fix" | "withdrawn";

/** An open disputed thread the re-justification pass may act on (#22). */
export interface DisputedThread {
  /** GraphQL node id (for replying / resolving). */
  id: string;
  /** Finding fingerprints on the thread. */
  fingerprints: string[];
  /** The human's dispute reply body, if captured. */
  humanReplyBody?: string;
}

/** The pure decision over the PR's prowl-review threads. */
export interface ThreadActionPlan {
  /** Threads to resolve via the GraphQL mutation. */
  resolve: Array<{ id: string; reason: ThreadResolveReason; fingerprints: string[] }>;
  /**
   * Fingerprints to withhold from this run's findings: ones the human settled
   * (won't-fix/acknowledged) or disputed (disagree), so the reviewer stops
   * re-raising them.
   */
  suppress: { acknowledged: string[]; disputed: string[] };
  /** Open disputed threads the re-justification pass may defend or withdraw (#22). */
  disputedThreads: DisputedThread[];
  /** Count of disputed threads left open for the human (kept, not resolved). */
  keptOpenDisputed: number;
  /** Fingerprints whose old resolved thread should not suppress a future inline comment. */
  repostable: string[];
}

/**
 * Decide, purely, what to do with the PR's prowl-review threads given this run's
 * current finding fingerprints. A thread is only ever acted on when it carries a
 * prowl-review fingerprint (so human-authored threads are never touched) and is
 * not already resolved.
 *
 * Precedence per thread: a human dispute wins (keep open, withhold the finding);
 * then a human settle (resolve + withhold); then "finding no longer present"
 * (resolve as fixed). A still-current finding with no human reply is left
 * untouched, even when GitHub marks its old diff position outdated, because the
 * publisher dedupes by fingerprint and may not create a replacement inline
 * thread for the same finding.
 */
export function planThreadActions(input: {
  threads: ReviewThread[];
  currentFingerprints: Iterable<string>;
  resolveStaleThreads?: boolean;
}): ThreadActionPlan {
  const current = new Set(input.currentFingerprints);
  const resolveStaleThreads = input.resolveStaleThreads !== false;
  const resolve: ThreadActionPlan["resolve"] = [];
  const acknowledged = new Set<string>();
  const disputed = new Set<string>();
  const disputedThreads: DisputedThread[] = [];
  const repostable = new Set<string>();
  const openThreadFingerprints = new Set<string>();
  let keptOpenDisputed = 0;

  for (const thread of input.threads) {
    if (!thread.isResolved) {
      thread.fingerprints.forEach((fp) => openThreadFingerprints.add(fp));
    }
  }

  for (const thread of input.threads) {
    if (thread.fingerprints.length === 0) {
      continue;
    }

    if (isDisputingIntent(thread.humanIntent)) {
      thread.fingerprints.forEach((fp) => disputed.add(fp));
      if (!thread.isResolved) {
        keptOpenDisputed += 1;
        disputedThreads.push({
          id: thread.id,
          fingerprints: [...thread.fingerprints],
          ...(thread.humanReplyBody !== undefined ? { humanReplyBody: thread.humanReplyBody } : {})
        });
      }
      continue;
    }

    if (isResolvingIntent(thread.humanIntent)) {
      thread.fingerprints.forEach((fp) => acknowledged.add(fp));
      if (!thread.isResolved) {
        resolve.push({
          id: thread.id,
          reason: thread.humanIntent === "wont-fix" ? "wont-fix" : "acknowledged",
          fingerprints: [...thread.fingerprints]
        });
      }
      continue;
    }

    if (thread.isResolved) {
      thread.fingerprints.forEach((fp) => {
        if (!openThreadFingerprints.has(fp)) {
          repostable.add(fp);
        }
      });
      continue;
    }

    // No decisive human reply: resolve only when the finding is gone from this
    // full review. An outdated-but-current thread stays open so dedupe cannot
    // close the only inline thread for a still-valid finding.
    const stillCurrent = thread.fingerprints.some((fp) => current.has(fp));
    if (resolveStaleThreads && !stillCurrent) {
      resolve.push({ id: thread.id, reason: "fixed", fingerprints: [...thread.fingerprints] });
    }
  }

  return {
    resolve,
    suppress: { acknowledged: [...acknowledged], disputed: [...disputed] },
    disputedThreads,
    keptOpenDisputed,
    repostable: [...repostable]
  };
}

interface ReviewThreadCommentNode {
  body?: string | null;
  authorAssociation?: string | null;
  author?: { login?: string | null; __typename?: string | null } | null;
}

/** GraphQL shape for the review-threads query (only the fields we read). */
interface ReviewThreadsQueryResult {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<{
          id?: string;
          isResolved?: boolean;
          isOutdated?: boolean;
          comments?: {
            nodes?: Array<ReviewThreadCommentNode | null>;
          } | null;
          recentComments?: {
            nodes?: Array<ReviewThreadCommentNode | null>;
          } | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
}

const REVIEW_THREADS_QUERY = `
query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREAD_PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          comments(first: ${COMMENTS_PER_THREAD}) {
            nodes { body authorAssociation author { login __typename } }
          }
          recentComments: comments(last: ${COMMENTS_PER_THREAD}) {
            nodes { body authorAssociation author { login __typename } }
          }
        }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `
mutation ResolveThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

const REPLY_TO_THREAD_MUTATION = `
mutation ReplyToThread($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`;

/**
 * Fetch prowl-review's review threads on the PR, mapped to {@link ReviewThread}.
 * A thread's fingerprints come from comments authored by the bot; its
 * `humanIntent` is the classified intent of the newest decisive trusted GitHub
 * User comment from the recent page. Non-decisive follow-ups do not erase an
 * earlier settled/disputed decision. Tolerant — any read failure returns `[]` so
 * the review proceeds.
 */
export async function fetchReviewThreads(
  octokit: OctokitLike,
  ref: PullRequestRef,
  botLogin?: string
): Promise<ReviewThread[]> {
  try {
    const login = await getAuthenticatedLogin(octokit, botLogin);
    if (!login) {
      return [];
    }

    const threads: ReviewThread[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
      const data = await octokit.graphql<ReviewThreadsQueryResult>(REVIEW_THREADS_QUERY, {
        owner: ref.owner,
        repo: ref.repo,
        number: ref.pull_number,
        cursor: cursor ?? null
      });
      const connection = data.repository?.pullRequest?.reviewThreads;
      const nodes = connection?.nodes ?? [];
      for (const node of nodes) {
        if (!node?.id) {
          continue;
        }
        const comments = node.comments?.nodes ?? [];
        const recentComments = node.recentComments?.nodes ?? [];
        const fingerprints = new Set<string>();
        let humanIntent: ReplyIntent = "other";
        let humanReplyBody: string | undefined;
        for (const comment of comments) {
          if (!comment) {
            continue;
          }
          const author = comment.author?.login ?? undefined;
          if (author === login) {
            parseInlineFingerprintMarkers(comment.body ?? undefined).forEach((fp) => fingerprints.add(fp));
          }
        }
        for (const comment of recentComments) {
          if (!comment) {
            continue;
          }
          const author = comment.author?.login ?? undefined;
          if (author === login) {
            parseInlineFingerprintMarkers(comment.body ?? undefined).forEach((fp) => fingerprints.add(fp));
          }
        }
        for (let i = recentComments.length - 1; i >= 0; i -= 1) {
          const comment = recentComments[i];
          if (!comment) {
            continue;
          }
          const author = comment.author?.login ?? undefined;
          const authorType = comment.author?.__typename ?? undefined;
          const association = comment.authorAssociation ?? "NONE";
          const isTrustedHuman =
            authorType === "User" && BREAK_GLASS_TRUSTED_ASSOCIATIONS.has(association);
          if (author === login || !isTrustedHuman) {
            continue;
          }
          const intent = classifyReplyIntent(comment.body ?? undefined);
          if (intent !== "other") {
            humanIntent = intent;
            humanReplyBody = comment.body ?? undefined;
            break;
          }
        }
        threads.push({
          id: node.id,
          isResolved: node.isResolved === true,
          isOutdated: node.isOutdated === true,
          fingerprints: [...fingerprints],
          humanIntent,
          ...(humanReplyBody !== undefined ? { humanReplyBody } : {})
        });
      }

      if (connection?.pageInfo?.hasNextPage !== true) {
        break;
      }
      cursor = connection.pageInfo.endCursor;
      if (!cursor) {
        break;
      }
    }
    return threads;
  } catch {
    return [];
  }
}

/** Resolve a single review thread. Tolerant — returns false on any failure. */
export async function resolveReviewThread(octokit: OctokitLike, threadId: string): Promise<boolean> {
  try {
    await octokit.graphql(RESOLVE_THREAD_MUTATION, { threadId });
    return true;
  } catch {
    return false;
  }
}

/** Post a reply on a review thread via GraphQL (#22). Tolerant — false on any failure. */
export async function replyToReviewThread(octokit: OctokitLike, threadId: string, body: string): Promise<boolean> {
  try {
    await octokit.graphql(REPLY_TO_THREAD_MUTATION, { threadId, body });
    return true;
  } catch {
    return false;
  }
}

import type { OctokitLike } from "./client.js";
import type { PullRequestRef } from "./diff.js";
import { REVIEW_MARKER } from "../review/walkthrough.js";
import type { BreakGlassSignal } from "../review/approval.js";

/**
 * Break-glass override detection (backlog #52).
 *
 * Scans the PR's issue comments and inline review comments for a
 * `@prowl-review break glass` override and, when one is present from a
 * **trusted** author (repo owner/member/collaborator), reports it so the
 * approval rubric can force-approve past a blocking finding.
 *
 * Four guards keep the override honest:
 *  - **Author association** must be OWNER/MEMBER/COLLABORATOR, so a drive-by fork
 *    contributor (association NONE/CONTRIBUTOR) can't unblock their own PR. This
 *    needs no extra API call — GitHub returns `author_association` on each comment.
 *  - When a head SHA is supplied, the override comment must name that exact SHA,
 *    so an override cannot silently carry forward to a later commit.
 *  - When a timestamp cutoff is supplied by a caller, the override comment must
 *    be newer than that cutoff.
 *  - prowl-review's **own** summary comment is skipped (it carries the hidden
 *    {@link REVIEW_MARKER}) and prowl-review's own inline finding comments are
 *    skipped (they carry a hidden finding marker). These comments can literally
 *    contain the override phrase as guidance or quoted context, so the bot can
 *    never self-trigger an override — including in local mode where the runner's
 *    token is the repo owner.
 *
 * Tolerant: an issue-comment read failure yields an inactive signal, while an
 * inline-comment read failure preserves any trusted issue-comment override that
 * was already found. A transient API error never invents an approval.
 */

/** Matches `@prowl-review break glass` / `break-glass` / `breakglass` (case-insensitive). */
export const BREAK_GLASS_RE = /@prowl-review\s+break[\s-]?glass\b/i;

/** GitHub author associations trusted to trigger a break-glass override. */
export const BREAK_GLASS_TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const INLINE_FINDING_MARKER = "<!-- prowl-review:finding ";

/** Don't page issue comments forever on a very long thread. */
const MAX_COMMENT_PAGES = 20;
const MAX_REVIEW_COMMENT_PAGES = 20;
const COMMENT_SORT = "created";
const COMMENT_DIRECTION = "desc";

interface BreakGlassComment {
  body?: string;
  user?: { login?: string } | null;
  author_association?: string;
  created_at?: string;
}

interface BreakGlassCandidate {
  signal: BreakGlassSignal;
  createdAt?: number;
  order: number;
}

/** Return true when a comment body asks prowl-review to break glass. */
export function matchesBreakGlass(body: string | null | undefined): boolean {
  return typeof body === "string" && BREAK_GLASS_RE.test(body);
}

function mentionsHeadSha(body: string | null | undefined, headSha: string | undefined): boolean {
  if (!headSha) {
    return true;
  }
  return typeof body === "string" && body.toLowerCase().includes(headSha.toLowerCase());
}

function parsedCommentTimestamp(comment: BreakGlassComment): number | undefined {
  const createdAt = comment.created_at ? Date.parse(comment.created_at) : Number.NaN;
  return Number.isFinite(createdAt) ? createdAt : undefined;
}

function newestBreakGlassCandidate(candidates: BreakGlassCandidate[]): BreakGlassCandidate | undefined {
  return candidates.reduce<BreakGlassCandidate | undefined>((newest, candidate) => {
    if (!newest) {
      return candidate;
    }
    if (candidate.createdAt !== undefined && newest.createdAt !== undefined) {
      if (candidate.createdAt === newest.createdAt) {
        return candidate.order < newest.order ? candidate : newest;
      }
      return candidate.createdAt > newest.createdAt ? candidate : newest;
    }
    if (candidate.createdAt !== undefined) {
      return candidate;
    }
    if (newest.createdAt !== undefined) {
      return newest;
    }
    return candidate.order < newest.order ? candidate : newest;
  }, undefined);
}

function breakGlassCandidateForComment(
  comment: BreakGlassComment,
  options: { botLogin?: string; createdAfter?: string; headSha?: string },
  createdAfter: number | undefined,
  order: number
): BreakGlassCandidate | undefined {
  const login = comment.user?.login;
  // Never honor our own summary/inline finding comments (they can quote the
  // phrase as guidance or context) or the configured bot login.
  const body = comment.body ?? "";
  if (body.includes(REVIEW_MARKER) || body.includes(INLINE_FINDING_MARKER)) {
    return undefined;
  }
  if (options.botLogin && login === options.botLogin) {
    return undefined;
  }
  if (!matchesBreakGlass(comment.body)) {
    return undefined;
  }
  if (!mentionsHeadSha(comment.body, options.headSha)) {
    return undefined;
  }
  const commentCreatedAt = parsedCommentTimestamp(comment);
  if (createdAfter !== undefined && (commentCreatedAt === undefined || commentCreatedAt <= createdAfter)) {
    return undefined;
  }
  const association = comment.author_association ?? "NONE";
  if (!BREAK_GLASS_TRUSTED_ASSOCIATIONS.has(association)) {
    return undefined;
  }
  return {
    signal: { active: true, actor: login ?? undefined, association },
    createdAt: commentCreatedAt,
    order
  };
}

/**
 * Scan PR comments for a trusted `@prowl-review break glass` override. Fetch
 * newest-first pages from each comment surface, then choose the newest trusted
 * candidate by timestamp across all collected candidates.
 */
export async function detectBreakGlass(
  octokit: OctokitLike,
  ref: PullRequestRef,
  options: { botLogin?: string; createdAfter?: string; headSha?: string } = {}
): Promise<BreakGlassSignal> {
  try {
    const parsedCreatedAfter = options.createdAfter ? Date.parse(options.createdAfter) : undefined;
    if (parsedCreatedAfter !== undefined && !Number.isFinite(parsedCreatedAfter)) {
      return { active: false };
    }
    const createdAfter = parsedCreatedAfter;
    const perPage = 100;
    let page = 1;
    let order = 0;
    const candidates: BreakGlassCandidate[] = [];
    for (;;) {
      const response = await octokit.rest.issues.listComments({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.pull_number,
        per_page: perPage,
        page,
        sort: COMMENT_SORT,
        direction: COMMENT_DIRECTION,
        ...(options.createdAfter ? { since: options.createdAfter } : {})
      });

      for (const comment of response.data) {
        order += 1;
        const candidate = breakGlassCandidateForComment(comment, options, createdAfter, order);
        if (candidate) {
          candidates.push(candidate);
        }
      }

      if (response.data.length < perPage || page >= MAX_COMMENT_PAGES) {
        break;
      }
      page += 1;
    }
    try {
      page = 1;
      for (;;) {
        const response = await octokit.rest.pulls.listReviewComments({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.pull_number,
          per_page: perPage,
          page,
          sort: COMMENT_SORT,
          direction: COMMENT_DIRECTION,
          ...(options.createdAfter ? { since: options.createdAfter } : {})
        });

        for (const comment of response.data) {
          order += 1;
          const candidate = breakGlassCandidateForComment(comment, options, createdAfter, order);
          if (candidate) {
            candidates.push(candidate);
          }
        }

        if (response.data.length < perPage || page >= MAX_REVIEW_COMMENT_PAGES) {
          break;
        }
        page += 1;
      }
    } catch {
      const newest = newestBreakGlassCandidate(candidates);
      if (newest) {
        return newest.signal;
      }
      return { active: false };
    }
    const newest = newestBreakGlassCandidate(candidates);
    if (newest) {
      return newest.signal;
    }
  } catch {
    // fall through to an inactive signal
  }
  return { active: false };
}

import type { OctokitLike } from "./client.js";
import type { PullRequestRef } from "./diff.js";
import { REVIEW_MARKER } from "../review/walkthrough.js";
import type { BreakGlassSignal } from "../review/approval.js";

/**
 * Break-glass override detection (backlog #52).
 *
 * Scans the PR's issue comments for a `@prowl-review break glass` override and,
 * when one is present from a **trusted** author (repo owner/member/collaborator),
 * reports it so the approval rubric can force-approve past a blocking finding.
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
 *    {@link REVIEW_MARKER} and, when requesting changes, literally contains the
 *    override phrase as guidance) so the bot can never self-trigger an override —
 *    including in local mode where the runner's token is the repo owner.
 *
 * Tolerant: any read failure yields an inactive signal, so a transient API error
 * never accidentally approves a PR.
 */

/** Matches `@prowl-review break glass` / `break-glass` / `breakglass` (case-insensitive). */
export const BREAK_GLASS_RE = /@prowl-review\s+break[\s-]?glass\b/i;

/** GitHub author associations trusted to trigger a break-glass override. */
export const BREAK_GLASS_TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Don't page issue comments forever on a very long thread. */
const MAX_COMMENT_PAGES = 20;

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

/**
 * Scan PR comments for a trusted `@prowl-review break glass` override. GitHub
 * returns issue comments in ascending order, so we keep the newest trusted match
 * while paging instead of assuming the first match is the latest.
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
    let newest: BreakGlassSignal | undefined;
    for (;;) {
      const response = await octokit.rest.issues.listComments({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.pull_number,
        per_page: perPage,
        page,
        ...(options.createdAfter ? { since: options.createdAfter } : {})
      });

      for (const comment of response.data) {
        const login = comment.user?.login;
        // Never honor our own summary comment (carries the marker + the phrase as
        // guidance) or the configured bot login.
        if ((comment.body ?? "").includes(REVIEW_MARKER)) {
          continue;
        }
        if (options.botLogin && login === options.botLogin) {
          continue;
        }
        if (!matchesBreakGlass(comment.body)) {
          continue;
        }
        if (!mentionsHeadSha(comment.body, options.headSha)) {
          continue;
        }
        if (createdAfter !== undefined) {
          const createdAt = comment.created_at ? Date.parse(comment.created_at) : Number.NaN;
          if (!Number.isFinite(createdAt) || createdAt <= createdAfter) {
            continue;
          }
        }
        const association = comment.author_association ?? "NONE";
        if (!BREAK_GLASS_TRUSTED_ASSOCIATIONS.has(association)) {
          continue;
        }
        newest = { active: true, actor: login ?? undefined, association };
      }

      if (response.data.length < perPage || page >= MAX_COMMENT_PAGES) {
        break;
      }
      page += 1;
    }
    if (newest) {
      return newest;
    }
  } catch {
    // fall through to an inactive signal
  }
  return { active: false };
}

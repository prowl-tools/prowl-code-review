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
 * Two guards keep the override honest:
 *  - **Author association** must be OWNER/MEMBER/COLLABORATOR, so a drive-by fork
 *    contributor (association NONE/CONTRIBUTOR) can't unblock their own PR. This
 *    needs no extra API call — GitHub returns `author_association` on each comment.
 *  - When a push timestamp is supplied, the override comment must be newer than
 *    that push, so an override cannot silently carry forward to later commits.
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
const MAX_COMMENT_PAGES = 10;

/** Return true when a comment body asks prowl-review to break glass. */
export function matchesBreakGlass(body: string | null | undefined): boolean {
  return typeof body === "string" && BREAK_GLASS_RE.test(body);
}

/**
 * Scan PR comments for a trusted `@prowl-review break glass` override. Returns the
 * first matching comment from a trusted author (newest first), or an inactive
 * signal when none is found or the read fails.
 */
export async function detectBreakGlass(
  octokit: OctokitLike,
  ref: PullRequestRef,
  options: { botLogin?: string; createdAfter?: string } = {}
): Promise<BreakGlassSignal> {
  try {
    const parsedCreatedAfter = options.createdAfter ? Date.parse(options.createdAfter) : undefined;
    const createdAfter =
      parsedCreatedAfter === undefined || Number.isFinite(parsedCreatedAfter) ? parsedCreatedAfter : Number.POSITIVE_INFINITY;
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
        return { active: true, actor: login ?? undefined, association };
      }

      if (response.data.length < perPage || page >= MAX_COMMENT_PAGES) {
        break;
      }
      page += 1;
    }
  } catch {
    // fall through to an inactive signal
  }
  return { active: false };
}

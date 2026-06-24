import type { OctokitLike } from "./client.js";
import type { IssueRef } from "../review/issue-refs.js";

/**
 * Linked-issue fetching for issue/ticket validation (#32).
 *
 * Pulls a referenced issue's title + body so the review can check the PR against
 * its acceptance criteria. Tolerant: a missing issue, a permissions error
 * (cross-repo), or a reference that is actually a pull request resolves to
 * `null` so the review proceeds without it. Transient/API failures are allowed
 * to reject so the pipeline can surface a degraded validation note.
 */

/** A fetched linked issue's content. */
export interface FetchedIssue {
  ref: IssueRef;
  title: string;
  body: string;
}

/** Extract an Octokit-style HTTP status from an unknown thrown value. */
function getHttpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}

/** Return true for permanent responses where the linked issue cannot be used. */
function isUnusableIssueError(error: unknown): boolean {
  const status = getHttpStatus(error);
  return status === 403 || status === 404 || status === 410 || status === 451;
}

/**
 * Fetch one linked issue's title/body, or null when it can't be used: not found,
 * inaccessible, empty, or actually a pull request (PRs aren't requirements).
 */
export async function fetchIssue(octokit: OctokitLike, ref: IssueRef): Promise<FetchedIssue | null> {
  try {
    const response = await octokit.rest.issues.get({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number
    });
    const data = response.data;
    if (data.pull_request) {
      return null; // a PR, not an issue — skip
    }
    const title = (data.title ?? "").trim();
    const body = (data.body ?? "").trim();
    if (!title && !body) {
      return null;
    }
    return { ref, title, body };
  } catch (error) {
    if (isUnusableIssueError(error)) {
      return null;
    }
    throw error;
  }
}

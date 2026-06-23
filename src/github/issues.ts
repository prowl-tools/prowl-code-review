import type { OctokitLike } from "./client.js";
import type { IssueRef } from "../review/issue-refs.js";

/**
 * Linked-issue fetching for issue/ticket validation (#32).
 *
 * Pulls a referenced issue's title + body so the review can check the PR against
 * its acceptance criteria. Tolerant: a missing issue, a permissions error
 * (cross-repo), or a reference that is actually a pull request resolves to
 * `null` so the review proceeds without it (never a sink).
 */

/** A fetched linked issue's content. */
export interface FetchedIssue {
  ref: IssueRef;
  title: string;
  body: string;
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
  } catch {
    return null;
  }
}

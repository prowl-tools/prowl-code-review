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

/** Extract a response header from an Octokit-style error object. */
function getResponseHeader(error: unknown, name: string): string | undefined {
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return undefined;
  }
  const response = error.response;
  if (typeof response !== "object" || response === null || !("headers" in response)) {
    return undefined;
  }
  const headers = response.headers;
  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }
  const headerMap = headers as Record<string, unknown>;
  const key = Object.keys(headerMap).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headerMap[key] : undefined;
  if (Array.isArray(value)) {
    return value.length > 0 ? String(value[0]) : undefined;
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** GitHub reports primary and secondary rate limits as 403 in some cases. */
function isRateLimitError(error: unknown): boolean {
  if (getHttpStatus(error) !== 403) {
    return false;
  }
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("rate limit") ||
    getResponseHeader(error, "retry-after") !== undefined ||
    getResponseHeader(error, "x-ratelimit-remaining") === "0"
  );
}

/** Return true for permanent responses where the linked issue cannot be used. */
function isUnusableIssueError(error: unknown): boolean {
  const status = getHttpStatus(error);
  return (status === 403 && !isRateLimitError(error)) || status === 404 || status === 410 || status === 451;
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

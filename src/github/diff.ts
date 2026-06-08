import type { OctokitLike } from "./client.js";

/** Repository and pull request number identifying a GitHub PR. */
export interface PullRequestRef {
  /** Repository owner or organization. */
  owner: string;
  /** Repository name without owner. */
  repo: string;
  /** Pull request number. */
  pull_number: number;
}

/** Pull request metadata required by the review pipeline. */
export interface PullRequestMeta {
  /** Pull request number. */
  number: number;
  /** Pull request title. */
  title: string;
  /** Pull request body text, if present. */
  body: string | null;
  /** Base branch commit SHA. */
  baseSha: string;
  /** Head branch commit SHA. */
  headSha: string;
  /** Whether the pull request is currently a draft. */
  draft: boolean;
  /** GitHub pull request state. */
  state: string;
  /** GitHub login of the author, or null if unavailable. */
  author: string | null;
  /** Number of files changed in the pull request. */
  changedFiles: number;
}

/** Fetched pull request metadata together with its raw unified diff. */
export interface FetchedPullRequest {
  /** Normalized pull request metadata. */
  meta: PullRequestMeta;
  /** Raw unified diff text (to be parsed with `parseDiff`). */
  diff: string;
}

/** Shape of the parts of the PR payload we read. */
interface RawPullRequest {
  /** Pull request number. */
  number: number;
  /** Pull request title. */
  title: string;
  /** Pull request body text, if present. */
  body: string | null;
  /** Base branch information. */
  base: { sha: string };
  /** Head branch information. */
  head: { sha: string };
  /** Whether the pull request is currently a draft. */
  draft?: boolean;
  /** GitHub pull request state. */
  state: string;
  /** Pull request author, if GitHub returns one. */
  user: { login: string } | null;
  /** Number of changed files, omitted by some fixtures/mocks. */
  changed_files?: number;
}

/**
 * Fetch a pull request's metadata and raw unified diff via the GitHub REST API.
 * Two calls: a normal `pulls.get` for metadata and a `format: "diff"` `pulls.get`
 * for the unified diff text. `octokit` is injectable for testing.
 */
export async function fetchPullRequest(
  octokit: OctokitLike,
  ref: PullRequestRef
): Promise<FetchedPullRequest> {
  const metaResponse = await octokit.rest.pulls.get({ ...ref });
  const pr = metaResponse.data as RawPullRequest;

  const diffResponse = await octokit.rest.pulls.get({
    ...ref,
    mediaType: { format: "diff" }
  });
  // With `format: "diff"` the API returns the raw diff as the body.
  const diff = diffResponse.data as unknown as string;

  return {
    meta: {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      draft: pr.draft ?? false,
      state: pr.state,
      author: pr.user?.login ?? null,
      changedFiles: pr.changed_files ?? 0
    },
    diff
  };
}

import type { OctokitLike } from "./client.js";

export interface PullRequestRef {
  owner: string;
  repo: string;
  pull_number: number;
}

export interface PullRequestMeta {
  number: number;
  title: string;
  body: string | null;
  baseSha: string;
  headSha: string;
  draft: boolean;
  state: string;
  author: string | null;
  changedFiles: number;
}

export interface FetchedPullRequest {
  meta: PullRequestMeta;
  /** Raw unified diff text (to be parsed with `parseDiff`). */
  diff: string;
}

/** Shape of the parts of the PR payload we read. */
interface RawPullRequest {
  number: number;
  title: string;
  body: string | null;
  base: { sha: string };
  head: { sha: string };
  draft?: boolean;
  state: string;
  user: { login: string } | null;
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

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

interface RawComparison {
  /** GitHub compare relationship: ahead/behind/diverged/identical. */
  status?: unknown;
}

function comparisonStatus(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const status = (data as RawComparison).status;
  return typeof status === "string" ? status : undefined;
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

/**
 * Fetch the raw unified diff between two commits (incremental re-review, #23) via
 * `repos.compareCommitsWithBasehead` with `format: "diff"`. Used to review only
 * the delta a push added since the last reviewed SHA. Throws if the range can't
 * be compared (e.g. the base SHA is unreachable after a force-push) — the caller
 * falls back to a full review.
 */
export async function fetchComparisonDiff(
  octokit: OctokitLike,
  ref: PullRequestRef,
  base: string,
  head: string
): Promise<string> {
  const basehead = `${base}...${head}`;
  const comparison = await octokit.rest.repos.compareCommitsWithBasehead({
    owner: ref.owner,
    repo: ref.repo,
    basehead
  });
  const status = comparisonStatus(comparison.data);
  if (status !== "ahead" && status !== "identical") {
    throw new Error(
      `Cannot use incremental compare ${basehead}: base is not an ancestor of head (status: ${status ?? "unknown"})`
    );
  }
  if (status === "identical") {
    return "";
  }

  const response = await octokit.rest.repos.compareCommitsWithBasehead({
    owner: ref.owner,
    repo: ref.repo,
    basehead,
    mediaType: { format: "diff" }
  });
  // With `format: "diff"` the API returns the raw diff as the body.
  return response.data as unknown as string;
}

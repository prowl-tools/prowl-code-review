import { getOctokit } from "@actions/github";

/**
 * Minimal structural view of the Octokit REST methods prowl-review uses.
 * Defined explicitly so callers (and tests) can supply a lightweight mock
 * without depending on the full Octokit type.
 */
export interface OctokitLike {
  /** REST API namespaces used by prowl-review. */
  rest: {
    /** Pull request endpoints used for metadata and raw diff retrieval. */
    pulls: {
      /** Fetch PR metadata, or raw diff text when `mediaType.format` is `diff`. */
      get(params: {
        /** Repository owner or organization. */
        owner: string;
        /** Repository name without owner. */
        repo: string;
        /** Pull request number. */
        pull_number: number;
        /** Optional media format override for non-JSON responses. */
        mediaType?: { format: string };
      }): Promise<{ data: unknown }>;
      /** Publish a review: a summary `body`, an `event`, and inline `comments`. */
      createReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        body?: string;
        event?: string;
        commit_id?: string;
        comments?: Array<{
          path: string;
          body: string;
          line?: number;
          side?: string;
          start_line?: number;
          start_side?: string;
        }>;
      }): Promise<{ data: unknown }>;
    };
  };
}

/** Create an authenticated Octokit client from a GitHub token. */
export function createOctokit(token: string): OctokitLike {
  return getOctokit(token) as unknown as OctokitLike;
}

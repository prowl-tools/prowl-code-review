import { getOctokit } from "@actions/github";

/**
 * Minimal structural view of the Octokit REST methods prowl-review uses.
 * Defined explicitly so callers (and tests) can supply a lightweight mock
 * without depending on the full Octokit type.
 */
export interface OctokitLike {
  rest: {
    pulls: {
      get(params: {
        owner: string;
        repo: string;
        pull_number: number;
        mediaType?: { format: string };
      }): Promise<{ data: unknown }>;
    };
  };
}

/** Create an authenticated Octokit client from a GitHub token. */
export function createOctokit(token: string): OctokitLike {
  return getOctokit(token) as unknown as OctokitLike;
}

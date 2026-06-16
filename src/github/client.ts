import { getOctokit } from "@actions/github";
import type { ReviewEvent, ReviewSide } from "../review/inline.js";

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
        event?: ReviewEvent;
        commit_id?: string;
        comments?: Array<{
          path: string;
          body: string;
          line?: number;
          side?: ReviewSide;
          start_line?: number;
          start_side?: ReviewSide;
        }>;
      }): Promise<{ data: unknown }>;
      /** List inline review comments already posted on the PR. */
      listReviewComments(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: Array<{ body?: string; user?: { login?: string } | null }> }>;
    };
    /** Issue endpoints — a PR is an issue, so its top-level comments live here. */
    issues: {
      /** List a PR/issue's top-level comments (used to find our prior summary). */
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
        sort?: "created" | "updated";
        direction?: "asc" | "desc";
      }): Promise<{ data: Array<{ id: number; body?: string; user?: { login?: string } | null }> }>;
      /** Create a top-level PR/issue comment (the summary on a first run). */
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<{ data: unknown }>;
      /** Update an existing PR/issue comment in place (update-not-duplicate). */
      updateComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<{ data: unknown }>;
    };
    /** Repository endpoints — commit comparison for incremental re-review (#23). */
    repos: {
      /** Compare two commits; with `mediaType.format: "diff"` returns the raw delta diff. */
      compareCommitsWithBasehead(params: {
        owner: string;
        repo: string;
        /** `BASE...HEAD` revision range. */
        basehead: string;
        mediaType?: { format: string };
      }): Promise<{ data: unknown }>;
    };
    /** User endpoints used to identify the authenticated GitHub app/bot. */
    users: {
      /** Return the authenticated user's login for comment ownership checks. */
      getAuthenticated(): Promise<{ data: { login: string } }>;
    };
  };
}

/** Create an authenticated Octokit client from a GitHub token. */
export function createOctokit(token: string): OctokitLike {
  return getOctokit(token) as unknown as OctokitLike;
}

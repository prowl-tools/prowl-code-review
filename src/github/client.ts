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
  };
}

/** Create an authenticated Octokit client from a GitHub token. */
export function createOctokit(token: string): OctokitLike {
  return getOctokit(token) as unknown as OctokitLike;
}

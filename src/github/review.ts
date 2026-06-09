import type { OctokitLike } from "./client.js";
import type { PullRequestRef } from "./diff.js";
import type { ReviewPayload } from "../review/inline.js";

/**
 * Publish a single cohesive review (backlog #10): one `POST /pulls/{n}/reviews`
 * with the summary body, an event, and the inline `comments[]`. `octokit` is
 * injectable for testing, mirroring the diff-fetch layer.
 */
export async function submitReview(
  octokit: OctokitLike,
  ref: PullRequestRef,
  payload: ReviewPayload,
  commitId?: string
): Promise<void> {
  await octokit.rest.pulls.createReview({
    ...ref,
    body: payload.body,
    event: payload.event,
    ...(commitId ? { commit_id: commitId } : {}),
    comments: payload.comments
  });
}

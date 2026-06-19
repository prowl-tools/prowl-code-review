import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { createOctokit, type OctokitLike } from "../../github/client.js";
import type { PullRequestRef } from "../../github/diff.js";
import { setPausedState, postPullRequestComment } from "../../github/review.js";
import {
  parseCommand,
  commandHelpText,
  isTrustedCommandAuthor,
  type ParsedCommand
} from "../../review/commands.js";
import { resolveRepo, runReviewWithOptions } from "./review.js";

/**
 * `prowl-review command` — handle an `@prowl-review <verb>` bot command from a PR
 * comment event (backlog #26).
 *
 * Reads the `issue_comment` / `pull_request_review_comment` event, parses the
 * command (verb allowlist, #14), trust-gates the author (owner/member/
 * collaborator, like break-glass #52), and dispatches:
 *  - `review` / `full review` → re-run the pipeline (incremental, or a full
 *    re-scan); always runs, ignoring pause (it's an explicit request).
 *  - `pause` / `resume` → toggle the auto-review pause flag persisted in the
 *    summary comment's state marker.
 *  - `help` / anything unrecognized → reply with the supported-command list.
 *
 * Deferred (still #26): `ignore` / `resolve` / `configure` — these target a
 * specific finding/thread from the reply context, which rides with the #30
 * learnings write-back and #22 reply infra.
 */

/** A bot-command comment event reduced to what dispatch needs. */
export interface CommentEvent {
  body: string;
  association: string | undefined;
  login: string | undefined;
  pullNumber: number;
}

/** Read and normalize the triggering comment event from `GITHUB_EVENT_PATH`. */
export function resolveCommentEvent(env: NodeJS.ProcessEnv = process.env): CommentEvent | null {
  const path = env.GITHUB_EVENT_PATH;
  if (!path || !existsSync(path)) {
    return null;
  }
  try {
    const event = JSON.parse(readFileSync(path, "utf8")) as {
      comment?: { body?: string; author_association?: string; user?: { login?: string; type?: string } | null };
      issue?: { number?: number; pull_request?: unknown };
      pull_request?: { number?: number };
    };
    const comment = event.comment;
    if (!comment?.body) {
      return null;
    }
    if (comment.user?.type === "Bot") {
      return null;
    }
    let pullNumber: number | undefined;
    if (event.issue) {
      // An issue_comment is only a PR comment when `pull_request` is present.
      if (!event.issue.pull_request) {
        return null;
      }
      pullNumber = event.issue.number;
    } else if (event.pull_request) {
      pullNumber = event.pull_request.number;
    }
    if (!pullNumber) {
      return null;
    }
    return {
      body: comment.body,
      association: comment.author_association,
      login: comment.user?.login ?? undefined,
      pullNumber
    };
  } catch {
    return null;
  }
}

/** Injectable side effects so dispatch is unit-testable without GitHub. */
export interface CommandDispatchDeps {
  runReview?: (
    cli: { pr: string; repo: string; incremental?: boolean },
    runtime: { respectPause?: boolean }
  ) => Promise<void>;
  setPaused?: (octokit: OctokitLike, ref: PullRequestRef, paused: boolean) => Promise<{ updatedExisting: boolean }>;
  postComment?: (octokit: OctokitLike, ref: PullRequestRef, body: string) => Promise<void>;
}

/** Result of dispatching a parsed command (for logging/tests). */
export interface CommandOutcome {
  verb: ParsedCommand["verb"];
  /** True when the command triggered a review run. */
  reviewed: boolean;
}

/**
 * Dispatch a trusted, parsed command. Assumes the caller has already trust-gated
 * the author. Side effects are injectable for testing.
 */
export async function dispatchCommand(
  parsed: ParsedCommand,
  ctx: { octokit: OctokitLike; ref: PullRequestRef; deps?: CommandDispatchDeps }
): Promise<CommandOutcome> {
  const runReview = ctx.deps?.runReview ?? runReviewWithOptions;
  const setPaused = ctx.deps?.setPaused ?? setPausedState;
  const postComment = ctx.deps?.postComment ?? postPullRequestComment;
  const repo = `${ctx.ref.owner}/${ctx.ref.repo}`;
  const pr = String(ctx.ref.pull_number);

  switch (parsed.verb) {
    case "review":
      // Explicit request overrides pause.
      await runReview({ pr, repo }, { respectPause: false });
      return { verb: parsed.verb, reviewed: true };
    case "full-review":
      await runReview({ pr, repo, incremental: false }, { respectPause: false });
      return { verb: parsed.verb, reviewed: true };
    case "pause": {
      await setPaused(ctx.octokit, ctx.ref, true);
      await postComment(
        ctx.octokit,
        ctx.ref,
        "⏸️ Auto-review **paused** for this PR. New pushes won't be reviewed until you comment `@prowl-review resume`."
      );
      return { verb: parsed.verb, reviewed: false };
    }
    case "resume": {
      await setPaused(ctx.octokit, ctx.ref, false);
      await postComment(
        ctx.octokit,
        ctx.ref,
        "▶️ Auto-review **resumed** for this PR. Comment `@prowl-review review` to review the current state now."
      );
      return { verb: parsed.verb, reviewed: false };
    }
    case "help":
    default:
      await postComment(ctx.octokit, ctx.ref, commandHelpText());
      return { verb: parsed.verb, reviewed: false };
  }
}

/** Build the `command` CLI subcommand wired to the comment-event dispatch. */
export function buildCommandCommand(): Command {
  const command = new Command("command");

  command
    .description("Handle an @prowl-review bot command from a PR comment event")
    .option("--repo <owner/repo>", "repository (defaults to GITHUB_REPOSITORY)")
    .action(async (options: { repo?: string }) => {
      const event = resolveCommentEvent();
      if (!event) {
        console.log("prowl-review: no PR comment event found; nothing to do.");
        return;
      }

      const parsed = parseCommand(event.body);
      if (!parsed) {
        // No @prowl-review mention — not for us.
        return;
      }

      if (!isTrustedCommandAuthor(event.association)) {
        console.log(
          `prowl-review: ignoring @prowl-review command from an untrusted author (association: ${event.association ?? "none"}).`
        );
        return;
      }

      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error("GITHUB_TOKEN environment variable is required to handle commands.");
      }
      const { owner, repo } = resolveRepo(options.repo);
      const octokit = createOctokit(token);
      const ref = { owner, repo, pull_number: event.pullNumber };

      const outcome = await dispatchCommand(parsed, { octokit, ref });
      console.log(
        `prowl-review: handled \`@prowl-review ${parsed.verb}\` on ${owner}/${repo}#${event.pullNumber}` +
          (outcome.reviewed ? " (review run)" : "")
      );
    });

  return command;
}

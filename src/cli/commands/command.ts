import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { createOctokit, type OctokitLike } from "../../github/client.js";
import {
  fetchPullRequest as defaultFetchPullRequest,
  type FetchedPullRequest,
  type PullRequestRef
} from "../../github/diff.js";
import { setPausedState, postPullRequestComment, replyToReviewComment } from "../../github/review.js";
import {
  parseCommand,
  commandHelpText,
  isTrustedCommandAuthor,
  type ParsedCommand
} from "../../review/commands.js";
import {
  generateChatReply as defaultGenerateChatReply,
  DEFAULT_CHAT_MAX_TOKENS,
  type ChatReplyInput,
  type ChatThreadContext
} from "../../review/chat.js";
import { parseDiff } from "../../review/parse-diff.js";
import { applyDiffLimits } from "../../review/size-guards.js";
import { renderGuardedDiff } from "../../review/render-diff.js";
import { redactSecrets, isSensitiveFile } from "../../review/redact.js";
import { filterSensitiveDiffFiles } from "../../review/sensitive-diff.js";
import { loadConfig } from "../../config/loader.js";
import { resolveProviderConfig, type ProviderConfig, type TokenUsage } from "../../providers/index.js";
import {
  resolveRepo,
  runReviewWithOptions,
  resolveConfigLoadOptions,
  resolveWorkspace,
  resolveGuidelinesWorkspace,
  loadGuidelines,
  resolveOrgGuidelinesPath,
  composeGuidelines
} from "./review.js";

/**
 * `prowl-review command` — handle an `@prowl-review <verb>` bot command from a PR
 * comment event (backlog #26).
 *
 * Reads the `issue_comment` / `pull_request_review_comment` event, parses the
 * command (verb allowlist, #14), trust-gates the author (owner/member/
 * collaborator, like break-glass #52), and dispatches:
 *  - `review` / `full review` → re-run the pipeline (incremental, or a full
 *    re-scan); always runs, ignoring pause (it's an explicit request).
 *  - `break glass <head-sha>` → re-run the pipeline so the approval gate can
 *    consume the trusted override comment.
 *  - `pause` / `resume` → toggle the auto-review pause flag persisted in the
 *    summary comment's state marker.
 *  - `help` / anything unrecognized → reply with the supported-command list.
 *
 * Deferred (still #26): `ignore` / `resolve` / `configure` — these target a
 * specific finding/thread from the reply context, which rides with the #30
 * learnings write-back and #22 reply infra.
 */

/** A bot-command comment event reduced to what dispatch + chat need. */
export interface CommentEvent {
  body: string;
  association: string | undefined;
  login: string | undefined;
  pullNumber: number;
  /** The comment's REST id (for in-thread chat replies, #27). */
  commentId?: number;
  /** True when the event is an inline review-comment (vs a top-level PR comment). */
  isReviewComment: boolean;
  /** Inline-thread context, present on review-comment events (#27). */
  thread?: ChatThreadContext;
}

function safeInlineDiffHunk(path: string, diffHunk: string | undefined): string | undefined {
  if (!diffHunk || isSensitiveFile(path)) {
    return undefined;
  }
  return redactSecrets(diffHunk).text || undefined;
}

/** Read and normalize the triggering comment event from `GITHUB_EVENT_PATH`. */
export function resolveCommentEvent(env: NodeJS.ProcessEnv = process.env): CommentEvent | null {
  const path = env.GITHUB_EVENT_PATH;
  if (!path || !existsSync(path)) {
    return null;
  }
  try {
    const event = JSON.parse(readFileSync(path, "utf8")) as {
      comment?: {
        id?: number;
        body?: string;
        author_association?: string;
        user?: { login?: string; type?: string } | null;
        path?: string;
        line?: number | null;
        original_line?: number | null;
        in_reply_to_id?: number | null;
        diff_hunk?: string;
      };
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
    // An inline review-comment event carries a top-level `pull_request` plus a
    // file path. Pathless PR comment events fall back to a top-level PR reply.
    const isReviewComment = Boolean(event.pull_request) && !event.issue && Boolean(comment.path);
    let pullNumber: number | undefined;
    if (event.issue) {
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

    const thread: ChatThreadContext | undefined =
      isReviewComment && comment.path
        ? {
            path: comment.path,
            line: comment.line ?? comment.original_line ?? undefined,
            diffHunk: safeInlineDiffHunk(comment.path, comment.diff_hunk)
          }
        : undefined;

    return {
      body: comment.body,
      association: comment.author_association,
      login: comment.user?.login ?? undefined,
      pullNumber,
      commentId: isReviewComment ? (comment.in_reply_to_id ?? comment.id) : comment.id,
      isReviewComment,
      thread
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
  /** Answer a free-form `@prowl-review` question (#27). When absent, dispatch falls back to help. */
  respond?: (question: string) => Promise<void>;
}

/** Result of dispatching a parsed command (for logging/tests). */
export interface CommandOutcome {
  verb: ParsedCommand["verb"];
  /** True when the command triggered a review run. */
  reviewed: boolean;
  /** True when a free-form question was answered with a chat reply (#27). */
  responded?: boolean;
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
  const respond = ctx.deps?.respond;
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
    case "break-glass":
      await runReview({ pr, repo }, { respectPause: false });
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
      await postComment(ctx.octokit, ctx.ref, commandHelpText());
      return { verb: parsed.verb, reviewed: false };
    case "unknown":
      // A free-form mention is a question → answer it in-thread (#27). Without a
      // chat capability wired in, fall back to the command help.
      if (respond) {
        await respond(parsed.argument);
        return { verb: parsed.verb, reviewed: false, responded: true };
      }
      await postComment(ctx.octokit, ctx.ref, commandHelpText());
      return { verb: parsed.verb, reviewed: false };
    default:
      await postComment(ctx.octokit, ctx.ref, commandHelpText());
      return { verb: parsed.verb, reviewed: false };
  }
}

/** Cap the diff fed into a chat reply, so the prompt stays bounded. */
const CHAT_DIFF_MAX_BYTES = 60_000;

/** Injectable side effects for the chat-reply orchestration (#27). */
export interface ChatHandlerDeps {
  fetchPr?: (octokit: OctokitLike, ref: PullRequestRef) => Promise<FetchedPullRequest>;
  generateReply?: (
    input: ChatReplyInput,
    options: { config: ProviderConfig; maxTokens?: number }
  ) => Promise<{ reply: string; usage: TokenUsage }>;
  postIssueComment?: (octokit: OctokitLike, ref: PullRequestRef, body: string) => Promise<void>;
  postReviewReply?: (octokit: OctokitLike, ref: PullRequestRef, commentId: number, body: string) => Promise<void>;
}

/**
 * Answer a free-form `@prowl-review` question (#27): fetch the PR, build a
 * size-guarded + secret-redacted diff context, generate a grounded reply, and
 * post it — in-thread for an inline review comment, or as a PR comment otherwise.
 */
export async function respondToComment(params: {
  octokit: OctokitLike;
  ref: PullRequestRef;
  event: CommentEvent;
  question: string;
  config: ProviderConfig;
  guidelines?: string;
  maxTokens?: number;
  deps?: ChatHandlerDeps;
}): Promise<void> {
  const fetchPr = params.deps?.fetchPr ?? defaultFetchPullRequest;
  const generateReply = params.deps?.generateReply ?? defaultGenerateChatReply;
  const postIssueComment = params.deps?.postIssueComment ?? postPullRequestComment;
  const postReviewReply = params.deps?.postReviewReply ?? replyToReviewComment;

  const { meta, diff } = await fetchPr(params.octokit, params.ref);
  const parsed = parseDiff(diff);
  const filtered = filterSensitiveDiffFiles(parsed.files);
  const guarded = applyDiffLimits({ files: filtered.files }, { maxDiffBytes: CHAT_DIFF_MAX_BYTES });
  const rendered = renderGuardedDiff(guarded.files);
  const redactedDiff = redactSecrets(rendered).text;
  const diffNote = guarded.truncated ? "\n\n(diff truncated to fit the chat context)" : "";

  const input: ChatReplyInput = {
    question: params.question,
    prTitle: meta.title,
    prBody: meta.body,
    diff: `${redactedDiff}${diffNote}`,
    guidelines: params.guidelines,
    thread: params.event.thread
  };
  const { reply } = await generateReply(input, {
    config: params.config,
    maxTokens: params.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS
  });
  // The reply is our bot's own output; redact defensively in case the model
  // echoed a secret from the diff.
  const safeReply = redactSecrets(reply).text;
  const body = `${safeReply}\n\n<sub>🦝 prowl-review — reply to your \`@prowl-review\` comment</sub>`;

  if (params.event.isReviewComment && params.event.commentId !== undefined) {
    await postReviewReply(params.octokit, params.ref, params.event.commentId, body);
  } else {
    await postIssueComment(params.octokit, params.ref, body);
  }
}

/** Compose trusted org + repo guidelines for a chat reply (mirrors the review path). */
function loadChatGuidelines(): string | undefined {
  const guidelinesRoot = resolveGuidelinesWorkspace();
  const repoGuidelines = guidelinesRoot ? loadGuidelines(guidelinesRoot) : undefined;
  const orgPath = resolveOrgGuidelinesPath();
  let orgGuidelines: string | undefined;
  if (orgPath && existsSync(orgPath)) {
    try {
      orgGuidelines = readFileSync(orgPath, "utf8");
    } catch {
      orgGuidelines = undefined;
    }
  }
  return composeGuidelines(orgGuidelines, repoGuidelines);
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

      // Free-form questions (#27) answer in-thread. The provider config is
      // resolved lazily inside the closure so non-chat verbs (pause/resume) never
      // require an AI key.
      const respond = async (question: string): Promise<void> => {
        const root = resolveWorkspace();
        const { config } = loadConfig(resolveConfigLoadOptions({}, root));
        const providerConfig = resolveProviderConfig(process.env, {
          provider: config.provider,
          model: config.model
        });
        await respondToComment({
          octokit,
          ref,
          event,
          question,
          config: providerConfig,
          guidelines: loadChatGuidelines()
        });
      };

      const outcome = await dispatchCommand(parsed, { octokit, ref, deps: { respond } });
      console.log(
        `prowl-review: handled \`@prowl-review ${parsed.verb}\` on ${owner}/${repo}#${event.pullNumber}` +
          (outcome.reviewed ? " (review run)" : outcome.responded ? " (chat reply)" : "")
      );
    });

  return command;
}

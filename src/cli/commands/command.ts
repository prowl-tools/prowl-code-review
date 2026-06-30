import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { createOctokit, type OctokitLike } from "../../github/client.js";
import {
  fetchPullRequest as defaultFetchPullRequest,
  type FetchedPullRequest,
  type PullRequestRef
} from "../../github/diff.js";
import {
  fetchReviewCommentBody as defaultFetchReviewCommentBody,
  fetchReviewCommentFingerprints as defaultFetchReviewCommentFingerprints,
  fetchReviewCommentLearningEntries as defaultFetchReviewCommentLearningEntries,
  recordRepoLearnings as defaultRecordRepoLearnings,
  setPausedState,
  setIgnoredFindings,
  setConfigOverrides,
  postPullRequestComment,
  replyToReviewComment
} from "../../github/review.js";
import type { RepoLearningEntry } from "../../review/learnings.js";
import {
  fetchReviewThreads as defaultFetchReviewThreads,
  resolveReviewThread as defaultResolveReviewThread
} from "../../github/threads.js";
import {
  parseCommand,
  commandHelpText,
  parseConfigureArgs,
  configureHelpText,
  isTrustedCommandAuthor,
  type ParsedCommand
} from "../../review/commands.js";
import type { ReviewState } from "../../review/state.js";
import {
  generateChatReply as defaultGenerateChatReply,
  sanitizeChatReplyMarkdown,
  type ChatReplyInput,
  type ChatThreadContext
} from "../../review/chat.js";
import {
  generateAssist as defaultGenerateAssist,
  assistLabel,
  sanitizeAssistMarkdown,
  type AssistInput,
  type AssistKind
} from "../../review/generate.js";
import { parseDiff } from "../../review/parse-diff.js";
import { applyDiffLimits } from "../../review/size-guards.js";
import { renderGuardedDiff } from "../../review/render-diff.js";
import { redactSecrets, isSensitiveFile } from "../../review/redact.js";
import { filterSensitiveDiffFiles, isSensitiveDiffFile } from "../../review/sensitive-diff.js";
import { DEFAULT_IGNORE_GLOBS, filterIgnoredDiffFiles } from "../../review/ignore.js";
import { REVIEW_MARKER } from "../../review/walkthrough.js";
import type { DiffFile } from "../../review/diff-types.js";
import { loadConfig } from "../../config/loader.js";
import type { ProwlReviewConfig } from "../../config/schema.js";
import { resolveProviderConfig, type ProviderConfig, type TokenUsage } from "../../providers/index.js";
import {
  resolveRepo,
  runReviewWithOptions,
  resolveConfigLoadOptions,
  resolveForkReviewDecisionFromEvent,
  resolveForkReviewDecisionForRun,
  resolveWorkspace,
  resolveTrustedConfigBase,
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
 *  - `docstrings` / `tests` → generate docstrings or unit-test stubs for the
 *    changed code and post them (#33).
 *  - `resolve` → resolve the finding thread a reply targets + mute it (#26).
 *  - `configure <key=value …>` → set per-PR review settings (#26).
 *  - `help` / anything unrecognized → reply with the supported-command list.
 */

/** A bot-command comment event reduced to what dispatch + chat need. */
export interface CommentEvent {
  body: string;
  association: string | undefined;
  login: string | undefined;
  pullNumber: number;
  /** The comment's REST id (for in-thread chat replies, #27). */
  commentId?: number;
  /** Root inline review-comment id when this event is itself an inline reply. */
  parentCommentId?: number;
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

const INLINE_FINDING_MARKER = "<!-- prowl-review:finding ";

function withoutSensitiveThreadText(thread: ChatThreadContext): ChatThreadContext {
  const safeThread: ChatThreadContext = { path: thread.path };
  if (thread.line !== undefined) {
    safeThread.line = thread.line;
  }
  return { ...safeThread, diffHunk: undefined };
}

function isProwlAuthoredComment(body: string): boolean {
  return body.includes(REVIEW_MARKER) || body.includes(INLINE_FINDING_MARKER);
}

function safeThreadContext(thread: ChatThreadContext | undefined, files: DiffFile[]): ChatThreadContext | undefined {
  if (!thread) {
    return undefined;
  }
  const file = files.find((candidate) => candidate.path === thread.path);
  if (!file || isSensitiveDiffFile(file)) {
    return withoutSensitiveThreadText(thread);
  }
  return thread;
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
    if (isProwlAuthoredComment(comment.body)) {
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
      parentCommentId: isReviewComment ? (comment.in_reply_to_id ?? undefined) : undefined,
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
  /** Mute the finding the `@prowl-review ignore` reply targets (#30). When absent, dispatch replies with guidance. */
  ignore?: () => Promise<{ ignored: number }>;
  /** Generate docstrings / unit-test stubs for the changed code (#33). When absent, dispatch falls back to help. */
  generate?: (kind: AssistKind) => Promise<void>;
  /** Resolve the finding thread an `@prowl-review resolve` reply targets (#26). When absent, dispatch replies with guidance. */
  resolve?: () => Promise<{ resolved: number }>;
  /** Apply per-PR review settings from `@prowl-review configure` (#26). When absent, dispatch falls back to help. */
  configure?: (argument: string) => Promise<{ ok: boolean }>;
}

/** Result of dispatching a parsed command (for logging/tests). */
export interface CommandOutcome {
  verb: ParsedCommand["verb"];
  /** True when the command triggered a review run. */
  reviewed: boolean;
  /** True when a free-form question was answered with a chat reply (#27). */
  responded?: boolean;
  /** Number of finding fingerprints muted by an `ignore` command (#30). */
  ignored?: number;
  /** The assist generated by a `docstrings` / `tests` command (#33). */
  generated?: AssistKind;
  /** Number of finding threads resolved by a `resolve` command (#26). */
  resolved?: number;
  /** True when a `configure` command applied per-PR review settings (#26). */
  configured?: boolean;
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
  const ignore = ctx.deps?.ignore;
  const generate = ctx.deps?.generate;
  const resolve = ctx.deps?.resolve;
  const configure = ctx.deps?.configure;
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
    case "ignore":
      // Mute the targeted finding (#30). Without the wired handler (e.g. a
      // top-level `ignore` with no thread), fall back to guidance via help.
      if (ignore) {
        const result = await ignore();
        return { verb: parsed.verb, reviewed: false, ignored: result.ignored };
      }
      await postComment(ctx.octokit, ctx.ref, commandHelpText());
      return { verb: parsed.verb, reviewed: false };
    case "resolve":
      // Resolve the finding thread this reply targets (#26). Without the wired
      // handler (e.g. a top-level `resolve` with no thread), reply with guidance.
      if (resolve) {
        const result = await resolve();
        return { verb: parsed.verb, reviewed: false, resolved: result.resolved };
      }
      await postComment(ctx.octokit, ctx.ref, commandHelpText());
      return { verb: parsed.verb, reviewed: false };
    case "configure":
      // Apply per-PR review settings (#26). Without the wired handler, fall back to help.
      if (configure) {
        const result = await configure(parsed.argument);
        return { verb: parsed.verb, reviewed: false, configured: result.ok };
      }
      await postComment(ctx.octokit, ctx.ref, commandHelpText());
      return { verb: parsed.verb, reviewed: false };
    case "docstrings":
    case "tests":
      // Generate the requested assist (#33). Without the wired generator (no AI
      // capability), fall back to the command help.
      if (generate) {
        await generate(parsed.verb);
        return { verb: parsed.verb, reviewed: false, generated: parsed.verb };
      }
      await postComment(ctx.octokit, ctx.ref, commandHelpText());
      return { verb: parsed.verb, reviewed: false };
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
  fetchReviewCommentBody?: (octokit: OctokitLike, ref: PullRequestRef, commentId: number) => Promise<string | undefined>;
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
  ignore?: readonly string[];
  deps?: ChatHandlerDeps;
}): Promise<void> {
  const fetchPr = params.deps?.fetchPr ?? defaultFetchPullRequest;
  const generateReply = params.deps?.generateReply ?? defaultGenerateChatReply;
  const postIssueComment = params.deps?.postIssueComment ?? postPullRequestComment;
  const postReviewReply = params.deps?.postReviewReply ?? replyToReviewComment;
  const fetchReviewCommentBody = params.deps?.fetchReviewCommentBody ?? defaultFetchReviewCommentBody;

  const { meta, diff } = await fetchPr(params.octokit, params.ref);
  const parsed = parseDiff(diff);
  const filtered = filterSensitiveDiffFiles(parsed.files);
  const ignorePatterns = params.ignore ?? DEFAULT_IGNORE_GLOBS;
  const { files: reviewableFiles } = filterIgnoredDiffFiles(filtered.files, ignorePatterns);
  const guarded = applyDiffLimits({ files: reviewableFiles }, { maxDiffBytes: CHAT_DIFF_MAX_BYTES });
  const rendered = renderGuardedDiff(guarded.files);
  const redactedDiff = redactSecrets(rendered).text;
  const diffNote = guarded.truncated ? "\n\n(diff truncated to fit the chat context)" : "";
  const parentCommentBody =
    params.event.parentCommentId !== undefined
      ? await fetchReviewCommentBody(params.octokit, params.ref, params.event.parentCommentId)
      : undefined;
  const thread =
    params.event.thread && parentCommentBody
      ? { ...params.event.thread, parentCommentBody }
      : params.event.thread;

  const input: ChatReplyInput = {
    question: params.question,
    prTitle: meta.title,
    prBody: meta.body,
    diff: `${redactedDiff}${diffNote}`,
    guidelines: params.guidelines,
    thread: safeThreadContext(thread, parsed.files)
  };
  const { reply } = await generateReply(input, {
    config: params.config,
    maxTokens: params.maxTokens
  });
  // The reply is our bot's own output; redact defensively in case the model
  // echoed a secret from the diff.
  const safeReply = sanitizeChatReplyMarkdown(redactSecrets(reply).text);
  const body = `${safeReply}\n\n<sub>🦝 prowl-review — reply to your \`&#64;prowl-review\` comment</sub>`;

  if (params.event.isReviewComment && params.event.commentId !== undefined) {
    await postReviewReply(params.octokit, params.ref, params.event.commentId, body);
  } else {
    await postIssueComment(params.octokit, params.ref, body);
  }
}

/** Injectable side effects for the assist-generation orchestration (#33). */
export interface GenerateHandlerDeps {
  fetchPr?: (octokit: OctokitLike, ref: PullRequestRef) => Promise<FetchedPullRequest>;
  generate?: (
    input: AssistInput,
    options: { config: ProviderConfig; maxTokens?: number }
  ) => Promise<{ content: string; usage: TokenUsage }>;
  postIssueComment?: (octokit: OctokitLike, ref: PullRequestRef, body: string) => Promise<void>;
  postReviewReply?: (octokit: OctokitLike, ref: PullRequestRef, commentId: number, body: string) => Promise<void>;
  fetchReviewCommentBody?: (octokit: OctokitLike, ref: PullRequestRef, commentId: number) => Promise<string | undefined>;
}

/**
 * Handle `@prowl-review docstrings` / `tests` (#33): fetch the PR, build a
 * size-guarded + secret-redacted diff context, generate the assist, and post it —
 * in-thread for an inline review comment, or as a PR comment otherwise. Mirrors
 * {@link respondToComment}.
 */
export async function generateForComment(params: {
  octokit: OctokitLike;
  ref: PullRequestRef;
  event: CommentEvent;
  kind: AssistKind;
  config: ProviderConfig;
  guidelines?: string;
  maxTokens?: number;
  ignore?: readonly string[];
  deps?: GenerateHandlerDeps;
}): Promise<void> {
  const fetchPr = params.deps?.fetchPr ?? defaultFetchPullRequest;
  const generate = params.deps?.generate ?? defaultGenerateAssist;
  const postIssueComment = params.deps?.postIssueComment ?? postPullRequestComment;
  const postReviewReply = params.deps?.postReviewReply ?? replyToReviewComment;
  const fetchReviewCommentBody = params.deps?.fetchReviewCommentBody ?? defaultFetchReviewCommentBody;

  const { meta, diff } = await fetchPr(params.octokit, params.ref);
  const parsed = parseDiff(diff);
  const filtered = filterSensitiveDiffFiles(parsed.files);
  const ignorePatterns = params.ignore ?? DEFAULT_IGNORE_GLOBS;
  const { files: reviewableFiles } = filterIgnoredDiffFiles(filtered.files, ignorePatterns);
  const guarded = applyDiffLimits({ files: reviewableFiles }, { maxDiffBytes: CHAT_DIFF_MAX_BYTES });
  const rendered = renderGuardedDiff(guarded.files);
  const redactedDiff = redactSecrets(rendered).text;
  const diffNote = guarded.truncated ? "\n\n(diff truncated to fit the context)" : "";

  const parentCommentBody =
    params.event.parentCommentId !== undefined
      ? await fetchReviewCommentBody(params.octokit, params.ref, params.event.parentCommentId)
      : undefined;
  const thread =
    params.event.thread && parentCommentBody
      ? { ...params.event.thread, parentCommentBody }
      : params.event.thread;

  const input: AssistInput = {
    kind: params.kind,
    prTitle: meta.title,
    prBody: meta.body,
    diff: `${redactedDiff}${diffNote}`,
    guidelines: params.guidelines,
    thread: safeThreadContext(thread, parsed.files)
  };
  const { content } = await generate(input, { config: params.config, maxTokens: params.maxTokens });
  // The output is our bot's own; sanitize + redact defensively at the post boundary.
  const safeContent = sanitizeAssistMarkdown(redactSecrets(content).text);
  const body = `${safeContent}\n\n<sub>🦝 prowl-review — generated ${assistLabel(params.kind)} for your \`&#64;prowl-review ${params.kind}\` request. Review before committing.</sub>`;

  if (params.event.isReviewComment && params.event.commentId !== undefined) {
    await postReviewReply(params.octokit, params.ref, params.event.commentId, body);
  } else {
    await postIssueComment(params.octokit, params.ref, body);
  }
}

/** Compose trusted org + repo guidelines for a chat reply (mirrors the review path). */
export function loadChatGuidelines(): string | undefined {
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

/** Injectable side effects shared by the `ignore` / `resolve` repo-wide learnings step (#30). */
export interface RepoLearningsDeps {
  /** Recover fingerprint + label entries from a finding's comment for repo-wide muting. */
  fetchLearningEntries?: (
    octokit: OctokitLike,
    ref: PullRequestRef,
    commentId: number
  ) => Promise<RepoLearningEntry[]>;
  /** Persist muted findings to the repo-wide learnings store issue. */
  recordLearnings?: (
    octokit: OctokitLike,
    ref: PullRequestRef,
    entries: RepoLearningEntry[]
  ) => Promise<{ added: number }>;
}

/**
 * Persist a mute to the repo-wide learnings store (#30) so it teaches future PRs.
 * Opt-in (`enabled`) and strictly best-effort: any failure leaves the per-PR mute
 * intact and reports 0 taught, so repo-wide persistence never sinks the command.
 */
async function teachRepoWide(params: {
  octokit: OctokitLike;
  ref: PullRequestRef;
  rootId: number;
  enabled?: boolean;
  deps?: RepoLearningsDeps;
}): Promise<number> {
  if (!params.enabled) {
    return 0;
  }
  const fetchLearningEntries = params.deps?.fetchLearningEntries ?? defaultFetchReviewCommentLearningEntries;
  const recordLearnings = params.deps?.recordLearnings ?? defaultRecordRepoLearnings;
  try {
    const entries = await fetchLearningEntries(params.octokit, params.ref, params.rootId);
    if (entries.length === 0) {
      return 0;
    }
    const { added } = await recordLearnings(params.octokit, params.ref, entries);
    return added;
  } catch {
    return 0;
  }
}

/** Injectable side effects for the `ignore` orchestration (#30). */
export interface IgnoreHandlerDeps extends RepoLearningsDeps {
  fetchFingerprints?: (octokit: OctokitLike, ref: PullRequestRef, commentId: number) => Promise<string[]>;
  setIgnored?: (
    octokit: OctokitLike,
    ref: PullRequestRef,
    fingerprints: string[]
  ) => Promise<{ added: number; total: number }>;
  postReviewReply?: (octokit: OctokitLike, ref: PullRequestRef, commentId: number, body: string) => Promise<void>;
  postIssueComment?: (octokit: OctokitLike, ref: PullRequestRef, body: string) => Promise<void>;
}

/**
 * Mute the finding an `@prowl-review ignore` reply targets (#30): recover the
 * finding fingerprint from the bot's root comment in the thread, persist it to
 * the per-PR ignore list (#12 state marker), and acknowledge in-thread. Only
 * meaningful as a reply on a finding's comment; otherwise it replies with
 * guidance. Returns how many fingerprints were newly muted.
 */
export async function handleIgnore(params: {
  octokit: OctokitLike;
  ref: PullRequestRef;
  event: CommentEvent;
  /** Also persist the mute repo-wide so it teaches future PRs (#30); opt-in. */
  repoLearnings?: boolean;
  deps?: IgnoreHandlerDeps;
}): Promise<{ ignored: number }> {
  const fetchFingerprints = params.deps?.fetchFingerprints ?? defaultFetchReviewCommentFingerprints;
  const setIgnored = params.deps?.setIgnored ?? setIgnoredFindings;
  const postReviewReply = params.deps?.postReviewReply ?? replyToReviewComment;
  const postIssueComment = params.deps?.postIssueComment ?? postPullRequestComment;

  const ack = async (body: string): Promise<void> => {
    if (params.event.isReviewComment && params.event.commentId !== undefined) {
      await postReviewReply(params.octokit, params.ref, params.event.commentId, body);
    } else {
      await postIssueComment(params.octokit, params.ref, body);
    }
  };

  const rootId =
    params.event.parentCommentId ?? (params.event.isReviewComment ? params.event.commentId : undefined);
  if (rootId === undefined) {
    await ack("ℹ️ Reply `@prowl-review ignore` directly on a finding's comment to mute it on this PR.");
    return { ignored: 0 };
  }

  const fingerprints = await fetchFingerprints(params.octokit, params.ref, rootId);
  if (fingerprints.length === 0) {
    await ack("ℹ️ I couldn't identify a prowl-review finding on that thread to ignore.");
    return { ignored: 0 };
  }

  const { added } = await setIgnored(params.octokit, params.ref, fingerprints);
  const taughtRepoWide = await teachRepoWide({
    octokit: params.octokit,
    ref: params.ref,
    rootId,
    enabled: params.repoLearnings,
    deps: params.deps
  });
  await ack(
    taughtRepoWide > 0
      ? "👍 Ignored — muted on this PR and added to this repo's learned patterns, so it won't be raised on future PRs either."
      : "👍 Ignored — I won't raise this finding again on this PR. Comment `@prowl-review review` to refresh."
  );
  return { ignored: added };
}

/** Injectable side effects for the `resolve` orchestration (#26). */
export interface ResolveHandlerDeps extends RepoLearningsDeps {
  fetchFingerprints?: (octokit: OctokitLike, ref: PullRequestRef, commentId: number) => Promise<string[]>;
  fetchThreads?: typeof defaultFetchReviewThreads;
  resolveThread?: (octokit: OctokitLike, threadId: string) => Promise<boolean>;
  setIgnored?: (
    octokit: OctokitLike,
    ref: PullRequestRef,
    fingerprints: string[]
  ) => Promise<{ added: number; total: number }>;
  postReviewReply?: (octokit: OctokitLike, ref: PullRequestRef, commentId: number, body: string) => Promise<void>;
  postIssueComment?: (octokit: OctokitLike, ref: PullRequestRef, body: string) => Promise<void>;
}

const RESOLVE_THREAD_CONCURRENCY = 4;

/**
 * Resolve the finding thread an `@prowl-review resolve` reply targets (#26):
 * recover the finding fingerprint(s) from the bot's root comment, resolve the
 * matching open review thread(s) via GraphQL, and mute the fingerprint(s) so the
 * finding isn't re-raised on the next review (the difference from `ignore`, which
 * leaves the thread open). Only meaningful as a reply on a finding's comment;
 * otherwise it replies with guidance. Tolerant — it leaves the finding unmuted
 * unless the matching thread(s) resolve and the mute state persists cleanly.
 */
export async function handleResolve(params: {
  octokit: OctokitLike;
  ref: PullRequestRef;
  event: CommentEvent;
  /** Also persist the mute repo-wide so it teaches future PRs (#30); opt-in. */
  repoLearnings?: boolean;
  deps?: ResolveHandlerDeps;
}): Promise<{ resolved: number }> {
  const fetchFingerprints = params.deps?.fetchFingerprints ?? defaultFetchReviewCommentFingerprints;
  const fetchThreads = params.deps?.fetchThreads ?? defaultFetchReviewThreads;
  const resolveThread = params.deps?.resolveThread ?? defaultResolveReviewThread;
  const setIgnored = params.deps?.setIgnored ?? setIgnoredFindings;
  const postReviewReply = params.deps?.postReviewReply ?? replyToReviewComment;
  const postIssueComment = params.deps?.postIssueComment ?? postPullRequestComment;

  const ack = async (body: string): Promise<void> => {
    if (params.event.isReviewComment && params.event.commentId !== undefined) {
      await postReviewReply(params.octokit, params.ref, params.event.commentId, body);
    } else {
      await postIssueComment(params.octokit, params.ref, body);
    }
  };

  const rootId =
    params.event.parentCommentId ?? (params.event.isReviewComment ? params.event.commentId : undefined);
  if (rootId === undefined) {
    await ack("ℹ️ Reply `@prowl-review resolve` directly on a finding's comment to resolve its thread.");
    return { resolved: 0 };
  }

  const fingerprints = await fetchFingerprints(params.octokit, params.ref, rootId);
  if (fingerprints.length === 0) {
    await ack("ℹ️ I couldn't identify a prowl-review finding on that thread to resolve.");
    return { resolved: 0 };
  }

  // Resolve the open thread(s) carrying these fingerprints, then mute so the
  // finding isn't re-raised on the next review.
  const targets = new Set(fingerprints);
  const threads = await fetchThreads(params.octokit, params.ref);
  const matchingThreads = threads.filter(
    (thread) => !thread.isResolved && thread.fingerprints.some((fingerprint) => targets.has(fingerprint))
  );
  let resolved = 0;
  for (let index = 0; index < matchingThreads.length; index += RESOLVE_THREAD_CONCURRENCY) {
    const batch = matchingThreads.slice(index, index + RESOLVE_THREAD_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((thread) => resolveThread(params.octokit, thread.id)));
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        resolved += 1;
      }
    }
  }
  if (matchingThreads.length === 0 || resolved !== matchingThreads.length) {
    await ack("⚠️ I couldn't resolve this finding's thread cleanly, so I left it unmuted.");
    return { resolved };
  }
  try {
    await setIgnored(params.octokit, params.ref, fingerprints);
  } catch {
    await ack("⚠️ I resolved the matching thread, but couldn't mute the finding for future reviews.");
    return { resolved };
  }
  const taughtRepoWide = await teachRepoWide({
    octokit: params.octokit,
    ref: params.ref,
    rootId,
    enabled: params.repoLearnings,
    deps: params.deps
  });
  await ack(
    taughtRepoWide > 0
      ? "✅ Resolved — thread resolved, muted on this PR, and added to this repo's learned patterns for future PRs."
      : "✅ Resolved — marked this finding's thread resolved and muted it on this PR."
  );
  return { resolved };
}

/** Injectable side effects for the `configure` orchestration (#26). */
export interface ConfigureHandlerDeps {
  setOverrides?: typeof setConfigOverrides;
  postReviewReply?: (octokit: OctokitLike, ref: PullRequestRef, commentId: number, body: string) => Promise<void>;
  postIssueComment?: (octokit: OctokitLike, ref: PullRequestRef, body: string) => Promise<void>;
}

/**
 * Apply per-PR review settings from `@prowl-review configure` (#26): parse the
 * allowlisted key=value settings (or `reset`), persist them in the summary state
 * marker, and acknowledge. Invalid/empty input replies with usage instead of
 * changing anything. Returns whether settings were applied.
 */
export async function handleConfigure(params: {
  octokit: OctokitLike;
  ref: PullRequestRef;
  event: CommentEvent;
  argument: string;
  deps?: ConfigureHandlerDeps;
}): Promise<{ ok: boolean }> {
  const setOverrides = params.deps?.setOverrides ?? setConfigOverrides;
  const postReviewReply = params.deps?.postReviewReply ?? replyToReviewComment;
  const postIssueComment = params.deps?.postIssueComment ?? postPullRequestComment;

  const ack = async (body: string): Promise<void> => {
    if (params.event.isReviewComment && params.event.commentId !== undefined) {
      await postReviewReply(params.octokit, params.ref, params.event.commentId, body);
    } else {
      await postIssueComment(params.octokit, params.ref, body);
    }
  };

  const parsed = parseConfigureArgs(params.argument);
  if (parsed.errors.length > 0 || (parsed.empty && !parsed.reset)) {
    await ack(configureHelpText(parsed.errors));
    return { ok: false };
  }

  let overrides: ReviewState["configOverrides"];
  try {
    const result = await setOverrides(params.octokit, params.ref, {
      overrides: parsed.overrides,
      reset: parsed.reset
    });
    overrides = result.overrides;
  } catch {
    await ack("⚠️ I couldn't save per-PR review settings, so no settings were changed.");
    return { ok: false };
  }

  if (parsed.reset || !overrides) {
    await ack("⚙️ Cleared per-PR review settings — back to the repository config. Comment `@prowl-review review` to refresh.");
    return { ok: true };
  }
  const summary = Object.entries(overrides)
    .map(([key, value]) => `${key}=${value === true ? "on" : value === false ? "off" : value}`)
    .join(", ");
  await ack(`⚙️ Updated per-PR review settings: ${summary}. They apply on the next review (\`@prowl-review review\`).`);
  return { ok: true };
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

      // Load the repo config honoring fork-config trust. Shared by the AI verbs
      // (which also need a provider key) and the repo-wide-learnings flag read for
      // ignore/resolve (#30), which must not require a key.
      const loadCommandConfig = async (): Promise<ProwlReviewConfig> => {
        const root = resolveWorkspace();
        const eventFork = resolveForkReviewDecisionFromEvent(process.env);
        const fork = eventFork ?? (await resolveForkReviewDecisionForRun(octokit, ref));
        return loadConfig(
          resolveConfigLoadOptions({}, root, process.env, fork.isFork, resolveTrustedConfigBase(process.env))
        ).config;
      };

      // AI-backed verbs (chat #27, docstrings/tests #33) resolve the provider
      // config lazily so non-AI verbs (pause/resume/ignore) never require a key.
      const resolveAiContext = async (): Promise<{ config: ProviderConfig; ignore?: readonly string[] }> => {
        const config = await loadCommandConfig();
        return {
          config: resolveProviderConfig(process.env, { provider: config.provider, model: config.model }),
          ignore: config.ignore
        };
      };

      // Free-form questions (#27) answer in-thread.
      const respond = async (question: string): Promise<void> => {
        const { config, ignore: ignorePatterns } = await resolveAiContext();
        await respondToComment({
          octokit,
          ref,
          event,
          question,
          config,
          guidelines: loadChatGuidelines(),
          ignore: ignorePatterns
        });
      };

      // Generate docstrings / unit-test stubs (#33).
      const generate = async (kind: AssistKind): Promise<void> => {
        const { config, ignore: ignorePatterns } = await resolveAiContext();
        await generateForComment({
          octokit,
          ref,
          event,
          kind,
          config,
          guidelines: loadChatGuidelines(),
          ignore: ignorePatterns
        });
      };

      const ignore = async (): Promise<{ ignored: number }> => {
        const config = await loadCommandConfig();
        return handleIgnore({ octokit, ref, event, repoLearnings: config.review?.repoLearnings === true });
      };
      const resolve = async (): Promise<{ resolved: number }> => {
        const config = await loadCommandConfig();
        return handleResolve({ octokit, ref, event, repoLearnings: config.review?.repoLearnings === true });
      };
      const configure = (argument: string): Promise<{ ok: boolean }> =>
        handleConfigure({ octokit, ref, event, argument });

      const outcome = await dispatchCommand(parsed, {
        octokit,
        ref,
        deps: { respond, ignore, generate, resolve, configure }
      });
      const suffix = outcome.reviewed
        ? " (review run)"
        : outcome.responded
          ? " (chat reply)"
          : outcome.generated
            ? ` (generated ${assistLabel(outcome.generated)})`
            : outcome.ignored
              ? ` (muted ${outcome.ignored} finding(s))`
              : outcome.resolved !== undefined
                ? ` (resolved ${outcome.resolved} thread(s))`
                : outcome.configured
                  ? " (settings updated)"
                  : "";
      console.log(
        `prowl-review: handled \`@prowl-review ${parsed.verb}\` on ${owner}/${repo}#${event.pullNumber}${suffix}`
      );
    });

  return command;
}

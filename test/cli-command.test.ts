import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchCommand,
  loadChatGuidelines,
  resolveCommentEvent,
  respondToComment,
  type CommandDispatchDeps
} from "../src/cli/commands/command.js";
import type { OctokitLike } from "../src/github/client.js";

const ref = { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 };
const octokit = {} as unknown as OctokitLike;
const AWS_ACCESS_KEY = ["AKIA", "1234567890ABCD99"].join("");

function deps(over: Partial<CommandDispatchDeps> = {}): CommandDispatchDeps {
  return {
    runReview: vi.fn(async () => {}),
    setPaused: vi.fn(async () => ({ updatedExisting: true })),
    postComment: vi.fn(async () => {}),
    ...over
  };
}

describe("dispatchCommand (#26)", () => {
  it("runs an incremental review for `review`, ignoring pause", async () => {
    const d = deps();
    const outcome = await dispatchCommand({ verb: "review", argument: "" }, { octokit, ref, deps: d });
    expect(d.runReview).toHaveBeenCalledWith(
      { pr: "7", repo: "prowl-tools/prowl-code-review" },
      { respectPause: false }
    );
    expect(outcome.reviewed).toBe(true);
  });

  it("forces a full re-scan for `full-review`", async () => {
    const d = deps();
    await dispatchCommand({ verb: "full-review", argument: "" }, { octokit, ref, deps: d });
    expect(d.runReview).toHaveBeenCalledWith(
      { pr: "7", repo: "prowl-tools/prowl-code-review", incremental: false },
      { respectPause: false }
    );
  });

  it("runs an incremental review for `break-glass`, ignoring pause", async () => {
    const d = deps();
    const outcome = await dispatchCommand({ verb: "break-glass", argument: "abc123" }, { octokit, ref, deps: d });
    expect(d.runReview).toHaveBeenCalledWith(
      { pr: "7", repo: "prowl-tools/prowl-code-review" },
      { respectPause: false }
    );
    expect(outcome.reviewed).toBe(true);
  });

  it("pauses and acknowledges", async () => {
    const d = deps();
    const outcome = await dispatchCommand({ verb: "pause", argument: "" }, { octokit, ref, deps: d });
    expect(d.setPaused).toHaveBeenCalledWith(octokit, ref, true);
    expect(d.postComment).toHaveBeenCalledWith(octokit, ref, expect.stringContaining("paused"));
    expect(outcome.reviewed).toBe(false);
    expect(d.runReview).not.toHaveBeenCalled();
  });

  it("resumes and acknowledges", async () => {
    const d = deps();
    await dispatchCommand({ verb: "resume", argument: "" }, { octokit, ref, deps: d });
    expect(d.setPaused).toHaveBeenCalledWith(octokit, ref, false);
    expect(d.postComment).toHaveBeenCalledWith(octokit, ref, expect.stringContaining("resumed"));
  });

  it("replies with help for the help verb", async () => {
    const d = deps();
    await dispatchCommand({ verb: "help", argument: "" }, { octokit, ref, deps: d });
    expect(d.postComment).toHaveBeenCalledWith(octokit, ref, expect.stringContaining("prowl-review commands"));
    expect(d.runReview).not.toHaveBeenCalled();
  });

  it("answers a free-form question (unknown verb) via the chat responder (#27)", async () => {
    const respond = vi.fn(async () => {});
    const d = deps({ respond });
    const outcome = await dispatchCommand(
      { verb: "unknown", argument: "why is this O(n^2)?" },
      { octokit, ref, deps: d }
    );
    expect(respond).toHaveBeenCalledWith("why is this O(n^2)?");
    expect(outcome.responded).toBe(true);
    expect(d.postComment).not.toHaveBeenCalled();
  });

  it("falls back to help for an unknown verb when no chat responder is wired", async () => {
    const d = deps(); // no respond
    await dispatchCommand({ verb: "unknown", argument: "hello?" }, { octokit, ref, deps: d });
    expect(d.postComment).toHaveBeenCalledWith(octokit, ref, expect.stringContaining("prowl-review commands"));
  });
});

describe("resolveCommentEvent (#26)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prowl-cmd-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeEvent(payload: unknown): NodeJS.ProcessEnv {
    const path = join(dir, "event.json");
    writeFileSync(path, JSON.stringify(payload));
    return { GITHUB_EVENT_PATH: path } as NodeJS.ProcessEnv;
  }

  it("parses an issue_comment on a PR", () => {
    const env = writeEvent({
      comment: { id: 555, body: "@prowl-review review", author_association: "OWNER", user: { login: "maintainer" } },
      issue: { number: 7, pull_request: { url: "..." } }
    });
    expect(resolveCommentEvent(env)).toEqual({
      body: "@prowl-review review",
      association: "OWNER",
      login: "maintainer",
      pullNumber: 7,
      commentId: 555,
      isReviewComment: false,
      thread: undefined
    });
  });

  it("captures inline-thread context from a pull_request_review_comment (#27)", () => {
    const env = writeEvent({
      comment: {
        id: 999,
        body: "@prowl-review why is this unsafe?",
        author_association: "MEMBER",
        user: { login: "dev" },
        path: "src/a.ts",
        line: 42,
        diff_hunk: "@@ -1 +1 @@\n+const x = 1;"
      },
      pull_request: { number: 12 }
    });
    expect(resolveCommentEvent(env)).toEqual({
      body: "@prowl-review why is this unsafe?",
      association: "MEMBER",
      login: "dev",
      pullNumber: 12,
      commentId: 999,
      isReviewComment: true,
      thread: { path: "src/a.ts", line: 42, diffHunk: "@@ -1 +1 @@\n+const x = 1;" }
    });
  });

  it("targets the top-level review comment when the trigger is an inline reply", () => {
    const env = writeEvent({
      comment: {
        id: 1002,
        in_reply_to_id: 999,
        body: "@prowl-review why is this unsafe?",
        author_association: "MEMBER",
        user: { login: "dev" },
        path: "src/a.ts",
        line: 42,
        diff_hunk: "@@ -1 +1 @@\n+const x = 1;"
      },
      pull_request: { number: 12 }
    });

    expect(resolveCommentEvent(env)?.commentId).toBe(999);
  });

  it("redacts inline-thread diff hunks before they reach the chat prompt", () => {
    const env = writeEvent({
      comment: {
        id: 999,
        body: "@prowl-review why is this unsafe?",
        author_association: "MEMBER",
        user: { login: "dev" },
        path: "src/a.ts",
        line: 42,
        diff_hunk: `@@ -1 +1 @@\n+const key = "${AWS_ACCESS_KEY}";`
      },
      pull_request: { number: 12 }
    });

    const event = resolveCommentEvent(env);
    expect(event?.thread?.diffHunk).not.toContain(AWS_ACCESS_KEY);
    expect(event?.thread?.diffHunk).toContain("[REDACTED:aws-access-key]");
  });

  it("omits inline diff hunks from sensitive files", () => {
    const env = writeEvent({
      comment: {
        id: 999,
        body: "@prowl-review why is this unsafe?",
        author_association: "MEMBER",
        user: { login: "dev" },
        path: ".env",
        line: 1,
        diff_hunk: "@@ -0,0 +1 @@\n+CUSTOM_VALUE=plainsecretvalue"
      },
      pull_request: { number: 12 }
    });

    expect(resolveCommentEvent(env)?.thread).toEqual({ path: ".env", line: 1, diffHunk: undefined });
  });

  it("ignores bot-authored comments", () => {
    const env = writeEvent({
      comment: {
        body: "@prowl-review pause",
        author_association: "OWNER",
        user: { login: "github-actions[bot]", type: "Bot" }
      },
      issue: { number: 7, pull_request: { url: "..." } }
    });

    expect(resolveCommentEvent(env)).toBeNull();
  });

  it("ignores an issue_comment that is not on a PR", () => {
    const env = writeEvent({
      comment: { body: "@prowl-review review", author_association: "OWNER" },
      issue: { number: 7 } // no pull_request → a plain issue
    });
    expect(resolveCommentEvent(env)).toBeNull();
  });

  it("parses a pathless pull_request_review_comment as PR-scoped only", () => {
    const env = writeEvent({
      comment: { id: 444, body: "@prowl-review pause", author_association: "MEMBER", user: { login: "dev" } },
      pull_request: { number: 12 }
    });
    expect(resolveCommentEvent(env)).toMatchObject({
      pullNumber: 12,
      commentId: 444,
      isReviewComment: false,
      thread: undefined
    });
  });

  it("returns null when there is no event file or no comment", () => {
    expect(resolveCommentEvent({} as NodeJS.ProcessEnv)).toBeNull();
    const env = writeEvent({ issue: { number: 7, pull_request: {} } });
    expect(resolveCommentEvent(env)).toBeNull();
  });

  it("ignores unreadable org guidelines without throwing", () => {
    const priorOrgPath = process.env.PROWL_ORG_GUIDELINES_PATH;
    const priorGuidelinesWorkspace = process.env.PROWL_GUIDELINES_WORKSPACE;
    process.env.PROWL_ORG_GUIDELINES_PATH = dir;
    delete process.env.PROWL_GUIDELINES_WORKSPACE;
    try {
      expect(loadChatGuidelines()).toBeUndefined();
    } finally {
      if (priorOrgPath === undefined) {
        delete process.env.PROWL_ORG_GUIDELINES_PATH;
      } else {
        process.env.PROWL_ORG_GUIDELINES_PATH = priorOrgPath;
      }
      if (priorGuidelinesWorkspace === undefined) {
        delete process.env.PROWL_GUIDELINES_WORKSPACE;
      } else {
        process.env.PROWL_GUIDELINES_WORKSPACE = priorGuidelinesWorkspace;
      }
    }
  });
});

describe("respondToComment (#27)", () => {
  const config = { provider: "anthropic" as const, model: "m", apiKey: "k" };
  const baseEvent = {
    body: "@prowl-review why?",
    association: "OWNER",
    login: "dev",
    pullNumber: 7,
    isReviewComment: false
  };

  function chatDeps(diff = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+secret = "${AWS_ACCESS_KEY}"\n`) {
    return {
      fetchPr: vi.fn(async () => ({
        meta: { title: "T", body: "desc", headSha: "h", baseSha: "b" },
        diff
      })),
      generateReply: vi.fn(async () => ({
        reply: "It loops twice.",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
      })),
      postIssueComment: vi.fn(async () => {}),
      postReviewReply: vi.fn(async () => {})
    };
  }

  it("posts a top-level reply for a PR comment, grounded in the fetched diff", async () => {
    const deps = chatDeps();
    await respondToComment({
      octokit,
      ref,
      event: { ...baseEvent },
      question: "why?",
      config,
      deps
    });

    expect(deps.fetchPr).toHaveBeenCalled();
    expect(deps.postIssueComment).toHaveBeenCalledWith(octokit, ref, expect.stringContaining("It loops twice."));
    expect(deps.postReviewReply).not.toHaveBeenCalled();
    // The fetched diff reaches the generator (redacted of secrets).
    const chatInput = deps.generateReply.mock.calls[0][0];
    expect(chatInput.diff).not.toContain(AWS_ACCESS_KEY);
  });

  it("filters sensitive diff files before generating a chat reply", async () => {
    const deps = chatDeps(
      [
        "diff --git a/.env b/.env",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/.env",
        "@@ -0,0 +1 @@",
        "+CUSTOM_VALUE=plainsecretvalue",
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "+export const shown = true;"
      ].join("\n")
    );

    await respondToComment({
      octokit,
      ref,
      event: { ...baseEvent },
      question: "why?",
      config,
      deps
    });

    const chatInput = deps.generateReply.mock.calls[0][0];
    expect(chatInput.diff).not.toContain("plainsecretvalue");
    expect(chatInput.diff).not.toContain(".env");
    expect(chatInput.diff).toContain("src/app.ts");
    expect(chatInput.diff).not.toContain("(diff truncated to fit the chat context)");
  });

  it("does not label binary skips as chat diff truncation", async () => {
    const deps = chatDeps(
      [
        "diff --git a/img.png b/img.png",
        "new file mode 100644",
        "Binary files /dev/null and b/img.png differ",
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "+export const shown = true;"
      ].join("\n")
    );

    await respondToComment({
      octokit,
      ref,
      event: { ...baseEvent },
      question: "why?",
      config,
      deps
    });

    expect(deps.generateReply.mock.calls[0][0].diff).not.toContain("(diff truncated to fit the chat context)");
  });

  it("replies in-thread for an inline review comment", async () => {
    const deps = chatDeps();
    await respondToComment({
      octokit,
      ref,
      event: { ...baseEvent, isReviewComment: true, commentId: 321, thread: { path: "src/a.ts", line: 5 } },
      question: "why?",
      config,
      deps
    });

    expect(deps.postReviewReply).toHaveBeenCalledWith(octokit, ref, 321, expect.stringContaining("It loops twice."));
    expect(deps.postIssueComment).not.toHaveBeenCalled();
    expect(deps.generateReply.mock.calls[0][0].thread).toEqual({ path: "src/a.ts", line: 5 });
  });

  it("drops inline thread hunks when a file was renamed from a sensitive path", async () => {
    const deps = chatDeps(
      [
        "diff --git a/.env b/env.example",
        "similarity index 80%",
        "rename from .env",
        "rename to env.example",
        "--- a/.env",
        "+++ b/env.example",
        "@@ -1 +1 @@",
        "+CUSTOM_VALUE=plainsecretvalue"
      ].join("\n")
    );

    await respondToComment({
      octokit,
      ref,
      event: {
        ...baseEvent,
        isReviewComment: true,
        commentId: 321,
        thread: {
          path: "env.example",
          line: 1,
          diffHunk: "@@ -1 +1 @@\n+CUSTOM_VALUE=plainsecretvalue"
        }
      },
      question: "why?",
      config,
      deps
    });

    const chatInput = deps.generateReply.mock.calls[0][0];
    expect(chatInput.diff).not.toContain("plainsecretvalue");
    expect(chatInput.thread).toEqual({ path: "env.example", line: 1, diffHunk: undefined });
  });

  it("preserves inline thread hunks when the thread file is absent from the fetched diff", async () => {
    const deps = chatDeps(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "+export const shown = true;"
      ].join("\n")
    );

    await respondToComment({
      octokit,
      ref,
      event: {
        ...baseEvent,
        isReviewComment: true,
        commentId: 321,
        thread: {
          path: "src/missing.ts",
          line: 10,
          diffHunk: "@@ -1 +1 @@\n+const value = 1;"
        }
      },
      question: "why?",
      config,
      deps
    });

    expect(deps.generateReply.mock.calls[0][0].thread).toEqual({
      path: "src/missing.ts",
      line: 10,
      diffHunk: "@@ -1 +1 @@\n+const value = 1;"
    });
  });
});

describe("command workflow metadata", () => {
  it("filters bot comments and reviews the PR head workspace", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/prowl-review-command.yml"), "utf8");
    const reviewWorkflow = readFileSync(join(process.cwd(), ".github/workflows/prowl-review.yml"), "utf8");

    expect(workflow).toContain(
      "group: prowl-review-${{ github.event.issue.number || github.event.pull_request.number }}"
    );
    expect(workflow).toContain("queue: max");
    expect(workflow).toContain("cancel-in-progress: false");
    // Triggers on both top-level and inline PR comments (#27).
    expect(workflow).toContain("issue_comment:");
    expect(workflow).toContain("pull_request_review_comment:");
    expect(reviewWorkflow).toContain("group: prowl-review-${{ github.event.pull_request.number }}");
    expect(reviewWorkflow).toContain("queue: max");
    expect(reviewWorkflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("github.event.comment.user.type != 'Bot'");
    expect(workflow).toContain("github.event.comment.author_association == 'OWNER'");
    expect(workflow).toContain("github.event.comment.author_association == 'MEMBER'");
    expect(workflow).toContain("github.event.comment.author_association == 'COLLABORATOR'");
    expect(workflow.indexOf("Resolve PR metadata")).toBeLessThan(workflow.indexOf("Checkout trusted base"));
    expect(workflow).toContain("gh api \"repos/${GITHUB_REPOSITORY}/pulls/${pr_number}\"");
    expect(workflow).toContain("[.base.sha, .head.sha, .head.repo.full_name] | @tsv");
    expect(workflow).toContain("echo \"base_sha=${base_sha}\"");
    expect(workflow).toContain("ref: ${{ steps.pr.outputs.base_sha }}");
    expect(workflow).toContain("action_file=\"action.yml\"");
    expect(workflow).toContain("grep -Eq '^[[:space:]]{2}mode:' \"${action_file}\"");
    expect(workflow).toContain("grep -q 'inputs.mode' \"${action_file}\"");
    expect(workflow).toContain("Trusted base does not support prowl-review command mode yet");
    expect(workflow).toContain("Checkout PR head for context");
    expect(workflow).toContain("workspace-path: ${{ github.workspace }}/pr-head");
    expect(workflow).toContain("PROWL_REVIEWED_HEAD_SHA: ${{ steps.pr.outputs.head_sha }}");
  });
});

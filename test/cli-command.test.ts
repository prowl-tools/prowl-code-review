import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  dispatchCommand,
  loadChatGuidelines,
  resolveCommentEvent,
  respondToComment,
  handleIgnore,
  type CommandDispatchDeps,
  type CommentEvent
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

  it("mutes a finding for the ignore verb via the ignore handler (#30)", async () => {
    const ignore = vi.fn(async () => ({ ignored: 1 }));
    const d = deps({ ignore });
    const outcome = await dispatchCommand({ verb: "ignore", argument: "" }, { octokit, ref, deps: d });
    expect(ignore).toHaveBeenCalledTimes(1);
    expect(outcome.ignored).toBe(1);
    expect(d.postComment).not.toHaveBeenCalled();
  });

  it("falls back to help for ignore when no ignore handler is wired", async () => {
    const d = deps(); // no ignore
    await dispatchCommand({ verb: "ignore", argument: "" }, { octokit, ref, deps: d });
    expect(d.postComment).toHaveBeenCalledWith(octokit, ref, expect.stringContaining("prowl-review commands"));
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
      parentCommentId: undefined,
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
      parentCommentId: undefined,
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

    expect(resolveCommentEvent(env)).toMatchObject({ commentId: 999, parentCommentId: 999 });
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

  it("ignores prowl-authored inline finding comments even from trusted user tokens", () => {
    const env = writeEvent({
      comment: {
        id: 999,
        body: "Finding mentions @prowl-review review.\n\n<!-- prowl-review:finding fp-a -->",
        author_association: "OWNER",
        user: { login: "maintainer", type: "User" },
        path: "src/a.ts",
        line: 42,
        diff_hunk: "@@ -1 +1 @@\n+const x = 1;"
      },
      pull_request: { number: 12 }
    });

    expect(resolveCommentEvent(env)).toBeNull();
  });

  it("ignores prowl-authored summary comments even from trusted user tokens", () => {
    const env = writeEvent({
      comment: {
        id: 555,
        body: "<!-- prowl-review:summary -->\nPaused. Comment `@prowl-review resume`.",
        author_association: "OWNER",
        user: { login: "maintainer", type: "User" }
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
      fetchReviewCommentBody: vi.fn(async () => "Parent finding body"),
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

  it("filters ignored diff files before capping chat context", async () => {
    const lockPayload = "x".repeat(58_000);
    const sourcePayload = "y".repeat(3_000);
    const deps = chatDeps(
      [
        "diff --git a/package-lock.json b/package-lock.json",
        "--- a/package-lock.json",
        "+++ b/package-lock.json",
        "@@ -1 +1 @@",
        `+${lockPayload}`,
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        `+${sourcePayload}`
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
    expect(chatInput.diff).not.toContain("package-lock.json");
    expect(chatInput.diff).not.toContain(lockPayload);
    expect(chatInput.diff).toContain("src/app.ts");
    expect(chatInput.diff).toContain(sourcePayload);
  });

  it("honors an empty chat ignore list as an explicit opt-out", async () => {
    const deps = chatDeps(
      [
        "diff --git a/package-lock.json b/package-lock.json",
        "--- a/package-lock.json",
        "+++ b/package-lock.json",
        "@@ -1 +1 @@",
        "+{}"
      ].join("\n")
    );

    await respondToComment({
      octokit,
      ref,
      event: { ...baseEvent },
      question: "why?",
      config,
      ignore: [],
      deps
    });

    expect(deps.generateReply.mock.calls[0][0].diff).toContain("package-lock.json");
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
    expect(deps.fetchReviewCommentBody).not.toHaveBeenCalled();
  });

  it("includes the parent review comment body for inline reply questions", async () => {
    const deps = chatDeps("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+const x = 1;\n");
    await respondToComment({
      octokit,
      ref,
      event: {
        ...baseEvent,
        isReviewComment: true,
        commentId: 321,
        parentCommentId: 321,
        thread: { path: "src/a.ts", line: 5, diffHunk: "@@ -1 +1 @@\n+const x = 1;" }
      },
      question: "why?",
      config,
      deps
    });

    expect(deps.fetchReviewCommentBody).toHaveBeenCalledWith(octokit, ref, 321);
    expect(deps.generateReply.mock.calls[0][0].thread).toEqual({
      path: "src/a.ts",
      line: 5,
      parentCommentBody: "Parent finding body",
      diffHunk: "@@ -1 +1 @@\n+const x = 1;"
    });
  });

  it("preserves parent review comment body when a current safe thread has no diff hunk", async () => {
    const deps = chatDeps("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+const x = 1;\n");
    await respondToComment({
      octokit,
      ref,
      event: {
        ...baseEvent,
        isReviewComment: true,
        commentId: 321,
        parentCommentId: 321,
        thread: { path: "src/a.ts", line: 5 }
      },
      question: "why?",
      config,
      deps
    });

    expect(deps.generateReply.mock.calls[0][0].thread).toEqual({
      path: "src/a.ts",
      line: 5,
      parentCommentBody: "Parent finding body"
    });
  });

  it("sanitizes generated replies before posting them to GitHub", async () => {
    const deps = chatDeps();
    deps.generateReply.mockResolvedValueOnce({
      reply: "**ok** <img src=x onerror=alert(1)>\n[bad](javascript:alert(1))\n@team",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
    });

    await respondToComment({
      octokit,
      ref,
      event: { ...baseEvent },
      question: "why?",
      config,
      deps
    });

    const body = deps.postIssueComment.mock.calls[0][2];
    expect(body).toContain("**ok**");
    expect(body).not.toContain("<img");
    expect(body).not.toMatch(/javascript\s*:/i);
    expect(body).toContain("&#64;team");
    expect(body).toContain("<sub>");
    expect(body).toContain("&#64;prowl-review");
    expect(body).not.toContain("@prowl-review");
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
        parentCommentId: 321,
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
    expect(JSON.stringify(chatInput.thread)).not.toContain("Parent finding body");
  });

  it("drops inline thread hunks when the thread file is absent from the fetched diff", async () => {
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
        parentCommentId: 321,
        thread: {
          path: "src/missing.ts",
          line: 10,
          diffHunk: "@@ -1 +1 @@\n+CUSTOM_VALUE=plainsecretvalue"
        }
      },
      question: "why?",
      config,
      deps
    });

    const chatInput = deps.generateReply.mock.calls[0][0];
    expect(chatInput.thread).toEqual({
      path: "src/missing.ts",
      line: 10,
      diffHunk: undefined
    });
    expect(JSON.stringify(chatInput.thread)).not.toContain("plainsecretvalue");
    expect(JSON.stringify(chatInput.thread)).not.toContain("Parent finding body");
  });
});

describe("handleIgnore (#30)", () => {
  const inlineEvent: CommentEvent = {
    body: "@prowl-review ignore",
    association: "OWNER",
    login: "dev",
    pullNumber: 7,
    isReviewComment: true,
    commentId: 100,
    parentCommentId: 100 // the bot's root finding comment
  };

  function ignoreDeps() {
    return {
      fetchFingerprints: vi.fn(async () => ["fp-1"]),
      setIgnored: vi.fn(async () => ({ added: 1, total: 1 })),
      postReviewReply: vi.fn(async () => {}),
      postIssueComment: vi.fn(async () => {})
    };
  }

  it("mutes the targeted finding and acks in-thread", async () => {
    const deps = ignoreDeps();
    const result = await handleIgnore({ octokit, ref, event: inlineEvent, deps });

    expect(deps.fetchFingerprints).toHaveBeenCalledWith(octokit, ref, 100);
    expect(deps.setIgnored).toHaveBeenCalledWith(octokit, ref, ["fp-1"]);
    expect(deps.postReviewReply).toHaveBeenCalledWith(octokit, ref, 100, expect.stringContaining("Ignored"));
    expect(result.ignored).toBe(1);
  });

  it("reports only newly added mutes", async () => {
    const deps = { ...ignoreDeps(), setIgnored: vi.fn(async () => ({ added: 0, total: 1 })) };
    const result = await handleIgnore({ octokit, ref, event: inlineEvent, deps });

    expect(deps.setIgnored).toHaveBeenCalledWith(octokit, ref, ["fp-1"]);
    expect(result.ignored).toBe(0);
  });

  it("gives guidance when the thread has no prowl-review finding", async () => {
    const deps = { ...ignoreDeps(), fetchFingerprints: vi.fn(async () => []) };
    const result = await handleIgnore({ octokit, ref, event: inlineEvent, deps });
    expect(deps.setIgnored).not.toHaveBeenCalled();
    expect(deps.postReviewReply).toHaveBeenCalledWith(octokit, ref, 100, expect.stringContaining("couldn't identify"));
    expect(result.ignored).toBe(0);
  });

  it("gives guidance for a top-level ignore with no finding thread", async () => {
    const deps = ignoreDeps();
    const topLevel: CommentEvent = {
      body: "@prowl-review ignore",
      association: "OWNER",
      login: "dev",
      pullNumber: 7,
      isReviewComment: false,
      commentId: 9
    };
    const result = await handleIgnore({ octokit, ref, event: topLevel, deps });
    expect(deps.fetchFingerprints).not.toHaveBeenCalled();
    expect(deps.postIssueComment).toHaveBeenCalledWith(octokit, ref, expect.stringContaining("directly on a finding"));
    expect(result.ignored).toBe(0);
  });
});

describe("command workflow metadata", () => {
  it("filters bot comments and reviews the PR head workspace", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/prowl-review-command.yml"), "utf8");
    const reviewWorkflow = readFileSync(join(process.cwd(), ".github/workflows/prowl-review.yml"), "utf8");
    const parsedWorkflow = parseYaml(workflow) as {
      jobs: {
        command: {
          concurrency?: {
            group?: string;
            queue?: string;
            "cancel-in-progress"?: boolean;
          };
        };
      };
    };

    expect(parsedWorkflow.jobs.command.concurrency).toEqual({
      group: "prowl-review-${{ github.event.issue.number || github.event.pull_request.number }}",
      queue: "max",
      "cancel-in-progress": false
    });
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
    expect(workflow).toContain("!contains(github.event.comment.body, '<!-- prowl-review:summary -->')");
    expect(workflow).toContain("!contains(github.event.comment.body, '<!-- prowl-review:finding ')");
    expect(workflow.indexOf("Resolve PR metadata")).toBeLessThan(workflow.indexOf("Checkout trusted base"));
    expect(workflow).toContain("set -euo pipefail");
    expect(workflow).toContain("gh api \"repos/${GITHUB_REPOSITORY}/pulls/${pr_number}\"");
    expect(workflow).toContain("[.base.sha, .head.sha, .head.repo.full_name] | @tsv");
    expect(workflow).toContain("Failed to resolve complete PR metadata");
    expect(workflow).toContain("echo \"base_sha=${base_sha}\"");
    expect(workflow).toContain("echo \"head_repo=${head_repo}\"");
    expect(workflow).toContain("ref: ${{ steps.pr.outputs.base_sha }}");
    expect(workflow).toContain("action_file=\"action.yml\"");
    expect(workflow).toContain("grep -Eq '^[[:space:]]{2}mode:' \"${action_file}\"");
    expect(workflow).toContain("grep -q 'inputs.mode' \"${action_file}\"");
    // Command mode also gates on ensemble-key support so it self-bootstraps (#53).
    expect(workflow).toContain("grep -q 'ai-key-anthropic' \"${action_file}\"");
    expect(workflow).toContain("grep -q 'ai-key-gemini' \"${action_file}\"");
    expect(reviewWorkflow).toContain("grep -q 'ai-key-anthropic' \"${action_file}\"");
    expect(reviewWorkflow).toContain("grep -q 'ai-key-gemini' \"${action_file}\"");
    expect(workflow).toContain("Trusted base does not support the prowl-review command-mode ensemble yet");
    expect(workflow).toContain("Checkout PR head for context");
    expect(workflow).toContain("workspace-path: ${{ github.workspace }}/pr-head");
    expect(workflow).toContain("PROWL_REVIEWED_HEAD_SHA: ${{ steps.pr.outputs.head_sha }}");
    expect(workflow).toContain("PROWL_REVIEWED_HEAD_REPOSITORY: ${{ steps.pr.outputs.head_repo }}");
  });
});

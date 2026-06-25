import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  createOctokit: vi.fn(),
  fetchPullRequest: vi.fn(),
  generateChatReply: vi.fn(),
  postPullRequestComment: vi.fn(),
  replyToReviewComment: vi.fn()
}));

vi.mock("../src/github/client.js", () => ({
  createOctokit: mocks.createOctokit
}));

vi.mock("../src/github/diff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/github/diff.js")>()),
  fetchPullRequest: mocks.fetchPullRequest
}));

vi.mock("../src/github/review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/github/review.js")>()),
  postPullRequestComment: mocks.postPullRequestComment,
  replyToReviewComment: mocks.replyToReviewComment
}));

vi.mock("../src/review/chat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/review/chat.js")>()),
  generateChatReply: mocks.generateChatReply
}));

import { buildCommandCommand } from "../src/cli/commands/command.js";

const ORIGINAL_ENV = process.env;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prowl-command-entry-"));
  tempDirs.push(dir);
  return dir;
}

describe("command CLI entrypoint", () => {
  beforeEach(() => {
    const workspace = tempDir();
    const eventPath = join(workspace, "event.json");
    writeFileSync(join(workspace, ".prowl-review.yml"), "provider: gemini\n");
    writeFileSync(
      eventPath,
      JSON.stringify({
        comment: {
          id: 555,
          body: "@prowl-review why?",
          author_association: "OWNER",
          user: { login: "maintainer", type: "User" }
        },
        issue: {
          number: 7,
          pull_request: { url: "https://api.github.com/repos/prowl-tools/prowl-code-review/pulls/7" }
        },
        repository: { full_name: "prowl-tools/prowl-code-review" }
      })
    );

    process.env = {
      ...ORIGINAL_ENV,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "prowl-tools/prowl-code-review",
      GITHUB_TOKEN: "token",
      PROWL_AI_KEY: "key",
      PROWL_REVIEWED_HEAD_REPOSITORY: "prowl-tools/prowl-code-review",
      PROWL_WORKSPACE: workspace
    };
    delete process.env.PROWL_ORG_GUIDELINES_PATH;
    delete process.env.PROWL_GUIDELINES_WORKSPACE;

    const octokit = { rest: { pulls: { get: vi.fn() } } };
    mocks.createOctokit.mockReset().mockReturnValue(octokit);
    mocks.fetchPullRequest.mockReset().mockResolvedValue({
      meta: { title: "T", body: null, headSha: "head", baseSha: "base" },
      diff: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n+export const x = 1;\n"
    });
    mocks.generateChatReply.mockReset().mockResolvedValue({
      reply: "Answer.",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
    });
    mocks.postPullRequestComment.mockReset().mockResolvedValue(undefined);
    mocks.replyToReviewComment.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = ORIGINAL_ENV;
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("uses the workflow head-repository signal for chat config loading without fetching PR metadata", async () => {
    const command = buildCommandCommand();

    await command.parseAsync(["node", "command"]);

    const octokit = mocks.createOctokit.mock.results[0].value;
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
    expect(mocks.fetchPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.generateChatReply.mock.calls[0][1].config.provider).toBe("gemini");
    expect(mocks.postPullRequestComment).toHaveBeenCalledWith(
      octokit,
      { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 },
      expect.stringContaining("Answer.")
    );
  });

  it("does not auto-discover workspace config when chat runs against a fork PR", async () => {
    process.env.PROWL_REVIEWED_HEAD_REPOSITORY = "contributor/prowl-code-review";
    const command = buildCommandCommand();

    await command.parseAsync(["node", "command"]);

    const octokit = mocks.createOctokit.mock.results[0].value;
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
    expect(mocks.fetchPullRequest).toHaveBeenCalledTimes(1);
    expect(mocks.generateChatReply.mock.calls[0][1].config.provider).toBe("anthropic");
    expect(mocks.postPullRequestComment).toHaveBeenCalledWith(
      octokit,
      { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 },
      expect.stringContaining("Answer.")
    );
  });
});

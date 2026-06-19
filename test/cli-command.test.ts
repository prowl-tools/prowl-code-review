import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchCommand, resolveCommentEvent, type CommandDispatchDeps } from "../src/cli/commands/command.js";
import type { OctokitLike } from "../src/github/client.js";

const ref = { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 };
const octokit = {} as unknown as OctokitLike;

function deps(over: Partial<CommandDispatchDeps> = {}): Required<CommandDispatchDeps> {
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

  it("replies with help for help and unknown verbs", async () => {
    for (const verb of ["help", "unknown"] as const) {
      const d = deps();
      await dispatchCommand({ verb, argument: "" }, { octokit, ref, deps: d });
      expect(d.postComment).toHaveBeenCalledWith(octokit, ref, expect.stringContaining("prowl-review commands"));
      expect(d.runReview).not.toHaveBeenCalled();
    }
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
      comment: { body: "@prowl-review review", author_association: "OWNER", user: { login: "maintainer" } },
      issue: { number: 7, pull_request: { url: "..." } }
    });
    expect(resolveCommentEvent(env)).toEqual({
      body: "@prowl-review review",
      association: "OWNER",
      login: "maintainer",
      pullNumber: 7
    });
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

  it("parses a pull_request_review_comment", () => {
    const env = writeEvent({
      comment: { body: "@prowl-review pause", author_association: "MEMBER", user: { login: "dev" } },
      pull_request: { number: 12 }
    });
    expect(resolveCommentEvent(env)?.pullNumber).toBe(12);
  });

  it("returns null when there is no event file or no comment", () => {
    expect(resolveCommentEvent({} as NodeJS.ProcessEnv)).toBeNull();
    const env = writeEvent({ issue: { number: 7, pull_request: {} } });
    expect(resolveCommentEvent(env)).toBeNull();
  });
});

describe("command workflow metadata", () => {
  it("filters bot comments and reviews the PR head workspace", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/prowl-review-command.yml"), "utf8");

    expect(workflow).toContain("github.event.comment.user.type != 'Bot'");
    expect(workflow).toContain("Checkout PR head for context");
    expect(workflow).toContain("workspace-path: ${{ github.workspace }}/pr-head");
    expect(workflow).toContain("PROWL_REVIEWED_HEAD_SHA: ${{ steps.pr.outputs.head_sha }}");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  planThreadActions,
  fetchReviewThreads,
  resolveReviewThread,
  type ReviewThread
} from "../src/github/threads.js";
import type { OctokitLike } from "../src/github/client.js";

const ref = { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 };

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "T1",
    isResolved: false,
    isOutdated: false,
    fingerprints: ["fp1"],
    humanIntent: "other",
    ...over
  };
}

describe("planThreadActions (#22)", () => {
  it("resolves a thread whose finding is gone from this run (fixed)", () => {
    const plan = planThreadActions({ threads: [thread({ fingerprints: ["gone"] })], currentFingerprints: ["fp1"] });
    expect(plan.resolve).toEqual([{ id: "T1", reason: "fixed" }]);
    expect(plan.suppress).toEqual({ acknowledged: [], disputed: [] });
  });

  it("keeps a thread open when GitHub marked it outdated but the fingerprint is still current", () => {
    const plan = planThreadActions({
      threads: [thread({ isOutdated: true, fingerprints: ["fp1"] })],
      currentFingerprints: ["fp1"]
    });
    expect(plan.resolve).toEqual([]);
  });

  it("resolves an outdated thread once its finding is absent from the current review", () => {
    const plan = planThreadActions({
      threads: [thread({ isOutdated: true, fingerprints: ["old"] })],
      currentFingerprints: ["fp1"]
    });
    expect(plan.resolve).toEqual([{ id: "T1", reason: "fixed" }]);
  });

  it("leaves a still-current finding's thread untouched", () => {
    const plan = planThreadActions({ threads: [thread({ fingerprints: ["fp1"] })], currentFingerprints: ["fp1"] });
    expect(plan.resolve).toEqual([]);
  });

  it("never resolves already-resolved threads or non-bot (no-fingerprint) threads", () => {
    const plan = planThreadActions({
      threads: [
        thread({ id: "R", isResolved: true, fingerprints: ["gone"] }),
        thread({ id: "H", fingerprints: [] })
      ],
      currentFingerprints: []
    });
    expect(plan.resolve).toEqual([]);
  });

  it("keeps suppression for already-resolved settled threads without resolving again", () => {
    const plan = planThreadActions({
      threads: [
        thread({ id: "A", isResolved: true, fingerprints: ["ack"], humanIntent: "acknowledged" }),
        thread({ id: "W", isResolved: true, fingerprints: ["wf"], humanIntent: "wont-fix" })
      ],
      currentFingerprints: ["ack", "wf"]
    });
    expect(plan.resolve).toEqual([]);
    expect(plan.suppress.acknowledged.sort()).toEqual(["ack", "wf"]);
  });

  it("resolves + suppresses on an acknowledged/won't-fix reply", () => {
    const plan = planThreadActions({
      threads: [
        thread({ id: "A", fingerprints: ["ack"], humanIntent: "acknowledged" }),
        thread({ id: "W", fingerprints: ["wf"], humanIntent: "wont-fix" })
      ],
      currentFingerprints: ["ack", "wf"]
    });
    expect(plan.resolve).toEqual([
      { id: "A", reason: "acknowledged" },
      { id: "W", reason: "wont-fix" }
    ]);
    expect(plan.suppress.acknowledged.sort()).toEqual(["ack", "wf"]);
    expect(plan.suppress.disputed).toEqual([]);
  });

  it("keeps a disputed thread open and suppresses its finding (not blindly re-raised)", () => {
    const plan = planThreadActions({
      threads: [thread({ id: "D", fingerprints: ["dis"], humanIntent: "disagree" })],
      currentFingerprints: ["dis"]
    });
    expect(plan.resolve).toEqual([]); // never resolved against the human's wish
    expect(plan.suppress.disputed).toEqual(["dis"]);
    expect(plan.keptOpenDisputed).toBe(1);
  });

  it("can skip fixed resolution when the current finding set is incomplete", () => {
    const plan = planThreadActions({
      threads: [
        thread({ id: "G", fingerprints: ["gone"] }),
        thread({ id: "O", isOutdated: true, fingerprints: ["fp1"] })
      ],
      currentFingerprints: ["fp1"],
      resolveStaleThreads: false
    });
    expect(plan.resolve).toEqual([]);
  });

  it("honors a dispute even when the finding is also outdated", () => {
    const plan = planThreadActions({
      threads: [thread({ id: "D", isOutdated: true, fingerprints: ["dis"], humanIntent: "disagree" })],
      currentFingerprints: []
    });
    expect(plan.resolve).toEqual([]);
    expect(plan.keptOpenDisputed).toBe(1);
  });
});

describe("fetchReviewThreads (#22)", () => {
  function mockOctokit(threads: unknown, login = "prowl-bot") {
    const graphql = vi.fn(async () => ({
      repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads } } }
    }));
    const getAuthenticated = vi.fn(async () => ({ data: { login } }));
    const octokit = { graphql, rest: { users: { getAuthenticated } } } as unknown as OctokitLike;
    return { octokit, graphql };
  }

  it("maps bot fingerprints and the latest human reply intent", async () => {
    const { octokit } = mockOctokit([
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [
            { body: "Finding\n<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot" } },
            { body: "won't fix this", author: { login: "dev" } }
          ]
        }
      }
    ]);
    const threads = await fetchReviewThreads(octokit, ref, "prowl-bot");
    expect(threads).toEqual([
      { id: "T1", isResolved: false, isOutdated: false, fingerprints: ["fp1"], humanIntent: "wont-fix" }
    ]);
  });

  it("ignores fingerprints in non-bot comments and takes the newest human reply", async () => {
    const { octokit } = mockOctokit([
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [
            { body: "<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot" } },
            { body: "I disagree", author: { login: "dev" } },
            { body: "actually, acknowledged", author: { login: "dev" } }
          ]
        }
      }
    ]);
    const [t] = await fetchReviewThreads(octokit, ref, "prowl-bot");
    expect(t.fingerprints).toEqual(["fp1"]);
    expect(t.humanIntent).toBe("acknowledged"); // latest human reply wins
  });

  it("returns [] tolerantly when the GraphQL read fails", async () => {
    const graphql = vi.fn(async () => {
      throw new Error("graphql down");
    });
    const octokit = {
      graphql,
      rest: { users: { getAuthenticated: vi.fn(async () => ({ data: { login: "b" } })) } }
    } as unknown as OctokitLike;
    expect(await fetchReviewThreads(octokit, ref, "b")).toEqual([]);
  });

  it("returns [] when the bot login cannot be resolved", async () => {
    const graphql = vi.fn();
    const octokit = {
      graphql,
      rest: { users: { getAuthenticated: vi.fn(async () => { throw new Error("no auth"); }) } }
    } as unknown as OctokitLike;
    expect(await fetchReviewThreads(octokit, ref)).toEqual([]);
    expect(graphql).not.toHaveBeenCalled();
  });
});

describe("resolveReviewThread (#22)", () => {
  it("calls the resolve mutation and reports success", async () => {
    const graphql = vi.fn(async () => ({ resolveReviewThread: { thread: { id: "T1", isResolved: true } } }));
    const octokit = { graphql } as unknown as OctokitLike;
    expect(await resolveReviewThread(octokit, "T1")).toBe(true);
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("resolveReviewThread"), { threadId: "T1" });
  });

  it("reports false tolerantly on failure", async () => {
    const graphql = vi.fn(async () => {
      throw new Error("no permission");
    });
    const octokit = { graphql } as unknown as OctokitLike;
    expect(await resolveReviewThread(octokit, "T1")).toBe(false);
  });
});

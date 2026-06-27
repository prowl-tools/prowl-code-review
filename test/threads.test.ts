import { describe, expect, it, vi } from "vitest";
import {
  planThreadActions,
  fetchReviewThreads,
  resolveReviewThread,
  replyToReviewThread,
  type ReviewThread
} from "../src/github/threads.js";
import type { OctokitLike } from "../src/github/client.js";
import {
  buildRejustifyReply,
  REJUSTIFICATION_REPLY_MARKER,
  REJUSTIFICATION_WITHDRAW_REPLY_PREFIX
} from "../src/review/rejustify.js";

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
    expect(plan.resolve).toEqual([{ id: "T1", reason: "fixed", fingerprints: ["gone"] }]);
    expect(plan.suppress).toEqual({ acknowledged: [], disputed: [], withdrawn: [] });
    expect(plan.repostable).toEqual([]);
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
    expect(plan.resolve).toEqual([{ id: "T1", reason: "fixed", fingerprints: ["old"] }]);
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
    expect(plan.repostable).toEqual(["gone"]);
  });

  it("does not keep reposting a resolved fingerprint that already has an open thread", () => {
    const plan = planThreadActions({
      threads: [
        thread({ id: "old", isResolved: true, fingerprints: ["fp1"] }),
        thread({ id: "new", isResolved: false, fingerprints: ["fp1"] })
      ],
      currentFingerprints: ["fp1"]
    });
    expect(plan.resolve).toEqual([]);
    expect(plan.repostable).toEqual([]);
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
      { id: "A", reason: "acknowledged", fingerprints: ["ack"] },
      { id: "W", reason: "wont-fix", fingerprints: ["wf"] }
    ]);
    expect(plan.suppress.acknowledged.sort()).toEqual(["ack", "wf"]);
    expect(plan.suppress.disputed).toEqual([]);
    expect(plan.suppress.withdrawn).toEqual([]);
  });

  it("keeps a disputed thread open and suppresses its finding (not blindly re-raised)", () => {
    const plan = planThreadActions({
      threads: [thread({ id: "D", fingerprints: ["dis"], humanIntent: "disagree", humanReplyBody: "I disagree, it's guarded" })],
      currentFingerprints: ["dis"]
    });
    expect(plan.resolve).toEqual([]); // never resolved against the human's wish
    expect(plan.suppress.disputed).toEqual(["dis"]);
    expect(plan.keptOpenDisputed).toBe(1);
    // Exposes the open disputed thread (id + fingerprints + reply) for re-justification (#22).
    expect(plan.disputedThreads).toEqual([
      { id: "D", fingerprints: ["dis"], humanReplyBody: "I disagree, it's guarded" }
    ]);
  });

  it("suppresses a bot-withdrawn dispute and retries thread resolution without blocking approval", () => {
    const plan = planThreadActions({
      threads: [thread({ id: "D", fingerprints: ["dis"], botRejustification: "withdrawn" })],
      currentFingerprints: ["dis"]
    });
    expect(plan.resolve).toEqual([{ id: "D", reason: "withdrawn", fingerprints: ["dis"] }]);
    expect(plan.suppress.withdrawn).toEqual(["dis"]);
    expect(plan.suppress.disputed).toEqual([]);
    expect(plan.keptOpenDisputed).toBe(0);
    expect(plan.disputedThreads).toEqual([]);
  });

  it("does not expose an already-resolved disputed thread for re-justification", () => {
    const plan = planThreadActions({
      threads: [thread({ id: "D", isResolved: true, fingerprints: ["dis"], humanIntent: "disagree" })],
      currentFingerprints: ["dis"]
    });
    expect(plan.disputedThreads).toEqual([]);
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
            { body: "Finding\n<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot", __typename: "Bot" } }
          ]
        },
        recentComments: {
          nodes: [
            { body: "won't fix this", authorAssociation: "COLLABORATOR", author: { login: "dev", __typename: "User" } }
          ]
        }
      }
    ]);
    const threads = await fetchReviewThreads(octokit, ref, "prowl-bot");
    expect(threads).toEqual([
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        fingerprints: ["fp1"],
        humanIntent: "wont-fix",
        humanReplyBody: "won't fix this"
      }
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
            { body: "<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot", __typename: "Bot" } },
            { body: "<!-- prowl-review:finding fake -->", author: { login: "dev", __typename: "User" } },
            { body: "I disagree", author: { login: "dev", __typename: "User" } }
          ]
        },
        recentComments: {
          nodes: [
            { body: "actually, acknowledged", authorAssociation: "OWNER", author: { login: "dev", __typename: "User" } }
          ]
        }
      }
    ]);
    const [t] = await fetchReviewThreads(octokit, ref, "prowl-bot");
    expect(t.fingerprints).toEqual(["fp1"]);
    expect(t.humanIntent).toBe("acknowledged"); // latest human reply wins
    expect(t.humanReplyBody).toBe("actually, acknowledged"); // captured for re-justification (#22)
  });

  it("keeps the newest decisive human intent when later trusted replies are non-decisive", async () => {
    const { octokit } = mockOctokit([
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [
            { body: "<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot", __typename: "Bot" } }
          ]
        },
        recentComments: {
          nodes: [
            { body: "won't fix this", authorAssociation: "OWNER", author: { login: "dev", __typename: "User" } },
            { body: "pushed an update", authorAssociation: "OWNER", author: { login: "dev", __typename: "User" } },
            { body: "thanks", authorAssociation: "OWNER", author: { login: "dev", __typename: "User" } }
          ]
        }
      }
    ]);

    const [t] = await fetchReviewThreads(octokit, ref, "prowl-bot");

    expect(t.fingerprints).toEqual(["fp1"]);
    expect(t.humanIntent).toBe("wont-fix");
  });

  it("does not expose an already-defended dispute until a newer human dispute arrives", async () => {
    const { octokit } = mockOctokit([
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [
            { body: "<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot", __typename: "Bot" } }
          ]
        },
        recentComments: {
          nodes: [
            { body: "<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot", __typename: "Bot" } },
            { body: "I disagree, this is guarded.", authorAssociation: "OWNER", author: { login: "dev", __typename: "User" } },
            {
              body: "Standing by this finding.\n\n<sub>prowl-review - re-evaluated after your reply (#22).</sub>",
              author: { login: "prowl-bot", __typename: "Bot" }
            }
          ]
        }
      }
    ]);

    const [t] = await fetchReviewThreads(octokit, ref, "prowl-bot");

    expect(t.fingerprints).toEqual(["fp1"]);
    expect(t.humanIntent).toBe("other");
    expect(t.humanReplyBody).toBeUndefined();
  });

  it("suppresses an already-withdrawn dispute until a newer human dispute arrives", async () => {
    const { octokit } = mockOctokit([
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [
            { body: "<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot", __typename: "Bot" } }
          ]
        },
        recentComments: {
          nodes: [
            { body: "I disagree, this is guarded.", authorAssociation: "OWNER", author: { login: "dev", __typename: "User" } },
            {
              body: buildRejustifyReply({ decision: "withdraw", reasoning: "The objection is correct." }),
              author: { login: "prowl-bot", __typename: "Bot" }
            }
          ]
        }
      }
    ]);

    const [t] = await fetchReviewThreads(octokit, ref, "prowl-bot");

    expect(t.fingerprints).toEqual(["fp1"]);
    expect(t.humanIntent).toBe("other");
    expect(t.humanReplyBody).toBeUndefined();
    expect(t.botRejustification).toBe("withdrawn");
  });

  it("classifies withdrawal only from the controlled reply header", async () => {
    const { octokit } = mockOctokit([
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [
            { body: "<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot", __typename: "Bot" } }
          ]
        },
        recentComments: {
          nodes: [
            { body: "I disagree, this is guarded.", authorAssociation: "OWNER", author: { login: "dev", __typename: "User" } },
            {
              body: [
                "**Standing by this finding.** Here's why, on reflection:",
                "",
                `The objection quoted ${REJUSTIFICATION_WITHDRAW_REPLY_PREFIX}, but the code still fails.`,
                "",
                `<sub>prowl-review - ${REJUSTIFICATION_REPLY_MARKER}.</sub>`
              ].join("\n"),
              author: { login: "prowl-bot", __typename: "Bot" }
            }
          ]
        }
      }
    ]);

    const [t] = await fetchReviewThreads(octokit, ref, "prowl-bot");

    expect(t.humanIntent).toBe("other");
    expect(t.humanReplyBody).toBeUndefined();
    expect(t.botRejustification).toBeUndefined();
  });

  it("re-exposes a defended dispute when the human replies again", async () => {
    const { octokit } = mockOctokit([
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [
            { body: "<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot", __typename: "Bot" } }
          ]
        },
        recentComments: {
          nodes: [
            { body: "I disagree, this is guarded.", authorAssociation: "OWNER", author: { login: "dev", __typename: "User" } },
            {
              body: "Standing by this finding.\n\n<sub>prowl-review - re-evaluated after your reply (#22).</sub>",
              author: { login: "prowl-bot", __typename: "Bot" }
            },
            { body: "I still disagree.", authorAssociation: "OWNER", author: { login: "dev", __typename: "User" } }
          ]
        }
      }
    ]);

    const [t] = await fetchReviewThreads(octokit, ref, "prowl-bot");

    expect(t.humanIntent).toBe("disagree");
    expect(t.humanReplyBody).toBe("I still disagree.");
  });

  it("lets a newer human dispute override an earlier withdrawal marker", async () => {
    const { octokit } = mockOctokit([
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [
            { body: "<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot", __typename: "Bot" } }
          ]
        },
        recentComments: {
          nodes: [
            { body: "I disagree, this is guarded.", authorAssociation: "OWNER", author: { login: "dev", __typename: "User" } },
            {
              body: buildRejustifyReply({ decision: "withdraw", reasoning: "The objection is correct." }),
              author: { login: "prowl-bot", __typename: "Bot" }
            },
            { body: "I still disagree after another run.", authorAssociation: "OWNER", author: { login: "dev", __typename: "User" } }
          ]
        }
      }
    ]);

    const [t] = await fetchReviewThreads(octokit, ref, "prowl-bot");

    expect(t.humanIntent).toBe("disagree");
    expect(t.humanReplyBody).toBe("I still disagree after another run.");
    expect(t.botRejustification).toBeUndefined();
  });

  it("ignores non-user comments when classifying human intent", async () => {
    const { octokit } = mockOctokit([
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [
            { body: "<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot", __typename: "Bot" } }
          ]
        },
        recentComments: {
          nodes: [
            { body: "acknowledged", author: { login: "other-bot", __typename: "Bot" } }
          ]
        }
      }
    ]);
    const [t] = await fetchReviewThreads(octokit, ref, "prowl-bot");
    expect(t.fingerprints).toEqual(["fp1"]);
    expect(t.humanIntent).toBe("other");
  });

  it("ignores untrusted user comments when classifying human intent", async () => {
    const { octokit } = mockOctokit([
      {
        id: "T1",
        isResolved: false,
        isOutdated: false,
        comments: {
          nodes: [
            { body: "<!-- prowl-review:finding fp1 -->", author: { login: "prowl-bot", __typename: "Bot" } }
          ]
        },
        recentComments: {
          nodes: [
            {
              body: "won't fix",
              authorAssociation: "CONTRIBUTOR",
              author: { login: "fork-author", __typename: "User" }
            }
          ]
        }
      }
    ]);
    const [t] = await fetchReviewThreads(octokit, ref, "prowl-bot");
    expect(t.fingerprints).toEqual(["fp1"]);
    expect(t.humanIntent).toBe("other");
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

  it("returns [] when the bot login cannot be resolved outside Actions", async () => {
    // Deterministic regardless of the CI env: no override, no PROWL_BOT_LOGIN,
    // not in Actions → login is genuinely unresolved, so no threads are fetched.
    const savedActions = process.env.GITHUB_ACTIONS;
    const savedLogin = process.env.PROWL_BOT_LOGIN;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.PROWL_BOT_LOGIN;
    try {
      const graphql = vi.fn();
      const octokit = {
        graphql,
        rest: { users: { getAuthenticated: vi.fn(async () => { throw new Error("no auth"); }) } }
      } as unknown as OctokitLike;
      expect(await fetchReviewThreads(octokit, ref)).toEqual([]);
      expect(graphql).not.toHaveBeenCalled();
    } finally {
      if (savedActions === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = savedActions;
      if (savedLogin === undefined) delete process.env.PROWL_BOT_LOGIN;
      else process.env.PROWL_BOT_LOGIN = savedLogin;
    }
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

describe("replyToReviewThread (#22)", () => {
  it("calls the reply mutation with the thread id and body", async () => {
    const graphql = vi.fn(async () => ({ addPullRequestReviewThreadReply: { comment: { id: "c1" } } }));
    const octokit = { graphql } as unknown as OctokitLike;
    expect(await replyToReviewThread(octokit, "T1", "Standing by this.")).toBe(true);
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("addPullRequestReviewThreadReply"), {
      threadId: "T1",
      body: "Standing by this."
    });
  });

  it("reports false tolerantly on failure", async () => {
    const graphql = vi.fn(async () => {
      throw new Error("no permission");
    });
    const octokit = { graphql } as unknown as OctokitLike;
    expect(await replyToReviewThread(octokit, "T1", "x")).toBe(false);
  });
});

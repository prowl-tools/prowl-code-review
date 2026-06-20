import { describe, expect, it, vi } from "vitest";
import {
  detectBreakGlass,
  matchesBreakGlass,
  BREAK_GLASS_TRUSTED_ASSOCIATIONS
} from "../src/github/break-glass.js";
import { REVIEW_MARKER } from "../src/review/walkthrough.js";
import type { OctokitLike } from "../src/github/client.js";

const ref = { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 };

interface Comment {
  id: number;
  body?: string;
  user?: { login?: string } | null;
  author_association?: string;
  created_at?: string;
}

function mockOctokit(comments: Comment[], reviewComments: Comment[] = []) {
  const listComments = vi.fn(async (params: { per_page?: number; page?: number; since?: string }) => {
    const since = params.since ? Date.parse(params.since) : undefined;
    const visible =
      since === undefined
        ? comments
        : comments.filter((comment) => {
            const updatedAt = comment.created_at ? Date.parse(comment.created_at) : Number.NaN;
            return Number.isFinite(updatedAt) && updatedAt > since;
          });
    const perPage = params.per_page ?? 30;
    const page = params.page ?? 1;
    const start = (page - 1) * perPage;
    return { data: visible.slice(start, start + perPage) };
  });
  const listReviewComments = vi.fn(async (params: { per_page?: number; page?: number }) => {
    const perPage = params.per_page ?? 30;
    const page = params.page ?? 1;
    const start = (page - 1) * perPage;
    return { data: reviewComments.slice(start, start + perPage) };
  });
  const octokit = { rest: { issues: { listComments }, pulls: { listReviewComments } } } as unknown as OctokitLike;
  return { octokit, listComments, listReviewComments };
}

describe("matchesBreakGlass (#52)", () => {
  it.each([
    "@prowl-review break glass",
    "@prowl-review break-glass",
    "@prowl-review breakglass",
    "please @prowl-review break glass to merge this hotfix",
    "@prowl-review   BREAK GLASS"
  ])("matches %j", (body) => {
    expect(matchesBreakGlass(body)).toBe(true);
  });

  it.each(["break glass", "@prowl-review approve", "glass break", undefined, null])(
    "does not match %j",
    (body) => {
      expect(matchesBreakGlass(body as string | undefined)).toBe(false);
    }
  );
});

describe("detectBreakGlass (#52)", () => {
  it("returns an active signal for a trusted override comment", async () => {
    const { octokit } = mockOctokit([
      { id: 1, body: "@prowl-review break glass", user: { login: "maintainer" }, author_association: "OWNER" }
    ]);
    const signal = await detectBreakGlass(octokit, ref);
    expect(signal).toEqual({ active: true, actor: "maintainer", association: "OWNER" });
  });

  it.each([...BREAK_GLASS_TRUSTED_ASSOCIATIONS])("honors a %s author", async (association) => {
    const { octokit } = mockOctokit([
      { id: 1, body: "@prowl-review break glass", user: { login: "x" }, author_association: association }
    ]);
    expect((await detectBreakGlass(octokit, ref)).active).toBe(true);
  });

  it.each(["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", undefined])(
    "ignores an untrusted (%s) author",
    async (association) => {
      const { octokit } = mockOctokit([
        { id: 1, body: "@prowl-review break glass", user: { login: "drive-by" }, author_association: association }
      ]);
      expect((await detectBreakGlass(octokit, ref)).active).toBe(false);
    }
  );

  it("never self-triggers from prowl-review's own marked summary comment", async () => {
    // The summary literally contains the override phrase as guidance; the marker
    // must keep the bot from honoring its own comment even under an owner token.
    const { octokit } = mockOctokit([
      {
        id: 1,
        body: `Approval gate: comment \`@prowl-review break glass\` to override.\n${REVIEW_MARKER}`,
        user: { login: "owner" },
        author_association: "OWNER"
      }
    ]);
    expect((await detectBreakGlass(octokit, ref)).active).toBe(false);
  });

  it("skips the configured bot login", async () => {
    const { octokit } = mockOctokit([
      { id: 1, body: "@prowl-review break glass", user: { login: "prowl-bot" }, author_association: "OWNER" }
    ]);
    expect((await detectBreakGlass(octokit, ref, { botLogin: "prowl-bot" })).active).toBe(false);
  });

  it("returns the newest trusted match when several exist", async () => {
    // GitHub lists issue comments oldest-first, so the last trusted match wins.
    const { octokit, listComments } = mockOctokit([
      {
        id: 1,
        body: "@prowl-review break glass",
        user: { login: "first" },
        author_association: "OWNER",
        created_at: "2026-06-17T14:00:00Z"
      },
      {
        id: 2,
        body: "@prowl-review break glass",
        user: { login: "second" },
        author_association: "MEMBER",
        created_at: "2026-06-17T15:00:00Z"
      }
    ]);
    const signal = await detectBreakGlass(octokit, ref);
    expect(signal.actor).toBe("second");
    expect(listComments).toHaveBeenCalledWith(
      expect.not.objectContaining({ sort: expect.anything(), direction: expect.anything() })
    );
  });

  it("paginates in API order and still chooses a newer override", async () => {
    const filler = Array.from({ length: 99 }, (_, index) => ({
      id: index + 2,
      body: "discussion",
      user: { login: "reviewer" },
      author_association: "MEMBER",
      created_at: "2026-06-17T14:01:00Z"
    }));
    const { octokit, listComments } = mockOctokit([
      {
        id: 1,
        body: "@prowl-review break glass",
        user: { login: "first" },
        author_association: "OWNER",
        created_at: "2026-06-17T14:00:00Z"
      },
      ...filler,
      {
        id: 101,
        body: "@prowl-review break glass",
        user: { login: "second" },
        author_association: "MEMBER",
        created_at: "2026-06-17T15:00:00Z"
      }
    ]);

    const signal = await detectBreakGlass(octokit, ref, { createdAfter: "2026-06-17T13:00:00Z" });

    expect(signal.actor).toBe("second");
    expect(listComments).toHaveBeenCalledTimes(2);
    expect(listComments).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ page: 1, since: "2026-06-17T13:00:00Z" })
    );
    expect(listComments).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2 }));
  });

  it("ignores override comments from before the current head commit", async () => {
    const { octokit } = mockOctokit([
      {
        id: 1,
        body: "@prowl-review break glass",
        user: { login: "maintainer" },
        author_association: "OWNER",
        created_at: "2026-06-17T12:00:00Z"
      }
    ]);

    const signal = await detectBreakGlass(octokit, ref, { createdAfter: "2026-06-17T13:00:00Z" });
    expect(signal.active).toBe(false);
  });

  it("fails closed without querying when createdAfter is invalid", async () => {
    const { octokit, listComments } = mockOctokit([
      {
        id: 1,
        body: "@prowl-review break glass",
        user: { login: "maintainer" },
        author_association: "OWNER",
        created_at: "2026-06-17T14:00:00Z"
      }
    ]);

    const signal = await detectBreakGlass(octokit, ref, { createdAfter: "not a date" });
    expect(signal.active).toBe(false);
    expect(listComments).not.toHaveBeenCalled();
  });

  it("honors override comments after the current head commit", async () => {
    const { octokit } = mockOctokit([
      {
        id: 1,
        body: "@prowl-review break glass",
        user: { login: "maintainer" },
        author_association: "OWNER",
        created_at: "2026-06-17T14:00:00Z"
      }
    ]);

    const signal = await detectBreakGlass(octokit, ref, { createdAfter: "2026-06-17T13:00:00Z" });
    expect(signal).toEqual({ active: true, actor: "maintainer", association: "OWNER" });
  });

  it("honors trusted inline review-comment overrides", async () => {
    const { octokit, listReviewComments } = mockOctokit([], [
      {
        id: 1,
        body: "@prowl-review break glass head-sha",
        user: { login: "reviewer" },
        author_association: "MEMBER",
        created_at: "2026-06-17T14:00:00Z"
      }
    ]);

    const signal = await detectBreakGlass(octokit, ref, { headSha: "head-sha" });

    expect(signal).toEqual({ active: true, actor: "reviewer", association: "MEMBER" });
    expect(listReviewComments).toHaveBeenCalledWith(expect.objectContaining({ pull_number: ref.pull_number }));
  });

  it("chooses the newest override across top-level and inline comments", async () => {
    const { octokit } = mockOctokit(
      [
        {
          id: 1,
          body: "@prowl-review break glass",
          user: { login: "maintainer" },
          author_association: "OWNER",
          created_at: "2026-06-17T14:00:00Z"
        }
      ],
      [
        {
          id: 2,
          body: "@prowl-review break glass",
          user: { login: "reviewer" },
          author_association: "COLLABORATOR",
          created_at: "2026-06-17T15:00:00Z"
        }
      ]
    );

    expect(await detectBreakGlass(octokit, ref)).toEqual({
      active: true,
      actor: "reviewer",
      association: "COLLABORATOR"
    });
  });

  it("requires the current head SHA when one is supplied", async () => {
    const { octokit } = mockOctokit([
      {
        id: 1,
        body: "@prowl-review break glass old-head",
        user: { login: "maintainer" },
        author_association: "OWNER",
        created_at: "2026-06-17T14:00:00Z"
      },
      {
        id: 2,
        body: "@prowl-review break glass new-head",
        user: { login: "maintainer" },
        author_association: "OWNER",
        created_at: "2026-06-17T15:00:00Z"
      }
    ]);

    const signal = await detectBreakGlass(octokit, ref, { headSha: "new-head" });
    expect(signal).toEqual({ active: true, actor: "maintainer", association: "OWNER" });
  });

  it("does not carry a break-glass override across head SHAs", async () => {
    const { octokit } = mockOctokit([
      {
        id: 1,
        body: "@prowl-review break glass old-head",
        user: { login: "maintainer" },
        author_association: "OWNER",
        created_at: "2026-06-17T14:00:00Z"
      }
    ]);

    const signal = await detectBreakGlass(octokit, ref, { headSha: "new-head" });
    expect(signal.active).toBe(false);
  });

  it("is inactive (never accidentally approves) when the read fails", async () => {
    const listComments = vi.fn(async () => {
      throw new Error("github unavailable");
    });
    const octokit = { rest: { issues: { listComments } } } as unknown as OctokitLike;
    expect(await detectBreakGlass(octokit, ref)).toEqual({ active: false });
  });

  it("is inactive when there are no override comments", async () => {
    const { octokit } = mockOctokit([
      { id: 1, body: "looks good to me", user: { login: "owner" }, author_association: "OWNER" }
    ]);
    expect((await detectBreakGlass(octokit, ref)).active).toBe(false);
  });
});

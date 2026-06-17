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

function mockOctokit(comments: Comment[]) {
  const listComments = vi.fn(async () => ({ data: comments }));
  const octokit = { rest: { issues: { listComments } } } as unknown as OctokitLike;
  return { octokit, listComments };
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
    // Listed newest-first (sort=created/desc), so the first trusted match wins.
    const { octokit, listComments } = mockOctokit([
      { id: 2, body: "@prowl-review break glass", user: { login: "second" }, author_association: "MEMBER" },
      { id: 1, body: "@prowl-review break glass", user: { login: "first" }, author_association: "OWNER" }
    ]);
    const signal = await detectBreakGlass(octokit, ref);
    expect(signal.actor).toBe("second");
    expect(listComments).toHaveBeenCalledWith(expect.objectContaining({ sort: "created", direction: "desc" }));
  });

  it("ignores override comments from before the current head push", async () => {
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

  it("honors override comments after the current head push", async () => {
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

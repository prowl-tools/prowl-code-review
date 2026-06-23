import { describe, expect, it, vi } from "vitest";
import { fetchPullRequest, fetchPullRequestMeta, fetchComparisonDiff, fetchPullRequestHeadSha } from "../src/github/diff.js";
import type { OctokitLike } from "../src/github/client.js";

function mockOctokit(prData: unknown, diff: string) {
  const get = vi.fn(async (params: { mediaType?: { format: string } }) => {
    if (params.mediaType?.format === "diff") {
      return { data: diff };
    }
    return { data: prData };
  });
  const octokit = { rest: { pulls: { get } } } as unknown as OctokitLike;
  return { octokit, get };
}

describe("fetchPullRequest", () => {
  const ref = { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 };

  it("fetches metadata and the raw diff and maps them", async () => {
    const { octokit, get } = mockOctokit(
      {
        number: 7,
        title: "Add thing",
        body: "does a thing",
        base: { sha: "base-sha" },
        head: { sha: "head-sha", repo: { name: "prowl-code-review", owner: { login: "prowl-tools" } } },
        draft: true,
        state: "open",
        user: { login: "michael" },
        changed_files: 3
      },
      "RAW DIFF TEXT"
    );

    const result = await fetchPullRequest(octokit, ref);

    expect(get).toHaveBeenCalledTimes(2);
    expect(result.diff).toBe("RAW DIFF TEXT");
    expect(result.meta).toEqual({
      number: 7,
      title: "Add thing",
      body: "does a thing",
      baseSha: "base-sha",
      headSha: "head-sha",
      draft: true,
      state: "open",
      author: "michael",
      changedFiles: 3
    });
  });

  it("tolerates a null author and missing optional fields", async () => {
    const { octokit } = mockOctokit(
      {
        number: 1,
        title: "t",
        body: null,
        base: { sha: "b" },
        head: { sha: "h" },
        state: "open",
        user: null
      },
      ""
    );

    const result = await fetchPullRequest(octokit, ref);
    expect(result.meta.author).toBeNull();
    expect(result.meta.draft).toBe(false);
    expect(result.meta.changedFiles).toBe(0);
  });
});

describe("fetchPullRequestMeta", () => {
  const ref = { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 };

  it("fetches and normalizes metadata without requesting the raw diff", async () => {
    const { octokit, get } = mockOctokit(
      {
        number: 7,
        title: "Add thing",
        body: null,
        base: { sha: "base-sha" },
        head: { sha: "head-sha" },
        draft: undefined,
        state: "open",
        user: null
      },
      "RAW DIFF TEXT"
    );

    await expect(fetchPullRequestMeta(octokit, ref)).resolves.toEqual({
      number: 7,
      title: "Add thing",
      body: null,
      baseSha: "base-sha",
      headSha: "head-sha",
      draft: false,
      state: "open",
      author: null,
      changedFiles: 0
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(expect.not.objectContaining({ mediaType: expect.anything() }));
  });
});

describe("fetchComparisonDiff (#23)", () => {
  const ref = { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 };

  it("verifies ancestry before requesting the BASE...HEAD raw diff", async () => {
    const compareCommitsWithBasehead = vi.fn(async (params: { mediaType?: { format: string } }) => ({
      data: params.mediaType?.format === "diff" ? "DELTA DIFF" : { status: "ahead" }
    }));
    const octokit = { rest: { repos: { compareCommitsWithBasehead } } } as unknown as OctokitLike;

    const diff = await fetchComparisonDiff(octokit, ref, "old-sha", "new-sha");

    expect(diff).toBe("DELTA DIFF");
    expect(compareCommitsWithBasehead).toHaveBeenCalledTimes(2);
    expect(compareCommitsWithBasehead).toHaveBeenNthCalledWith(1, {
      owner: "prowl-tools",
      repo: "prowl-code-review",
      basehead: "old-sha...new-sha"
    });
    expect(compareCommitsWithBasehead).toHaveBeenNthCalledWith(2, {
      owner: "prowl-tools",
      repo: "prowl-code-review",
      basehead: "old-sha...new-sha",
      mediaType: { format: "diff" }
    });
  });

  it("returns an empty diff when the compare range is identical", async () => {
    const compareCommitsWithBasehead = vi.fn(async () => ({ data: { status: "identical" } }));
    const octokit = { rest: { repos: { compareCommitsWithBasehead } } } as unknown as OctokitLike;

    await expect(fetchComparisonDiff(octokit, ref, "old-sha", "new-sha")).resolves.toBe("");

    expect(compareCommitsWithBasehead).toHaveBeenCalledTimes(1);
  });

  it("rejects diverged comparisons so the caller can run a full review", async () => {
    const compareCommitsWithBasehead = vi.fn(async () => ({ data: { status: "diverged" } }));
    const octokit = { rest: { repos: { compareCommitsWithBasehead } } } as unknown as OctokitLike;

    await expect(fetchComparisonDiff(octokit, ref, "old-sha", "new-sha")).rejects.toThrow(
      /base is not an ancestor/
    );

    expect(compareCommitsWithBasehead).toHaveBeenCalledTimes(1);
  });

  it("propagates errors so the caller can fall back to a full review", async () => {
    const compareCommitsWithBasehead = vi.fn(async () => {
      throw new Error("404 Not Found");
    });
    const octokit = { rest: { repos: { compareCommitsWithBasehead } } } as unknown as OctokitLike;
    await expect(fetchComparisonDiff(octokit, ref, "old", "new")).rejects.toThrow(/404/);
  });
});

describe("fetchPullRequestHeadSha (#21)", () => {
  const ref = { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 };

  it("returns the current PR head SHA", async () => {
    const get = vi.fn(async () => ({ data: { head: { sha: "current-head" } } }));
    const octokit = { rest: { pulls: { get } } } as unknown as OctokitLike;
    expect(await fetchPullRequestHeadSha(octokit, ref)).toBe("current-head");
    // A lightweight metadata-only call (no diff media type).
    expect(get).toHaveBeenCalledWith(expect.not.objectContaining({ mediaType: expect.anything() }));
  });

  it("returns undefined tolerantly when the read fails (never blocks publishing)", async () => {
    const get = vi.fn(async () => {
      throw new Error("502");
    });
    const octokit = { rest: { pulls: { get } } } as unknown as OctokitLike;
    expect(await fetchPullRequestHeadSha(octokit, ref)).toBeUndefined();
  });
});

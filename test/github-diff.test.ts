import { describe, expect, it, vi } from "vitest";
import { fetchPullRequest, fetchComparisonDiff } from "../src/github/diff.js";
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
        head: { sha: "head-sha" },
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

describe("fetchComparisonDiff (#23)", () => {
  const ref = { owner: "prowl-tools", repo: "prowl-code-review", pull_number: 7 };

  it("requests the BASE...HEAD range as a raw diff and returns the body", async () => {
    const compareCommitsWithBasehead = vi.fn(async () => ({ data: "DELTA DIFF" }));
    const octokit = { rest: { repos: { compareCommitsWithBasehead } } } as unknown as OctokitLike;

    const diff = await fetchComparisonDiff(octokit, ref, "old-sha", "new-sha");

    expect(diff).toBe("DELTA DIFF");
    expect(compareCommitsWithBasehead).toHaveBeenCalledWith({
      owner: "prowl-tools",
      repo: "prowl-code-review",
      basehead: "old-sha...new-sha",
      mediaType: { format: "diff" }
    });
  });

  it("propagates errors so the caller can fall back to a full review", async () => {
    const compareCommitsWithBasehead = vi.fn(async () => {
      throw new Error("404 Not Found");
    });
    const octokit = { rest: { repos: { compareCommitsWithBasehead } } } as unknown as OctokitLike;
    await expect(fetchComparisonDiff(octokit, ref, "old", "new")).rejects.toThrow(/404/);
  });
});

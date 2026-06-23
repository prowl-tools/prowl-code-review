import { describe, expect, it, vi } from "vitest";
import { fetchIssue } from "../src/github/issues.js";
import type { OctokitLike } from "../src/github/client.js";

const ref = { owner: "o", repo: "r", number: 5 };

function octokitReturning(data: unknown): OctokitLike {
  return { rest: { issues: { get: vi.fn(async () => ({ data })) } } } as unknown as OctokitLike;
}

describe("fetchIssue (#32)", () => {
  it("returns the issue title + body", async () => {
    const issue = await fetchIssue(octokitReturning({ title: "Theme", body: "Support dark mode." }), ref);
    expect(issue).toEqual({ ref, title: "Theme", body: "Support dark mode." });
  });

  it("skips a reference that is actually a pull request", async () => {
    const issue = await fetchIssue(octokitReturning({ title: "A PR", body: "x", pull_request: { url: "..." } }), ref);
    expect(issue).toBeNull();
  });

  it("skips an empty issue", async () => {
    expect(await fetchIssue(octokitReturning({ title: "  ", body: "" }), ref)).toBeNull();
  });

  it("returns null (tolerant) when the fetch throws", async () => {
    const octokit = {
      rest: { issues: { get: vi.fn(async () => { throw new Error("404"); }) } }
    } as unknown as OctokitLike;
    expect(await fetchIssue(octokit, ref)).toBeNull();
  });
});

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

  it.each([
    [403, "forbidden"],
    [404, "not found"],
    [410, "gone"],
    [451, "unavailable for legal reasons"]
  ])("returns null for permanent unusable issue response %i", async (status, message) => {
    const octokit = {
      rest: {
        issues: {
          get: vi.fn(async () => {
            throw Object.assign(new Error(message), { status });
          })
        }
      }
    } as unknown as OctokitLike;
    expect(await fetchIssue(octokit, ref)).toBeNull();
  });

  it("throws transient fetch errors so the pipeline can report degraded validation", async () => {
    const octokit = {
      rest: {
        issues: {
          get: vi.fn(async () => {
            throw Object.assign(new Error("rate limited"), { status: 429 });
          })
        }
      }
    } as unknown as OctokitLike;
    await expect(fetchIssue(octokit, ref)).rejects.toThrow(/rate limited/);
  });
});

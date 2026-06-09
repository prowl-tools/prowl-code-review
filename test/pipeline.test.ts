import { describe, expect, it, vi } from "vitest";
import { reviewPullRequest } from "../src/pipeline.js";
import type { OctokitLike } from "../src/github/client.js";
import type { ProviderConfig } from "../src/providers/index.js";
import type { ReviewResult } from "../src/review/run-review.js";
import type { Finding } from "../src/review/findings.js";

const config: ProviderConfig = { provider: "anthropic", model: "m", apiKey: "k" };
const ref = { owner: "o", repo: "r", pull_number: 7 };
const octokit = {} as unknown as OctokitLike;

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 const c = 3;
`;

const meta = {
  number: 7, title: "T", body: null, baseSha: "base", headSha: "head",
  draft: false, state: "open", author: "me", changedFiles: 1
};

function finding(over: Partial<Finding> = {}): Finding {
  return { file: "src/a.ts", line: 2, severity: "major", category: "correctness", title: "Bug", body: "b", confidence: 0.7, ...over };
}

function reviewResult(findings: Finding[], over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    findings,
    raw: findings,
    passes: [],
    judge: { duplicatesRemoved: 0, belowThreshold: 0, belowConfidence: 0, capped: 0 },
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    ...over
  };
}

function makeDeps() {
  return {
    fetchPullRequest: vi.fn(async () => ({ meta, diff: DIFF })),
    gatherContext: vi.fn(async () => ({
      files: [{ path: "src/a.ts", content: "export const a = 1;", truncated: false }],
      rounds: 1,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      reachedLimit: false,
      notes: [],
      toolOutputs: []
    })),
    runReview: vi.fn(async () => reviewResult([finding()])),
    submitReview: vi.fn(async () => {})
  };
}

describe("reviewPullRequest", () => {
  it("composes the pipeline and publishes one review", async () => {
    const deps = makeDeps();
    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    expect(deps.gatherContext).toHaveBeenCalledWith(
      expect.objectContaining({ changedPaths: ["src/a.ts"] })
    );

    const reviewInput = deps.runReview.mock.calls[0][0];
    expect(reviewInput.diff).toContain("     2 +const b = 2;"); // size-guarded, annotated diff
    expect(reviewInput.context).toContain("export const a = 1;"); // gathered context threaded in

    expect(deps.submitReview).toHaveBeenCalledTimes(1);
    const [, , payload, commitId] = deps.submitReview.mock.calls[0];
    expect(commitId).toBe("head");
    expect(payload.body).toContain("prowl-review");
    expect(payload.comments).toHaveLength(1); // finding on line 2 anchors inline

    expect(result.posted).toBe(true);
    expect(result.contextFiles).toBe(1);
  });

  it("does not publish on a dry run", async () => {
    const deps = makeDeps();
    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps, dryRun: true });
    expect(deps.submitReview).not.toHaveBeenCalled();
    expect(result.posted).toBe(false);
  });

  it("skips agentic context when asked", async () => {
    const deps = makeDeps();
    await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps, skipContext: true });
    expect(deps.gatherContext).not.toHaveBeenCalled();
    expect(deps.runReview.mock.calls[0][0].context).toBeUndefined();
  });

  it("surfaces context retrieval notes in the summary", async () => {
    const deps = makeDeps();
    deps.gatherContext.mockResolvedValue({
      files: [{ path: "src/a.ts", content: "export const a = 1;", truncated: false }],
      rounds: 6,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      reachedLimit: true,
      notes: ["Reached max tool rounds (6)."],
      toolOutputs: []
    });

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    expect(result.payload.body).toContain("Review notes");
    expect(result.payload.body).toContain("Context retrieval: Reached max tool rounds");
  });

  it("falls back to diff-only review when context retrieval fails", async () => {
    const deps = makeDeps();
    deps.gatherContext.mockRejectedValue(new Error("provider timeout"));

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    expect(deps.runReview).toHaveBeenCalledTimes(1);
    expect(deps.runReview.mock.calls[0][0].context).toBeUndefined();
    expect(deps.submitReview).toHaveBeenCalledTimes(1);
    expect(result.contextFiles).toBe(0);
    expect(result.payload.body).toContain("Context retrieval failed");
    expect(result.payload.body).toContain("provider timeout");
  });

  it("surfaces failed review passes so clean summaries are not misleading", async () => {
    const deps = makeDeps();
    deps.runReview.mockResolvedValue(
      reviewResult([], {
        passes: [
          { specialist: "correctness", findings: 0, ok: false, error: "provider rejected prompt" },
          { specialist: "security", findings: 0, ok: true }
        ]
      })
    );

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    expect(result.payload.body).toContain("_No blocking issues found._");
    expect(result.payload.body).toContain("1/2 review specialist passes failed");
    expect(result.payload.body).toContain("Review pass \"correctness\" failed: provider rejected prompt");
  });

  it("skips sensitive files and redacts secrets before review", async () => {
    const deps = makeDeps();
    const sensitiveDiff = `diff --git a/.env b/.env
new file mode 100644
--- /dev/null
+++ b/.env
@@ -0,0 +1 @@
+API_KEY=AKIAIOSFODNN7EXAMPLE
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
 const a = 1;
+const t = "ghp_${"a".repeat(36)}";
diff --git a/.env b/config/example.txt
similarity index 72%
rename from .env
rename to config/example.txt
--- a/.env
+++ b/config/example.txt
@@ -1 +1 @@
-DATABASE_URL=postgres://user:pass@host/db
+DATABASE_URL=postgres://user:pass@host/db
`;
    deps.fetchPullRequest.mockResolvedValue({ meta, diff: sensitiveDiff });

    const result = await reviewPullRequest(octokit, ref, {
      config,
      toolkitRoot: "/repo",
      diffLimits: { maxFiles: 1 },
      deps
    });

    // .env is kept out of the review entirely and reported.
    expect(result.skipped).toContainEqual({ path: ".env", reason: "sensitive" });
    expect(result.skipped).toContainEqual({ path: "config/example.txt", reason: "sensitive" });
    expect(deps.gatherContext.mock.calls[0][0].changedPaths).toEqual(["src/a.ts"]);

    const diffInput = deps.runReview.mock.calls[0][0].diff;
    expect(diffInput).not.toContain(".env");
    expect(diffInput).not.toContain("config/example.txt");
    expect(diffInput).not.toContain("postgres://user:pass@host/db");
    expect(diffInput).toContain("src/a.ts");
    expect(diffInput).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(diffInput).not.toContain("ghp_aaaa");
    expect(diffInput).toContain("[REDACTED");
    expect(result.payload.body).toContain("sensitive");
  });

  it("redacts private key blocks after rendering annotated diffs", async () => {
    const deps = makeDeps();
    const privateKeyDiff = `diff --git a/README.md b/README.md
new file mode 100644
--- /dev/null
+++ b/README.md
@@ -0,0 +1,3 @@
+-----BEGIN RSA PRIVATE KEY-----
+MIIsecretbytes
+-----END RSA PRIVATE KEY-----
`;
    deps.fetchPullRequest.mockResolvedValue({ meta, diff: privateKeyDiff });

    await reviewPullRequest(octokit, ref, { config, deps, skipContext: true });

    const diffInput = deps.runReview.mock.calls[0][0].diff;
    expect(diffInput).toContain("[REDACTED:private-key]");
    expect(diffInput).not.toContain("MIIsecretbytes");
    expect(diffInput).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("surfaces high-signal suppression in the review notes", async () => {
    const deps = makeDeps();
    deps.runReview.mockResolvedValue(
      reviewResult([finding()], {
        judge: { duplicatesRemoved: 0, belowThreshold: 0, belowConfidence: 2, capped: 3 }
      })
    );

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    // Note text is markdown-escaped in the walkthrough, so match escape-safe substrings.
    expect(result.payload.body).toContain("Hid 2 low");
    expect(result.payload.body).toContain("3 additional lower");
  });
});

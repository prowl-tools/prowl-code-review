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
    verification: { verified: 0, droppedFalsePositive: 0, demoted: 0, unverified: 0, ok: true },
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
    gatherGrounding: vi.fn(async () => ({ findings: [], notes: [] })),
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
    const [, , payload, submitOptions] = deps.submitReview.mock.calls[0];
    expect(submitOptions).toEqual({ commitId: "head", headSha: "head" });
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

  it("ignores generated/vendored files by default and reports them as skipped (#19)", async () => {
    const deps = makeDeps();
    deps.fetchPullRequest = vi.fn(async () => ({
      meta,
      diff: `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 const a = 1;
+const b = 2;
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,1 +1,2 @@
 {}
+{"x":1}
`
    }));

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    // Only the source file reaches the reviewer; the lockfile is skipped, not dropped.
    const reviewInput = deps.runReview.mock.calls[0][0];
    expect(reviewInput.diff).toContain("src/a.ts");
    expect(reviewInput.diff).not.toContain("package-lock.json");
    expect(result.skipped).toContainEqual({ path: "package-lock.json", reason: "ignored" });
    expect(result.payload.body).toContain("Not reviewed");
    expect(result.payload.body).toContain("package-lock.json");
  });

  it("reviews an ignored-by-default file when the config opts out with an empty list (#19)", async () => {
    const deps = makeDeps();
    deps.fetchPullRequest = vi.fn(async () => ({
      meta,
      diff: `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,1 +1,2 @@
 {}
+{"x":1}
`
    }));

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps, ignore: [] });

    const reviewInput = deps.runReview.mock.calls[0][0];
    expect(reviewInput.diff).toContain("package-lock.json"); // nothing ignored
    expect(result.skipped).not.toContainEqual({ path: "package-lock.json", reason: "ignored" });
  });

  it("skips agentic context when asked", async () => {
    const deps = makeDeps();
    await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps, skipContext: true });
    expect(deps.gatherContext).not.toHaveBeenCalled();
    expect(deps.runReview.mock.calls[0][0].context).toBeUndefined();
  });

  it("runs linter grounding and threads it into the review (#16)", async () => {
    const deps = makeDeps();
    const lint = {
      file: "src/a.ts", line: 2, severity: "minor" as const,
      category: "lint", title: "no-debugger", body: "no debugger", confidence: 0.9
    };
    deps.gatherGrounding.mockResolvedValue({ findings: [lint], notes: ["ESLint: 1 grounding finding(s)."] });

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    expect(deps.gatherGrounding).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/repo",
        changedPaths: ["src/a.ts"],
        changedLines: { "src/a.ts": [2] },
        trustWorkspace: false
      })
    );
    const reviewInput = deps.runReview.mock.calls[0][0];
    expect(reviewInput.grounding.findings).toEqual([lint]);
    expect(reviewInput.grounding.summary).toContain("no-debugger");
    expect(result.payload.body).toContain("Linter grounding");
    expect(result.payload.body).toContain("ESLint");
  });

  it("passes the trusted workspace opt-in to grounding", async () => {
    const deps = makeDeps();
    await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps, trustWorkspace: true });
    expect(deps.gatherGrounding).toHaveBeenCalledWith(
      expect.objectContaining({ trustWorkspace: true })
    );
  });

  it("redacts linter grounding before it reaches review prompts", async () => {
    const deps = makeDeps();
    const lint = {
      file: "src/a.ts",
      line: 2,
      severity: "minor" as const,
      category: "lint",
      title: "custom-rule",
      body: "SECRET_KEY=django-insecure-super-secret-value",
      confidence: 0.9
    };
    deps.gatherGrounding.mockResolvedValue({ findings: [lint], notes: [] });

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    const grounding = deps.runReview.mock.calls[0][0].grounding;
    expect(grounding.findings[0].body).toContain("[REDACTED:assignment]");
    expect(grounding.summary).toContain("[REDACTED:assignment]");
    expect(grounding.summary).not.toContain("django-insecure");
    expect(result.payload.body).toContain("Redacted 1 secret\\(s\\) from linter grounding output.");
  });

  it("redacts linter grounding notes before publishing them", async () => {
    const deps = makeDeps();
    deps.gatherGrounding.mockResolvedValue({
      findings: [],
      notes: ["ESLint failed: SECRET_KEY=django-insecure-super-secret-value"]
    });

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    expect(result.payload.body).toContain("REDACTED:assignment");
    expect(result.payload.body).toContain("Redacted 1 secret\\(s\\) from linter grounding output.");
    expect(result.payload.body).not.toContain("django-insecure");
  });

  it("skips grounding when asked", async () => {
    const deps = makeDeps();
    await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps, skipGrounding: true });
    expect(deps.gatherGrounding).not.toHaveBeenCalled();
    expect(deps.runReview.mock.calls[0][0].grounding).toBeUndefined();
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

  it("renders context retrieval failures as degraded when no findings remain", async () => {
    const deps = makeDeps();
    deps.gatherContext.mockRejectedValue(new Error("provider timeout"));
    deps.runReview.mockResolvedValue(
      reviewResult([], {
        passes: [
          { specialist: "correctness", findings: 0, ok: true },
          { specialist: "security", findings: 0, ok: true }
        ]
      })
    );

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    expect(deps.submitReview).toHaveBeenCalledTimes(1);
    expect(result.payload.body).toContain("⚠️ **Review incomplete** — coverage degraded");
    expect(result.payload.body).toContain("Context retrieval failed");
    expect(result.payload.body).not.toContain("No issues found");
  });

  it("renders context retrieval limit hits as clean-with-note, not degraded (#56)", async () => {
    // A hit bound (max rounds/files) or truncated search is partial context on an
    // otherwise healthy review — benign, like a guardrail file-skip. It must NOT
    // escalate the whole review to "Review incomplete"; the note still surfaces it.
    const deps = makeDeps();
    deps.gatherContext.mockResolvedValue({
      files: [{ path: "src/a.ts", content: "export const a = 1;", truncated: false }],
      rounds: 6,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      reachedLimit: true,
      notes: ["Reached max tool rounds (6)."],
      toolOutputs: []
    });
    deps.runReview.mockResolvedValue(
      reviewResult([], {
        passes: [
          { specialist: "correctness", findings: 0, ok: true },
          { specialist: "security", findings: 0, ok: true }
        ]
      })
    );

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    expect(result.payload.body).not.toContain("Review incomplete");
    expect(result.payload.body).toContain("No issues found");
    // Honest truncation (#5): the bound is still reported, just not as a failure.
    expect(result.payload.body).toContain("Reached max tool rounds");
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

    // A failed pass renders the degraded state — never a clean "no issues" (#56).
    expect(result.payload.body).toContain("⚠️ **Review incomplete** — 1/2 specialist passes failed");
    expect(result.payload.body).toContain("Review pass \"correctness\" failed: provider rejected prompt");
    expect(result.payload.body).not.toContain("No blocking issues found");
  });

  it("renders the compact clean state when healthy with no findings", async () => {
    const deps = makeDeps();
    deps.runReview.mockResolvedValue(
      reviewResult([], {
        passes: [
          { specialist: "correctness", findings: 0, ok: true },
          { specialist: "security", findings: 0, ok: true }
        ]
      })
    );

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    expect(result.payload.body).toContain("✅ No issues found");
    expect(result.payload.body).toContain("2/2 passes");
    expect(result.payload.body).not.toContain("Findings: none");
    expect(result.payload.body).not.toContain("Review incomplete");
  });

  it("renders a degraded state when verification fails, even with no findings", async () => {
    const deps = makeDeps();
    deps.runReview.mockResolvedValue(
      reviewResult([], {
        passes: [
          { specialist: "correctness", findings: 0, ok: true },
          { specialist: "security", findings: 0, ok: true }
        ],
        verification: {
          verified: 0,
          droppedFalsePositive: 0,
          demoted: 0,
          unverified: 0,
          ok: false,
          error: "provider timeout"
        }
      })
    );

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    expect(result.payload.body).toContain("⚠️ **Review incomplete** — coverage degraded");
    expect(result.payload.body).toContain("False-positive verification failed");
    expect(result.payload.body).toContain("provider timeout");
    expect(result.payload.body).not.toContain("No issues found");
  });

  it("renders skipped-file reviews as clean-with-caveat, not degraded (#56)", async () => {
    const deps = makeDeps();
    const twoFileDiff = `${DIFF}diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1,2 @@
 const b = 1;
+const c = 2;
`;
    deps.fetchPullRequest.mockResolvedValue({ meta, diff: twoFileDiff });
    deps.runReview.mockResolvedValue(
      reviewResult([], {
        passes: [
          { specialist: "correctness", findings: 0, ok: true },
          { specialist: "security", findings: 0, ok: true }
        ]
      })
    );

    const result = await reviewPullRequest(octokit, ref, {
      config,
      toolkitRoot: "/repo",
      diffLimits: { maxFiles: 1 },
      deps
    });

    expect(result.skipped).toContainEqual({ path: "src/b.ts", reason: "maxFiles" });
    // A healthy review that skipped files is partial, not failed: clean state with
    // an honest caveat headline + the "Not reviewed" note — never the alarming
    // "Review incomplete" reserved for actual failures.
    expect(result.payload.body).toContain("✅ No issues found in reviewed files");
    expect(result.payload.body).toContain("Not reviewed");
    expect(result.payload.body).toContain("skipped - file limit reached");
    expect(result.payload.body).toContain("src/b.ts");
    expect(result.payload.body).not.toContain("Review incomplete");
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
diff --git a/config/public.txt b/secrets/prod.txt
similarity index 72%
rename from config/public.txt
rename to secrets/prod.txt
--- a/config/public.txt
+++ b/secrets/prod.txt
@@ -1 +1 @@
-PUBLIC_VALUE=example
+PUBLIC_VALUE=example
`;
    deps.fetchPullRequest.mockResolvedValue({ meta, diff: sensitiveDiff });
    deps.runReview.mockResolvedValue(reviewResult([]));

    const result = await reviewPullRequest(octokit, ref, {
      config,
      toolkitRoot: "/repo",
      diffLimits: { maxFiles: 1 },
      deps
    });

    // .env is kept out of the review entirely and reported.
    expect(result.skipped).toContainEqual({ path: ".env", reason: "sensitive" });
    expect(result.skipped).toContainEqual({ path: "config/example.txt", reason: "sensitive" });
    expect(result.skipped).toContainEqual({ path: "secrets/prod.txt", reason: "sensitive" });
    expect(deps.gatherContext.mock.calls[0][0].changedPaths).toEqual(["src/a.ts"]);

    const diffInput = deps.runReview.mock.calls[0][0].diff;
    expect(diffInput).not.toContain(".env");
    expect(diffInput).not.toContain("config/example.txt");
    expect(diffInput).not.toContain("secrets/prod.txt");
    expect(diffInput).not.toContain("config/public.txt");
    expect(diffInput).not.toContain("postgres://user:pass@host/db");
    expect(diffInput).toContain("src/a.ts");
    expect(diffInput).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(diffInput).not.toContain("ghp_aaaa");
    expect(diffInput).toContain("[REDACTED");
    expect(result.payload.body).toContain("sensitive");
    // Sensitive/size skips are partial coverage, not a failed review: clean + caveat.
    expect(result.payload.body).toContain("✅ No issues found in reviewed files");
    expect(result.payload.body).not.toContain("Review incomplete");
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
        judge: { duplicatesRemoved: 0, belowThreshold: 1, belowConfidence: 2, capped: 3 }
      })
    );

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    // Note text is markdown-escaped in the walkthrough, so match escape-safe substrings.
    expect(result.payload.body).toContain("Hid 1 finding");
    expect(result.payload.body).toContain("severity floor");
    expect(result.payload.body).toContain("Hid 2 low");
    expect(result.payload.body).toContain("3 additional lower");
  });

  it("surfaces verification outcomes in the review notes", async () => {
    const deps = makeDeps();
    deps.runReview.mockResolvedValue(
      reviewResult([finding()], {
        verification: { verified: 4, droppedFalsePositive: 2, demoted: 1, unverified: 1, ok: true }
      })
    );

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    expect(result.payload.body).toContain("Dropped 2 finding");
    expect(result.payload.body).toContain("false positive");
    expect(result.payload.body).toContain("Lowered confidence on 1 finding");
    expect(result.payload.body).toContain("could not be verified");
  });

  it("reports a verification failure in the review notes", async () => {
    const deps = makeDeps();
    deps.runReview.mockResolvedValue(
      reviewResult([finding()], {
        verification: {
          verified: 0,
          droppedFalsePositive: 0,
          demoted: 0,
          unverified: 2,
          ok: false,
          error: "verifier down"
        }
      })
    );

    const result = await reviewPullRequest(octokit, ref, { config, toolkitRoot: "/repo", deps });

    expect(result.payload.body).toContain("verification failed");
    expect(result.payload.body).toContain("verifier down");
  });
});

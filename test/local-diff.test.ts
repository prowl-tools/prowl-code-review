import { describe, expect, it, vi } from "vitest";
import {
  assertLocalHeadMatchesCheckout,
  resolveLocalDiff,
  resolveLocalWorkspace,
  LocalDiffError
} from "../src/review/local-diff.js";

describe("resolveLocalDiff", () => {
  it("diffs base against head using --merge-base when head is given", async () => {
    const exec = vi.fn().mockResolvedValue("DIFF");
    const diff = await resolveLocalDiff({ base: "main", head: "feature", cwd: "/repo", exec });
    expect(diff).toBe("DIFF");
    expect(exec).toHaveBeenCalledWith([
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--find-renames",
      "--find-copies",
      "--find-copies-harder",
      "--merge-base",
      "--end-of-options",
      "main",
      "feature"
    ]);
  });

  it("diffs base against the working tree when head is omitted", async () => {
    const exec = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("WT");
    const diff = await resolveLocalDiff({ base: "main", cwd: "/repo", exec });
    expect(diff).toBe("WT");
    expect(exec).toHaveBeenNthCalledWith(1, ["ls-files", "--others", "--exclude-standard", "-z"]);
    expect(exec).toHaveBeenNthCalledWith(2, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--find-renames",
      "--find-copies",
      "--find-copies-harder",
      "--merge-base",
      "--end-of-options",
      "main"
    ]);
  });

  it("trims surrounding whitespace from the refs", async () => {
    const exec = vi.fn().mockResolvedValue("");
    await resolveLocalDiff({ base: "  develop  ", head: "  topic  ", cwd: "/repo", exec });
    expect(exec).toHaveBeenCalledWith([
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--find-renames",
      "--find-copies",
      "--find-copies-harder",
      "--merge-base",
      "--end-of-options",
      "develop",
      "topic"
    ]);
  });

  it("treats a blank head as the working tree", async () => {
    const exec = vi.fn().mockResolvedValue("");
    await resolveLocalDiff({ base: "main", head: "   ", cwd: "/repo", exec });
    expect(exec).toHaveBeenNthCalledWith(1, ["ls-files", "--others", "--exclude-standard", "-z"]);
    expect(exec).toHaveBeenNthCalledWith(2, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--find-renames",
      "--find-copies",
      "--find-copies-harder",
      "--merge-base",
      "--end-of-options",
      "main"
    ]);
  });

  it("rejects untracked files when reviewing the working tree", async () => {
    const exec = vi.fn().mockResolvedValueOnce("new.ts\0config/example.txt\0");
    await expect(resolveLocalDiff({ base: "main", cwd: "/repo", exec })).rejects.toThrow(
      /does not include untracked files \(new.ts, config\/example.txt\)/
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(["ls-files", "--others", "--exclude-standard", "-z"]);
  });

  it("ignores prowl's generated local output when checking working-tree untracked files", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(".prowl-review/debug.jsonl\0.prowl-review/usage.jsonl\0")
      .mockResolvedValueOnce("DIFF");

    await expect(resolveLocalDiff({ base: "main", cwd: "/repo", exec })).resolves.toBe("DIFF");
    expect(exec).toHaveBeenNthCalledWith(1, ["ls-files", "--others", "--exclude-standard", "-z"]);
    expect(exec).toHaveBeenNthCalledWith(2, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--find-renames",
      "--find-copies",
      "--find-copies-harder",
      "--merge-base",
      "--end-of-options",
      "main"
    ]);
  });

  it("passes refs after --end-of-options so ref names cannot be parsed as git options", async () => {
    const exec = vi.fn().mockResolvedValue("");
    await resolveLocalDiff({ base: "--help", head: "--stat", cwd: "/repo", exec });
    expect(exec).toHaveBeenCalledWith([
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--find-renames",
      "--find-copies",
      "--find-copies-harder",
      "--merge-base",
      "--end-of-options",
      "--help",
      "--stat"
    ]);
  });

  it("rejects an empty base ref", async () => {
    await expect(resolveLocalDiff({ base: "   ", cwd: "/repo", exec: vi.fn() })).rejects.toBeInstanceOf(
      LocalDiffError
    );
  });

  it("propagates a git failure as a LocalDiffError", async () => {
    const exec = vi.fn().mockRejectedValue(new LocalDiffError("git diff failed: bad revision"));
    await expect(resolveLocalDiff({ base: "main", cwd: "/repo", exec })).rejects.toThrow(/bad revision/);
  });
});

describe("resolveLocalWorkspace", () => {
  it("prefers an explicit injected workspace", async () => {
    const exec = vi.fn();
    await expect(
      resolveLocalWorkspace({
        cwd: "/repo/subdir",
        env: { PROWL_WORKSPACE: " /repo " } as NodeJS.ProcessEnv,
        exec
      })
    ).resolves.toBe("/repo");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to the git repository top-level", async () => {
    const exec = vi.fn().mockResolvedValue("/repo\n");
    await expect(resolveLocalWorkspace({ cwd: "/repo/subdir", env: {}, exec })).resolves.toBe("/repo");
    expect(exec).toHaveBeenCalledWith(["rev-parse", "--show-toplevel"]);
  });

  it("uses GitHub workspace when PROWL_WORKSPACE is blank", async () => {
    const exec = vi.fn();
    await expect(
      resolveLocalWorkspace({
        cwd: "/repo/subdir",
        env: { PROWL_WORKSPACE: "  ", GITHUB_WORKSPACE: " /actions/repo " } as NodeJS.ProcessEnv,
        exec
      })
    ).resolves.toBe("/actions/repo");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("assertLocalHeadMatchesCheckout", () => {
  it("does nothing when head is omitted or blank", async () => {
    const exec = vi.fn();
    await assertLocalHeadMatchesCheckout({ cwd: "/repo", exec });
    await assertLocalHeadMatchesCheckout({ cwd: "/repo", head: "   ", exec });
    expect(exec).not.toHaveBeenCalled();
  });

  it("allows an explicit head that resolves to the checked-out HEAD", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    await assertLocalHeadMatchesCheckout({ cwd: "/repo", head: "feature", exec });
    expect(exec).toHaveBeenNthCalledWith(1, ["rev-parse", "--verify", "HEAD"]);
    expect(exec).toHaveBeenNthCalledWith(2, ["rev-parse", "--verify", "--end-of-options", "feature^{commit}"]);
    expect(exec).toHaveBeenNthCalledWith(3, ["status", "--porcelain", "--untracked-files=normal"]);
    expect(exec).toHaveBeenNthCalledWith(4, [
      "status",
      "--porcelain=v1",
      "-z",
      "--ignored=matching",
      "--untracked-files=normal"
    ]);
  });

  it("passes the requested head after --end-of-options", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    await assertLocalHeadMatchesCheckout({ cwd: "/repo", head: "--help", exec });
    expect(exec).toHaveBeenNthCalledWith(2, ["rev-parse", "--verify", "--end-of-options", "--help^{commit}"]);
  });

  it("rejects an explicit head that differs from the checkout", async () => {
    const exec = vi.fn().mockResolvedValueOnce("abc123\n").mockResolvedValueOnce("def456\n");
    await expect(assertLocalHeadMatchesCheckout({ cwd: "/repo", head: "feature", exec })).rejects.toThrow(
      /does not match the checked-out HEAD/
    );
    expect(exec).not.toHaveBeenCalledWith(["status", "--porcelain", "--untracked-files=normal"]);
  });

  it("rejects an explicit head when the worktree is dirty", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce(" M src/a.ts\n?? tmp.txt\n");
    await expect(assertLocalHeadMatchesCheckout({ cwd: "/repo", head: "feature", exec })).rejects.toThrow(
      /requires a clean worktree/
    );
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("rejects untracked review-readable files for an explicit head", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("?? REVIEW_GUIDELINES.md\n");
    await expect(assertLocalHeadMatchesCheckout({ cwd: "/repo", head: "feature", exec })).rejects.toThrow(
      /requires a clean worktree/
    );
    expect(exec).toHaveBeenNthCalledWith(3, ["status", "--porcelain", "--untracked-files=normal"]);
  });

  it("rejects ignored review-readable files for an explicit head", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("!! src/generated/schema.ts\0");
    await expect(assertLocalHeadMatchesCheckout({ cwd: "/repo", head: "feature", exec })).rejects.toThrow(
      /ignored local files/
    );
  });

  it("allows ignored files under directories skipped by context tools", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("!! node_modules/\0!! dist/app.js\0");
    await expect(assertLocalHeadMatchesCheckout({ cwd: "/repo", head: "feature", exec })).resolves.toBeUndefined();
  });

  it("allows ignored prowl local output for an explicit head", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("abc123\n")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("!! .prowl-review/\0!! .prowl-review/debug.jsonl\0");
    await expect(assertLocalHeadMatchesCheckout({ cwd: "/repo", head: "feature", exec })).resolves.toBeUndefined();
  });
});

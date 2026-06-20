import { describe, expect, it, vi } from "vitest";
import { resolveLocalDiff, LocalDiffError } from "../src/review/local-diff.js";

describe("resolveLocalDiff", () => {
  it("diffs base against head using --merge-base when head is given", async () => {
    const exec = vi.fn().mockResolvedValue("DIFF");
    const diff = await resolveLocalDiff({ base: "main", head: "feature", cwd: "/repo", exec });
    expect(diff).toBe("DIFF");
    expect(exec).toHaveBeenCalledWith(["diff", "--merge-base", "main", "feature"]);
  });

  it("diffs base against the working tree when head is omitted", async () => {
    const exec = vi.fn().mockResolvedValue("WT");
    await resolveLocalDiff({ base: "main", cwd: "/repo", exec });
    expect(exec).toHaveBeenCalledWith(["diff", "--merge-base", "main"]);
  });

  it("trims surrounding whitespace from the refs", async () => {
    const exec = vi.fn().mockResolvedValue("");
    await resolveLocalDiff({ base: "  develop  ", head: "  topic  ", cwd: "/repo", exec });
    expect(exec).toHaveBeenCalledWith(["diff", "--merge-base", "develop", "topic"]);
  });

  it("treats a blank head as the working tree", async () => {
    const exec = vi.fn().mockResolvedValue("");
    await resolveLocalDiff({ base: "main", head: "   ", cwd: "/repo", exec });
    expect(exec).toHaveBeenCalledWith(["diff", "--merge-base", "main"]);
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

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasSymlinkComponent,
  isWorkspaceConfinedPath,
  prepareDebugLogPathForWrite
} from "../src/debug/paths.js";

describe("debug path helpers", () => {
  it("confines relative and absolute paths to the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "prowl-debug-paths-"));

    expect(isWorkspaceConfinedPath("trace.jsonl", workspace)).toBe(true);
    expect(isWorkspaceConfinedPath(join(workspace, "trace.jsonl"), workspace)).toBe(true);
    expect(isWorkspaceConfinedPath("../trace.jsonl", workspace)).toBe(false);
    expect(isWorkspaceConfinedPath(join(tmpdir(), "trace.jsonl"), workspace)).toBe(false);
  });

  it("detects symlinked directory and final-file components", () => {
    const workspace = mkdtempSync(join(tmpdir(), "prowl-debug-paths-"));
    const outside = mkdtempSync(join(tmpdir(), "prowl-debug-outside-"));
    symlinkSync(outside, join(workspace, "traces"), "dir");
    writeFileSync(join(outside, "trace.jsonl"), "");
    symlinkSync(join(outside, "trace.jsonl"), join(workspace, "trace.jsonl"), "file");

    expect(hasSymlinkComponent("traces/run.jsonl", workspace, { allowMissingTail: true })).toBe(true);
    expect(hasSymlinkComponent("trace.jsonl", workspace, { allowMissingTail: true })).toBe(true);
  });

  it("handles missing tails according to the caller policy", () => {
    const workspace = mkdtempSync(join(tmpdir(), "prowl-debug-paths-"));

    expect(hasSymlinkComponent("missing/trace.jsonl", workspace, { allowMissingTail: true })).toBe(false);
    expect(hasSymlinkComponent("missing/trace.jsonl", workspace)).toBe(true);
  });

  it("creates nested parent directories and returns the resolved path", () => {
    const workspace = mkdtempSync(join(tmpdir(), "prowl-debug-paths-"));
    const resolvedPath = prepareDebugLogPathForWrite("traces/nested/run.jsonl", workspace);

    expect(resolvedPath).toBe(join(workspace, "traces", "nested", "run.jsonl"));
    expect(existsSync(join(workspace, "traces", "nested"))).toBe(true);
  });

  it("rejects paths that escape the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "prowl-debug-paths-"));

    expect(() => prepareDebugLogPathForWrite("../run.jsonl", workspace)).toThrow(/escapes the workspace/);
  });

  it("does not create nested parents through a symlinked component", () => {
    const workspace = mkdtempSync(join(tmpdir(), "prowl-debug-paths-"));
    const outside = mkdtempSync(join(tmpdir(), "prowl-debug-outside-"));
    symlinkSync(outside, join(workspace, "traces"), "dir");

    expect(() => prepareDebugLogPathForWrite("traces/nested/run.jsonl", workspace)).toThrow(/symlink/);
    expect(existsSync(join(outside, "nested"))).toBe(false);
  });

  it("rejects a symlinked final trace file", () => {
    const workspace = mkdtempSync(join(tmpdir(), "prowl-debug-paths-"));
    const outside = mkdtempSync(join(tmpdir(), "prowl-debug-outside-"));
    const outsideTrace = join(outside, "trace.jsonl");
    writeFileSync(outsideTrace, "outside");
    symlinkSync(outsideTrace, join(workspace, "trace.jsonl"), "file");

    expect(() => prepareDebugLogPathForWrite("trace.jsonl", workspace)).toThrow(/symlink/);
    expect(readFileSync(outsideTrace, "utf8")).toBe("outside");
  });
});

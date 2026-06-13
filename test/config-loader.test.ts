import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, findConfigPath, loadConfig } from "../src/config/loader.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prowl-config-"));
  tempDirs.push(dir);
  return dir;
}

describe("loadConfig (#29)", () => {
  it("returns an empty config when no file is found (defaults apply downstream)", () => {
    const dir = tempDir();
    const loaded = loadConfig({ cwd: dir });
    expect(loaded.config).toEqual({});
    expect(loaded.configPath).toBeNull();
  });

  it("returns an empty config when disabled (--no-config)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), "review:\n  minSeverity: major\n");
    const loaded = loadConfig({ cwd: dir, disabled: true });
    expect(loaded.config).toEqual({});
    expect(loaded.configPath).toBeNull();
  });

  it("loads and validates a config file", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      "provider: openai\nreview:\n  minSeverity: major\n  verify: false\n"
    );
    const loaded = loadConfig({ cwd: dir });
    expect(loaded.config).toEqual({ provider: "openai", review: { minSeverity: "major", verify: false } });
    expect(loaded.configPath).toBe(join(dir, CONFIG_FILENAME));
  });

  it("finds the config by searching upward from a nested directory", () => {
    const root = tempDir();
    writeFileSync(join(root, CONFIG_FILENAME), "review:\n  maxFindings: 5\n");
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findConfigPath(nested)).toBe(join(root, CONFIG_FILENAME));
    expect(loadConfig({ cwd: nested }).config).toEqual({ review: { maxFindings: 5 } });
  });

  it("accepts the .yaml extension too", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".prowl-review.yaml"), "provider: gemini\nmodel: gemini-x\n");
    expect(loadConfig({ cwd: dir }).config).toEqual({ provider: "gemini", model: "gemini-x" });
  });

  it("throws a readable error on a schema violation", () => {
    const dir = tempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), "review:\n  minSeverity: urgent\n");
    expect(() => loadConfig({ cwd: dir })).toThrow(/Invalid .*review\.minSeverity/s);
  });

  it("throws on a malformed YAML document", () => {
    const dir = tempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), "review: [unclosed\n");
    expect(() => loadConfig({ cwd: dir })).toThrow(/Could not parse/);
  });

  it("throws when an explicit config path does not exist", () => {
    const dir = tempDir();
    const missing = join(dir, CONFIG_FILENAME);
    expect(() => loadConfig({ configPath: missing })).toThrow(/not found/);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import fs, { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "yaml";
import { z } from "zod";
import { CONFIG_FILENAME, findConfigPath, loadConfig } from "../src/config/loader.js";

let tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

  it("opens config files without following symlinks", () => {
    const dir = tempDir();
    const configPath = join(dir, CONFIG_FILENAME);
    writeFileSync(configPath, "provider: openai\n");
    const openSpy = vi.spyOn(fs, "openSync");

    loadConfig({ cwd: dir });

    const openCall = openSpy.mock.calls.find(([target]) => target === configPath);
    expect(openCall).toBeDefined();
    const flags = openCall?.[1];
    expect(typeof flags).toBe("number");
    expect((flags as number) & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
  });

  it("finds the config by searching upward from a nested directory", () => {
    const root = tempDir();
    writeFileSync(join(root, CONFIG_FILENAME), "review:\n  maxFindings: 5\n");
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findConfigPath(nested)).toBe(join(root, CONFIG_FILENAME));
    expect(loadConfig({ cwd: nested }).config).toEqual({ review: { maxFindings: 5 } });
  });

  it("rejects a symlinked config discovered during search", () => {
    const root = tempDir();
    const outside = tempDir();
    const outsideConfig = join(outside, CONFIG_FILENAME);
    writeFileSync(outsideConfig, "provider: openai\n");
    symlinkSync(outsideConfig, join(root, CONFIG_FILENAME), "file");

    expect(() => findConfigPath(root)).toThrow(/symlink/);
    expect(() => loadConfig({ cwd: root })).toThrow(/symlink/);
  });

  it("surfaces unexpected directory read errors while searching", () => {
    const dir = tempDir();
    const readError = Object.assign(new Error("blocked"), { code: "EACCES" });
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw readError;
    });

    let thrown: unknown;
    try {
      findConfigPath(dir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(readError);
  });

  it("accepts the .yaml extension too", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".prowl-review.yaml"), "provider: gemini\nmodel: gemini-x\n");
    expect(loadConfig({ cwd: dir }).config).toEqual({ provider: "gemini", model: "gemini-x" });
  });

  it("throws a readable error on a schema violation", () => {
    const dir = tempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), "review:\n  minSeverity: urgent\n");

    let thrown: unknown;
    try {
      loadConfig({ cwd: dir });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const thrownError = thrown as Error;
    expect(thrownError.message).toMatch(/Invalid .*review\.minSeverity/s);
    expect(thrownError.cause).toBeInstanceOf(z.ZodError);
  });

  it("throws on a malformed YAML document", () => {
    const dir = tempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), "review: [unclosed\n");

    let thrown: unknown;
    try {
      loadConfig({ cwd: dir });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const thrownError = thrown as Error;
    expect(thrownError.message).toMatch(/Could not parse/);
    expect(thrownError.cause).toBeInstanceOf(Error);
  });

  it("normalizes non-Error YAML parse failures into an Error cause", () => {
    const dir = tempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), "review:\n  minSeverity: major\n");
    vi.spyOn(yaml, "parse").mockImplementationOnce(() => {
      throw "parser failed";
    });

    let thrown: unknown;
    try {
      loadConfig({ cwd: dir });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const thrownError = thrown as Error;
    expect(thrownError.message).toMatch(/parser failed/);
    expect(thrownError.cause).toBeInstanceOf(Error);
    expect((thrownError.cause as Error).message).toBe("parser failed");
  });

  it("throws when an explicit config path does not exist", () => {
    const dir = tempDir();
    const missing = join(dir, CONFIG_FILENAME);
    expect(() => loadConfig({ configPath: missing })).toThrow(/not found/);
  });

  it("rejects an explicit symlinked config path", () => {
    const root = tempDir();
    const outside = tempDir();
    const outsideConfig = join(outside, CONFIG_FILENAME);
    const symlinkedConfig = join(root, CONFIG_FILENAME);
    writeFileSync(outsideConfig, "provider: openai\n");
    symlinkSync(outsideConfig, symlinkedConfig, "file");

    expect(() => loadConfig({ configPath: symlinkedConfig })).toThrow(/symlink/);
  });
});

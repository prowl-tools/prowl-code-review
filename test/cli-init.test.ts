import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfigTemplate } from "../src/cli/commands/init.js";
import { CONFIG_FILENAME } from "../src/config/loader.js";
import { configSchema } from "../src/config/schema.js";
import { parse as parseYaml } from "yaml";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prowl-init-"));
  tempDirs.push(dir);
  return dir;
}

describe("prowl-review init (#29)", () => {
  it("writes a commented config template", () => {
    const dir = tempDir();
    const path = writeConfigTemplate(".", false, dir);
    expect(path).toBe(join(realpathSync(dir), CONFIG_FILENAME));
    const body = readFileSync(path, "utf8");
    expect(body).toContain(".prowl-review.yml");
    expect(body).toContain("PROWL_AI_KEY");
  });

  it("scaffolds a file that is valid once uncommented (defaults are all-optional)", () => {
    const dir = tempDir();
    const body = readFileSync(writeConfigTemplate(".", false, dir), "utf8");
    // Every line is commented, so the parsed document is empty and valid.
    expect(configSchema.parse(parseYaml(body) ?? {})).toEqual({});
  });

  it("refuses to overwrite an existing config without --force", () => {
    const dir = tempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), "provider: openai\n");
    expect(() => writeConfigTemplate(".", false, dir)).toThrow(/already exists/);
  });

  it("overwrites with --force", () => {
    const dir = tempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), "provider: openai\n");
    const path = writeConfigTemplate(".", true, dir);
    expect(readFileSync(path, "utf8")).toContain("BYOK AI code review");
  });

  it("refuses to write outside the workspace", () => {
    const dir = tempDir();
    const sibling = `${dir}-sibling`;
    expect(() => writeConfigTemplate("../outside", false, dir)).toThrow(/outside the workspace/);
    expect(() => writeConfigTemplate(sibling, false, dir)).toThrow(/outside the workspace/);
    expect(() => writeConfigTemplate(tmpdir(), false, dir)).toThrow(/outside the workspace/);
  });

  it("refuses to write through a symlinked directory", () => {
    const dir = tempDir();
    const outside = tempDir();
    try {
      symlinkSync(outside, join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    expect(() => writeConfigTemplate("linked", false, dir)).toThrow(/symlinked path/);
  });

  it("refuses to overwrite a symlinked config target with --force", () => {
    const dir = tempDir();
    const outside = tempDir();
    const outsideConfig = join(outside, CONFIG_FILENAME);
    writeFileSync(outsideConfig, "provider: openai\n");
    try {
      symlinkSync(outsideConfig, join(dir, CONFIG_FILENAME), "file");
    } catch {
      return;
    }

    expect(() => writeConfigTemplate(".", true, dir)).toThrow(/symlinked config target/);
    expect(readFileSync(outsideConfig, "utf8")).toBe("provider: openai\n");
  });
});

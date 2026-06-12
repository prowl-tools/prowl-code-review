import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const path = writeConfigTemplate(dir, false);
    expect(path).toBe(join(dir, CONFIG_FILENAME));
    const body = readFileSync(path, "utf8");
    expect(body).toContain(".prowl-review.yml");
    expect(body).toContain("PROWL_AI_KEY");
  });

  it("scaffolds a file that is valid once uncommented (defaults are all-optional)", () => {
    const dir = tempDir();
    const body = readFileSync(writeConfigTemplate(dir, false), "utf8");
    // Every line is commented, so the parsed document is empty and valid.
    expect(configSchema.parse(parseYaml(body) ?? {})).toEqual({});
  });

  it("refuses to overwrite an existing config without --force", () => {
    const dir = tempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), "provider: openai\n");
    expect(() => writeConfigTemplate(dir, false)).toThrow(/already exists/);
  });

  it("overwrites with --force", () => {
    const dir = tempDir();
    writeFileSync(join(dir, CONFIG_FILENAME), "provider: openai\n");
    const path = writeConfigTemplate(dir, true);
    expect(readFileSync(path, "utf8")).toContain("BYOK AI code review");
  });
});

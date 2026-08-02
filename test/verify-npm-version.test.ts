import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  parseVersion,
  satisfiesMinimumVersion,
} from "../scripts/verify-npm-version.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/verify-npm-version.mjs", import.meta.url));

describe("verify npm version script (#63)", () => {
  it("parses stable npm semantic versions", () => {
    expect(parseVersion("11.5.1")).toEqual({ major: 11, minor: 5, patch: 1 });
    expect(parseVersion(" 12.0.0\n")).toEqual({ major: 12, minor: 0, patch: 0 });
  });

  it("compares major, minor, and patch components numerically", () => {
    expect(compareVersions("11.5.1", "11.5.1")).toBe(0);
    expect(compareVersions("11.5.2", "11.5.1")).toBe(1);
    expect(compareVersions("11.6.0", "11.5.9")).toBe(1);
    expect(compareVersions("12.0.0", "11.99.99")).toBe(1);
    expect(compareVersions("11.5.0", "11.5.1")).toBe(-1);
    expect(compareVersions("10.9.9", "11.5.1")).toBe(-1);
  });

  it("accepts versions at or above the minimum", () => {
    expect(satisfiesMinimumVersion("11.5.1", "11.5.1")).toBe(true);
    expect(satisfiesMinimumVersion("11.5.2", "11.5.1")).toBe(true);
    expect(satisfiesMinimumVersion("12.0.0", "11.5.1")).toBe(true);
  });

  it("rejects versions below the minimum", () => {
    expect(satisfiesMinimumVersion("11.5.0", "11.5.1")).toBe(false);
    expect(satisfiesMinimumVersion("11.4.9", "11.5.1")).toBe(false);
    expect(satisfiesMinimumVersion("10.9.4", "11.5.1")).toBe(false);
  });

  it("rejects malformed, incomplete, and prerelease versions", () => {
    for (const version of [
      "",
      "11",
      "11.5",
      "11.5.x",
      "11.5.1-rc.1",
      "01.5.1",
      "1.05.1",
      "1.5.01",
      "npm 11.5.1",
    ]) {
      expect(() => parseVersion(version)).toThrow("unable to parse npm version");
    }
  });

  it("exits successfully when the CLI version satisfies the minimum", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "11.5.2", "11.5.1"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("exits non-zero when the CLI version is below the minimum", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "11.5.0", "11.5.1"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("need >=11.5.1");
  });

  it("suppresses error output in quiet mode", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, "--quiet", "11.5.0", "11.5.1"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
  });

  it("prints usage when CLI arguments are missing", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: verify-npm-version.mjs");
  });
});

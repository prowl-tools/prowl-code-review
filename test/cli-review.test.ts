import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGuidelines,
  parseMinSeverity,
  resolveGuidelinesWorkspace,
  resolvePullNumber,
  resolveRepo,
  resolveTrustWorkspace,
  resolveWorkspace
} from "../src/cli/commands/review.js";

const ORIGINAL_ENV = process.env;
let tempDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prowl-review-"));
  tempDirs.push(dir);
  return dir;
}

describe("review command helpers", () => {
  it("resolves repository from flag or environment", () => {
    expect(resolveRepo("owner/repo")).toEqual({ owner: "owner", repo: "repo" });

    process.env.GITHUB_REPOSITORY = "env-owner/env-repo";
    expect(resolveRepo()).toEqual({ owner: "env-owner", repo: "env-repo" });
  });

  it("rejects malformed repositories", () => {
    for (const value of ["owner", "owner/", "/repo", "owner/repo/extra"]) {
      expect(() => resolveRepo(value)).toThrow(/Repository required/);
    }
  });

  it("resolves pull numbers from flags and event payloads", () => {
    expect(resolvePullNumber("42")).toBe(42);

    const dir = tempDir();
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }));
    process.env.GITHUB_EVENT_PATH = eventPath;
    expect(resolvePullNumber()).toBe(7);

    writeFileSync(eventPath, JSON.stringify({ number: 8 }));
    expect(resolvePullNumber()).toBe(8);
  });

  it("rejects invalid pull numbers and invalid event payloads", () => {
    expect(() => resolvePullNumber("0")).toThrow(/Invalid --pr/);
    expect(() => resolvePullNumber("not-a-number")).toThrow(/Invalid --pr/);

    const dir = tempDir();
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, "{not-json");
    process.env.GITHUB_EVENT_PATH = eventPath;
    expect(() => resolvePullNumber()).toThrow(/Pull request number required/);
  });

  it("loads guidelines in precedence order and skips unreadable entries", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "CLAUDE.md"), "claude rules");
    expect(loadGuidelines(dir)).toBe("claude rules");

    writeFileSync(join(dir, "REVIEW_GUIDELINES.md"), "review rules");
    expect(loadGuidelines(dir)).toBe("review rules");

    const fallbackDir = tempDir();
    mkdirSync(join(fallbackDir, "REVIEW_GUIDELINES.md"));
    writeFileSync(join(fallbackDir, "CLAUDE.md"), "fallback rules");
    expect(loadGuidelines(fallbackDir)).toBe("fallback rules");
  });

  it("parses and validates min severity", () => {
    expect(parseMinSeverity(undefined)).toBeUndefined();
    expect(parseMinSeverity("major")).toBe("major");
    expect(() => parseMinSeverity("urgent")).toThrow(/Invalid --min-severity/);
  });

  it("prefers the explicit action workspace over the GitHub default", () => {
    process.env.GITHUB_WORKSPACE = "/base";
    process.env.PROWL_WORKSPACE = "/head";
    expect(resolveWorkspace()).toBe("/head");

    process.env.PROWL_WORKSPACE = "";
    expect(resolveWorkspace()).toBe("/base");
  });

  it("keeps trusted guidelines explicit and separate from the context workspace", () => {
    process.env.GITHUB_WORKSPACE = "/base";
    process.env.PROWL_WORKSPACE = "/head";
    process.env.PROWL_GUIDELINES_WORKSPACE = "/trusted-guidelines";
    expect(resolveGuidelinesWorkspace()).toBe("/trusted-guidelines");

    process.env.PROWL_GUIDELINES_WORKSPACE = "";
    expect(resolveGuidelinesWorkspace()).toBeUndefined();

    process.env.PROWL_GUIDELINES_WORKSPACE = "   ";
    expect(resolveGuidelinesWorkspace()).toBeUndefined();
  });

  it("resolves workspace execution trust from explicit truthy env values", () => {
    delete process.env.PROWL_TRUST_WORKSPACE;
    expect(resolveTrustWorkspace()).toBe(false);

    process.env.PROWL_TRUST_WORKSPACE = "true";
    expect(resolveTrustWorkspace()).toBe(true);

    process.env.PROWL_TRUST_WORKSPACE = "1";
    expect(resolveTrustWorkspace()).toBe(true);

    process.env.PROWL_TRUST_WORKSPACE = "yes";
    expect(resolveTrustWorkspace()).toBe(true);

    process.env.PROWL_TRUST_WORKSPACE = "TRUE";
    expect(resolveTrustWorkspace()).toBe(true);

    process.env.PROWL_TRUST_WORKSPACE = "Yes";
    expect(resolveTrustWorkspace()).toBe(true);

    process.env.PROWL_TRUST_WORKSPACE = " true ";
    expect(resolveTrustWorkspace()).toBe(true);

    process.env.PROWL_TRUST_WORKSPACE = "false";
    expect(resolveTrustWorkspace()).toBe(false);
  });

  it("resolves workspace execution trust to false for other env values", () => {
    for (const value of ["0", "no", "falsey", "", "y", "t", "on"]) {
      process.env.PROWL_TRUST_WORKSPACE = value;
      expect(resolveTrustWorkspace()).toBe(false);
    }
  });
});

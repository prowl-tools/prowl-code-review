import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractChangelogSection } from "../scripts/changelog-section.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/changelog-section.mjs", import.meta.url));

const CHANGELOG = `# Changelog

## [Unreleased]

### Added
- Work in progress.

## [1.2.0] - 2026-06-25

### Added
- Shiny new feature.

### Fixed
- A nasty bug.

## [1.1.0] - 2026-06-01

### Added
- Older feature.
`;

describe("extractChangelogSection (#42)", () => {
  it("extracts a versioned section up to the next heading", () => {
    const notes = extractChangelogSection(CHANGELOG, "1.2.0");
    expect(notes).toContain("Shiny new feature.");
    expect(notes).toContain("A nasty bug.");
    // Does not bleed into the previous release.
    expect(notes).not.toContain("Older feature.");
    expect(notes).not.toContain("Work in progress.");
  });

  it("tolerates a leading v in the version", () => {
    expect(extractChangelogSection(CHANGELOG, "v1.2.0")).toContain("Shiny new feature.");
  });

  it("trims whitespace around the requested version", () => {
    expect(extractChangelogSection(CHANGELOG, "  v1.2.0  ")).toContain("Shiny new feature.");
  });

  it("matches exact version headings instead of prerelease prefixes", () => {
    const changelog = `# Changelog

## [1.2.0-rc.1] - 2026-06-20

- Release candidate notes.

## [1.2.0] - 2026-06-25

- Stable release notes.
`;
    const notes = extractChangelogSection(changelog, "1.2.0");
    expect(notes).toContain("Stable release notes.");
    expect(notes).not.toContain("Release candidate notes.");
  });

  it("handles CRLF line endings", () => {
    const notes = extractChangelogSection(CHANGELOG.replace(/\n/g, "\r\n"), "1.2.0");
    expect(notes).toContain("Shiny new feature.");
    expect(notes).not.toContain("Older feature.");
  });

  it("falls back to the Unreleased section when no versioned heading exists", () => {
    const notes = extractChangelogSection(CHANGELOG, "9.9.9");
    expect(notes).toContain("Work in progress.");
    expect(notes).not.toContain("Shiny new feature.");
  });

  it("falls back to Unreleased for malformed version headings", () => {
    const changelog = `# Changelog

## [Unreleased]

- Work in progress.

##[1.2.0]

- Malformed heading.
`;
    const notes = extractChangelogSection(changelog, "1.2.0");
    expect(notes).toContain("Work in progress.");
    expect(notes).not.toContain("Malformed heading.");
  });

  it("uses the first matching version section when duplicate headings exist", () => {
    const changelog = `# Changelog

## [1.2.0] - 2026-06-25

- First section.

## [1.2.0] - 2026-06-26

- Duplicate section.
`;
    const notes = extractChangelogSection(changelog, "1.2.0");
    expect(notes).toContain("First section.");
    expect(notes).not.toContain("Duplicate section.");
  });

  it("returns a generic line when nothing usable is found", () => {
    expect(extractChangelogSection("# Changelog\n", "1.0.0")).toBe("Release 1.0.0.");
  });

  it("handles empty version input without matching every heading", () => {
    expect(extractChangelogSection("# Changelog\n", "   ")).toBe("Release.");
  });

  it("does not treat a deeper (###) heading as a section boundary", () => {
    const notes = extractChangelogSection(CHANGELOG, "1.2.0");
    expect(notes).toContain("### Added");
    expect(notes).toContain("### Fixed");
  });

  it("prints release notes when invoked as a CLI with a changelog path", () => {
    const dir = mkdtempSync(join(tmpdir(), "prowl-changelog-"));
    try {
      const changelogPath = join(dir, "CHANGELOG.md");
      writeFileSync(changelogPath, CHANGELOG, "utf8");
      const output = execFileSync(process.execPath, [SCRIPT_PATH, "1.2.0", changelogPath], {
        encoding: "utf8",
      });
      expect(output).toContain("Shiny new feature.");
      expect(output).not.toContain("Older feature.");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("returns usage and exits non-zero when the CLI version argument is missing", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: changelog-section.mjs <version> [changelog-path]");
  });

  it("prints a generic CLI release line when the changelog file is missing", () => {
    const output = execFileSync(process.execPath, [SCRIPT_PATH, "1.0.0", "does-not-exist.md"], {
      encoding: "utf8",
    });
    expect(output).toBe("Release 1.0.0.\n");
  });

  it("prints a generic CLI release line when the changelog file is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "prowl-changelog-"));
    try {
      const changelogPath = join(dir, "CHANGELOG.md");
      writeFileSync(changelogPath, "", "utf8");
      const output = execFileSync(process.execPath, [SCRIPT_PATH, "1.0.0", changelogPath], {
        encoding: "utf8",
      });
      expect(output).toBe("Release 1.0.0.\n");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

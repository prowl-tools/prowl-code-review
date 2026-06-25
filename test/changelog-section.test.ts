import { describe, expect, it } from "vitest";
import { extractChangelogSection } from "../scripts/changelog-section.mjs";

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

  it("falls back to the Unreleased section when no versioned heading exists", () => {
    const notes = extractChangelogSection(CHANGELOG, "9.9.9");
    expect(notes).toContain("Work in progress.");
    expect(notes).not.toContain("Shiny new feature.");
  });

  it("returns a generic line when nothing usable is found", () => {
    expect(extractChangelogSection("# Changelog\n", "1.0.0")).toBe("Release 1.0.0.");
  });

  it("does not treat a deeper (###) heading as a section boundary", () => {
    const notes = extractChangelogSection(CHANGELOG, "1.2.0");
    expect(notes).toContain("### Added");
    expect(notes).toContain("### Fixed");
  });
});

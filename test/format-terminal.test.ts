import { describe, expect, it } from "vitest";
import {
  formatLocalReport,
  formatLocalReportJson,
  formatSummaryLine,
  severityBreakdown,
  findingLocation
} from "../src/review/format-terminal.js";
import type { Finding } from "../src/review/findings.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: "src/a.ts",
    line: 42,
    severity: "major",
    category: "correctness",
    title: "Off-by-one in loop bound",
    body: "The loop runs one iteration too many.",
    confidence: 0.8,
    ...over
  };
}

describe("findingLocation", () => {
  it("renders file:line, or just the file when the line is unknown", () => {
    expect(findingLocation(finding({ line: 42 }))).toBe("src/a.ts:42");
    expect(findingLocation(finding({ line: undefined }))).toBe("src/a.ts");
  });
});

describe("severityBreakdown / formatSummaryLine", () => {
  it("counts findings per severity", () => {
    const counts = severityBreakdown([finding(), finding({ severity: "critical" }), finding({ severity: "critical" })]);
    expect(counts).toEqual({ critical: 2, major: 1, minor: 0, trivial: 0, info: 0 });
  });

  it("summarizes counts most-severe first, with singular/plural", () => {
    expect(formatSummaryLine([])).toBe("No findings.");
    expect(formatSummaryLine([finding()])).toBe("1 finding: 1 major");
    expect(formatSummaryLine([finding({ severity: "minor" }), finding({ severity: "critical" })])).toBe(
      "2 findings: 1 critical, 1 minor"
    );
  });
});

describe("formatLocalReport", () => {
  it("renders severity badge, location, title, body, and suggestion", () => {
    const report = formatLocalReport([finding({ suggestion: "for (i = 0; i < n; i++)" })], []);
    expect(report).toContain("[MAJOR]");
    expect(report).toContain("src/a.ts:42");
    expect(report).toContain("Off-by-one in loop bound");
    expect(report).toContain("The loop runs one iteration too many.");
    expect(report).toContain("suggestion:");
    expect(report).toContain("for (i = 0; i < n; i++)");
  });

  it("sorts findings by severity (most severe first)", () => {
    const report = formatLocalReport(
      [finding({ severity: "minor", title: "low" }), finding({ severity: "critical", title: "high" })],
      []
    );
    expect(report.indexOf("high")).toBeLessThan(report.indexOf("low"));
  });

  it("shows a clean summary and no finding blocks when there are none", () => {
    const report = formatLocalReport([], []);
    expect(report).toContain("No findings.");
    expect(report).not.toContain("[");
  });

  it("surfaces operational notes under a Notes heading", () => {
    const report = formatLocalReport([], ["Skipped files — binary (not reviewable): logo.png"]);
    expect(report).toContain("Notes:");
    expect(report).toContain("- Skipped files — binary (not reviewable): logo.png");
  });

  it("omits ANSI escapes by default and includes them with color enabled", () => {
    const plain = formatLocalReport([finding()], []);
    const colored = formatLocalReport([finding()], [], { color: true });
    const esc = String.fromCharCode(27);
    expect(plain).not.toContain(esc);
    expect(colored).toContain(esc);
  });
});

describe("formatLocalReportJson", () => {
  it("emits a machine-readable summary + findings + notes", () => {
    const json = JSON.parse(formatLocalReportJson([finding({ severity: "critical" })], ["  a note  ", "  "]));
    expect(json.summary.total).toBe(1);
    expect(json.summary.bySeverity.critical).toBe(1);
    expect(json.findings).toHaveLength(1);
    expect(json.findings[0].title).toBe("Off-by-one in loop bound");
    // Notes are trimmed and blanks dropped.
    expect(json.notes).toEqual(["a note"]);
  });
});

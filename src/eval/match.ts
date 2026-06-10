import type { Finding } from "../review/findings.js";
import {
  DEFAULT_LINE_WINDOW,
  type CaseKind,
  type CaseResult,
  type ExpectedBug,
  type MatchOptions
} from "./types.js";

/**
 * Deterministic finding ↔ expected-bug matching (backlog #13).
 *
 * A finding matches an expected bug when it is on the same file and its line
 * range overlaps the bug's range expanded by ±`lineWindow`, optionally also
 * sharing the bug's category. Findings without a line never match (the harness
 * rewards precise localisation). Pure and fully testable — no LLM, no IO.
 */

/** Normalise a path for comparison (POSIX separators, no leading `./`). */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Inclusive line range a finding spans on the new side (null when unlocated). */
function findingRange(finding: Finding): { start: number; end: number } | null {
  if (finding.line === undefined) {
    return null;
  }
  const start = finding.line;
  const end = finding.endLine !== undefined && finding.endLine >= start ? finding.endLine : start;
  return { start, end };
}

/** True when a finding lands on an expected bug under the given options. */
export function matchesBug(finding: Finding, bug: ExpectedBug, options: MatchOptions = {}): boolean {
  if (normalizePath(finding.file) !== normalizePath(bug.file)) {
    return false;
  }
  const range = findingRange(finding);
  if (!range) {
    return false; // unlocated findings can't be credited to a specific defect
  }
  if (options.requireCategory && bug.category) {
    if (finding.category.toLowerCase() !== bug.category.toLowerCase()) {
      return false;
    }
  }
  const window = options.lineWindow ?? DEFAULT_LINE_WINDOW;
  const bugLast = bug.endLine !== undefined && bug.endLine >= bug.line ? bug.endLine : bug.line;
  const bugStart = bug.line - window;
  const bugEnd = bugLast + window;
  // Overlap test between [range.start, range.end] and [bugStart, bugEnd].
  return range.start <= bugEnd && range.end >= bugStart;
}

/**
 * Score one case's findings against its expected bugs.
 *
 * Recall is bug-level (each defect covered by ≥1 finding); precision is
 * finding-level (each finding hitting ≥1 defect). For `clean` cases there are
 * no expected bugs, so every finding is a false positive.
 */
export function scoreCase(
  id: string,
  kind: CaseKind,
  findings: Finding[],
  expected: ExpectedBug[],
  options: MatchOptions = {}
): CaseResult {
  const coveredBugs = expected.filter((bug) =>
    findings.some((finding) => matchesBug(finding, bug, options))
  ).length;
  const matchedFindings = findings.filter((finding) =>
    expected.some((bug) => matchesBug(finding, bug, options))
  ).length;

  return {
    id,
    kind,
    expectedBugs: expected.length,
    coveredBugs,
    falseNegatives: expected.length - coveredBugs,
    findings: findings.length,
    matchedFindings,
    falsePositives: findings.length - matchedFindings,
    errored: false
  };
}

/** Build the error-case result for a review pass that failed (excluded from metrics). */
export function erroredCase(id: string, kind: CaseKind, error: string): CaseResult {
  return {
    id,
    kind,
    expectedBugs: 0,
    coveredBugs: 0,
    falseNegatives: 0,
    findings: 0,
    matchedFindings: 0,
    falsePositives: 0,
    errored: true,
    error
  };
}

import { SEVERITY_ORDER, type Finding, type Severity } from "./findings.js";

/**
 * Terminal rendering for local review output (backlog #35).
 *
 * Pure formatters: turn the review's findings plus operational notes into a
 * human-readable report (severity, file:line, title, body, committable
 * suggestion) or a machine-readable JSON document for `--json`. No I/O — the
 * caller prints the returned string — so both shapes are unit-testable.
 */

/** Raw ANSI escape (0x1b); built at runtime so the source stays ASCII-clean. */
const ESC = String.fromCharCode(27);

/** ANSI color codes per severity, used only when color output is enabled. */
const SEVERITY_COLOR: Record<Severity, string> = {
  critical: `${ESC}[1;31m`, // bold red
  major: `${ESC}[31m`, // red
  minor: `${ESC}[33m`, // yellow
  trivial: `${ESC}[36m`, // cyan
  info: `${ESC}[90m` // grey
};
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;

export interface TerminalFormatOptions {
  /** Emit ANSI color codes. Default false (caller decides from TTY detection). */
  color?: boolean;
}

/** Wrap text in an ANSI code when color is enabled, otherwise return it as-is. */
function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${RESET}` : text;
}

/** A finding's `file:line` location, omitting the line when unknown. */
export function findingLocation(finding: Finding): string {
  return finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
}

/** Indent every line of a block by `spaces`. */
function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${pad}${line}` : line))
    .join("\n");
}

/** Count findings per severity for the summary header. */
export function severityBreakdown(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0, trivial: 0, info: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

/** One-line summary, e.g. "3 findings: 1 critical, 2 major". */
export function formatSummaryLine(findings: Finding[]): string {
  if (findings.length === 0) {
    return "No findings.";
  }
  const counts = severityBreakdown(findings);
  const parts = (Object.keys(SEVERITY_ORDER) as Severity[])
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}`);
  const noun = findings.length === 1 ? "finding" : "findings";
  return `${findings.length} ${noun}: ${parts.join(", ")}`;
}

/** Render a single finding as an indented terminal block. */
function formatFinding(finding: Finding, color: boolean): string {
  const badge = paint(`[${finding.severity.toUpperCase()}]`, SEVERITY_COLOR[finding.severity], color);
  const location = paint(findingLocation(finding), BOLD, color);
  const category = paint(finding.category, DIM, color);
  const lines = [`${badge} ${location} ${category}`, indent(finding.title, 2)];
  if (finding.body.trim()) {
    lines.push(indent(finding.body.trim(), 4));
  }
  if (finding.suggestion?.trim()) {
    lines.push(indent(paint("suggestion:", DIM, color), 4));
    lines.push(indent(finding.suggestion.trimEnd(), 6));
  }
  return lines.join("\n");
}

/**
 * Render the full local-review report: a header summary, each finding sorted by
 * severity, and any operational notes (skips, degraded stages) — surfaced, never
 * silently dropped (core principle #5).
 */
export function formatLocalReport(
  findings: Finding[],
  notes: string[],
  options: TerminalFormatOptions = {}
): string {
  const color = options.color === true;
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const blocks: string[] = [paint(`prowl-review (local) — ${formatSummaryLine(findings)}`, BOLD, color)];

  if (sorted.length > 0) {
    blocks.push(sorted.map((finding) => formatFinding(finding, color)).join("\n\n"));
  }

  const cleanNotes = notes.map((note) => note.trim()).filter(Boolean);
  if (cleanNotes.length > 0) {
    const heading = paint("Notes:", DIM, color);
    blocks.push([heading, ...cleanNotes.map((note) => `  - ${note}`)].join("\n"));
  }

  return blocks.join("\n\n");
}

/** Render the report as a JSON document for `--json` (machine-readable). */
export function formatLocalReportJson(findings: Finding[], notes: string[]): string {
  return JSON.stringify(
    {
      summary: {
        total: findings.length,
        bySeverity: severityBreakdown(findings)
      },
      findings,
      notes: notes.map((note) => note.trim()).filter(Boolean)
    },
    null,
    2
  );
}

import type { DiffFile } from "./diff-types.js";
import type { Finding, Severity } from "./findings.js";
import { SEVERITIES, SEVERITY_ORDER } from "./findings.js";
import type { SkipReason, SkippedFile } from "./diff-types.js";

/**
 * Structured walkthrough summary (backlog #9) — a pure markdown formatter that
 * turns the ranked findings + parsed diff into the review's summary body. No
 * GitHub calls; #10 publishes the returned string. Findings detail is carried
 * by inline comments (#10); this summary highlights blockers + counts.
 */

/**
 * Hidden marker so a re-run can find and update its prior summary instead of
 * stacking duplicates (used by #22). Keep this string stable.
 */
export const REVIEW_MARKER = "<!-- prowl-review:summary -->";

export type Impact = "high" | "medium" | "low";

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🟡",
  trivial: "🔵",
  info: "⚪"
};

const IMPACT_BADGE: Record<Impact, string> = {
  high: "🔴 High",
  medium: "🟠 Medium",
  low: "🟢 Low"
};

export interface WalkthroughInput {
  /** Consolidated, ranked findings from the judge (#6). */
  findings: Finding[];
  /** Files included in the review (from `parseDiff` / `applyDiffLimits`). */
  files: DiffFile[];
  /** Optional plain-language summary (LLM- or caller-provided). */
  summary?: string;
  /** Files skipped by size guards — reported, never dropped silently. */
  skipped?: SkippedFile[];
  /** Optional Mermaid diagram body; rendered only when provided. */
  mermaid?: string;
  /** Override the derived impact. */
  impact?: Impact;
  /** Override the derived effort (1–5). */
  effort?: number;
}

const SKIP_LABELS: Record<SkipReason, string> = {
  binary: "binary (not reviewable)",
  maxFiles: "skipped - file limit reached",
  maxDiffBytes: "skipped - diff size limit reached"
};

const MARKDOWN_TEXT_ESCAPES = new Set("\\`*_{}[]()#+-.!|>".split(""));

/** Replace control characters so untrusted paths cannot change Markdown structure. */
function normalizeMarkdownText(value: string): string {
  let normalized = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      if (char === "\n") {
        normalized += "\\n";
      } else if (char === "\r") {
        normalized += "\\r";
      } else if (char === "\t") {
        normalized += "\\t";
      } else {
        normalized += `\\x${code.toString(16).padStart(2, "0")}`;
      }
    } else {
      normalized += char;
    }
  }
  return normalized;
}

/** Escape Markdown metacharacters for plain text contexts such as headings. */
function escapeMarkdownText(value: string): string {
  let escaped = "";
  for (const char of normalizeMarkdownText(value)) {
    escaped += MARKDOWN_TEXT_ESCAPES.has(char) ? `\\${char}` : char;
  }
  return escaped;
}

/** Render untrusted text as an inline code span, even when it contains backticks. */
function inlineCode(value: string): string {
  const normalized = normalizeMarkdownText(value);
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(normalized.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(longestBacktickRun + 1);
  const padding = normalized.startsWith("`") || normalized.endsWith("`") ? " " : "";
  return `${fence}${padding}${normalized}${padding}${fence}`;
}

/** Count added and deleted text lines for one parsed diff file. */
function lineDelta(file: DiffFile): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") {
        additions += 1;
      } else if (line.type === "del") {
        deletions += 1;
      }
    }
  }
  return { additions, deletions };
}

/** Count all changed text lines across parsed diff files. */
function totalChangedLines(files: DiffFile[]): number {
  return files.reduce((sum, file) => {
    const { additions, deletions } = lineDelta(file);
    return sum + additions + deletions;
  }, 0);
}

/** Count findings per severity (zeros included). */
export function severityCounts(findings: Finding[]): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

/** Derive PR impact from the worst finding severity and change size. */
export function deriveImpact(findings: Finding[], files: DiffFile[]): Impact {
  if (findings.some((f) => f.severity === "critical")) {
    return "high";
  }
  if (findings.some((f) => f.severity === "major") || totalChangedLines(files) > 400) {
    return "medium";
  }
  return "low";
}

/** Derive a 1–5 estimated-effort score from change size and file count. */
export function deriveEffort(files: DiffFile[]): number {
  const lines = totalChangedLines(files);
  const count = files.length;
  let score = 1;
  if (lines > 20 || count > 2) score = 2;
  if (lines > 80 || count > 5) score = 3;
  if (lines > 250 || count > 15) score = 4;
  if (lines > 600 || count > 40) score = 5;
  return score;
}

/** Render a compact severity-count summary for the walkthrough header. */
function severityCountLine(counts: Record<Severity, number>): string {
  const parts = SEVERITIES.filter((s) => counts[s] > 0).map(
    (s) => `${SEVERITY_BADGE[s]} ${counts[s]}`
  );
  return parts.length > 0 ? parts.join(" · ") : "none";
}

/** Group files by top-level directory for scannable changed-file sections. */
function topDir(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "(root)" : path.slice(0, slash);
}

/** Render the grouped changed-file list with untrusted paths in safe code spans. */
function changedFilesSection(files: DiffFile[]): string {
  if (files.length === 0) {
    return "### Changed files\n_None._";
  }
  const groups = new Map<string, DiffFile[]>();
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const dir = topDir(file.path);
    const list = groups.get(dir) ?? [];
    list.push(file);
    groups.set(dir, list);
  }

  const lines: string[] = [`### Changed files (${files.length})`];
  for (const [dir, groupFiles] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = dir === "(root)" ? "(root)/" : escapeMarkdownText(`${dir}/`);
    lines.push(`**${label}**`);
    for (const file of groupFiles) {
      const { additions, deletions } = lineDelta(file);
      const delta = file.binary
        ? "binary"
        : [additions ? `+${additions}` : "", deletions ? `−${deletions}` : ""].filter(Boolean).join(" ") || "no line changes";
      lines.push(`- ${inlineCode(file.path)} — ${file.status} (${delta})`);
    }
  }
  return lines.join("\n");
}

/** Render skipped-file notes with untrusted paths in safe code spans. */
function skippedFilesNote(skipped: SkippedFile[]): string {
  if (skipped.length === 0) {
    return "";
  }

  const byReason = new Map<SkipReason, string[]>();
  for (const { path, reason } of skipped) {
    const list = byReason.get(reason) ?? [];
    list.push(inlineCode(path));
    byReason.set(reason, list);
  }

  const parts: string[] = [];
  for (const [reason, paths] of byReason) {
    parts.push(`${SKIP_LABELS[reason]}: ${paths.join(", ")}`);
  }
  return parts.join("; ");
}

/** Render a finding's file/line location with a safe path code span. */
function findingLocation(finding: Finding): string {
  return inlineCode(finding.line ? `${finding.file}:${finding.line}` : finding.file);
}

/** Render only blocking findings in the summary; inline comments carry details. */
function findingsSection(findings: Finding[]): string {
  const blockers = findings.filter(
    (f) => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER.major
  );
  if (blockers.length === 0) {
    return "### Findings\n_No blocking issues found._";
  }
  const lines = ["### Findings"];
  for (const finding of blockers) {
    lines.push(`- ${SEVERITY_BADGE[finding.severity]} **${finding.title}** — ${findingLocation(finding)}`);
  }
  return lines.join("\n");
}

/** Render the full walkthrough summary markdown for a review. */
export function buildWalkthrough(input: WalkthroughInput): string {
  const counts = severityCounts(input.findings);
  const impact = input.impact ?? deriveImpact(input.findings, input.files);
  const effort = input.effort ?? deriveEffort(input.files);

  const sections: string[] = [
    REVIEW_MARKER,
    "## 🦝 prowl-review",
    input.summary?.trim() || "_Automated review of the changes in this pull request._",
    `**Impact:** ${IMPACT_BADGE[impact]} · **Estimated effort:** ${effort}/5 · **Findings:** ${severityCountLine(counts)}`,
    changedFilesSection(input.files),
    findingsSection(input.findings)
  ];

  if (input.skipped && input.skipped.length > 0) {
    sections.push(`> ⚠️ **Not reviewed:** ${skippedFilesNote(input.skipped)}`);
  }

  if (input.mermaid?.trim()) {
    sections.push(["### Diagram", "```mermaid", input.mermaid.trim(), "```"].join("\n"));
  }

  return sections.join("\n\n");
}

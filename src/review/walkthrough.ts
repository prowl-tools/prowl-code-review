import type { DiffFile } from "./diff-types.js";
import type { Finding, Severity } from "./findings.js";
import { SEVERITIES, SEVERITY_ORDER } from "./findings.js";
import type { SkippedFile } from "./diff-types.js";
import { describeSkipped } from "./size-guards.js";

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

function severityCountLine(counts: Record<Severity, number>): string {
  const parts = SEVERITIES.filter((s) => counts[s] > 0).map(
    (s) => `${SEVERITY_BADGE[s]} ${counts[s]}`
  );
  return parts.length > 0 ? parts.join(" · ") : "none";
}

function topDir(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "(root)" : path.slice(0, slash);
}

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
    lines.push(`**${dir}/**`);
    for (const file of groupFiles) {
      const { additions, deletions } = lineDelta(file);
      const delta = file.binary
        ? "binary"
        : [additions ? `+${additions}` : "", deletions ? `−${deletions}` : ""].filter(Boolean).join(" ") || "no line changes";
      lines.push(`- \`${file.path}\` — ${file.status} (${delta})`);
    }
  }
  return lines.join("\n");
}

function findingsSection(findings: Finding[]): string {
  const blockers = findings.filter(
    (f) => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER.major
  );
  if (blockers.length === 0) {
    return "### Findings\n_No blocking issues found._";
  }
  const lines = ["### Findings"];
  for (const finding of blockers) {
    const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    lines.push(`- ${SEVERITY_BADGE[finding.severity]} **${finding.title}** — \`${where}\``);
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
    sections.push(`> ⚠️ **Not reviewed:** ${describeSkipped(input.skipped)}`);
  }

  if (input.mermaid?.trim()) {
    sections.push(["### Diagram", "```mermaid", input.mermaid.trim(), "```"].join("\n"));
  }

  return sections.join("\n\n");
}

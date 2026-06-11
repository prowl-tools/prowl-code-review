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

type LineDelta = { additions: number; deletions: number };

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
  /** Review coverage or retrieval notes that should not be hidden. */
  notes?: string[];
  /** Override the derived impact. */
  impact?: Impact;
  /** Override the derived effort (1–5). */
  effort?: number;
  /** Specialist-pass coverage, for the review-info line and degraded detection (#56). */
  coverage?: { passed: number; total: number };
  /**
   * True when the run could not fully review (a specialist pass failed,
   * verification failed, coverage truncated). Drives the "degraded" comment
   * state so a failed review is never disguised as a clean pass (#56).
   */
  degraded?: boolean;
}

const SKIP_LABELS: Record<SkipReason, string> = {
  binary: "binary (not reviewable)",
  maxFiles: "skipped - file limit reached",
  maxDiffBytes: "skipped - diff size limit reached",
  sensitive: "sensitive - kept out of the prompt"
};

const MARKDOWN_TEXT_ESCAPES = new Set("\\`*_{}[]()#+-.!|><@".split(""));
const MARKDOWN_PARAGRAPH_ESCAPES = new Set("\\`*_{}[]()#+!|><@".split(""));

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
    escaped += MARKDOWN_TEXT_ESCAPES.has(char) ? escapeMarkdownChar(char) : char;
  }
  return neutralizeMentions(escaped);
}

/** Escape angle brackets as entities so untrusted text cannot become raw HTML. */
function escapeMarkdownChar(char: string): string {
  if (char === "<") {
    return "&lt;";
  }
  if (char === ">") {
    return "&gt;";
  }
  return `\\${char}`;
}

/** Escape untrusted paragraph text without over-escaping normal punctuation. */
function escapeMarkdownParagraph(value: string): string {
  const normalized = normalizeMarkdownText(value);
  let escaped = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized.charAt(index);
    const shouldEscape =
      MARKDOWN_PARAGRAPH_ESCAPES.has(char) ||
      (index === 0 && char === "-") ||
      isOrderedListDot(normalized, index);
    escaped += shouldEscape ? escapeMarkdownChar(char) : char;
  }
  return neutralizeMentions(escaped);
}

/** Escape multiline paragraph content line-by-line, then flatten it to one Markdown line. */
function escapeMarkdownParagraphFlat(value: string): string {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => escapeMarkdownParagraph(line.trim()))
    .filter(Boolean)
    .join(" ");
}

/** Detect a leading ordered-list marker after trimming summary text. */
function isOrderedListDot(value: string, dotIndex: number): boolean {
  if (dotIndex === 0 || value.charAt(dotIndex) !== "." || value.charAt(dotIndex + 1) !== " ") {
    return false;
  }
  for (let index = 0; index < dotIndex; index += 1) {
    const char = value.charAt(index);
    if (char < "0" || char > "9") {
      return false;
    }
  }
  return true;
}

/** Render mention markers as entities so GitHub does not notify users or teams. */
function neutralizeMentions(value: string): string {
  return value.replaceAll("\\@", "&#64;").replaceAll("@", "&#64;");
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

/** Render fenced code with a fence longer than any backtick run in the body. */
function fencedCodeBlock(language: string, body: string): string {
  const trimmed = body.trim();
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(trimmed.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [`${fence}${language}`, trimmed, fence].join("\n");
}

/** Count added and deleted text lines for one parsed diff file. */
function lineDelta(file: DiffFile): LineDelta {
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

/** Reuse diff-line counts when several summary sections need the same file delta. */
function lineDeltaFor(file: DiffFile, deltas?: Map<DiffFile, LineDelta>): LineDelta {
  const cached = deltas?.get(file);
  if (cached) {
    return cached;
  }
  const delta = lineDelta(file);
  deltas?.set(file, delta);
  return delta;
}

/** Count all changed text lines across parsed diff files. */
function totalChangedLines(files: DiffFile[], deltas?: Map<DiffFile, LineDelta>): number {
  return files.reduce((sum, file) => {
    const { additions, deletions } = lineDeltaFor(file, deltas);
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
export function deriveImpact(
  findings: Finding[],
  files: DiffFile[],
  changedLines = totalChangedLines(files)
): Impact {
  if (findings.some((f) => f.severity === "critical")) {
    return "high";
  }
  if (findings.some((f) => f.severity === "major") || changedLines > 400) {
    return "medium";
  }
  return "low";
}

/** Derive a 1–5 estimated-effort score from change size and file count. */
export function deriveEffort(files: DiffFile[], changedLines = totalChangedLines(files)): number {
  const count = files.length;
  let score = 1;
  if (changedLines > 20 || count > 2) score = 2;
  if (changedLines > 80 || count > 5) score = 3;
  if (changedLines > 250 || count > 15) score = 4;
  if (changedLines > 600 || count > 40) score = 5;
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

/**
 * Render the grouped changed-file list inside a collapsed `<details>` so the
 * file inventory stays out of the summary's main flow — a count in the summary,
 * the full list one click away (backlog #54).
 */
function changedFilesSection(files: DiffFile[], deltas?: Map<DiffFile, LineDelta>): string {
  if (files.length === 0) {
    return "<details>\n<summary><b>Changed files (0)</b></summary>\n\n_None._\n\n</details>";
  }
  const groups = new Map<string, DiffFile[]>();
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const dir = topDir(file.path);
    const list = groups.get(dir) ?? [];
    list.push(file);
    groups.set(dir, list);
  }

  const body: string[] = [];
  for (const [dir, groupFiles] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = dir === "(root)" ? "(root)/" : escapeMarkdownText(`${dir}/`);
    body.push(`**${label}**`);
    for (const file of groupFiles) {
      const { additions, deletions } = lineDeltaFor(file, deltas);
      const delta = file.binary
        ? "binary"
        : [additions ? `+${additions}` : "", deletions ? `−${deletions}` : ""].filter(Boolean).join(" ") || "no line changes";
      body.push(`- ${inlineCode(file.path)} — ${file.status} (${delta})`);
    }
  }

  // A blank line after <summary> is required for GitHub to render the Markdown
  // list inside the disclosure block.
  return [
    "<details>",
    `<summary><b>Changed files (${files.length})</b></summary>`,
    "",
    body.join("\n"),
    "",
    "</details>"
  ].join("\n");
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
    lines.push(
      `- ${SEVERITY_BADGE[finding.severity]} **${escapeMarkdownParagraphFlat(finding.title)}** — ${findingLocation(finding)}`
    );
  }
  return lines.join("\n");
}

/** Render caller-provided summaries as escaped text, preserving the fallback style. */
function summarySection(summary: string | undefined): string {
  const trimmed = summary?.trim();
  return trimmed ? escapeMarkdownParagraphFlat(trimmed) : "_Automated review of the changes in this pull request._";
}

/** Escape multi-line operational notes line-by-line before putting them in Markdown lists. */
function escapeReviewNote(note: string): string {
  return escapeMarkdownParagraphFlat(note);
}

/** Render reviewer-visible operational notes without allowing Markdown injection. */
function notesSection(notes: string[] | undefined): string {
  const visible = notes?.map((note) => note.trim()).filter(Boolean) ?? [];
  if (visible.length === 0) {
    return "";
  }
  return [
    "> ⚠️ **Review notes**",
    ...visible.map((note) => `> - ${escapeReviewNote(note)}`)
  ].join("\n");
}

/** Signature emoji for a genuinely clean review (Prowl's raccoon, not a generic 🎉). */
const CLEAN_EMOJI = "🦝";

/** The three distinct shapes a review comment can take (backlog #56). */
export type ReviewCommentState = "findings" | "clean" | "degraded";

/**
 * Pick the comment state from the review result. `findings` wins (real issues
 * are shown even if the run was also degraded); otherwise a degraded run is a
 * failure, and only a healthy empty run is "clean".
 */
export function reviewCommentState(input: WalkthroughInput): ReviewCommentState {
  if (input.findings.length > 0) {
    return "findings";
  }
  const partialCoverage =
    input.coverage !== undefined && input.coverage.passed < input.coverage.total;
  const skippedFiles = (input.skipped?.length ?? 0) > 0;
  return input.degraded || partialCoverage || skippedFiles ? "degraded" : "clean";
}

/** Render the "> ⚠️ Not reviewed" skip line, or "" when nothing was skipped. */
function skippedNoteBlock(skipped: SkippedFile[] | undefined): string {
  return skipped && skipped.length > 0 ? `> ⚠️ **Not reviewed:** ${skippedFilesNote(skipped)}` : "";
}

/** Render the optional Mermaid diagram block, or "" when none is provided. */
function diagramBlock(mermaid: string | undefined): string {
  return mermaid?.trim() ? ["### Diagram", fencedCodeBlock("mermaid", mermaid)].join("\n") : "";
}

/** Collapsed "Review info" block for the clean state: impact/effort/passes + benign notes. */
function reviewInfoDetails(input: WalkthroughInput, impact: Impact, effort: number): string {
  const header = `Impact: ${IMPACT_BADGE[impact]} · Estimated effort: ${effort}/5${
    input.coverage ? ` · ${input.coverage.passed}/${input.coverage.total} passes` : ""
  }`;
  const lines = [header];
  for (const note of input.notes?.map((n) => n.trim()).filter(Boolean) ?? []) {
    lines.push(`- ${escapeReviewNote(note)}`);
  }
  return ["<details>", "<summary><b>Review info</b></summary>", "", lines.join("\n"), "", "</details>"].join("\n");
}

/**
 * Render the review summary markdown in one of three distinct states (#56):
 * `findings` (full report), `clean` (compact "no issues" + collapsibles), or
 * `degraded` (a clear "review incomplete" — never disguised as "Findings: none").
 */
export function buildWalkthrough(input: WalkthroughInput): string {
  const lineDeltas = new Map<DiffFile, LineDelta>();
  const changedLines = totalChangedLines(input.files, lineDeltas);
  const impact = input.impact ?? deriveImpact(input.findings, input.files, changedLines);
  const effort = input.effort ?? deriveEffort(input.files, changedLines);
  const state = reviewCommentState(input);

  const sections: string[] = [REVIEW_MARKER, "## prowl-review"];

  if (state === "clean") {
    sections.push(
      `✅ No issues found ${CLEAN_EMOJI}`,
      reviewInfoDetails(input, impact, effort),
      changedFilesSection(input.files, lineDeltas)
    );
  } else if (state === "degraded") {
    const failed = input.coverage ? input.coverage.total - input.coverage.passed : 0;
    const header =
      failed > 0 && input.coverage
        ? `⚠️ **Review incomplete** — ${failed}/${input.coverage.total} specialist passes failed; coverage degraded`
        : "⚠️ **Review incomplete** — coverage degraded";
    sections.push(header, notesSection(input.notes), changedFilesSection(input.files, lineDeltas));
  } else {
    const counts = severityCounts(input.findings);
    sections.push(
      summarySection(input.summary),
      `**Impact:** ${IMPACT_BADGE[impact]} · **Estimated effort:** ${effort}/5 · **Findings:** ${severityCountLine(counts)}`,
      changedFilesSection(input.files, lineDeltas),
      findingsSection(input.findings),
      notesSection(input.notes)
    );
  }

  sections.push(skippedNoteBlock(input.skipped), diagramBlock(input.mermaid));

  // Drop the empty placeholders the per-state blocks may have produced.
  return sections.filter((section) => section.trim().length > 0).join("\n\n");
}

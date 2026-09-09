import type { DiffFile } from "./diff-types.js";
import type { Finding, Severity } from "./findings.js";
import { SEVERITIES, SEVERITY_ORDER, isBlockingFinding } from "./findings.js";
import type { SkipReason, SkippedFile } from "./diff-types.js";

/**
 * Structured walkthrough summary (backlog #9) — a pure markdown formatter that
 * turns the ranked findings + parsed diff into the review's summary body. No
 * GitHub calls; #10 publishes the returned string. Findings detail is carried
 * by inline comments (#10); this summary highlights blockers + counts.
 *
 * Layout (#72): one always-visible status line, then three collapsed rows —
 * **Walkthrough** (summary, findings table, per-model, nitpicks, diagram),
 * **Changed files** (grouped inventory + anything not reviewed), and
 * **Review info** (coverage, grounding, verification and retrieval notes) — so
 * the first comment fits on one screen without scrolling.
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

/** Map impact to a GitHub alert type so the callout's color tracks severity (#54). */
const IMPACT_ALERT: Record<Impact, string> = {
  high: "CAUTION",
  medium: "WARNING",
  low: "NOTE"
};

/** Render a 1–5 effort score as a filled/empty bar, e.g. ▰▰▰▱▱ (#54). */
function effortBar(effort: number): string {
  const filled = normalizeEffort(effort);
  return "▰".repeat(filled) + "▱".repeat(5 - filled);
}

/** Clamp reviewer-visible effort values to the score range shown in comments. */
function normalizeEffort(effort: number): number {
  return Math.max(1, Math.min(5, Math.round(effort)));
}

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
  /**
   * Number of providers in a multi-provider ensemble run (#53). When ≥ 2,
   * findings agreed on by multiple providers get a 🤝 consensus badge.
   */
  providerCount?: number;
  /**
   * Ensemble provider lineup, in order (#53). When ≥ 2, the walkthrough adds a
   * per-model collapsible section so each model's own findings are visible
   * alongside the consolidated table.
   */
  providers?: string[];
}

const SKIP_LABELS: Record<SkipReason, string> = {
  binary: "binary (not reviewable)",
  maxFiles: "skipped - file limit reached",
  maxDiffBytes: "skipped - diff size limit reached",
  sensitive: "sensitive - kept out of the prompt",
  ignored: "ignored - matched the ignore list"
};

const MARKDOWN_TEXT_ESCAPES = new Set("\\`*_{}[]()#+-.!|><@&".split(""));
const MARKDOWN_PARAGRAPH_ESCAPES = new Set("\\`*_{}[]()#+!|><@&".split(""));

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
  if (char === "&") {
    return "&amp;";
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

/** Escape multiline body text line-by-line while preserving paragraph breaks. */
function escapeMarkdownParagraphBlock(value: string): string {
  return value.split(/\r\n|\r|\n/).map(escapeMarkdownParagraph).join("\n");
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
function fencedCodeBlock(language: string, body: string, options: { preserveWhitespace?: boolean } = {}): string {
  const trimmed = options.preserveWhitespace ? body.replace(/\r\n|\r/g, "\n") : body.trim();
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

/** Wrap a body in a collapsed `<details>` block with a bold summary row. */
function detailsBlock(summary: string, body: string): string {
  // A blank line after <summary> is required for GitHub to render the Markdown
  // inside the disclosure block.
  return ["<details>", `<summary><b>${summary}</b></summary>`, "", body, "", "</details>"].join("\n");
}

/** Pluralize a count-labelled noun for summary rows. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Render the grouped changed-file list inside a collapsed `<details>` so the
 * file inventory stays out of the summary's main flow — a count in the summary
 * row, the full list one click away (backlog #54). Files the guardrails skipped
 * are listed in the same block under "Not reviewed" and counted in the row, so
 * partial coverage is visible without opening it (no silent truncation).
 */
function changedFilesSection(files: DiffFile[], deltas?: Map<DiffFile, LineDelta>, skipped: SkippedFile[] = []): string {
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
    // A blank line between groups so the heading does not lazily continue the
    // previous group's last list item.
    if (body.length > 0) {
      body.push("");
    }
    body.push(`**${label}**`);
    for (const file of groupFiles) {
      const { additions, deletions } = lineDeltaFor(file, deltas);
      const delta = file.binary
        ? "binary"
        : [additions ? `+${additions}` : "", deletions ? `−${deletions}` : ""].filter(Boolean).join(" ") || "no line changes";
      body.push(`- ${inlineCode(file.path)} — ${file.status} (${delta})`);
    }
  }
  if (body.length === 0) {
    body.push("_None._");
  }
  if (skipped.length > 0) {
    body.push("", "**Not reviewed**", ...skippedFileLines(skipped));
  }

  const count = skipped.length > 0 ? `${files.length} · ${skipped.length} not reviewed` : `${files.length}`;
  return detailsBlock(`🗂️ Changed files (${count})`, body.join("\n"));
}

/** Render skipped files as one bullet per reason, with untrusted paths in safe code spans. */
function skippedFileLines(skipped: SkippedFile[]): string[] {
  const byReason = new Map<SkipReason, string[]>();
  for (const { path, reason } of skipped) {
    const list = byReason.get(reason) ?? [];
    list.push(inlineCode(path));
    byReason.set(reason, list);
  }
  return [...byReason.entries()].map(([reason, paths]) => `- ${SKIP_LABELS[reason]}: ${paths.join(", ")}`);
}

/** Render a finding's file/line location with a safe path code span. */
function findingLocation(finding: Finding): string {
  return inlineCode(finding.line ? `${finding.file}:${finding.line}` : finding.file);
}

/**
 * Cross-provider consensus badge for an ensemble run (#53): "🤝 N/M" when at
 * least two providers independently raised the finding, else "". `providerCount`
 * is the ensemble size (M); omitted/`<2` disables the badge entirely.
 */
export function consensusBadge(finding: Finding, providerCount?: number): string {
  const agreed = finding.sources?.length ?? 0;
  if (!providerCount || providerCount < 2 || agreed < 2) {
    return "";
  }
  return `🤝 ${agreed}/${providerCount}`;
}

/** Append the consensus badge to a rendered fragment when present. */
function withConsensus(fragment: string, finding: Finding, providerCount?: number): string {
  const badge = consensusBadge(finding, providerCount);
  return badge ? `${fragment} ${badge}` : fragment;
}

/** One finding rendered as a summary bullet (badge · title · location). */
function findingBullet(finding: Finding, providerCount?: number): string {
  const bullet = `- ${SEVERITY_BADGE[finding.severity]} **${escapeMarkdownParagraphFlat(finding.title)}** — ${findingLocation(finding)}`;
  return withConsensus(bullet, finding, providerCount);
}

/** One nitpick rendered with enough detail to fix it without an inline comment. */
function nitpickDetail(finding: Finding, providerCount?: number): string {
  const parts = [findingBullet(finding, providerCount), "", escapeMarkdownParagraphBlock(finding.body)];
  const suggestion = finding.suggestion;
  if (suggestion?.trim()) {
    parts.push("", "_Suggested fix:_", fencedCodeBlock("suggestion", suggestion, { preserveWhitespace: true }));
  }
  return parts.join("\n");
}

/** Escape a pre-rendered cell so a stray pipe/newline can't break a Markdown table. */
function tableCellSafe(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Render blocking findings as a compact table (severity · location · finding) —
 * scannable rather than a flat bullet wall (#54). Nitpicks go in their own
 * collapsed section.
 */
function findingsSection(findings: Finding[], providerCount?: number): string {
  const blockers = findings.filter(isBlockingFinding);
  if (blockers.length === 0) {
    return "### Findings\n_No blocking issues found._";
  }
  const rows = blockers.map((finding) => {
    // The title is already paragraph-escaped (pipes included) and the badge has
    // no pipes/newlines, so the cell is table-safe without re-escaping.
    const title = withConsensus(`**${escapeMarkdownParagraphFlat(finding.title)}**`, finding, providerCount);
    return `| ${SEVERITY_BADGE[finding.severity]} ${finding.severity} | ${tableCellSafe(
      findingLocation(finding)
    )} | ${title} |`;
  });
  return ["### Findings", "", "| Severity | Location | Finding |", "| :-- | :-- | :-- |", ...rows].join("\n");
}

/**
 * Render non-blocking (`minor` and below) findings in a collapsed "Nitpicks"
 * disclosure so polish doesn't clutter the review or the diff (#58). Empty when
 * there are no nitpicks.
 */
function nitpickSection(findings: Finding[], providerCount?: number): string {
  const nits = findings.filter((finding) => !isBlockingFinding(finding));
  if (nits.length === 0) {
    return "";
  }
  return [
    "<details>",
    `<summary>🧹 Nitpicks (${nits.length})</summary>`,
    "",
    nits.map((finding) => nitpickDetail(finding, providerCount)).join("\n\n"),
    "",
    "</details>"
  ].join("\n");
}

/**
 * A small per-provider glyph for the per-model sections; falls back to 🔹.
 * Squares (distinct from the severity circles) in each provider's brand color:
 * orange = Anthropic, blue = OpenAI, green = Gemini.
 */
const PROVIDER_GLYPH: Record<string, string> = {
  anthropic: "🟧",
  openai: "🟦",
  gemini: "🟩"
};

/** Order a provider's findings most-severe-first using that provider's own take. */
function providerFindingLine(finding: Finding, provider: string): { severity: Severity; line: string } {
  const perspective = finding.perspectives?.find((p) => p.provider === provider);
  const severity = perspective?.severity ?? finding.severity;
  const title = perspective?.title ?? finding.title;
  return {
    severity,
    line: `- ${SEVERITY_BADGE[severity]} ${severity} ${findingLocation(finding)} — ${escapeMarkdownParagraphFlat(title)}`
  };
}

/**
 * Per-model breakdown for an ensemble run (#53): one collapsed `<details>` per
 * provider listing the findings it raised, in that provider's own words and
 * severity — so a reader can see what each model returned, not just the
 * consolidated result. Empty unless ≥ 2 providers ran.
 */
function perModelSections(findings: Finding[], providers: string[] | undefined): string {
  if (!providers || providers.length < 2) {
    return "";
  }
  const sections = providers.map((provider) => {
    const own = findings
      .filter((finding) => (finding.sources ?? []).includes(provider))
      .map((finding) => providerFindingLine(finding, provider))
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    const glyph = PROVIDER_GLYPH[provider.toLowerCase()] ?? "🔹";
    const heading = `${glyph} ${provider} — ${own.length} finding${own.length === 1 ? "" : "s"}`;
    const inner = own.length > 0 ? own.map((entry) => entry.line).join("\n") : "_No findings from this model._";
    return ["<details>", `<summary>${heading}</summary>`, "", inner, "", "</details>"].join("\n");
  });
  return ["### Per-model findings", "", ...sections].join("\n");
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

/**
 * Context-retrieval notes are operational chatter (a skipped suggested path, a
 * budget hit) that arrives a dozen at a time. Once there are this many they
 * roll up into one nested disclosure inside Review info instead of a flat
 * bullet wall; fewer stay inline where they are easy to read.
 */
const RETRIEVAL_NOTE_PREFIX = "Context retrieval:";
const RETRIEVAL_ROLLUP_THRESHOLD = 3;
const SKIPPED_PATH_NOTE_RE = /^Context retrieval: Skipped .*\bpath\b/i;

/** Split visible notes into the inline list and the rolled-up retrieval group. */
function splitRetrievalNotes(notes: string[]): { inline: string[]; rolled: string[] } {
  const rolled = notes.filter((note) => note.startsWith(RETRIEVAL_NOTE_PREFIX));
  if (rolled.length < RETRIEVAL_ROLLUP_THRESHOLD) {
    return { inline: notes, rolled: [] };
  }
  return { inline: notes.filter((note) => !note.startsWith(RETRIEVAL_NOTE_PREFIX)), rolled };
}

/** Nested disclosure for the rolled-up retrieval notes, labelled with what is inside. */
function rolledRetrievalNotes(rolled: string[]): string {
  const skippedPaths = rolled.filter((note) => SKIPPED_PATH_NOTE_RE.test(note)).length;
  const detail = skippedPaths > 0 ? ` · ${plural(skippedPaths, "suggested path")} skipped` : "";
  const label = `Context retrieval (${plural(rolled.length, "note")}${detail})`;
  return [
    "<details>",
    `<summary>${label}</summary>`,
    "",
    rolled.map((note) => `- ${escapeReviewNote(note)}`).join("\n"),
    "",
    "</details>"
  ].join("\n");
}

/**
 * Collapsed "Review info" row: coverage / impact header lines, then the
 * operational notes (grounding, verification, retrieval) as an escaped list,
 * with bulk retrieval chatter rolled up one level deeper. Empty when there is
 * nothing to say, so a quiet review does not grow an empty row.
 */
function reviewInfoSection(notes: string[] | undefined, headerLines: string[] = []): string {
  const visible = notes?.map((note) => note.trim()).filter(Boolean) ?? [];
  const { inline, rolled } = splitRetrievalNotes(visible);
  const parts: string[] = [];
  if (headerLines.length > 0) {
    parts.push(headerLines.join("\n"));
  }
  if (inline.length > 0) {
    parts.push(inline.map((note) => `- ${escapeReviewNote(note)}`).join("\n"));
  }
  if (rolled.length > 0) {
    parts.push(rolledRetrievalNotes(rolled));
  }
  if (parts.length === 0) {
    return "";
  }
  return detailsBlock("🔍 Review info", parts.join("\n\n"));
}

/** Celebration emoji for a genuinely clean review (a "ship it" rocket, not CodeRabbit's 🎉). */
const CLEAN_EMOJI = "🚀";

/** The three distinct shapes a review comment can take (backlog #56). */
export type ReviewCommentState = "findings" | "clean" | "degraded";

/**
 * Pick the comment state from the review result. `findings` wins (real issues
 * are shown even if the run was also degraded); a run that couldn't fully
 * execute (caller's `degraded` flag, or a failed specialist pass seen via
 * partial coverage) is `degraded`; everything else is `clean`.
 *
 * Skipped files do NOT make a run degraded — a guardrail skip is partial
 * coverage on an otherwise healthy review, surfaced as the clean state's caveat
 * headline + the "Not reviewed" list in Changed files, not an alarming
 * "Review incomplete" (#56).
 */
export function reviewCommentState(input: WalkthroughInput): ReviewCommentState {
  if (input.findings.length > 0) {
    return "findings";
  }
  const partialCoverage =
    input.coverage !== undefined && input.coverage.passed < input.coverage.total;
  return input.degraded || partialCoverage ? "degraded" : "clean";
}

/** Render the optional Mermaid diagram block, or "" when none is provided. */
function diagramBlock(mermaid: string | undefined): string {
  return mermaid?.trim() ? ["### Diagram", fencedCodeBlock("mermaid", mermaid)].join("\n") : "";
}

/** Join non-empty Markdown blocks with a blank line between them. */
function joinBlocks(blocks: string[]): string {
  return blocks.filter((block) => block.trim().length > 0).join("\n\n");
}

/** Impact/effort/findings header as a GitHub alert keyed to impact (findings state, #54). */
function impactAlert(impact: Impact, effort: number, counts: Record<Severity, number>): string {
  return [
    `> [!${IMPACT_ALERT[impact]}]`,
    `> **Impact:** ${IMPACT_BADGE[impact]} · **Estimated effort:** ${effortBar(effort)} (${effort}/5) · ` +
      `**Findings:** ${severityCountLine(counts)}`
  ].join("\n");
}

/** "N/M passes" fragment for the Review info header, or "" without coverage data. */
function passesLine(coverage: WalkthroughInput["coverage"]): string {
  return coverage ? `${coverage.passed}/${coverage.total} passes` : "";
}

/**
 * Collapsed "Walkthrough" row for the findings state: the plain-language
 * summary, the blocking-findings table, the per-model breakdown (#53), the
 * nitpick bucket (#58) and the optional diagram. Inline comments already carry
 * each finding on the diff, so this is the recap, one click away.
 */
function walkthroughSection(input: WalkthroughInput): string {
  const body = joinBlocks([
    summarySection(input.summary),
    findingsSection(input.findings, input.providerCount),
    perModelSections(input.findings, input.providers),
    nitpickSection(input.findings, input.providerCount),
    diagramBlock(input.mermaid)
  ]);
  return detailsBlock("📝 Walkthrough", body);
}

/**
 * Walkthrough row for the clean / degraded states: only when the caller gave a
 * summary or a diagram — there is no findings table to recap, so the row is
 * omitted rather than shown empty.
 */
function optionalWalkthroughSection(input: WalkthroughInput): string {
  const summary = input.summary?.trim() ? summarySection(input.summary) : "";
  const body = joinBlocks([summary, diagramBlock(input.mermaid)]);
  return body ? detailsBlock("📝 Walkthrough", body) : "";
}

/**
 * Render the review summary markdown in one of three distinct states (#56):
 * `findings` (status alert + Walkthrough), `clean` (compact "no issues"), or
 * `degraded` (a clear "review incomplete" — never disguised as "Findings:
 * none"). Every state shares the same three collapsed rows underneath the
 * status line so the comment is scannable without scrolling (#72).
 */
export function buildWalkthrough(input: WalkthroughInput): string {
  const lineDeltas = new Map<DiffFile, LineDelta>();
  const changedLines = totalChangedLines(input.files, lineDeltas);
  const impact = input.impact ?? deriveImpact(input.findings, input.files, changedLines);
  const effort = normalizeEffort(input.effort ?? deriveEffort(input.files, changedLines));
  const state = reviewCommentState(input);
  const skipped = input.skipped ?? [];

  const sections: string[] = [REVIEW_MARKER, "## prowl-review"];

  if (state === "clean") {
    // When guardrails skipped files the review is still healthy, but it didn't
    // see everything — caveat the headline rather than claiming a blanket pass
    // (the "Not reviewed" list in Changed files says what was skipped). (#56)
    const headline =
      skipped.length > 0 ? `✅ No issues found in reviewed files ${CLEAN_EMOJI}` : `✅ No issues found ${CLEAN_EMOJI}`;
    const header = [
      `Impact: ${IMPACT_BADGE[impact]} · Estimated effort: ${effortBar(effort)} (${effort}/5)`,
      passesLine(input.coverage)
    ]
      .filter(Boolean)
      .join(" · ");
    sections.push(
      headline,
      optionalWalkthroughSection(input),
      changedFilesSection(input.files, lineDeltas, skipped),
      reviewInfoSection(input.notes, [header])
    );
  } else if (state === "degraded") {
    const failed = input.coverage ? input.coverage.total - input.coverage.passed : 0;
    const header =
      failed > 0 && input.coverage
        ? `⚠️ **Review incomplete** — ${failed}/${input.coverage.total} specialist passes failed; coverage degraded`
        : "⚠️ **Review incomplete** — coverage degraded";
    sections.push(
      header,
      optionalWalkthroughSection(input),
      changedFilesSection(input.files, lineDeltas, skipped),
      reviewInfoSection(input.notes)
    );
  } else {
    const counts = severityCounts(input.findings);
    sections.push(
      impactAlert(impact, effort, counts),
      walkthroughSection(input),
      changedFilesSection(input.files, lineDeltas, skipped),
      reviewInfoSection(input.notes, input.coverage ? [`**Coverage:** ${passesLine(input.coverage)}`] : [])
    );
  }

  // Drop the empty placeholders the per-state blocks may have produced.
  return joinBlocks(sections);
}

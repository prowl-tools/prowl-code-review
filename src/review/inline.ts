import type { ParsedDiff } from "./diff-types.js";
import type { Finding, Severity } from "./findings.js";
import { isBlockingFinding } from "./findings.js";
import { findingFingerprint, GITHUB_COMMENT_BODY_LIMIT } from "./state.js";

/**
 * Inline comments + committable suggestions (backlog #10).
 *
 * Pure mapping/formatting: turn ranked findings into GitHub review comments
 * anchored to exact diff lines, with a committable `suggestion` block when a fix
 * exists. Findings that don't land on a changed line are returned as `unmapped`
 * so the caller can keep them in the summary (no silent drop).
 */

/** GitHub diff side accepted by inline review comments. */
export type ReviewSide = "RIGHT" | "LEFT";

/** GitHub review event used when publishing the review payload. */
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** Inline comment payload accepted by GitHub's create-review endpoint. */
export interface ReviewComment {
  /** Repository-relative path to the commented file. */
  path: string;
  /** New-side line the comment anchors to (end line for a range). */
  line: number;
  /** Diff side for `line`. */
  side: ReviewSide;
  /** Start line for a multi-line comment range. */
  start_line?: number;
  /** Diff side for `start_line`. */
  start_side?: ReviewSide;
  /** Markdown body for the inline review comment. */
  body: string;
  /** Stable fingerprint of the source finding, for update-not-duplicate dedup (#12/#22). */
  fingerprint: string;
}

/** Default ceiling on inline comments per review, so a big PR isn't carpet-bombed (#25). */
export const DEFAULT_MAX_INLINE_COMMENTS = 20;

/** Result of mapping findings into inline comments. */
export interface InlineMapping {
  /** Findings successfully anchored as GitHub inline review comments. */
  comments: ReviewComment[];
  /** Findings that couldn't be anchored to a changed line. */
  unmapped: Finding[];
  /** Mappable findings dropped from inline because the volume cap was reached (#25). */
  overflow: Finding[];
}

/** Complete review payload ready to publish to GitHub. */
export interface ReviewPayload {
  /** Markdown summary body for the pull request review. */
  body: string;
  /** Review event sent with the payload. */
  event: ReviewEvent;
  /** Inline comments included in the review. */
  comments: ReviewComment[];
}

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "🔴",
  major: "🟠",
  minor: "🟡",
  trivial: "🔵",
  info: "⚪"
};

const MARKDOWN_TEXT_ESCAPES = new Set("\\`*_{}[]()#+-.!|><@&".split(""));
const MARKDOWN_PARAGRAPH_ESCAPES = new Set("\\`*_{}[]()#+!|><@&".split(""));
const PROWL_REVIEW_STATE_MARKER_RE = /<\s*!\s*--\s*prowl-review:state\b[\s\S]*?--\s*>/gi;
const PROWL_REVIEW_INLINE_FINGERPRINT_MARKER_RE = /<\s*!\s*--\s*prowl-review:finding\b[\s\S]*?--\s*>/gi;
const INLINE_FINGERPRINT_MARKER_HEADROOM = 128;
const SUMMARY_STATE_MARKER_HEADROOM = 4_096;
const INLINE_COMMENT_BODY_BUDGET = GITHUB_COMMENT_BODY_LIMIT - INLINE_FINGERPRINT_MARKER_HEADROOM;
const SUMMARY_COMMENT_BODY_BUDGET = GITHUB_COMMENT_BODY_LIMIT - SUMMARY_STATE_MARKER_HEADROOM;
const MIN_AGENT_PROMPT_BLOCK_CHARS = 512;
const AGENT_PROMPT_TRUNCATION_NOTICE =
  "[truncated to keep the GitHub comment within the body size limit]";

/**
 * Build commentable new-side line numbers per file, preserving the hunk each
 * line belongs to so multi-line ranges never cross GitHub diff hunks.
 */
function newSideLineHunks(diff: ParsedDiff): Map<string, Map<number, number>> {
  const map = new Map<string, Map<number, number>>();
  for (const file of diff.files) {
    const lines = new Map<number, number>();
    file.hunks.forEach((hunk, hunkIndex) => {
      for (const line of hunk.lines) {
        if (line.newLine !== undefined) {
          lines.set(line.newLine, hunkIndex);
        }
      }
    });
    map.set(file.path, lines);
  }
  return map;
}

/** Return true when every line in a range is present in the same diff hunk. */
function sameHunkRange(lineHunks: Map<number, number>, start: number, end: number): boolean {
  const hunkIndex = lineHunks.get(start);
  if (hunkIndex === undefined || lineHunks.get(end) !== hunkIndex) {
    return false;
  }

  for (let line = start; line <= end; line += 1) {
    if (lineHunks.get(line) !== hunkIndex) {
      return false;
    }
  }

  return true;
}

/** Replace control characters so untrusted finding text cannot alter Markdown. */
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

/** Render mention markers as entities so GitHub does not notify users or teams. */
function neutralizeMentions(value: string): string {
  return value.replaceAll("\\@", "&#64;").replaceAll("@", "&#64;");
}

/** Detect an ordered-list marker that would alter Markdown paragraph structure. */
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

/** Escape Markdown metacharacters for plain text contexts such as headings. */
function escapeMarkdownText(value: string): string {
  let escaped = "";
  for (const char of normalizeMarkdownText(value)) {
    escaped += MARKDOWN_TEXT_ESCAPES.has(char) ? escapeMarkdownChar(char) : char;
  }
  return neutralizeMentions(escaped);
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

/** Escape multiline body text line-by-line while preserving paragraph breaks. */
function escapeMarkdownParagraphBlock(value: string): string {
  return value.split(/\r\n|\r|\n/).map(escapeMarkdownParagraph).join("\n");
}

/** Pick a backtick fence longer than any run inside `content`, so it can't break out. */
function fenceFor(content: string): string {
  let longestRun = 0;
  for (const match of content.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Wrap suggested code in a ```suggestion fence longer than any backtick run in it. */
function suggestionBlock(code: string): string {
  const fence = fenceFor(code);
  return `${fence}suggestion\n${code.replace(/\n$/, "")}\n${fence}`;
}

/** Wrap sanitized prompt content in a collapsed fenced block. */
function agentPromptDetailsBlock(content: string, fence = fenceFor(content)): string {
  return [
    "<details>",
    "<summary>🤖 Resolve with an AI agent</summary>",
    "",
    `${fence}text\n${content}\n${fence}`,
    "",
    "</details>"
  ].join("\n");
}

/** Fit a prompt block into the available published-comment budget, or omit it. */
function fitAgentPromptBlock(content: string, maxChars?: number): string | undefined {
  const fence = fenceFor(content);
  const full = agentPromptDetailsBlock(content, fence);
  if (maxChars === undefined || full.length <= maxChars) {
    return full;
  }
  if (maxChars < MIN_AGENT_PROMPT_BLOCK_CHARS) {
    return undefined;
  }

  const suffix = `\n\n${AGENT_PROMPT_TRUNCATION_NOTICE}\n\n${AGENT_PROMPT_INSTRUCTION}`;
  const fixedOverhead = agentPromptDetailsBlock("", fence).length + suffix.length;
  const budgetForContent = maxChars - fixedOverhead;
  if (budgetForContent <= 0) {
    return undefined;
  }

  const truncatedContent = `${content.slice(0, budgetForContent).trimEnd()}${suffix}`;
  return agentPromptDetailsBlock(truncatedContent, fence);
}

/**
 * Strip control characters so untrusted finding text can't break out of a code
 * fence or smuggle terminal/markup escapes. Newlines and tabs are preserved
 * (the agent prompt is multi-line literal text); CR is normalized to LF and any
 * other C0/DEL control is dropped. Prowl state and inline fingerprint markers
 * are removed so quoted or prompt-injected finding text cannot spoof hidden
 * markers that later review publication reads for deduplication/state.
 * Fence-widening (see {@link fenceFor}) handles embedded backtick runs.
 */
function sanitizeForCodeFence(value: string): string {
  let out = "";
  const sanitized = value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  for (const char of sanitized) {
    const code = char.charCodeAt(0);
    if (code === 0x09 || code === 0x0a) {
      out += char;
    } else if (code <= 0x1f || code === 0x7f) {
      // drop other control characters
    } else {
      out += char;
    }
  }
  return out
    .replaceAll(PROWL_REVIEW_STATE_MARKER_RE, "[removed prowl-review state marker]")
    .replaceAll(PROWL_REVIEW_INLINE_FINGERPRINT_MARKER_RE, "[removed prowl-review finding marker]");
}

/** Fixed instruction appended to every agent-fix prompt (#57). */
const AGENT_PROMPT_INSTRUCTION =
  "Instructions: verify the finding against the current code; if it is valid, apply the smallest " +
  "change that resolves it without altering unrelated behavior and re-run the build and tests; if it " +
  "is not valid, leave the code unchanged and explain why.";

/**
 * Build the collapsed "Resolve with an AI agent" block for a finding (#57): a
 * ready-to-copy, fenced (non-rendered) prompt carrying the finding's location,
 * severity, category, title, body, and committable suggestion (when present),
 * plus a fixed verify-or-fix instruction. Untrusted finding text is
 * control-char sanitized, the fence is widened past any backtick run in it, and
 * the copied text is truncated or omitted when needed so prompt duplication
 * does not push the published GitHub comment over its body limit.
 */
function agentPromptBlock(finding: Finding, maxChars?: number): string | undefined {
  const lines = [
    "Resolve this prowl-review finding.",
    "",
    `Location: ${findingLocation(finding)}`,
    `Severity: ${finding.severity}`,
    `Category: ${finding.category}`,
    `Title: ${finding.title}`,
    "",
    "Details:",
    finding.body
  ];
  if (hasSuggestion(finding)) {
    lines.push("", "Suggested fix:", finding.suggestion ?? "");
  }
  lines.push("", AGENT_PROMPT_INSTRUCTION);

  const content = sanitizeForCodeFence(lines.join("\n"));
  return fitAgentPromptBlock(content, maxChars);
}

/** Return true when a finding includes a non-empty committable suggestion. */
function hasSuggestion(finding: Finding): boolean {
  return Boolean(finding.suggestion?.trim());
}

/** Return true when a suggestion would replace more than one line. */
function hasMultiLineSuggestion(finding: Finding): boolean {
  const suggestion = finding.suggestion?.replaceAll("\r\n", "\n").replace(/\n+$/, "") ?? "";
  return suggestion.includes("\n");
}

/** Options governing how a finding comment is rendered. */
export interface FindingCommentOptions {
  /** Append the "Resolve with an AI agent" prompt block (#57). Default true. */
  agentPrompt?: boolean;
}

interface FindingCommentRenderOptions extends FindingCommentOptions {
  /** Maximum published body length; prompt text is truncated or omitted to fit. */
  maxBodyChars?: number;
}

/** Format the visible finding body without the optional agent prompt. */
function formatFindingCommentBody(finding: Finding): string {
  const parts = [
    `${SEVERITY_BADGE[finding.severity]} **[${finding.severity}] ${escapeMarkdownText(finding.title)}**`,
    "",
    escapeMarkdownParagraphBlock(finding.body)
  ];
  if (hasSuggestion(finding)) {
    parts.push("", suggestionBlock(finding.suggestion ?? ""));
  }
  return parts.join("\n");
}

/** Append a budgeted agent prompt to an already-rendered finding body. */
function appendAgentPrompt(
  body: string,
  finding: Finding,
  options: FindingCommentRenderOptions = {}
): string {
  // Default on: a copy-paste prompt so a coding agent can verify-and-fix (#57).
  if (options.agentPrompt !== false) {
    const separator = "\n\n";
    const maxPromptChars =
      options.maxBodyChars === undefined ? undefined : options.maxBodyChars - body.length - separator.length;
    const prompt = agentPromptBlock(finding, maxPromptChars);
    if (prompt) {
      return `${body}${separator}${prompt}`;
    }
  }
  return body;
}

/** Format one finding as an inline comment body (severity badge + optional fix + agent prompt). */
function formatFindingCommentInternal(finding: Finding, options: FindingCommentRenderOptions = {}): string {
  return appendAgentPrompt(formatFindingCommentBody(finding), finding, options);
}

/** Format one finding as an inline comment body (severity badge + optional fix + agent prompt). */
export function formatFindingComment(finding: Finding, options: FindingCommentOptions = {}): string {
  return formatFindingCommentInternal(finding, { ...options, maxBodyChars: INLINE_COMMENT_BODY_BUDGET });
}

/** Format the most specific location available for a finding. */
function findingLocation(finding: Finding): string {
  if (finding.line === undefined) {
    return finding.file;
  }
  if (finding.endLine !== undefined && finding.endLine > finding.line) {
    return `${finding.file}:${finding.line}-${finding.endLine}`;
  }
  return `${finding.file}:${finding.line}`;
}

/** Build the fallback review-body section for findings outside changed diff lines. */
function formatUnmappedFindings(
  findings: Finding[],
  options: FindingCommentOptions,
  initialLength = 0
): string {
  if (findings.length === 0) {
    return "";
  }

  const parts = [
    "## Unmapped findings",
    "",
    "These findings could not be anchored to changed diff lines, so they are included here instead."
  ];
  let section = parts.join("\n");
  const visibleEntries = findings.map((finding) => {
    const heading = `### ${escapeMarkdownText(findingLocation(finding))}`;
    const comment = formatFindingCommentBody(finding);
    return {
      heading,
      comment,
      length: heading.length + 2 + comment.length
    };
  });
  const separatorLength = 2;
  let remainingVisibleLength = visibleEntries.reduce(
    (sum, visibleEntry) => sum + separatorLength + visibleEntry.length,
    0
  );

  for (const [index, finding] of findings.entries()) {
    const separator = "\n\n";
    const visibleEntry = visibleEntries[index];
    remainingVisibleLength -= separator.length + visibleEntry.length;
    const commentPrefixLength = visibleEntry.heading.length + 2;
    const existingLength = initialLength + section.length + separator.length;
    const remainingForEntry = SUMMARY_COMMENT_BODY_BUDGET - existingLength - remainingVisibleLength;
    const comment = appendAgentPrompt(visibleEntry.comment, finding, {
      ...options,
      maxBodyChars: remainingForEntry - commentPrefixLength
    });
    section = `${section}${separator}${visibleEntry.heading}\n\n${comment}`;
  }

  return section;
}

/**
 * Render the inline-cap overflow as a compact section grouped by severity (#25):
 * one line per finding (`badge location — title`), so a large PR's extra
 * findings are reported in the summary without re-bloating it with full bodies.
 * Returns "" when nothing overflowed.
 */
function formatOverflowFindings(overflow: Finding[], cap: number): string {
  if (overflow.length === 0) {
    return "";
  }

  const lines = [
    `## ${overflow.length} more finding${overflow.length === 1 ? "" : "s"} (inline comment cap: ${cap})`,
    "",
    "The inline-comment cap was reached; these additional findings are listed here instead of on the diff."
  ];

  // Group by severity in precedence order; only severities that occur are shown.
  for (const severity of Object.keys(SEVERITY_BADGE) as Severity[]) {
    const group = overflow.filter((finding) => finding.severity === severity);
    if (group.length === 0) {
      continue;
    }
    lines.push("", `**${SEVERITY_BADGE[severity]} ${severity} (${group.length})**`);
    for (const finding of group) {
      lines.push(
        `- ${escapeMarkdownText(findingLocation(finding))} — ${escapeMarkdownText(finding.title)}`
      );
    }
  }

  return lines.join("\n");
}

/** Append the overflow section to the review body. */
function withOverflowFindings(summaryBody: string, overflow: Finding[], cap: number): string {
  const trimmed = summaryBody.trimEnd();
  const section = formatOverflowFindings(overflow, cap);
  return [trimmed, section].filter(Boolean).join("\n\n");
}

/** Append unmapped findings to the review body without changing inline comments. */
function withUnmappedFindings(summaryBody: string, unmapped: Finding[], options: FindingCommentOptions): string {
  const trimmed = summaryBody.trimEnd();
  const separator = trimmed ? "\n\n" : "";
  const section = formatUnmappedFindings(unmapped, options, trimmed.length + separator.length);
  return [trimmed, section].filter(Boolean).join(separator);
}

/**
 * Map findings to inline review comments anchored on the diff. A finding maps
 * when its file + line is a new-side line in the diff; multi-line findings only
 * become ranges when every line sits inside the same diff hunk. Everything else
 * is `unmapped`.
 */
export interface BuildInlineCommentsOptions extends FindingCommentOptions {
  /** Max inline comments to emit; mappable findings beyond it become `overflow` (#25). */
  maxComments?: number;
}

/**
 * Convert ranked blocking findings into GitHub inline comments up to the
 * configured cap, returning unanchored findings separately from cap overflow so
 * callers can preserve both groups in the summary body.
 */
export function buildInlineComments(
  findings: Finding[],
  diff: ParsedDiff,
  options: BuildInlineCommentsOptions = {}
): InlineMapping {
  const lines = newSideLineHunks(diff);
  const maxComments = options.maxComments ?? Infinity;
  const comments: ReviewComment[] = [];
  const unmapped: Finding[] = [];
  const overflow: Finding[] = [];

  for (const finding of findings) {
    const fileLines = lines.get(finding.file);
    if (finding.line === undefined || !fileLines || !fileLines.has(finding.line)) {
      unmapped.push(finding);
      continue;
    }

    const endLine = finding.endLine;
    const hasRange = endLine !== undefined && endLine > finding.line;
    const canAnchorRange = hasRange ? sameHunkRange(fileLines, finding.line, endLine) : false;

    if (hasSuggestion(finding) && !canAnchorRange && (hasRange || hasMultiLineSuggestion(finding))) {
      unmapped.push(finding);
      continue;
    }

    // The volume cap (#25): findings are ranked, so the first `maxComments` keep
    // their inline comments and the rest roll into the summary's overflow section.
    if (comments.length >= maxComments) {
      overflow.push(finding);
      continue;
    }

    const comment: ReviewComment = {
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: formatFindingComment(finding, options),
      fingerprint: findingFingerprint(finding)
    };

    if (canAnchorRange && endLine !== undefined) {
      comment.start_line = finding.line;
      comment.start_side = "RIGHT";
      comment.line = endLine;
    }

    comments.push(comment);
  }

  return { comments, unmapped, overflow };
}

/**
 * Assemble the single published review: the walkthrough `summaryBody` plus
 * inline comments for the findings that anchor to the diff. Unmapped findings
 * are appended to the body with full detail so non-inline findings are not lost.
 *
 * Only blocking findings (`major`+) become inline/unmapped comments; nitpicks
 * (`minor` and below) live in the summary's collapsed nitpick section instead of
 * peppering the diff (#58).
 *
 * `agentPrompt` (default on) appends a copy-paste "Resolve with an AI agent"
 * block to every finding comment — inline and unmapped alike (#57).
 *
 * `maxInlineComments` (default {@link DEFAULT_MAX_INLINE_COMMENTS}) caps inline
 * comments so a large PR isn't carpet-bombed; ranked overflow rolls into a
 * compact severity-grouped summary section that reports the cap + count (#25).
 */
export function buildReviewPayload(input: {
  findings: Finding[];
  diff: ParsedDiff;
  summaryBody: string;
  event?: ReviewEvent;
  agentPrompt?: boolean;
  maxInlineComments?: number;
}): ReviewPayload {
  const commentOptions: FindingCommentOptions = { agentPrompt: input.agentPrompt };
  const cap = input.maxInlineComments ?? DEFAULT_MAX_INLINE_COMMENTS;
  const blocking = input.findings.filter(isBlockingFinding);
  const { comments, unmapped, overflow } = buildInlineComments(blocking, input.diff, {
    ...commentOptions,
    maxComments: cap
  });
  const withOverflow = withOverflowFindings(input.summaryBody, overflow, cap);
  return {
    body: withUnmappedFindings(withOverflow, unmapped, commentOptions),
    event: input.event ?? "COMMENT",
    comments
  };
}

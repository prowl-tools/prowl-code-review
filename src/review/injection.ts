import type { DiffFile } from "./diff-types.js";

/**
 * Prompt-injection attempt detection (backlog #14).
 *
 * The reviewer already treats all PR content as untrusted DATA and is instructed
 * to ignore instructions embedded in it (see `buildSharedSystem`/`buildVerifySystem`),
 * and the agentic tools are confined to the repo checkout. This adds the last
 * acceptance criterion: deterministically *notice* when a PR's added lines
 * contain text aimed at hijacking the reviewer, so it can be surfaced ("treated
 * as data and ignored") rather than passing silently.
 *
 * Detection is deliberately conservative — tight patterns over **added lines
 * only** — to keep false positives near zero (a security note that cries wolf is
 * worse than none). It never blocks or alters the review; it only reports.
 */

/** High-precision patterns for instructions aimed at an AI reviewer. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|preceding|earlier|system)\s+(?:instructions?|prompts?|messages?|directions?|rules?|guidelines?)\b/i,
  /\bdisregard\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|preceding|earlier|system)\b/i,
  /\bignore\s+(?:your|the)\s+(?:system\s+)?(?:instructions?|prompt|guidelines?|rules?)\b/i,
  /\byou\s+are\s+now\s+(?:a|an|the)\b/i,
  /\b(?:approve|lgtm|pass|merge)\s+this\s+(?:pr|pull\s*request|review|change|mr)\b/i,
  /\bdo\s+not\s+(?:report|flag|mention|raise|surface)\b.{0,40}\b(?:finding|issue|bug|vulnerabilit|problem|this)\b/i,
  /\b(?:instead\s+of|rather\s+than)\s+reviewing\b/i
];

/** One added line that looks like a prompt-injection attempt. */
export interface InjectionHit {
  path: string;
  /** 1-based new-side line number, when known. */
  line?: number;
}

/** True when a single line of text matches any injection pattern. */
export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Scan the **added** lines of the reviewed diff for prompt-injection attempts.
 * Returns one hit per matching added line (deduped by path+line).
 */
export function detectInjectionAttempts(files: DiffFile[]): InjectionHit[] {
  const hits: InjectionHit[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type !== "add" || !looksLikeInjection(line.content)) {
          continue;
        }
        const key = `${file.path}:${line.newLine ?? ""}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        hits.push({ path: file.path, line: line.newLine });
      }
    }
  }
  return hits;
}

/** Render an injection-detection review note, or `[]` when nothing matched (#14). */
export function injectionNotes(files: DiffFile[], maxLocations = 5): string[] {
  const hits = detectInjectionAttempts(files);
  if (hits.length === 0) {
    return [];
  }
  const locations = hits
    .slice(0, maxLocations)
    .map((hit) => (hit.line ? `${hit.path}:${hit.line}` : hit.path));
  const suffix = hits.length > locations.length ? `, +${hits.length - locations.length} more` : "";
  return [
    `Possible prompt-injection text detected in ${hits.length} added line(s) ` +
      `(${locations.join(", ")}${suffix}); treated as data and ignored — review the change's intent.`
  ];
}

import { z } from "zod";
import { extractJsonArrayCandidate } from "./json-output.js";

/**
 * Findings schema (backlog #7) — the structured output of a review pass.
 *
 * Severity-and-confidence tagged so the judge (backlog #6) can dedup, rank, and
 * threshold, and so later stages can map findings to inline comments (#10).
 */

export const SEVERITIES = ["critical", "major", "minor", "trivial", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Severity precedence — lower index is more severe (used for ranking/threshold). */
export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  trivial: 3,
  info: 4
};

export const FindingSchema = z.object({
  /** Repo-relative file path the finding applies to. */
  file: z.string().min(1),
  /** 1-based new-side line number, when the finding maps to a specific line. */
  line: z.number().int().positive().optional(),
  /** End line for a multi-line finding. */
  endLine: z.number().int().positive().optional(),
  severity: z.enum(SEVERITIES),
  /** Category (e.g. the specialist key: correctness/security/performance/tests). */
  category: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  /** Optional committable fix. */
  suggestion: z.string().optional(),
  /** Model confidence 0–1; defaults to 0.5 when the model omits it. */
  confidence: z.number().min(0).max(1).default(0.5)
});

export type Finding = z.infer<typeof FindingSchema>;

/** Return true when a parsed candidate array has at least one valid finding. */
function hasValidFindingEntry(value: unknown[]): boolean {
  return value.some((entry) => FindingSchema.safeParse(entry).success);
}

/** Cheaply reject bracketed prose before paying JSON.parse/schema-validation cost. */
function mayContainFindingEntry(json: string): boolean {
  return (
    json.includes('"file"') &&
    json.includes('"severity"') &&
    json.includes('"category"') &&
    json.includes('"title"') &&
    json.includes('"body"')
  );
}

/** A parsed review-pass response: the findings plus whether the output was recognizable (#7). */
export interface ParsedFindings {
  /** Valid findings extracted from the response. */
  findings: Finding[];
  /**
   * True when the response contained a recognizable findings array — either an
   * explicit empty array (the model genuinely found nothing) or an array with at
   * least one schema-valid finding. False means no findings array could be
   * isolated at all: the output was unparseable, so the caller should retry the
   * pass once before giving up (#7).
   */
  ok: boolean;
  /** Array entries that were present but failed schema validation (malformed). */
  invalid: number;
}

/**
 * Match a response whose only JSON content is an empty array — an explicit "no
 * findings" answer. Distinguishing this from unparseable output lets the caller
 * retry the latter without re-running a pass that legitimately found nothing.
 */
function isEmptyFindingsArray(text: string): boolean {
  return /^\[\s*\]$/.test(text.replace(/```(?:json)?/gi, "").trim());
}

/**
 * Parse a review-pass response into validated findings, reporting whether the
 * output was a recognizable findings array (#7). Tolerant of prose/markdown
 * around the JSON; invalid entries are dropped (counted in `invalid`) rather than
 * throwing, so one malformed finding doesn't sink the whole pass. Use this when
 * the caller needs to decide whether to retry; {@link parseFindings} is the thin
 * findings-only wrapper.
 */
export function parseFindingsResult(text: string): ParsedFindings {
  // An explicit empty array is a valid "no findings" answer, not a parse failure.
  if (isEmptyFindingsArray(text)) {
    return { findings: [], ok: true, invalid: 0 };
  }
  const candidate = extractJsonArrayCandidate(text, {
    acceptJson: mayContainFindingEntry,
    accept: hasValidFindingEntry
  });
  if (!candidate) {
    return { findings: [], ok: false, invalid: 0 };
  }
  const findings: Finding[] = [];
  let invalid = 0;
  for (const entry of candidate.value) {
    const result = FindingSchema.safeParse(entry);
    if (result.success) {
      findings.push(result.data);
    } else {
      invalid += 1;
    }
  }
  return { findings, ok: true, invalid };
}

/**
 * Parse a model response into validated findings. Tolerant of prose/markdown
 * around the JSON; invalid entries are dropped rather than throwing, so one
 * malformed finding doesn't sink the whole pass.
 */
export function parseFindings(text: string): Finding[] {
  return parseFindingsResult(text).findings;
}

/** Stable dedup key: same file + line + category is considered the same issue. */
export function findingKey(finding: Finding): string {
  return `${finding.file}|${finding.line ?? 0}|${finding.category.toLowerCase()}`;
}

/**
 * A finding is "blocking" when its severity is `major` or worse — i.e. a problem
 * the code actually exhibits. `minor` and below are nitpicks: surfaced in a
 * collapsed section, not as prominent/inline comments (#58).
 */
export function isBlockingFinding(finding: Finding): boolean {
  return SEVERITY_ORDER[finding.severity] <= SEVERITY_ORDER.major;
}

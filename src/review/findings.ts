import { z } from "zod";

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

/** Strip markdown code fences and isolate the outermost JSON array, if present. */
function extractJsonArray(text: string): string | null {
  const withoutFences = text.replace(/```(?:json)?/gi, "");
  const start = withoutFences.indexOf("[");
  const end = withoutFences.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  return withoutFences.slice(start, end + 1);
}

/**
 * Parse a model response into validated findings. Tolerant of prose/markdown
 * around the JSON; invalid entries are dropped rather than throwing, so one
 * malformed finding doesn't sink the whole pass.
 */
export function parseFindings(text: string): Finding[] {
  const json = extractJsonArray(text);
  if (!json) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const findings: Finding[] = [];
  for (const entry of parsed) {
    const result = FindingSchema.safeParse(entry);
    if (result.success) {
      findings.push(result.data);
    }
  }
  return findings;
}

/** Stable dedup key: same file + line + category is considered the same issue. */
export function findingKey(finding: Finding): string {
  return `${finding.file}|${finding.line ?? 0}|${finding.category.toLowerCase()}`;
}

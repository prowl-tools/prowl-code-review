import {
  type Finding,
  type Severity,
  SEVERITY_ORDER,
  findingKey
} from "./findings.js";

/**
 * Deterministic judge pass (backlog #6) + high-signal defaults (backlog #55):
 * consolidate the specialists' raw findings into one clean, ranked list: drop
 * low-severity/low-confidence noise, dedup identical issues, rank, and cap the
 * volume — so the default review is useful, not noisy.
 *
 * The skeptical "is this actually a bug?" LLM verification is a separate pass
 * (backlog #8); this layer is pure and fully testable.
 */

/** Default floor: hide `trivial`/`info` unless the caller opts in. */
export const DEFAULT_MIN_SEVERITY: Severity = "minor";
/** Default confidence floor; non-critical findings below this are dropped. */
export const DEFAULT_MIN_CONFIDENCE = 0.5;
/** Default cap on the number of findings surfaced. */
export const DEFAULT_MAX_FINDINGS = 25;

/** Pick the stronger of two duplicate findings (higher severity, then confidence). */
function preferred(a: Finding, b: Finding): Finding {
  const severityDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (severityDelta !== 0) {
    return severityDelta < 0 ? a : b;
  }
  return b.confidence > a.confidence ? b : a;
}

/** Collapse findings that share file + line + category, keeping the strongest. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = byKey.get(key);
    byKey.set(key, existing ? preferred(existing, finding) : finding);
  }
  return [...byKey.values()];
}

/** Sort by severity (most severe first), breaking ties by confidence then file. */
export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const severityDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    return findingKey(a).localeCompare(findingKey(b));
  });
}

/** Drop findings less severe than `minSeverity`. */
export function filterBySeverity(findings: Finding[], minSeverity: Severity): Finding[] {
  const floor = SEVERITY_ORDER[minSeverity];
  return findings.filter((finding) => SEVERITY_ORDER[finding.severity] <= floor);
}

/** Drop non-critical findings below `minConfidence` (criticals always kept). */
export function filterByConfidence(findings: Finding[], minConfidence: number): Finding[] {
  return findings.filter(
    (finding) => finding.severity === "critical" || finding.confidence >= minConfidence
  );
}

export interface JudgeOptions {
  /** Drop findings below this severity. Default {@link DEFAULT_MIN_SEVERITY}. */
  minSeverity?: Severity;
  /** Drop non-critical findings below this confidence. Default {@link DEFAULT_MIN_CONFIDENCE}. */
  minConfidence?: number;
  /** Cap the number of findings surfaced. Default {@link DEFAULT_MAX_FINDINGS}. */
  maxFindings?: number;
}

export interface JudgeResult {
  /** Consolidated, ranked, capped findings. */
  findings: Finding[];
  /** How many duplicates were collapsed. */
  duplicatesRemoved: number;
  /** How many findings were dropped by the severity threshold. */
  belowThreshold: number;
  /** How many findings were dropped by the confidence floor. */
  belowConfidence: number;
  /** How many findings were dropped by the volume cap. */
  capped: number;
}

function normalizeMaxFindings(value: number | undefined, available: number): number {
  const requested = value ?? DEFAULT_MAX_FINDINGS;
  if (Number.isNaN(requested)) {
    return Math.min(available, DEFAULT_MAX_FINDINGS);
  }
  if (requested === Infinity) {
    return available;
  }
  if (requested === -Infinity) {
    return 0;
  }
  return Math.min(available, Math.max(0, Math.floor(requested)));
}

/** Run the full deterministic judge: severity → confidence → dedupe → rank → cap. */
export function judgeFindings(findings: Finding[], options: JudgeOptions = {}): JudgeResult {
  const minSeverity = options.minSeverity ?? DEFAULT_MIN_SEVERITY;
  const afterSeverity = filterBySeverity(findings, minSeverity);
  const belowThreshold = findings.length - afterSeverity.length;

  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const afterConfidence = filterByConfidence(afterSeverity, minConfidence);
  const belowConfidence = afterSeverity.length - afterConfidence.length;

  const deduped = dedupeFindings(afterConfidence);
  const duplicatesRemoved = afterConfidence.length - deduped.length;

  const ranked = rankFindings(deduped);
  const maxFindings = normalizeMaxFindings(options.maxFindings, ranked.length);
  const capped = Math.max(0, ranked.length - maxFindings);

  return {
    findings: ranked.slice(0, maxFindings),
    duplicatesRemoved,
    belowThreshold,
    belowConfidence,
    capped
  };
}

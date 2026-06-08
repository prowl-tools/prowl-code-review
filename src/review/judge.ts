import {
  type Finding,
  type Severity,
  SEVERITY_ORDER,
  findingKey
} from "./findings.js";

/**
 * Deterministic judge pass (backlog #6): consolidate the specialists' raw
 * findings into one clean, ranked list — dedup identical issues, sort by
 * severity then confidence, and drop anything below a severity threshold.
 *
 * The skeptical "is this actually a bug?" LLM verification is a separate pass
 * (backlog #8); this layer is pure and fully testable.
 */

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
    return a.file.localeCompare(b.file);
  });
}

/** Drop findings less severe than `minSeverity`. */
export function filterBySeverity(findings: Finding[], minSeverity: Severity): Finding[] {
  const floor = SEVERITY_ORDER[minSeverity];
  return findings.filter((finding) => SEVERITY_ORDER[finding.severity] <= floor);
}

export interface JudgeOptions {
  /** Drop findings below this severity. Defaults to keeping everything (`info`). */
  minSeverity?: Severity;
}

export interface JudgeResult {
  /** Consolidated, ranked findings. */
  findings: Finding[];
  /** How many duplicates were collapsed. */
  duplicatesRemoved: number;
  /** How many findings were dropped by the severity threshold. */
  belowThreshold: number;
}

/** Run the full deterministic judge: dedupe → threshold → rank. */
export function judgeFindings(findings: Finding[], options: JudgeOptions = {}): JudgeResult {
  const deduped = dedupeFindings(findings);
  const duplicatesRemoved = findings.length - deduped.length;

  const minSeverity = options.minSeverity ?? "info";
  const kept = filterBySeverity(deduped, minSeverity);
  const belowThreshold = deduped.length - kept.length;

  return {
    findings: rankFindings(kept),
    duplicatesRemoved,
    belowThreshold
  };
}

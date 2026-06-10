import type { CaseResult, EvalMetrics } from "./types.js";

/**
 * Aggregate precision / recall / F1 + clean-PR false-alarm rate (backlog #13).
 *
 * Errored cases (their review pass failed) are excluded so a provider hiccup
 * can't masquerade as perfect precision. Pure — fully testable.
 */

/** Precision = matched findings / total findings; 1.0 when nothing was emitted. */
export function precision(matchedFindings: number, totalFindings: number): number {
  return totalFindings === 0 ? 1 : matchedFindings / totalFindings;
}

/** Recall = covered bugs / expected bugs; 1.0 when there were no bugs to find. */
export function recall(coveredBugs: number, expectedBugs: number): number {
  return expectedBugs === 0 ? 1 : coveredBugs / expectedBugs;
}

/** Harmonic mean of precision and recall; 0 when either is 0. */
export function f1Score(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** Reduce per-case results into the benchmark's headline metrics. */
export function aggregate(results: CaseResult[]): EvalMetrics {
  const scored = results.filter((result) => !result.errored);

  let coveredBugs = 0;
  let expectedBugs = 0;
  let matchedFindings = 0;
  let totalFindings = 0;
  let cleanCases = 0;
  let bugCases = 0;
  let cleanFindings = 0;

  for (const result of scored) {
    coveredBugs += result.coveredBugs;
    expectedBugs += result.expectedBugs;
    matchedFindings += result.matchedFindings;
    totalFindings += result.findings;
    if (result.kind === "clean") {
      cleanCases += 1;
      cleanFindings += result.findings;
    } else {
      bugCases += 1;
    }
  }

  const p = precision(matchedFindings, totalFindings);
  const r = recall(coveredBugs, expectedBugs);

  return {
    coveredBugs,
    expectedBugs,
    matchedFindings,
    totalFindings,
    precision: p,
    recall: r,
    f1: f1Score(p, r),
    cleanFalseAlarmRate: cleanCases === 0 ? 0 : cleanFindings / cleanCases,
    cleanCases,
    bugCases
  };
}

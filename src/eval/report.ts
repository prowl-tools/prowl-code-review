import type { CaseResult, EvalReport } from "./types.js";

/**
 * Eval report rendering (backlog #13).
 *
 * Pure formatters — a human-readable markdown summary for the terminal/PR, and
 * the raw JSON for storing alongside a model/prompt version so regressions are
 * diffable run-to-run.
 */

/** Format a 0–1 ratio as a fixed-width percentage. */
function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** One row of the per-case table. */
function caseRow(result: CaseResult): string {
  if (result.errored) {
    return `| ${result.id} | ${result.kind} | — | — | — | ⚠️ errored |`;
  }
  const recall = result.kind === "bug" ? `${result.coveredBugs}/${result.expectedBugs}` : "—";
  const status =
    result.kind === "clean"
      ? result.falsePositives === 0
        ? "✅ quiet"
        : `🔸 ${result.falsePositives} noise`
      : result.falseNegatives === 0 && result.falsePositives === 0
        ? "✅ clean catch"
        : `${result.coveredBugs === result.expectedBugs ? "✅" : "❌"} ${result.falsePositives} FP`;
  return `| ${result.id} | ${result.kind} | ${recall} | ${result.findings} | ${result.falsePositives} | ${status} |`;
}

/** Render review settings that affect scoring and reproducibility. */
function reviewSettings(report: EvalReport): string {
  const settings = [
    report.review.verify ? "verification on" : "verification off"
  ];
  if (report.review.minSeverity) {
    settings.push(`min severity ${report.review.minSeverity}`);
  }
  if (report.review.minConfidence !== undefined) {
    settings.push(`min confidence ${report.review.minConfidence}`);
  }
  if (report.review.maxFindings !== undefined) {
    settings.push(`max findings ${report.review.maxFindings}`);
  }
  if (report.review.verifyConfidence !== undefined) {
    settings.push(`verify confidence ${report.review.verifyConfidence}`);
  }
  return settings.join(", ");
}

/** Render the report as a markdown summary. */
export function renderReportMarkdown(report: EvalReport): string {
  const m = report.metrics;
  const lines: string[] = [
    "# prowl-review quality eval",
    "",
    `**Provider/model:** ${report.provider} / ${report.model}`,
    `**Prompt fingerprint:** \`${report.promptFingerprint}\``,
    `**Match:** ±${report.match.lineWindow} lines${report.match.requireCategory ? ", category required" : ""}`,
    `**Review:** ${reviewSettings(report)}`,
    "",
    "## Metrics",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Precision | ${pct(m.precision)} (${m.matchedFindings}/${m.totalFindings} findings) |`,
    `| Recall | ${pct(m.recall)} (${m.coveredBugs}/${m.expectedBugs} bugs) |`,
    `| F1 | ${pct(m.f1)} |`,
    `| Clean-PR false alarms | ${m.cleanFalseAlarmRate.toFixed(2)} findings/case (${m.cleanCases} clean) |`,
    `| Cases | ${m.bugCases} bug, ${m.cleanCases} clean${report.errored > 0 ? `, ${report.errored} errored` : ""} |`,
    "",
    "## Cases",
    "",
    "| Case | Kind | Bugs found | Findings | FP | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.cases.map(caseRow)
  ];
  if (report.errored > 0) {
    lines.push(
      "",
      `> ⚠️ ${report.errored} case(s) errored and were excluded from metrics — see JSON output for details.`
    );
  }
  return lines.join("\n");
}

/** Render the full report as pretty JSON for archival/diffing. */
export function renderReportJson(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

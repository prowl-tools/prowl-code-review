import { Command } from "commander";
import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { loadBenchmark } from "../../eval/load.js";
import { runBenchmark, type ReviewKnobs } from "../../eval/runner.js";
import { renderReportJson, renderReportMarkdown } from "../../eval/report.js";
import type { EvalMetrics, EvalReport } from "../../eval/types.js";
import { parseMinSeverity } from "./review.js";

/**
 * `prowl-review eval` — score the reviewer against the in-repo benchmark.
 *
 * A maintainer tool (not part of the Action): loads `bench/`, runs each case
 * through the real review pipeline using `PROWL_AI_KEY`, prints precision/
 * recall/F1 + the clean-PR false-alarm rate, and (optionally) writes the full
 * JSON report and gates on minimum thresholds so regressions fail CI.
 */

/** Resolve the benchmark directory from a flag, defaulting to `bench/` under cwd. */
export function resolveBenchDir(flag?: string): string {
  const value = flag?.trim() || "bench";
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

/** Parse and validate the optional line-match window. */
export function parseLineWindow(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid --line-window: ${value} (use a non-negative integer).`);
  }
  return parsed;
}

/** Parse and validate an optional 0–1 threshold. */
export function parseThreshold(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid ${name}: ${value} (use a number between 0 and 1).`);
  }
  return parsed;
}

export interface Thresholds {
  precision?: number;
  recall?: number;
  f1?: number;
}

/** Pure gate check: list the thresholds the run failed to meet. */
export function evaluateThresholds(metrics: EvalMetrics, thresholds: Thresholds): string[] {
  const failures: string[] = [];
  if (thresholds.precision !== undefined && metrics.precision < thresholds.precision) {
    failures.push(`precision ${(metrics.precision * 100).toFixed(1)}% < min ${(thresholds.precision * 100).toFixed(1)}%`);
  }
  if (thresholds.recall !== undefined && metrics.recall < thresholds.recall) {
    failures.push(`recall ${(metrics.recall * 100).toFixed(1)}% < min ${(thresholds.recall * 100).toFixed(1)}%`);
  }
  if (thresholds.f1 !== undefined && metrics.f1 < thresholds.f1) {
    failures.push(`F1 ${(metrics.f1 * 100).toFixed(1)}% < min ${(thresholds.f1 * 100).toFixed(1)}%`);
  }
  return failures;
}

/** Pure gate check for a full report, including errored cases excluded from metrics. */
export function evaluateGate(report: Pick<EvalReport, "metrics" | "errored">, thresholds: Thresholds): string[] {
  const failures = evaluateThresholds(report.metrics, thresholds);
  if (report.errored > 0) {
    failures.push(`${report.errored} benchmark case${report.errored === 1 ? "" : "s"} errored`);
  }
  return failures;
}

interface EvalCommandOptions {
  bench?: string;
  json?: string;
  lineWindow?: string;
  requireCategory?: boolean;
  verify?: boolean;
  minSeverity?: string;
  minPrecision?: string;
  minRecall?: string;
  minF1?: string;
}

/** Build the `eval` CLI command wired to the quality benchmark harness. */
export function buildEvalCommand(): Command {
  const command = new Command("eval");

  command
    .description("Score the reviewer against the in-repo quality benchmark")
    .option("--bench <dir>", "benchmark directory (defaults to ./bench)")
    .option("--json <path>", "write the full JSON report to this path")
    .option("--line-window <n>", "line tolerance when matching findings to bugs (default 3)")
    .option("--require-category", "require a finding's category to match the expected bug")
    .option("--no-verify", "skip the false-positive verification pass during the run")
    .option("--min-severity <severity>", "drop findings below this severity (mirrors the review default)")
    .option("--min-precision <n>", "fail if precision is below this 0–1 threshold")
    .option("--min-recall <n>", "fail if recall is below this 0–1 threshold")
    .option("--min-f1 <n>", "fail if F1 is below this 0–1 threshold")
    .action(async (options: EvalCommandOptions) => {
      const benchDir = resolveBenchDir(options.bench);
      const cases = loadBenchmark(benchDir);
      if (cases.length === 0) {
        throw new Error(`No benchmark cases found in ${benchDir}.`);
      }

      const review: ReviewKnobs = {
        verify: options.verify !== false,
        minSeverity: parseMinSeverity(options.minSeverity)
      };

      const report = await runBenchmark(cases, {
        match: {
          lineWindow: parseLineWindow(options.lineWindow),
          requireCategory: Boolean(options.requireCategory)
        },
        review
      });

      console.log(renderReportMarkdown(report));

      if (options.json) {
        const jsonPath = isAbsolute(options.json) ? options.json : resolve(process.cwd(), options.json);
        writeFileSync(jsonPath, renderReportJson(report));
        console.log(`\nWrote JSON report to ${jsonPath}`);
      }

      const failures = evaluateGate(report, {
        precision: parseThreshold(options.minPrecision, "--min-precision"),
        recall: parseThreshold(options.minRecall, "--min-recall"),
        f1: parseThreshold(options.minF1, "--min-f1")
      });
      if (failures.length > 0) {
        console.error(`\nEval gate failed: ${failures.join("; ")}`);
        process.exitCode = 1;
      }
    });

  return command;
}

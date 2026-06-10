import {
  resolveProviderConfig,
  type CompletionRequest,
  type CompletionResult,
  type ProviderConfig
} from "../providers/index.js";
import {
  runReview as defaultRunReview,
  type ReviewInput,
  type ReviewResult,
  type RunReviewOptions
} from "../review/run-review.js";
import { parseDiff } from "../review/parse-diff.js";
import { renderGuardedDiff } from "../review/render-diff.js";
import { scoreCase, erroredCase } from "./match.js";
import { aggregate } from "./metrics.js";
import { promptFingerprint } from "./version.js";
import {
  DEFAULT_LINE_WINDOW,
  type BenchmarkCase,
  type CaseResult,
  type EvalReport,
  type MatchOptions
} from "./types.js";

/**
 * Benchmark runner (backlog #13).
 *
 * Feeds each case's stored diff through the real review pipeline (#6/#8) and
 * scores the findings against the case's expected bugs. The heavy stages are
 * injectable so the harness itself is unit-testable without an LLM key: tests
 * pass a fake `complete` (or a fake `runReview`); the live eval uses the real
 * pipeline with `PROWL_AI_KEY` set.
 *
 * Cases run sequentially — deterministic ordering, and gentle on provider rate
 * limits during a real run.
 */

/** Review knobs forwarded to each pass so the eval mirrors production behaviour. */
export type ReviewKnobs = Pick<
  RunReviewOptions,
  "minSeverity" | "minConfidence" | "maxFindings" | "verify" | "verifyConfidence"
>;

export interface RunBenchmarkOptions {
  /** Provider config; resolved from the environment when omitted. */
  config?: ProviderConfig;
  /** Finding↔bug matching configuration. */
  match?: MatchOptions;
  /** Review knobs applied to every case (defaults to the pipeline defaults). */
  review?: ReviewKnobs;
  /** Injectable review pass (defaults to the real multi-pass review). */
  runReview?: (input: ReviewInput, options?: RunReviewOptions) => Promise<ReviewResult>;
  /** Injectable completion, forwarded to the real review pass. */
  complete?: (request: CompletionRequest, config: ProviderConfig) => Promise<CompletionResult>;
}

/** True when the review pipeline returned normally but no specialist pass succeeded. */
function allSpecialistPassesFailed(result: ReviewResult): boolean {
  return result.passes.length > 0 && result.passes.every((pass) => !pass.ok);
}

/** Build a compact error message from failed specialist passes. */
function failedPassMessage(result: ReviewResult): string {
  const failures = result.passes
    .filter((pass) => !pass.ok)
    .map((pass) => `${pass.specialist}${pass.error ? `: ${pass.error}` : ""}`);
  return `All review specialist passes failed: ${failures.join("; ")}`;
}

/** Run the full benchmark and return a scored, stamped report. */
export async function runBenchmark(
  cases: BenchmarkCase[],
  options: RunBenchmarkOptions = {}
): Promise<EvalReport> {
  const config = options.config ?? resolveProviderConfig();
  const review = options.runReview ?? defaultRunReview;
  const match: Required<MatchOptions> = {
    lineWindow: options.match?.lineWindow ?? DEFAULT_LINE_WINDOW,
    requireCategory: options.match?.requireCategory ?? false
  };

  const results: CaseResult[] = [];
  for (const benchmarkCase of cases) {
    try {
      // Mirror the production pipeline: parse the stored diff and feed the model
      // the same new-side line-annotated rendering, so reported line numbers are
      // comparable to a real review (and to the case's expected bug lines).
      const rendered = renderGuardedDiff(parseDiff(benchmarkCase.diff).files);
      const result = await review(
        {
          diff: rendered,
          context: benchmarkCase.context,
          guidelines: benchmarkCase.guidelines
        },
        { config, complete: options.complete, ...options.review }
      );
      if (allSpecialistPassesFailed(result)) {
        results.push(erroredCase(benchmarkCase.id, benchmarkCase.kind, failedPassMessage(result)));
        continue;
      }
      results.push(
        scoreCase(benchmarkCase.id, benchmarkCase.kind, result.findings, benchmarkCase.expected, match)
      );
    } catch (error) {
      results.push(
        erroredCase(benchmarkCase.id, benchmarkCase.kind, error instanceof Error ? error.message : String(error))
      );
    }
  }

  return {
    provider: config.provider,
    model: config.model,
    promptFingerprint: promptFingerprint(),
    match,
    metrics: aggregate(results),
    cases: results,
    errored: results.filter((result) => result.errored).length
  };
}

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
import {
  DEFAULT_MAX_FINDINGS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_SEVERITY
} from "../review/judge.js";
import { DEFAULT_VERIFY_CONFIDENCE } from "../review/verify.js";
import { parseDiff } from "../review/parse-diff.js";
import { applyDiffLimits } from "../review/size-guards.js";
import type { DiffFile, DiffLimits, SkippedFile } from "../review/diff-types.js";
import { renderGuardedDiff } from "../review/render-diff.js";
import { redactSecrets } from "../review/redact.js";
import { filterSensitiveDiffFiles } from "../review/sensitive-diff.js";
import { DEFAULT_IGNORE_GLOBS, filterIgnoredDiffFiles } from "../review/ignore.js";
import { DEFAULT_SPECIALISTS } from "../review/specialists.js";
import {
  DEFAULT_TIER_THRESHOLDS,
  diffComplexity,
  planOrchestration,
  selectRiskTier,
  type RiskTieringConfig
} from "../review/risk-tier.js";
import { scoreCase, erroredCase } from "./match.js";
import { aggregate } from "./metrics.js";
import { promptFingerprint } from "./version.js";
import {
  DEFAULT_LINE_WINDOW,
  type BenchmarkCase,
  type CaseResult,
  type EvalReport,
  type EvalRiskTierCase,
  type EvalRiskTieringSettings,
  type EvalReviewSettings,
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
  /** Diff size limits applied before rendering, mirroring the production review path. */
  diffLimits?: DiffLimits;
  /** Ignore globs applied before diff limits. Omitted -> production defaults; [] disables ignores. */
  ignore?: string[];
  /** Finding↔bug matching configuration. */
  match?: MatchOptions;
  /** Review knobs applied to every case (defaults to the pipeline defaults). */
  review?: ReviewKnobs;
  /** Risk-tiered orchestration applied per benchmark case; omitted -> production defaults. */
  riskTiering?: RiskTieringConfig;
  /** Injectable review pass (defaults to the real multi-pass review). */
  runReview?: (input: ReviewInput, options?: RunReviewOptions) => Promise<ReviewResult>;
  /** Injectable completion, forwarded to the real review pass. */
  complete?: (request: CompletionRequest, config: ProviderConfig) => Promise<CompletionResult>;
}

/** True when the review pipeline returned normally but at least one specialist failed. */
function hasSpecialistPassFailure(result: ReviewResult): boolean {
  return result.passes.some((pass) => !pass.ok);
}

/** Build a compact error message from failed specialist passes. */
function failedPassMessage(result: ReviewResult): string {
  const failures = result.passes
    .filter((pass) => !pass.ok)
    .map((pass) => `${pass.specialist}${pass.error ? `: ${pass.error}` : ""}`);
  const prefix =
    failures.length === result.passes.length
      ? "All review specialist passes failed"
      : failures.length === 1
        ? "Review specialist pass failed"
        : "Review specialist passes failed";
  return `${prefix}: ${failures.join("; ")}`;
}

/** Build a compact error message when the verification pass did not run cleanly. */
function verificationFailureMessage(result: ReviewResult): string {
  return `Review verification failed: ${result.verification.error ?? "unknown error"}`;
}

/** Fill in review defaults so report metadata fully describes the run. */
function normalizeReviewSettings(review?: ReviewKnobs): EvalReviewSettings {
  return {
    verify: review?.verify ?? true,
    minSeverity: review?.minSeverity ?? DEFAULT_MIN_SEVERITY,
    minConfidence: review?.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    maxFindings: review?.maxFindings ?? DEFAULT_MAX_FINDINGS,
    verifyConfidence: review?.verifyConfidence ?? DEFAULT_VERIFY_CONFIDENCE
  };
}

/** Fill in tier defaults so report metadata fully describes the run. */
function normalizeRiskTieringSettings(riskTiering: RiskTieringConfig = {}): EvalRiskTieringSettings {
  return {
    enabled: riskTiering.enabled !== false,
    minimal: {
      maxChangedLines: riskTiering.minimal?.maxChangedLines ?? DEFAULT_TIER_THRESHOLDS.minimal.maxChangedLines,
      maxFiles: riskTiering.minimal?.maxFiles ?? DEFAULT_TIER_THRESHOLDS.minimal.maxFiles
    },
    deep: {
      minChangedLines: riskTiering.deep?.minChangedLines ?? DEFAULT_TIER_THRESHOLDS.deep.minChangedLines,
      minFiles: riskTiering.deep?.minFiles ?? DEFAULT_TIER_THRESHOLDS.deep.minFiles
    }
  };
}

/** Reject malformed fixtures before they can score as quiet or ordinary misses. */
function validateParsedBenchmarkDiff(files: DiffFile[]): void {
  if (files.length === 0) {
    throw new Error("Invalid benchmark diff: no changed files were parsed.");
  }
  const withoutHunks = files.filter((file) => !file.binary && file.hunks.length === 0);
  if (withoutHunks.length > 0) {
    throw new Error(
      `Invalid benchmark diff: no textual hunks were parsed for ${withoutHunks
        .map((file) => file.path)
        .join(", ")}.`
    );
  }
  const withEmptyHunks = files.filter(
    (file) => !file.binary && file.hunks.some((hunk) => hunk.lines.length === 0)
  );
  if (withEmptyHunks.length > 0) {
    throw new Error(
      `Invalid benchmark diff: empty textual hunks were parsed for ${withEmptyHunks
        .map((file) => file.path)
        .join(", ")}.`
    );
  }
}

/** Ensure every expected defect remains visible after production-style guards. */
function validateExpectedFilesVisible(
  benchmarkCase: BenchmarkCase,
  files: DiffFile[],
  skipped: SkippedFile[]
): void {
  const visiblePaths = new Set(files.map((file) => file.path));
  const skippedReasons = new Map(skipped.map((file) => [file.path, file.reason]));
  const missing = [...new Set(benchmarkCase.expected.map((bug) => bug.file))]
    .filter((path) => !visiblePaths.has(path))
    .map((path) => {
      const reason = skippedReasons.get(path);
      return reason === undefined ? path : `${path} (${reason})`;
    });

  if (missing.length > 0) {
    throw new Error(`Expected bug file omitted from review input: ${missing.join(", ")}`);
  }
}

/** Reject cases where guards removed every file before review. */
function validateReviewableDiff(files: DiffFile[]): void {
  if (files.length === 0) {
    throw new Error("Invalid benchmark diff: no reviewable files remained after guards.");
  }
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
  const reviewSettings = normalizeReviewSettings(options.review);
  const riskTieringSettings = normalizeRiskTieringSettings(options.riskTiering);

  const results: CaseResult[] = [];
  const riskTierCases: EvalRiskTierCase[] = [];
  for (const benchmarkCase of cases) {
    try {
      // Mirror the production pipeline: parse the stored diff and feed the model
      // the same new-side line-annotated rendering, so reported line numbers are
      // comparable to a real review (and to the case's expected bug lines).
      const parsed = parseDiff(benchmarkCase.diff);
      validateParsedBenchmarkDiff(parsed.files);
      const safeDiff = filterSensitiveDiffFiles(parsed.files);
      const ignoredDiff = filterIgnoredDiffFiles(safeDiff.files, options.ignore ?? DEFAULT_IGNORE_GLOBS);
      const guarded = applyDiffLimits({ files: ignoredDiff.files }, options.diffLimits);
      validateExpectedFilesVisible(benchmarkCase, guarded.files, [
        ...safeDiff.skipped,
        ...ignoredDiff.skipped,
        ...guarded.skipped
      ]);
      validateReviewableDiff(guarded.files);
      const tierSelection = selectRiskTier(diffComplexity(guarded.files), options.riskTiering);
      const tierPlan = planOrchestration(tierSelection.tier);
      const specialists = tierPlan.builtinSpecialistKeys
        ? DEFAULT_SPECIALISTS.filter((s) => tierPlan.builtinSpecialistKeys!.includes(s.key))
        : undefined;
      riskTierCases.push({
        id: benchmarkCase.id,
        tier: tierSelection.tier,
        changedLines: tierSelection.changedLines,
        fileCount: tierSelection.fileCount,
        ...(specialists ? { specialistKeys: specialists.map((specialist) => specialist.key) } : {})
      });
      const rendered = renderGuardedDiff(guarded.files);
      const diff = redactSecrets(rendered).text;
      const context = benchmarkCase.context === undefined ? undefined : redactSecrets(benchmarkCase.context).text;
      const result = await review(
        {
          diff,
          context,
          guidelines: benchmarkCase.guidelines,
          specialists
        },
        { config, complete: options.complete, ...reviewSettings }
      );
      if (hasSpecialistPassFailure(result)) {
        results.push(erroredCase(benchmarkCase.id, benchmarkCase.kind, failedPassMessage(result)));
        continue;
      }
      if (!result.verification.ok) {
        results.push(erroredCase(benchmarkCase.id, benchmarkCase.kind, verificationFailureMessage(result)));
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
    review: reviewSettings,
    riskTiering: {
      settings: riskTieringSettings,
      cases: riskTierCases
    },
    metrics: aggregate(results),
    cases: results,
    errored: results.filter((result) => result.errored).length
  };
}

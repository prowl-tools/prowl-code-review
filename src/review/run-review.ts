import {
  complete as defaultComplete,
  retrying,
  emptyUsage,
  resolveProviderConfig,
  type CompletionRequest,
  type CompletionResult,
  type ProviderConfig,
  type RetryOptions,
  type TokenUsage
} from "../providers/index.js";
import { type Finding, type Severity, parseFindings } from "./findings.js";
import { judgeFindings, type JudgeResult } from "./judge.js";
import { verifyFindings, type VerifyResult } from "./verify.js";
import {
  DEFAULT_SPECIALISTS,
  buildSpecialistPrompt,
  buildSharedSystem,
  type Specialist
} from "./specialists.js";

/**
 * Multi-pass specialized review + judge/dedup (backlog #6) + false-positive
 * verification (backlog #8).
 *
 * Runs each specialist as its own pass with stable instructions in `system`
 * and untrusted PR content in `prompt`, collects structured findings, re-checks
 * blocking and low-confidence ones with a skeptical verification pass, then consolidates
 * what survives with the deterministic judge. Specialist failures degrade
 * gracefully and are reported.
 */

export interface ReviewInput {
  /** The (size-guarded) unified diff to review. */
  diff: string;
  /** Cross-file context gathered by the agentic retriever (#4), if any. */
  context?: string;
  /** Project review guidelines (CLAUDE.md / REVIEW_GUIDELINES.md), if any. */
  guidelines?: string;
  /** Specialist set; defaults to {@link DEFAULT_SPECIALISTS}. */
  specialists?: Specialist[];
  /**
   * Deterministic linter/SAST grounding (#16): findings are merged into the
   * review (deduped by the judge) and `summary` is injected into each specialist
   * prompt so the LLM reconciles with them instead of re-discovering.
   */
  grounding?: { findings: Finding[]; summary: string };
}

export interface RunReviewOptions {
  /** Provider config; resolved from the environment when omitted. */
  config?: ProviderConfig;
  /** Drop findings below this severity in the judge. Default `minor` (#55). */
  minSeverity?: Severity;
  /** Drop non-critical findings below this confidence. Default 0.5 (#55). */
  minConfidence?: number;
  /** Cap the number of findings surfaced. Default 25 (#55). */
  maxFindings?: number;
  /** Run the skeptical false-positive verification pass. Default `true` (#8). */
  verify?: boolean;
  /** Non-blocking findings at/above this confidence skip verification. Default 0.8 (#8). */
  verifyConfidence?: number;
  /** Injectable completion (defaults to the provider dispatcher, wrapped in retry). */
  complete?: (request: CompletionRequest, config: ProviderConfig) => Promise<CompletionResult>;
  /** Retry/backoff config for transient provider errors (#17). Applied to the default completion. */
  retry?: RetryOptions;
}

export interface SpecialistPassReport {
  specialist: string;
  findings: number;
  ok: boolean;
  /** Set when the pass failed. */
  error?: string;
}

export interface ReviewResult {
  /** Consolidated, ranked findings after the judge. */
  findings: Finding[];
  /** Every pre-judge finding: specialist output plus deterministic grounding. */
  raw: Finding[];
  /** Per-specialist outcome (count, ok/failed). */
  passes: SpecialistPassReport[];
  /** False-positive verification bookkeeping (#8). */
  verification: Omit<VerifyResult, "findings" | "usage">;
  /** Judge bookkeeping (dedup/threshold counts). */
  judge: Omit<JudgeResult, "findings">;
  /** Summed token usage across passes (specialists + verification). */
  usage: TokenUsage;
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens
  };
}

/** Run the multi-pass review and return consolidated findings. */
export async function runReview(
  input: ReviewInput,
  options: RunReviewOptions = {}
): Promise<ReviewResult> {
  // Default provider calls retry transient failures (#17); an injected `complete`
  // is used as-is (tests/consumers control their own retry). `run` is reused for
  // both specialist passes and the verification pass, so both get resilience.
  const run = options.complete ?? retrying(defaultComplete, options.retry);
  const baseConfig = options.config ?? resolveProviderConfig();
  const specialists = input.specialists ?? DEFAULT_SPECIALISTS;

  // Shared, byte-identical trusted instructions; untrusted PR content stays in prompt.
  const system = buildSharedSystem({
    guidelines: input.guidelines
  });

  const outcomes = await Promise.all(
    specialists.map(async (specialist): Promise<{ report: SpecialistPassReport; findings: Finding[]; usage: TokenUsage }> => {
      const config = specialist.model ? { ...baseConfig, model: specialist.model } : baseConfig;
      try {
        const result = await run({
          system,
          prompt: buildSpecialistPrompt({
            specialist,
            diff: input.diff,
            context: input.context,
            grounding: input.grounding?.summary
          })
        }, config);
        const findings = parseFindings(result.text).map((finding) => ({
          ...finding,
          category: finding.category || specialist.key
        }));
        return {
          report: { specialist: specialist.key, findings: findings.length, ok: true },
          findings,
          usage: result.usage
        };
      } catch (error) {
        return {
          report: {
            specialist: specialist.key,
            findings: 0,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          },
          findings: [],
          usage: emptyUsage()
        };
      }
    })
  );

  // Merge deterministic linter findings (#16) in with the specialists' raw
  // findings; the judge dedups them against any the LLM re-discovered.
  const raw = [...outcomes.flatMap((outcome) => outcome.findings), ...(input.grounding?.findings ?? [])];
  let usage = outcomes.reduce((total, outcome) => addUsage(total, outcome.usage), emptyUsage());

  // Skeptical false-positive pass (#8): re-check blocking (inline-posted) and
  // low-confidence findings before the judge so confirmed bugs survive and
  // false positives — even confident ones — are dropped.
  const verification =
    options.verify === false
      ? {
          findings: raw,
          verified: 0,
          droppedFalsePositive: 0,
          demoted: 0,
          unverified: 0,
          ok: true,
          usage: emptyUsage()
        }
      : await verifyFindings(
          raw,
          { diff: input.diff, context: input.context },
          { config: baseConfig, complete: run, verifyConfidence: options.verifyConfidence }
        );
  usage = addUsage(usage, verification.usage);
  const verificationReport = {
    verified: verification.verified,
    droppedFalsePositive: verification.droppedFalsePositive,
    demoted: verification.demoted,
    unverified: verification.unverified,
    ok: verification.ok,
    error: verification.error
  };

  const { findings, ...judge } = judgeFindings(verification.findings, {
    minSeverity: options.minSeverity,
    minConfidence: options.minConfidence,
    maxFindings: options.maxFindings
  });

  return {
    findings,
    raw,
    passes: outcomes.map((outcome) => outcome.report),
    verification: verificationReport,
    judge,
    usage
  };
}

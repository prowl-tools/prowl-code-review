import {
  complete as defaultComplete,
  emptyUsage,
  resolveProviderConfig,
  type CompletionRequest,
  type CompletionResult,
  type ProviderConfig,
  type TokenUsage
} from "../providers/index.js";
import { type Finding, type Severity, parseFindings } from "./findings.js";
import { judgeFindings, type JudgeResult } from "./judge.js";
import {
  DEFAULT_SPECIALISTS,
  buildSpecialistPrompt,
  buildSharedSystem,
  type Specialist
} from "./specialists.js";

/**
 * Multi-pass specialized review + judge/dedup (backlog #6).
 *
 * Runs each specialist as its own pass with stable instructions in `system`
 * and untrusted PR content in `prompt`, collects structured findings, then consolidates them with the
 * deterministic judge. Specialist failures degrade gracefully and are reported.
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
}

export interface RunReviewOptions {
  /** Provider config; resolved from the environment when omitted. */
  config?: ProviderConfig;
  /** Drop findings below this severity in the judge. Default keeps all. */
  minSeverity?: Severity;
  /** Injectable completion (defaults to the provider dispatcher). */
  complete?: (request: CompletionRequest, config: ProviderConfig) => Promise<CompletionResult>;
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
  /** Every raw finding the specialists produced (pre-judge). */
  raw: Finding[];
  /** Per-specialist outcome (count, ok/failed). */
  passes: SpecialistPassReport[];
  /** Judge bookkeeping (dedup/threshold counts). */
  judge: Omit<JudgeResult, "findings">;
  /** Summed token usage across passes. */
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
  const run = options.complete ?? defaultComplete;
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
            context: input.context
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

  const raw = outcomes.flatMap((outcome) => outcome.findings);
  const usage = outcomes.reduce((total, outcome) => addUsage(total, outcome.usage), emptyUsage());
  const { findings, ...judge } = judgeFindings(raw, { minSeverity: options.minSeverity });

  return {
    findings,
    raw,
    passes: outcomes.map((outcome) => outcome.report),
    judge,
    usage
  };
}

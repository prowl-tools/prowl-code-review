import {
  complete as defaultComplete,
  retrying,
  withFailback,
  emptyUsage,
  resolveProviderConfig,
  type CompletionRequest,
  type CompletionResult,
  type FailbackOptions,
  type ProviderConfig,
  type RetryOptions,
  type TokenUsage
} from "../providers/index.js";
import { type Finding, type Severity, SEVERITY_ORDER, parseFindingsResult } from "./findings.js";
import { judgeFindings, type JudgeResult } from "./judge.js";
import { verifyFindings, type VerifyResult } from "./verify.js";
import { totalTokens } from "../cost/pricing.js";
import {
  DEFAULT_SPECIALISTS,
  REQUIREMENTS_SPECIALIST,
  REQUIREMENTS_SPECIALIST_KEY,
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
  /** Learned false-positive patterns (LEARNED_PATTERNS.md), if any (#30). */
  learnedPatterns?: string;
  /** Human labels of languages this PR changes, for language-aware review (#5). */
  languages?: string[];
  /**
   * Linked-issue requirements / acceptance criteria (#32). When present, a
   * conditional requirements lens runs in addition to the configured specialists
   * and flags acceptance criteria the diff does not satisfy.
   */
  requirements?: string;
  /**
   * Optional full guarded PR diff for requirements validation. Incremental
   * re-reviews keep normal lenses on the delta while requirements are checked
   * against the full PR surface.
   */
  requirementsDiff?: string;
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
  /** Token budget (#18): when the specialist passes have already spent it, skip verification. */
  maxTokens?: number;
  /** Injectable completion (defaults to the provider dispatcher, wrapped in retry). */
  complete?: (request: CompletionRequest, config: ProviderConfig) => Promise<CompletionResult>;
  /** Retry/backoff config for transient provider errors (#17). Applied to the default completion. */
  retry?: RetryOptions;
  /**
   * Cross-generation failback (#17): on retryable exhaustion, retry with an older
   * same-family model. Wraps whichever completion is in use (the default retried
   * completion or an injected `complete`). Omitted → no failback.
   */
  failback?: FailbackOptions;
}

export interface SpecialistPassReport {
  specialist: string;
  findings: number;
  ok: boolean;
  /** True when the pass was retried once because its first output was unparseable (#7). */
  retried?: boolean;
  /** Set when the pass failed. */
  error?: string;
}

export interface ReviewResult {
  /** Consolidated, ranked findings after the judge. */
  findings: Finding[];
  /** Consolidated, ranked findings before the final volume cap. */
  uncappedFindings?: Finding[];
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
  const cacheWriteInputTokens = (a.cacheWriteInputTokens ?? 0) + (b.cacheWriteInputTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    ...(cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {})
  };
}

/**
 * Run one specialist pass, retrying once if the model's output isn't a parseable
 * findings array (#7). An explicit empty array counts as a valid "no findings"
 * result and is not retried; only genuinely unparseable output is. Both attempts'
 * token usage is summed. `ok: false` means even the retry was unparseable — the
 * caller reports the pass as degraded rather than silently treating it as empty.
 */
async function runSpecialistPass(
  run: (request: CompletionRequest, config: ProviderConfig) => Promise<CompletionResult>,
  request: CompletionRequest,
  config: ProviderConfig
): Promise<{ findings: Finding[]; ok: boolean; retried: boolean; usage: TokenUsage }> {
  const first = await run(request, config);
  let parsed = parseFindingsResult(first.text);
  let usage = first.usage;
  let retried = false;
  if (!parsed.ok) {
    retried = true;
    const second = await run(request, config);
    usage = addUsage(usage, second.usage);
    const retryParsed = parseFindingsResult(second.text);
    if (retryParsed.ok) {
      parsed = retryParsed;
    }
  }
  return { findings: parsed.findings, ok: parsed.ok, retried, usage };
}

/** Run the multi-pass review and return consolidated findings. */
export async function runReview(
  input: ReviewInput,
  options: RunReviewOptions = {}
): Promise<ReviewResult> {
  // Default provider calls retry transient failures (#17); an injected `complete`
  // is used as-is for retry (tests/consumers control that). `run` is reused for
  // both specialist passes and the verification pass, so both get resilience —
  // and cross-generation failback (#17) wraps either when configured.
  const base = options.complete ?? retrying(defaultComplete, options.retry);
  const run = options.failback ? withFailback(base, options.failback) : base;
  const baseConfig = options.config ?? resolveProviderConfig();
  const configuredSpecialists = input.specialists ?? DEFAULT_SPECIALISTS;
  const activeRequirements = input.requirements?.trim() ? input.requirements : undefined;
  const activeRequirementsDiff = activeRequirements ? input.requirementsDiff ?? input.diff : undefined;
  // Issue/ticket validation (#32): when the PR links an issue, append the
  // requirements lens (with the acceptance criteria supplied in its prompt) so
  // it runs alongside the configured specialists regardless of risk tier.
  const specialists = activeRequirements
    ? [...configuredSpecialists, REQUIREMENTS_SPECIALIST]
    : configuredSpecialists;

  // Shared, byte-identical trusted instructions; untrusted PR content stays in prompt.
  const system = buildSharedSystem({
    guidelines: input.guidelines,
    learnedPatterns: input.learnedPatterns,
    languages: input.languages
  });

  const outcomes = await Promise.all(
    specialists.map(async (specialist): Promise<{ report: SpecialistPassReport; findings: Finding[]; usage: TokenUsage }> => {
      const config = specialist.model ? { ...baseConfig, model: specialist.model } : baseConfig;
      try {
        const specialistDiff =
          specialist.key === REQUIREMENTS_SPECIALIST_KEY && activeRequirementsDiff
            ? activeRequirementsDiff
            : input.diff;
        const pass = await runSpecialistPass(
          run,
          {
            system,
            prompt: buildSpecialistPrompt({
              specialist,
              diff: specialistDiff,
              context: input.context,
              grounding: input.grounding?.summary,
              // Only the requirements lens receives the linked-issue criteria (#32).
              requirements: specialist.key === REQUIREMENTS_SPECIALIST_KEY ? activeRequirements : undefined
            }),
            // Native JSON output where the provider supports it (#7).
            responseFormat: "json"
          },
          config
        );
        // Specialist passes own their category; keep custom reviewer buckets stable
        // even when the model emits a natural category like "security".
        const mapped = pass.findings.map((finding) => ({
          ...finding,
          category: specialist.key
        }));
        // Per-reviewer severity floor (#51): drop this lens's below-floor findings
        // before the judge so a high-signal-only custom reviewer stays quiet.
        const findings = specialist.severityFloor
          ? mapped.filter(
              (finding) => SEVERITY_ORDER[finding.severity] <= SEVERITY_ORDER[specialist.severityFloor!]
            )
          : mapped;
        return {
          report: {
            specialist: specialist.key,
            findings: pass.ok ? findings.length : 0,
            ok: pass.ok,
            ...(pass.retried ? { retried: true } : {}),
            ...(pass.ok ? {} : { error: "Pass output was not parseable JSON after one retry." })
          },
          // An unparseable pass contributes no findings and is reported as degraded.
          findings: pass.ok ? findings : [],
          usage: pass.usage
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
  // false positives — even confident ones — are dropped. Skipped when the token
  // budget (#18) is already spent by the specialist passes.
  const budgetSpent = options.maxTokens !== undefined && totalTokens(usage) >= options.maxTokens;
  const skipVerification = options.verify === false || budgetSpent;
  const verification = skipVerification
    ? {
        findings: raw,
        verified: 0,
        droppedFalsePositive: 0,
        demoted: 0,
        unverified: 0,
        ok: true,
        usage: emptyUsage(),
        skippedForBudget: budgetSpent || undefined
      }
    : await verifyFindings(
        raw,
        { diff: activeRequirementsDiff ?? input.diff, context: input.context, requirements: activeRequirements },
        { config: baseConfig, complete: run, verifyConfidence: options.verifyConfidence }
      );
  usage = addUsage(usage, verification.usage);
  const verificationReport = {
    verified: verification.verified,
    droppedFalsePositive: verification.droppedFalsePositive,
    demoted: verification.demoted,
    unverified: verification.unverified,
    ok: verification.ok,
    error: verification.error,
    skippedForBudget: verification.skippedForBudget
  };

  const judged = judgeFindings(verification.findings, {
    minSeverity: options.minSeverity,
    minConfidence: options.minConfidence,
    maxFindings: options.maxFindings
  });
  const uncappedFindings =
    judged.capped > 0
      ? judgeFindings(verification.findings, {
          minSeverity: options.minSeverity,
          minConfidence: options.minConfidence,
          maxFindings: Infinity
        }).findings
      : judged.findings;
  const { findings, ...judge } = judged;

  return {
    findings,
    uncappedFindings,
    raw,
    passes: outcomes.map((outcome) => outcome.report),
    verification: verificationReport,
    judge,
    usage
  };
}

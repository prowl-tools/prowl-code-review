import {
  emptyUsage,
  type ProviderConfig,
  type ProviderName,
  type TokenUsage
} from "../providers/index.js";
import {
  runReview as defaultRunReview,
  type ReviewInput,
  type ReviewResult,
  type RunReviewOptions,
  type SpecialistPassReport
} from "./run-review.js";
import { judgeEnsembleFindings } from "./judge.js";
import type { Finding } from "./findings.js";

/**
 * Multi-provider ensemble review (backlog #53).
 *
 * Runs the same shared review input (diff + cross-file context #4 + linter/SAST
 * grounding #16, all computed once by the pipeline) through `runReview` (#6) for
 * each configured provider **in parallel**, pools the findings tagged by source
 * provider, and consolidates them with the cross-provider judge — recording
 * provenance and boosting confidence on agreement (#53). Cross-provider
 * agreement is itself a verification signal, complementing the skeptical pass
 * (#8).
 *
 * Each provider's own judge floors are disabled here so all of its findings reach
 * the cross-judge; the real severity/confidence/volume floors are applied once,
 * after the consensus boost, so a finding several providers agree on can survive
 * even if each scored it just under the threshold. A provider that errors
 * degrades gracefully and is reported — the ensemble still consolidates the rest.
 */

export interface EnsembleProviderReport {
  provider: ProviderName;
  model: string;
  ok: boolean;
  /** Findings this provider contributed to the pool (pre cross-judge). */
  findings: number;
  /** Token usage for this provider's review pass, preserved for mixed-provider cost estimates. */
  usage?: TokenUsage;
  error?: string;
}

export interface EnsembleReviewResult extends ReviewResult {
  /** Per-provider outcome for logging/notes (#53). */
  providers: EnsembleProviderReport[];
}

export interface RunEnsembleOptions {
  /** Provider configs to fan out across (≥2 expected; the pipeline guards this). */
  configs: ProviderConfig[];
  /** Final cross-judge floors (applied after the consensus boost). */
  minSeverity?: RunReviewOptions["minSeverity"];
  minConfidence?: RunReviewOptions["minConfidence"];
  maxFindings?: RunReviewOptions["maxFindings"];
  /** Forwarded to each provider's pass. */
  verify?: RunReviewOptions["verify"];
  verifyConfidence?: RunReviewOptions["verifyConfidence"];
  /** Total review token budget (#18); split evenly across providers so the sum stays within it. */
  maxTokens?: number;
  /** Retry/backoff config forwarded to each provider's pass (#17). */
  retry?: RunReviewOptions["retry"];
  /** Injectable single-provider review (defaults to {@link defaultRunReview}). */
  runReview?: typeof defaultRunReview;
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
 * Tag every finding with the provider that raised it (#53 provenance) and seed
 * its single-provider perspective, so the cross-judge can preserve each model's
 * own take when it consolidates duplicates.
 */
function tagSources(findings: Finding[], provider: ProviderName): Finding[] {
  return findings.map((finding) => ({
    ...finding,
    sources: [provider],
    perspectives: [
      {
        provider,
        severity: finding.severity,
        confidence: finding.confidence,
        title: finding.title,
        body: finding.body
      }
    ]
  }));
}

function findingSignature(finding: Finding): string {
  // Verification may rewrite confidence; grounding identity should only use
  // stable finding fields so deterministic findings stay out of provenance.
  return JSON.stringify({
    file: finding.file,
    line: finding.line,
    endLine: finding.endLine,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    body: finding.body,
    suggestion: finding.suggestion
  });
}

function excludeGroundingFindings(findings: Finding[], groundingSignatures: Set<string>): Finding[] {
  if (groundingSignatures.size === 0) {
    return findings;
  }
  return findings.filter((finding) => !groundingSignatures.has(findingSignature(finding)));
}

function withoutSources(finding: Finding): Finding {
  const copy = { ...finding };
  delete copy.sources;
  return copy;
}

/** Run the ensemble: fan out per provider, pool, and cross-judge with provenance. */
export async function runEnsembleReview(
  input: ReviewInput,
  options: RunEnsembleOptions
): Promise<EnsembleReviewResult> {
  const review = options.runReview ?? defaultRunReview;
  const configs = options.configs;
  // Split the per-review budget so the sum across providers stays within #18.
  const perProviderMaxTokens =
    options.maxTokens === undefined ? undefined : Math.floor(options.maxTokens / Math.max(1, configs.length));

  const outcomes = await Promise.all(
    configs.map(async (config) => {
      try {
        const result = await review(input, {
          config,
          // Defer all floors to the cross-judge so consensus can rescue findings.
          minSeverity: "info",
          minConfidence: 0,
          maxFindings: Infinity,
          verify: options.verify,
          verifyConfidence: options.verifyConfidence,
          maxTokens: perProviderMaxTokens,
          retry: options.retry
        });
        return { config, result, error: undefined as string | undefined };
      } catch (error) {
        return { config, result: undefined, error: error instanceof Error ? error.message : String(error) };
      }
    })
  );

  const pooled: Finding[] = [];
  const pooledRaw: Finding[] = [];
  const passes: SpecialistPassReport[] = [];
  const providers: EnsembleProviderReport[] = [];
  const groundingFindings = input.grounding?.findings ?? [];
  const groundingSignatures = new Set(groundingFindings.map((finding) => findingSignature(finding)));
  const survivingGrounding = new Map<string, Finding>();
  let usage = emptyUsage();
  let verified = 0;
  let droppedFalsePositive = 0;
  let demoted = 0;
  let unverified = 0;
  let verificationOk = true;
  let verificationError: string | undefined;
  let skippedForBudget: boolean | undefined;

  for (const { config, result, error } of outcomes) {
    if (!result) {
      providers.push({ provider: config.provider, model: config.model, ok: false, findings: 0, error });
      passes.push({
        specialist: `${config.provider}`,
        findings: 0,
        ok: false,
        error: error ?? "Provider review failed."
      });
      continue;
    }
    for (const finding of result.findings) {
      const signature = findingSignature(finding);
      if (!groundingSignatures.has(signature)) {
        continue;
      }
      const existing = survivingGrounding.get(signature);
      if (!existing || finding.confidence > existing.confidence) {
        survivingGrounding.set(signature, withoutSources(finding));
      }
    }
    const providerFindings = excludeGroundingFindings(result.findings, groundingSignatures);
    const providerRaw = excludeGroundingFindings(result.raw, groundingSignatures);
    const tagged = tagSources(providerFindings, config.provider);
    pooled.push(...tagged);
    pooledRaw.push(...tagSources(providerRaw, config.provider));
    usage = addUsage(usage, result.usage);
    verified += result.verification.verified;
    droppedFalsePositive += result.verification.droppedFalsePositive;
    demoted += result.verification.demoted;
    unverified += result.verification.unverified;
    verificationOk = verificationOk && result.verification.ok;
    verificationError = verificationError ?? result.verification.error;
    skippedForBudget = skippedForBudget ?? result.verification.skippedForBudget;
    // Namespace each provider's pass so degradation notes name the provider.
    for (const pass of result.passes) {
      passes.push({ ...pass, specialist: `${config.provider}:${pass.specialist}` });
    }
    providers.push({
      provider: config.provider,
      model: config.model,
      ok: true,
      findings: tagged.length,
      usage: result.usage
    });
  }
  const verifiedGroundingFindings = groundingFindings
    .map((finding) => survivingGrounding.get(findingSignature(finding)))
    .filter((finding): finding is Finding => Boolean(finding));
  pooled.push(...verifiedGroundingFindings);
  pooledRaw.push(...groundingFindings);

  const judged = judgeEnsembleFindings(pooled, {
    minSeverity: options.minSeverity,
    minConfidence: options.minConfidence,
    maxFindings: options.maxFindings
  });
  const uncappedFindings =
    judged.capped > 0
      ? judgeEnsembleFindings(pooled, {
          minSeverity: options.minSeverity,
          minConfidence: options.minConfidence,
          maxFindings: Infinity
        }).findings
      : judged.findings;
  const { findings, ...judge } = judged;

  return {
    findings,
    uncappedFindings,
    raw: pooledRaw,
    passes,
    verification: {
      verified,
      droppedFalsePositive,
      demoted,
      unverified,
      ok: verificationOk,
      error: verificationError,
      skippedForBudget
    },
    judge,
    usage,
    providers
  };
}

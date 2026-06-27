import type { OctokitLike } from "./github/client.js";
import {
  fetchPullRequest as defaultFetchPullRequest,
  fetchComparisonDiff as defaultFetchComparisonDiff,
  fetchPullRequestHeadSha as defaultFetchPullRequestHeadSha,
  fetchPullRequestMeta as defaultFetchPullRequestMeta,
  updatePullRequestBody as defaultUpdatePullRequestBody,
  type FetchedPullRequest,
  type PullRequestMeta,
  type PullRequestRef
} from "./github/diff.js";
import {
  generatePrDescription as defaultGeneratePrDescription,
  shouldDescribePr,
  embedPrDescription
} from "./review/pr-description.js";
import { parseIssueReferences, formatIssueRef } from "./review/issue-refs.js";
import { fetchIssue as defaultFetchIssue, type FetchedIssue } from "./github/issues.js";
import {
  submitReview as defaultSubmitReview,
  fetchPriorReviewState as defaultFetchPriorReviewState,
  hasActiveRequestChanges as defaultHasActiveRequestChanges,
  type SubmitReviewOptions,
  type SubmitReviewResult,
  type PriorRequestChangesState
} from "./github/review.js";
import {
  planCheckRun,
  submitCheckRun as defaultSubmitCheckRun,
  type CheckRunPlan,
  type CheckConclusion
} from "./github/check-run.js";
import { detectBreakGlass as defaultDetectBreakGlass } from "./github/break-glass.js";
import {
  fetchReviewThreads as defaultFetchReviewThreads,
  resolveReviewThread as defaultResolveReviewThread,
  planThreadActions,
  type ReviewThread,
  type ThreadActionPlan
} from "./github/threads.js";
import { findingFingerprint } from "./review/state.js";
import {
  planApprovalDecision,
  approvalNotes,
  type ApprovalConfig,
  type ApprovalDecision,
  type BreakGlassSignal
} from "./review/approval.js";
import type { ReviewState } from "./review/state.js";
import { parseDiff } from "./review/parse-diff.js";
import { applyDiffLimits } from "./review/size-guards.js";
import type { DiffFile, DiffLimits, SkippedFile } from "./review/diff-types.js";
import { renderGuardedDiff } from "./review/render-diff.js";
import {
  ContextRetrievalError,
  gatherContext as defaultGatherContext,
  type GatherContextParams,
  type GatheredContext,
  type RetrievalLimits
} from "./context/retrieval.js";
import { runReview as defaultRunReview, type ReviewResult, type ReviewInput, type RunReviewOptions } from "./review/run-review.js";
import {
  runEnsembleReview as defaultRunEnsembleReview,
  type EnsembleReviewResult,
  type EnsembleProviderReport,
  type RunEnsembleOptions
} from "./review/ensemble.js";
import { DEFAULT_SPECIALISTS, type Specialist } from "./review/specialists.js";
import { summarizeLanguages } from "./review/language.js";
import {
  diffComplexity,
  selectRiskTier,
  planOrchestration,
  type RiskTier,
  type RiskTieringConfig
} from "./review/risk-tier.js";
import {
  gatherGrounding as defaultGatherGrounding,
  buildGroundingSummary,
  dependencyScanTargets,
  type GatherGroundingParams,
  type GroundingResult,
  type GroundingLimits,
  type DependencyScanOptions,
  type SemgrepOptions
} from "./grounding/index.js";
import { buildWalkthrough } from "./review/walkthrough.js";
import { buildReviewPayload, type ReviewEvent, type ReviewPayload } from "./review/inline.js";
import { summarizeSuggestionGating, DEFAULT_SUGGESTION_MIN_CONFIDENCE } from "./review/suggestions.js";
import {
  emptyUsage,
  resolveProviderConfig,
  type FailbackEvent,
  type FailbackOptions,
  type ProviderConfig,
  type RetryOptions,
  type TokenUsage
} from "./providers/index.js";
import type { Finding, Severity } from "./review/findings.js";
import { redactSecrets } from "./review/redact.js";
import { filterSensitiveDiffFiles } from "./review/sensitive-diff.js";
import { filterIgnoredDiffFiles, DEFAULT_IGNORE_GLOBS } from "./review/ignore.js";
import { injectionNotes } from "./review/injection.js";
import { totalTokens } from "./cost/pricing.js";
import type { DebugSink } from "./debug/trace.js";

/**
 * End-to-end PR review pipeline (backlog #11): fetch → parse → sensitivity
 * filter → ignore filter → size-guard → agentic context → multi-pass review +
 * judge → walkthrough → publish.
 *
 * Heavy stages are injectable so the orchestration is unit-testable without a
 * live provider or GitHub.
 */

/** Injectable pipeline stages (default to the library implementations). */
export interface PipelineDeps {
  fetchPullRequest?: (octokit: OctokitLike, ref: PullRequestRef) => Promise<FetchedPullRequest>;
  /** Fetch current PR metadata without downloading the diff, used for final body/head checks (#33). */
  fetchPullRequestMeta?: (octokit: OctokitLike, ref: PullRequestRef) => Promise<PullRequestMeta>;
  /** Load prior persisted review state to find the last reviewed SHA (#23). */
  fetchPriorState?: (octokit: OctokitLike, ref: PullRequestRef) => Promise<ReviewState | null>;
  /** Fetch the raw delta diff between two commits for incremental re-review (#23). */
  fetchComparisonDiff?: (
    octokit: OctokitLike,
    ref: PullRequestRef,
    base: string,
    head: string
  ) => Promise<string>;
  gatherContext?: (params: GatherContextParams) => Promise<GatheredContext>;
  runReview?: (input: ReviewInput, options?: RunReviewOptions) => Promise<ReviewResult>;
  /** Multi-provider ensemble review (#53); used when ≥2 provider configs are resolved. */
  runEnsembleReview?: (input: ReviewInput, options: RunEnsembleOptions) => Promise<EnsembleReviewResult>;
  gatherGrounding?: (params: GatherGroundingParams) => Promise<GroundingResult>;
  submitReview?: (
    octokit: OctokitLike,
    ref: PullRequestRef,
    payload: ReviewPayload,
    options?: SubmitReviewOptions
  ) => Promise<SubmitReviewResult | void>;
  /** Publish the merge-gate Check Run (#24). */
  submitCheckRun?: (
    octokit: OctokitLike,
    ref: PullRequestRef,
    input: { headSha: string; plan: CheckRunPlan; name?: string }
  ) => Promise<void>;
  /** Detect a `@prowl-review break glass <head-sha>` override for the approval gate (#52). */
  detectBreakGlass?: (
    octokit: OctokitLike,
    ref: PullRequestRef,
    options?: { botLogin?: string; createdAfter?: string; headSha?: string }
  ) => Promise<BreakGlassSignal>;
  /** Detect whether prowl-review has an active prior request-changes review (#52). */
  detectPriorRequestChanges?: (octokit: OctokitLike, ref: PullRequestRef) => Promise<PriorRequestChangesState>;
  /** List prowl-review's prior review threads for tidy-up (#22). */
  fetchReviewThreads?: (octokit: OctokitLike, ref: PullRequestRef, botLogin?: string) => Promise<ReviewThread[]>;
  /** Resolve a single review thread via GraphQL (#22). */
  resolveReviewThread?: (octokit: OctokitLike, threadId: string) => Promise<boolean>;
  /** Re-fetch the PR's current head SHA for the stale-publish guard (#21). */
  fetchHeadSha?: (octokit: OctokitLike, ref: PullRequestRef) => Promise<string | undefined>;
  /** Generate a PR description from the diff (#33). */
  generatePrDescription?: typeof defaultGeneratePrDescription;
  /** Write the generated description back to the PR body (#33). */
  updatePullRequestBody?: (octokit: OctokitLike, ref: PullRequestRef, body: string) => Promise<void>;
  /** Fetch a linked issue's content for issue/ticket validation (#32). */
  fetchIssue?: typeof defaultFetchIssue;
}

export interface ReviewPullRequestOptions {
  config?: ProviderConfig;
  /**
   * Multi-provider ensemble review (#53). When `configs` has ≥2 entries the
   * review step fans out across them (shared context + grounding, run once) and
   * consolidates findings with cross-provider provenance. Resolved by the CLI
   * from `ensemble` config + per-provider env keys. Omitted/single → normal review.
   */
  ensemble?: { configs: ProviderConfig[] };
  /**
   * Auto-generate a PR description from the diff (#33). Opt-in. When enabled and
   * the PR body is empty (or already holds prowl-review's generated block), the
   * pipeline writes/refreshes a summary in the PR body; a human-authored body is
   * never overwritten.
   */
  prDescription?: { enabled?: boolean };
  /**
   * Issue/ticket validation (#32). Opt-in. When enabled and the PR links a GitHub
   * issue, the pipeline fetches the issue's acceptance criteria and a requirements
   * lens flags any the diff doesn't satisfy.
   */
  issueValidation?: { enabled?: boolean; maxIssues?: number };
  /**
   * Cross-generation failback (#17). Opt-in. When true, a review pass that keeps
   * hitting retryable/overload errors after retries falls back to an older model
   * of the same family before failing; each failback is surfaced as a review note.
   */
  failback?: boolean;
  /**
   * Retry/backoff config for the review passes (#17). Mainly used to wire an
   * `onRetry` hook for heartbeat/progress logging; omitted → built-in defaults.
   */
  retry?: RetryOptions;
  /** Repo checkout root for agentic context; context is skipped if unset. */
  toolkitRoot?: string;
  /**
   * Glob patterns for generated/vendored files to skip (#19). Omitted →
   * {@link DEFAULT_IGNORE_GLOBS}; an explicit list (including `[]`) replaces them.
   */
  ignore?: string[];
  diffLimits?: DiffLimits;
  contextLimits?: RetrievalLimits;
  minSeverity?: Severity;
  /** Drop non-critical findings below this confidence (default 0.5, #55). */
  minConfidence?: number;
  /** Cap the number of findings surfaced (default 25, #55). */
  maxFindings?: number;
  /** Cap inline comments per review; overflow rolls into the summary (default 20, #25). */
  maxInlineComments?: number;
  /**
   * Suggested-fix validation (#39): only render a committable `suggestion` block
   * for findings at/above `minConfidence` (default 0.8) that pass structural
   * validation. Lower-confidence fixes stay in the agent prompt, not one-click.
   */
  suggestions?: { minConfidence?: number };
  /**
   * Per-review token budget (#18): caps agentic context retrieval and skips the
   * verification pass once spent; the over-budget total is reported. Resolved
   * from `budget.maxTokens`/`maxUsd` by the CLI. Specialist passes still run.
   */
  budgetTokens?: number;
  /**
   * Specialist set for the multi-pass review (#51): built-ins (minus any toggled
   * off) plus custom reviewers. Omitted → the built-in {@link DEFAULT_SPECIALISTS}.
   */
  specialists?: Specialist[];
  /**
   * Risk-tiered orchestration (#31): scale pass count + context to diff size.
   * Omitted → enabled with built-in thresholds; `{ enabled: false }` disables it.
   */
  riskTiering?: RiskTieringConfig;
  /**
   * Incremental re-review (#23): on a re-run, review only the delta since the last
   * reviewed SHA (from prior state) instead of the whole PR. Default on; set false
   * to always review the full PR diff. Falls back to a full review when there's no
   * prior SHA or the delta can't be computed (e.g. after a force-push).
   */
  incremental?: boolean;
  /** Run the skeptical false-positive verification pass (default true, #8). */
  verify?: boolean;
  /** Findings at/above this confidence skip verification (default 0.8, #8). */
  verifyConfidence?: number;
  guidelines?: string;
  /** Learned false-positive patterns (LEARNED_PATTERNS.md) injected into prompts (#30). */
  learnedPatterns?: string;
  /**
   * Merge gate via the Checks API (#24). Opt-in (needs `checks: write`). With
   * `failOn` set, findings at/above that severity make the check fail; omitted →
   * an informational (neutral) check.
   */
  checkRun?: { enabled?: boolean; failOn?: Severity };
  /**
   * Approval rubric + break-glass override (#52). Opt-in (`approval.enabled`).
   * When engaged, the findings map to the published review event (and the #24
   * check conclusion); a trusted `@prowl-review break glass <head-sha>` comment overrides a
   * request-changes into an approval. Omitted/disabled → the review only comments.
   */
  approval?: ApprovalConfig;
  /**
   * Tidy prior finding threads on a re-run (#22): resolve threads whose finding
   * is no longer current or that a human settled (won't-fix/acknowledged), and
   * withhold findings the human settled or disputed instead of re-raising them.
   * Default on; set false to leave threads untouched. Tolerant — GraphQL failures
   * never sink the review.
   */
  resolveThreads?: boolean;
  /**
   * Skip publishing when the PR head advanced past the reviewed SHA (#21). Closes
   * the brief overlap window left by the workflow's `concurrency:
   * cancel-in-progress`, so a just-superseded run can't clobber the summary with
   * stale results for an outdated commit. Default on; tolerant (a failed head
   * re-check publishes normally). Never skips a dry run.
   */
  cancelIfHeadAdvanced?: boolean;
  /**
   * Exact PR head SHA represented by the checked-out workspace/event. Omitted
   * falls back to the PR metadata head SHA fetched at run start.
   */
  reviewedHeadSha?: string;
  /** Explicit review event override; wins over the approval rubric when set. */
  event?: ReviewEvent;
  /** Append a copy-paste "Resolve with an AI agent" prompt to each finding (default true, #57). */
  agentPrompt?: boolean;
  /** Skip agentic cross-file context retrieval (e.g. fork PRs / cost control). */
  skipContext?: boolean;
  /** Skip linter/SAST grounding (#16). */
  skipGrounding?: boolean;
  /** Allow grounding to execute repository-defined linter code/config in toolkitRoot. */
  trustWorkspace?: boolean;
  /** Limits for the linter/SAST grounding stage (#16). */
  groundingLimits?: GroundingLimits;
  /**
   * Semgrep SAST grounding policy (#16b): run Semgrep over changed source files
   * and feed its findings into the review. Omitted → enabled with the default
   * registry ruleset; skips gracefully when Semgrep isn't installed.
   */
  semgrep?: SemgrepOptions;
  /**
   * Dependency-CVE / license scanning policy (#34): scan changed lockfiles with
   * osv-scanner for known vulnerabilities (and license-policy violations when an
   * SPDX allowlist is set). Omitted → enabled (vuln scan only); skips gracefully
   * when osv-scanner isn't installed.
   */
  dependencyScan?: DependencyScanOptions;
  /** Build the review but don't publish it. */
  dryRun?: boolean;
  /**
   * Debug/verbose tracing (#49). When set, the pipeline + review emit structured
   * events (assembled prompts, fetched-context list, findings at each stage,
   * usage) to this sink. The CLI streams them to a JSONL file. Redacted at the
   * sink boundary; omitted → no tracing.
   */
  debug?: DebugSink;
  deps?: PipelineDeps;
}

const THREAD_RESOLUTION_CONCURRENCY = 4;

export interface ReviewPullRequestResult {
  meta: PullRequestMeta;
  payload: ReviewPayload;
  review: ReviewResult;
  /** Total LLM usage for the whole pipeline, including context retrieval. */
  usage: TokenUsage;
  /** Files omitted by size guards (reported, never dropped silently). */
  skipped: SkippedFile[];
  /** Number of files the agentic retriever pulled in. */
  contextFiles: number;
  /** Orchestration tier chosen for this diff (#31); undefined when no files were reviewed. */
  riskTier?: RiskTier;
  /** True when only the delta since the last reviewed SHA was reviewed (#23). */
  incremental?: boolean;
  /** Conclusion of the merge-gate Check Run (#24); undefined when disabled/skipped/failed. */
  checkRunConclusion?: CheckConclusion;
  /** Approval rubric decision (#52); undefined when the gate is disabled. */
  approval?: ApprovalDecision;
  /** Prior-thread tidy-up outcome (#22); undefined when disabled or no prior threads. */
  threads?: ThreadTidyResult;
  /** True when publishing was skipped because the PR head advanced past the reviewed SHA (#21). */
  headAdvanced?: boolean;
  /** Multi-provider ensemble outcome (#53); undefined for a normal single-provider review. */
  ensemble?: { providers: EnsembleProviderReport[] };
  /** True when an auto-generated PR description was written; false when generated but skipped/failed (#33). */
  prDescriptionUpdated?: boolean;
  /** Count of linked issues whose acceptance criteria were validated (#32). */
  issuesValidated?: number;
  /** True when the review was published (false on dry run). */
  posted: boolean;
}

export class ReviewPublishError extends Error {
  readonly result: ReviewPullRequestResult;

  constructor(message: string, result: ReviewPullRequestResult) {
    super(message);
    this.name = "ReviewPublishError";
    this.result = result;
  }
}

/** Keep operational review notes compact enough for a readable summary. */
function truncateNote(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

/** Review result used when filters leave no provider-reviewable files. */
function emptyReviewResult(): ReviewResult {
  return {
    findings: [],
    uncappedFindings: [],
    raw: [],
    passes: [],
    verification: { verified: 0, droppedFalsePositive: 0, demoted: 0, unverified: 0, ok: true },
    judge: { duplicatesRemoved: 0, belowThreshold: 0, belowConfidence: 0, capped: 0 },
    usage: emptyUsage()
  };
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

/** Convert failed specialist passes into reviewer-visible coverage notes. */
function reviewPassNotes(reviewResult: ReviewResult): string[] {
  const failures = reviewResult.passes.filter((pass) => !pass.ok);
  if (failures.length === 0) {
    return [];
  }

  const total = reviewResult.passes.length;
  const coverage =
    failures.length === total
      ? "All review specialist passes failed; coverage is degraded."
      : `${failures.length}/${total} review specialist passes failed; coverage is degraded.`;

  return [
    coverage,
    ...failures.map((pass) =>
      truncateNote(`Review pass "${pass.specialist}" failed: ${pass.error ?? "unknown error"}`)
    )
  ];
}

/** Surface what the skeptical verification pass changed, so it isn't silent (#8). */
function verificationNotes(reviewResult: ReviewResult): string[] {
  const notes: string[] = [];
  const { droppedFalsePositive, demoted, unverified, ok, error, skippedForBudget } = reviewResult.verification;
  if (skippedForBudget) {
    notes.push("Skipped false-positive verification to stay within the token budget (#18); raise the budget for the extra precision pass.");
  }
  if (!ok) {
    notes.push(
      truncateNote(
        `False-positive verification failed; candidate findings kept unverified: ${error ?? "unknown error"}`
      )
    );
    return notes;
  }
  if (droppedFalsePositive > 0) {
    notes.push(`Dropped ${droppedFalsePositive} finding(s) as likely false positive(s) on verification.`);
  }
  if (demoted > 0) {
    notes.push(`Lowered confidence on ${demoted} finding(s) after skeptical verification.`);
  }
  if (unverified > 0) {
    notes.push(`${unverified} candidate finding(s) could not be verified and were kept as-is.`);
  }
  return notes;
}

/** Surface what the high-signal defaults hid, so suppression isn't silent (#55). */
function judgeNotes(reviewResult: ReviewResult): string[] {
  const notes: string[] = [];
  const { belowThreshold, belowConfidence, capped } = reviewResult.judge;
  if (belowThreshold > 0) {
    notes.push(`Hid ${belowThreshold} finding(s) below the severity floor.`);
  }
  if (belowConfidence > 0) {
    notes.push(`Hid ${belowConfidence} low-confidence finding(s) below the confidence floor.`);
  }
  if (capped > 0) {
    notes.push(`${capped} additional lower-ranked finding(s) not shown (findings cap reached).`);
  }
  return notes;
}

/** Surface committable suggestions withheld by validation, so it isn't silent (#39, #5). */
function suggestionGatingNotes(findings: Finding[], minConfidence: number): string[] {
  const { withheldLowConfidence, withheldInvalid } = summarizeSuggestionGating(findings, minConfidence);
  const notes: string[] = [];
  if (withheldLowConfidence > 0) {
    notes.push(
      `Withheld a one-click fix on ${withheldLowConfidence} finding(s) below the suggestion confidence ` +
        `floor (${minConfidence}); the proposed fix is still in each finding's agent prompt (#39).`
    );
  }
  if (withheldInvalid > 0) {
    notes.push(
      `Withheld a one-click fix on ${withheldInvalid} finding(s) whose suggested code didn't pass ` +
        "validation (empty, truncated, or redacted) (#39)."
    );
  }
  return notes;
}

/**
 * Resolve linked-issue requirements for issue/ticket validation (#32): parse the
 * PR title/body for linked issues, fetch each (capped, tolerant), and assemble
 * their acceptance criteria into one redacted block for the requirements lens.
 * Returns the requirements text (undefined when none), the count validated, and
 * surfaced notes — never throws.
 */
async function resolveLinkedIssueRequirements(params: {
  fetchIssue: typeof defaultFetchIssue;
  octokit: OctokitLike;
  ref: PullRequestRef;
  meta: PullRequestMeta;
  maxIssues: number;
}): Promise<{ requirements?: string; count: number; notes: string[] }> {
  const text = [params.meta.title, params.meta.body ?? ""].join("\n\n");
  const refs = parseIssueReferences(text, { owner: params.ref.owner, repo: params.ref.repo });
  if (refs.length === 0) {
    return { count: 0, notes: [] };
  }
  const notes: string[] = [];
  const capped = refs.slice(0, params.maxIssues);
  if (refs.length > capped.length) {
    notes.push(
      `Issue validation: ${refs.length} linked issues found; validating the first ${capped.length} (maxIssues).`
    );
  }
  const settled = await Promise.allSettled(capped.map((ref) => params.fetchIssue(params.octokit, ref)));
  const fetched = settled.flatMap((result): FetchedIssue[] =>
    result.status === "fulfilled" && result.value !== null ? [result.value] : []
  );
  if (settled.some((result) => result.status === "rejected")) {
    notes.push("Issue validation: one or more linked issue fetches failed; continued with the rest.");
  }
  if (fetched.length === 0) {
    notes.push("Issue validation: linked issue(s) could not be fetched (missing, inaccessible, or a PR); skipped.");
    return { count: 0, notes };
  }
  const blocks = fetched.map((issue) => {
    const label = formatIssueRef(issue.ref, { owner: params.ref.owner, repo: params.ref.repo });
    return `### ${label}: ${issue.title}\n${issue.body || "(no description)"}`;
  });
  const requirements = redactSecrets(blocks.join("\n\n")).text;
  notes.push(
    `Issue validation: checking the PR against ${fetched.length} linked issue(s): ` +
      `${fetched.map((issue) => formatIssueRef(issue.ref, { owner: params.ref.owner, repo: params.ref.repo })).join(", ")}.`
  );
  return { requirements, count: fetched.length, notes };
}

/** Notes describing the multi-provider ensemble run + any provider that failed (#53). */
function ensembleNotes(providers: EnsembleProviderReport[] | undefined): string[] {
  if (!providers || providers.length === 0) {
    return [];
  }
  const ok = providers.filter((p) => p.ok);
  const notes: string[] = [];
  if (ok.length >= 2) {
    notes.push(
      `Ensemble review (#53): consolidated findings from ${ok.length} providers ` +
        `(${ok.map((p) => p.provider).join(", ")}). 🤝 marks findings ≥2 providers independently raised.`
    );
  }
  for (const failed of providers.filter((p) => !p.ok)) {
    const safeError = failed.error ? redactSecrets(failed.error).text : undefined;
    notes.push(
      truncateNote(
        `Ensemble: provider "${failed.provider}" did not complete${safeError ? ` (${safeError})` : ""}.`
      )
    );
  }
  return notes;
}

/** Notes for cross-generation failbacks that occurred during the review (#17). */
function failbackNotes(events: FailbackEvent[]): string[] {
  if (events.length === 0) {
    return [];
  }
  // One note per distinct provider/from/to swap (a model can fail back on many passes).
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const event of events) {
    const key = `${event.provider}:${event.from}->${event.to}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    notes.push(
      `Provider overload (#17): ${event.provider} fell back from \`${event.from}\` to \`${event.to}\` after retries — review ran on the older model.`
    );
  }
  return notes;
}

/** Note when the run's total tokens exceeded the configured budget (#18). */
function budgetNotes(usage: TokenUsage, budgetTokens: number | undefined): string[] {
  if (budgetTokens === undefined) {
    return [];
  }
  const spent = totalTokens(usage);
  if (spent <= budgetTokens) {
    return [];
  }
  return [
    `Review used ~${spent.toLocaleString()} tokens, over the configured budget of ` +
      `${budgetTokens.toLocaleString()} (#18); optional stages were trimmed. Raise the budget or ` +
      `tighten diff limits to review more.`
  ];
}

/** Merge tier context limits under any explicit user limits (user wins per-field). */
function mergeContextLimits(
  user: RetrievalLimits | undefined,
  tier: { maxRounds?: number; maxFiles?: number } | undefined
): RetrievalLimits | undefined {
  if (!tier) {
    return user;
  }
  return {
    ...user,
    maxRounds: user?.maxRounds ?? tier.maxRounds,
    maxFiles: user?.maxFiles ?? tier.maxFiles
  };
}

/**
 * Surface a coverage-affecting tier choice as a review note (#5: no silent
 * reduction). Only the cost-saving `minimal` tier trims coverage, so only it
 * reports; `standard`/`deep` add no note (the tier is still logged to stdout).
 */
function riskTierNotes(
  selection: ReturnType<typeof selectRiskTier>,
  applied: {
    specialistKeys?: string[];
    contextLimited: boolean;
  }
): string[] {
  if (selection.tier !== "minimal") {
    return [];
  }

  const reductions: string[] = [];
  if (applied.specialistKeys) {
    reductions.push(`ran a reduced specialist set (${applied.specialistKeys.join(", ")})`);
  }
  if (applied.contextLimited) {
    reductions.push("limited cross-file context");
  }
  if (reductions.length === 0) {
    return [];
  }

  const appliedText =
    reductions.length === 1
      ? reductions[0]
      : `${reductions.slice(0, -1).join(", ")} and ${reductions[reductions.length - 1]}`;
  return [
    `Risk tier: minimal (${selection.changedLines} changed line(s), ${selection.fileCount} file(s)) — ` +
      `${appliedText} to scale cost with risk (#31). ` +
      `Set riskTiering.enabled: false to always run the full review.`
  ];
}

/**
 * Disclose incremental-review scope (#23, #5: no silent reduction). When only the
 * delta was scanned, say so; when an attempted incremental fell back to a full
 * review (e.g. force-push), note that too.
 */
function incrementalNotes(baseSha: string | undefined, fallback: boolean): string[] {
  if (baseSha) {
    return [
      `Incremental review (#23): scanned only the changes since the last reviewed commit (\`${baseSha.slice(0, 7)}\`); ` +
        `earlier prowl-review summary comments remain on the PR and were not re-scanned. ` +
        `Use --no-incremental (or review.incremental: false) to re-scan the full PR.`
    ];
  }
  if (fallback) {
    return ["Could not safely use the incremental delta (history may have changed); ran a full review (#23)."];
  }
  return [];
}

function submitOptionsForReview(
  meta: PullRequestMeta,
  incrementalBaseSha: string | undefined,
  complete = true,
  repostableFindings: string[] = [],
  shouldPublish?: () => Promise<boolean>
): SubmitReviewOptions {
  return {
    commitId: meta.headSha,
    ...(complete ? { headSha: meta.headSha } : {}),
    ...(incrementalBaseSha !== undefined ? { preservePriorSummary: true } : {}),
    ...(repostableFindings.length > 0 ? { repostableFindings } : {}),
    ...(shouldPublish ? { shouldPublish } : {})
  };
}

function normalizeSubmitReviewResult(result: SubmitReviewResult | void): SubmitReviewResult {
  return result ?? { posted: true, cancelled: false };
}

/** Apply reviewability filters and size limits, returning files plus user-visible skip notes. */
function filterAndGuardDiffFiles(
  files: DiffFile[],
  ignorePatterns: readonly string[],
  diffLimits: DiffLimits | undefined
): { files: DiffFile[]; skipped: SkippedFile[] } {
  const { files: keptFiles, skipped } = filterReviewableDiffFiles(files, ignorePatterns);
  return guardReviewableDiffFiles(keptFiles, diffLimits, skipped);
}

/** Remove sensitive and ignored files before size budgeting or publish-file selection. */
function filterReviewableDiffFiles(
  files: DiffFile[],
  ignorePatterns: readonly string[]
): { files: DiffFile[]; skipped: SkippedFile[] } {
  // Keep sensitive files out of the review entirely and out of size budgets.
  const { files: safeFiles, skipped: sensitiveSkipped } = filterSensitiveDiffFiles(files);
  // Drop generated/vendored files (#19) before size guards so they don't burn the
  // budget; reported as skipped, never dropped silently. Omitted config → built-in
  // defaults; an explicit list (including []) replaces them.
  const { files: keptFiles, skipped: ignoredSkipped } = filterIgnoredDiffFiles(safeFiles, ignorePatterns);
  return { files: keptFiles, skipped: [...sensitiveSkipped, ...ignoredSkipped] };
}

/** Apply configured diff size limits to already-filtered files. */
function guardReviewableDiffFiles(
  files: DiffFile[],
  diffLimits: DiffLimits | undefined,
  skipped: SkippedFile[] = []
): { files: DiffFile[]; skipped: SkippedFile[] } {
  const guarded = applyDiffLimits({ files }, diffLimits);
  return { files: guarded.files, skipped: [...guarded.skipped, ...skipped] };
}

/** Keep only full-PR files that correspond to paths reviewed in an incremental delta. */
function filterPublishDiffFiles(
  reviewableFiles: DiffFile[],
  reviewedPaths: Set<string>
): DiffFile[] {
  return reviewableFiles.filter((file) => reviewedPaths.has(file.path));
}

function changedLineKeys(file: DiffFile): Set<string> {
  const keys = new Set<string>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add" && line.newLine !== undefined) {
        keys.add(`add:${line.newLine}:${line.content}`);
      } else if (line.type === "del") {
        keys.add(`del:${line.oldLine ?? ""}:${line.content}`);
      }
    }
  }
  return keys;
}

function incrementalDeltaIsWithinPrDiff(deltaFiles: DiffFile[], prFiles: DiffFile[]): boolean {
  const prByPath = new Map(prFiles.map((file) => [file.path, file]));
  const prKeysByPath = new Map<string, Set<string>>();
  for (const deltaFile of deltaFiles) {
    const prFile = prByPath.get(deltaFile.path);
    if (!prFile || deltaFile.binary !== prFile.binary) {
      return false;
    }

    let prKeys = prKeysByPath.get(prFile.path);
    if (!prKeys) {
      prKeys = changedLineKeys(prFile);
      prKeysByPath.set(prFile.path, prKeys);
    }
    for (const key of changedLineKeys(deltaFile)) {
      if (!prKeys.has(key)) {
        return false;
      }
    }
  }
  return true;
}

/** Outcome of the prior-thread tidy-up (#22), surfaced on the result for reporting. */
export interface ThreadTidyResult {
  /** Threads resolved because their finding is no longer current. */
  resolvedFixed: number;
  /** Threads resolved because a human settled them (won't-fix/acknowledged). */
  resolvedSettled: number;
  /** Settled thread actions that block approval because this run's finding set is incomplete. */
  approvalBlockingSettled: number;
  /** Current findings withheld because a human settled them (won't-fix/acknowledged). */
  withheldSettled: number;
  /** Current findings withheld because a human disputed them ("disagree"). */
  withheldDisputed: number;
  /** Disputed threads left open for the human (not resolved). */
  keptOpenDisputed: number;
  /** Prior inline fingerprints that may be posted again because the old thread was fixed. */
  repostableFindings: string[];
}

type ThreadResolveAction = ThreadActionPlan["resolve"][number];

async function resolveThreadActions(params: {
  actions: ThreadResolveAction[];
  resolveThread: NonNullable<PipelineDeps["resolveReviewThread"]>;
  octokit: OctokitLike;
  shouldResolveThread?: () => Promise<boolean>;
}): Promise<{ resolvedFixed: number; resolvedSettled: number; resolvedFixedFingerprints: string[] }> {
  let resolvedFixed = 0;
  let resolvedSettled = 0;
  const resolvedFixedFingerprints = new Set<string>();
  let next = 0;
  const workerCount = Math.min(THREAD_RESOLUTION_CONCURRENCY, params.actions.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < params.actions.length) {
      const action = params.actions[next];
      next += 1;
      if (!action) {
        continue;
      }
      if (params.shouldResolveThread && !(await params.shouldResolveThread())) {
        break;
      }
      const ok = await params.resolveThread(params.octokit, action.id);
      if (!ok) {
        continue;
      }
      if (action.reason === "fixed") {
        resolvedFixed += 1;
        action.fingerprints.forEach((fingerprint) => resolvedFixedFingerprints.add(fingerprint));
      } else {
        resolvedSettled += 1;
      }
    }
  });
  await Promise.all(workers);
  return { resolvedFixed, resolvedSettled, resolvedFixedFingerprints: [...resolvedFixedFingerprints] };
}

/**
 * Drop findings the user muted via `@prowl-review ignore` (#30). The ignore list
 * is fingerprints persisted in the summary state marker; suppression runs before
 * the approval gate so a muted finding never drives request-changes or re-posts.
 */
function suppressIgnoredFindings(
  findings: Finding[],
  ignored: Set<string>
): { findings: Finding[]; notes: string[]; suppressed: number } {
  if (ignored.size === 0) {
    return { findings, notes: [], suppressed: 0 };
  }
  const kept = findings.filter((finding) => !ignored.has(findingFingerprint(finding)));
  const suppressed = findings.length - kept.length;
  if (suppressed === 0) {
    return { findings, notes: [], suppressed: 0 };
  }
  return {
    findings: kept,
    suppressed,
    notes: [
      `Suppressed ${suppressed} finding(s) you muted with \`@prowl-review ignore\` (#30); ` +
        "they won't be raised again on this PR."
    ]
  };
}

function suppressIgnoredFindingsWithRefill(params: {
  findings: Finding[];
  candidateFindings?: Finding[];
  ignored: Set<string>;
}): { findings: Finding[]; candidateFindings?: Finding[]; notes: string[]; capped?: number } {
  if (params.ignored.size === 0) {
    return params.candidateFindings === undefined
      ? { findings: params.findings, notes: [] }
      : { findings: params.findings, candidateFindings: params.candidateFindings, notes: [] };
  }

  const hasCandidateFindings = params.candidateFindings !== undefined;
  const candidateFindings = params.candidateFindings ?? params.findings;
  const suppression = suppressIgnoredFindings(candidateFindings, params.ignored);
  if (suppression.suppressed === 0) {
    return params.candidateFindings === undefined
      ? { findings: params.findings, notes: [] }
      : { findings: params.findings, candidateFindings: params.candidateFindings, notes: [] };
  }

  const visibleLimit = params.findings.length;
  const refilled = suppression.findings.slice(0, visibleLimit);
  const result: { findings: Finding[]; candidateFindings?: Finding[]; notes: string[]; capped?: number } = {
    findings: refilled,
    notes: suppression.notes
  };
  if (hasCandidateFindings) {
    result.candidateFindings = suppression.findings;
    result.capped = Math.max(0, suppression.findings.length - refilled.length);
  }
  return result;
}

/**
 * Tidy prior finding threads (#22): resolve threads whose finding is no longer
 * current (gone from this run) or that a human settled (won't-fix/acknowledged), and
 * withhold findings the human settled or disputed so the reviewer doesn't
 * re-raise them. Returns the (possibly reduced) findings, reviewer-visible notes,
 * and a structured tidy result. Tolerant: a GraphQL failure yields an empty
 * thread list, so the review proceeds unchanged.
 */
async function tidyReviewThreads(params: {
  fetchThreads: NonNullable<PipelineDeps["fetchReviewThreads"]>;
  resolveThread: NonNullable<PipelineDeps["resolveReviewThread"]>;
  octokit: OctokitLike;
  ref: PullRequestRef;
  findings: Finding[];
  candidateFindings?: Finding[];
  resolveStaleThreads: boolean;
  enabled: boolean;
  dryRun: boolean;
  shouldResolveThread?: () => Promise<boolean>;
}): Promise<{ findings: Finding[]; notes: string[]; tidy?: ThreadTidyResult; capped?: number }> {
  if (!params.enabled) {
    return { findings: params.findings, notes: [] };
  }

  const threads = await params.fetchThreads(params.octokit, params.ref);
  if (threads.length === 0) {
    return { findings: params.findings, notes: [] };
  }

  const fingerprintByFinding = new Map(params.findings.map((finding) => [finding, findingFingerprint(finding)]));
  const hasCandidateFindings = params.candidateFindings !== undefined;
  const candidateFindings = params.candidateFindings ?? params.findings;
  const fingerprintByCandidate = new Map(candidateFindings.map((finding) => [finding, findingFingerprint(finding)]));
  const currentFingerprints = [...new Set([...fingerprintByFinding.values(), ...fingerprintByCandidate.values()])];
  const plan = planThreadActions({ threads, currentFingerprints, resolveStaleThreads: params.resolveStaleThreads });

  const acknowledged = new Set(plan.suppress.acknowledged);
  const disputed = new Set(plan.suppress.disputed);
  const approvalBlockingSettled = params.resolveStaleThreads ? 0 : acknowledged.size;
  let withheldSettled = 0;
  let withheldDisputed = 0;
  const kept: Finding[] = [];
  const visibleLimit = params.findings.length;
  for (const finding of candidateFindings) {
    const fingerprint = fingerprintByCandidate.get(finding)!;
    if (acknowledged.has(fingerprint)) {
      withheldSettled += 1;
    } else if (disputed.has(fingerprint)) {
      withheldDisputed += 1;
    } else {
      kept.push(finding);
    }
  }
  const refilled = kept.slice(0, visibleLimit);
  const capped = hasCandidateFindings ? Math.max(0, kept.length - refilled.length) : undefined;

  // Resolve threads (skipped on a dry run, which never mutates PR state).
  let resolvedFixed = 0;
  let resolvedSettled = 0;
  let resolvedFixedFingerprints: string[] = [];
  if (!params.dryRun) {
    ({ resolvedFixed, resolvedSettled, resolvedFixedFingerprints } = await resolveThreadActions({
      actions: plan.resolve,
      resolveThread: params.resolveThread,
      octokit: params.octokit,
      shouldResolveThread: params.shouldResolveThread
    }));
  }

  const notes: string[] = [];
  const resolvedTotal = resolvedFixed + resolvedSettled;
  if (resolvedTotal > 0) {
    const parts: string[] = [];
    if (resolvedFixed > 0) {
      parts.push(`${resolvedFixed} no longer current`);
    }
    if (resolvedSettled > 0) {
      parts.push(`${resolvedSettled} you settled`);
    }
    notes.push(`Resolved ${resolvedTotal} prior finding thread(s) — ${parts.join(", ")} (#22).`);
  }
  if (withheldSettled > 0) {
    notes.push(
      `Withheld ${withheldSettled} finding(s) you marked acknowledged/won't-fix so they aren't re-raised (#22).`
    );
  }
  if (withheldDisputed > 0) {
    notes.push(
      `Withheld ${withheldDisputed} disputed finding(s) (you replied "disagree"); left the thread open for re-review rather than re-raising (#22).`
    );
  } else if (plan.keptOpenDisputed > 0) {
    notes.push(`Left ${plan.keptOpenDisputed} disputed thread(s) open for re-review (#22).`);
  }

  const tidy: ThreadTidyResult = {
    resolvedFixed,
    resolvedSettled,
    approvalBlockingSettled,
    withheldSettled,
    withheldDisputed,
    keptOpenDisputed: plan.keptOpenDisputed,
    repostableFindings: [...new Set([...plan.repostable, ...resolvedFixedFingerprints])]
  };
  return { findings: refilled, notes, tidy, capped };
}

function approvalBlockingThreadCount(tidy: ThreadTidyResult | undefined): number {
  if (!tidy) {
    return 0;
  }
  return (
    Math.max(tidy.withheldSettled, tidy.approvalBlockingSettled) +
    Math.max(tidy.withheldDisputed, tidy.keptOpenDisputed)
  );
}

function inhibitApprovalForWithheldThreads(
  decision: ApprovalDecision,
  tidy: ThreadTidyResult | undefined
): ApprovalDecision {
  const blocked = approvalBlockingThreadCount(tidy);
  if (blocked === 0 || !decision.enabled || decision.event !== "APPROVE" || decision.overridden) {
    return decision;
  }
  return {
    ...decision,
    event: "COMMENT",
    clearsPriorRequestChanges: false,
    threadApprovalBlocked: true,
    reason: `${blocked} finding thread(s) were withheld or left open by human reply; posting as a comment instead of approving.`
  };
}

/**
 * Stale-publish guard (#21): return true when the PR head has advanced past the
 * SHA we reviewed, so this run should not publish (a newer run supersedes it).
 * Closes the overlap window the workflow's `concurrency: cancel-in-progress`
 * can't fully cover. Never engages on a dry run, when disabled, or when the head
 * re-check is unavailable (tolerant — prefer publishing over silent skipping).
 */
async function headAdvancedPastReview(params: {
  fetchHeadSha: NonNullable<PipelineDeps["fetchHeadSha"]>;
  octokit: OctokitLike;
  ref: PullRequestRef;
  reviewedSha: string;
  enabled: boolean;
  dryRun: boolean;
}): Promise<boolean> {
  if (!params.enabled || params.dryRun) {
    return false;
  }
  const current = await params.fetchHeadSha(params.octokit, params.ref);
  return current !== undefined && current !== params.reviewedSha;
}

/**
 * Publish the merge-gate Check Run (#24) when enabled. Non-fatal: a failure
 * (e.g. missing `checks: write`) never sinks the review, which is the primary
 * output. Returns the conclusion, or undefined when skipped/failed.
 */
async function maybeSubmitCheckRun(
  submit: NonNullable<PipelineDeps["submitCheckRun"]>,
  octokit: OctokitLike,
  ref: PullRequestRef,
  input: {
    dryRun?: boolean;
    checkRun?: { enabled?: boolean; failOn?: Severity };
    headSha?: string;
    findings: Finding[];
    incremental: boolean;
    /** Approval rubric decision (#52); when engaged it drives the conclusion. */
    approval?: ApprovalDecision;
  }
): Promise<CheckConclusion | undefined> {
  if (input.dryRun || !input.checkRun?.enabled || !input.headSha) {
    return undefined;
  }
  try {
    const plan = planCheckRun({
      findings: input.findings,
      failOn: input.checkRun.failOn,
      incremental: input.incremental,
      approval: input.approval
    });
    await submit(octokit, ref, { headSha: input.headSha, plan });
    return plan.conclusion;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the approval-rubric decision (#52). When the gate is enabled and honors
 * break-glass, detect a `@prowl-review break glass <head-sha>` override first; the pure
 * rubric then maps the findings (+ override) to the review event. With the gate
 * disabled this is a cheap pure call that returns a COMMENT decision and makes no
 * GitHub request.
 */
async function resolveApprovalDecision(
  detect: NonNullable<PipelineDeps["detectBreakGlass"]>,
  detectPriorRequestChanges: NonNullable<PipelineDeps["detectPriorRequestChanges"]>,
  octokit: OctokitLike,
  ref: PullRequestRef,
  findings: Finding[],
  config: ApprovalConfig | undefined,
  options: { coverageDegraded?: boolean; breakGlassHeadSha?: string; threadApprovalBlockers?: number } = {}
): Promise<ApprovalDecision> {
  let breakGlass: BreakGlassSignal | undefined;
  const threadApprovalBlockers = options.threadApprovalBlockers ?? 0;
  let decision = planApprovalDecision({
    findings,
    config,
    coverageDegraded: options.coverageDegraded,
    breakGlassTarget: options.breakGlassHeadSha
  });
  const shouldDetectBreakGlass =
    decision.enabled && (decision.blocking > 0 || threadApprovalBlockers > 0) && config?.breakGlass !== false;
  if (shouldDetectBreakGlass) {
    if (options.breakGlassHeadSha) {
      breakGlass = await detect(octokit, ref, { headSha: options.breakGlassHeadSha });
      decision = planApprovalDecision({
        findings,
        config,
        breakGlass,
        coverageDegraded: options.coverageDegraded,
        breakGlassTarget: options.breakGlassHeadSha
      });
    } else {
      decision = planApprovalDecision({
        findings,
        config,
        coverageDegraded: options.coverageDegraded,
        breakGlassTarget: options.breakGlassHeadSha,
        breakGlassFreshnessUnknown: true
      });
    }
  }
  if (decision.enabled && !decision.coverageDegraded && decision.blocking === 0) {
    const priorRequestChanges = await detectPriorRequestChanges(octokit, ref);
    if (priorRequestChanges.active || priorRequestChanges.truncated) {
      decision = planApprovalDecision({
        findings,
        config,
        breakGlass,
        coverageDegraded: options.coverageDegraded,
        breakGlassTarget: options.breakGlassHeadSha,
        priorRequestChanges: priorRequestChanges.active,
        priorRequestChangesTruncated: priorRequestChanges.truncated
      });
    }
  }
  if (
    decision.enabled &&
    !decision.coverageDegraded &&
    decision.blocking === 0 &&
    decision.event === "APPROVE" &&
    threadApprovalBlockers > 0 &&
    breakGlass?.active === true
  ) {
    return {
      ...decision,
      event: "APPROVE",
      overridden: true,
      clearsPriorRequestChanges: false,
      breakGlassFreshnessUnknown: false,
      overrideActor: breakGlass.actor,
      reason:
        `Break-glass override${breakGlass.actor ? ` by @${breakGlass.actor}` : ""}: approving past ` +
        `${threadApprovalBlockers} finding thread(s) withheld or left open by human reply.`
    };
  }
  return decision;
}

/** Build a new-side changed-line map for grounding tools that lint whole files. */
function changedLinesByPath(files: DiffFile[]): Record<string, number[]> {
  const changed: Record<string, number[]> = {};
  for (const file of files) {
    const lines = new Set<number>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add" && line.newLine) {
          lines.add(line.newLine);
        }
      }
    }
    if (lines.size > 0) {
      changed[file.path] = [...lines].sort((a, b) => a - b);
    }
  }
  return changed;
}

function hasAddedNewLines(file: DiffFile): boolean {
  return file.hunks.some((hunk) => hunk.lines.some((line) => line.type === "add" && line.newLine));
}

/** Redact untrusted linter finding text before it reaches prompts or comments. */
function redactGroundingFindings(findings: Finding[]): { findings: Finding[]; count: number } {
  let count = 0;
  const redacted = findings.map((finding) => {
    const title = redactSecrets(finding.title);
    const body = redactSecrets(finding.body);
    const suggestion = finding.suggestion ? redactSecrets(finding.suggestion) : undefined;
    count += title.count + body.count + (suggestion?.count ?? 0);
    return {
      ...finding,
      title: title.text,
      body: body.text,
      ...(suggestion ? { suggestion: suggestion.text } : {})
    };
  });
  return { findings: redacted, count };
}

/** Redact linter operational notes before they can be rendered in the review body. */
function redactGroundingNotes(notes: string[]): { notes: string[]; count: number } {
  let count = 0;
  const redacted = notes.map((note) => {
    const result = redactSecrets(note);
    count += result.count;
    return result.text;
  });
  return { notes: redacted, count };
}

/** Run the full review pipeline for one pull request. */
export async function reviewPullRequest(
  octokit: OctokitLike,
  ref: PullRequestRef,
  options: ReviewPullRequestOptions = {}
): Promise<ReviewPullRequestResult> {
  const config = options.config ?? resolveProviderConfig();
  const deps = options.deps ?? {};
  const fetchPr = deps.fetchPullRequest ?? defaultFetchPullRequest;
  const fetchPrMeta: NonNullable<PipelineDeps["fetchPullRequestMeta"]> =
    deps.fetchPullRequestMeta ??
    (deps.fetchPullRequest
      ? async (octokit: OctokitLike, ref: PullRequestRef) => (await fetchPr(octokit, ref)).meta
      : defaultFetchPullRequestMeta);
  const gather = deps.gatherContext ?? defaultGatherContext;
  const ground = deps.gatherGrounding ?? defaultGatherGrounding;
  const review = deps.runReview ?? defaultRunReview;
  const ensembleReview = deps.runEnsembleReview ?? defaultRunEnsembleReview;
  const describePr = deps.generatePrDescription ?? defaultGeneratePrDescription;
  const updateBody = deps.updatePullRequestBody ?? defaultUpdatePullRequestBody;
  const getIssue = deps.fetchIssue ?? defaultFetchIssue;
  const submit = deps.submitReview ?? defaultSubmitReview;
  const submitCheck = deps.submitCheckRun ?? defaultSubmitCheckRun;
  const detectOverride = deps.detectBreakGlass ?? defaultDetectBreakGlass;
  const detectPriorRequestChanges = deps.detectPriorRequestChanges ?? defaultHasActiveRequestChanges;
  const fetchThreads = deps.fetchReviewThreads ?? defaultFetchReviewThreads;
  const resolveThread = deps.resolveReviewThread ?? defaultResolveReviewThread;
  const fetchHeadSha = deps.fetchHeadSha ?? defaultFetchPullRequestHeadSha;
  const tidyThreadsEnabled = options.resolveThreads !== false;
  const staleGuardEnabled = options.cancelIfHeadAdvanced !== false;
  const loadPriorState = deps.fetchPriorState ?? defaultFetchPriorReviewState;
  const compareDiff = deps.fetchComparisonDiff ?? defaultFetchComparisonDiff;
  const debug = options.debug;
  const ensembleProviderNames = (options.ensemble?.configs ?? []).map((entry) => entry.provider);
  debug?.({
    type: "run-start",
    pr: `${ref.owner}/${ref.repo}#${ref.pull_number}`,
    provider: config.provider,
    model: config.model,
    ...(ensembleProviderNames.length >= 2 ? { ensemble: ensembleProviderNames } : {}),
    dryRun: options.dryRun === true,
    incremental: options.incremental !== false
  });

  const { meta, diff } = await fetchPr(octokit, ref);
  const reviewedHeadSha = options.reviewedHeadSha ?? meta.headSha;
  const reviewedHeadAlreadyStale =
    staleGuardEnabled && options.dryRun !== true && reviewedHeadSha !== meta.headSha;
  if (reviewedHeadAlreadyStale) {
    const reviewResult = emptyReviewResult();
    const summaryBody = buildWalkthrough({
      findings: reviewResult.findings,
      files: [],
      skipped: [],
      notes: ["Skipped review because the PR head advanced past the reviewed commit before review work started."]
    });
    const payload = buildReviewPayload({
      findings: reviewResult.findings,
      diff: { files: [] },
      summaryBody,
      event: options.event,
      agentPrompt: options.agentPrompt,
      maxInlineComments: options.maxInlineComments
    });
    return {
      meta,
      payload,
      review: reviewResult,
      usage: reviewResult.usage,
      skipped: [],
      contextFiles: 0,
      incremental: false,
      headAdvanced: true,
      posted: false
    };
  }
  const hasHeadAdvanced = () =>
    headAdvancedPastReview({
      fetchHeadSha,
      octokit,
      ref,
      reviewedSha: reviewedHeadSha,
      enabled: staleGuardEnabled,
      dryRun: options.dryRun === true
    });
  const shouldResolveThread = async () => !(await hasHeadAdvanced());
  const shouldPublishReview = async () => !(await hasHeadAdvanced());
  const fullParsed = parseDiff(diff);

  // Incremental re-review (#23): on a re-run, scan only the delta a push added
  // since the last reviewed SHA instead of the whole PR. Best-effort — a missing
  // prior SHA, an unchanged head, or a compare failure (e.g. after a force-push)
  // falls back to the full PR diff.
  // Load prior persisted state once: the last reviewed SHA (#23) and the per-PR
  // ignore list (#30) both live in the summary comment's state marker.
  const priorState = await loadPriorState(octokit, ref);
  const ignoredFingerprints = new Set(priorState?.ignoredFindings ?? []);

  let parsed = fullParsed;
  let incrementalBaseSha: string | undefined;
  let incrementalFallback = false;
  if (options.incremental !== false) {
    const priorSha = priorState?.lastReviewedSha;
    if (priorSha && priorSha !== meta.headSha) {
      try {
        const delta = await compareDiff(octokit, ref, priorSha, meta.headSha);
        parsed = parseDiff(delta);
        incrementalBaseSha = priorSha;
      } catch {
        incrementalFallback = true;
      }
    }
  }
  if (incrementalBaseSha !== undefined && !incrementalDeltaIsWithinPrDiff(parsed.files, fullParsed.files)) {
    parsed = fullParsed;
    incrementalBaseSha = undefined;
    incrementalFallback = true;
  }
  const incrementalNotesList = incrementalNotes(incrementalBaseSha, incrementalFallback);

  const ignorePatterns = options.ignore ?? DEFAULT_IGNORE_GLOBS;
  const { files: reviewFiles, skipped } = filterAndGuardDiffFiles(parsed.files, ignorePatterns, options.diffLimits);
  debug?.({
    type: "diff",
    reviewedFiles: reviewFiles.length,
    skippedFiles: skipped.length,
    ...(incrementalBaseSha !== undefined ? { incrementalBase: incrementalBaseSha } : {})
  });
  const fullReviewable =
    incrementalBaseSha === undefined ? { files: reviewFiles, skipped } : filterReviewableDiffFiles(fullParsed.files, ignorePatterns);
  const fullGuarded =
    incrementalBaseSha === undefined
      ? { files: reviewFiles, skipped }
      : guardReviewableDiffFiles(fullReviewable.files, options.diffLimits, fullReviewable.skipped);
  const fullSkipped = fullGuarded.skipped;
  const publishFiles =
    incrementalBaseSha === undefined
      ? reviewFiles
      // Publish anchors come from the reviewed delta paths, but need the full PR
      // diff for current line positions; do not re-apply full-PR size caps here.
      : filterPublishDiffFiles(fullReviewable.files, new Set(reviewFiles.map((file) => file.path)));
  const reviewPathSet = new Set(reviewFiles.map((file) => file.path));
  const sensitiveSkippedPaths = new Set(skipped.filter((file) => file.reason === "sensitive").map((file) => file.path));
  const secretScanFiles = parsed.files.filter((file) => sensitiveSkippedPaths.has(file.path) && !reviewPathSet.has(file.path));

  // Redact/report anything that will reach prompts or review comments.
  const redactionNotes: string[] = [];
  const sensitiveSkipCount = sensitiveSkippedPaths.size;
  if (sensitiveSkipCount > 0) {
    redactionNotes.push(`Skipped ${sensitiveSkipCount} sensitive file(s) — kept out of the prompt.`);
  }

  // Linter/SAST grounding (#16): run deterministic tools on reviewable files and
  // let Gitleaks additionally scan sensitive skipped files without exposing their
  // contents to context retrieval or provider review prompts.
  let grounding: ReviewInput["grounding"];
  let groundingFindings: Finding[] = [];
  let directGroundingFindings: Finding[] = [];
  let groundingNotes: string[] = [];
  const groundingLineFiles = [...reviewFiles, ...secretScanFiles];
  const groundingChangedLines = changedLinesByPath(groundingLineFiles);
  const secretScanPathSet = new Set(secretScanFiles.map((file) => file.path));
  const secretScanWholeFilePaths = secretScanFiles
    .filter((file) => (file.status === "renamed" || file.status === "copied") && !hasAddedNewLines(file))
    .map((file) => file.path);
  const semgrepWholeFilePaths = reviewFiles.filter((file) => file.status === "copied").map((file) => file.path);
  // Dependency scan (#34) sources changed manifests/lockfiles from the full diff
  // (pre-ignore) so a lockfile excluded from line-review by the ignore list (#19)
  // is still scanned for known CVEs; gate the grounding stage on those too.
  const dependencyManifestPaths = parsed.files.map((file) => file.path);
  const dependencyTargets = dependencyScanTargets(dependencyManifestPaths);
  if (!options.skipGrounding && options.toolkitRoot && (groundingLineFiles.length > 0 || dependencyTargets.length > 0)) {
    try {
      const result = await ground({
        root: options.toolkitRoot,
        changedPaths: reviewFiles.map((file) => file.path),
        dependencyPaths: dependencyManifestPaths,
        secretScanPaths: secretScanFiles.map((file) => file.path),
        secretScanWholeFilePaths,
        semgrepWholeFilePaths,
        changedLines: groundingChangedLines,
        trustWorkspace: options.trustWorkspace === true,
        limits: options.groundingLimits,
        semgrep: options.semgrep,
        dependencyScan: options.dependencyScan
      });
      const redactedNotes = redactGroundingNotes(result.notes);
      groundingNotes = redactedNotes.notes.map((note) => truncateNote(`Linter grounding: ${note}`));
      const redacted = redactGroundingFindings(result.findings);
      groundingFindings = redacted.findings;
      const directSecretFindings = groundingFindings.filter((finding) => secretScanPathSet.has(finding.file));
      const dependencyFindings = groundingFindings.filter((finding) => finding.category.toLowerCase() === "dependency");
      directGroundingFindings = groundingFindings.filter(
        (finding) => secretScanPathSet.has(finding.file) || finding.category.toLowerCase() === "dependency"
      );
      const promptGroundingFindings = groundingFindings.filter(
        (finding) => !secretScanPathSet.has(finding.file) && finding.category.toLowerCase() !== "dependency"
      );
      const redactionCount = redacted.count + redactedNotes.count;
      if (redactionCount > 0) {
        redactionNotes.push(`Redacted ${redactionCount} secret(s) from linter grounding output.`);
      }
      if (directSecretFindings.length > 0 && reviewFiles.length > 0) {
        groundingNotes.push(
          `Linter grounding: kept ${directSecretFindings.length} sensitive-file secret finding(s) outside provider verification.`
        );
      }
      if (dependencyFindings.length > 0 && reviewFiles.length > 0) {
        groundingNotes.push(
          `Linter grounding: kept ${dependencyFindings.length} dependency finding(s) outside provider verification.`
        );
      }
      if (promptGroundingFindings.length > 0) {
        grounding = { findings: promptGroundingFindings, summary: buildGroundingSummary(promptGroundingFindings) };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = redactSecrets(message);
      if (redacted.count > 0) {
        redactionNotes.push(`Redacted ${redacted.count} secret(s) from linter grounding output.`);
      }
      groundingNotes = [truncateNote(`Linter grounding failed; continuing without it: ${redacted.text}`)];
    }
  }
  debug?.({ type: "grounding", findings: groundingFindings.length, notes: groundingNotes.length });

  // Redact secrets from anything that will reach the provider.
  const renderedDiff = renderGuardedDiff(reviewFiles);
  const redactedDiff = redactSecrets(renderedDiff);
  const diffText = redactedDiff.text;
  if (redactedDiff.count > 0) {
    redactionNotes.push(`Redacted ${redactedDiff.count} secret(s) from the diff.`);
  }
  let fullGuardedRenderedDiff: string | undefined;
  const renderFullGuardedDiff = () => {
    if (incrementalBaseSha === undefined) {
      return renderedDiff;
    }
    fullGuardedRenderedDiff ??= renderGuardedDiff(fullGuarded.files);
    return fullGuardedRenderedDiff;
  };
  const redactedTitle = redactSecrets(meta.title);
  if (redactedTitle.count > 0) {
    redactionNotes.push(`Redacted ${redactedTitle.count} secret(s) from the PR title.`);
  }

  // Auto-generate a PR description (#33) when enabled and the body is empty (or
  // already holds our generated block). The new body is PATCHed at publish time;
  // a human-authored description is never touched. Tolerant — a failure here is a
  // note, never a sink for the review.
  let prDescriptionText: string | undefined;
  let prDescriptionUsage = emptyUsage();
  const prDescriptionNotes: string[] = [];
  const generatePrDescriptionIfAllowed = async (usageBeforePrDescription: TokenUsage): Promise<void> => {
    const prDescriptionAllowed = options.prDescription?.enabled === true && shouldDescribePr(meta.body);
    const prDescriptionBudgetExhausted =
      options.budgetTokens !== undefined && totalTokens(usageBeforePrDescription) >= options.budgetTokens;
    if (prDescriptionAllowed && prDescriptionBudgetExhausted) {
      prDescriptionNotes.push("Skipped PR description generation because the token budget was exhausted (#18).");
    } else if (prDescriptionAllowed) {
      try {
        let descriptionDiffText = diffText;
        if (incrementalBaseSha !== undefined) {
          const redactedDescriptionDiff = redactSecrets(renderFullGuardedDiff());
          descriptionDiffText = redactedDescriptionDiff.text;
          if (redactedDescriptionDiff.count > 0) {
            redactionNotes.push(`Redacted ${redactedDescriptionDiff.count} secret(s) from the PR description diff.`);
          }
        }
        const generated = await describePr(
          { title: redactedTitle.text, diff: descriptionDiffText, guidelines: options.guidelines, alreadyRedacted: true },
          { config, retry: undefined }
        );
        prDescriptionUsage = generated.usage;
        const redactedDescription = redactSecrets(generated.description);
        if (redactedDescription.count > 0) {
          redactionNotes.push(`Redacted ${redactedDescription.count} secret(s) from PR description output.`);
        }
        prDescriptionText = redactedDescription.text;
        prDescriptionNotes.push(
          meta.body && meta.body.trim()
            ? "Refreshed the auto-generated PR description block from the latest changes (#33)."
            : "Generated a PR description from the diff because the body was empty (#33)."
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const redacted = redactSecrets(message);
        if (redacted.count > 0) {
          redactionNotes.push(`Redacted ${redacted.count} secret(s) from PR description generation output.`);
        }
        prDescriptionNotes.push(
          truncateNote(`PR description generation failed; continuing without it: ${redacted.text}`)
        );
      }
    }
  };
  const publishPrDescription = async (result: ReviewPullRequestResult): Promise<void> => {
    if (prDescriptionText === undefined) {
      return;
    }
    try {
      const latestMeta = await fetchPrMeta(octokit, ref);
      if (staleGuardEnabled && latestMeta.headSha !== reviewedHeadSha) {
        result.headAdvanced = true;
        result.prDescriptionUpdated = false;
      } else if (!shouldDescribePr(latestMeta.body)) {
        result.prDescriptionUpdated = false;
      } else {
        await updateBody(octokit, ref, embedPrDescription(latestMeta.body, prDescriptionText));
        result.prDescriptionUpdated = true;
      }
    } catch {
      result.prDescriptionUpdated = false;
      // surfaced via the review note; body update is best-effort
    }
  };

  // Issue/ticket validation (#32): pull linked-issue acceptance criteria so the
  // requirements lens can flag gaps. Resolve before the no-file shortcut so an
  // incremental run with an ignored/filtered delta can still validate against the
  // full guarded PR diff.
  const issueValidation = options.issueValidation?.enabled
    ? await resolveLinkedIssueRequirements({
        fetchIssue: getIssue,
        octokit,
        ref,
        meta,
        maxIssues: options.issueValidation.maxIssues ?? 3
      })
    : { requirements: undefined, count: 0, notes: [] as string[] };
  let requirementsDiff: string | undefined;
  if (issueValidation.requirements && incrementalBaseSha !== undefined) {
    const redactedRequirementsDiff = redactSecrets(renderFullGuardedDiff());
    requirementsDiff = redactedRequirementsDiff.text;
    if (redactedRequirementsDiff.count > 0) {
      redactionNotes.push(`Redacted ${redactedRequirementsDiff.count} secret(s) from the issue validation diff.`);
    }
  }

  // Cross-generation failback (#17): on retryable exhaustion, retry with an older
  // same-family model. Events are collected into review notes (#56).
  const failbackEvents: FailbackEvent[] = [];
  const failback: FailbackOptions | undefined = options.failback
    ? { onFailback: (event) => failbackEvents.push(event) }
    : undefined;

  if (reviewFiles.length === 0) {
    const runRequirementsOnlyReview = issueValidation.requirements !== undefined && fullGuarded.files.length > 0;
    const reviewResult = runRequirementsOnlyReview
      ? await review(
          {
            diff: diffText,
            guidelines: options.guidelines,
            learnedPatterns: options.learnedPatterns,
            languages: summarizeLanguages(fullGuarded.files.map((file) => file.path)).map((language) => language.label),
            requirements: issueValidation.requirements,
            requirementsDiff: requirementsDiff ?? diffText,
            specialists: []
          },
          {
            config,
            minSeverity: options.minSeverity,
            minConfidence: options.minConfidence,
            maxFindings: options.maxFindings,
            verify: options.verify,
            verifyConfidence: options.verifyConfidence,
            maxTokens: options.budgetTokens,
            ...(options.retry ? { retry: options.retry } : {}),
            ...(failback ? { failback } : {}),
            ...(debug ? { debug } : {})
          }
        )
      : {
          ...emptyReviewResult(),
          findings: groundingFindings,
          uncappedFindings: groundingFindings,
          raw: groundingFindings
        };
    if (runRequirementsOnlyReview && groundingFindings.length > 0) {
      const uncappedFindings = reviewResult.uncappedFindings ?? reviewResult.findings;
      reviewResult.raw = [...reviewResult.raw, ...groundingFindings];
      reviewResult.findings = [...groundingFindings, ...reviewResult.findings];
      reviewResult.uncappedFindings = [...groundingFindings, ...uncappedFindings];
    }
    // Drop findings muted via `@prowl-review ignore` (#30) before the gate.
    const ignoredSuppression = suppressIgnoredFindingsWithRefill({
      findings: reviewResult.findings,
      candidateFindings: reviewResult.uncappedFindings,
      ignored: ignoredFingerprints
    });
    reviewResult.findings = ignoredSuppression.findings;
    if (ignoredSuppression.candidateFindings) {
      reviewResult.uncappedFindings = ignoredSuppression.candidateFindings;
    }
    if (ignoredSuppression.capped !== undefined) {
      reviewResult.judge.capped = ignoredSuppression.capped;
    }
    reviewResult.raw = reviewResult.findings;
    await generatePrDescriptionIfAllowed(reviewResult.usage);
    const totalUsage = addUsage(reviewResult.usage, prDescriptionUsage);
    const requirementsCoverage = runRequirementsOnlyReview
      ? {
          passed: reviewResult.passes.filter((pass) => pass.ok).length,
          total: reviewResult.passes.length
        }
      : undefined;
    const requirementsDegraded =
      requirementsCoverage !== undefined &&
      (requirementsCoverage.passed < requirementsCoverage.total || !reviewResult.verification.ok);
    const approvalCoverageIncomplete = requirementsDegraded || fullSkipped.length > 0;
    const headAdvancedBeforeTidy = await hasHeadAdvanced();
    // Tidy prior threads first (#22) so withheld findings don't count toward the gate.
    const tidied: Awaited<ReturnType<typeof tidyReviewThreads>> = headAdvancedBeforeTidy
      ? { findings: reviewResult.findings, notes: [] }
      : await tidyReviewThreads({
          fetchThreads,
          resolveThread,
          octokit,
          ref,
          findings: reviewResult.findings,
          candidateFindings: reviewResult.uncappedFindings,
          resolveStaleThreads: incrementalBaseSha === undefined && !approvalCoverageIncomplete,
          enabled: tidyThreadsEnabled,
          dryRun: options.dryRun === true,
          shouldResolveThread
        });
    reviewResult.findings = tidied.findings;
    reviewResult.raw = tidied.findings;
    if (tidied.capped !== undefined) {
      reviewResult.judge.capped = tidied.capped;
    }
    let approval = await resolveApprovalDecision(
      detectOverride,
      detectPriorRequestChanges,
      octokit,
      ref,
      reviewResult.findings,
      options.approval,
      {
        coverageDegraded: approvalCoverageIncomplete,
        breakGlassHeadSha: meta.headSha,
        threadApprovalBlockers: approvalBlockingThreadCount(tidied.tidy)
      }
    );
    approval = inhibitApprovalForWithheldThreads(approval, tidied.tidy);
    const summaryBody = buildWalkthrough({
      findings: reviewResult.findings,
      files: runRequirementsOnlyReview ? fullGuarded.files : parsed.files,
      skipped,
      coverage: requirementsCoverage,
      degraded: requirementsDegraded,
      notes: [
        ...incrementalNotesList,
        ...approvalNotes(approval),
        ...issueValidation.notes,
        ...prDescriptionNotes,
        ...ignoredSuppression.notes,
        ...tidied.notes,
        ...failbackNotes(failbackEvents),
        ...redactionNotes,
        ...groundingNotes,
        ...(runRequirementsOnlyReview
          ? [
              incrementalBaseSha
                ? "No reviewable changes since the last reviewed commit; ran linked-issue requirements validation against the full PR diff."
                : "No reviewable files remained after filters; ran linked-issue requirements validation against the guarded PR diff."
            ]
          : []),
        ...verificationNotes(reviewResult),
        ...judgeNotes(reviewResult),
        ...suggestionGatingNotes(reviewResult.findings, options.suggestions?.minConfidence ?? DEFAULT_SUGGESTION_MIN_CONFIDENCE),
        ...reviewPassNotes(reviewResult),
        ...budgetNotes(totalUsage, options.budgetTokens).map((note) => truncateNote(note)),
        ...(runRequirementsOnlyReview
          ? []
          : [
              incrementalBaseSha
                ? "No reviewable changes since the last reviewed commit; provider review skipped."
                : "No reviewable files remained after filters; provider review skipped."
            ])
      ]
    });
    const payload = buildReviewPayload({
      findings: reviewResult.findings,
      diff: { files: runRequirementsOnlyReview ? fullGuarded.files : [] },
      summaryBody,
      event: options.event ?? approval.event,
      agentPrompt: options.agentPrompt,
      suggestions: options.suggestions
    });

    const result: ReviewPullRequestResult = {
      meta,
      payload,
      review: reviewResult,
      usage: totalUsage,
      skipped,
      contextFiles: 0,
      incremental: incrementalBaseSha !== undefined,
      ...(approval.enabled ? { approval } : {}),
      ...(tidied.tidy ? { threads: tidied.tidy } : {}),
      ...(options.issueValidation?.enabled ? { issuesValidated: issueValidation.count } : {}),
      posted: false
    };
    // Stale-publish guard (#21): a newer push superseded this run — don't clobber.
    if (headAdvancedBeforeTidy || (await hasHeadAdvanced())) {
      result.headAdvanced = true;
      return result;
    }
    if (!options.dryRun) {
      try {
        const submitResult = normalizeSubmitReviewResult(
          await submit(
            octokit,
            ref,
            payload,
            submitOptionsForReview(
              meta,
              incrementalBaseSha,
              !approvalCoverageIncomplete,
              tidied.tidy?.repostableFindings,
              shouldPublishReview
            )
          )
        );
        result.posted = submitResult.posted;
        if (submitResult.cancelled) {
          result.headAdvanced = true;
          return result;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ReviewPublishError(message, result);
      }
      if (await hasHeadAdvanced()) {
        result.headAdvanced = true;
        if (prDescriptionText !== undefined) {
          result.prDescriptionUpdated = false;
        }
        return result;
      }
      await publishPrDescription(result);
      if (result.headAdvanced) {
        return result;
      }
    }
    // A passing gate still posts on a no-findings run so a Required check isn't left pending.
    result.checkRunConclusion = await maybeSubmitCheckRun(submitCheck, octokit, ref, {
      dryRun: options.dryRun,
      checkRun: options.checkRun,
      headSha: meta.headSha,
      findings: reviewResult.findings,
      incremental: incrementalBaseSha !== undefined,
      approval
    });

    return result;
  }

  // Risk-tiered orchestration (#31): scale the cost drivers (pass count + context)
  // to diff complexity, so a tiny diff doesn't pay for the full fan-out.
  const tierSelection = selectRiskTier(diffComplexity(reviewFiles), options.riskTiering);
  const tierPlan = planOrchestration(tierSelection.tier);
  // A tier trims the BUILT-IN lenses only when the user hasn't configured an
  // explicit set (#51) — explicit config is honored as-is, and custom reviewers
  // always run. Omitted → the pipeline's default set via runReview.
  const effectiveSpecialists =
    options.specialists ??
    (tierPlan.builtinSpecialistKeys
      ? DEFAULT_SPECIALISTS.filter((s) => tierPlan.builtinSpecialistKeys!.includes(s.key))
      : undefined);
  // Context limits: explicit user values win per-field; the tier fills the rest.
  const effectiveContextLimits = mergeContextLimits(options.contextLimits, tierPlan.contextLimits);
  const tierSpecialistKeys = options.specialists === undefined ? tierPlan.builtinSpecialistKeys : undefined;
  const tierLimitedContext =
    !options.skipContext &&
    Boolean(options.toolkitRoot) &&
    ((options.contextLimits?.maxRounds === undefined && tierPlan.contextLimits?.maxRounds !== undefined) ||
      (options.contextLimits?.maxFiles === undefined && tierPlan.contextLimits?.maxFiles !== undefined));
  const tierNotes = riskTierNotes(tierSelection, {
    specialistKeys: tierSpecialistKeys,
    contextLimited: tierLimitedContext
  });

  let context: string | undefined;
  let contextFiles = 0;
  let contextUsage = emptyUsage();
  let contextNotes: string[] = [];
  let contextDegraded = false;
  if (!options.skipContext && options.toolkitRoot && reviewFiles.length > 0) {
    try {
      const contextMaxTokens =
        options.budgetTokens === undefined
          ? effectiveContextLimits?.maxTokens
          : effectiveContextLimits?.maxTokens === undefined
            ? options.budgetTokens
            : Math.min(options.budgetTokens, effectiveContextLimits.maxTokens);
      const gathered = await gather({
        toolkit: { root: options.toolkitRoot },
        changedPaths: reviewFiles.map((file) => file.path),
        config,
        // Cap the (otherwise unbounded) retrieval loop at the tighter explicit context or review budget (#18).
        limits: { ...effectiveContextLimits, maxTokens: contextMaxTokens }
      });
      contextFiles = gathered.files.length;
      contextUsage = gathered.usage;
      contextNotes = gathered.notes.map((note) => truncateNote(`Context retrieval: ${note}`));
      debug?.({
        type: "context",
        files: gathered.files.map((file) => ({ path: file.path, truncated: file.truncated })),
        rounds: gathered.rounds,
        reachedLimit: gathered.reachedLimit
      });
      // A hit bound (max rounds/files) or a truncated search/list is partial
      // context on an otherwise healthy review — not an inability to run. Like a
      // guardrail file-skip it stays a benign note, NOT a degraded headline (#56).
      // Only a thrown retrieval error (catch below) means coverage truly degraded.
      if (gathered.files.length > 0) {
        const joined = gathered.files.map((file) => `# ${file.path}\n${file.content}`).join("\n\n");
        // Defense-in-depth: tool reads are already redacted, but redact again.
        context = redactSecrets(joined).text;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ContextRetrievalError) {
        contextUsage = error.usage;
      }
      contextDegraded = true;
      contextNotes = [truncateNote(`Context retrieval failed; continuing without extra context: ${message}`)];
    }
  }

  // The verification gate sees the budget net of what context retrieval already
  // spent, so it skips the precision pass once the run is out of budget (#18).
  const reviewBudgetTokens =
    options.budgetTokens === undefined
      ? undefined
      : Math.max(0, options.budgetTokens - totalTokens(contextUsage));
  const contextSkippedForBudget = reviewBudgetTokens === 0 && context !== undefined;
  const reviewContext = contextSkippedForBudget ? undefined : context;
  // Shared input: context (#4) + grounding (#16) run once and feed every provider.
  const reviewInput: ReviewInput = {
    diff: diffText,
    context: reviewContext,
    guidelines: options.guidelines,
    learnedPatterns: options.learnedPatterns,
    languages: summarizeLanguages(reviewFiles.map((file) => file.path)).map((language) => language.label),
    grounding,
    requirements: issueValidation.requirements,
    requirementsDiff,
    specialists: effectiveSpecialists
  };
  // Ensemble (#53): fan out across providers when ≥2 configs were resolved; the
  // cross-provider judge consolidates with provenance. Otherwise a normal review.
  const ensembleConfigs = options.ensemble?.configs ?? [];
  const ensembleActive = ensembleConfigs.length >= 2;
  const ensembleRunReview = deps.runEnsembleReview ? undefined : review;
  const reviewResult: ReviewResult = ensembleActive
    ? await ensembleReview(reviewInput, {
        configs: ensembleConfigs,
        minSeverity: options.minSeverity,
        minConfidence: options.minConfidence,
        maxFindings: options.maxFindings,
        verify: options.verify,
        verifyConfidence: options.verifyConfidence,
        maxTokens: reviewBudgetTokens,
        ...(options.retry ? { retry: options.retry } : {}),
        ...(failback ? { failback } : {}),
        ...(debug ? { debug } : {}),
        ...(ensembleRunReview ? { runReview: ensembleRunReview } : {})
      })
    : await review(reviewInput, {
        config,
        minSeverity: options.minSeverity,
        minConfidence: options.minConfidence,
        maxFindings: options.maxFindings,
        verify: options.verify,
        verifyConfidence: options.verifyConfidence,
        maxTokens: reviewBudgetTokens,
        ...(options.retry ? { retry: options.retry } : {}),
        ...(failback ? { failback } : {}),
        ...(debug ? { debug } : {})
      });
  const ensembleProviders = ensembleActive
    ? (reviewResult as EnsembleReviewResult).providers
    : undefined;
  const providerCount = ensembleProviders?.filter((p) => p.ok).length;
  if (directGroundingFindings.length > 0) {
    const uncappedFindings = reviewResult.uncappedFindings ?? reviewResult.findings;
    reviewResult.raw = [...reviewResult.raw, ...directGroundingFindings];
    reviewResult.findings = [...directGroundingFindings, ...reviewResult.findings];
    reviewResult.uncappedFindings = [...directGroundingFindings, ...uncappedFindings];
  }

  const usageBeforePrDescription = addUsage(reviewResult.usage, contextUsage);
  await generatePrDescriptionIfAllowed(usageBeforePrDescription);

  // Drop findings muted via `@prowl-review ignore` (#30) before the gate + tidy.
  const ignoredSuppression = suppressIgnoredFindingsWithRefill({
    findings: reviewResult.findings,
    candidateFindings: reviewResult.uncappedFindings,
    ignored: ignoredFingerprints
  });
  reviewResult.findings = ignoredSuppression.findings;
  if (ignoredSuppression.candidateFindings) {
    reviewResult.uncappedFindings = ignoredSuppression.candidateFindings;
  }
  if (ignoredSuppression.capped !== undefined) {
    reviewResult.judge.capped = ignoredSuppression.capped;
  }

  // Coverage drives the three review-comment states (#56): a run is "degraded"
  // when the reviewer couldn't fully run — a specialist pass failed, verification
  // failed, or context retrieval threw. Benign partial coverage is NOT a failure:
  // guardrail file skips and bounded context truncation (max rounds/files, a
  // truncated search) leave the review healthy but partial, so they render as the
  // clean state with a caveat headline + a note, rather than an alarming "Review
  // incomplete" on every PR that touches a lockfile or has many grep matches.
  const passesPassed = reviewResult.passes.filter((pass) => pass.ok).length;
  const coverage = { passed: passesPassed, total: reviewResult.passes.length };
  const degraded =
    passesPassed < reviewResult.passes.length || !reviewResult.verification.ok || contextDegraded;
  const approvalCoverageIncomplete = degraded || fullSkipped.length > 0;

  const totalUsage = addUsage(usageBeforePrDescription, prDescriptionUsage);

  const headAdvancedBeforeTidy = await hasHeadAdvanced();
  // Tidy prior threads (#22) before the gate decision, so findings a human
  // already settled or disputed are withheld and don't drive request-changes.
  const tidied: Awaited<ReturnType<typeof tidyReviewThreads>> = headAdvancedBeforeTidy
    ? { findings: reviewResult.findings, notes: [] }
    : await tidyReviewThreads({
        fetchThreads,
        resolveThread,
        octokit,
        ref,
        findings: reviewResult.findings,
        candidateFindings: reviewResult.uncappedFindings,
        resolveStaleThreads:
          incrementalBaseSha === undefined && !approvalCoverageIncomplete && reviewResult.judge.capped === 0,
        enabled: tidyThreadsEnabled,
        dryRun: options.dryRun === true,
        shouldResolveThread
      });
  reviewResult.findings = tidied.findings;
  if (tidied.capped !== undefined) {
    reviewResult.judge.capped = tidied.capped;
  }

  // Approval rubric (#52): map the surfaced findings (+ any break-glass override)
  // to the review event and the #24 check conclusion — one decision, both surfaces.
  let approval = await resolveApprovalDecision(
    detectOverride,
    detectPriorRequestChanges,
    octokit,
    ref,
    reviewResult.findings,
    options.approval,
    {
      coverageDegraded: approvalCoverageIncomplete,
      breakGlassHeadSha: meta.headSha,
      threadApprovalBlockers: approvalBlockingThreadCount(tidied.tidy)
    }
  );
  approval = inhibitApprovalForWithheldThreads(approval, tidied.tidy);

  const summaryBody = buildWalkthrough({
    findings: reviewResult.findings,
    files: reviewFiles,
    skipped,
    coverage,
    degraded,
    providerCount,
    providers: ensembleProviders?.filter((p) => p.ok).map((p) => p.provider),
    notes: [
      ...incrementalNotesList,
      ...approvalNotes(approval),
      ...ensembleNotes(ensembleProviders),
      ...failbackNotes(failbackEvents),
      ...issueValidation.notes,
      ...prDescriptionNotes,
      ...ignoredSuppression.notes,
      ...tidied.notes,
      ...tierNotes,
      ...injectionNotes(reviewFiles).map((note) => truncateNote(note)),
      ...redactionNotes,
      ...contextNotes,
      ...groundingNotes,
      ...(contextSkippedForBudget
        ? ["Skipped optional context in specialist prompts because context retrieval exhausted the token budget."]
        : []),
      ...verificationNotes(reviewResult),
      ...judgeNotes(reviewResult),
      ...suggestionGatingNotes(reviewResult.findings, options.suggestions?.minConfidence ?? DEFAULT_SUGGESTION_MIN_CONFIDENCE),
      ...reviewPassNotes(reviewResult),
      ...budgetNotes(totalUsage, options.budgetTokens).map((note) => truncateNote(note))
    ]
  });

  const payload = buildReviewPayload({
    findings: reviewResult.findings,
    diff: { files: publishFiles },
    summaryBody,
    event: options.event ?? approval.event,
    agentPrompt: options.agentPrompt,
    maxInlineComments: options.maxInlineComments,
    providerCount,
    suggestions: options.suggestions
  });

  const result: ReviewPullRequestResult = {
    meta,
    payload,
    review: reviewResult,
    usage: totalUsage,
    skipped,
    contextFiles,
    riskTier: tierSelection.tier,
    incremental: incrementalBaseSha !== undefined,
    ...(approval.enabled ? { approval } : {}),
    ...(tidied.tidy ? { threads: tidied.tidy } : {}),
    ...(ensembleProviders ? { ensemble: { providers: ensembleProviders } } : {}),
    ...(options.issueValidation?.enabled ? { issuesValidated: issueValidation.count } : {}),
    posted: false
  };
  // Stale-publish guard (#21): a newer push superseded this run — don't clobber.
  if (headAdvancedBeforeTidy || (await hasHeadAdvanced())) {
    result.headAdvanced = true;
    return result;
  }
  if (!options.dryRun) {
    try {
      const submitResult = normalizeSubmitReviewResult(
        await submit(
          octokit,
          ref,
          payload,
          submitOptionsForReview(
            meta,
            incrementalBaseSha,
            !approvalCoverageIncomplete,
            tidied.tidy?.repostableFindings,
            shouldPublishReview
          )
        )
      );
      result.posted = submitResult.posted;
      if (submitResult.cancelled) {
        result.headAdvanced = true;
        return result;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ReviewPublishError(message, result);
    }
    if (await hasHeadAdvanced()) {
      result.headAdvanced = true;
      if (prDescriptionText !== undefined) {
        result.prDescriptionUpdated = false;
      }
      return result;
    }
    await publishPrDescription(result);
  }
  if (result.headAdvanced) {
    return result;
  }
  // Merge gate (#24): conclusion from the approval rubric (#52) when engaged,
  // else from the surfaced findings against `failOn`.
  result.checkRunConclusion = await maybeSubmitCheckRun(submitCheck, octokit, ref, {
    dryRun: options.dryRun,
    checkRun: options.checkRun,
    headSha: meta.headSha,
    findings: reviewResult.findings,
    incremental: incrementalBaseSha !== undefined,
    approval
  });
  return result;
}

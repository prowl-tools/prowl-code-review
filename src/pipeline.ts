import type { OctokitLike } from "./github/client.js";
import {
  fetchPullRequest as defaultFetchPullRequest,
  type FetchedPullRequest,
  type PullRequestMeta,
  type PullRequestRef
} from "./github/diff.js";
import { submitReview as defaultSubmitReview, type SubmitReviewOptions } from "./github/review.js";
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
  gatherGrounding as defaultGatherGrounding,
  buildGroundingSummary,
  type GatherGroundingParams,
  type GroundingResult,
  type GroundingLimits
} from "./grounding/index.js";
import { buildWalkthrough } from "./review/walkthrough.js";
import { buildReviewPayload, type ReviewEvent, type ReviewPayload } from "./review/inline.js";
import { emptyUsage, resolveProviderConfig, type ProviderConfig, type TokenUsage } from "./providers/index.js";
import type { Finding, Severity } from "./review/findings.js";
import { redactSecrets } from "./review/redact.js";
import { filterSensitiveDiffFiles } from "./review/sensitive-diff.js";
import { filterIgnoredDiffFiles, DEFAULT_IGNORE_GLOBS } from "./review/ignore.js";
import { injectionNotes } from "./review/injection.js";
import { totalTokens } from "./cost/pricing.js";

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
  gatherContext?: (params: GatherContextParams) => Promise<GatheredContext>;
  runReview?: (input: ReviewInput, options?: RunReviewOptions) => Promise<ReviewResult>;
  gatherGrounding?: (params: GatherGroundingParams) => Promise<GroundingResult>;
  submitReview?: (
    octokit: OctokitLike,
    ref: PullRequestRef,
    payload: ReviewPayload,
    options?: SubmitReviewOptions
  ) => Promise<void>;
}

export interface ReviewPullRequestOptions {
  config?: ProviderConfig;
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
   * Per-review token budget (#18): caps agentic context retrieval and skips the
   * verification pass once spent; the over-budget total is reported. Resolved
   * from `budget.maxTokens`/`maxUsd` by the CLI. Specialist passes still run.
   */
  budgetTokens?: number;
  /** Run the skeptical false-positive verification pass (default true, #8). */
  verify?: boolean;
  /** Findings at/above this confidence skip verification (default 0.8, #8). */
  verifyConfidence?: number;
  guidelines?: string;
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
  /** Build the review but don't publish it. */
  dryRun?: boolean;
  deps?: PipelineDeps;
}

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
  const gather = deps.gatherContext ?? defaultGatherContext;
  const ground = deps.gatherGrounding ?? defaultGatherGrounding;
  const review = deps.runReview ?? defaultRunReview;
  const submit = deps.submitReview ?? defaultSubmitReview;

  const { meta, diff } = await fetchPr(octokit, ref);
  const parsed = parseDiff(diff);
  // Keep sensitive files out of the review entirely and out of size budgets.
  const { files: safeFiles, skipped: sensitiveSkipped } = filterSensitiveDiffFiles(parsed.files);
  // Drop generated/vendored files (#19) before size guards so they don't burn the
  // budget; reported as skipped, never dropped silently. Omitted config → built-in
  // defaults; an explicit list (including []) replaces them.
  const ignorePatterns = options.ignore ?? DEFAULT_IGNORE_GLOBS;
  const { files: keptFiles, skipped: ignoredSkipped } = filterIgnoredDiffFiles(safeFiles, ignorePatterns);
  const safeParsed = { files: keptFiles };
  const guarded = applyDiffLimits(safeParsed, options.diffLimits);
  const reviewFiles = guarded.files;
  const skipped: SkippedFile[] = [...guarded.skipped, ...sensitiveSkipped, ...ignoredSkipped];

  if (reviewFiles.length === 0) {
    const reviewResult = emptyReviewResult();
    const summaryBody = buildWalkthrough({
      findings: [],
      files: parsed.files,
      skipped,
      notes: ["No reviewable files remained after filters; provider review skipped."]
    });
    const payload = buildReviewPayload({
      findings: [],
      diff: { files: [] },
      summaryBody,
      event: options.event,
      agentPrompt: options.agentPrompt
    });

    const result = { meta, payload, review: reviewResult, usage: reviewResult.usage, skipped, contextFiles: 0, posted: false };
    if (!options.dryRun) {
      try {
        await submit(octokit, ref, payload, { commitId: meta.headSha, headSha: meta.headSha });
        result.posted = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ReviewPublishError(message, result);
      }
    }

    return result;
  }

  // Redact secrets from anything that will reach the provider.
  const redactionNotes: string[] = [];
  const renderedDiff = renderGuardedDiff(reviewFiles);
  const redactedDiff = redactSecrets(renderedDiff);
  const diffText = redactedDiff.text;
  if (redactedDiff.count > 0) {
    redactionNotes.push(`Redacted ${redactedDiff.count} secret(s) from the diff.`);
  }
  if (sensitiveSkipped.length > 0) {
    redactionNotes.push(`Skipped ${sensitiveSkipped.length} sensitive file(s) — kept out of the prompt.`);
  }

  let context: string | undefined;
  let contextFiles = 0;
  let contextUsage = emptyUsage();
  let contextNotes: string[] = [];
  let contextDegraded = false;
  if (!options.skipContext && options.toolkitRoot && reviewFiles.length > 0) {
    try {
      const gathered = await gather({
        toolkit: { root: options.toolkitRoot },
        changedPaths: reviewFiles.map((file) => file.path),
        config,
        // Cap the (otherwise unbounded) retrieval loop at the token budget (#18).
        limits: { ...options.contextLimits, maxTokens: options.budgetTokens }
      });
      contextFiles = gathered.files.length;
      contextUsage = gathered.usage;
      contextNotes = gathered.notes.map((note) => truncateNote(`Context retrieval: ${note}`));
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

  // Linter/SAST grounding (#16): run the repo's deterministic linters on the
  // changed files and feed the findings into the review so the LLM reconciles
  // rather than re-discovers. Degrades gracefully; never blocks the review.
  let grounding: ReviewInput["grounding"];
  let groundingNotes: string[] = [];
  if (!options.skipGrounding && options.toolkitRoot && reviewFiles.length > 0) {
    try {
      const result = await ground({
        root: options.toolkitRoot,
        changedPaths: reviewFiles.map((file) => file.path),
        changedLines: changedLinesByPath(reviewFiles),
        trustWorkspace: options.trustWorkspace === true,
        limits: options.groundingLimits
      });
      const redactedNotes = redactGroundingNotes(result.notes);
      groundingNotes = redactedNotes.notes.map((note) => truncateNote(`Linter grounding: ${note}`));
      const redacted = redactGroundingFindings(result.findings);
      const redactionCount = redacted.count + redactedNotes.count;
      if (redactionCount > 0) {
        redactionNotes.push(`Redacted ${redactionCount} secret(s) from linter grounding output.`);
      }
      if (redacted.findings.length > 0) {
        grounding = { findings: redacted.findings, summary: buildGroundingSummary(redacted.findings) };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      groundingNotes = [truncateNote(`Linter grounding failed; continuing without it: ${message}`)];
    }
  }

  // The verification gate sees the budget net of what context retrieval already
  // spent, so it skips the precision pass once the run is out of budget (#18).
  const reviewBudgetTokens =
    options.budgetTokens === undefined
      ? undefined
      : Math.max(0, options.budgetTokens - totalTokens(contextUsage));
  const reviewResult = await review(
    { diff: diffText, context, guidelines: options.guidelines, grounding },
    {
      config,
      minSeverity: options.minSeverity,
      minConfidence: options.minConfidence,
      maxFindings: options.maxFindings,
      verify: options.verify,
      verifyConfidence: options.verifyConfidence,
      maxTokens: reviewBudgetTokens
    }
  );

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

  const totalUsage = addUsage(reviewResult.usage, contextUsage);

  const summaryBody = buildWalkthrough({
    findings: reviewResult.findings,
    files: reviewFiles,
    skipped,
    coverage,
    degraded,
    notes: [
      ...injectionNotes(reviewFiles).map((note) => truncateNote(note)),
      ...redactionNotes,
      ...contextNotes,
      ...groundingNotes,
      ...verificationNotes(reviewResult),
      ...judgeNotes(reviewResult),
      ...reviewPassNotes(reviewResult),
      ...budgetNotes(totalUsage, options.budgetTokens).map((note) => truncateNote(note))
    ]
  });

  const payload = buildReviewPayload({
    findings: reviewResult.findings,
    diff: { files: reviewFiles },
    summaryBody,
    event: options.event,
    agentPrompt: options.agentPrompt,
    maxInlineComments: options.maxInlineComments
  });

  const result = {
    meta,
    payload,
    review: reviewResult,
    usage: totalUsage,
    skipped,
    contextFiles,
    posted: false
  };
  if (!options.dryRun) {
    try {
      await submit(octokit, ref, payload, { commitId: meta.headSha, headSha: meta.headSha });
      result.posted = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ReviewPublishError(message, result);
    }
  }

  return result;
}

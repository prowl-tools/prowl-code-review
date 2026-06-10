import type { OctokitLike } from "./github/client.js";
import {
  fetchPullRequest as defaultFetchPullRequest,
  type FetchedPullRequest,
  type PullRequestMeta,
  type PullRequestRef
} from "./github/diff.js";
import { submitReview as defaultSubmitReview } from "./github/review.js";
import { parseDiff } from "./review/parse-diff.js";
import { applyDiffLimits } from "./review/size-guards.js";
import type { DiffFile, DiffLimits, SkippedFile } from "./review/diff-types.js";
import { renderGuardedDiff } from "./review/render-diff.js";
import {
  gatherContext as defaultGatherContext,
  type GatherContextParams,
  type GatheredContext,
  type RetrievalLimits
} from "./context/retrieval.js";
import { runReview as defaultRunReview, type ReviewResult, type ReviewInput, type RunReviewOptions } from "./review/run-review.js";
import { buildWalkthrough } from "./review/walkthrough.js";
import { buildReviewPayload, type ReviewEvent, type ReviewPayload } from "./review/inline.js";
import { resolveProviderConfig, type ProviderConfig } from "./providers/index.js";
import type { Severity } from "./review/findings.js";
import { isSensitiveFile, redactSecrets } from "./review/redact.js";

/**
 * End-to-end PR review pipeline (backlog #11): fetch → parse → sensitivity
 * filter → size-guard → agentic context → multi-pass review + judge →
 * walkthrough → publish.
 *
 * Heavy stages are injectable so the orchestration is unit-testable without a
 * live provider or GitHub.
 */

/** Injectable pipeline stages (default to the library implementations). */
export interface PipelineDeps {
  fetchPullRequest?: (octokit: OctokitLike, ref: PullRequestRef) => Promise<FetchedPullRequest>;
  gatherContext?: (params: GatherContextParams) => Promise<GatheredContext>;
  runReview?: (input: ReviewInput, options?: RunReviewOptions) => Promise<ReviewResult>;
  submitReview?: (
    octokit: OctokitLike,
    ref: PullRequestRef,
    payload: ReviewPayload,
    commitId?: string
  ) => Promise<void>;
}

export interface ReviewPullRequestOptions {
  config?: ProviderConfig;
  /** Repo checkout root for agentic context; context is skipped if unset. */
  toolkitRoot?: string;
  diffLimits?: DiffLimits;
  contextLimits?: RetrievalLimits;
  minSeverity?: Severity;
  /** Drop non-critical findings below this confidence (default 0.5, #55). */
  minConfidence?: number;
  /** Cap the number of findings surfaced (default 25, #55). */
  maxFindings?: number;
  guidelines?: string;
  event?: ReviewEvent;
  /** Skip agentic cross-file context retrieval (e.g. fork PRs / cost control). */
  skipContext?: boolean;
  /** Build the review but don't publish it. */
  dryRun?: boolean;
  deps?: PipelineDeps;
}

export interface ReviewPullRequestResult {
  meta: PullRequestMeta;
  payload: ReviewPayload;
  review: ReviewResult;
  /** Files omitted by size guards (reported, never dropped silently). */
  skipped: SkippedFile[];
  /** Number of files the agentic retriever pulled in. */
  contextFiles: number;
  /** True when the review was published (false on dry run). */
  posted: boolean;
}

/** Keep operational review notes compact enough for a readable summary. */
function truncateNote(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
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

/** Treat both sides of a rename as sensitive-path evidence. */
function isSensitiveDiffFile(file: DiffFile): boolean {
  return isSensitiveFile(file.path) || (file.oldPath !== undefined && isSensitiveFile(file.oldPath));
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
  const review = deps.runReview ?? defaultRunReview;
  const submit = deps.submitReview ?? defaultSubmitReview;

  const { meta, diff } = await fetchPr(octokit, ref);
  const parsed = parseDiff(diff);
  // Keep sensitive files out of the review entirely and out of size budgets.
  const safeParsed = {
    files: parsed.files.filter((file) => !isSensitiveDiffFile(file))
  };
  const sensitiveSkipped: SkippedFile[] = parsed.files
    .filter((file) => isSensitiveDiffFile(file))
    .map((file) => ({ path: file.path, reason: "sensitive" }));
  const guarded = applyDiffLimits(safeParsed, options.diffLimits);
  const reviewFiles = guarded.files;
  const skipped: SkippedFile[] = [...guarded.skipped, ...sensitiveSkipped];

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
  let contextNotes: string[] = [];
  if (!options.skipContext && options.toolkitRoot && reviewFiles.length > 0) {
    try {
      const gathered = await gather({
        toolkit: { root: options.toolkitRoot },
        changedPaths: reviewFiles.map((file) => file.path),
        config,
        limits: options.contextLimits
      });
      contextFiles = gathered.files.length;
      contextNotes = gathered.notes.map((note) => truncateNote(`Context retrieval: ${note}`));
      if (gathered.files.length > 0) {
        const joined = gathered.files.map((file) => `# ${file.path}\n${file.content}`).join("\n\n");
        // Defense-in-depth: tool reads are already redacted, but redact again.
        context = redactSecrets(joined).text;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      contextNotes = [truncateNote(`Context retrieval failed; continuing without extra context: ${message}`)];
    }
  }

  const reviewResult = await review(
    { diff: diffText, context, guidelines: options.guidelines },
    {
      config,
      minSeverity: options.minSeverity,
      minConfidence: options.minConfidence,
      maxFindings: options.maxFindings
    }
  );

  const summaryBody = buildWalkthrough({
    findings: reviewResult.findings,
    files: reviewFiles,
    skipped,
    notes: [
      ...redactionNotes,
      ...contextNotes,
      ...judgeNotes(reviewResult),
      ...reviewPassNotes(reviewResult)
    ]
  });

  const payload = buildReviewPayload({
    findings: reviewResult.findings,
    diff: { files: reviewFiles },
    summaryBody,
    event: options.event
  });

  let posted = false;
  if (!options.dryRun) {
    await submit(octokit, ref, payload, meta.headSha);
    posted = true;
  }

  return { meta, payload, review: reviewResult, skipped, contextFiles, posted };
}

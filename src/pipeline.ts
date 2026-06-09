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
import type { DiffLimits, SkippedFile } from "./review/diff-types.js";
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

/**
 * End-to-end PR review pipeline (backlog #11): fetch → parse → size-guard →
 * agentic context → multi-pass review + judge → walkthrough → publish.
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

function truncateNote(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

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
  const guarded = applyDiffLimits(parsed, options.diffLimits);
  const diffText = renderGuardedDiff(guarded.files);

  let context: string | undefined;
  let contextFiles = 0;
  let contextNotes: string[] = [];
  if (!options.skipContext && options.toolkitRoot && guarded.files.length > 0) {
    const gathered = await gather({
      toolkit: { root: options.toolkitRoot },
      changedPaths: guarded.files.map((file) => file.path),
      config,
      limits: options.contextLimits
    });
    contextFiles = gathered.files.length;
    contextNotes = gathered.notes.map((note) => truncateNote(`Context retrieval: ${note}`));
    if (gathered.files.length > 0) {
      context = gathered.files.map((file) => `# ${file.path}\n${file.content}`).join("\n\n");
    }
  }

  const reviewResult = await review(
    { diff: diffText, context, guidelines: options.guidelines },
    { config, minSeverity: options.minSeverity }
  );

  const summaryBody = buildWalkthrough({
    findings: reviewResult.findings,
    files: guarded.files,
    skipped: guarded.skipped,
    notes: [...contextNotes, ...reviewPassNotes(reviewResult)]
  });

  const payload = buildReviewPayload({
    findings: reviewResult.findings,
    diff: { files: guarded.files },
    summaryBody,
    event: options.event
  });

  let posted = false;
  if (!options.dryRun) {
    await submit(octokit, ref, payload, meta.headSha);
    posted = true;
  }

  return { meta, payload, review: reviewResult, skipped: guarded.skipped, contextFiles, posted };
}

/**
 * prowl-review — programmatic (library) surface.
 *
 * The review engine grows here as modules land, so the same core can back the
 * CLI, the GitHub Action, and a future hosted app.
 */
/** Package name exposed for consumers that need to identify this library. */
export const PACKAGE_NAME = "prowl-review";

// End-to-end PR review pipeline (the integration entry point).
export {
  reviewPullRequest,
  type ReviewPullRequestOptions,
  type ReviewPullRequestResult,
  type PipelineDeps
} from "./pipeline.js";
export { renderGuardedDiff } from "./review/render-diff.js";
export { redactSecrets, isSensitiveFile, type RedactionResult } from "./review/redact.js";

// Multi-provider BYOK LLM abstraction (Claude / OpenAI / Gemini) + prompt caching.
export {
  complete,
  completeWithTools,
  getProvider,
  resolveProviderConfig,
  DEFAULT_MODELS,
  DEFAULT_MAX_TOKENS,
  PROVIDER_NAMES,
  emptyUsage,
  type Provider,
  type ProviderName,
  type ProviderConfig,
  type CompletionRequest,
  type CompletionResult,
  type TokenUsage,
  type ToolDefinition,
  type ToolCall,
  type ToolResult,
  type ToolMessage,
  type ToolCompletionRequest,
  type ToolCompletionResult
} from "./providers/index.js";

// Agentic cross-file context retrieval (sandboxed tools + tool-use loop).
export {
  listRepoFiles,
  listRepoFilesDetailed,
  readRepoFile,
  searchRepo,
  RepoAccessError,
  DEFAULT_IGNORE,
  type ToolkitOptions,
  type ListFilesResult,
  type ReadFileResult,
  type SearchMatch,
  type SearchOptions,
  type SearchResult
} from "./context/tools.js";
export {
  gatherContext,
  REVIEW_TOOLS,
  type GatherContextParams,
  type GatheredContext,
  type RetrievedFile,
  type RetrievedToolOutput,
  type RetrievalLimits
} from "./context/retrieval.js";

// GitHub PR diff + metadata fetch.
export { createOctokit, type OctokitLike } from "./github/client.js";
export {
  fetchPullRequest,
  type PullRequestRef,
  type PullRequestMeta,
  type FetchedPullRequest
} from "./github/diff.js";
export {
  submitReview,
  planPublish,
  type SubmitReviewOptions,
  type PublishPlan,
  type PriorSummaryComment
} from "./github/review.js";
export {
  findingFingerprint,
  serializeState,
  parseState,
  embedState,
  REVIEW_STATE_VERSION,
  ReviewStateSchema,
  type ReviewState
} from "./review/state.js";

// Inline comments + committable suggestions (the published review).
export {
  buildInlineComments,
  buildReviewPayload,
  formatFindingComment,
  type ReviewComment,
  type ReviewEvent,
  type ReviewSide,
  type ReviewPayload,
  type InlineMapping
} from "./review/inline.js";

// Unified-diff parsing + size guards.
export { parseDiff } from "./review/parse-diff.js";
export { applyDiffLimits, describeSkipped } from "./review/size-guards.js";
export type {
  ParsedDiff,
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffLine,
  DiffLineType,
  DiffLimits,
  GuardedDiff,
  SkippedFile,
  SkipReason
} from "./review/diff-types.js";

// Multi-pass specialized review + judge/dedup.
export {
  FindingSchema,
  parseFindings,
  findingKey,
  SEVERITIES,
  SEVERITY_ORDER,
  type Finding,
  type Severity
} from "./review/findings.js";
export {
  judgeFindings,
  dedupeFindings,
  rankFindings,
  filterBySeverity,
  filterByConfidence,
  DEFAULT_MIN_SEVERITY,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MAX_FINDINGS,
  type JudgeOptions,
  type JudgeResult
} from "./review/judge.js";
export {
  DEFAULT_SPECIALISTS,
  buildSharedSystem,
  buildSpecialistDirective,
  buildSpecialistPrompt,
  type Specialist
} from "./review/specialists.js";
export {
  buildWalkthrough,
  reviewCommentState,
  severityCounts,
  deriveImpact,
  deriveEffort,
  REVIEW_MARKER,
  type WalkthroughInput,
  type Impact,
  type ReviewCommentState
} from "./review/walkthrough.js";
export {
  verifyFindings,
  parseVerdicts,
  buildVerifySystem,
  buildVerifyPrompt,
  DEFAULT_VERIFY_CONFIDENCE,
  VerdictSchema,
  type Verdict,
  type VerifyInput,
  type VerifyOptions,
  type VerifyResult
} from "./review/verify.js";
export {
  runReview,
  type ReviewInput,
  type RunReviewOptions,
  type ReviewResult,
  type SpecialistPassReport
} from "./review/run-review.js";

// Quality eval harness (benchmark scoring + runner).
export {
  BenchmarkCaseSchema,
  ExpectedBugSchema,
  CASE_KINDS,
  DEFAULT_LINE_WINDOW,
  type BenchmarkCase,
  type ExpectedBug,
  type CaseKind,
  type CaseResult,
  type MatchOptions,
  type EvalMetrics,
  type EvalReport
} from "./eval/types.js";
export { matchesBug, scoreCase, erroredCase } from "./eval/match.js";
export { aggregate, precision, recall, f1Score } from "./eval/metrics.js";
export { loadBenchmark, loadCase } from "./eval/load.js";
export { runBenchmark, type RunBenchmarkOptions, type ReviewKnobs } from "./eval/runner.js";
export { renderReportMarkdown, renderReportJson } from "./eval/report.js";
export { promptFingerprint } from "./eval/version.js";

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
  ReviewPublishError,
  reviewPullRequest,
  type ReviewPullRequestOptions,
  type ReviewPullRequestResult,
  type ThreadTidyResult,
  type PipelineDeps
} from "./pipeline.js";
export { renderGuardedDiff } from "./review/render-diff.js";
export { redactSecrets, isSensitiveFile, type RedactionResult } from "./review/redact.js";

// Debug/verbose run tracing (#49): structured, redacted, line-per-event JSONL.
export {
  createDebugSink,
  createDebugRecorder,
  createJsonlSink,
  toDebugFindings,
  type DebugEvent,
  type DebugSink,
  type DebugRecord,
  type DebugFinding
} from "./debug/trace.js";

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

// `.prowl-review.yml` configuration (loader + schema).
export {
  loadConfig,
  findConfigPath,
  CONFIG_FILENAME,
  CONFIG_FILENAMES,
  type LoadConfigOptions,
  type LoadedConfig
} from "./config/loader.js";
export { configSchema, type ProwlReviewConfig } from "./config/schema.js";
export { CONFIG_TEMPLATE } from "./config/template.js";

// Linter / SAST grounding (deterministic findings fed into the review).
export {
  gatherGrounding,
  buildGroundingSummary,
  parseEslintJson,
  parseOsvJson,
  parseSemgrepJson,
  dependencyScanTargets,
  DEFAULT_MAX_FILES as DEFAULT_GROUNDING_MAX_FILES,
  DEFAULT_MAX_FINDINGS as DEFAULT_GROUNDING_MAX_FINDINGS,
  DEFAULT_TIMEOUT_MS as DEFAULT_GROUNDING_TIMEOUT_MS,
  DEFAULT_SEMGREP_CONFIG,
  type GatherGroundingParams,
  type GroundingResult,
  type GroundingLimits,
  type DependencyScanOptions,
  type SemgrepOptions,
  type Exec,
  type ExecOptions,
  type ExecResult
} from "./grounding/index.js";

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
  ContextRetrievalError,
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
  fetchComparisonDiff,
  fetchPullRequestHeadSha,
  fetchPullRequestMeta,
  updatePullRequestBody,
  type PullRequestRef,
  type PullRequestMeta,
  type FetchedPullRequest
} from "./github/diff.js";
export {
  generatePrDescription,
  shouldDescribePr,
  embedPrDescription,
  renderDescriptionBlock,
  buildDescriptionSystem,
  buildDescriptionPrompt,
  PR_SUMMARY_START,
  PR_SUMMARY_END,
  DEFAULT_DESCRIPTION_MAX_TOKENS,
  type PrDescriptionInput
} from "./review/pr-description.js";
export { parseIssueReferences, formatIssueRef, type IssueRef } from "./review/issue-refs.js";
export { fetchIssue, type FetchedIssue } from "./github/issues.js";
export {
  submitReview,
  planPublish,
  fetchPriorReviewState,
  hasActiveRequestChanges,
  setPausedState,
  setIgnoredFindings,
  fetchReviewCommentFingerprints,
  postPullRequestComment,
  type SubmitReviewOptions,
  type SubmitReviewResult,
  type PriorRequestChangesState,
  type PublishPlan,
  type PriorSummaryComment
} from "./github/review.js";
export {
  parseCommand,
  commandHelpText,
  isTrustedCommandAuthor,
  COMMAND_VERBS,
  TRUSTED_COMMAND_ASSOCIATIONS,
  type CommandVerb,
  type ParsedCommand
} from "./review/commands.js";
export {
  generateChatReply,
  sanitizeChatReplyMarkdown,
  buildChatSystem,
  buildChatPrompt,
  DEFAULT_CHAT_MAX_TOKENS,
  type ChatReplyInput,
  type ChatThreadContext
} from "./review/chat.js";
export {
  planCheckRun,
  submitCheckRun,
  annotationLevelFor,
  CHECK_RUN_NAME,
  CHECK_ANNOTATION_BATCH,
  type CheckRunPlan,
  type CheckConclusion,
  type CheckAnnotation,
  type AnnotationLevel
} from "./github/check-run.js";
export {
  detectBreakGlass,
  matchesBreakGlass,
  BREAK_GLASS_RE,
  BREAK_GLASS_TRUSTED_ASSOCIATIONS
} from "./github/break-glass.js";
export {
  fetchReviewThreads,
  resolveReviewThread,
  planThreadActions,
  type ReviewThread,
  type ThreadActionPlan,
  type ThreadResolveReason
} from "./github/threads.js";
export {
  classifyReplyIntent,
  isResolvingIntent,
  isDisputingIntent,
  type ReplyIntent
} from "./review/reply-intent.js";
export {
  findingFingerprint,
  serializeState,
  parseState,
  embedState,
  REVIEW_STATE_VERSION,
  ReviewStateSchema,
  type ReviewState
} from "./review/state.js";

// Local pre-push review mode (#35): diff git refs + render findings to the terminal.
export {
  resolveLocalDiff,
  defaultGitExec,
  LocalDiffError,
  type GitExec,
  type ResolveLocalDiffOptions
} from "./review/local-diff.js";
export {
  formatLocalReport,
  formatLocalReportJson,
  formatSummaryLine,
  severityBreakdown,
  findingLocation,
  type TerminalFormatOptions
} from "./review/format-terminal.js";
export {
  runLocalReview,
  resolveColor,
  meetsFailThreshold,
  type LocalReviewCommandOptions,
  type LocalReviewDeps,
  type LocalReviewResult
} from "./cli/commands/review-local.js";

// Inline comments + committable suggestions (the published review).
export {
  buildInlineComments,
  buildReviewPayload,
  formatFindingComment,
  DEFAULT_MAX_INLINE_COMMENTS,
  type FindingCommentOptions,
  type ReviewComment,
  type ReviewEvent,
  type ReviewSide,
  type ReviewPayload,
  type InlineMapping
} from "./review/inline.js";

// Suggested-fix validation (#39): gate committable suggestions by confidence + structure.
export {
  validateSuggestion,
  shouldCommitSuggestion,
  summarizeSuggestionGating,
  DEFAULT_SUGGESTION_MIN_CONFIDENCE,
  type SuggestionValidation,
  type SuggestionGatingSummary
} from "./review/suggestions.js";

// Unified-diff parsing + size guards.
export { parseDiff } from "./review/parse-diff.js";
export { applyDiffLimits, describeSkipped } from "./review/size-guards.js";
export { filterIgnoredDiffFiles, isIgnoredPath, DEFAULT_IGNORE_GLOBS } from "./review/ignore.js";
export { detectInjectionAttempts, injectionNotes, looksLikeInjection, type InjectionHit } from "./review/injection.js";

// Token-usage + cost logging (estimate, local log, aggregation).
export {
  estimateCost,
  resolveModelPrice,
  resolveTokenBudget,
  resolveTokenBudgetForTargets,
  totalTokens,
  formatUsd,
  formatCostLine,
  DEFAULT_PRICES,
  type ModelPrice,
  type PriceOverrides,
  type CostEstimate,
  type Budget,
  type BudgetTarget
} from "./cost/pricing.js";
export {
  appendUsageRecord,
  readUsageRecords,
  aggregateUsage,
  aggregateUsageAsync,
  assertNoWorkspaceSymlinks,
  toUsageRecord,
  defaultUsageLogPath,
  findUsageLog,
  USAGE_LOG_DIR,
  USAGE_LOG_FILENAME,
  type UsageRecord,
  type AppendUsageRecordOptions,
  type UsageGroup,
  type UsageAggregate
} from "./cost/usage-log.js";
export { renderCostReportMarkdown, renderCostReportJson } from "./cost/report.js";
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
  LANGUAGES,
  detectLanguage,
  isJavaScriptFamily,
  summarizeLanguages,
  type LanguageId,
  type LanguageCount
} from "./review/language.js";
export {
  FindingSchema,
  ProviderPerspectiveSchema,
  parseFindings,
  parseFindingsResult,
  findingKey,
  isBlockingFinding,
  SEVERITIES,
  SEVERITY_ORDER,
  type Finding,
  type ProviderPerspective,
  type ParsedFindings,
  type Severity
} from "./review/findings.js";
export {
  judgeFindings,
  judgeEnsembleFindings,
  consensusConfidence,
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
  runEnsembleReview,
  type EnsembleReviewResult,
  type EnsembleProviderReport,
  type RunEnsembleOptions
} from "./review/ensemble.js";
export { withHeartbeat, type HeartbeatOptions } from "./review/heartbeat.js";
export {
  DEFAULT_SPECIALISTS,
  BUILTIN_SPECIALIST_KEYS,
  REQUIREMENTS_SPECIALIST,
  REQUIREMENTS_SPECIALIST_KEY,
  resolveSpecialists,
  buildSharedSystem,
  buildSpecialistDirective,
  buildSpecialistPrompt,
  type Specialist,
  type SpecialistsConfig,
  type CustomSpecialistConfig
} from "./review/specialists.js";
export {
  diffComplexity,
  selectRiskTier,
  planOrchestration,
  DEFAULT_TIER_THRESHOLDS,
  MINIMAL_TIER_BUILTINS,
  TIER_CONTEXT_LIMITS,
  type RiskTier,
  type RiskTieringConfig,
  type DiffComplexity,
  type RiskTierSelection,
  type TierPlan
} from "./review/risk-tier.js";
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
  parseVerdictsResult,
  buildVerifySystem,
  buildVerifyPrompt,
  DEFAULT_VERIFY_CONFIDENCE,
  VerdictSchema,
  type Verdict,
  type ParsedVerdicts,
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
export {
  planApprovalDecision,
  approvalNotes,
  DEFAULT_REQUEST_CHANGES_AT,
  type ApprovalConfig,
  type ApprovalDecision,
  type BreakGlassSignal
} from "./review/approval.js";

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

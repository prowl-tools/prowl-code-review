/**
 * prowl-review — programmatic (library) surface.
 *
 * The review engine grows here as modules land, so the same core can back the
 * CLI, the GitHub Action, and a future hosted app.
 */
/** Package name exposed for consumers that need to identify this library. */
export const PACKAGE_NAME = "prowl-review";

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
  severityCounts,
  deriveImpact,
  deriveEffort,
  REVIEW_MARKER,
  type WalkthroughInput,
  type Impact
} from "./review/walkthrough.js";
export {
  runReview,
  type ReviewInput,
  type RunReviewOptions,
  type ReviewResult,
  type SpecialistPassReport
} from "./review/run-review.js";

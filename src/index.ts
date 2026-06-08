/**
 * prowl-review — programmatic (library) surface.
 *
 * The review engine grows here as modules land, so the same core can back the
 * CLI, the GitHub Action, and a future hosted app.
 */
export const PACKAGE_NAME = "prowl-review";

// Multi-provider BYOK LLM abstraction (Claude / OpenAI / Gemini) + prompt caching.
export {
  complete,
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
  type TokenUsage
} from "./providers/index.js";

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

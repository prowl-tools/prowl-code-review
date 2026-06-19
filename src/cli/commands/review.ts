import { Command } from "commander";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createOctokit, type OctokitLike } from "../../github/client.js";
import { submitCheckRun, type CheckRunPlan, type CheckConclusion } from "../../github/check-run.js";
import type { PullRequestRef } from "../../github/diff.js";
import { fetchPriorReviewState } from "../../github/review.js";
import {
  ReviewPublishError,
  reviewPullRequest,
  type ReviewPullRequestOptions,
  type ReviewPullRequestResult
} from "../../pipeline.js";
import { resolveProviderConfig, type ProviderConfig } from "../../providers/index.js";
import { loadConfig, type LoadConfigOptions } from "../../config/loader.js";
import type { ProwlReviewConfig } from "../../config/schema.js";
import { SEVERITIES, type Severity } from "../../review/findings.js";
import { resolveSpecialists } from "../../review/specialists.js";
import { estimateCost, formatCostLine, resolveTokenBudget, type PriceOverrides } from "../../cost/pricing.js";
import { appendUsageRecord, toUsageRecord, defaultUsageLogPath } from "../../cost/usage-log.js";

/**
 * `prowl-review review` — review a pull request and publish findings.
 *
 * The entry point invoked by the GitHub Action: reads `GITHUB_TOKEN` +
 * `PROWL_AI_KEY` from the environment, resolves the repo/PR from flags or the
 * GitHub event, runs the full pipeline, and publishes (or, with `--dry-run`,
 * just reports) the review.
 */

/** Resolve and validate the target repository from a flag or GitHub Actions env. */
export function resolveRepo(flag?: string): { owner: string; repo: string } {
  const value = flag ?? process.env.GITHUB_REPOSITORY;
  if (!value) {
    throw new Error("Repository required: pass --repo <owner/repo> or set GITHUB_REPOSITORY.");
  }
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Repository required: pass --repo <owner/repo> or set GITHUB_REPOSITORY.");
  }
  const [owner, repo] = parts;
  return { owner, repo };
}

/** Resolve and validate the pull request number from a flag or event payload. */
export function resolvePullNumber(flag?: string): number {
  if (flag) {
    const parsed = Number(flag);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --pr: ${flag}`);
    }
    return parsed;
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
        pull_request?: { number?: number };
        number?: number;
      };
      const number = event.pull_request?.number ?? event.number;
      if (number) {
        return number;
      }
    } catch {
      // fall through to the error below
    }
  }
  throw new Error("Pull request number required: pass --pr <n> (or run on a pull_request event).");
}

/** Read a UTF-8 file, returning undefined when it is absent or unreadable. */
function readOptionalFile(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Load optional review guidelines from the repository root, preferring REVIEW_GUIDELINES.md. */
export function loadGuidelines(root: string): string | undefined {
  for (const name of ["REVIEW_GUIDELINES.md", "CLAUDE.md"]) {
    const content = readOptionalFile(join(root, name));
    if (content !== undefined) {
      return content;
    }
  }
  return undefined;
}

/** Load optional learned false-positive patterns (LEARNED_PATTERNS.md) from a trusted root (#30). */
export function loadLearnedPatterns(root: string): string | undefined {
  return readOptionalFile(join(root, "LEARNED_PATTERNS.md"));
}

/**
 * Resolve the optional org-wide guidelines file injected into every repo's review
 * (#30). Trusted (out-of-band like the guidelines workspace), so it comes from an
 * env var / Action input, never untrusted repo config.
 */
export function resolveOrgGuidelinesPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PROWL_ORG_GUIDELINES_PATH?.trim() || undefined;
}

/**
 * Compose org-wide and per-repo guidelines into one block (#30). When both are
 * present they are kept under clear sub-headers; otherwise whichever exists is
 * used as-is.
 */
export function composeGuidelines(org: string | undefined, repo: string | undefined): string | undefined {
  const normalizedOrg = org?.trim() ? org : undefined;
  const normalizedRepo = repo?.trim() ? repo : undefined;
  if (normalizedOrg && normalizedRepo) {
    return `## Organization standards\n${normalizedOrg}\n\n## Repository standards\n${normalizedRepo}`;
  }
  return normalizedOrg ?? normalizedRepo;
}

/** Parse an optional severity threshold for filtering findings. */
export function parseMinSeverity(value: string | undefined): Severity | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (!(SEVERITIES as readonly string[]).includes(normalized)) {
    throw new Error(`Invalid --min-severity: ${value} (use one of ${SEVERITIES.join(", ")}).`);
  }
  return normalized as Severity;
}

/** Resolve the repository checkout used by context retrieval. */
export function resolveWorkspace(): string {
  return process.env.PROWL_WORKSPACE || process.env.GITHUB_WORKSPACE || process.cwd();
}

/** Resolve the explicit trusted checkout used to load review guidelines. */
export function resolveGuidelinesWorkspace(): string | undefined {
  return process.env.PROWL_GUIDELINES_WORKSPACE?.trim() || undefined;
}

/** Resolve whether repo-local tooling may execute in the review workspace. */
export function resolveTrustWorkspace(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.PROWL_TRUST_WORKSPACE?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

/** Detect fork PR events where repo-local tooling must not be trusted. */
export function isForkPullRequestEvent(env: NodeJS.ProcessEnv = process.env): boolean {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) {
    return false;
  }
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: { head?: { repo?: { fork?: boolean; full_name?: string } } };
    };
    const headRepo = event.pull_request?.head?.repo;
    if (!headRepo) {
      return false;
    }
    if (headRepo.fork === true) {
      return true;
    }
    const baseRepository = env.GITHUB_REPOSITORY?.trim().toLowerCase();
    const headRepository = headRepo.full_name?.trim().toLowerCase();
    return Boolean(baseRepository && headRepository && baseRepository !== headRepository);
  } catch {
    return false;
  }
}

/** Resolve the PR head SHA represented by the checked-out Action workspace. */
export function resolveReviewedHeadSha(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.PROWL_REVIEWED_HEAD_SHA?.trim();
  if (explicit) {
    return explicit;
  }
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
        pull_request?: { head?: { sha?: string } };
      };
      return event.pull_request?.head?.sha?.trim() || undefined;
    } catch {
      // fall through to undefined
    }
  }
  return undefined;
}

interface ReviewCommandOptions {
  pr?: string;
  repo?: string;
  minSeverity?: string;
  context?: boolean;
  verify?: boolean;
  /** `--no-incremental` → false; otherwise true/undefined (#23). */
  incremental?: boolean;
  /** `--no-resolve-threads` → false; otherwise true/undefined (#22). */
  resolveThreads?: boolean;
  grounding?: boolean;
  trustWorkspace?: boolean;
  agentPrompt?: boolean;
  dryRun?: boolean;
  /** `--config <path>` → string; `--no-config` → false; otherwise true/undefined. */
  config?: string | boolean;
}

/** The pipeline-tuning options derived from CLI flags + the config file. */
type ResolvedReviewOptions = Pick<
  ReviewPullRequestOptions,
  | "minSeverity"
  | "minConfidence"
  | "maxFindings"
  | "verify"
  | "verifyConfidence"
  | "skipContext"
  | "contextLimits"
  | "skipGrounding"
  | "trustWorkspace"
  | "diffLimits"
  | "agentPrompt"
  | "ignore"
  | "maxInlineComments"
  | "specialists"
  | "riskTiering"
  | "incremental"
  | "resolveThreads"
  | "checkRun"
  | "approval"
>;

/** Drop undefined entries so an object of all-undefined collapses to undefined. */
function compact<T extends Record<string, unknown>>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

function truthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function envString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** Resolve config-loading inputs from CLI flags and trusted Action env. */
export function resolveConfigLoadOptions(
  cli: ReviewCommandOptions,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): LoadConfigOptions {
  if (cli.config === false) {
    return { cwd, disabled: true };
  }

  const configPath = typeof cli.config === "string" ? cli.config : envString(env.PROWL_CONFIG_PATH);
  if (configPath) {
    return { cwd, configPath };
  }

  if (truthyEnv(env.PROWL_NO_CONFIG)) {
    return { cwd, disabled: true };
  }

  return { cwd };
}

/** Resolve whether the review should publish or just render output. */
export function resolveDryRun(
  cli: ReviewCommandOptions,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(cli.dryRun) || truthyEnv(env.PROWL_DRY_RUN);
}

async function maybeSubmitPausedCheckRun(
  octokit: OctokitLike,
  ref: PullRequestRef,
  input: {
    checkRun?: ProwlReviewConfig["checkRun"];
    dryRun: boolean;
    headSha?: string;
  }
): Promise<CheckConclusion | undefined> {
  if (input.dryRun || !input.checkRun?.enabled || !input.headSha) {
    return undefined;
  }

  const plan: CheckRunPlan = {
    conclusion: "neutral",
    title: "Auto-review paused",
    summary:
      "prowl-review is paused for this pull request. Comment `@prowl-review resume` to re-enable automatic reviews.\n\n" +
      "No review was run for this commit.",
    annotations: []
  };

  try {
    await submitCheckRun(octokit, ref, { headSha: input.headSha, plan });
    return plan.conclusion;
  } catch {
    return undefined;
  }
}

/**
 * Resolve where (if anywhere) to append the per-run usage record (#36).
 * `PROWL_USAGE_LOG` wins when it stays inside the workspace; otherwise local
 * runs log under the workspace, while ephemeral GitHub Actions runs skip the
 * log (cost still goes to the logs + job summary) since the file wouldn't
 * survive the runner.
 */
export function resolveUsageLogPath(workspace: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const workspaceRoot = resolve(workspace);
  const explicit = envString(env.PROWL_USAGE_LOG);
  if (explicit) {
    const explicitPath = resolve(workspaceRoot, explicit);
    const relativePath = relative(workspaceRoot, explicitPath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return null;
    }
    return explicitPath;
  }
  if (env.GITHUB_ACTIONS === "true") {
    return null;
  }
  return defaultUsageLogPath(workspaceRoot);
}

/**
 * Merge CLI flags with the `.prowl-review.yml` config into pipeline options.
 * Precedence is **CLI flag > config file > built-in default**: an omitted value
 * stays `undefined` so the pipeline/judge applies its own default. A disable
 * from either the CLI or the config switches a stage off (the CLI has no
 * positive re-enable flag). Workspace trust is intentionally out-of-band:
 * only the CLI flag or environment may enable repo-local code execution.
 * Pure and env-injectable for testing.
 */
export function resolveReviewOptions(
  cli: ReviewCommandOptions,
  config: ProwlReviewConfig,
  env: NodeJS.ProcessEnv = process.env
): ResolvedReviewOptions {
  const minSeverity = cli.minSeverity ?? envString(env.PROWL_MIN_SEVERITY);
  const requestedTrustWorkspace = cli.trustWorkspace ?? resolveTrustWorkspace(env);

  return {
    minSeverity: parseMinSeverity(minSeverity) ?? config.review?.minSeverity,
    minConfidence: config.review?.minConfidence,
    maxFindings: config.review?.maxFindings,
    maxInlineComments: config.review?.maxInlineComments,
    verify: cli.verify === false ? false : config.review?.verify,
    verifyConfidence: config.review?.verifyConfidence,
    // CLI --no-incremental (or config) forces a full-PR review (#23).
    incremental: cli.incremental === false ? false : config.review?.incremental,
    // CLI --no-resolve-threads (or config) leaves prior threads untouched (#22).
    resolveThreads: cli.resolveThreads === false ? false : config.review?.resolveThreads,
    skipContext:
      cli.context === false || config.context?.enabled === false ? true : undefined,
    contextLimits: compact({
      maxRounds: config.context?.maxRounds,
      maxFiles: config.context?.maxFiles
    }),
    skipGrounding:
      cli.grounding === false || config.grounding?.enabled === false ? true : undefined,
    trustWorkspace: requestedTrustWorkspace && !isForkPullRequestEvent(env),
    diffLimits: compact({
      maxFiles: config.diff?.maxFiles,
      maxDiffBytes: config.diff?.maxBytes
    }),
    // Default on; CLI `--no-agent-prompt` (or `agentPrompt: false` in config) turns it off.
    agentPrompt: cli.agentPrompt === false || config.agentPrompt === false ? false : undefined,
    // Omitted → built-in defaults; an explicit list (including []) replaces them (#19).
    ignore: config.ignore,
    // Omitted → the pipeline's built-in specialist set; config composes built-ins + custom (#51).
    specialists: config.specialists ? resolveSpecialists(config.specialists) : undefined,
    // Omitted → tiering on with built-in thresholds; config can tune or disable it (#31).
    riskTiering: config.riskTiering,
    // Merge gate (#24); opt-in via config (needs checks: write).
    checkRun: config.checkRun,
    // Approval rubric + break-glass (#52); opt-in via config.
    approval: config.approval
  };
}

interface ReportReviewCommandResultOptions {
  owner: string;
  repo: string;
  pullNumber: number;
  root: string;
  providerConfig: ProviderConfig;
  pricing?: PriceOverrides;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  publishFailed?: boolean;
}

export function reportReviewCommandResult(
  result: ReviewPullRequestResult,
  options: ReportReviewCommandResultOptions
): void {
  const env = options.env ?? process.env;
  const count = result.review.findings.length;
  const inline = result.payload.comments.length;
  const publishStatus = result.posted
    ? "— posted"
    : options.publishFailed
      ? "— publish failed (not posted)"
      : result.headAdvanced
        ? "— skipped (PR head advanced; superseded by a newer run)"
        : "— dry run (not posted)";

  console.log(
    `prowl-review: ${count} finding(s), ${inline} inline, ${result.contextFiles} context file(s) on ` +
      `${options.owner}/${options.repo}#${options.pullNumber} ${publishStatus}`
  );
  if (result.checkRunConclusion) {
    console.log(`prowl-review: merge-gate check run → ${result.checkRunConclusion}`);
  }
  if (result.approval?.enabled) {
    const verdict = result.approval.event.toLowerCase().replace("_", " ");
    const override = result.approval.overridden
      ? ` (break-glass override${result.approval.overrideActor ? ` by @${result.approval.overrideActor}` : ""})`
      : "";
    console.log(`prowl-review: approval gate → ${verdict}${override}`);
  }
  if (result.threads) {
    const t = result.threads;
    const resolved = t.resolvedFixed + t.resolvedSettled;
    const withheld = t.withheldSettled + t.withheldDisputed;
    if (resolved > 0 || withheld > 0) {
      console.log(
        `prowl-review: threads → resolved ${resolved}, withheld ${withheld} (disputed ${t.withheldDisputed})`
      );
    }
  }

  const outputPath = env.GITHUB_OUTPUT;
  if (outputPath) {
    try {
      appendFileSync(outputPath, `findings=${count}\nposted=${result.posted}\n`);
    } catch {
      // non-fatal: output file unavailable
    }
  }

  // Per-review cost transparency (#36): emit to logs + the Action job summary
  // (never the PR comment), and append to the local usage log for `costs`.
  const cost = estimateCost(
    result.usage,
    options.providerConfig.provider,
    options.providerConfig.model,
    options.pricing ?? {}
  );
  // The chosen risk tier (#31) is logged alongside the cost so a run's spend is
  // attributable to its orchestration tier.
  const tierSuffix = result.riskTier ? ` · risk tier: ${result.riskTier}` : "";
  console.log(`prowl-review cost: ${formatCostLine(cost)}${tierSuffix}`);

  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `### prowl-review cost\n\n- ${formatCostLine(cost)}${tierSuffix}\n`);
    } catch {
      // non-fatal: job summary unavailable
    }
  }

  const usageLogPath = resolveUsageLogPath(options.root, env);
  if (usageLogPath) {
    try {
      appendUsageRecord(
        usageLogPath,
        toUsageRecord(cost, {
          ts: (options.now?.() ?? new Date()).toISOString(),
          repo: `${options.owner}/${options.repo}`,
          pr: options.pullNumber
        }),
        { workspace: options.root }
      );
    } catch {
      // non-fatal: usage log unavailable
    }
  }
}

/** Build the `review` CLI command wired to the end-to-end GitHub review pipeline. */
export function buildReviewCommand(): Command {
  const command = new Command("review");

  command
    .description("Review a pull request and publish findings")
    .option("--pr <number>", "pull request number (defaults to the GitHub event)")
    .option("--repo <owner/repo>", "repository (defaults to GITHUB_REPOSITORY)")
    .option("--min-severity <severity>", `drop findings below this severity (${SEVERITIES.join("|")})`)
    .option("--no-context", "skip agentic cross-file context retrieval")
    .option("--no-grounding", "skip linter/SAST grounding")
    .option("--trust-workspace", "allow repo-local linter/SAST tools to execute in the workspace")
    .option("--no-verify", "skip the skeptical false-positive verification pass")
    .option("--no-incremental", "review the full PR diff, not just the delta since the last review")
    .option("--no-resolve-threads", "leave prior finding threads untouched (skip resolve + reply handling)")
    .option("--no-agent-prompt", "omit the per-finding \"Resolve with an AI agent\" prompt")
    .option("--config <path>", "path to a .prowl-review.yml config (defaults to an upward search)")
    .option("--no-config", "ignore any .prowl-review.yml and use built-in defaults")
    .option("--dry-run", "build the review but do not publish it")
    .action(async (options: ReviewCommandOptions) => {
      // The auto path (pull_request trigger) respects `@prowl-review pause` (#26).
      await runReviewWithOptions(options, { respectPause: true });
    });

  return command;
}

/**
 * Resolve config + flags and run the end-to-end review, reporting cost/usage.
 * Shared by the `review` CLI command (auto path) and the `command` handler's
 * `review` / `full review` verbs (#26). `respectPause` skips the run when the PR
 * is paused — set for auto reviews, cleared for an explicit `@prowl-review
 * review` request, which always runs.
 */
export async function runReviewWithOptions(
  options: ReviewCommandOptions,
  runtime: { respectPause?: boolean } = {}
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required to post reviews.");
  }

  const { owner, repo } = resolveRepo(options.repo);
  const pullNumber = resolvePullNumber(options.pr);
  const ref = { owner, repo, pull_number: pullNumber };
  const octokit = createOctokit(token);
  const root = resolveWorkspace();
  const { config } = loadConfig(resolveConfigLoadOptions(options, root));
  const reviewedHeadSha = resolveReviewedHeadSha();
  const dryRun = resolveDryRun(options);

  if (runtime.respectPause) {
    const prior = await fetchPriorReviewState(octokit, ref);
    if (prior?.paused) {
      const pausedCheckRunConclusion = await maybeSubmitPausedCheckRun(octokit, ref, {
        checkRun: config.checkRun,
        dryRun,
        headSha: reviewedHeadSha
      });
      console.log(
        `prowl-review: auto-review paused for ${owner}/${repo}#${pullNumber} ` +
          "— comment `@prowl-review resume` to re-enable."
      );
      if (pausedCheckRunConclusion) {
        console.log(`prowl-review: merge-gate check run → ${pausedCheckRunConclusion}`);
      }
      return;
    }
  }

  const guidelinesRoot = resolveGuidelinesWorkspace();
  const repoGuidelines = guidelinesRoot ? loadGuidelines(guidelinesRoot) : undefined;
  const orgGuidelinesPath = resolveOrgGuidelinesPath();
  const orgGuidelines = orgGuidelinesPath ? readOptionalFile(orgGuidelinesPath) : undefined;
  const guidelines = composeGuidelines(orgGuidelines, repoGuidelines);
  // Learned false-positive patterns (#30) load from the trusted guidelines checkout.
  const learnedPatterns = guidelinesRoot ? loadLearnedPatterns(guidelinesRoot) : undefined;

  const providerConfig = resolveProviderConfig(process.env, {
    provider: config.provider,
    model: config.model
  });
  const resolved = resolveReviewOptions(options, config);

  // Resolve the per-PR budget (#18) into a token ceiling, pricing-aware for maxUsd.
  const budget = resolveTokenBudget(
    config.budget,
    providerConfig.provider,
    providerConfig.model,
    config.pricing ?? {}
  );
  for (const note of budget.notes) {
    console.warn(`prowl-review: ${note}`);
  }

  const reviewOptions = {
    ...resolved,
    config: providerConfig,
    toolkitRoot: root,
    guidelines,
    learnedPatterns,
    budgetTokens: budget.tokens ?? undefined,
    reviewedHeadSha,
    dryRun
  };

  try {
    const result = await reviewPullRequest(octokit, ref, reviewOptions);
    reportReviewCommandResult(result, { owner, repo, pullNumber, root, providerConfig, pricing: config.pricing ?? {} });
  } catch (error) {
    if (error instanceof ReviewPublishError) {
      reportReviewCommandResult(error.result, {
        owner,
        repo,
        pullNumber,
        root,
        providerConfig,
        pricing: config.pricing ?? {},
        publishFailed: true
      });
    }
    throw error;
  }
}
